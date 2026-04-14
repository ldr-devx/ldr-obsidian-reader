// ============================================================
// src/views/PdfReaderView.ts  — REWRITE COMPLETO
// PDF viewer: scroll infinito nativo del browser, zoom via
// CSS scale sin parpadeo, fullscreen idéntico a ImageReaderView.
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf");

import { ItemView, WorkspaceLeaf, Notice, Platform } from "obsidian";
import type LdrEpubReaderPlugin from "../../main";
import { Book } from "../models";

export const PDF_READER_VIEW_TYPE = "ldr-pdf-reader";

type FitMode     = "width" | "height" | "page" | "original";
type SidebarTab  = "thumbs" | "toc";
type LayoutMode  = "single" | "double-odd" | "double-even";

interface TocItem {
    title: string;
    dest: string | unknown[] | null;
    items: TocItem[];
    depth: number;
}

interface PdfViewport { width: number; height: number; }
interface PdfPage {
    getViewport(opts: { scale: number }): PdfViewport;
    render(opts: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): { promise: Promise<void> };
}

const SPREAD_GAP      = 8;
const SIDEBAR_MIN_W   = 100;
const SIDEBAR_MAX_W   = 360;
const SIDEBAR_DEF_W   = 140;
const IMMERSIVE_DELAY = 3000;

export class PdfReaderView extends ItemView {
    private plugin: LdrEpubReaderPlugin;
    private book: Book | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private pdfDoc: any | null = null;
    private totalPages   = 0;
    private currentPage  = 1;
    private fitMode: FitMode       = "width";
    private layoutMode: LayoutMode = "single";
    private zoomLevel    = 1.0;
    private darkMode     = false;
    private isFullscreen = false;
    private settingsOpen = false;
    private sidebarOpen  = false;
    private sidebarWidth = SIDEBAR_DEF_W;
    private activeSidebarTab: SidebarTab = "thumbs";

    // Fullscreen auto-hide
    private immersiveHideTimer: ReturnType<typeof setTimeout> | null = null;

    // Zoom visual via CSS transform (sin re-render inmediato)
    private zoomCommitTimer: ReturnType<typeof setTimeout> | null = null;
    private zoomTranslateX = 0;
    private zoomTranslateY = 0;

    // Mouse drag pan (zoom > 1)
    private isMouseDragging = false;
    private mouseDragLastX  = 0;
    private mouseDragLastY  = 0;

    // Touch / pinch
    private isPinching      = false;
    private pinchStartDist  = 0;
    private pinchStartZoom  = 1.0;
    private pinchFocalX     = 0;
    private pinchFocalY     = 0;
    private lastTapTime     = 0;
    private isTouchDragging = false;

    // Render
    private isRendering = false;
    private renderQueue: number | null = null;
    private renderSeq   = 0;   // versión para cancelar renders obsoletos

    // Scroll page-change
    private scrollEdgeTimer: ReturnType<typeof setTimeout> | null = null;
    private justNavigated = false; // evita falso-positivo de borde al cargar página

    // DOM
    private scrollEl:        HTMLElement;
    private spreadEl:        HTMLElement;
    private canvasLeft:      HTMLCanvasElement;
    private canvasRight:     HTMLCanvasElement;
    private pageInputEl:     HTMLInputElement;
    private totalPagesEl:    HTMLElement;
    private pageIndicatorEl: HTMLElement;
    private headerEl:        HTMLElement;
    private footerEl:        HTMLElement;
    private sidebarEl:       HTMLElement;
    private thumbsContainer: HTMLElement;
    private tocContainer:    HTMLElement;
    private settingsPanel:   HTMLElement;
    private settingsBtnEl:   HTMLElement;
    private tocItems: TocItem[] = [];

    private thumbObserver: IntersectionObserver | null = null;
    private thumbRendering = new Set<number>();

    constructor(leaf: WorkspaceLeaf, plugin: LdrEpubReaderPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType()    { return PDF_READER_VIEW_TYPE; }
    getDisplayText() { return this.book?.title ?? "PDF Reader"; }
    getIcon()        { return "file-text"; }

    // ── WORKER ────────────────────────────────────────────────────

    private initWorker(): void {
        if (pdfjsLib.GlobalWorkerOptions.workerSrc) return;
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const fs       = require("fs")   as typeof import("fs");
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const nodePath = require("path") as typeof import("path");
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const base = (this.app.vault.adapter as any).basePath as string | undefined;
            const candidates: string[] = [];
            if (base) candidates.push(nodePath.join(base, ".obsidian", "plugins", "ldr-obsidian-reader", "pdf.worker.min.js"));
            candidates.push(
                nodePath.join(__dirname, "pdf.worker.min.js"),
                nodePath.join(__dirname, "..", "pdf.worker.min.js"),
                nodePath.join(__dirname, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.min.js"),
            );
            for (const p of candidates) {
                if (fs.existsSync(p)) {
                    const blob = new Blob([fs.readFileSync(p, "utf8")], { type: "application/javascript" });
                    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
                    console.log("[LDR PDF] worker →", p);
                    return;
                }
            }
            console.error("[LDR PDF] pdf.worker.min.js no encontrado.");
        } catch (e) { console.error("[LDR PDF] worker init error:", e); }
    }

    // ── LIFECYCLE ─────────────────────────────────────────────────

    async onOpen() {
        const root = this.containerEl.children[1] as HTMLElement;
        root.empty();
        root.addClass("ldr-pdf-reader");
        this.buildUI(root);
        this.registerKeyboard();
        this.registerWheelZoom();
        this.registerMouseDrag();
        this.registerTouch();
        this.registerScrollEdge();

        this.registerDomEvent(document, "fullscreenchange", () => {
            if (!document.fullscreenElement && this.isFullscreen) {
                this.isFullscreen = false;
                document.body.classList.remove("ldr-fullscreen");
                this.containerEl.classList.remove("ldr-fullscreen-leaf");
                this.headerEl.removeClass("is-hidden");
                this.footerEl.removeClass("is-hidden");
                this.pageIndicatorEl.removeClass("is-visible");
                if (this.immersiveHideTimer) { clearTimeout(this.immersiveHideTimer); this.immersiveHideTimer = null; }
                this.buildSettingsPanel();
            }
        });
    }

    async onClose() {
        this.saveProgress();
        this.thumbObserver?.disconnect();
        this.thumbObserver = null;
        if (this.immersiveHideTimer) clearTimeout(this.immersiveHideTimer);
        if (this.zoomCommitTimer)    clearTimeout(this.zoomCommitTimer);
        if (this.scrollEdgeTimer)    clearTimeout(this.scrollEdgeTimer);
        if (this.isFullscreen) this.exitFullscreen();
    }

    // ── LOAD BOOK ─────────────────────────────────────────────────

    async loadBook(bookId: string) {
        this.initWorker();
        const book = this.plugin.store.getBook(bookId);
        if (!book) { new Notice("Book not found."); return; }
        this.book = book;

        const state = this.plugin.store.getReadingState(bookId);
        this.currentPage      = state?.pageIndex ? state.pageIndex + 1 : 1;
        this.zoomLevel        = state?.pdfZoom        ?? 1.0;
        this.layoutMode       = (state?.pdfLayoutMode as LayoutMode) ?? "single";
        this.sidebarOpen      = state?.pdfSidebarOpen ?? false;
        this.activeSidebarTab = (state?.pdfSidebarTab as SidebarTab) ?? "thumbs";
        this.sidebarWidth     = state?.pdfSidebarWidth ?? SIDEBAR_DEF_W;

        this.sidebarEl.toggleClass("is-open", this.sidebarOpen);
        if (this.sidebarOpen) this.sidebarEl.style.width = `${this.sidebarWidth}px`;

        const file = this.app.vault.getFiles().find(f => f.path === book.filePath);
        if (!file) { new Notice("PDF file not found in vault."); return; }

        try {
            const buffer = await this.app.vault.readBinary(file);
            this.pdfDoc  = await pdfjsLib.getDocument({ data: buffer }).promise;
            this.totalPages = this.pdfDoc.numPages;
        } catch (err) {
            new Notice("Failed to load PDF.");
            console.error("[LDR PDF]", err);
            return;
        }

        this.headerEl.querySelector(".ldr-pdf-title")!.textContent = book.title;
        if (this.totalPagesEl) this.totalPagesEl.textContent = `/ ${this.totalPages}`;
        if (this.pageInputEl) {
            this.pageInputEl.max   = String(this.totalPages);
            this.pageInputEl.value = String(this.currentPage);
        }

        await this.loadToc();
        this.buildThumbnails();
        this.buildSidebar();
        await this.renderPage(this.currentPage);
    }

    // ── UI ────────────────────────────────────────────────────────

    private buildUI(root: HTMLElement) {
        this.headerEl = root.createDiv({ cls: "ldr-pdf-header" });
        this.buildHeader();

        const main = root.createDiv({ cls: "ldr-pdf-main" });

        this.sidebarEl = main.createDiv({ cls: "ldr-pdf-sidebar" });
        this.buildSidebar();
        this.buildSidebarResizeHandle();

        // scrollEl: contenedor con overflow-y:auto — scroll nativo del browser
        this.scrollEl  = main.createDiv({ cls: "ldr-pdf-scroll" });
        this.spreadEl  = this.scrollEl.createDiv({ cls: "ldr-pdf-spread" });
        this.canvasLeft  = this.spreadEl.createEl("canvas", { cls: "ldr-pdf-canvas" });
        this.canvasRight = this.spreadEl.createEl("canvas", { cls: "ldr-pdf-canvas" });
        this.canvasRight.style.display = "none";

        this.pageIndicatorEl = this.scrollEl.createDiv({ cls: "ldr-pdf-page-indicator" });
        this.updatePageIndicator();

        this.settingsPanel = root.createDiv({ cls: "ldr-pdf-settings-panel" });
        this.buildSettingsPanel();

        root.addEventListener("click", (e) => {
            if (this.settingsOpen
                && !this.settingsPanel.contains(e.target as Node)
                && !this.settingsBtnEl.contains(e.target as Node)) {
                this.closeSettings();
            }
        });

        this.footerEl = root.createDiv({ cls: "ldr-pdf-footer" });
        this.buildFooter();
    }

    private buildHeader() {
        this.headerEl.empty();

        const backBtn = this.headerEl.createDiv({ cls: "ldr-pdf-btn", attr: { title: "Back to library" } });
        backBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>`;
        backBtn.addEventListener("click", () => {
            this.saveProgress();
            if (this.isFullscreen) this.exitFullscreen();
            this.plugin.openHomeView();
        });

        this.headerEl.createDiv({ cls: "ldr-pdf-title", text: this.book?.title ?? "PDF Reader" });

        const actions = this.headerEl.createDiv({ cls: "ldr-pdf-header-actions" });

        if (Platform.isDesktop) {
            const extBtn = actions.createDiv({ cls: "ldr-pdf-btn", attr: { title: "Open in system viewer" } });
            extBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
            extBtn.addEventListener("click", () => this.openExternal());
        }

        const sidebarBtn = actions.createDiv({ cls: "ldr-pdf-btn", attr: { title: "Toggle sidebar" } });
        sidebarBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>`;
        sidebarBtn.addEventListener("click", () => this.toggleSidebar());

        this.settingsBtnEl = actions.createDiv({ cls: "ldr-pdf-btn", attr: { title: "Settings" } });
        this.settingsBtnEl.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
        this.settingsBtnEl.addEventListener("click", (e) => { e.stopPropagation(); this.toggleSettings(); });
    }

    private buildFooter() {
        this.footerEl.empty();

        const prevBtn = this.footerEl.createDiv({ cls: "ldr-pdf-btn", attr: { title: "Previous page" } });
        prevBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>`;
        prevBtn.addEventListener("click", () => this.goToPage(this.prevSpreadStart(this.currentPage)));

        const pageRow = this.footerEl.createDiv({ cls: "ldr-pdf-page-row" });
        this.pageInputEl = pageRow.createEl("input", {
            cls: "ldr-pdf-page-input",
            attr: { type: "number", min: "1", value: "1" },
        });
        this.pageInputEl.addEventListener("change", () => {
            const n = parseInt(this.pageInputEl.value);
            if (!isNaN(n)) this.goToPage(n);
        });
        this.pageInputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                const n = parseInt(this.pageInputEl.value);
                if (!isNaN(n)) this.goToPage(n);
                this.pageInputEl.blur();
            }
            e.stopPropagation();
        });
        this.pageInputEl.addEventListener("blur", () => {
            const n = parseInt(this.pageInputEl.value);
            if (isNaN(n) || n < 1 || n > this.totalPages) this.pageInputEl.value = String(this.currentPage);
        });

        this.totalPagesEl = pageRow.createSpan({
            cls: "ldr-pdf-total-pages",
            text: `/ ${this.totalPages || "—"}`,
        });

        const nextBtn = this.footerEl.createDiv({ cls: "ldr-pdf-btn", attr: { title: "Next page" } });
        nextBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;
        nextBtn.addEventListener("click", () => this.goToPage(this.nextSpreadStart(this.currentPage)));
    }

    // ── SETTINGS PANEL ────────────────────────────────────────────

    private buildSettingsPanel() {
        this.settingsPanel.empty();

        // ── Fullscreen — igual que ImageReaderView ─────────────────
        const fsSection = this.settingsPanel.createDiv({ cls: "ldr-pdf-settings-section" });
        const fsLabel   = this.isFullscreen ? "Exit fullscreen" : "Fullscreen";
        const fsSvg     = this.isFullscreen
            ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="21" y2="3"/><line x1="3" y1="21" x2="14" y2="10"/></svg>`
            : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
        const fsBtn = fsSection.createDiv({ cls: `ldr-pdf-fit-btn${this.isFullscreen ? " is-active" : ""}` });
        fsBtn.innerHTML = `${fsSvg} <span>${fsLabel}</span>`;
        fsBtn.style.cssText = "display:flex;align-items:center;gap:6px;justify-content:center;";
        fsBtn.addEventListener("click", () => { this.toggleFullscreen(); this.closeSettings(); });

        this.settingsPanel.createDiv({ cls: "ldr-pdf-settings-sep" });

        // ── Layout ────────────────────────────────────────────────
        const layoutSection = this.settingsPanel.createDiv({ cls: "ldr-pdf-settings-section" });
        layoutSection.createDiv({ cls: "ldr-pdf-settings-label", text: "Layout" });
        const layoutRow = layoutSection.createDiv({ cls: "ldr-pdf-settings-row" });
        const layouts: { key: LayoutMode; label: string }[] = [
            { key: "single",      label: "Single"  },
            { key: "double-odd",  label: "2P·Odd"  },
            { key: "double-even", label: "2P·Even" },
        ];
        layouts.forEach(({ key, label }) => {
            const btn = layoutRow.createDiv({ cls: `ldr-pdf-fit-btn${this.layoutMode === key ? " is-active" : ""}`, text: label });
            btn.addEventListener("click", async () => {
                this.layoutMode = key;
                const snap = this.getSpreadPages(this.currentPage).left;
                this.buildSettingsPanel();
                await this.renderPage(snap);
                this.saveProgress();
            });
        });

        // ── Fit ────────────────────────────────────────────────────
        const fitSection = this.settingsPanel.createDiv({ cls: "ldr-pdf-settings-section" });
        fitSection.createDiv({ cls: "ldr-pdf-settings-label", text: "Fit" });
        const fitRow = fitSection.createDiv({ cls: "ldr-pdf-settings-row" });
        const fits: { key: FitMode; label: string }[] = [
            { key: "width",    label: "Width"  },
            { key: "height",   label: "Height" },
            { key: "page",     label: "Fit"    },
            { key: "original", label: "1:1"    },
        ];
        fits.forEach(({ key, label }) => {
            const btn = fitRow.createDiv({ cls: `ldr-pdf-fit-btn${this.fitMode === key ? " is-active" : ""}`, text: label });
            btn.addEventListener("click", async () => {
                this.fitMode = key;
                this.resetZoomTranslate();
                this.buildSettingsPanel();
                await this.renderPage(this.currentPage);
            });
        });

        // ── Dark mode ─────────────────────────────────────────────
        const darkSection = this.settingsPanel.createDiv({ cls: "ldr-pdf-settings-section" });
        darkSection.createDiv({ cls: "ldr-pdf-settings-label", text: "Dark mode" });
        const darkToggle = darkSection.createDiv({ cls: `ldr-pdf-toggle${this.darkMode ? " is-active" : ""}` });
        darkToggle.createDiv({ cls: "ldr-pdf-toggle-knob" });
        darkToggle.addEventListener("click", () => {
            this.darkMode = !this.darkMode;
            this.canvasLeft.toggleClass("ldr-pdf-canvas--dark",  this.darkMode);
            this.canvasRight.toggleClass("ldr-pdf-canvas--dark", this.darkMode);
            darkToggle.toggleClass("is-active", this.darkMode);
        });

        // ── Zoom ──────────────────────────────────────────────────
        const zoomSection = this.settingsPanel.createDiv({ cls: "ldr-pdf-settings-section" });
        zoomSection.createDiv({ cls: "ldr-pdf-settings-label", text: "Zoom" });
        const zoomRow = zoomSection.createDiv({ cls: "ldr-pdf-settings-row" });
        zoomRow.createDiv({ cls: "ldr-pdf-btn", text: "−" })
            .addEventListener("click", async () => this.commitZoom(this.zoomLevel - 0.25));
        zoomRow.createSpan({ cls: "ldr-pdf-zoom-label", text: `${Math.round(this.zoomLevel * 100)}%` });
        zoomRow.createDiv({ cls: "ldr-pdf-btn", text: "+" })
            .addEventListener("click", async () => this.commitZoom(this.zoomLevel + 0.25));
    }

    private toggleSettings() {
        this.settingsOpen = !this.settingsOpen;
        if (this.settingsOpen) this.buildSettingsPanel();
        this.settingsPanel.toggleClass("is-open", this.settingsOpen);
        this.settingsBtnEl.toggleClass("is-active", this.settingsOpen);
    }

    private closeSettings() {
        this.settingsOpen = false;
        this.settingsPanel.removeClass("is-open");
        this.settingsBtnEl.removeClass("is-active");
    }

    // ── FULLSCREEN ────────────────────────────────────────────────
    // Implementación idéntica a ImageReaderView:
    //   body.ldr-fullscreen         → oculta UI de Obsidian via CSS global
    //   containerEl.ldr-fullscreen-leaf → fija este leaf a pantalla completa
    //   requestFullscreen()         → fullscreen real del SO

    private toggleFullscreen() {
        this.isFullscreen ? this.exitFullscreen() : this.enterFullscreen();
    }

    private enterFullscreen() {
        this.isFullscreen = true;
        document.body.classList.add("ldr-fullscreen");
        this.containerEl.classList.add("ldr-fullscreen-leaf");
        if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(() => {});
        }
        this.headerEl.addClass("is-hidden");
        this.footerEl.addClass("is-hidden");
        this.pageIndicatorEl.addClass("is-visible");
        this.scheduleImmersiveHide();
        this.containerEl.addEventListener("mousemove", this.boundShowControls);
        this.buildSettingsPanel();
    }

    private exitFullscreen() {
        this.isFullscreen = false;
        document.body.classList.remove("ldr-fullscreen");
        this.containerEl.classList.remove("ldr-fullscreen-leaf");
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        if (this.immersiveHideTimer) { clearTimeout(this.immersiveHideTimer); this.immersiveHideTimer = null; }
        this.headerEl.removeClass("is-hidden");
        this.footerEl.removeClass("is-hidden");
        this.pageIndicatorEl.removeClass("is-visible");
        this.containerEl.removeEventListener("mousemove", this.boundShowControls);
        this.buildSettingsPanel();
    }

    private boundShowControls = () => {
        if (!this.isFullscreen) return;
        this.headerEl.removeClass("is-hidden");
        this.footerEl.removeClass("is-hidden");
        this.pageIndicatorEl.removeClass("is-visible");
        this.scheduleImmersiveHide();
    };

    private scheduleImmersiveHide() {
        if (this.immersiveHideTimer) clearTimeout(this.immersiveHideTimer);
        this.immersiveHideTimer = setTimeout(() => {
            this.immersiveHideTimer = null;
            if (this.isFullscreen) {
                this.headerEl.addClass("is-hidden");
                this.footerEl.addClass("is-hidden");
                this.pageIndicatorEl.addClass("is-visible");
            }
        }, IMMERSIVE_DELAY);
    }

    // ── SIDEBAR ───────────────────────────────────────────────────

    private buildSidebar() {
        this.sidebarEl.empty();
        const tabBar   = this.sidebarEl.createDiv({ cls: "ldr-pdf-sidebar-tabs" });
        const thumbTab = tabBar.createSpan({ cls: `ldr-pdf-sidebar-tab${this.activeSidebarTab === "thumbs" ? " is-active" : ""}`, text: "Pages" });
        thumbTab.addEventListener("click", () => { this.activeSidebarTab = "thumbs"; this.buildSidebar(); this.buildThumbnails(); this.saveProgress(); });
        const tocTab = tabBar.createSpan({ cls: `ldr-pdf-sidebar-tab${this.activeSidebarTab === "toc" ? " is-active" : ""}`, text: "Contents" });
        tocTab.addEventListener("click", () => { this.activeSidebarTab = "toc"; this.buildSidebar(); this.saveProgress(); });

        this.thumbsContainer = this.sidebarEl.createDiv({ cls: "ldr-pdf-thumbs" });
        this.tocContainer    = this.sidebarEl.createDiv({ cls: "ldr-pdf-toc" });

        if (this.activeSidebarTab === "thumbs") {
            this.thumbsContainer.style.display = "flex";
            this.tocContainer.style.display    = "none";
        } else {
            this.thumbsContainer.style.display = "none";
            this.tocContainer.style.display    = "block";
            this.renderTocList();
        }
    }

    private buildSidebarResizeHandle() {
        const handle = this.sidebarEl.createDiv({ cls: "ldr-pdf-sidebar-resize" });
        let dragging = false, startX = 0, startW = 0;
        const onMove = (e: MouseEvent) => {
            if (!dragging) return;
            const w = Math.max(SIDEBAR_MIN_W, Math.min(SIDEBAR_MAX_W, startW + (e.clientX - startX)));
            this.sidebarWidth = w;
            this.sidebarEl.style.width = `${w}px`;
        };
        const onUp = () => {
            if (!dragging) return;
            dragging = false;
            this.sidebarEl.removeClass("is-resizing");
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup",  onUp);
            this.saveProgress();
        };
        handle.addEventListener("mousedown", (e) => {
            e.preventDefault(); dragging = true; startX = e.clientX; startW = this.sidebarEl.offsetWidth;
            this.sidebarEl.addClass("is-resizing");
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup",   onUp);
        });
    }

    private toggleSidebar() {
        this.sidebarOpen = !this.sidebarOpen;
        this.sidebarEl.toggleClass("is-open", this.sidebarOpen);
        if (this.sidebarOpen) this.sidebarEl.style.width = `${this.sidebarWidth}px`;
        this.saveProgress();
    }

    // ── SPREAD LOGIC ──────────────────────────────────────────────

    private getSpreadPages(p: number): { left: number; right: number | null } {
        if (this.layoutMode === "single") return { left: p, right: null };
        if (this.layoutMode === "double-odd") {
            if (p <= 1) return { left: 1, right: null };
            const i = Math.floor((p - 2) / 2), l = 2 + i * 2;
            return { left: l, right: l + 1 <= this.totalPages ? l + 1 : null };
        }
        const i = Math.floor((p - 1) / 2), l = 1 + i * 2;
        return { left: l, right: l + 1 <= this.totalPages ? l + 1 : null };
    }

    private nextSpreadStart(p: number): number {
        if (this.layoutMode === "single") return p + 1;
        if (this.layoutMode === "double-odd" && p <= 1) return 2;
        return this.getSpreadPages(p).left + 2;
    }

    private prevSpreadStart(p: number): number {
        if (this.layoutMode === "single") return p - 1;
        const { left } = this.getSpreadPages(p);
        if (left <= 1) return 1;
        return this.getSpreadPages(left - 1).left;
    }

    // ── RENDERING ─────────────────────────────────────────────────

    private async renderPage(pageNum: number) {
        if (!this.pdfDoc) return;
        const { left, right } = this.getSpreadPages(Math.max(1, Math.min(this.totalPages, pageNum)));

        if (this.isRendering) { this.renderQueue = left; return; }
        this.isRendering = true;
        this.currentPage = left;
        this.updatePageIndicator();

        const seq = ++this.renderSeq;

        try {
            const lPage: PdfPage      = await this.pdfDoc.getPage(left);
            const rPage: PdfPage|null = right ? await this.pdfDoc.getPage(right) : null;
            if (seq !== this.renderSeq) return; // render obsoleto

            const scale = this.computeScale(lPage, rPage);
            await this.renderToCanvas(lPage, this.canvasLeft, scale);
            this.canvasLeft.toggleClass("ldr-pdf-canvas--dark", this.darkMode);

            if (rPage) {
                this.canvasRight.style.display = "block";
                await this.renderToCanvas(rPage, this.canvasRight, scale);
                this.canvasRight.toggleClass("ldr-pdf-canvas--dark", this.darkMode);
            } else {
                this.canvasRight.style.display = "none";
            }

            this.resetZoomTranslate();
            this.applyZoomTransform();

            // Scroll al inicio de la página tras cambio de página
            this.justNavigated = true;
            this.scrollEl.scrollTop = 0;
            setTimeout(() => { this.justNavigated = false; }, 300);

            this.highlightThumb(left);
        } catch (err) {
            console.error("[LDR PDF] render error:", err);
        } finally {
            this.isRendering = false;
            if (this.renderQueue !== null) {
                const next = this.renderQueue;
                this.renderQueue = null;
                await this.renderPage(next);
            }
        }
    }

    private async renderToCanvas(page: PdfPage, canvas: HTMLCanvasElement, scale: number) {
        const vp = page.getViewport({ scale });
        canvas.width  = vp.width;
        canvas.height = vp.height;
        await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
    }

    /**
     * Escala base: el zoomLevel se aplica SÓLO via CSS transform, no aquí.
     * Esto permite zoom visual instantáneo sin re-render del canvas.
     */
    private computeScale(lPage: PdfPage, rPage: PdfPage | null): number {
        const vL = lPage.getViewport({ scale: 1.0 });
        const vR = rPage ? rPage.getViewport({ scale: 1.0 }) : null;
        const cw = this.scrollEl.clientWidth  || window.innerWidth;
        const ch = this.scrollEl.clientHeight || window.innerHeight;
        const tw = vR ? vL.width + vR.width + SPREAD_GAP : vL.width;
        const mh = vR ? Math.max(vL.height, vR.height) : vL.height;
        switch (this.fitMode) {
            case "width":    return cw / tw;
            case "height":   return ch / mh;
            case "page":     return Math.min(cw / tw, ch / mh);
            case "original": return 1.0;
        }
    }

    /**
     * Aplica zoom via CSS transform en el spread.
     * transform-origin: top center asegura que el spread se expanda hacia
     * abajo/lados y el scroll nativo cubre el contenido ampliado.
     */
    private applyZoomTransform() {
        if (this.zoomLevel === 1.0 && this.zoomTranslateX === 0 && this.zoomTranslateY === 0) {
            this.spreadEl.style.transform       = "";
            this.spreadEl.style.transformOrigin = "";
            return;
        }
        this.spreadEl.style.transformOrigin = "top center";
        this.spreadEl.style.transform =
            `scale(${this.zoomLevel}) translate(${this.zoomTranslateX}px, ${this.zoomTranslateY}px)`;
    }

    private resetZoomTranslate() {
        this.zoomTranslateX = 0;
        this.zoomTranslateY = 0;
    }

    // ── ZOOM ──────────────────────────────────────────────────────

    /**
     * Zoom visual inmediato (trackpad / pinch): aplica sólo CSS transform.
     * Ajusta translate para mantener el punto focal estático en pantalla.
     * Re-render diferido 350ms después del último evento.
     */
    private gestureZoom(newRaw: number, focalX: number, focalY: number) {
        const oldZoom = this.zoomLevel;
        const newZoom = Math.max(0.5, Math.min(5.0, newRaw));
        if (newZoom === oldZoom) return;

        const rect  = this.spreadEl.getBoundingClientRect();
        const fx    = focalX - rect.left;
        const fy    = focalY - rect.top;
        const ratio = newZoom / oldZoom;

        // Ajustar translate para que el punto focal no se mueva
        this.zoomTranslateX += fx * (1 - ratio) / newZoom;
        this.zoomTranslateY += fy * (1 - ratio) / newZoom;
        this.zoomLevel = newZoom;
        this.applyZoomTransform();

        if (this.zoomCommitTimer) clearTimeout(this.zoomCommitTimer);
        this.zoomCommitTimer = setTimeout(() => {
            this.zoomCommitTimer = null;
            this.commitZoom(this.zoomLevel);
        }, 350);
    }

    /**
     * Zoom con re-render: actualiza el canvas a la resolución correcta.
     */
    private async commitZoom(level: number) {
        this.zoomLevel = Math.max(0.5, Math.min(5.0, level));
        this.resetZoomTranslate();
        this.applyZoomTransform();
        await this.renderPage(this.currentPage);
        this.buildSettingsPanel();
        this.scrollEl.style.cursor = this.zoomLevel > 1.05 ? "grab" : "";
    }

    // ── WHEEL ZOOM ────────────────────────────────────────────────

    /**
     * Solo intercepta Ctrl/Meta+wheel (zoom).
     * El scroll normal sin modificador queda 100% en manos del browser:
     * momentum de trackpad, inercia, barra de scroll nativa, todo funciona.
     */
    private registerWheelZoom() {
        this.registerDomEvent(this.scrollEl, "wheel", (e: WheelEvent) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            e.preventDefault();
            let dy = e.deltaY;
            if (e.deltaMode === 1) dy *= 20;
            else if (e.deltaMode === 2) dy *= 400;
            this.gestureZoom(this.zoomLevel * (dy < 0 ? 1.06 : 0.94), e.clientX, e.clientY);
        }, { passive: false });
    }

    // ── SCROLL → CAMBIO DE PÁGINA ─────────────────────────────────

    /**
     * Detecta cuándo el scroll llega al borde inferior/superior
     * para avanzar/retroceder página. El throttle de 150ms evita
     * disparos múltiples durante el momentum del trackpad.
     */
    private registerScrollEdge() {
        this.registerDomEvent(this.scrollEl, "scroll", () => {
            if (this.justNavigated || this.isRendering) return;
            if (this.scrollEdgeTimer) clearTimeout(this.scrollEdgeTimer);
            this.scrollEdgeTimer = setTimeout(() => {
                this.scrollEdgeTimer = null;
                this.checkScrollEdge();
            }, 150);
        });
    }

    private checkScrollEdge() {
        if (this.justNavigated || this.isRendering || !this.pdfDoc) return;
        const el       = this.scrollEl;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
        const atTop    = el.scrollTop < 8;

        if (atBottom && this.currentPage < this.totalPages) {
            this.goToPage(this.nextSpreadStart(this.currentPage));
        } else if (atTop && this.currentPage > 1) {
            this.goToPage(this.prevSpreadStart(this.currentPage), true);
        }
    }

    // ── MOUSE DRAG (pan con zoom) ─────────────────────────────────

    private registerMouseDrag() {
        this.registerDomEvent(this.scrollEl, "mousedown", (e: MouseEvent) => {
            if (e.button !== 0 || this.zoomLevel <= 1.05) return;
            e.preventDefault();
            this.isMouseDragging = true;
            this.mouseDragLastX  = e.clientX;
            this.mouseDragLastY  = e.clientY;
            this.scrollEl.style.cursor = "grabbing";
        });

        this.registerDomEvent(document, "mousemove", (e: MouseEvent) => {
            if (!this.isMouseDragging) return;
            const dx = e.clientX - this.mouseDragLastX;
            const dy = e.clientY - this.mouseDragLastY;
            this.mouseDragLastX = e.clientX;
            this.mouseDragLastY = e.clientY;
            // Pan horizontal via translate; vertical via scrollTop nativo
            this.scrollEl.scrollTop  -= dy;
            this.zoomTranslateX      += dx / this.zoomLevel;
            this.applyZoomTransform();
        });

        this.registerDomEvent(document, "mouseup", () => {
            if (!this.isMouseDragging) return;
            this.isMouseDragging = false;
            this.scrollEl.style.cursor = this.zoomLevel > 1.05 ? "grab" : "";
        });
    }

    // ── TOUCH ─────────────────────────────────────────────────────

    private registerTouch() {
        this.registerDomEvent(this.scrollEl, "touchstart", (e: TouchEvent) => {
            if (e.touches.length === 2) {
                e.preventDefault();
                this.isPinching     = true;
                this.pinchStartDist = this.getTouchDist(e);
                this.pinchStartZoom = this.zoomLevel;
                const mid = this.getTouchMid(e);
                this.pinchFocalX = mid.x;
                this.pinchFocalY = mid.y;
            } else {
                this.isTouchDragging = false;
            }
        }, { passive: false });

        this.registerDomEvent(this.scrollEl, "touchmove", (e: TouchEvent) => {
            if (e.touches.length === 2 && this.isPinching) {
                e.preventDefault();
                const dist   = this.getTouchDist(e);
                const mid    = this.getTouchMid(e);
                this.gestureZoom(this.pinchStartZoom * (dist / this.pinchStartDist), mid.x, mid.y);
            }
            // 1 dedo: scroll nativo del browser — no intervenir
        }, { passive: false });

        this.registerDomEvent(this.scrollEl, "touchend", async (e: TouchEvent) => {
            if (this.isPinching && e.touches.length < 2) {
                this.isPinching = false;
                if (this.zoomCommitTimer) { clearTimeout(this.zoomCommitTimer); this.zoomCommitTimer = null; }
                await this.commitZoom(this.zoomLevel);
                return;
            }
            this.isPinching = false;

            // Doble tap → reset zoom
            if (Platform.isMobile && e.changedTouches.length === 1 && !this.isTouchDragging) {
                const now = Date.now();
                if (now - this.lastTapTime < 300 && this.zoomLevel > 1.0) await this.commitZoom(1.0);
                this.lastTapTime = now;
            }
            this.isTouchDragging = false;
        }, { passive: false });
    }

    private getTouchDist(e: TouchEvent): number {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    private getTouchMid(e: TouchEvent): { x: number; y: number } {
        return { x: (e.touches[0].clientX + e.touches[1].clientX) / 2, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
    }

    // ── NAVIGATION ────────────────────────────────────────────────

    async goToPage(pageNum: number, scrollToBottom = false) {
        if (!this.pdfDoc) return;
        pageNum = Math.max(1, Math.min(this.totalPages, pageNum));
        const snap = this.getSpreadPages(pageNum).left;
        if (snap === this.currentPage && !this.isRendering) return;
        await this.renderPage(snap);
        if (scrollToBottom) {
            requestAnimationFrame(() => { this.scrollEl.scrollTop = this.scrollEl.scrollHeight; });
        }
        this.saveProgress();
    }

    private updatePageIndicator() {
        const { right } = this.getSpreadPages(this.currentPage);
        const pt = right ? `${this.currentPage}–${right}` : String(this.currentPage);
        const txt = `${pt} / ${this.totalPages || "—"}`;
        if (this.pageIndicatorEl) this.pageIndicatorEl.textContent = txt;
        if (this.pageInputEl)    this.pageInputEl.value = String(this.currentPage);
        if (this.totalPagesEl)   this.totalPagesEl.textContent = `/ ${this.totalPages || "—"}`;
    }

    // ── KEYBOARD ──────────────────────────────────────────────────

    private registerKeyboard() {
        this.registerDomEvent(document, "keydown", async (e: KeyboardEvent) => {
            if (this.app.workspace.activeLeaf?.view !== this) return;
            const t = e.target as HTMLElement;
            if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable) return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            switch (e.key) {
                case "ArrowRight": case "PageDown":
                    e.preventDefault(); await this.goToPage(this.nextSpreadStart(this.currentPage)); break;
                case "ArrowLeft": case "PageUp":
                    e.preventDefault(); await this.goToPage(this.prevSpreadStart(this.currentPage)); break;
                case "Home":    e.preventDefault(); await this.goToPage(1); break;
                case "End":     e.preventDefault(); await this.goToPage(this.totalPages); break;
                case "+": case "=": e.preventDefault(); await this.commitZoom(this.zoomLevel + 0.25); break;
                case "-":       e.preventDefault(); await this.commitZoom(this.zoomLevel - 0.25); break;
                case "0":       e.preventDefault(); await this.commitZoom(1.0); break;
                case "f": case "F": this.toggleFullscreen(); break;
                case "Escape": if (this.isFullscreen) this.exitFullscreen(); break;
            }
        });
    }

    // ── TOC ───────────────────────────────────────────────────────

    private async loadToc() {
        if (!this.pdfDoc) return;
        try { this.tocItems = (await this.pdfDoc.getOutline())
                ? this.flattenOutline(await this.pdfDoc.getOutline(), 0) : []; }
        catch { this.tocItems = []; }
    }

    private flattenOutline(items: { title: string; dest: unknown; items: unknown[] }[], depth: number): TocItem[] {
        const result: TocItem[] = [];
        for (const item of items) {
            result.push({ title: item.title, dest: item.dest as TocItem["dest"], items: [], depth });
            if (item.items?.length) result.push(...this.flattenOutline(item.items as { title: string; dest: unknown; items: unknown[] }[], depth + 1));
        }
        return result;
    }

    private renderTocList() {
        this.tocContainer.empty();
        if (!this.tocItems.length) { this.tocContainer.createDiv({ cls: "ldr-pdf-toc-empty", text: "No table of contents" }); return; }
        this.tocItems.forEach((item) => {
            const el = this.tocContainer.createDiv({ cls: "ldr-pdf-toc-item", text: item.title });
            el.style.paddingLeft = `${8 + item.depth * 12}px`;
            el.addEventListener("click", async () => {
                if (!this.pdfDoc || !item.dest) return;
                try {
                    let pn: number;
                    if (typeof item.dest === "string") { const r = await this.pdfDoc.getDestination(item.dest); pn = await this.pdfDoc.getPageIndex(r[0]) + 1; }
                    else if (Array.isArray(item.dest)) { pn = await this.pdfDoc.getPageIndex((item.dest as unknown[])[0]) + 1; }
                    else return;
                    await this.goToPage(pn);
                } catch (err) { console.warn("[LDR PDF] TOC nav error:", err); }
            });
        });
    }

    // ── THUMBNAILS ────────────────────────────────────────────────

    private buildThumbnails() {
        this.thumbsContainer.empty();
        this.thumbObserver?.disconnect();
        this.thumbRendering.clear();
        if (!this.pdfDoc) return;

        this.thumbObserver = new IntersectionObserver(
            (entries) => entries.forEach((en) => {
                if (!en.isIntersecting) return;
                const el  = en.target as HTMLElement;
                const idx = parseInt(el.dataset.page ?? "0");
                if (idx > 0 && !this.thumbRendering.has(idx)) { this.thumbObserver?.unobserve(el); this.renderThumb(el, idx); }
            }),
            { root: this.thumbsContainer, rootMargin: "300px" },
        );

        for (let i = 1; i <= this.totalPages; i++) {
            const cell = this.thumbsContainer.createDiv({ cls: "ldr-pdf-thumb-cell", attr: { "data-page": String(i) } });
            cell.createEl("canvas", { cls: "ldr-pdf-thumb-canvas" });
            cell.createDiv({ cls: "ldr-pdf-thumb-label", text: String(i) });
            cell.addEventListener("click", async () => { await this.goToPage(i); this.highlightThumb(i); });
            this.thumbObserver.observe(cell);
        }
        this.highlightThumb(this.currentPage);
    }

    private async renderThumb(cell: HTMLElement, pageNum: number) {
        if (!this.pdfDoc) return;
        this.thumbRendering.add(pageNum);
        try {
            const page: PdfPage = await this.pdfDoc.getPage(pageNum);
            const vp = page.getViewport({ scale: 0.15 });
            const canvas = cell.querySelector("canvas") as HTMLCanvasElement;
            if (!canvas) return;
            canvas.width = vp.width; canvas.height = vp.height;
            await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
        } catch { /* silencioso */ }
        finally { this.thumbRendering.delete(pageNum); }
    }

    private highlightThumb(pageNum: number) {
        this.thumbsContainer.querySelectorAll(".ldr-pdf-thumb-cell").forEach((el) => {
            el.toggleClass("is-active", parseInt((el as HTMLElement).dataset.page ?? "0") === pageNum);
        });
        const active = this.thumbsContainer.querySelector(".ldr-pdf-thumb-cell.is-active") as HTMLElement;
        if (active) active.scrollIntoView({ block: "nearest" });
    }

    // ── OPEN EXTERNAL ─────────────────────────────────────────────

    private async openExternal() {
        if (!this.book) return;
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const fullPath = (this.app.vault.adapter as any).getFullPath?.(this.book.filePath);
            if (!fullPath) { new Notice("Cannot resolve file path."); return; }
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            await require("electron").shell.openPath(fullPath);
        } catch (err) { new Notice("Could not open file externally."); console.error("[LDR PDF] openExternal:", err); }
    }

    // ── PROGRESS ──────────────────────────────────────────────────

    private saveProgress() {
        if (!this.book) return;
        const progress = this.totalPages > 0 ? Math.round(((this.currentPage - 1) / this.totalPages) * 100) : 0;
        const existing = this.plugin.store.getReadingState(this.book.id);
        this.plugin.store.saveReadingState({
            bookId: this.book.id, cfi: "", currentPage: this.currentPage,
            totalPages: this.totalPages, currentChapterId: "", progress,
            lastReadAt: Date.now(), pageIndex: this.currentPage - 1,
            pdfZoom: this.zoomLevel, pdfLayoutMode: this.layoutMode,
            pdfSidebarOpen: this.sidebarOpen, pdfSidebarTab: this.activeSidebarTab,
            pdfSidebarWidth: this.sidebarWidth, readingMode: existing?.readingMode,
        });
    }
}
