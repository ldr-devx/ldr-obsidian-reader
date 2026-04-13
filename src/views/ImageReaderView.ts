// ============================================================
// src/views/ImageReaderView.ts
// Motor de lectura de imágenes (CBZ).
// Zoom con punto focal + pan post-zoom. Sin modo webtoon.
// ============================================================

import JSZip from "jszip";
import { ItemView, WorkspaceLeaf, Notice, TFile, Platform } from "obsidian";
import type LdrEpubReaderPlugin from "../../main";
import {
	Book,
	ReadingState,
	ComicReaderSettings,
	DEFAULT_COMIC_READER_SETTINGS,
} from "../models";
import { CbzParser } from "../core/CbzParser";
import { ImageCache } from "../core/ImageCache";

export const COMIC_READER_VIEW_TYPE = "ldr-comic-reader";

type ReadingMode = "paginated" | "double";

export class ImageReaderView extends ItemView {
	private plugin: LdrEpubReaderPlugin;
	private book: Book | null = null;
	private zipInstance: JSZip | null = null;
	private imageList: string[] = [];
	private currentPage = 0;
	private settings: ComicReaderSettings;
	private cache: ImageCache;
	private activeMode: ReadingMode = "paginated";
	private isFullscreen = false;
	private isNavigating = false;
	private settingsOpen = false;

	// Debounces
	private resizeDebounce: ReturnType<typeof setTimeout> | null = null;
	private sliderDebounce: ReturnType<typeof setTimeout> | null = null;

	// Referencias DOM
	private bodyEl: HTMLElement;
	private imageContainer: HTMLElement;
	private pageIndicator: HTMLElement;
	private pageSlider: HTMLInputElement | null = null;
	private settingsPanel: HTMLElement;
	private settingsBtn: HTMLElement;
	private titleEl: HTMLElement;
	private tapLeft: HTMLElement;
	private tapRight: HTMLElement;

	// Swipe
	private swipeStartX = 0;
	private swipeStartY = 0;

	// Zoom / pan
	private zoomLevel = 1.0;
	private panX = 0;
	private panY = 0;
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

	constructor(leaf: WorkspaceLeaf, plugin: LdrEpubReaderPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.settings = {
			...DEFAULT_COMIC_READER_SETTINGS,
			...plugin.store.getComicReaderSettings(),
		};
		this.activeMode = this.normalizeMode(this.settings.readingMode);
		const cacheSize = Platform.isMobile ? 10 : 20;
		this.cache = new ImageCache(cacheSize);
	}

	getViewType() { return COMIC_READER_VIEW_TYPE; }
	getDisplayText() { return this.book?.title ?? "Comic Reader"; }
	getIcon() { return "book-image"; }

	async onOpen() {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass("ldr-comic-reader");
		this.buildUI(root);
	}

	async onClose() {
		this.saveProgress();
		if (this.isFullscreen) this.exitFullscreen();
		if (this.resizeDebounce) clearTimeout(this.resizeDebounce);
		if (this.sliderDebounce) clearTimeout(this.sliderDebounce);
		this.cache.clear();
		this.zipInstance = null;
	}

	// ── HELPERS ──────────────────────────────────────────────────

	/** Convierte modos guardados con webtoon → paginated */
	private normalizeMode(mode: ComicReaderSettings["readingMode"]): ReadingMode {
		if (mode === "webtoon") return "paginated";
		return mode as ReadingMode;
	}

	// ── CARGAR LIBRO ─────────────────────────────────────────────

	async loadBook(bookId: string) {
		this.book = this.plugin.store.getBook(bookId);
		if (!this.book) { new Notice("Book not found."); return; }
		if (this.book.contentType !== "cbz") { new Notice("Not a CBZ file."); return; }

		const file = this.app.vault.getAbstractFileByPath(this.book.filePath);
		if (!(file instanceof TFile)) { new Notice("File not found."); return; }

		this.cache.clear();
		this.zipInstance = null;
		this.imageList = [];
		this.imageContainer.empty();
		this.showLoading(true);

		try {
			const buffer = await this.app.vault.readBinary(file);
			this.zipInstance = await JSZip.loadAsync(buffer);
			this.imageList = CbzParser.getImageList(this.zipInstance);

			if (this.imageList.length === 0) {
				new Notice("No images found in CBZ file.");
				this.showLoading(false);
				return;
			}

			// Restaurar estado
			const saved = this.plugin.store.getReadingState(this.book.id);
			this.currentPage = Math.max(
				0,
				Math.min(saved?.pageIndex ?? 0, this.imageList.length - 1),
			);
			// Restaurar modo (webtoon → paginated)
			if (saved?.readingMode) {
				const mode = this.normalizeMode(saved.readingMode);
				this.activeMode = mode;
				this.settings.readingMode = mode;
			}

			if (this.titleEl) this.titleEl.textContent = this.book.title;

			this.showLoading(false);
			this.updatePageSlider();
			await this.renderCurrentMode();
			this.updatePageIndicator();
			this.updatePageSlider();
		} catch (err) {
			console.error("[LDR] ImageReaderView.loadBook error:", err);
			new Notice("Error loading CBZ file.");
			this.showLoading(false);
		}
	}

	// ── BUILD UI ─────────────────────────────────────────────────

	private buildUI(root: HTMLElement) {
		root.style.setProperty("background", this.settings.backgroundColor);

		// ── Header ──────────────────────────────────────────────
		const header = root.createDiv({ cls: "ldr-comic-header" });

		const backBtn = header.createDiv({ cls: "ldr-reader-btn", attr: { title: "Back" } });
		backBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>`;
		backBtn.addEventListener("click", () => {
			this.saveProgress();
			if (this.isFullscreen) this.exitFullscreen();
			this.plugin.openHomeView();
		});

		this.titleEl = header.createDiv({ cls: "ldr-comic-header-title", text: this.book?.title ?? "" });

		const infoBtn = header.createDiv({ cls: "ldr-reader-btn", attr: { title: "Controls" } });
		infoBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
		infoBtn.addEventListener("click", (e) => { e.stopPropagation(); this.showControlsInfo(root); });

		const thumbBtn = header.createDiv({ cls: "ldr-reader-btn", attr: { title: "Page grid" } });
		thumbBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`;
		thumbBtn.addEventListener("click", (e) => { e.stopPropagation(); this.showThumbnailGrid(root); });

		this.settingsBtn = header.createDiv({ cls: "ldr-reader-btn", attr: { title: "Settings" } });
		this.settingsBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
		this.settingsBtn.addEventListener("click", (e) => { e.stopPropagation(); this.toggleSettings(); });

		// ── Body ────────────────────────────────────────────────
		this.bodyEl = root.createDiv({ cls: "ldr-comic-body" });

		this.tapLeft = this.bodyEl.createDiv({ cls: "ldr-comic-tap ldr-comic-tap--left" });
		this.tapLeft.addEventListener("click", () => this.prevPage());

		this.imageContainer = this.bodyEl.createDiv({ cls: "ldr-comic-image-container" });
		this.applyFitMode();
		this.applyBrightness();

		this.tapRight = this.bodyEl.createDiv({ cls: "ldr-comic-tap ldr-comic-tap--right" });
		this.tapRight.addEventListener("click", () => this.nextPage());

		// ── Footer ──────────────────────────────────────────────
		const footer = root.createDiv({ cls: "ldr-comic-footer" });
		this.pageIndicator = footer.createDiv({ cls: "ldr-comic-page-indicator", text: "— / —" });
		this.buildPageSlider(footer);

		// ── Settings panel ──────────────────────────────────────
		this.settingsPanel = root.createDiv({ cls: "ldr-settings-panel ldr-comic-settings" });
		this.buildSettingsPanel();

		// Cerrar settings al hacer clic fuera
		root.addEventListener("click", (e) => {
			if (this.settingsOpen && !this.settingsPanel.contains(e.target as Node) && !this.settingsBtn.contains(e.target as Node)) {
				this.closeSettings();
			}
		});

		// ── Keyboard ────────────────────────────────────────────
		this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
			// Solo manejar cuando esta vista está activa
			if (this.app.workspace.activeLeaf?.view !== this) return;
			const kbTarget = e.target as HTMLElement;
			if (kbTarget?.tagName === "INPUT" || kbTarget?.tagName === "TEXTAREA" || kbTarget?.isContentEditable) return;
			// Dejar pasar los atajos globales de Obsidian (Ctrl+..., Alt+..., Meta+...)
			if (e.ctrlKey || e.metaKey || e.altKey) return;
			switch (e.key) {
				case "ArrowRight":
				case "ArrowDown":
					e.preventDefault();
					this.nextPage();
					break;
				case "ArrowLeft":
				case "ArrowUp":
					e.preventDefault();
					this.prevPage();
					break;
				case " ":
					e.preventDefault();
					e.shiftKey ? this.prevPage() : this.nextPage();
					break;
				case "Escape":
					if (this.isFullscreen) this.exitFullscreen();
					else if (this.settingsOpen) this.closeSettings();
					break;
			}
		});

		// ── Swipe / Pan (PointerEvents) ──────────────────────────
		this.registerDomEvent(this.bodyEl, "pointerdown", (e: PointerEvent) => {
			this.swipeStartX = e.clientX;
			this.swipeStartY = e.clientY;
			if (this.zoomLevel > 1.05) {
				this.isDragging = true;
				this.dragLastX = e.clientX;
				this.dragLastY = e.clientY;
			}
		});
		this.registerDomEvent(this.bodyEl, "pointermove", (e: PointerEvent) => {
			if (!this.isDragging) return;
			this.panX += e.clientX - this.dragLastX;
			this.panY += e.clientY - this.dragLastY;
			this.dragLastX = e.clientX;
			this.dragLastY = e.clientY;
			this.clampPan();
			this.applyZoom();
		});
		this.registerDomEvent(this.bodyEl, "pointerup", (e: PointerEvent) => {
			if (this.isDragging) { this.isDragging = false; return; }
			if (this.isPinching) return;
			const dx = e.clientX - this.swipeStartX;
			const dy = e.clientY - this.swipeStartY;
			if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
				dx < 0 ? this.nextPage() : this.prevPage();
			}
		});

		// ── Scroll wheel: zoom focal (Ctrl) + pan ────────────────
		// La navegación por rueda/trackpad se eliminó para evitar conflictos
		// con el gesto de zoom. Navega con ←/→, toque en bordes o slider.
		this.registerDomEvent(this.bodyEl, "wheel", (e: WheelEvent) => {
			if (e.ctrlKey || e.metaKey) {
				e.preventDefault();
				const factor = e.deltaY < 0 ? 1.1 : 0.9;
				this.setZoom(this.zoomLevel * factor, e.clientX, e.clientY);
				return;
			}
			if (this.zoomLevel > 1.05) {
				// Pan mode: mueve la imagen
				e.preventDefault();
				this.panX -= e.deltaX;
				this.panY -= e.deltaY;
				this.clampPan();
				this.applyZoom();
				return;
			}
			// fit-width sin zoom: permitir scroll nativo para ver la imagen completa
			if (this.settings.fitMode === "width") {
				// No llamar preventDefault → el bodyEl scrollea verticalmente
				return;
			}
			// Resto de modos: solo bloquear (sin navegar con rueda)
			e.preventDefault();
		}, { passive: false });

		// ── Pinch zoom con punto focal (mobile touch) ────────────
		this.registerDomEvent(this.bodyEl, "touchstart", (e: TouchEvent) => {
			if (e.touches.length === 2) {
				this.isPinching = true;
				this.pinchStartDist = this.getTouchDist(e.touches);
				this.pinchStartZoom = this.zoomLevel;
				this.pinchStartPanX = this.panX;
				this.pinchStartPanY = this.panY;
				const mid = this.getTouchMidpoint(e.touches);
				this.pinchFocalX = mid.x;
				this.pinchFocalY = mid.y;
				e.preventDefault();
			}
			// Bloquear paneles laterales de Obsidian cuando hay zoom
			if (this.zoomLevel > 1.0) e.stopPropagation();
		}, { passive: false });

		this.registerDomEvent(this.bodyEl, "touchmove", (e: TouchEvent) => {
			// Bloquear paneles laterales en modo zoom
			if (this.zoomLevel > 1.0) e.stopPropagation();

			if (e.touches.length === 2 && this.isPinching) {
				const dist = this.getTouchDist(e.touches);
				const scaleFactor = dist / this.pinchStartDist;
				const newZoom = Math.max(1.0, Math.min(5.0, this.pinchStartZoom * scaleFactor));

				const rect = this.bodyEl.getBoundingClientRect();
				const cx = rect.left + rect.width / 2;
				const cy = rect.top + rect.height / 2;
				const dx = this.pinchFocalX - cx;
				const dy = this.pinchFocalY - cy;

				this.zoomLevel = newZoom;

				if (newZoom <= 1.0) {
					this.panX = 0;
					this.panY = 0;
				} else {
					// Mantener el punto focal fijo durante el pinch
					this.panX = dx * (1 - newZoom / this.pinchStartZoom) + this.pinchStartPanX * (newZoom / this.pinchStartZoom);
					this.panY = dy * (1 - newZoom / this.pinchStartZoom) + this.pinchStartPanY * (newZoom / this.pinchStartZoom);
					this.clampPan();
				}

				this.applyZoom();
				e.preventDefault();
			}
		}, { passive: false });

		this.registerDomEvent(this.bodyEl, "touchend", (e: TouchEvent) => {
			if (this.isPinching) {
				this.isPinching = false;
				return;
			}
			// Doble toque para restablecer zoom (mobile)
			if (Platform.isMobile && e.changedTouches.length === 1 && !this.isDragging) {
				const now = Date.now();
				if (now - this.lastTapTime < 300 && this.zoomLevel > 1.0) {
					this.resetZoom();
				}
				this.lastTapTime = now;
			}
		});

		// ── Fullscreen sync ──────────────────────────────────────
		this.registerDomEvent(document, "fullscreenchange", () => {
			if (!document.fullscreenElement && this.isFullscreen) {
				this.isFullscreen = false;
				document.body.classList.remove("ldr-fullscreen");
				this.containerEl.classList.remove("ldr-fullscreen-leaf");
			}
		});

		// ── Resize / landscape auto-double ───────────────────────
		this.registerDomEvent(window, "resize", () => this.debouncedResize());
	}

	// ── PAGE SLIDER ──────────────────────────────────────────────

	private buildPageSlider(footer: HTMLElement) {
		const slider = footer.createEl("input", { cls: "ldr-comic-page-slider" });
		slider.type = "range";
		slider.min = "0";
		slider.max = "0";
		slider.value = "0";
		slider.setAttribute("aria-label", "Page");

		slider.addEventListener("input", () => {
			const idx = Number(slider.value);
			// Actualizar indicador inmediatamente para feedback visual
			this.currentPage = idx;
			this.updatePageIndicator();
			// Debounce del render real para no re-renderizar en cada tick
			if (this.sliderDebounce) clearTimeout(this.sliderDebounce);
			this.sliderDebounce = setTimeout(async () => {
				this.sliderDebounce = null;
				if (!this.isNavigating) await this.goToPage(idx);
			}, 200);
		});
		this.pageSlider = slider;
	}

	private updatePageSlider() {
		if (!this.pageSlider) return;
		const total = this.imageList.length;
		this.pageSlider.max = String(Math.max(0, total - 1));
		this.pageSlider.value = String(this.currentPage);
	}

	// ── RENDER DISPATCHER ────────────────────────────────────────

	private async renderCurrentMode() {
		if (this.activeMode === "double") {
			await this.renderDouble(this.currentPage);
		} else {
			await this.renderPaginated(this.currentPage);
		}
	}

	// ── RENDER: PAGINATED ─────────────────────────────────────────

	private async renderPaginated(index: number) {
		if (!this.zipInstance || this.imageList.length === 0) return;
		if (index < 0 || index >= this.imageList.length) return;

		const dataUrl = await this.loadImageDataUrl(index);
		if (!dataUrl) { new Notice(`Could not load page ${index + 1}.`); return; }

		this.imageContainer.empty();
		this.imageContainer.removeClass("ldr-mode-double");
		this.imageContainer.addClass("ldr-mode-paginated");

		const imgEl = this.imageContainer.createEl("img", { cls: "ldr-comic-page-img" });
		imgEl.src = dataUrl;
		imgEl.alt = `Page ${index + 1}`;

		this.applyFitMode();
		this.applyBrightness();
		this.preloadPages(index);
	}

	// ── RENDER: DOUBLE PAGE ───────────────────────────────────────

	private async renderDouble(index: number) {
		if (!this.zipInstance || this.imageList.length === 0) return;

		// Asegurar índice par (primera página del par)
		const leftIdx = index % 2 === 0 ? index : index - 1;
		const rightIdx = leftIdx + 1;
		this.currentPage = leftIdx;

		this.imageContainer.empty();
		this.imageContainer.removeClass("ldr-mode-paginated");
		this.imageContainer.addClass("ldr-mode-double");

		const leftUrl = await this.loadImageDataUrl(leftIdx);
		if (leftUrl) {
			const imgL = this.imageContainer.createEl("img", { cls: "ldr-comic-page-img ldr-comic-double-img" });
			imgL.src = leftUrl;
			imgL.alt = `Page ${leftIdx + 1}`;
		}

		if (rightIdx < this.imageList.length) {
			const rightUrl = await this.loadImageDataUrl(rightIdx);
			if (rightUrl) {
				const imgR = this.imageContainer.createEl("img", { cls: "ldr-comic-page-img ldr-comic-double-img" });
				imgR.src = rightUrl;
				imgR.alt = `Page ${rightIdx + 1}`;
			}
		}

		this.applyBrightness();
		this.preloadPages(leftIdx);
	}

	// ── SWITCH MODE ──────────────────────────────────────────────

	private async switchMode(mode: ReadingMode) {
		this.activeMode = mode;
		this.settings.readingMode = mode;
		await this.plugin.store.updateComicReaderSettings({ readingMode: mode });

		await this.renderCurrentMode();
		this.updatePageIndicator();
		this.updatePageSlider();
		this.buildSettingsPanel();
	}

	// ── NAVIGATION ───────────────────────────────────────────────

	private async nextPage() {
		if (this.isNavigating || this.imageList.length === 0) return;
		const step = this.activeMode === "double" ? 2 : 1;
		if (this.currentPage + step > this.imageList.length - 1) return;
		this.isNavigating = true;
		this.resetZoom();
		this.currentPage = Math.min(this.currentPage + step, this.imageList.length - 1);
		await this.renderCurrentMode();
		this.updatePageIndicator();
		this.updatePageSlider();
		this.saveProgress();
		this.isNavigating = false;
	}

	private async prevPage() {
		if (this.isNavigating || this.imageList.length === 0) return;
		if (this.currentPage <= 0) return;
		this.isNavigating = true;
		this.resetZoom();
		const step = this.activeMode === "double" ? 2 : 1;
		this.currentPage = Math.max(0, this.currentPage - step);
		await this.renderCurrentMode();
		this.updatePageIndicator();
		this.updatePageSlider();
		this.saveProgress();
		this.isNavigating = false;
	}

	async goToPage(index: number) {
		if (this.imageList.length === 0) return;
		this.isNavigating = true;
		this.resetZoom();
		this.currentPage = Math.max(0, Math.min(index, this.imageList.length - 1));
		await this.renderCurrentMode();
		this.updatePageIndicator();
		this.updatePageSlider();
		this.saveProgress();
		this.isNavigating = false;
	}

	// ── PRELOAD ───────────────────────────────────────────────────

	private preloadPages(around: number) {
		if (!this.zipInstance) return;
		const preload = Platform.isMobile ? 2 : this.settings.preloadPages;
		const start = Math.max(0, around - preload);
		const end = Math.min(this.imageList.length - 1, around + preload);
		for (let i = start; i <= end; i++) {
			if (i === around) continue;
			const key = this.cacheKey(i);
			if (this.cache.has(key)) continue;
			const zip = this.zipInstance;
			const images = this.imageList;
			CbzParser.extractImageAtIndex(zip, images, i)
				.then((img) => {
					if (img) this.cache.set(key, `data:${img.mimeType};base64,${img.base64}`);
				})
				.catch(() => {});
		}
	}

	private async loadImageDataUrl(index: number): Promise<string | null> {
		if (!this.zipInstance) return null;
		const key = this.cacheKey(index);
		const cached = this.cache.get(key);
		if (cached) return cached;
		const img = await CbzParser.extractImageAtIndex(this.zipInstance, this.imageList, index);
		if (!img) return null;
		const url = `data:${img.mimeType};base64,${img.base64}`;
		this.cache.set(key, url);
		return url;
	}

	// ── SETTINGS PANEL ───────────────────────────────────────────

	private buildSettingsPanel() {
		const p = this.settingsPanel;
		p.empty();

		// Progreso
		const topBar = p.createDiv({ cls: "ldr-sp-topbar" });
		const pctWrap = topBar.createDiv({ cls: "ldr-sp-pct-wrap" });
		const total = this.imageList.length;
		pctWrap.createSpan({ cls: "ldr-sp-pct", text: total > 0 ? `${this.currentPage + 1} / ${total}` : "— / —" });
		pctWrap.createSpan({ cls: "ldr-sp-pct-sub", text: "page" });

		const pctBar = topBar.createDiv({ cls: "ldr-sp-pct-bar" });
		const pct = total > 1 ? (this.currentPage / (total - 1)) * 100 : 0;
		pctBar.createDiv({ cls: "ldr-sp-pct-fill", attr: { style: `width:${pct}%` } });

		const btns = topBar.createDiv({ cls: "ldr-sp-topbtns" });
		this.makeTopBtn(btns, "full screen",
			`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`,
			() => this.toggleFullscreen());

		p.createDiv({ cls: "ldr-sp-sep" });

		// Selector de modo de lectura
		p.createDiv({ cls: "ldr-sp-label", text: "Reading mode" });
		const modeRow = p.createDiv({ cls: "ldr-comic-fit-row" });
		const modes: Array<{ key: ReadingMode; icon: string; label: string }> = [
			{
				key: "paginated",
				label: "Page",
				icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="3" width="16" height="18" rx="2"/></svg>`,
			},
			{
				key: "double",
				label: "Double",
				icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="9" height="18" rx="1"/><rect x="13" y="3" width="9" height="18" rx="1"/></svg>`,
			},
		];
		for (const { key, icon, label } of modes) {
			const btn = modeRow.createDiv({
				cls: `ldr-comic-fit-btn ldr-comic-mode-btn${this.activeMode === key ? " is-active" : ""}`,
			});
			btn.innerHTML = icon;
			btn.createSpan({ text: label });
			btn.addEventListener("click", async () => {
				if (this.activeMode === key) return;
				await this.switchMode(key);
			});
		}

		p.createDiv({ cls: "ldr-sp-sep" });

		// Fit mode — siempre visible (no hay webtoon)
		p.createDiv({ cls: "ldr-sp-label", text: "Fit mode" });
		const fitRow = p.createDiv({ cls: "ldr-comic-fit-row" });
		const fitModes: Array<{ key: ComicReaderSettings["fitMode"]; label: string }> = [
			{ key: "width", label: "Width" },
			{ key: "height", label: "Height" },
			{ key: "contain", label: "Fit" },
			{ key: "original", label: "1:1" },
		];
		for (const { key, label } of fitModes) {
			const btn = fitRow.createDiv({
				cls: `ldr-comic-fit-btn${this.settings.fitMode === key ? " is-active" : ""}`,
				text: label,
			});
			btn.addEventListener("click", async () => {
				this.settings.fitMode = key;
				await this.plugin.store.updateComicReaderSettings({ fitMode: key });
				this.applyFitMode();
				this.buildSettingsPanel();
			});
		}

		p.createDiv({ cls: "ldr-sp-sep" });

		// Slider de brillo
		const slidersRow = p.createDiv({ cls: "ldr-sp-sliders-row" });
		this.buildBrightnessSlider(slidersRow);
	}

	private makeTopBtn(parent: HTMLElement, label: string, icon: string, onClick: () => void) {
		const btn = parent.createDiv({ cls: "ldr-sp-topbtn" });
		btn.innerHTML = icon;
		btn.createSpan({ text: label });
		btn.addEventListener("click", onClick);
	}

	private buildBrightnessSlider(parent: HTMLElement) {
		const min = 50, max = 150, step = 5;
		const col = parent.createDiv({ cls: "ldr-sp-vcol" });
		const trackWrap = col.createDiv({ cls: "ldr-sp-vtrack-wrap" });
		const track = trackWrap.createDiv({ cls: "ldr-sp-vtrack" });
		const fill = track.createDiv({ cls: "ldr-sp-vfill" });
		const thumb = track.createDiv({ cls: "ldr-sp-vthumb" });

		const p0 = (this.settings.brightness - min) / (max - min);
		fill.style.height = `${p0 * 100}%`;
		thumb.style.bottom = `${p0 * 100}%`;

		const valLabel = col.createDiv({ cls: "ldr-sp-vval", text: String(this.settings.brightness) });
		col.createDiv({ cls: "ldr-sp-vlabel", text: "BRIGHTNESS" });

		let dragging = false;
		const update = (clientY: number) => {
			const rect = track.getBoundingClientRect();
			const ratio = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
			const val = Math.max(min, Math.min(max, Math.round((min + ratio * (max - min)) / step) * step));
			this.settings.brightness = val;
			fill.style.height = `${ratio * 100}%`;
			thumb.style.bottom = `${ratio * 100}%`;
			valLabel.textContent = String(val);
			this.applyBrightness();
			this.plugin.store.updateComicReaderSettings({ brightness: val });
		};
		track.addEventListener("mousedown", (e) => { dragging = true; update(e.clientY); e.preventDefault(); });
		document.addEventListener("mousemove", (e) => { if (dragging) update(e.clientY); });
		document.addEventListener("mouseup", () => { dragging = false; });
		track.addEventListener("touchstart", (e) => update(e.touches[0].clientY), { passive: true });
		track.addEventListener("touchmove", (e) => update(e.touches[0].clientY), { passive: true });
	}

	private toggleSettings() {
		this.settingsOpen = !this.settingsOpen;
		if (this.settingsOpen) this.buildSettingsPanel();
		this.settingsPanel.toggleClass("is-open", this.settingsOpen);
	}

	private closeSettings() {
		this.settingsOpen = false;
		this.settingsPanel.removeClass("is-open");
	}

	// ── THUMBNAIL GRID ────────────────────────────────────────────

	private showThumbnailGrid(root: HTMLElement) {
		root.querySelector(".ldr-thumb-modal")?.remove();

		const modal = root.createDiv({ cls: "ldr-thumb-modal" });
		const overlay = modal.createDiv({ cls: "ldr-controls-overlay" });
		overlay.addEventListener("click", () => modal.remove());

		const panel = modal.createDiv({ cls: "ldr-thumb-panel" });

		const hdr = panel.createDiv({ cls: "ldr-controls-hdr" });
		hdr.createSpan({ cls: "ldr-controls-title", text: `Pages · ${this.imageList.length}` });
		const closeBtn = hdr.createDiv({ cls: "ldr-controls-close" });
		closeBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
		closeBtn.addEventListener("click", () => modal.remove());

		const grid = panel.createDiv({ cls: "ldr-thumb-grid" });

		// Lazy loading con IntersectionObserver + margen amplio
		const thumbObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const cell = entry.target as HTMLElement;
					if (cell.getAttribute("data-loaded") === "1") continue;
					cell.setAttribute("data-loaded", "1");
					thumbObserver.unobserve(cell);
					const idx = Number(cell.getAttribute("data-index"));
					this.loadImageDataUrl(idx).then((url) => {
						if (!url) return;
						const img = cell.querySelector("img") as HTMLImageElement | null;
						if (img) img.src = url;
					});
				}
			},
			{ root: grid, rootMargin: "400px" },
		);

		for (let i = 0; i < this.imageList.length; i++) {
			const cell = grid.createDiv({
				cls: `ldr-thumb-cell${i === this.currentPage ? " is-active" : ""}`,
				attr: { "data-index": String(i) },
			});
			const imgEl = cell.createEl("img", { cls: "ldr-thumb-img", attr: { alt: `Page ${i + 1}` } });
			cell.createDiv({ cls: "ldr-thumb-num", text: String(i + 1) });

			// Si ya está en caché, cargar inmediatamente sin esperar al observer
			const cached = this.cache.get(this.cacheKey(i));
			if (cached) {
				imgEl.src = cached;
				cell.setAttribute("data-loaded", "1");
			} else {
				thumbObserver.observe(cell);
			}

			cell.addEventListener("click", () => {
				modal.remove();
				this.goToPage(i);
			});
		}

		// Scroll a la página activa
		setTimeout(() => {
			const active = grid.querySelector(".ldr-thumb-cell.is-active") as HTMLElement;
			if (active) active.scrollIntoView({ block: "center" });
		}, 50);
	}

	// ── APPLY STYLES ─────────────────────────────────────────────

	private applyFitMode() {
		if (!this.imageContainer) return;
		this.imageContainer.removeClass("ldr-fit-width", "ldr-fit-height", "ldr-fit-contain", "ldr-fit-original");
		this.imageContainer.addClass(`ldr-fit-${this.settings.fitMode}`);
		// En fit-width sin zoom, habilitar scroll vertical para ver imágenes altas
		this.updateBodyScroll();
	}

	/** Activa/desactiva el scroll vertical del bodyEl según fit mode y zoom */
	private updateBodyScroll() {
		const scrollable = this.settings.fitMode === "width" && this.zoomLevel <= 1.0;
		this.bodyEl.toggleClass("ldr-body--scrollable", scrollable);
	}

	private applyBrightness() {
		if (!this.imageContainer) return;
		this.imageContainer.style.filter = `brightness(${this.settings.brightness / 100})`;
	}

	private applyBackground() {
		const root = this.containerEl.children[1] as HTMLElement;
		if (root) root.style.setProperty("background", this.settings.backgroundColor);
	}

	// ── PAGE INDICATOR ────────────────────────────────────────────

	private updatePageIndicator() {
		if (!this.pageIndicator) return;
		const total = this.imageList.length;
		if (!this.settings.showPageIndicator) { this.pageIndicator.textContent = ""; return; }
		if (this.activeMode === "double" && total > 0) {
			const right = Math.min(this.currentPage + 1, total - 1);
			this.pageIndicator.textContent = `${this.currentPage + 1}–${right + 1} / ${total}`;
		} else {
			this.pageIndicator.textContent = total > 0 ? `${this.currentPage + 1} / ${total}` : "— / —";
		}
	}

	// ── LOADING ───────────────────────────────────────────────────

	private showLoading(show: boolean) {
		const existing = this.imageContainer?.querySelector(".ldr-comic-loading");
		if (show) {
			if (!existing && this.imageContainer) {
				const loader = this.imageContainer.createDiv({ cls: "ldr-comic-loading" });
				loader.innerHTML = `<svg class="ldr-comic-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="32" height="32"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/></svg><span>Loading…</span>`;
			}
		} else {
			existing?.remove();
		}
	}

	// ── FULLSCREEN ────────────────────────────────────────────────

	private toggleFullscreen() {
		this.closeSettings();
		this.isFullscreen ? this.exitFullscreen() : this.enterFullscreen();
	}

	private enterFullscreen() {
		this.isFullscreen = true;
		document.body.classList.add("ldr-fullscreen");
		this.containerEl.classList.add("ldr-fullscreen-leaf");
		if (document.documentElement.requestFullscreen) {
			document.documentElement.requestFullscreen().catch(() => {});
		}
	}

	private exitFullscreen() {
		this.isFullscreen = false;
		document.body.classList.remove("ldr-fullscreen");
		this.containerEl.classList.remove("ldr-fullscreen-leaf");
		if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
	}

	// ── RESIZE / LANDSCAPE AUTO-DOUBLE ───────────────────────────

	private debouncedResize() {
		if (this.resizeDebounce) clearTimeout(this.resizeDebounce);
		this.resizeDebounce = setTimeout(() => {
			this.resizeDebounce = null;
			if (!this.settings.autoDoubleOnLandscape) return;
			const isLandscape = window.innerWidth > window.innerHeight;
			const wantDouble = isLandscape && this.activeMode === "paginated";
			const wantSingle = !isLandscape && this.activeMode === "double";
			if (wantDouble) this.switchMode("double");
			else if (wantSingle) this.switchMode("paginated");
		}, 300);
	}

	// ── PROGRESS ─────────────────────────────────────────────────

	private saveProgress() {
		if (!this.book || this.imageList.length === 0) return;
		const total = this.imageList.length;
		const progress = total > 1 ? Math.round((this.currentPage / (total - 1)) * 100) : 100;
		const state: ReadingState = {
			bookId: this.book.id,
			cfi: "",
			currentPage: this.currentPage + 1,
			totalPages: total,
			currentChapterId: "",
			progress,
			lastReadAt: Date.now(),
			pageIndex: this.currentPage,
			readingMode: this.activeMode,
		};
		this.plugin.store.saveReadingState(state);
	}

	// ── CONTROLS INFO ────────────────────────────────────────────

	private showControlsInfo(root: HTMLElement) {
		root.querySelector(".ldr-controls-modal")?.remove();

		const modal = root.createDiv({ cls: "ldr-controls-modal" });
		const overlay = modal.createDiv({ cls: "ldr-controls-overlay" });
		overlay.addEventListener("click", () => modal.remove());

		const panel = modal.createDiv({ cls: "ldr-controls-panel" });
		const hdr = panel.createDiv({ cls: "ldr-controls-hdr" });
		hdr.createSpan({ cls: "ldr-controls-title", text: "Controls" });
		const closeBtn = hdr.createDiv({ cls: "ldr-controls-close" });
		closeBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
		closeBtn.addEventListener("click", () => modal.remove());

		this.addControlsSection(panel, "🖥  Desktop", [
			{ key: "← →", desc: "Previous / Next page" },
			{ key: "Ctrl + scroll", desc: "Zoom (focal point)" },
			{ key: "Two-finger scroll", desc: "Pan when zoomed / Navigate pages" },
			{ key: "Click edge", desc: "Previous / Next page" },
			{ key: "⊞", desc: "Open page grid" },
			{ key: "⚙", desc: "Mode, fit, brightness, fullscreen" },
		]);

		this.addControlsSection(panel, "📱  Mobile", [
			{ key: "Tap left ◀", desc: "Previous page" },
			{ key: "Tap right ▶", desc: "Next page" },
			{ key: "Swipe ←→", desc: "Navigate pages" },
			{ key: "Pinch", desc: "Zoom (focal point)" },
			{ key: "Double-tap", desc: "Reset zoom" },
			{ key: "Drag (zoomed)", desc: "Pan image" },
		]);

		this.addControlsSection(panel, "⚙  Modes", [
			{ key: "Page", desc: "Single image, keyboard / swipe" },
			{ key: "Double", desc: "Two pages side by side" },
		]);

		const onEsc = (e: KeyboardEvent) => {
			if (e.key === "Escape") { modal.remove(); document.removeEventListener("keydown", onEsc); }
		};
		document.addEventListener("keydown", onEsc);
	}

	private addControlsSection(parent: HTMLElement, title: string, rows: { key: string; desc: string }[]) {
		const section = parent.createDiv({ cls: "ldr-controls-section" });
		section.createDiv({ cls: "ldr-controls-section-title", text: title });
		for (const { key, desc } of rows) {
			const row = section.createDiv({ cls: "ldr-controls-row" });
			row.createEl("kbd", { cls: "ldr-controls-key", text: key });
			row.createSpan({ cls: "ldr-controls-desc", text: desc });
		}
	}

	// ── ZOOM ──────────────────────────────────────────────────────

	/**
	 * Aplica zoom con punto focal: el punto (focalX, focalY) en
	 * coordenadas de pantalla queda anclado durante el zoom.
	 * Fórmula: tx_new = dx*(1 - s_new/s_old) + tx_old*(s_new/s_old)
	 * donde dx = focalX - centerX del contenedor sin transformar.
	 */
	private setZoom(level: number, focalX?: number, focalY?: number) {
		const oldScale = this.zoomLevel;
		const newScale = Math.max(1.0, Math.min(5.0, level));

		if (focalX !== undefined && focalY !== undefined && oldScale > 0 && newScale !== oldScale) {
			const rect = this.bodyEl.getBoundingClientRect();
			const cx = rect.left + rect.width / 2;
			const cy = rect.top + rect.height / 2;
			const dx = focalX - cx;
			const dy = focalY - cy;
			this.panX = dx * (1 - newScale / oldScale) + this.panX * (newScale / oldScale);
			this.panY = dy * (1 - newScale / oldScale) + this.panY * (newScale / oldScale);
		}

		this.zoomLevel = newScale;

		if (newScale <= 1.0) {
			this.panX = 0;
			this.panY = 0;
		} else {
			this.clampPan();
		}

		this.applyZoom();
	}

	private resetZoom() {
		this.zoomLevel = 1.0;
		this.panX = 0;
		this.panY = 0;
		this.applyZoom();
	}

	/**
	 * Limita el pan para que la imagen no exponga espacio vacío
	 * dentro del contenedor.
	 */
	private clampPan() {
		const rect = this.bodyEl.getBoundingClientRect();
		const maxX = (rect.width * (this.zoomLevel - 1)) / 2;
		const maxY = (rect.height * (this.zoomLevel - 1)) / 2;
		this.panX = Math.max(-maxX, Math.min(maxX, this.panX));
		this.panY = Math.max(-maxY, Math.min(maxY, this.panY));
	}

	private applyZoom() {
		if (!this.imageContainer) return;
		this.imageContainer.style.transform =
			this.zoomLevel === 1.0 && this.panX === 0 && this.panY === 0
				? ""
				: `translate(${this.panX}px, ${this.panY}px) scale(${this.zoomLevel})`;
		// Actualizar scroll del bodyEl según zoom actual
		this.updateBodyScroll();
	}

	private getTouchDist(touches: TouchList): number {
		const dx = touches[0].clientX - touches[1].clientX;
		const dy = touches[0].clientY - touches[1].clientY;
		return Math.sqrt(dx * dx + dy * dy);
	}

	private getTouchMidpoint(touches: TouchList): { x: number; y: number } {
		return {
			x: (touches[0].clientX + touches[1].clientX) / 2,
			y: (touches[0].clientY + touches[1].clientY) / 2,
		};
	}

	// ── HELPERS ───────────────────────────────────────────────────

	private cacheKey(index: number): string {
		return `${this.book?.id ?? "unknown"}:${index}`;
	}

	refresh() {
		this.settings = { ...DEFAULT_COMIC_READER_SETTINGS, ...this.plugin.store.getComicReaderSettings() };
		this.applyBackground();
		this.applyFitMode();
		this.applyBrightness();
	}
}
