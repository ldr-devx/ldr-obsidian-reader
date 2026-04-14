// ============================================================
// src/views/PdfReaderView.ts
// Lector PDF con pdf.js: scroll continuo, zoom focal, pan,
// layout doble página, sidebar, fullscreen real.
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf");
// El worker se inicializa en initWorker() usando app.vault.adapter
// porque __dirname no es fiable en el bundle compilado por esbuild.

import { ItemView, WorkspaceLeaf, Notice, Platform } from "obsidian";
import type LdrEpubReaderPlugin from "../../main";
import { Book } from "../models";

export const PDF_READER_VIEW_TYPE = "ldr-pdf-reader";

type FitMode = "width" | "height" | "page" | "original";
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

const SPREAD_GAP = 4;
const IMMERSIVE_HIDE_DELAY = 3000;
const SIDEBAR_MIN_WIDTH = 100;
const SIDEBAR_MAX_WIDTH = 360;
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
    private panX = 0;
    private panY = 0;
    private darkMode = false;
    private isImmersive = false;
    private isFullscreen = false;
    private sidebarOpen = false;
    private sidebarWidth = SIDEBAR_DEFAULT_WIDTH;
    private activeSidebarTab: SidebarTab = "thumbs";
    private isRendering = false;
    private renderQueue: number | null = null;
    private settingsOpen = false;
    private immersiveHideTimer: ReturnType<typeof setTimeout> | null = null;

    // Zoom / pan — touch
    private isPinching = false;
    private pinchStartDist = 0;
    private pinchStartZoom = 1.0;
    private pinchStartPanX = 0;
    private pinchStartPanY = 0;
    private pinchFocalX = 0;
    private pinchFocalY = 0;
    private isDragging = false;
    private dragLastX = 0;
    private dragLastY = 0;
    private lastTapTime = 0;

    // Zoom / pan — mouse drag (desktop)
    private isMouseDragging = false;
    private mouseDragLastX = 0;
    private mouseDragLastY = 0;

    // Wheel / scroll state
    private wheelAccumY = 0;          // acumulador de scroll Y
    private wheelAccumX = 0;          // acumulador de scroll X
    private zoomCommitTimer: ReturnType<typeof setTimeout> | null = null;
    private rafPanId: number | null = null;

    // DOM refs
    private viewportEl: HTMLElement;
    private spreadEl: HTMLElement;
    private canvasEl: HTMLCanvasElement;
    private canvasRight: HTMLCanvasElement;
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
    private tocItems: TocItem[] = [];

    // Thumbnail lazy loading
    private thumbObserver: IntersectionObserver | null = null;
    private thumbRendering = new Set<number>();

    constructor(leaf: WorkspaceLeaf, plugin: LdrEpubReaderPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() { return PDF_READER_VIEW_TYPE; }
    getDisplayText() { return this.book?.title ?? "PDF Reader"; }
    getIcon() { return "file-text"; }

    // ── WORKER INIT ───────────────────────────────────────────────

    private initWorker(): void {
        if (pdfjsLib.GlobalWorkerOptions.workerSrc) return;

        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const fs = require("fs") as typeof import("fs");
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const nodePath = require("path") as typeof import("path");

            const pluginId = "ldr-obsidian-reader";
            const candidates: string[] = [];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const basePath = (this.app.vault.adapter as any).basePath as string | undefined;
            if (basePath) {
                candidates.push(
                    nodePath.join(basePath, ".obsidian", "plugins", pluginId, "pdf.worker.min.js"),
                );
            }

            candidates.push(
                nodePath.join(__dirname, "pdf.worker.min.js"),
                nodePath.join(__dirname, "..", "pdf.worker.min.js"),
                nodePath.join(__dirname, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.min.js"),
                nodePath.join(__dirname, "..", "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.min.js"),
            );

            for (const workerPath of candidates) {
                if (fs.existsSync(workerPath)) {
                    const workerCode = fs.readFileSync(workerPath, "utf8");
                    const blob = new Blob([workerCode], { type: "application/javascript" });
                    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
                    console.log("[LDR PDF] Worker inicializado desde:", workerPath);
                    return;
                }
            }

            console.error(
                "[LDR PDF] No se encontró pdf.worker.min.js. Rutas intentadas:\n" +
                candidates.join("\n"),
            );
        } catch (e) {
            console.error("[LDR PDF] Error inicializando worker de pdf.js:", e);
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
        this.registerMouseDrag();
        this.registerImmersiveMouseMove();

        // Sincronizar si el usuario sale de fullscreen con Escape del SO
        this.registerDomEvent(document, "fullscreenchange", () => {
            if (!document.fullscreenElement && this.isFullscreen) {
                this.isFullscreen = false;
                document.body.classList.remove("ldr-fullscreen");
                this.containerEl.classList.remove("ldr-fullscreen-leaf");
            }
        });
    }

    async onClose() {
        this.saveProgress();
        this.thumbObserver?.disconnect();
        this.thumbObserver = null;
        if (this.immersiveHideTimer) clearTimeout(this.immersiveHideTimer);
        if (this.zoomCommitTimer) clearTimeout(this.zoomCommitTimer);
        if (this.rafPanId !== null) { cancelAnimationFrame(this.rafPanId); this.rafPanId = null; }
        if (this.isImmersive) this.exitImmersive();
    }

    // ── LOAD BOOK ─────────────────────────────────────────────────

    async loadBook(bookId: string) {
        this.initWorker();
        const book = this.plugin.store.getBook(bookId);
        if (!book) { new Notice("Book not found."); return; }
        this.book = book;

        const state = this.plugin.store.getReadingState(bookId);
        this.currentPage = state?.pageIndex ? state.pageIndex + 1 : 1;
        this.zoomLevel = state?.pdfZoom ?? 1.0;
        this.layoutMode = (state?.pdfLayoutMode as LayoutMode) ?? "single";
        this.sidebarOpen = state?.pdfSidebarOpen ?? false;
        this.activeSidebarTab = (state?.pdfSidebarTab as SidebarTab) ?? "thumbs";
        this.sidebarWidth = state?.pdfSidebarWidth ?? SIDEBAR_DEFAULT_WIDTH;

        this.sidebarEl.toggleClass("is-open", this.sidebarOpen);
        if (this.sidebarOpen) {
            this.sidebarEl.style.width = `${this.sidebarWidth}px`;
        }

        const file = this.app.vault.getFiles().find(f => f.path === book.filePath);
        if (!file) { new Notice("PDF file not found in vault."); return; }

        try {
            const buffer = await this.app.vault.readBinary(file);
            const loadingTask = pdfjsLib.getDocument({ data: buffer });
            this.pdfDoc = await loadingTask.promise;
            this.totalPages = this.pdfDoc.numPages;
        } catch (err) {
            new Notice("Failed to load PDF.");
            console.error("[LDR PDF]", err);
            return;
        }

        this.headerEl.querySelector(".ldr-pdf-title")!.textContent = book.title;

        if (this.totalPagesEl) this.totalPagesEl.textContent = `/ ${this.totalPages}`;
        if (this.pageInputEl) {
            this.pageInputEl.max = String(this.totalPages);
            this.pageInputEl.value = String(this.currentPage);
        }

        await this.loadToc();
        this.buildThumbnails();
        this.buildSidebar();
        await this.renderPage(this.currentPage);
    }

    // ── UI BUILDER ────────────────────────────────────────────────

    private buildUI(root: HTMLElement) {
        this.headerEl = root.createDiv({ cls: "ldr-pdf-header" });
        this.buildHeader();

        const main = root.createDiv({ cls: "ldr-pdf-main" });

        this.sidebarEl = main.createDiv({ cls: "ldr-pdf-sidebar" });
        this.buildSidebar();
        this.buildSidebarResizeHandle();

        this.viewportEl = main.createDiv({ cls: "ldr-pdf-viewport" });

        this.spreadEl = this.viewportEl.createDiv({ cls: "ldr-pdf-spread" });
        this.canvasEl = this.spreadEl.createEl("canvas", { cls: "ldr-pdf-canvas" });
        this.canvasRight = this.spreadEl.createEl("canvas", { cls: "ldr-pdf-canvas" });
        this.canvasRight.style.display = "none";

        this.pageIndicatorEl = this.viewportEl.createDiv({ cls: "ldr-pdf-page-indicator" });
        this.updatePageIndicator();

        this.settingsPanel = root.createDiv({ cls: "ldr-pdf-settings-panel" });
        this.buildSettingsPanel();

        this.footerEl = root.createDiv({ cls: "ldr-pdf-footer" });
        this.buildFooter();
    }

    private buildHeader() {
        this.headerEl.empty();

        const backBtn = this.headerEl.createDiv({ cls: "ldr-pdf-btn", attr: { title: "Back to library" } });
        backBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>`;
        backBtn.addEventListener("click", () => {
            if (this.isImmersive) this.exitImmersive();
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
        this.settingsBtnEl.addEventListener("click", () => this.toggleSettings());

        const immersiveBtn = actions.createDiv({ cls: "ldr-pdf-btn", attr: { title: "Fullscreen (F)" } });
        immersiveBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>`;
        immersiveBtn.addEventListener("click", () => this.toggleImmersive());
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
            if (isNaN(n) || n < 1 || n > this.totalPages) {
                this.pageInputEl.value = String(this.currentPage);
            }
        });

        this.totalPagesEl = pageRow.createSpan({
            cls: "ldr-pdf-total-pages",
            text: `/ ${this.totalPages || "—"}`,
        });

        const nextBtn = this.footerEl.createDiv({ cls: "ldr-pdf-btn", attr: { title: "Next page" } });
        nextBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;
        nextBtn.addEventListener("click", () => this.goToPage(this.nextSpreadStart(this.currentPage)));
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
        this.tocContainer = this.sidebarEl.createDiv({ cls: "ldr-pdf-toc" });

        if (this.activeSidebarTab === "thumbs") {
            this.thumbsContainer.style.display = "flex";
            this.tocContainer.style.display = "none";
        } else {
            this.thumbsContainer.style.display = "none";
            this.tocContainer.style.display = "block";
            this.renderTocList();
        }
    }

    private buildSidebarResizeHandle() {
        const handle = this.sidebarEl.createDiv({ cls: "ldr-pdf-sidebar-resize" });
        let dragging = false;
        let startX = 0;
        let startWidth = 0;

        const onMove = (e: MouseEvent) => {
            if (!dragging) return;
            const newWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, startWidth + (e.clientX - startX)));
            this.sidebarWidth = newWidth;
            this.sidebarEl.style.width = `${newWidth}px`;
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

        // ── Fullscreen ────────────────────────────────────────────
        const fsSection = this.settingsPanel.createDiv({ cls: "ldr-pdf-settings-section" });
        const fsBtn = fsSection.createDiv({ cls: "ldr-pdf-fit-btn", text: this.isImmersive ? "Exit fullscreen" : "Fullscreen" });
        fsBtn.addEventListener("click", () => {
            this.toggleImmersive();
            this.toggleSettings(); // cerrar panel
        });

        this.settingsPanel.createDiv({ cls: "ldr-pdf-settings-sep" });

        // ── Layout mode ───────────────────────────────────────────
        const layoutSection = this.settingsPanel.createDiv({ cls: "ldr-pdf-settings-section" });
        layoutSection.createDiv({ cls: "ldr-pdf-settings-label", text: "Layout" });
        const layoutRow = layoutSection.createDiv({ cls: "ldr-pdf-settings-row" });

        const layoutOptions: { key: LayoutMode; label: string }[] = [
            { key: "single", label: "Single" },
            { key: "double-odd", label: "2P·Odd" },
            { key: "double-even", label: "2P·Even" },
        ];
        layoutOptions.forEach(({ key, label }) => {
            const btn = layoutRow.createDiv({
                cls: `ldr-pdf-fit-btn${this.layoutMode === key ? " is-active" : ""}`,
                text: label,
            });
            btn.addEventListener("click", async () => {
                this.layoutMode = key;
                this.panX = 0;
                this.panY = 0;
                const snapTo = this.getSpreadPages(this.currentPage).left;
                this.buildSettingsPanel();
                await this.renderPage(snapTo);
                this.saveProgress();
            });
        });

        // ── Fit mode ──────────────────────────────────────────────
        const fitSection = this.settingsPanel.createDiv({ cls: "ldr-pdf-settings-section" });
        fitSection.createDiv({ cls: "ldr-pdf-settings-label", text: "Fit" });
        const fitRow = fitSection.createDiv({ cls: "ldr-pdf-settings-row" });

        const fitOptions: { key: FitMode; label: string }[] = [
            { key: "width", label: "Width" },
            { key: "height", label: "Height" },
            { key: "page", label: "Fit" },
            { key: "original", label: "1:1" },
        ];
        fitOptions.forEach(({ key, label }) => {
            const btn = fitRow.createDiv({
                cls: `ldr-pdf-fit-btn${this.fitMode === key ? " is-active" : ""}`,
                text: label,
            });
            btn.addEventListener("click", async () => {
                this.fitMode = key;
                this.panX = 0;
                this.panY = 0;
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
            this.canvasEl.toggleClass("ldr-pdf-canvas--dark", this.darkMode);
            this.canvasRight.toggleClass("ldr-pdf-canvas--dark", this.darkMode);
            darkToggle.toggleClass("is-active", this.darkMode);
        });

        // ── Zoom controls ─────────────────────────────────────────
        const zoomSection = this.settingsPanel.createDiv({ cls: "ldr-pdf-settings-section" });
        zoomSection.createDiv({ cls: "ldr-pdf-settings-label", text: "Zoom" });
        const zoomRow = zoomSection.createDiv({ cls: "ldr-pdf-settings-row" });

        const zoomOut = zoomRow.createDiv({ cls: "ldr-pdf-btn", text: "−" });
        zoomOut.addEventListener("click", async () => { await this.setZoom(this.zoomLevel - 0.25); });
        zoomRow.createSpan({ cls: "ldr-pdf-zoom-label", text: `${Math.round(this.zoomLevel * 100)}%` });
        const zoomIn = zoomRow.createDiv({ cls: "ldr-pdf-btn", text: "+" });
        zoomIn.addEventListener("click", async () => { await this.setZoom(this.zoomLevel + 0.25); });
    }

    // ── SPREAD LOGIC ──────────────────────────────────────────────

    private getSpreadPages(pageNum: number): { left: number; right: number | null } {
        if (this.layoutMode === "single") return { left: pageNum, right: null };

        if (this.layoutMode === "double-odd") {
            if (pageNum <= 1) return { left: 1, right: null };
            const pairIdx = Math.floor((pageNum - 2) / 2);
            const left = 2 + pairIdx * 2;
            const right = left + 1 <= this.totalPages ? left + 1 : null;
            return { left, right };
        }

        const pairIdx = Math.floor((pageNum - 1) / 2);
        const left = 1 + pairIdx * 2;
        const right = left + 1 <= this.totalPages ? left + 1 : null;
        return { left, right };
    }

    private nextSpreadStart(pageNum: number): number {
        if (this.layoutMode === "single") return pageNum + 1;
        if (this.layoutMode === "double-odd") {
            if (pageNum <= 1) return 2;
            const { left } = this.getSpreadPages(pageNum);
            return left + 2;
        }
        const { left } = this.getSpreadPages(pageNum);
        return left + 2;
    }

    private prevSpreadStart(pageNum: number): number {
        if (this.layoutMode === "single") return pageNum - 1;
        const { left } = this.getSpreadPages(pageNum);
        if (left <= 1) return 1;
        return this.getSpreadPages(left - 1).left;
    }

    // ── RENDERING ─────────────────────────────────────────────────

    private async renderPage(pageNum: number) {
        if (!this.pdfDoc) return;

        const { left, right } = this.getSpreadPages(
            Math.max(1, Math.min(this.totalPages, pageNum)),
        );

        if (this.isRendering) {
            this.renderQueue = left;
            return;
        }

        this.isRendering = true;
        this.currentPage = left;
        this.updatePageIndicator();

        try {
            const leftPage: PdfPage = await this.pdfDoc.getPage(left);
            const rightPage: PdfPage | null = right ? await this.pdfDoc.getPage(right) : null;

            this.baseScale = this.computeBaseScale(leftPage, rightPage);
            const scale = this.baseScale * this.zoomLevel;

            await this.renderPageToCanvas(leftPage, this.canvasEl, scale);

            if (rightPage) {
                this.canvasRight.style.display = "block";
                await this.renderPageToCanvas(rightPage, this.canvasRight, scale);
            } else {
                this.canvasRight.style.display = "none";
            }

            this.canvasEl.toggleClass("ldr-pdf-canvas--dark", this.darkMode);
            this.canvasRight.toggleClass("ldr-pdf-canvas--dark", this.darkMode);

            this.applyTransform();
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

    private async renderPageToCanvas(page: PdfPage, canvas: HTMLCanvasElement, scale: number) {
        const viewport = page.getViewport({ scale });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext("2d")!;
        await page.render({ canvasContext: ctx, viewport }).promise;
    }

    private computeBaseScale(leftPage: PdfPage, rightPage: PdfPage | null): number {
        const vpL = leftPage.getViewport({ scale: 1.0 });
        const vpR = rightPage ? rightPage.getViewport({ scale: 1.0 }) : null;

        const cw = this.viewportEl.clientWidth || window.innerWidth;
        const ch = this.viewportEl.clientHeight || window.innerHeight;

        const totalW = vpR ? vpL.width + vpR.width + SPREAD_GAP : vpL.width;
        const maxH = vpR ? Math.max(vpL.height, vpR.height) : vpL.height;

        switch (this.fitMode) {
            case "width":    return cw / totalW;
            case "height":   return ch / maxH;
            case "page":     return Math.min(cw / totalW, ch / maxH);
            case "original": return 1.0;
        }
    }

    private applyTransform() {
        this.spreadEl.style.transform = `translate(${this.panX}px, ${this.panY}px)`;
    }

    // ── ZOOM ──────────────────────────────────────────────────────

    private async setZoom(level: number, focalX?: number, focalY?: number) {
        const oldZoom = this.zoomLevel;
        const newZoom = Math.max(0.25, Math.min(5.0, level));
        if (newZoom === oldZoom) return;

        if (focalX !== undefined && focalY !== undefined && oldZoom > 0) {
            const rect = this.viewportEl.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const dx = focalX - cx;
            const dy = focalY - cy;
            const ratio = newZoom / oldZoom;
            this.panX = dx * (1 - ratio) + this.panX * ratio;
            this.panY = dy * (1 - ratio) + this.panY * ratio;
        }

        this.zoomLevel = newZoom;

        if (newZoom <= 1.0) { this.panX = 0; this.panY = 0; }
        else { this.clampPan(); }

        // Actualizar cursor
        this.viewportEl.style.cursor = newZoom > 1.05 ? "grab" : "default";

        await this.renderPage(this.currentPage);
    }

    /**
     * Zoom visual inmediato vía CSS transform durante el gesto del trackpad.
     * El re-render real del canvas se difiere 350ms después del último evento
     * para evitar parpadeos: el usuario ve el zoom inmediatamente pero el
     * canvas solo se re-renderiza cuando termina el gesto.
     */
    private handleZoomWheel(deltaY: number, focalX: number, focalY: number) {
        const factor = deltaY < 0 ? 1.06 : 0.94;
        const oldZoom = this.zoomLevel;
        const newZoom = Math.max(0.25, Math.min(5.0, oldZoom * factor));
        if (newZoom === oldZoom) return;

        const rect = this.viewportEl.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = focalX - cx;
        const dy = focalY - cy;
        const ratio = newZoom / oldZoom;

        this.panX = dx * (1 - ratio) + this.panX * ratio;
        this.panY = dy * (1 - ratio) + this.panY * ratio;
        this.zoomLevel = newZoom;

        if (newZoom <= 1.0) { this.panX = 0; this.panY = 0; }
        else { this.clampPan(); }

        this.viewportEl.style.cursor = newZoom > 1.05 ? "grab" : "default";

        // Aplicar CSS transform inmediatamente — sin re-render del canvas
        this.applyTransform();

        // Re-render diferido: se dispara solo cuando el usuario deja de hacer zoom
        if (this.zoomCommitTimer) clearTimeout(this.zoomCommitTimer);
        this.zoomCommitTimer = setTimeout(() => {
            this.zoomCommitTimer = null;
            this.renderPage(this.currentPage);
        }, 350);
    }

    private clampPan() {
        const spreadW = this.spreadEl.offsetWidth * this.zoomLevel;
        const spreadH = this.spreadEl.offsetHeight * this.zoomLevel;
        const vpW = this.viewportEl.clientWidth;
        const vpH = this.viewportEl.clientHeight;
        const maxX = Math.max(0, (spreadW - vpW) / 2);
        const maxY = Math.max(0, (spreadH - vpH) / 2);
        this.panX = Math.max(-maxX, Math.min(maxX, this.panX));
        this.panY = Math.max(-maxY, Math.min(maxY, this.panY));
    }

    private resetZoom() {
        this.zoomLevel = 1.0;
        this.panX = 0;
        this.panY = 0;
        this.viewportEl.style.cursor = "default";
        this.renderPage(this.currentPage);
    }

    // ── NAVIGATION ────────────────────────────────────────────────

    async goToPage(pageNum: number) {
        if (!this.pdfDoc) return;
        pageNum = Math.max(1, Math.min(this.totalPages, pageNum));
        const snapTo = this.getSpreadPages(pageNum).left;
        if (snapTo === this.currentPage && !this.isRendering) return;
        this.panX = 0;
        this.panY = 0;
        await this.renderPage(snapTo);
        this.saveProgress();
    }

    private updatePageIndicator() {
        const { right } = this.getSpreadPages(this.currentPage);
        const pageText = right ? `${this.currentPage}–${right}` : String(this.currentPage);
        const text = `${pageText} / ${this.totalPages || "—"}`;
        if (this.pageIndicatorEl) this.pageIndicatorEl.textContent = text;
        if (this.pageInputEl) this.pageInputEl.value = String(this.currentPage);
        if (this.totalPagesEl) this.totalPagesEl.textContent = `/ ${this.totalPages || "—"}`;
    }

    // ── TOC ───────────────────────────────────────────────────────

    private async loadToc() {
        if (!this.pdfDoc) return;
        try {
            const outline = await this.pdfDoc.getOutline();
            this.tocItems = outline ? this.flattenOutline(outline, 0) : [];
        } catch {
            this.tocItems = [];
        }
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
                        pageNum = await this.pdfDoc.getPageIndex(ref[0]) + 1;
                    } else if (Array.isArray(item.dest)) {
                        pageNum = await this.pdfDoc.getPageIndex((item.dest as unknown[])[0]) + 1;
                    } else {
                        return;
                    }
                    await this.goToPage(pageNum);
                } catch (err) {
                    console.warn("[LDR PDF] TOC nav error:", err);
                }
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
                    if (entry.isIntersecting) {
                        const el = entry.target as HTMLElement;
                        const idx = parseInt(el.dataset.page ?? "0");
                        if (idx > 0 && !this.thumbRendering.has(idx)) {
                            this.thumbObserver?.unobserve(el);
                            this.renderThumb(el, idx);
                        }
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
            cell.addEventListener("click", async () => {
                await this.goToPage(i);
                this.highlightThumb(i);
            });
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
            canvas.width = vp.width;
            canvas.height = vp.height;
            await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
        } catch {
            // silently skip
        } finally {
            this.thumbRendering.delete(pageNum);
        }
    }

    private highlightThumb(pageNum: number) {
        this.thumbsContainer.querySelectorAll(".ldr-pdf-thumb-cell").forEach((el) => {
            const page = parseInt((el as HTMLElement).dataset.page ?? "0");
            el.toggleClass("is-active", page === pageNum);
        });
        const active = this.thumbsContainer.querySelector(".ldr-pdf-thumb-cell.is-active") as HTMLElement;
        if (active) active.scrollIntoView({ block: "nearest" });
    }

    // ── SIDEBAR + SETTINGS ────────────────────────────────────────

    private toggleSidebar() {
        this.sidebarOpen = !this.sidebarOpen;
        this.sidebarEl.toggleClass("is-open", this.sidebarOpen);
        if (this.sidebarOpen) this.sidebarEl.style.width = `${this.sidebarWidth}px`;
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

    // ── FULLSCREEN / IMMERSIVE ────────────────────────────────────
    // Implementación idéntica a ImageReaderView:
    // - ldr-fullscreen en body oculta sidebars/ribbons de Obsidian via CSS
    // - ldr-fullscreen-leaf en containerEl fija la vista a pantalla completa
    // - requestFullscreen() activa el fullscreen real del SO

    private toggleImmersive() {
        this.isImmersive ? this.exitImmersive() : this.enterImmersive();
    }

    private enterImmersive() {
        this.isImmersive = true;

        // Ocultar UI de Obsidian (CSS global)
        document.body.classList.add("ldr-fullscreen");
        // Fijar este leaf a pantalla completa
        this.containerEl.classList.add("ldr-fullscreen-leaf");

        // Fullscreen real del SO
        if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(() => {});
            this.isFullscreen = true;
        }

        // Ocultar header/footer del lector con auto-hide
        this.headerEl.addClass("is-hidden");
        this.footerEl.addClass("is-hidden");
        this.pageIndicatorEl.addClass("is-visible");
        this.scheduleImmersiveHide();
    }

    private exitImmersive() {
        this.isImmersive = false;

        // Restaurar UI de Obsidian
        document.body.classList.remove("ldr-fullscreen");
        this.containerEl.classList.remove("ldr-fullscreen-leaf");

        // Salir del fullscreen del SO
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        this.isFullscreen = false;

        // Mostrar header/footer
        this.cancelImmersiveHide();
        this.headerEl.removeClass("is-hidden");
        this.footerEl.removeClass("is-hidden");
        this.pageIndicatorEl.removeClass("is-visible");
    }

    private showImmersiveControls() {
        if (!this.isImmersive) return;
        this.headerEl.removeClass("is-hidden");
        this.footerEl.removeClass("is-hidden");
        this.pageIndicatorEl.removeClass("is-visible");
        this.scheduleImmersiveHide();
    }

    private scheduleImmersiveHide() {
        if (this.immersiveHideTimer) clearTimeout(this.immersiveHideTimer);
        this.immersiveHideTimer = setTimeout(() => {
            this.immersiveHideTimer = null;
            if (this.isImmersive) {
                this.headerEl.addClass("is-hidden");
                this.footerEl.addClass("is-hidden");
                this.pageIndicatorEl.addClass("is-visible");
            }
        }, IMMERSIVE_HIDE_DELAY);
    }

    private cancelImmersiveHide() {
        if (this.immersiveHideTimer) {
            clearTimeout(this.immersiveHideTimer);
            this.immersiveHideTimer = null;
        }
    }

    private registerImmersiveMouseMove() {
        this.registerDomEvent(this.containerEl, "mousemove", () => this.showImmersiveControls());
        this.registerDomEvent(this.containerEl, "touchstart", () => this.showImmersiveControls(), { passive: true });
    }

    // ── OPEN EXTERNAL (Desktop) ───────────────────────────────────

    private async openExternal() {
        if (!this.book) return;
        try {
            const adapter = this.app.vault.adapter;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const fullPath = (adapter as any).getFullPath?.(this.book.filePath);
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
            const kbTarget = e.target as HTMLElement;
            if (kbTarget?.tagName === "INPUT" || kbTarget?.tagName === "TEXTAREA" || kbTarget?.isContentEditable) return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            switch (e.key) {
                case "ArrowRight":
                case "ArrowDown":
                case "PageDown":
                case " ":
                    e.preventDefault();
                    await this.goToPage(this.nextSpreadStart(this.currentPage));
                    break;
                case "ArrowLeft":
                case "ArrowUp":
                case "PageUp":
                    e.preventDefault();
                    await this.goToPage(this.prevSpreadStart(this.currentPage));
                    break;
                case "Home":
                    e.preventDefault();
                    await this.goToPage(1);
                    break;
                case "End":
                    e.preventDefault();
                    await this.goToPage(this.totalPages);
                    break;
                case "+":
                case "=":
                    e.preventDefault();
                    await this.setZoom(this.zoomLevel + 0.25);
                    break;
                case "-":
                    e.preventDefault();
                    await this.setZoom(this.zoomLevel - 0.25);
                    break;
                case "0":
                    e.preventDefault();
                    this.resetZoom();
                    break;
                case "f":
                case "F":
                    this.toggleImmersive();
                    break;
                case "Escape":
                    if (this.isImmersive) this.exitImmersive();
                    break;
            }
        });
    }

    // ── WHEEL + TOUCH ─────────────────────────────────────────────

    private registerWheelAndTouch() {
        this.registerDomEvent(this.viewportEl, "wheel", (e: WheelEvent) => {
            e.preventDefault();

            // Normalizar deltaMode: LINE (rueda de mouse) → px, PAGE → px
            let dx = e.deltaX;
            let dy = e.deltaY;
            if (e.deltaMode === 1) { dx *= 20; dy *= 20; }        // LINE → px
            else if (e.deltaMode === 2) { dx *= 400; dy *= 400; }  // PAGE → px

            // ── Zoom con Ctrl/Meta (pinch trackpad en macOS también genera Ctrl) ──
            if (e.ctrlKey || e.metaKey) {
                this.handleZoomWheel(dy, e.clientX, e.clientY);
                return;
            }

            // ── Scroll continuo: SIEMPRE scroll, con o sin zoom ────────────────
            // Con zoom activo: hace pan dentro de la página renderizada.
            // Sin zoom (zoom == 1): hace scroll entre páginas de forma continua.
            // El cambio de página ocurre cuando el scroll llega al borde del canvas.
            if (this.rafPanId === null) {
                const capDx = dx;
                const capDy = dy;
                this.rafPanId = requestAnimationFrame(() => {
                    this.rafPanId = null;
                    this.wheelAccumX += capDx;
                    this.wheelAccumY += capDy;
                    this.applyScrollDelta(this.wheelAccumX, this.wheelAccumY);
                    this.wheelAccumX = 0;
                    this.wheelAccumY = 0;
                });
            } else {
                // Acumular para el RAF ya programado
                this.wheelAccumX += dx;
                this.wheelAccumY += dy;
            }
        }, { passive: false });

        // Touch: pinch = zoom, 1 dedo = pan
        this.registerDomEvent(this.viewportEl, "touchstart", (e: TouchEvent) => {
            if (this.zoomLevel > 1.0) e.stopPropagation();

            if (e.touches.length === 2) {
                this.isPinching = true;
                this.pinchStartDist = this.getTouchDist(e);
                this.pinchStartZoom = this.zoomLevel;
                this.pinchStartPanX = this.panX;
                this.pinchStartPanY = this.panY;
                const mid = this.getTouchMid(e);
                this.pinchFocalX = mid.x;
                this.pinchFocalY = mid.y;
            } else if (e.touches.length === 1) {
                this.isDragging = false;
                this.dragLastX = e.touches[0].clientX;
                this.dragLastY = e.touches[0].clientY;
            }
        }, { passive: false });

        this.registerDomEvent(this.viewportEl, "touchmove", (e: TouchEvent) => {
            e.stopPropagation();
            e.preventDefault();

            if (e.touches.length === 2 && this.isPinching) {
                const dist = this.getTouchDist(e);
                const newZoom = Math.max(0.25, Math.min(5.0, this.pinchStartZoom * (dist / this.pinchStartDist)));
                const ratio = newZoom / this.pinchStartZoom;
                const rect = this.viewportEl.getBoundingClientRect();
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;
                const dx = this.pinchFocalX - cx;
                const dy = this.pinchFocalY - cy;
                this.panX = dx * (1 - ratio) + this.pinchStartPanX * ratio;
                this.panY = dy * (1 - ratio) + this.pinchStartPanY * ratio;
                this.zoomLevel = newZoom;
                if (newZoom <= 1.0) { this.panX = 0; this.panY = 0; }
                else { this.clampPan(); }
                this.applyTransform();
            } else if (e.touches.length === 1 && !this.isPinching) {
                const dx = e.touches[0].clientX - this.dragLastX;
                const dy = e.touches[0].clientY - this.dragLastY;
                this.dragLastX = e.touches[0].clientX;
                this.dragLastY = e.touches[0].clientY;
                // Scroll continuo en touch también
                this.applyScrollDelta(-dx, -dy);
                this.isDragging = true;
            }
        }, { passive: false });

        this.registerDomEvent(this.viewportEl, "touchend", async (e: TouchEvent) => {
            if (this.isPinching && e.touches.length < 2) {
                await this.renderPage(this.currentPage);
                this.isPinching = false;
                return;
            }
            this.isPinching = false;

            if (Platform.isMobile && e.changedTouches.length === 1 && !this.isDragging) {
                const now = Date.now();
                if (now - this.lastTapTime < 300 && this.zoomLevel > 1.0) {
                    this.resetZoom();
                }
                this.lastTapTime = now;
            }
            this.isDragging = false;
        }, { passive: false });
    }

    /**
     * Scroll continuo unificado.
     *
     * Con zoom > 1: hace pan dentro de la página (comportamiento esperado).
     * Con zoom == 1: el canvas llena exactamente el viewport. Cuando el scroll
     * llega al borde superior/inferior, cambia a la página anterior/siguiente
     * con un threshold de 60px para evitar cambios accidentales en trackpad.
     *
     * De esta forma el scroll es siempre fluido independientemente del zoom,
     * igual que un PDF viewer nativo.
     */
    private applyScrollDelta(dx: number, dy: number) {
        const EDGE_THRESHOLD = 60; // px de margen para cambiar página

        const spreadW = this.spreadEl.offsetWidth;
        const spreadH = this.spreadEl.offsetHeight;
        const vpW = this.viewportEl.clientWidth;
        const vpH = this.viewportEl.clientHeight;
        const maxX = Math.max(0, (spreadW - vpW) / 2);
        const maxY = Math.max(0, (spreadH - vpH) / 2);

        const prevPanX = this.panX;
        const prevPanY = this.panY;

        this.panX -= dx;
        this.panY -= dy;

        // Clampear
        this.panX = Math.max(-maxX, Math.min(maxX, this.panX));
        this.panY = Math.max(-maxY, Math.min(maxY, this.panY));

        // Detectar si llegamos al borde en Y (para cambiar página)
        if (maxY === 0 || this.zoomLevel <= 1.05) {
            // Sin overflow vertical: el cambio de página es por scroll
            const overflowY = dy; // dirección del scroll
            if (overflowY > EDGE_THRESHOLD && this.currentPage < this.totalPages) {
                this.panY = 0; this.panX = 0;
                this.goToPage(this.nextSpreadStart(this.currentPage));
                return;
            }
            if (overflowY < -EDGE_THRESHOLD && this.currentPage > 1) {
                this.panY = 0; this.panX = 0;
                this.goToPage(this.prevSpreadStart(this.currentPage));
                return;
            }
        } else if (this.panY === prevPanY && dy !== 0) {
            // Con zoom: ya estamos en el borde, cambiar página
            if (dy > EDGE_THRESHOLD && this.currentPage < this.totalPages) {
                this.panY = -maxY;
                this.panX = 0;
                this.goToPage(this.nextSpreadStart(this.currentPage));
                return;
            }
            if (dy < -EDGE_THRESHOLD && this.currentPage > 1) {
                this.panY = maxY;
                this.panX = 0;
                this.goToPage(this.prevSpreadStart(this.currentPage));
                return;
            }
        }

        this.applyTransform();
    }

    // ── MOUSE DRAG (desktop pan) ──────────────────────────────────

    private registerMouseDrag() {
        this.registerDomEvent(this.viewportEl, "mousedown", (e: MouseEvent) => {
            if (e.button !== 0) return;
            e.preventDefault();
            this.isMouseDragging = true;
            this.mouseDragLastX = e.clientX;
            this.mouseDragLastY = e.clientY;
            this.viewportEl.style.cursor = "grabbing";
        });

        this.registerDomEvent(document, "mousemove", (e: MouseEvent) => {
            if (!this.isMouseDragging) return;
            const dx = e.clientX - this.mouseDragLastX;
            const dy = e.clientY - this.mouseDragLastY;
            this.mouseDragLastX = e.clientX;
            this.mouseDragLastY = e.clientY;
            this.applyScrollDelta(-dx, -dy);
        });

        this.registerDomEvent(document, "mouseup", () => {
            if (!this.isMouseDragging) return;
            this.isMouseDragging = false;
            this.viewportEl.style.cursor = this.zoomLevel > 1.05 ? "grab" : "default";
        });
    }

    // ── TOUCH HELPERS ─────────────────────────────────────────────

    private getTouchDist(e: TouchEvent): number {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    private getTouchMid(e: TouchEvent): { x: number; y: number } {
        return {
            x: (e.touches[0].clientX + e.touches[1].clientX) / 2,
            y: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        };
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
            readingMode: existing?.readingMode,
        });
    }
}
