// ============================================================
// src/views/PdfReaderView.ts
// Lector PDF: scroll infinito continuo (todas las páginas en
// un contenedor desplazable), zoom con Ctrl+scroll / pinch,
// layout doble página, sidebar, fullscreen idéntico a CBZ/EPUB.
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf");

import { ItemView, WorkspaceLeaf, Notice, Platform } from "obsidian";
import type LdrEpubReaderPlugin from "../../main";
import { Book } from "../models";

export const PDF_READER_VIEW_TYPE = "ldr-pdf-reader";

type FitMode   = "width" | "height" | "page" | "original";
type SidebarTab = "thumbs" | "toc";
type LayoutMode = "single" | "double-odd" | "double-even";

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

const SPREAD_GAP         = 8;   // px entre páginas en modo doble
const SIDEBAR_MIN_WIDTH  = 100;
const SIDEBAR_MAX_WIDTH  = 360;
const SIDEBAR_DEFAULT_WIDTH = 140;

export class PdfReaderView extends ItemView {
    private plugin: LdrEpubReaderPlugin;
    private book: Book | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private pdfDoc: any | null = null;
    private totalPages = 0;
    private currentPage = 1;
    private fitMode: FitMode = "width";
    private layoutMode: LayoutMode = "single";
    private baseScale = 1.0;
    private zoomLevel = 1.0;
    private darkMode = false;
    private isFullscreen = false;
    private sidebarOpen = false;
    private sidebarWidth = SIDEBAR_DEFAULT_WIDTH;
    private activeSidebarTab: SidebarTab = "thumbs";
    private settingsOpen = false;

    // Zoom — pinch touch
    private isPinching = false;
    private pinchStartDist = 0;
    private pinchStartZoom = 1.0;
    // Zoom al que se renderizaron las páginas por última vez (para CSS live-zoom)
    private renderedZoom = 1.0;

    // Timers
    private zoomDebounce: ReturnType<typeof setTimeout> | null = null;
    private scrollRafId: number | null = null;

    // DOM refs
    private viewportEl: HTMLElement;
    private pagesContainerEl: HTMLElement;
    private pageInputEl: HTMLInputElement;
    private totalPagesEl: HTMLElement;
    private pageIndicatorEl: HTMLElement;
    private headerEl: HTMLElement;
    private footerEl: HTMLElement;
    private sidebarEl: HTMLElement;
    private thumbsContainer: HTMLElement;
    private tocContainer: HTMLElement;
    private settingsPanel: HTMLElement;
    private settingsBtnEl: HTMLElement;
    private sidebarBtnEl: HTMLElement;
    private tocItems: TocItem[] = [];

    // Scroll infinito
    private slotEls     = new Map<number, HTMLElement>();
    private slotCanvases = new Map<number, HTMLCanvasElement>();
    private renderObserver: IntersectionObserver | null = null;
    private renderingPages = new Set<number>();

    // Thumbnails
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

    private async initWorker(): Promise<void> {
        if (pdfjsLib.GlobalWorkerOptions.workerSrc) return;

        // Silenciar warnings internos de pdf.js (p.ej. AcroForm buttons sin action dict)
        // VerbosityLevel: ERRORS=0, WARNINGS=1, INFOS=5
        pdfjsLib.verbosity = 0;

        const pluginId = "ldr-obsidian-reader";
        const workerFile = "pdf.worker.min.js";

        if (Platform.isMobile) {
            // En Android no existen fs/path (APIs de Node.js/Electron).
            // Usamos vault.adapter.read() que funciona en todas las plataformas.
            const vaultRelativePath = `.obsidian/plugins/${pluginId}/${workerFile}`;
            try {
                const content = await this.app.vault.adapter.read(vaultRelativePath);
                const blob = new Blob([content], { type: "application/javascript" });
                pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
                console.log("[LDR PDF] Mobile worker loaded via vault adapter");
            } catch (e) {
                console.error("[LDR PDF] Mobile worker load failed:", e);
            }
            return;
        }

        // Desktop: usar fs/path de Node.js
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const fs       = require("fs")   as typeof import("fs");
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const nodePath = require("path") as typeof import("path");
            const candidates: string[] = [];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const basePath = (this.app.vault.adapter as any).basePath as string | undefined;
            if (basePath) {
                candidates.push(nodePath.join(basePath, ".obsidian", "plugins", pluginId, workerFile));
            }
            candidates.push(
                nodePath.join(__dirname, workerFile),
                nodePath.join(__dirname, "..", workerFile),
            );

            for (const p of candidates) {
                if (fs.existsSync(p)) {
                    const blob = new Blob([fs.readFileSync(p, "utf8")], { type: "application/javascript" });
                    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
                    console.log("[LDR PDF] Worker:", p);
                    return;
                }
            }
            console.error("[LDR PDF] pdf.worker.min.js not found. Tried:", candidates.join(", "));
        } catch (e) {
            console.error("[LDR PDF] Worker init error:", e);
        }
    }

    // ── LIFECYCLE ─────────────────────────────────────────────────

    async onOpen() {
        const root = this.containerEl.children[1] as HTMLElement;
        root.empty();
        root.addClass("ldr-pdf-reader");
        this.buildUI(root);
        this.registerKeyboard();
        this.registerWheelAndTouch();

        // Sync cuando el SO cierra el fullscreen nativo (p.ej. tecla Escape del OS)
        this.registerDomEvent(document, "fullscreenchange", () => {
            if (!document.fullscreenElement && this.isFullscreen) {
                console.log("[LDR PDF] fullscreenchange: native FS exited externally");
                this.isFullscreen = false;
                document.body.classList.remove("ldr-fullscreen");
                this.containerEl.classList.remove("ldr-fullscreen-leaf");
            }
        });
    }

    async onClose() {
        this.saveProgress();
        this.thumbObserver?.disconnect();
        this.renderObserver?.disconnect();
        this.thumbObserver = null;
        this.renderObserver = null;
        if (this.zoomDebounce) clearTimeout(this.zoomDebounce);
        if (this.scrollRafId !== null) { cancelAnimationFrame(this.scrollRafId); this.scrollRafId = null; }
        if (this.isFullscreen) this.exitFullscreen();
    }

    // ── LOAD BOOK ─────────────────────────────────────────────────

    async loadBook(bookId: string) {
        await this.initWorker();
        const book = this.plugin.store.getBook(bookId);
        if (!book) { new Notice("Book not found."); return; }
        this.book = book;

        const state = this.plugin.store.getReadingState(bookId);
        this.currentPage      = state?.pageIndex ? state.pageIndex + 1 : 1;
        this.zoomLevel        = state?.pdfZoom ?? 1.0;
        this.layoutMode       = (state?.pdfLayoutMode as LayoutMode) ?? "single";
        this.sidebarOpen      = state?.pdfSidebarOpen ?? false;
        this.activeSidebarTab = (state?.pdfSidebarTab as SidebarTab) ?? "thumbs";
        this.sidebarWidth     = state?.pdfSidebarWidth ?? SIDEBAR_DEFAULT_WIDTH;
        this.darkMode         = state?.pdfDarkMode ?? false;

        if (this.sidebarOpen) {
            this.openSidebar();
        } else {
            this.closeSidebar();
        }

        const file = this.app.vault.getFiles().find(f => f.path === book.filePath);
        if (!file) { new Notice("PDF file not found in vault."); return; }

        try {
            const buffer = await this.app.vault.readBinary(file);
            this.pdfDoc = await pdfjsLib.getDocument({ data: buffer }).promise;
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
        await this.buildPagesLayout();
        if (this.darkMode) {
            for (const [pageNum, canvas] of this.slotCanvases) {
                canvas.addClass("ldr-pdf-canvas--dark");
                this.slotEls.get(pageNum)?.addClass("is-dark");
            }
        }
        this.scrollToPage(this.currentPage, "instant");
    }

    // ── UI ────────────────────────────────────────────────────────

    private buildUI(root: HTMLElement) {
        this.headerEl = root.createDiv({ cls: "ldr-pdf-header" });
        this.buildHeader();

        const main = root.createDiv({ cls: "ldr-pdf-main" });

        this.sidebarEl = main.createDiv({ cls: "ldr-pdf-sidebar" });
        this.buildSidebar();
        this.buildSidebarResizeHandle();

        this.viewportEl = main.createDiv({ cls: "ldr-pdf-viewport" });
        this.pagesContainerEl = this.viewportEl.createDiv({ cls: "ldr-pdf-pages" });

        this.pageIndicatorEl = this.viewportEl.createDiv({ cls: "ldr-pdf-page-indicator" });
        this.updatePageIndicator();

        this.settingsPanel = root.createDiv({ cls: "ldr-pdf-settings-panel" });
        this.buildSettingsPanel();

        this.footerEl = root.createDiv({ cls: "ldr-pdf-footer" });
        this.buildFooter();

        // Seguimiento de página actual al hacer scroll
        this.registerDomEvent(this.viewportEl, "scroll", () => this.onScroll());
    }

    private buildHeader() {
        this.headerEl.empty();

        const backBtn = this.headerEl.createDiv({ cls: "ldr-pdf-btn", attr: { title: "Back to library" } });
        backBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>`;
        backBtn.addEventListener("click", () => {
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

        this.sidebarBtnEl = actions.createDiv({ cls: "ldr-pdf-btn", attr: { title: "Toggle sidebar" } });
        this.sidebarBtnEl.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>`;
        this.sidebarBtnEl.addEventListener("click", () => this.toggleSidebar());

        this.settingsBtnEl = actions.createDiv({ cls: "ldr-pdf-btn", attr: { title: "Settings" } });
        this.settingsBtnEl.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
        this.settingsBtnEl.addEventListener("click", () => this.toggleSettings());

        const fsBtn = actions.createDiv({ cls: "ldr-pdf-btn", attr: { title: "Fullscreen (F)" } });
        fsBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>`;
        fsBtn.addEventListener("click", () => this.toggleFullscreen());
    }

    private buildFooter() {
        this.footerEl.empty();

        const prevBtn = this.footerEl.createDiv({ cls: "ldr-pdf-btn", attr: { title: "Previous page" } });
        prevBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>`;
        prevBtn.addEventListener("click", () => this.scrollToPage(this.prevSpreadStart(this.currentPage)));

        const pageRow = this.footerEl.createDiv({ cls: "ldr-pdf-page-row" });
        this.pageInputEl = pageRow.createEl("input", {
            cls: "ldr-pdf-page-input",
            attr: { type: "number", min: "1", value: "1" },
        });
        this.pageInputEl.addEventListener("change", () => {
            const n = parseInt(this.pageInputEl.value);
            if (!isNaN(n)) this.scrollToPage(Math.max(1, Math.min(this.totalPages, n)));
        });
        this.pageInputEl.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                const n = parseInt(this.pageInputEl.value);
                if (!isNaN(n)) this.scrollToPage(Math.max(1, Math.min(this.totalPages, n)));
                this.pageInputEl.blur();
            }
            e.stopPropagation();
        });
        this.pageInputEl.addEventListener("blur", () => {
            const n = parseInt(this.pageInputEl.value);
            if (isNaN(n) || n < 1 || n > this.totalPages) this.pageInputEl.value = String(this.currentPage);
        });

        this.totalPagesEl = pageRow.createSpan({ cls: "ldr-pdf-total-pages", text: `/ ${this.totalPages || "—"}` });

        const nextBtn = this.footerEl.createDiv({ cls: "ldr-pdf-btn", attr: { title: "Next page" } });
        nextBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;
        nextBtn.addEventListener("click", () => this.scrollToPage(this.nextSpreadStart(this.currentPage)));
    }

    private buildSidebar() {
        this.sidebarEl.empty();

        const tabBar = this.sidebarEl.createDiv({ cls: "ldr-pdf-sidebar-tabs" });

        const thumbTab = tabBar.createSpan({
            cls: `ldr-pdf-sidebar-tab${this.activeSidebarTab === "thumbs" ? " is-active" : ""}`,
            text: "Pages",
        });
        thumbTab.addEventListener("click", () => {
            this.activeSidebarTab = "thumbs";
            this.buildSidebar();
            this.buildThumbnails();
            this.saveProgress();
        });

        const tocTab = tabBar.createSpan({
            cls: `ldr-pdf-sidebar-tab${this.activeSidebarTab === "toc" ? " is-active" : ""}`,
            text: "Contents",
        });
        tocTab.addEventListener("click", () => {
            this.activeSidebarTab = "toc";
            this.buildSidebar();
            this.saveProgress();
        });

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
        let dragging = false, startX = 0, startWidth = 0;

        const onMove = (e: MouseEvent) => {
            if (!dragging) return;
            const w = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, startWidth + (e.clientX - startX)));
            this.sidebarWidth = w;
            this.sidebarEl.style.width = `${w}px`;
        };
        const onUp = () => {
            if (!dragging) return;
            dragging = false;
            this.sidebarEl.removeClass("is-resizing");
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            this.saveProgress();
        };
        handle.addEventListener("mousedown", (e) => {
            e.preventDefault();
            dragging = true;
            startX = e.clientX;
            startWidth = this.sidebarEl.offsetWidth;
            this.sidebarEl.addClass("is-resizing");
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });
    }

    private buildSettingsPanel() {
        this.settingsPanel.empty();

        // Fullscreen
        const fsSection = this.settingsPanel.createDiv({ cls: "ldr-pdf-settings-section" });
        const fsBtn = fsSection.createDiv({ cls: "ldr-pdf-fit-btn", text: this.isFullscreen ? "Exit fullscreen" : "Fullscreen" });
        fsBtn.addEventListener("click", () => { this.toggleFullscreen(); this.toggleSettings(); });

        this.settingsPanel.createDiv({ cls: "ldr-pdf-settings-sep" });

        // Layout
        const layoutSection = this.settingsPanel.createDiv({ cls: "ldr-pdf-settings-section" });
        layoutSection.createDiv({ cls: "ldr-pdf-settings-label", text: "Layout" });
        const layoutRow = layoutSection.createDiv({ cls: "ldr-pdf-settings-row" });
        ([
            { key: "single"     as LayoutMode, label: "Single"  },
            { key: "double-odd" as LayoutMode, label: "2P·Odd"  },
            { key: "double-even"as LayoutMode, label: "2P·Even" },
        ]).forEach(({ key, label }) => {
            const btn = layoutRow.createDiv({ cls: `ldr-pdf-fit-btn${this.layoutMode === key ? " is-active" : ""}`, text: label });
            btn.addEventListener("click", async () => {
                this.layoutMode = key;
                this.buildSettingsPanel();
                await this.buildPagesLayout();
                this.scrollToPage(this.currentPage, "instant");
                this.saveProgress();
            });
        });

        // Fit
        const fitSection = this.settingsPanel.createDiv({ cls: "ldr-pdf-settings-section" });
        fitSection.createDiv({ cls: "ldr-pdf-settings-label", text: "Fit" });
        const fitRow = fitSection.createDiv({ cls: "ldr-pdf-settings-row" });
        ([
            { key: "width"    as FitMode, label: "Width"  },
            { key: "height"   as FitMode, label: "Height" },
            { key: "page"     as FitMode, label: "Fit"    },
            { key: "original" as FitMode, label: "1:1"    },
        ]).forEach(({ key, label }) => {
            const btn = fitRow.createDiv({ cls: `ldr-pdf-fit-btn${this.fitMode === key ? " is-active" : ""}`, text: label });
            btn.addEventListener("click", async () => {
                this.fitMode = key;
                this.buildSettingsPanel();
                await this.buildPagesLayout();
                this.scrollToPage(this.currentPage, "instant");
            });
        });

        // Dark mode
        const darkSection = this.settingsPanel.createDiv({ cls: "ldr-pdf-settings-section" });
        darkSection.createDiv({ cls: "ldr-pdf-settings-label", text: "Dark mode" });
        const darkToggle = darkSection.createDiv({ cls: `ldr-pdf-toggle${this.darkMode ? " is-active" : ""}` });
        darkToggle.createDiv({ cls: "ldr-pdf-toggle-knob" });
        darkToggle.addEventListener("click", () => {
            this.darkMode = !this.darkMode;
            darkToggle.toggleClass("is-active", this.darkMode);
            for (const [pageNum, canvas] of this.slotCanvases) {
                canvas.toggleClass("ldr-pdf-canvas--dark", this.darkMode);
                this.slotEls.get(pageNum)?.toggleClass("is-dark", this.darkMode);
            }
            this.saveProgress();
        });

        // Zoom
        const zoomSection = this.settingsPanel.createDiv({ cls: "ldr-pdf-settings-section" });
        zoomSection.createDiv({ cls: "ldr-pdf-settings-label", text: "Zoom" });
        const zoomRow = zoomSection.createDiv({ cls: "ldr-pdf-settings-row" });
        zoomRow.createDiv({ cls: "ldr-pdf-btn", text: "−" })
            .addEventListener("click", async () => await this.setZoom(this.zoomLevel - 0.25));
        zoomRow.createSpan({ cls: "ldr-pdf-zoom-label", text: `${Math.round(this.zoomLevel * 100)}%` });
        zoomRow.createDiv({ cls: "ldr-pdf-btn", text: "+" })
            .addEventListener("click", async () => await this.setZoom(this.zoomLevel + 0.25));
    }

    // ── SCROLL INFINITO ───────────────────────────────────────────

    private async buildPagesLayout() {
        if (!this.pdfDoc) return;

        // Limpiar CSS live-zoom antes de reconstruir dimensiones reales
        this.pagesContainerEl.style.zoom = "";
        this.renderObserver?.disconnect();
        this.renderingPages.clear();

        // Escala base con la primera página
        const firstPage: PdfPage = await this.pdfDoc.getPage(1);
        this.baseScale    = this.computeBaseScale(firstPage);
        this.renderedZoom = this.zoomLevel;
        const dpr         = window.devicePixelRatio || 1;
        const scale       = this.baseScale * this.zoomLevel * dpr;
        const baseVp      = firstPage.getViewport({ scale });
        const cssW        = baseVp.width  / dpr;
        const cssH        = baseVp.height / dpr;

        const newRows     = this.getLayoutRows();
        const newPageNums = newRows.flat();

        // Rebuild DOM solo si cambia la estructura (primer carga, cambio de layout)
        const needsRebuild =
            newPageNums.length !== this.slotEls.size ||
            newPageNums.some(p => !this.slotEls.has(p));

        if (needsRebuild) {
            this.pagesContainerEl.empty();
            this.slotEls.clear();
            this.slotCanvases.clear();

            for (const row of newRows) {
                const rowEl = this.pagesContainerEl.createDiv({ cls: "ldr-pdf-row" });
                for (const pageNum of row) {
                    const slot = rowEl.createDiv({
                        cls: "ldr-pdf-page-slot",
                        attr: { "data-page": String(pageNum) },
                    });
                    slot.style.width  = `${cssW}px`;
                    slot.style.height = `${cssH}px`;
                    if (this.darkMode) slot.addClass("is-dark");
                    const canvas = slot.createEl("canvas", { cls: "ldr-pdf-canvas" });
                    canvas.width  = baseVp.width;
                    canvas.height = baseVp.height;
                    canvas.style.width  = `${cssW}px`;
                    canvas.style.height = `${cssH}px`;
                    if (this.darkMode) canvas.addClass("ldr-pdf-canvas--dark");
                    this.slotEls.set(pageNum, slot);
                    this.slotCanvases.set(pageNum, canvas);
                }
            }
        } else {
            // Solo zoom: CSS live-zoom ya proporcionó feedback; ahora ajustamos
            // dimensiones de slots para que el IntersectionObserver re-renderice
            for (const [, slot] of this.slotEls) {
                slot.style.width  = `${cssW}px`;
                slot.style.height = `${cssH}px`;
            }
            for (const [, canvas] of this.slotCanvases) {
                canvas.style.width  = `${cssW}px`;
                canvas.style.height = `${cssH}px`;
            }
        }

        // Observer lazy — rootMargin amplio para precargar
        this.renderObserver = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    const n = parseInt((entry.target as HTMLElement).dataset.page ?? "0");
                    if (n > 0 && !this.renderingPages.has(n)) this.doRenderPage(n);
                }
            },
            { root: this.viewportEl, rootMargin: "500px" },
        );
        for (const [, slot] of this.slotEls) this.renderObserver.observe(slot);
    }

    private getLayoutRows(): number[][] {
        const rows: number[][] = [];
        if (this.layoutMode === "single") {
            for (let i = 1; i <= this.totalPages; i++) rows.push([i]);
        } else if (this.layoutMode === "double-odd") {
            rows.push([1]);
            for (let i = 2; i <= this.totalPages; i += 2) {
                const row: number[] = [i];
                if (i + 1 <= this.totalPages) row.push(i + 1);
                rows.push(row);
            }
        } else {
            for (let i = 1; i <= this.totalPages; i += 2) {
                const row: number[] = [i];
                if (i + 1 <= this.totalPages) row.push(i + 1);
                rows.push(row);
            }
        }
        return rows;
    }

    private async doRenderPage(pageNum: number) {
        if (!this.pdfDoc) return;
        this.renderingPages.add(pageNum);
        try {
            const page: PdfPage = await this.pdfDoc.getPage(pageNum);
            const dpr   = window.devicePixelRatio || 1;
            const scale = this.baseScale * this.zoomLevel * dpr;
            const vp    = page.getViewport({ scale });
            const cssW  = vp.width  / dpr;
            const cssH  = vp.height / dpr;

            const canvas = this.slotCanvases.get(pageNum);
            const slot   = this.slotEls.get(pageNum);
            if (!canvas || !slot) return;

            // ── Off-screen render ─────────────────────────────────────
            // Renderizamos en un canvas oculto para que el visible nunca
            // quede en blanco durante el proceso async de pdf.js.
            const offscreen = document.createElement("canvas");
            offscreen.width  = vp.width;
            offscreen.height = vp.height;
            await page.render({
                canvasContext: offscreen.getContext("2d")!,
                viewport: vp,
            }).promise;

            // Check de stale: si el slot fue eliminado mientras renderizábamos
            if (!this.slotCanvases.has(pageNum)) return;

            // ── Swap atómico ──────────────────────────────────────────
            // Estas tres operaciones son síncronas → el browser las agrupa
            // en un solo frame → el usuario nunca ve el canvas en blanco.
            canvas.width  = vp.width;
            canvas.height = vp.height;
            canvas.getContext("2d")!.drawImage(offscreen, 0, 0);

            canvas.style.width  = `${cssW}px`;
            canvas.style.height = `${cssH}px`;
            slot.style.width    = `${cssW}px`;
            slot.style.height   = `${cssH}px`;
            canvas.toggleClass("ldr-pdf-canvas--dark", this.darkMode);
            slot.toggleClass("is-dark", this.darkMode);
        } catch (e) {
            console.warn("[LDR PDF] render page", pageNum, e);
        } finally {
            this.renderingPages.delete(pageNum);
        }
    }

    private scrollToPage(pageNum: number, behavior: ScrollBehavior = "smooth") {
        const slot = this.slotEls.get(pageNum);
        if (slot) slot.scrollIntoView({ behavior, block: "start" });
    }

    // ── SCROLL TRACKING ───────────────────────────────────────────

    private onScroll() {
        if (this.scrollRafId !== null) return;
        this.scrollRafId = requestAnimationFrame(() => {
            this.scrollRafId = null;
            this.updateCurrentPageFromScroll();
        });
    }

    private updateCurrentPageFromScroll() {
        if (!this.viewportEl || this.slotEls.size === 0) return;
        const vpRect = this.viewportEl.getBoundingClientRect();
        const vpMid  = vpRect.top + vpRect.height / 2;

        let closest = this.currentPage;
        let minDist = Infinity;
        for (const [n, slot] of this.slotEls) {
            const r    = slot.getBoundingClientRect();
            const mid  = r.top + r.height / 2;
            const dist = Math.abs(mid - vpMid);
            if (dist < minDist) { minDist = dist; closest = n; }
        }

        if (closest !== this.currentPage) {
            this.currentPage = closest;
            this.updatePageIndicator();
            this.highlightThumb(closest);
            this.saveProgress();
        }
    }

    // ── SCALE ─────────────────────────────────────────────────────

    private computeBaseScale(page: PdfPage): number {
        const vp1 = page.getViewport({ scale: 1.0 });
        const cw  = this.viewportEl.clientWidth  || window.innerWidth;
        const ch  = this.viewportEl.clientHeight || window.innerHeight;
        // En modo doble la fila contiene dos páginas lado a lado
        const isDouble = this.layoutMode !== "single";
        const totalW   = isDouble ? vp1.width * 2 + SPREAD_GAP : vp1.width;
        switch (this.fitMode) {
            case "width":    return cw / totalW;
            case "height":   return ch / vp1.height;
            case "page":     return Math.min(cw / totalW, ch / vp1.height);
            case "original": return 1.0;
        }
    }

    // ── ZOOM ──────────────────────────────────────────────────────

    private async setZoom(level: number) {
        const newZoom = Math.max(0.25, Math.min(5.0, level));
        if (newZoom === this.zoomLevel) return;
        const saved = this.currentPage;
        this.zoomLevel = newZoom;
        // Para botones discretos (+ / −) re-renderizamos directamente
        await this.buildPagesLayout();
        this.scrollToPage(saved, "instant");
        this.buildSettingsPanel();
    }

    private handleZoomWheel(deltaY: number) {
        const factor  = deltaY < 0 ? 1.08 : 0.92;
        const newZoom = Math.max(0.25, Math.min(5.0, this.zoomLevel * factor));
        if (newZoom === this.zoomLevel) return;
        this.zoomLevel = newZoom;

        // ── Live zoom via CSS ─────────────────────────────────────────
        // Escala visualmente el contenedor ya renderizado de forma instantánea
        // sin re-renderizar nada. Afecta al layout (scrollbar se actualiza) por
        // ser `zoom` y no `transform: scale`.
        if (this.renderedZoom > 0) {
            this.pagesContainerEl.style.zoom = String(this.zoomLevel / this.renderedZoom);
        }

        if (this.zoomDebounce) clearTimeout(this.zoomDebounce);
        this.zoomDebounce = setTimeout(async () => {
            this.zoomDebounce = null;
            const saved = this.currentPage;
            // buildPagesLayout limpia el CSS zoom y re-renderiza con off-screen canvas
            await this.buildPagesLayout();
            this.scrollToPage(saved, "instant");
        }, 400);
    }

    private resetZoom() { this.setZoom(1.0); }

    // ── NAVEGACIÓN ────────────────────────────────────────────────

    async goToPage(pageNum: number) {
        if (!this.pdfDoc) return;
        pageNum = Math.max(1, Math.min(this.totalPages, pageNum));
        this.scrollToPage(pageNum);
        this.currentPage = pageNum;
        this.updatePageIndicator();
        this.saveProgress();
    }

    private nextSpreadStart(p: number): number {
        if (this.layoutMode === "single") return Math.min(p + 1, this.totalPages);
        if (this.layoutMode === "double-odd") {
            if (p <= 1) return Math.min(2, this.totalPages);
            const left = p % 2 === 0 ? p : p - 1;
            return Math.min(left + 2, this.totalPages);
        }
        const left = p % 2 === 1 ? p : p - 1;
        return Math.min(left + 2, this.totalPages);
    }

    private prevSpreadStart(p: number): number {
        if (this.layoutMode === "single") return Math.max(p - 1, 1);
        if (this.layoutMode === "double-odd") {
            if (p <= 2) return 1;
            const left = p % 2 === 0 ? p : p - 1;
            return Math.max(left - 2, 2);
        }
        const left = p % 2 === 1 ? p : p - 1;
        return Math.max(left - 2, 1);
    }

    private updatePageIndicator() {
        if (this.pageIndicatorEl) this.pageIndicatorEl.textContent = `${this.currentPage} / ${this.totalPages || "—"}`;
        if (this.pageInputEl)    this.pageInputEl.value = String(this.currentPage);
        if (this.totalPagesEl)   this.totalPagesEl.textContent = `/ ${this.totalPages || "—"}`;
    }

    // ── TOC ───────────────────────────────────────────────────────

    private async loadToc() {
        if (!this.pdfDoc) return;
        try {
            const outline = await this.pdfDoc.getOutline();
            this.tocItems = outline ? this.flattenOutline(outline, 0) : [];
        } catch { this.tocItems = []; }
    }

    private flattenOutline(
        items: { title: string; dest: unknown; items: unknown[] }[],
        depth: number,
    ): TocItem[] {
        const result: TocItem[] = [];
        for (const item of items) {
            result.push({ title: item.title, dest: item.dest as TocItem["dest"], items: [], depth });
            if (item.items?.length) {
                result.push(...this.flattenOutline(item.items as { title: string; dest: unknown; items: unknown[] }[], depth + 1));
            }
        }
        return result;
    }

    private renderTocList() {
        this.tocContainer.empty();
        if (this.tocItems.length === 0) {
            this.tocContainer.createDiv({ cls: "ldr-pdf-toc-empty", text: "No table of contents" });
            return;
        }
        this.tocItems.forEach((item) => {
            const el = this.tocContainer.createDiv({ cls: "ldr-pdf-toc-item", text: item.title });
            el.style.paddingLeft = `${8 + item.depth * 12}px`;
            el.addEventListener("click", async () => {
                if (!this.pdfDoc || !item.dest) return;
                try {
                    let pageNum: number;
                    if (typeof item.dest === "string") {
                        const ref = await this.pdfDoc.getDestination(item.dest);
                        pageNum   = await this.pdfDoc.getPageIndex(ref[0]) + 1;
                    } else if (Array.isArray(item.dest)) {
                        pageNum = await this.pdfDoc.getPageIndex((item.dest as unknown[])[0]) + 1;
                    } else { return; }
                    await this.goToPage(pageNum);
                } catch (err) { console.warn("[LDR PDF] TOC nav:", err); }
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
            (entries) => {
                entries.forEach((entry) => {
                    if (!entry.isIntersecting) return;
                    const el  = entry.target as HTMLElement;
                    const idx = parseInt(el.dataset.page ?? "0");
                    if (idx > 0 && !this.thumbRendering.has(idx)) {
                        this.thumbObserver?.unobserve(el);
                        this.renderThumb(el, idx);
                    }
                });
            },
            { root: this.thumbsContainer, rootMargin: "300px" },
        );

        for (let i = 1; i <= this.totalPages; i++) {
            const cell = this.thumbsContainer.createDiv({
                cls: "ldr-pdf-thumb-cell",
                attr: { "data-page": String(i) },
            });
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
            const dpr    = Math.min(window.devicePixelRatio || 1, 2); // cap en 2 para thumbs
            const scale  = 0.15 * dpr;
            const vp     = page.getViewport({ scale });
            const canvas = cell.querySelector("canvas") as HTMLCanvasElement;
            if (!canvas) return;
            canvas.width        = Math.round(vp.width);
            canvas.height       = Math.round(vp.height);
            canvas.style.width  = `${vp.width / dpr}px`;
            canvas.style.height = `${vp.height / dpr}px`;
            await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
        } catch { /* silencioso */ } finally { this.thumbRendering.delete(pageNum); }
    }

    private highlightThumb(pageNum: number) {
        this.thumbsContainer.querySelectorAll(".ldr-pdf-thumb-cell").forEach((el) => {
            el.toggleClass("is-active", parseInt((el as HTMLElement).dataset.page ?? "0") === pageNum);
        });
        const active = this.thumbsContainer.querySelector(".ldr-pdf-thumb-cell.is-active") as HTMLElement;
        if (active) active.scrollIntoView({ block: "nearest" });
    }

    // ── SIDEBAR / SETTINGS ────────────────────────────────────────

    private openSidebar() {
        this.sidebarOpen = true;
        // Width controlado 100% por inline style — no depende de clase CSS
        this.sidebarEl.style.width = `${this.sidebarWidth}px`;
        this.sidebarBtnEl?.addClass("is-active");
    }

    private closeSidebar() {
        this.sidebarOpen = false;
        // "0px" explícito — más fiable que "" en todos los browsers/WebViews
        this.sidebarEl.style.width = "0px";
        this.sidebarBtnEl?.removeClass("is-active");
    }

    private toggleSidebar() {
        this.sidebarOpen ? this.closeSidebar() : this.openSidebar();
        this.saveProgress();
    }

    private toggleSettings() {
        this.settingsOpen = !this.settingsOpen;
        this.settingsPanel.toggleClass("is-open", this.settingsOpen);
        this.settingsBtnEl.toggleClass("is-active", this.settingsOpen);
        if (this.settingsOpen) {
            const handler = (e: MouseEvent) => {
                if (!this.settingsPanel.contains(e.target as Node) && e.target !== this.settingsBtnEl) {
                    this.settingsOpen = false;
                    this.settingsPanel.removeClass("is-open");
                    this.settingsBtnEl.removeClass("is-active");
                    document.removeEventListener("click", handler, true);
                }
            };
            setTimeout(() => document.addEventListener("click", handler, true), 0);
        }
    }

    // ── FULLSCREEN ────────────────────────────────────────────────
    // Idéntico a ImageReaderView y ReaderView.

    private toggleFullscreen() {
        console.log("[LDR PDF] toggleFullscreen — isFullscreen:", this.isFullscreen);
        this.isFullscreen ? this.exitFullscreen() : this.enterFullscreen();
    }

    private enterFullscreen() {
        console.log("[LDR PDF] enterFullscreen()");
        this.isFullscreen = true;
        document.body.classList.add("ldr-fullscreen");
        this.containerEl.classList.add("ldr-fullscreen-leaf");
        console.log("[LDR PDF] body.ldr-fullscreen:", document.body.classList.contains("ldr-fullscreen"));
        console.log("[LDR PDF] containerEl classes:", this.containerEl.className);
        if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen()
                .then(() => console.log("[LDR PDF] requestFullscreen OK"))
                .catch((e) => console.warn("[LDR PDF] requestFullscreen failed:", e));
        } else {
            console.warn("[LDR PDF] requestFullscreen not available on this platform");
        }
    }

    private exitFullscreen() {
        console.log("[LDR PDF] exitFullscreen()");
        this.isFullscreen = false;
        document.body.classList.remove("ldr-fullscreen");
        this.containerEl.classList.remove("ldr-fullscreen-leaf");
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    }

    // ── OPEN EXTERNAL ─────────────────────────────────────────────

    private async openExternal() {
        if (!this.book) return;
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const fullPath = (this.app.vault.adapter as any).getFullPath?.(this.book.filePath);
            if (!fullPath) { new Notice("Cannot resolve file path."); return; }
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { shell } = require("electron");
            await shell.openPath(fullPath);
        } catch (err) {
            new Notice("Could not open file externally.");
            console.error("[LDR PDF] openExternal:", err);
        }
    }

    // ── KEYBOARD ──────────────────────────────────────────────────

    private registerKeyboard() {
        this.registerDomEvent(document, "keydown", async (e: KeyboardEvent) => {
            if (this.app.workspace.activeLeaf?.view !== this) return;
            const t = e.target as HTMLElement;
            if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable) return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            switch (e.key) {
                case "ArrowRight": case "ArrowDown": case "PageDown": case " ":
                    e.preventDefault();
                    this.scrollToPage(this.nextSpreadStart(this.currentPage));
                    break;
                case "ArrowLeft": case "ArrowUp": case "PageUp":
                    e.preventDefault();
                    this.scrollToPage(this.prevSpreadStart(this.currentPage));
                    break;
                case "Home":  e.preventDefault(); this.scrollToPage(1); break;
                case "End":   e.preventDefault(); this.scrollToPage(this.totalPages); break;
                case "+": case "=": e.preventDefault(); await this.setZoom(this.zoomLevel + 0.25); break;
                case "-":           e.preventDefault(); await this.setZoom(this.zoomLevel - 0.25); break;
                case "0":           e.preventDefault(); this.resetZoom(); break;
                case "f": case "F": this.toggleFullscreen(); break;
                case "Escape": if (this.isFullscreen) this.exitFullscreen(); break;
            }
        });
    }

    // ── WHEEL + TOUCH ─────────────────────────────────────────────

    private registerWheelAndTouch() {
        // Ctrl+scroll → zoom. Scroll normal → nativo (no preventDefault)
        this.registerDomEvent(this.viewportEl, "wheel", (e: WheelEvent) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                let dy = e.deltaY;
                if (e.deltaMode === 1) dy *= 20;
                else if (e.deltaMode === 2) dy *= 400;
                this.handleZoomWheel(dy);
            }
        }, { passive: false });

        // Pinch = zoom (2 dedos); 1 dedo = scroll nativo
        this.registerDomEvent(this.viewportEl, "touchstart", (e: TouchEvent) => {
            if (e.touches.length === 2) {
                this.isPinching     = true;
                this.pinchStartDist = this.getTouchDist(e);
                this.pinchStartZoom = this.zoomLevel;
                e.preventDefault();
            }
        }, { passive: false });

        this.registerDomEvent(this.viewportEl, "touchmove", (e: TouchEvent) => {
            if (e.touches.length === 2 && this.isPinching) {
                const newZoom = Math.max(0.25, Math.min(5.0,
                    this.pinchStartZoom * (this.getTouchDist(e) / this.pinchStartDist)));
                this.zoomLevel = newZoom;

                // Live zoom via CSS — feedback instantáneo sin re-renderizar
                if (this.renderedZoom > 0) {
                    this.pagesContainerEl.style.zoom = String(this.zoomLevel / this.renderedZoom);
                }

                if (this.zoomDebounce) clearTimeout(this.zoomDebounce);
                this.zoomDebounce = setTimeout(async () => {
                    this.zoomDebounce = null;
                    const saved = this.currentPage;
                    await this.buildPagesLayout();
                    this.scrollToPage(saved, "instant");
                }, 400);
                e.preventDefault();
            }
        }, { passive: false });

        this.registerDomEvent(this.viewportEl, "touchend", (e: TouchEvent) => {
            if (e.touches.length < 2) this.isPinching = false;
        }, { passive: false });
    }

    // ── TOUCH HELPERS ─────────────────────────────────────────────

    private getTouchDist(e: TouchEvent): number {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    // ── PROGRESS ──────────────────────────────────────────────────

    private saveProgress() {
        if (!this.book) return;
        const progress = this.totalPages > 0
            ? Math.round(((this.currentPage - 1) / this.totalPages) * 100)
            : 0;
        const existing = this.plugin.store.getReadingState(this.book.id);
        this.plugin.store.saveReadingState({
            bookId: this.book.id,
            cfi: "",
            currentPage: this.currentPage,
            totalPages: this.totalPages,
            currentChapterId: "",
            progress,
            lastReadAt: Date.now(),
            pageIndex: this.currentPage - 1,
            pdfZoom: this.zoomLevel,
            pdfLayoutMode: this.layoutMode,
            pdfSidebarOpen: this.sidebarOpen,
            pdfSidebarTab: this.activeSidebarTab,
            pdfSidebarWidth: this.sidebarWidth,
            pdfDarkMode: this.darkMode,
            readingMode: existing?.readingMode,
        });
    }
}
