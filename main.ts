// ============================================================
// main.ts — LDR | Epub Reader
// ============================================================

import { Plugin, WorkspaceLeaf, TFile, Notice } from "obsidian";
import { DataStore } from "./src/core/DataStore";
import { LibraryScanner } from "./src/core/LibraryScanner";
import { LdrSettingTab } from "./src/settings/SettingTab";
import { HomeView, HOME_VIEW_TYPE } from "./src/views/HomeView";
import { ReaderView, READER_VIEW_TYPE } from "./src/views/ReaderView";
import { ImageReaderView, COMIC_READER_VIEW_TYPE } from "./src/views/ImageReaderView";
import { PdfReaderView, PDF_READER_VIEW_TYPE } from "./src/views/PdfReaderView";

export default class LdrEpubReaderPlugin extends Plugin {
	store: DataStore;
	scanner: LibraryScanner;
	private scanDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private layoutReady = false;

	async onload() {
		this.store = new DataStore(this);
		await this.store.load();
		this.scanner = new LibraryScanner(this.app, this.store);

		this.registerView(HOME_VIEW_TYPE, (leaf) => new HomeView(leaf, this));
		this.registerView(
			READER_VIEW_TYPE,
			(leaf) => new ReaderView(leaf, this),
		);
		this.registerView(
			COMIC_READER_VIEW_TYPE,
			(leaf) => new ImageReaderView(leaf, this),
		);
		this.registerView(
			PDF_READER_VIEW_TYPE,
			(leaf) => new PdfReaderView(leaf, this),
		);

		this.addSettingTab(new LdrSettingTab(this.app, this));
		this.registerCommands();
		this.registerVaultEvents();

		this.app.workspace.onLayoutReady(async () => {
			await this.scanner.scan(true);
			this.layoutReady = true;
			this.refreshHomeView();
		});

		this.addRibbonIcon("book-open", "LDR Epub Reader", () =>
			this.openHomeView(),
		);
	}

	async onunload() {
		if (this.scanDebounceTimer) clearTimeout(this.scanDebounceTimer);
	}

	private registerCommands() {
		this.addCommand({
			id: "open-library",
			name: "Open book library",
			callback: () => this.openHomeView(),
		});
		this.addCommand({
			id: "scan-library",
			name: "Scan book folder",
			callback: async () => {
				await this.scanner.scan(false);
				this.refreshHomeView();
			},
		});
		this.addCommand({
			id: "open-current-epub",
			name: "Open active epub in reader",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (file?.extension === "epub") {
					if (!checking) this.openReaderForFile(file);
					return true;
				}
				return false;
			},
		});
	}

	private debouncedScan() {
		if (!this.layoutReady) return;
		if (this.scanDebounceTimer) clearTimeout(this.scanDebounceTimer);
		this.scanDebounceTimer = setTimeout(async () => {
			this.scanDebounceTimer = null;
			await this.scanner.scan(true);
			this.refreshHomeView();
		}, 2000);
	}

	private isLibraryFile(file: TFile): boolean {
		return (
			(file.extension === "epub" || file.extension === "cbz") &&
			file.path.startsWith(this.store.getLibraryFolder())
		);
	}

	private isSupportedFile(file: TFile): boolean {
		return (
			file.extension === "epub" ||
			file.extension === "cbz" ||
			file.extension === "pdf"
		);
	}

	private registerVaultEvents() {
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (file instanceof TFile && (this.isLibraryFile(file) || file.extension === "pdf")) {
					this.debouncedScan();
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile && this.isSupportedFile(file)) {
					this.debouncedScan();
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file) => {
				if (file instanceof TFile && this.isSupportedFile(file)) {
					this.debouncedScan();
				}
			}),
		);
	}

	async openHomeView() {
		const { workspace } = this.app;

		// ¿Ya hay un HomeView? Simplemente revelarlo
		const existing = workspace.getLeavesOfType(HOME_VIEW_TYPE);
		if (existing.length > 0) {
			workspace.revealLeaf(existing[0]);
			return;
		}

		// ¿Hay un reader abierto? Reemplazarlo EN EL MISMO leaf
		const readerLeaves = [
			...workspace.getLeavesOfType(READER_VIEW_TYPE),
			...workspace.getLeavesOfType(COMIC_READER_VIEW_TYPE),
			...workspace.getLeavesOfType(PDF_READER_VIEW_TYPE),
		];
		if (readerLeaves.length > 0) {
			const leaf = readerLeaves[0];
			await leaf.setViewState({ type: HOME_VIEW_TYPE, active: true });
			workspace.revealLeaf(leaf);
			return;
		}

		// Último recurso: usar el leaf activo del panel principal
		const leaf = workspace.getLeaf(false);
		await leaf.setViewState({ type: HOME_VIEW_TYPE, active: true });
		workspace.revealLeaf(leaf);
	}

	async openReaderForFile(file: TFile) {
		const book = this.store
			.getAllBooks()
			.find((b) => b.filePath === file.path);
		if (book) {
			await this.openReaderForBook(book.id);
		} else {
			new Notice("Book not indexed. Scan library first.");
		}
	}

	async openReaderForBook(bookId: string) {
		const book = this.store.getBook(bookId);
		if (!book) {
			new Notice("Book not found.");
			return;
		}

		// Enrutar según tipo de contenido
		if (book.contentType === "cbz") {
			await this.openComicReaderForBook(bookId);
		} else if (book.contentType === "pdf") {
			await this.openPdfReaderForBook(bookId);
		} else {
			await this.openEpubReaderForBook(bookId);
		}
	}

	private async openEpubReaderForBook(bookId: string) {
		const { workspace } = this.app;

		// ¿Ya hay un ReaderView (epub)? Reutilizarlo
		const existing = workspace.getLeavesOfType(READER_VIEW_TYPE);
		if (existing.length > 0) {
			const leaf = existing[0];
			workspace.revealLeaf(leaf);
			await (leaf.view as ReaderView).loadBook(bookId);
			return;
		}

		// ¿Hay una vista de lectura de cómics? Reemplazarla
		const comicLeaves = workspace.getLeavesOfType(COMIC_READER_VIEW_TYPE);
		if (comicLeaves.length > 0) {
			const leaf = comicLeaves[0];
			await leaf.setViewState({ type: READER_VIEW_TYPE, active: true });
			workspace.revealLeaf(leaf);
			await (leaf.view as ReaderView).loadBook(bookId);
			return;
		}

		// ¿Hay un HomeView? Reemplazarlo EN EL MISMO leaf
		const homeLeaves = workspace.getLeavesOfType(HOME_VIEW_TYPE);
		if (homeLeaves.length > 0) {
			const leaf = homeLeaves[0];
			await leaf.setViewState({ type: READER_VIEW_TYPE, active: true });
			workspace.revealLeaf(leaf);
			await (leaf.view as ReaderView).loadBook(bookId);
			return;
		}

		// Último recurso
		const leaf = workspace.getLeaf(false);
		await leaf.setViewState({ type: READER_VIEW_TYPE, active: true });
		workspace.revealLeaf(leaf);
		await (leaf.view as ReaderView).loadBook(bookId);
	}

	private async openComicReaderForBook(bookId: string) {
		const { workspace } = this.app;

		// ¿Ya hay un ImageReaderView? Reutilizarlo
		const existing = workspace.getLeavesOfType(COMIC_READER_VIEW_TYPE);
		if (existing.length > 0) {
			const leaf = existing[0];
			workspace.revealLeaf(leaf);
			await (leaf.view as ImageReaderView).loadBook(bookId);
			return;
		}

		// ¿Hay una vista de lectura epub? Reemplazarla
		const epubLeaves = workspace.getLeavesOfType(READER_VIEW_TYPE);
		if (epubLeaves.length > 0) {
			const leaf = epubLeaves[0];
			await leaf.setViewState({ type: COMIC_READER_VIEW_TYPE, active: true });
			workspace.revealLeaf(leaf);
			await (leaf.view as ImageReaderView).loadBook(bookId);
			return;
		}

		// ¿Hay un HomeView? Reemplazarlo EN EL MISMO leaf
		const homeLeaves = workspace.getLeavesOfType(HOME_VIEW_TYPE);
		if (homeLeaves.length > 0) {
			const leaf = homeLeaves[0];
			await leaf.setViewState({ type: COMIC_READER_VIEW_TYPE, active: true });
			workspace.revealLeaf(leaf);
			await (leaf.view as ImageReaderView).loadBook(bookId);
			return;
		}

		// Último recurso
		const leaf = workspace.getLeaf(false);
		await leaf.setViewState({ type: COMIC_READER_VIEW_TYPE, active: true });
		workspace.revealLeaf(leaf);
		await (leaf.view as ImageReaderView).loadBook(bookId);
	}

	private async openPdfReaderForBook(bookId: string) {
		const { workspace } = this.app;

		const existing = workspace.getLeavesOfType(PDF_READER_VIEW_TYPE);
		if (existing.length > 0) {
			const leaf = existing[0];
			workspace.revealLeaf(leaf);
			await (leaf.view as PdfReaderView).loadBook(bookId);
			return;
		}

		// Reemplazar cualquier lector abierto
		const otherLeaves = [
			...workspace.getLeavesOfType(READER_VIEW_TYPE),
			...workspace.getLeavesOfType(COMIC_READER_VIEW_TYPE),
			...workspace.getLeavesOfType(HOME_VIEW_TYPE),
		];
		if (otherLeaves.length > 0) {
			const leaf = otherLeaves[0];
			await leaf.setViewState({ type: PDF_READER_VIEW_TYPE, active: true });
			workspace.revealLeaf(leaf);
			await (leaf.view as PdfReaderView).loadBook(bookId);
			return;
		}

		const leaf = workspace.getLeaf(false);
		await leaf.setViewState({ type: PDF_READER_VIEW_TYPE, active: true });
		workspace.revealLeaf(leaf);
		await (leaf.view as PdfReaderView).loadBook(bookId);
	}

	refreshHomeView() {
		this.app.workspace.getLeavesOfType(HOME_VIEW_TYPE).forEach((leaf) => {
			(leaf.view as HomeView)?.refresh?.();
		});
	}
}
