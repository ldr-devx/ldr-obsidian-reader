// ============================================================
// src/views/PdfReaderView.ts
// Lector PDF con pdf.js: canvas, zoom focal, pan, layout doble
// página, sidebar redimensionable, modo inmersivo con auto-hide.
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf");
// El worker se inicializa en initWorker() usando app.vault.adapter
// porque __dirname no es fiable en el bundle compilado por esbuild dentro de Obsidian.

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

// Minimal type aliases for pdf.js objects (avoid importing full types)
interface PdfViewport { width: number; height: number; }
interface PdfPage {
	getViewport(opts: { scale: number }): PdfViewport;
	render(opts: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): { promise: Promise<void> };
}

const SPREAD_GAP = 4;            // px entre páginas en layout doble
const IMMERSIVE_HIDE_DELAY = 3000; // ms antes de ocultar controles en inmersivo
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
	private sidebarOpen = false;
	private sidebarWidth = SIDEBAR_DEFAULT_WIDTH;
	private activeSidebarTab: SidebarTab = "thumbs";
	private isRendering = false;
	private renderQueue: number | null = null;
	private settingsOpen = false;
	private immersiveHideTimer: ReturnType<typeof setTimeout> | null = null;

	// Zoom / pan state
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

	/**
	 * Inicializa GlobalWorkerOptions.workerSrc de pdf.js usando el path real
	 * del plugin dentro del vault. Se llama en loadBook() en lugar del top-level
	 * porque en el bundle de esbuild __dirname apunta al proceso de Electron,
	 * no al directorio del plugin instalado.
	 *
	 * Estrategia:
	 * 1. Usar app.vault.adapter.basePath para localizar el plugin en el vault.
	 * 2. Fallback: buscar pdf.worker.min.js relativo a __dirname (útil en dev).
	 * 3. Si nada funciona, loguear el error claramente.
	 *
	 * El archivo pdf.worker.min.js debe copiarse al directorio del plugin
	 * durante el build (esbuild.config.mjs lo hace automáticamente).
	 */
	private initWorker(): void {
		if (pdfjsLib.GlobalWorkerOptions.workerSrc) return; // ya inicializado

		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const fs = require("fs") as typeof import("fs");
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const nodePath = require("path") as typeof import("path");

			const pluginId = "ldr-obsidian-reader";

			// Candidatos de path en orden de preferencia
			const candidates: string[] = [];

			// 1. Path real del vault (desktop: FileSystemAdapter expone basePath)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const basePath = (this.app.vault.adapter as any).basePath as string | undefined;
			if (basePath) {
				candidates.push(
					nodePath.join(basePath, ".obsidian", "plugins", pluginId, "pdf.worker.min.js"),
				);
			}

			// 2. Relativo a __dirname (funciona en dev cuando el proyecto está
			//    linkeado/copiado directamente en .obsidian/plugins/)
			candidates.push(
				nodePath.join(__dirname, "pdf.worker.min.js"),
				nodePath.join(__dirname, "..", "pdf.worker.min.js"),
				// Fallback al worker sin minificar (más pesado, para dev)
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
				candidates.join("\n") +
				"\n\nAsegúrate de ejecutar `npm run build` o `npm run dev` para copiar el worker.",
			);
		} catch (e) {
			console.error("[LDR PDF] Error inicializando worker de pdf.js:", e);
		}
	}

	async onOpen() {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass("ldr-pdf-reader");
		this.buildUI(root);
		this.registerKeyboard();
		this.registerWheelAndTouch();
		this.registerImmersiveMouseMove();
	}

	async onClose() {
		this.saveProgress();
		this.thumbObserver?.disconnect();
		this.thumbObserver = null;
		if (this.immersiveHideTimer) clearTimeout(this.immersiveHideTimer);
		if (document.fullscreenElement === this.containerEl) {
			document.exitFullscreen().catch(() => {});
		}
	}

	// ── LOAD BOOK ─────────────────────────────────────────────────

	async loadBook(bookId: string) {
		this.initWorker();
		const book = this.plugin.store.getBook(bookId);
		if (!book) { new Notice("Book not found."); return; }
		this.book = book;

		// Restore state
		const state = this.plugin.store.getReadingState(bookId);
		this.currentPage = state?.pageIndex ? state.pageIndex + 1 : 1;
		this.zoomLevel = state?.pdfZoom ?? 1.0;
		this.layoutMode = (state?.pdfLayoutMode as LayoutMode) ?? "single";
		this.sidebarOpen = state?.pdfSidebarOpen ?? false;
		this.activeSidebarTab = (state?.pdfSidebarTab as SidebarTab) ?? "thumbs";
		this.sidebarWidth = state?.pdfSidebarWidth ?? SIDEBAR_DEFAULT_WIDTH;

		// Apply sidebar state to DOM
		this.sidebarEl.toggleClass("is-open", this.sidebarOpen);
		if (this.sidebarOpen) {
			this.sidebarEl.style.width = `${this.sidebarWidth}px`;
		}

		// Read binary from vault
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
		this.buildSidebar(); // rebuild after tab state restored
		await this.renderPage(this.currentPage);
	}

	// ── UI BUILDER ────────────────────────────────────────────────

	private buildUI(root: HTMLElement) {
		// Header
		this.headerEl = root.createDiv({ cls: "ldr-pdf-header" });
		this.buildHeader();

		// Main area (sidebar + viewport)
		const main = root.createDiv({ cls: "ldr-pdf-main" });

		// Sidebar
		this.sidebarEl = main.createDiv({ cls: "ldr-pdf-sidebar" });
		this.buildSidebar();
		this.buildSidebarResizeHandle();

		// Viewport
		this.viewportEl = main.createDiv({ cls: "ldr-pdf-viewport" });

		// Spread: wrapper for one or two canvases
		this.spreadEl = this.viewportEl.createDiv({ cls: "ldr-pdf-spread" });
		this.canvasEl = this.spreadEl.createEl("canvas", { cls: "ldr-pdf-canvas" });
		this.canvasRight = this.spreadEl.createEl("canvas", { cls: "ldr-pdf-canvas" });
		this.canvasRight.style.display = "none";

		// Page indicator overlay (visible in immersive mode)
		this.pageIndicatorEl = this.viewportEl.createDiv({ cls: "ldr-pdf-page-indicator" });
		this.updatePageIndicator();

		// Settings panel (floating)
		this.settingsPanel = root.createDiv({ cls: "ldr-pdf-settings-panel" });
		this.buildSettingsPanel();

		// Footer
		this.footerEl = root.createDiv({ cls: "ldr-pdf-footer" });
		this.buildFooter();
	}

	private buildHeader() {
		this.headerEl.empty();

		// Back button
		const backBtn = this.headerEl.createDiv({ cls: "ldr-pdf-btn", attr: { title: "Back to library" } });
		backBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>`;
		backBtn.addEventListener("click", () => this.plugin.openHomeView());

		// Title
		this.headerEl.createDiv({ cls: "ldr-pdf-title", text: this.book?.title ?? "PDF Reader" });

		// Right actions
		const actions = this.headerEl.createDiv({ cls: "ldr-pdf-header-actions" });

		// Open externally (desktop only)
		if (Platform.isDesktop) {
			const extBtn = actions.createDiv({ cls: "ldr-pdf-btn", attr: { title: "Open in system viewer" } });
			extBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
			extBtn.addEventListener("click", () => this.openExternal());
		}

		// Sidebar toggle
		const sidebarBtn = actions.createDiv({ cls: "ldr-pdf-btn", attr: { title: "Toggle sidebar" } });
		sidebarBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>`;
		sidebarBtn.addEventListener("click", () => this.toggleSidebar());

		// Settings
		this.settingsBtnEl = actions.createDiv({ cls: "ldr-pdf-btn", attr: { title: "Settings" } });
		this.settingsBtnEl.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
		this.settingsBtnEl.addEventListener("click", () => this.toggleSettings());

		// Immersive
		const immersiveBtn = actions.createDiv({ cls: "ldr-pdf-btn", attr: { title: "Immersive mode" } });
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

	/** Drag handle en el borde derecho del sidebar para redimensionar */
	private buildSidebarResizeHandle() {
		const handle = this.sidebarEl.createDiv({ cls: "ldr-pdf-sidebar-resize" });

		let dragging = false;
		let startX = 0;
		let startWidth = 0;

		const onMove = (e: MouseEvent) => {
			if (!dragging) return;
			const newWidth = Math.max(
				SIDEBAR_MIN_WIDTH,
				Math.min(SIDEBAR_MAX_WIDTH, startWidth + (e.clientX - startX)),
			);
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
				// Snap currentPage to spread start
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
			{ key: "page", label: "Page" },
			{ key: "original", label: "1:1" },
		];
		fitOptions.forEach(({ key, label }) => {
			const btn = fitRow.createDiv({
				cls: `ldr-pdf-fit-btn${this.fitMode === key ? " is-active" : ""}`,
				text: label,
			});
			btn.addEventListener("click", async () => {
				this.fitMode = key;
				this.zoomLevel = 1.0;
				this.panX = 0;
				this.panY = 0;
				this.buildSettingsPanel();
				await this.renderPage(this.currentPage);
			});
		});

		// ── Dark mode ─────────────────────────────────────────────
		const darkSection = this.settingsPanel.createDiv({ cls: "ldr-pdf-settings-section" });
		darkSection.createDiv({ cls: "ldr-pdf-settings-label", text: "Invert colors (dark)" });
		const darkToggle = darkSection.createDiv({
			cls: `ldr-pdf-toggle${this.darkMode ? " is-active" : ""}`,
		});
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
		zoomOut.addEventListener("click", async () => {
			await this.setZoom(this.zoomLevel - 0.25);
		});
		zoomRow.createSpan({
			cls: "ldr-pdf-zoom-label",
			text: `${Math.round(this.zoomLevel * 100)}%`,
		});
		const zoomIn = zoomRow.createDiv({ cls: "ldr-pdf-btn", text: "+" });
		zoomIn.addEventListener("click", async () => {
			await this.setZoom(this.zoomLevel + 0.25);
		});
	}

	// ── SPREAD LOGIC ──────────────────────────────────────────────

	/**
	 * Dado el número de página activo, retorna las páginas a mostrar en el spread.
	 * - single: solo left = pageNum
	 * - double-odd: página 1 sola (portada), luego (2,3), (4,5)...
	 * - double-even: (1,2), (3,4)...
	 */
	private getSpreadPages(pageNum: number): { left: number; right: number | null } {
		if (this.layoutMode === "single") {
			return { left: pageNum, right: null };
		}

		if (this.layoutMode === "double-odd") {
			if (pageNum <= 1) return { left: 1, right: null };
			// Par 0-indexed: páginas 2-3 = par 0, 4-5 = par 1, etc.
			const pairIdx = Math.floor((pageNum - 2) / 2);
			const left = 2 + pairIdx * 2;
			const right = left + 1 <= this.totalPages ? left + 1 : null;
			return { left, right };
		}

		// double-even: (1,2), (3,4), ...
		const pairIdx = Math.floor((pageNum - 1) / 2);
		const left = 1 + pairIdx * 2;
		const right = left + 1 <= this.totalPages ? left + 1 : null;
		return { left, right };
	}

	/** Página de inicio del siguiente spread */
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

	/** Página de inicio del spread anterior */
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

			// Aplicar dark mode si está activo
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
			case "width":   return cw / totalW;
			case "height":  return ch / maxH;
			case "page":    return Math.min(cw / totalW, ch / maxH);
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

		// Ajustar pan para que el punto focal permanezca fijo en pantalla
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

		if (newZoom <= 1.0) {
			this.panX = 0;
			this.panY = 0;
		} else {
			this.clampPan();
		}

		await this.renderPage(this.currentPage);
	}

	private clampPan() {
		const spreadW = this.spreadEl.offsetWidth;
		const spreadH = this.spreadEl.offsetHeight;
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
		this.renderPage(this.currentPage);
	}

	// ── NAVIGATION ────────────────────────────────────────────────

	async goToPage(pageNum: number) {
		if (!this.pdfDoc) return;
		pageNum = Math.max(1, Math.min(this.totalPages, pageNum));
		// Snap to spread start
		const snapTo = this.getSpreadPages(pageNum).left;
		if (snapTo === this.currentPage && !this.isRendering) return;
		this.panX = 0;
		this.panY = 0;
		await this.renderPage(snapTo);
		this.saveProgress();
	}

	private updatePageIndicator() {
		const { right } = this.getSpreadPages(this.currentPage);
		const pageText = right
			? `${this.currentPage}–${right}`
			: String(this.currentPage);
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
			result.push({
				title: item.title,
				dest: item.dest as TocItem["dest"],
				items: [],
				depth,
			});
			if (item.items?.length) {
				result.push(
					...this.flattenOutline(
						item.items as { title: string; dest: unknown; items: unknown[] }[],
						depth + 1,
					),
				);
			}
		}
		return result;
	}

	private renderTocList() {
		this.tocContainer.empty();
		if (this.tocItems.length === 0) {
			this.tocContainer.createDiv({
				cls: "ldr-pdf-toc-empty",
				text: "No table of contents",
			});
			return;
		}
		this.tocItems.forEach((item) => {
			const el = this.tocContainer.createDiv({
				cls: "ldr-pdf-toc-item",
				text: item.title,
			});
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
		if (this.sidebarOpen) {
			this.sidebarEl.style.width = `${this.sidebarWidth}px`;
		}
		this.saveProgress();
	}

	private toggleSettings() {
		this.settingsOpen = !this.settingsOpen;
		this.settingsPanel.toggleClass("is-open", this.settingsOpen);
		this.settingsBtnEl.toggleClass("is-active", this.settingsOpen);

		if (this.settingsOpen) {
			const handler = (e: MouseEvent) => {
				if (
					!this.settingsPanel.contains(e.target as Node) &&
					e.target !== this.settingsBtnEl
				) {
					this.settingsOpen = false;
					this.settingsPanel.removeClass("is-open");
					this.settingsBtnEl.removeClass("is-active");
					document.removeEventListener("click", handler, true);
				}
			};
			setTimeout(() => document.addEventListener("click", handler, true), 0);
		}
	}

	// ── IMMERSIVE ────────────────────────────────────────────────

	private toggleImmersive() {
		this.isImmersive = !this.isImmersive;

		if (this.isImmersive) {
			this.headerEl.addClass("is-hidden");
			this.footerEl.addClass("is-hidden");
			this.pageIndicatorEl.addClass("is-visible");
			this.scheduleImmersiveHide();
		} else {
			this.cancelImmersiveHide();
			this.headerEl.removeClass("is-hidden");
			this.footerEl.removeClass("is-hidden");
			this.pageIndicatorEl.removeClass("is-visible");
		}
	}

	/** Muestra controles y reinicia el timer de auto-hide en modo inmersivo */
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
		// Mouse move (desktop)
		this.registerDomEvent(this.containerEl, "mousemove", () => {
			this.showImmersiveControls();
		});
		// Touch (mobile)
		this.registerDomEvent(this.containerEl, "touchstart", () => {
			this.showImmersiveControls();
		}, { passive: true });
	}

	// ── OPEN EXTERNAL (Desktop) ───────────────────────────────────

	private async openExternal() {
		if (!this.book) return;
		try {
			const adapter = this.app.vault.adapter;
			// FileSystemAdapter expone getFullPath en desktop
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
			// Solo manejar cuando esta vista está activa
			if (this.app.workspace.activeLeaf?.view !== this) return;
			const kbTarget = e.target as HTMLElement;
			if (kbTarget?.tagName === "INPUT" || kbTarget?.tagName === "TEXTAREA" || kbTarget?.isContentEditable) return;
			// Dejar pasar los atajos globales de Obsidian (Ctrl+..., Alt+..., Meta+...)
			if (e.ctrlKey || e.metaKey || e.altKey) return;
			switch (e.key) {
				case "ArrowRight":
				case "ArrowDown":
				case "PageDown":
				case " ": // Space
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
			}
		});
	}

	// ── WHEEL + TOUCH ─────────────────────────────────────────────

	private registerWheelAndTouch() {
		// Wheel: Ctrl/Meta+scroll = zoom, scroll sin modificador = pan o página
		this.registerDomEvent(this.viewportEl, "wheel", async (e: WheelEvent) => {
			e.preventDefault();
			if (e.ctrlKey || e.metaKey) {
				const factor = e.deltaY < 0 ? 1.1 : 0.9;
				await this.setZoom(this.zoomLevel * factor, e.clientX, e.clientY);
				return;
			}
			if (this.zoomLevel > 1.05) {
				this.panX -= e.deltaX;
				this.panY -= e.deltaY;
				this.clampPan();
				this.applyTransform();
				return;
			}
			// Navegación por página cuando no hay zoom
			if (e.deltaY > 0 || e.deltaX > 0) {
				await this.goToPage(this.nextSpreadStart(this.currentPage));
			} else {
				await this.goToPage(this.prevSpreadStart(this.currentPage));
			}
		}, { passive: false });

		// Touch: pinch = zoom, 1 dedo = pan (si hay zoom)
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
			if (this.zoomLevel > 1.0) {
				e.stopPropagation();
				e.preventDefault();
			}

			if (e.touches.length === 2 && this.isPinching) {
				const dist = this.getTouchDist(e);
				const newZoom = Math.max(
					0.25,
					Math.min(5.0, this.pinchStartZoom * (dist / this.pinchStartDist)),
				);
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
				// Feedback visual inmediato durante el pinch
				this.applyTransform();
			} else if (e.touches.length === 1 && !this.isPinching && this.zoomLevel > 1.05) {
				const dx = e.touches[0].clientX - this.dragLastX;
				const dy = e.touches[0].clientY - this.dragLastY;
				this.dragLastX = e.touches[0].clientX;
				this.dragLastY = e.touches[0].clientY;
				this.panX += dx;
				this.panY += dy;
				this.isDragging = true;
				this.clampPan();
				this.applyTransform();
			}
		}, { passive: false });

		this.registerDomEvent(this.viewportEl, "touchend", async (e: TouchEvent) => {
			if (this.isPinching && e.touches.length < 2) {
				// Re-render a la nueva escala para nitidez óptima
				await this.renderPage(this.currentPage);
				this.isPinching = false;
				return;
			}
			this.isPinching = false;

			// Doble tap en mobile = reset zoom
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
