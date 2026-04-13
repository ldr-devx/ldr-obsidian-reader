// ============================================================
// src/views/ReaderView.ts
// ============================================================

import ePub from "epubjs";
import { ItemView, WorkspaceLeaf, Notice, TFile } from "obsidian";
import type LdrEpubReaderPlugin from "../../main";
import {
	Book,
	ReadingState,
	ReaderSettings,
	BgColor,
	FontFamily,
	DEFAULT_READER_SETTINGS,
} from "../models";

export const READER_VIEW_TYPE = "ldr-epub-reader";

const COLOR_MAP: Record<
	BgColor,
	{ bg: string; fg: string; fgRgb: string; useRgba: boolean }
> = {
	white: {
		bg: "#f5f2eb",
		fg: "#1a1a1a",
		fgRgb: "26,26,26",
		useRgba: true,
	},
	sepia: {
		bg: "#f0e6c8",
		fg: "#3d2b1f",
		fgRgb: "61,43,31",
		useRgba: true,
	},
	gray: {
		bg: "#2a2a2a",
		fg: "#d0d0d0",
		fgRgb: "208,208,208",
		useRgba: true,
	},
	black: {
		bg: "#0d0b14",
		fg: "#e2dff0",
		fgRgb: "226,223,240",
		useRgba: true,
	},
	transparent: {
		bg: "transparent",
		fg: "",
		fgRgb: "",
		useRgba: false,
	},
};

const FONTS: FontFamily[] = [
	"Georgia",
	"Literata",
	"Inter",
	"OpenDyslexic",
	"SourceCodePro",
];

/** Stacks de fuentes que funcionan sin cargar archivos externos */
const FONT_STACKS: Record<FontFamily, string> = {
	Georgia: `Georgia, "Times New Roman", serif`,
	Literata: `Literata, Georgia, "Times New Roman", serif`,
	Inter: `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif`,
	OpenDyslexic: `OpenDyslexic, "Comic Sans MS", cursive, sans-serif`,
	SourceCodePro: `"Source Code Pro", "Courier New", Consolas, monospace`,
};

export class ReaderView extends ItemView {
	private plugin: LdrEpubReaderPlugin;
	private book: Book | null = null;
	private epubBook: any = null;
	private rendition: any = null;
	private settings: ReaderSettings;

	private iframeWrap: HTMLElement;
	private settingsPanel: HTMLElement;
	private settingsBtn: HTMLElement;
	private pageCounter: HTMLElement;

	private settingsOpen = false;
	private isFlipping = false;
	private isFullscreen = false;
	private currentPct = 0;
	private locationsReady = false;
	private initialLoadDone = false;
	private reloadDebounce: ReturnType<typeof setTimeout> | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: LdrEpubReaderPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.settings = {
			...DEFAULT_READER_SETTINGS,
			...plugin.store.getReaderSettings(),
		};
	}

	getViewType() {
		return READER_VIEW_TYPE;
	}
	getDisplayText() {
		return this.book?.title ?? "Reader";
	}
	getIcon() {
		return "book-open";
	}

	async onOpen() {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass("ldr-reader");
		this.buildUI(root);
	}

	async onClose() {
		this.saveProgress();
		if (this.isFullscreen) this.exitFullscreen();
		this.epubBook?.destroy();
	}

	// ── CARGAR LIBRO ─────────────────────────────────────────────

	async loadBook(bookId: string) {
		this.book = this.plugin.store.getBook(bookId);
		if (!this.book) {
			new Notice("Book not found.");
			return;
		}

		const file = this.app.vault.getAbstractFileByPath(this.book.filePath);
		if (!(file instanceof TFile)) {
			new Notice("File not found.");
			return;
		}

		this.epubBook?.destroy();
		this.epubBook = null;
		this.rendition = null;
		this.initialLoadDone = false;
		this.currentPct = 0;
		this.iframeWrap.empty();

		const root = this.containerEl.children[1] as HTMLElement;
		this.applyBg(root);

		const buffer = await this.app.vault.readBinary(file);
		this.epubBook = ePub(buffer, { replacements: "base64" });

		// Interceptar iframe para sandbox
		const iframeObserver = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				for (const node of Array.from(mutation.addedNodes)) {
					if (node instanceof HTMLIFrameElement) {
						node.setAttribute(
							"sandbox",
							"allow-same-origin allow-scripts allow-popups",
						);
						iframeObserver.disconnect();
					}
				}
			}
		});
		iframeObserver.observe(this.iframeWrap, {
			childList: true,
			subtree: true,
		});

		this.rendition = this.epubBook.renderTo(this.iframeWrap, {
			width: "100%",
			height: "100%",
			spread: "none",
			flow: "paginated",
			allowScriptedContent: false,
		});
		iframeObserver.observe(this.iframeWrap, {
			childList: true,
			subtree: true,
		});

		// Hook: convertir data: stylesheets a inline + inyectar CSS
		this.rendition.hooks.content.register(async (contents: any) => {
			const doc: Document | undefined = contents?.document;
			if (!doc) return;

			const links = Array.from(
				doc.querySelectorAll('link[rel="stylesheet"]'),
			);
			for (const link of links) {
				const href = link.getAttribute("href") ?? "";
				if (href.startsWith("data:text/css;base64,")) {
					try {
						const b64 = href.substring(
							"data:text/css;base64,".length,
						);
						const cssText = atob(b64);
						const inlineStyle = doc.createElement("style");
						inlineStyle.textContent = cssText;
						link.replaceWith(inlineStyle);
					} catch {
						link.remove();
					}
				} else if (
					href.startsWith("data:") ||
					href.startsWith("blob:")
				) {
					link.remove();
				}
			}

			const old = doc.getElementById("ldr-injected");
			if (old) old.remove();
			const style = doc.createElement("style");
			style.id = "ldr-injected";
			style.textContent = this.buildCss();
			doc.head?.appendChild(style);
		});

		const saved = this.plugin.store.getReadingState(this.book.id);

		// Show saved progress immediately so counter is correct from the start
		if (saved && saved.progress > 0) {
			this.currentPct = saved.progress / 100;
			this.updateCounter();
		}

		await this.rendition.display(saved?.cfi ?? undefined);

		this.locationsReady = false;
		this.initialLoadDone = false;
		const loadBreakSize = Math.round(1500 * (18 / this.settings.fontSize));
		this.epubBook.ready
			.then(() => this.epubBook.locations.generate(loadBreakSize))
			.then(() => {
				this.locationsReady = true;
				// Recalculate with accurate locations now that they're ready
				const loc = this.rendition?.location;
				if (loc?.start?.cfi) {
					try {
						this.currentPct =
							this.epubBook.locations.percentageFromCfi(
								loc.start.cfi,
							);
					} catch {}
				}
				this.updateCounter();
			})
			.catch(() => {});

		this.rendition.on("relocated", (loc: any) => {
			const cfi = loc?.start?.cfi;
			if (!cfi) return;
			if (this.locationsReady) {
				try {
					this.currentPct =
						this.epubBook.locations.percentageFromCfi(cfi);
				} catch {
					this.currentPct = loc?.start?.percentage ?? 0;
				}
			} else if (this.initialLoadDone) {
				// User navigated before locations ready — use epub.js estimate
				this.currentPct = loc?.start?.percentage ?? 0;
			}
			// If !initialLoadDone, keep the accurate saved progress value
			this.initialLoadDone = true;
			this.updateCounter();
			if (this.settingsOpen) this.updateSettingsPct();
			this.saveProgress();
		});

		this.rendition.on("keydown", (e: KeyboardEvent) => {
			if (e.key === "ArrowRight" || e.key === "ArrowDown")
				this.nextPage();
			if (e.key === "ArrowLeft" || e.key === "ArrowUp") this.prevPage();
			if (e.key === "Escape" && this.isFullscreen) this.exitFullscreen();
		});
	}

	// ── CSS ──────────────────────────────────────────────────────

	private buildCss(): string {
		const colorInfo = COLOR_MAP[this.settings.bgColor];
		const brightness = 0.35 + (this.settings.brightness / 100) * 0.65;
		const fontStack = FONT_STACKS[this.settings.fontFamily];

		let bgRule: string;
		let colorRule: string;
		let linkColor: string;

		if (colorInfo.useRgba) {
			bgRule = `background: ${colorInfo.bg} !important;`;
			colorRule = `color: rgba(${colorInfo.fgRgb}, ${brightness.toFixed(2)}) !important;`;
			linkColor = `rgba(${colorInfo.fgRgb}, .28)`;
		} else {
			// Transparent: usa el color elegido por el usuario
			const txtColor =
				this.settings.transparentTextColor === "white"
					? "#e2dff0"
					: "#1a1a1a";
			bgRule = `background: transparent !important;`;
			colorRule = `color: ${txtColor} !important; opacity: ${brightness.toFixed(2)};`;
			linkColor = `currentColor`;
		}

		return `
      html, body {
        ${bgRule}
        ${colorRule}
        font-family: ${fontStack} !important;
        font-size: ${this.settings.fontSize}px !important;
        line-height: 1.7 !important;
        margin: 0 !important;
        padding: 0 24px !important;
        -webkit-font-smoothing: antialiased;
        overflow-wrap: break-word !important;
        word-wrap: break-word !important;
      }
      * { background: transparent !important; box-sizing: border-box; }
      p  { margin: 0 0 0.8em !important; orphans: 2; widows: 2; overflow-wrap: break-word !important; }
      a  { color: inherit !important; text-decoration-color: ${linkColor} !important; }
      img, svg { max-width: 100% !important; height: auto !important; display: block; margin: 0 auto; }
    `;
	}

	/** Inyecta/actualiza CSS en el iframe sin recargar la página */
	private applyStyles() {
		if (!this.rendition) return;
		try {
			const contents = this.rendition.getContents();
			for (const content of contents) {
				const doc = content?.document;
				if (!doc) continue;
				let style = doc.getElementById(
					"ldr-injected",
				) as HTMLStyleElement | null;
				if (!style) {
					const s = doc.createElement("style");
					s.id = "ldr-injected";
					doc.head?.appendChild(s);
					style = s;
				}
				style!.textContent = this.buildCss();
			}
		} catch {}
	}

	/** Recarga con debounce (para cambios que afectan paginación) */
	private debouncedReload() {
		if (this.reloadDebounce) clearTimeout(this.reloadDebounce);
		this.reloadDebounce = setTimeout(() => {
			this.reloadDebounce = null;
			this.reloadPage();
			// Regenerate locations with font-size-aware break size
			if (this.epubBook) {
				this.locationsReady = false;
				this.initialLoadDone = true; // treat as user-initiated change
				const breakSize = Math.round(
					1500 * (18 / this.settings.fontSize),
				);
				this.epubBook.locations
					.generate(breakSize)
					.then(() => {
						this.locationsReady = true;
						const loc = this.rendition?.location;
						if (loc?.start?.cfi) {
							try {
								this.currentPct =
									this.epubBook.locations.percentageFromCfi(
										loc.start.cfi,
									);
							} catch {}
						}
						this.updateCounter();
					})
					.catch(() => {});
			}
		}, 400);
	}

	// ── UI ───────────────────────────────────────────────────────

	private buildUI(root: HTMLElement) {
		this.applyBg(root);

		const header = root.createDiv({ cls: "ldr-reader-header" });
		const backBtn = header.createDiv({
			cls: "ldr-reader-btn",
			attr: { title: "Back" },
		});
		backBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>`;
		backBtn.addEventListener("click", () => {
			this.saveProgress();
			if (this.isFullscreen) this.exitFullscreen();
			this.plugin.openHomeView();
		});

		header.createDiv({ cls: "ldr-reader-spacer" });

		const infoBtn = header.createDiv({
			cls: "ldr-reader-btn",
			attr: { title: "Controls" },
		});
		infoBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
		infoBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.showControlsInfo(root);
		});

		this.settingsBtn = header.createDiv({
			cls: "ldr-reader-btn",
			attr: { title: "Settings" },
		});
		this.settingsBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
		this.settingsBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.toggleSettings();
		});

		const body = root.createDiv({ cls: "ldr-reader-body" });

		body.createDiv({
			cls: "ldr-tap-zone ldr-tap-zone--left",
		}).addEventListener("click", () => this.prevPage());

		this.iframeWrap = body.createDiv({ cls: "ldr-reader-iframe-wrap" });

		body.createDiv({
			cls: "ldr-tap-zone ldr-tap-zone--right",
		}).addEventListener("click", () => this.nextPage());

		const footer = root.createDiv({ cls: "ldr-reader-footer" });
		this.pageCounter = footer.createDiv({
			cls: "ldr-page-counter",
			text: "— / —",
		});

		this.settingsPanel = root.createDiv({ cls: "ldr-settings-panel" });
		this.buildSettingsPanel();

		root.addEventListener("click", (e) => {
			if (
				this.settingsOpen &&
				!this.settingsPanel.contains(e.target as Node) &&
				!this.settingsBtn.contains(e.target as Node)
			) {
				this.closeSettings();
			}
		});

		// Escape key para fullscreen
		this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
			if (e.key === "Escape" && this.isFullscreen) {
				this.exitFullscreen();
			}
		});

		// Sincronizar estado cuando el fullscreen nativo se cierra (ej: botón atrás de Android)
		this.registerDomEvent(document, "fullscreenchange", () => {
			if (!document.fullscreenElement && this.isFullscreen) {
				this.isFullscreen = false;
				document.body.classList.remove("ldr-fullscreen");
				this.containerEl.classList.remove("ldr-fullscreen-leaf");
			}
		});
	}

	// ── SETTINGS PANEL ───────────────────────────────────────────

	private buildSettingsPanel() {
		const p = this.settingsPanel;
		p.empty();

		// Progreso
		const topBar = p.createDiv({ cls: "ldr-sp-topbar" });
		const pctWrap = topBar.createDiv({ cls: "ldr-sp-pct-wrap" });
		pctWrap.createSpan({
			cls: "ldr-sp-pct",
			text: `${Math.round(this.currentPct * 100)}%`,
		});
		pctWrap.createSpan({ cls: "ldr-sp-pct-sub", text: "read" });

		const pctBar = topBar.createDiv({ cls: "ldr-sp-pct-bar" });
		pctBar.createDiv({
			cls: "ldr-sp-pct-fill",
			attr: { style: `width:${Math.round(this.currentPct * 100)}%` },
		});

		const btns = topBar.createDiv({ cls: "ldr-sp-topbtns" });
		this.makeTopBtn(
			btns,
			"chapters",
			`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="15" y2="18"/></svg>`,
			() => this.showChapters(),
		);
		this.makeTopBtn(
			btns,
			"full screen",
			`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`,
			() => this.toggleFullscreen(),
		);

		p.createDiv({ cls: "ldr-sp-sep" });

		// Colores
		p.createDiv({ cls: "ldr-sp-label", text: "Background" });
		const colorRow = p.createDiv({ cls: "ldr-sp-colors" });
		(
			["white", "sepia", "gray", "black", "transparent"] as BgColor[]
		).forEach((key) => {
			const info = COLOR_MAP[key];
			const dot = colorRow.createDiv({
				cls: `ldr-sp-dot${this.settings.bgColor === key ? " is-active" : ""}${key === "transparent" ? " ldr-sp-dot--transparent" : ""}`,
			});

			if (key === "transparent") {
				// Patrón checkerboard para indicar transparencia
				dot.style.background = `
					linear-gradient(45deg, #666 25%, transparent 25%),
					linear-gradient(-45deg, #666 25%, transparent 25%),
					linear-gradient(45deg, transparent 75%, #666 75%),
					linear-gradient(-45deg, transparent 75%, #666 75%)
				`;
				dot.style.backgroundSize = "10px 10px";
				dot.style.backgroundPosition = "0 0, 0 5px, 5px -5px, -5px 0px";
			} else {
				dot.style.background = info.bg;
			}

			if (this.settings.bgColor === key) {
				const borderColor = key === "transparent" ? "#a78bfa" : info.fg;
				dot.style.boxShadow = `0 0 0 2px ${borderColor}, 0 0 0 4px rgba(167,139,250,0.4)`;
			}

			dot.addEventListener("click", async () => {
				this.settings.bgColor = key;
				await this.plugin.store.updateReaderSettings({ bgColor: key });
				const root = this.containerEl.children[1] as HTMLElement;
				this.applyBg(root);
				this.applyStyles();
				this.buildSettingsPanel();
			});
		});

		// Toggle blanco/negro para modo transparente
		if (this.settings.bgColor === "transparent") {
			p.createDiv({ cls: "ldr-sp-label", text: "Text color" });
			const txtRow = p.createDiv({ cls: "ldr-sp-colors" });
			(["black", "white"] as const).forEach((tc) => {
				const isActive = this.settings.transparentTextColor === tc;
				const dot = txtRow.createDiv({
					cls: `ldr-sp-dot${isActive ? " is-active" : ""}`,
				});
				dot.style.width = "26px";
				dot.style.height = "26px";
				dot.style.background = tc === "white" ? "#e2dff0" : "#1a1a1a";
				if (isActive) {
					dot.style.boxShadow =
						"0 0 0 2px #a78bfa, 0 0 0 4px rgba(167,139,250,0.4)";
				}
				dot.addEventListener("click", async () => {
					this.settings.transparentTextColor = tc;
					await this.plugin.store.updateReaderSettings({
						transparentTextColor: tc,
					});
					const root = this.containerEl.children[1] as HTMLElement;
					this.applyBg(root);
					this.applyStyles();
					this.buildSettingsPanel();
				});
			});
		}

		p.createDiv({ cls: "ldr-sp-sep" });

		// Fuente
		p.createDiv({ cls: "ldr-sp-label", text: "Font" });
		const fontRow = p.createDiv({ cls: "ldr-sp-fontrow" });
		const prevF = fontRow.createDiv({ cls: "ldr-sp-arrow" });
		prevF.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>`;
		const fontName = fontRow.createDiv({
			cls: "ldr-sp-fontname",
			text: this.settings.fontFamily,
		});
		const nextF = fontRow.createDiv({ cls: "ldr-sp-arrow" });
		nextF.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>`;

		const changeFont = async (d: number) => {
			const i = FONTS.indexOf(this.settings.fontFamily);
			this.settings.fontFamily =
				FONTS[(i + d + FONTS.length) % FONTS.length];
			fontName.textContent = this.settings.fontFamily;
			await this.plugin.store.updateReaderSettings({
				fontFamily: this.settings.fontFamily,
			});
			this.applyStyles();
			this.debouncedReload();
		};
		prevF.addEventListener("click", () => changeFont(-1));
		nextF.addEventListener("click", () => changeFont(1));

		p.createDiv({ cls: "ldr-sp-sep" });

		// Sliders: SIZE + BRIGHTNESS
		const slidersRow = p.createDiv({ cls: "ldr-sp-sliders-row" });
		this.buildVSlider(slidersRow, {
			key: "fontSize",
			label: "SIZE",
			min: 12,
			max: 32,
			step: 1,
		});
		this.buildVSlider(slidersRow, {
			key: "brightness",
			label: "BRIGHTNESS",
			min: 20,
			max: 100,
			step: 5,
		});
	}

	private makeTopBtn(
		parent: HTMLElement,
		label: string,
		icon: string,
		onClick: () => void,
	) {
		const btn = parent.createDiv({ cls: "ldr-sp-topbtn" });
		btn.innerHTML = icon;
		btn.createSpan({ text: label });
		btn.addEventListener("click", onClick);
	}

	private buildVSlider(
		parent: HTMLElement,
		{
			key,
			label,
			min,
			max,
			step,
		}: {
			key: keyof ReaderSettings;
			label: string;
			min: number;
			max: number;
			step: number;
		},
	) {
		const col = parent.createDiv({ cls: "ldr-sp-vcol" });
		const trackWrap = col.createDiv({ cls: "ldr-sp-vtrack-wrap" });
		const track = trackWrap.createDiv({ cls: "ldr-sp-vtrack" });
		const fill = track.createDiv({ cls: "ldr-sp-vfill" });
		const thumb = track.createDiv({ cls: "ldr-sp-vthumb" });

		const curVal = Number((this.settings as any)[key]);
		const pct = (curVal - min) / (max - min);
		fill.style.height = `${pct * 100}%`;
		thumb.style.bottom = `${pct * 100}%`;

		const valLabel = col.createDiv({
			cls: "ldr-sp-vval",
			text: String(curVal),
		});
		col.createDiv({ cls: "ldr-sp-vlabel", text: label });

		let dragging = false;
		const update = (clientY: number) => {
			const rect = track.getBoundingClientRect();
			const ratio =
				1 -
				Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
			const snapped =
				Math.round((min + ratio * (max - min)) / step) * step;
			const val = parseFloat(
				Math.max(min, Math.min(max, snapped)).toFixed(2),
			);
			(this.settings as any)[key] = val;
			fill.style.height = `${ratio * 100}%`;
			thumb.style.bottom = `${ratio * 100}%`;
			valLabel.textContent = String(val);

			// Feedback visual inmediato
			this.applyStyles();

			// Persistir + repaginar con debounce (fontSize afecta paginación)
			this.plugin.store.updateReaderSettings({ [key]: val } as any);
			if (key === "fontSize") {
				this.debouncedReload();
			}
		};

		track.addEventListener("mousedown", (e) => {
			dragging = true;
			update(e.clientY);
			e.preventDefault();
		});
		document.addEventListener("mousemove", (e) => {
			if (dragging) update(e.clientY);
		});
		document.addEventListener("mouseup", () => {
			dragging = false;
		});
		track.addEventListener(
			"touchstart",
			(e) => {
				update(e.touches[0].clientY);
			},
			{ passive: true },
		);
		track.addEventListener(
			"touchmove",
			(e) => {
				update(e.touches[0].clientY);
			},
			{ passive: true },
		);
	}

	private updateSettingsPct() {
		const pct = Math.round(this.currentPct * 100);
		const el = this.settingsPanel.querySelector(
			".ldr-sp-pct",
		) as HTMLElement;
		const fill = this.settingsPanel.querySelector(
			".ldr-sp-pct-fill",
		) as HTMLElement;
		if (el) el.textContent = `${pct}%`;
		if (fill) fill.style.width = `${pct}%`;
	}

	// ── NAVEGACIÓN ───────────────────────────────────────────────

	private async nextPage() {
		if (this.isFlipping || !this.rendition) return;
		this.flip("next");
		await this.rendition.next();
	}

	private async prevPage() {
		if (this.isFlipping || !this.rendition) return;
		this.flip("prev");
		await this.rendition.prev();
	}

	private flip(dir: "next" | "prev") {
		this.isFlipping = true;
		this.iframeWrap.addClass(`ldr-flip-${dir}`);
		setTimeout(() => {
			this.iframeWrap.removeClass(`ldr-flip-${dir}`);
			this.isFlipping = false;
		}, 280);
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
			{ key: "↑ ↓", desc: "Previous / Next page" },
			{ key: "Click edge", desc: "Navigate pages" },
			{ key: "⚙", desc: "Font, colors, brightness" },
			{ key: "≡", desc: "Table of contents" },
		]);

		this.addControlsSection(panel, "📱  Mobile", [
			{ key: "Tap left ◀", desc: "Previous page" },
			{ key: "Tap right ▶", desc: "Next page" },
			{ key: "Swipe ←→", desc: "Navigate pages" },
			{ key: "⚙", desc: "Font, colors, brightness" },
		]);

		const onEsc = (e: KeyboardEvent) => {
			if (e.key === "Escape") { modal.remove(); document.removeEventListener("keydown", onEsc); }
		};
		document.addEventListener("keydown", onEsc);
	}

	private addControlsSection(
		parent: HTMLElement,
		title: string,
		rows: { key: string; desc: string }[],
	) {
		const section = parent.createDiv({ cls: "ldr-controls-section" });
		section.createDiv({ cls: "ldr-controls-section-title", text: title });
		for (const { key, desc } of rows) {
			const row = section.createDiv({ cls: "ldr-controls-row" });
			row.createEl("kbd", { cls: "ldr-controls-key", text: key });
			row.createSpan({ cls: "ldr-controls-desc", text: desc });
		}
	}

	// ── CHAPTERS ─────────────────────────────────────────────────

	private showChapters() {
		if (!this.epubBook) return;
		const root = this.containerEl.children[1] as HTMLElement;
		root.querySelector(".ldr-chapters-modal")?.remove();

		this.epubBook.loaded.navigation
			.then((nav: any) => {
				const modal = root.createDiv({ cls: "ldr-chapters-modal" });
				const overlay = modal.createDiv({
					cls: "ldr-chapters-overlay",
				});
				overlay.addEventListener("click", () => modal.remove());
				const panel = modal.createDiv({ cls: "ldr-chapters-panel" });
				panel.createDiv({
					cls: "ldr-chapters-title",
					text: "Table of Contents",
				});

				const render = (items: any[], depth = 0) => {
					items.forEach((item: any) => {
						const el = panel.createDiv({ cls: "ldr-chapter-item" });
						el.style.paddingLeft = `${14 + depth * 14}px`;
						el.textContent = item.label?.trim() || "—";
						el.addEventListener("click", async () => {
							modal.remove();
							this.closeSettings();
							await this.rendition?.display(item.href);
						});
						if (item.subitems?.length)
							render(item.subitems, depth + 1);
					});
				};
				render(nav.toc);
			})
			.catch(() => new Notice("Could not load table of contents."));
	}

	// ── FULLSCREEN (CSS-based, como Excalidraw) ──────────────────

	private toggleFullscreen() {
		this.closeSettings();
		if (this.isFullscreen) {
			this.exitFullscreen();
		} else {
			this.enterFullscreen();
		}
	}

	private enterFullscreen() {
		this.isFullscreen = true;
		document.body.classList.add("ldr-fullscreen");
		this.containerEl.classList.add("ldr-fullscreen-leaf");
		// Intentar fullscreen nativo (como Excalidraw) — oculta también la barra del sistema en Android
		if (document.documentElement.requestFullscreen) {
			document.documentElement.requestFullscreen().catch(() => {});
		}
	}

	private exitFullscreen() {
		this.isFullscreen = false;
		document.body.classList.remove("ldr-fullscreen");
		this.containerEl.classList.remove("ldr-fullscreen-leaf");
		if (document.fullscreenElement) {
			document.exitFullscreen().catch(() => {});
		}
	}

	// ── HELPERS ──────────────────────────────────────────────────

	private reloadPage() {
		if (!this.rendition) return;
		const loc = this.rendition.location;
		this.rendition.display(loc?.start?.cfi ?? undefined).catch(() => {});
	}

	private applyBg(root: HTMLElement) {
		const info = COLOR_MAP[this.settings.bgColor];
		if (this.settings.bgColor === "transparent") {
			const txtColor =
				this.settings.transparentTextColor === "white"
					? "#e2dff0"
					: "#1a1a1a";
			root.style.setProperty("background", "transparent", "important");
			root.style.setProperty("color", txtColor, "important");
			root.style.setProperty("--reader-bg", "transparent");
			root.style.setProperty("--reader-fg", txtColor);
		} else {
			root.style.setProperty("background", info.bg, "important");
			root.style.setProperty("color", info.fg, "important");
			root.style.setProperty("--reader-bg", info.bg);
			root.style.setProperty("--reader-fg", info.fg);
		}
	}

	private updateCounter() {
		if (!this.pageCounter) return;
		const pct = Math.round(this.currentPct * 100);
		if (!this.locationsReady) {
			// Always show percentage while locations are loading/regenerating
			this.pageCounter.textContent =
				this.currentPct > 0 ? `${pct}%` : "— / —";
			return;
		}
		const total = this.epubBook?.locations.length() ?? 0;
		const cur = total > 0 ? Math.round(this.currentPct * total) : 0;
		this.pageCounter.textContent =
			total > 0 ? `${cur} / ${total} · ${pct}%` : `${pct}%`;
	}

	private saveProgress() {
		if (!this.book || !this.rendition) return;
		try {
			const loc = this.rendition.location;
			if (!loc?.start?.cfi) return;
			const total = this.epubBook?.locations.length() ?? 0;
			const state: ReadingState = {
				bookId: this.book.id,
				cfi: loc.start.cfi,
				currentPage:
					total > 0 ? Math.round(this.currentPct * total) : 0,
				totalPages: total,
				currentChapterId: loc.start.href ?? "",
				progress: Math.round(this.currentPct * 100),
				lastReadAt: Date.now(),
			};
			this.plugin.store.saveReadingState(state);
		} catch {}
	}

	refresh() {
		this.settings = {
			...DEFAULT_READER_SETTINGS,
			...this.plugin.store.getReaderSettings(),
		};
		const root = this.containerEl.children[1] as HTMLElement;
		this.applyBg(root);
		this.applyStyles();
	}
}
