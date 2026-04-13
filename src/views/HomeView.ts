// ============================================================
// src/views/HomeView.ts
// ============================================================

import { ItemView, WorkspaceLeaf, Menu } from "obsidian";
import type LdrEpubReaderPlugin from "../../main";
import { Book } from "../models";
import { sortBooks, SortKey } from "../utils/helpers";
import { CategoryModal } from "./CategoryModal";
import { normalizeSeriesName } from "../utils/seriesDetector";

export const HOME_VIEW_TYPE = "ldr-epub-home";

type Tab = "library" | "comics" | "pdfs" | "bookshelf";

interface SeriesGroup {
	normalizedName: string;
	displayName: string;
	volumes: Book[]; // sorted by volume number
}

export class HomeView extends ItemView {
	private plugin: LdrEpubReaderPlugin;
	private currentTab: Tab = "library";
	private editMode = false;
	private sortKey: SortKey = "dateAdded";
	private expandedCategory: string | null = null;
	private expandedSeries: string | null = null; // normalized series name

	private contentArea: HTMLElement;
	private tabBar: HTMLElement;
	private resizeObserver: ResizeObserver | null = null;
	private gridEl: HTMLElement | null = null;

	// Search state
	private searchQuery = "";
	private searchActive = false;
	private searchInputEl: HTMLInputElement | null = null;
	private searchBarEl: HTMLElement | null = null;
	private searchDebounce: ReturnType<typeof setTimeout> | null = null;

	// Detail modal state
	private detailModalEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: LdrEpubReaderPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return HOME_VIEW_TYPE;
	}
	getDisplayText() {
		return "LDR | Reader";
	}
	getIcon() {
		return "book-open";
	}

	async onOpen() {
		const root = this.containerEl.children[1] as HTMLElement;
		root.empty();
		root.addClass("ldr-home");
		this.buildHeader(root);
		this.searchBarEl = root.createDiv({ cls: "ldr-search-bar" });
		this.buildSearchBar();
		this.contentArea = root.createDiv({ cls: "ldr-content" });
		this.render();
	}

	async onClose() {}

	// ── RESIZE OBSERVER ──────────────────────────────────────────

	private setupResizeObserver() {
		this.resizeObserver = new ResizeObserver(() => {
			this.updateGridCols();
		});
		this.resizeObserver.observe(this.containerEl);
	}

	private updateGridCols() {
		if (!this.gridEl) return;
		const w = this.contentArea.clientWidth;
		const cols = w < 320 ? 1 : w < 600 ? 2 : w < 900 ? 3 : w < 1200 ? 4 : 5;
		this.gridEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
	}

	// ── HEADER ───────────────────────────────────────────────────

	private buildHeader(root: HTMLElement) {
		const header = root.createDiv({ cls: "ldr-header" });

		// Edit toggle
		const editToggle = header.createDiv({ cls: "ldr-edit-toggle" });
		editToggle.createDiv({ cls: "ldr-edit-dot" });
		editToggle.createSpan({ text: "Edit", cls: "ldr-edit-label" });
		editToggle.addEventListener("click", () => {
			this.editMode = !this.editMode;
			editToggle.toggleClass("is-active", this.editMode);
			this.render();
		});

		// Tabs (centro)
		this.tabBar = header.createDiv({ cls: "ldr-tabs" });
		this.buildTabs();

		// Right actions
		const actions = header.createDiv({ cls: "ldr-header-actions" });

		// Sort
		const sortBtn = actions.createDiv({
			cls: "ldr-icon-btn",
			attr: { title: "Sort" },
		});
		sortBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="9" y1="18" x2="15" y2="18"/></svg>`;
		sortBtn.addEventListener("click", (e) => this.showSortMenu(e));

		// Search
		const searchBtn = actions.createDiv({
			cls: "ldr-icon-btn",
			attr: { title: "Search" },
		});
		searchBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>`;
		searchBtn.addEventListener("click", () => this.toggleSearch());
	}

	private buildTabs() {
		this.tabBar.empty();
		const tabs: { key: Tab; label: string }[] = [
			{ key: "library", label: "Library" },
			{ key: "comics", label: "Comics" },
			{ key: "pdfs", label: "PDFs" },
			{ key: "bookshelf", label: "Bookshelf" },
		];
		tabs.forEach(({ key, label }) => {
			const tab = this.tabBar.createSpan({
				cls: `ldr-tab${this.currentTab === key ? " is-active" : ""}`,
				text: label,
			});
			tab.addEventListener("click", () => {
				this.currentTab = key;
				this.expandedCategory = null;
				this.expandedSeries = null;
				this.buildTabs();
				this.render();
			});
		});
	}

	// ── SEARCH ───────────────────────────────────────────────────

	private buildSearchBar() {
		if (!this.searchBarEl) return;
		this.searchBarEl.empty();

		const wrap = this.searchBarEl.createDiv({ cls: "ldr-search-wrap" });

		wrap.createDiv({ cls: "ldr-search-icon" }).innerHTML =
			`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>`;

		this.searchInputEl = wrap.createEl("input", {
			cls: "ldr-search-input",
			attr: {
				type: "text",
				placeholder: "Search by title, author, genre, series...",
			},
		});
		this.searchInputEl.value = this.searchQuery;

		this.searchInputEl.addEventListener("input", (e) => {
			this.searchQuery = (e.target as HTMLInputElement).value;
			if (this.searchDebounce) clearTimeout(this.searchDebounce);
			this.searchDebounce = setTimeout(() => {
				this.searchDebounce = null;
				this.render();
			}, 200);
		});

		this.searchInputEl.addEventListener("keydown", (e) => {
			if (e.key === "Escape") this.toggleSearch();
		});

		if (this.searchQuery) {
			const clear = wrap.createDiv({ cls: "ldr-search-clear" });
			clear.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
			clear.addEventListener("click", () => {
				this.searchQuery = "";
				this.buildSearchBar();
				this.render();
				this.searchInputEl?.focus();
			});
		}
	}

	private toggleSearch() {
		this.searchActive = !this.searchActive;
		this.searchBarEl?.toggleClass("is-active", this.searchActive);

		if (this.searchActive) {
			setTimeout(() => this.searchInputEl?.focus(), 150);
		} else {
			this.searchQuery = "";
			this.buildSearchBar();
			this.render();
		}
	}

	private filterBooks(books: Book[]): Book[] {
		const q = this.searchQuery.toLowerCase().trim();
		if (!q) return books;

		const cats = this.plugin.store.getCategories();

		return books.filter((book) => {
			const fields = [
				book.title,
				book.author,
				book.genre,
				book.synopsis,
				book.publishDate,
				book.language,
				book.publisher,
				book.isbn,
				// CBZ-specific fields
				book.series ?? "",
				book.year ?? "",
				book.comicMetadata?.summary ?? "",
				...book.categories.map(
					(cid) => cats.find((c) => c.id === cid)?.name ?? "",
				),
			];
			return fields.some((f) => (f ?? "").toLowerCase().includes(q));
		});
	}

	// ── RENDER ───────────────────────────────────────────────────

	private render() {
		this.gridEl = null;
		this.contentArea.empty();

		if (this.currentTab === "library") {
			this.renderLibrary();
		} else if (this.currentTab === "comics") {
			if (this.expandedSeries !== null) {
				this.renderSeriesExpanded(this.expandedSeries);
			} else {
				this.renderComicsTab();
			}
		} else if (this.currentTab === "pdfs") {
			this.renderPdfsTab();
		} else {
			this.expandedCategory !== null
				? this.renderCategoryExpanded(this.expandedCategory)
				: this.renderBookshelf();
		}
	}

	// ── LIBRARY (EPUB only) ───────────────────────────────────────

	private renderLibrary() {
		const epubBooks = this.plugin.store
			.getAllBooks()
			.filter((b) => !b.contentType || b.contentType === "epub");

		if (!this.searchQuery.trim()) {
			// Recently read: prefer EPUB, but show any if no EPUB was read
			const lastRead = this.plugin.store.getLastReadBook();
			if (lastRead && (!lastRead.contentType || lastRead.contentType === "epub")) {
				this.renderRecentlyRead(lastRead);
			}
		}

		this.renderBooksGrid(epubBooks, "Books");
	}

	// ── RECENTLY READ ────────────────────────────────────────────

	private renderRecentlyRead(book: Book) {
		const section = this.contentArea.createDiv({
			cls: "ldr-section ldr-section--recent",
		});

		const card = section.createDiv({ cls: "ldr-recent-card" });
		const coverWrap = card.createDiv({ cls: "ldr-recent-cover" });
		this.buildCover(coverWrap, book, "recent");

		const info = card.createDiv({ cls: "ldr-recent-info" });
		info.createDiv({ cls: "ldr-recent-label", text: "Recently read" });
		info.createDiv({ cls: "ldr-recent-title", text: book.title });
		info.createDiv({ cls: "ldr-recent-author", text: book.author });

		const state = this.plugin.store.getReadingState(book.id);
		const progress = this.computeProgress(book, state);

		const bottomRow = info.createDiv({ cls: "ldr-recent-bottom" });
		bottomRow.createSpan({
			cls: "ldr-recent-pct",
			text: `${Math.round(progress)}%`,
		});

		const pw = bottomRow.createDiv({ cls: "ldr-progress-bar" });
		pw.createDiv({
			cls: "ldr-progress-fill",
			attr: { style: `width:${progress}%` },
		});

		const btn = bottomRow.createDiv({ cls: "ldr-continue-btn" });
		btn.innerHTML = `continue <span class="ldr-continue-arrow">→</span>`;

		card.addEventListener("click", () =>
			this.plugin.openReaderForBook(book.id),
		);
	}

	// ── COMICS TAB ────────────────────────────────────────────────

	private renderComicsTab() {
		const allCbz = this.plugin.store
			.getAllBooks()
			.filter((b) => b.contentType === "cbz");

		const filtered = this.filterBooks(allCbz);

		if (filtered.length === 0) {
			const empty = this.contentArea.createDiv({ cls: "ldr-empty" });
			empty.createDiv({ cls: "ldr-empty-icon", text: "📖" });
			empty.createDiv({
				cls: "ldr-empty-title",
				text: this.searchQuery ? "No results" : "No comics yet",
			});
			empty.createDiv({
				cls: "ldr-empty-desc",
				text: this.searchQuery
					? "Try a different search term"
					: `Add .cbz files to the "${this.plugin.store.getLibraryFolder()}" folder`,
			});
			return;
		}

		const { seriesGroups, standalone } = this.groupComicsBySeries(filtered);

		// ── Series groups ─────────────────────────────────────────
		if (seriesGroups.length > 0) {
			const section = this.contentArea.createDiv({ cls: "ldr-section" });
			const hdr = section.createDiv({ cls: "ldr-section-hdr" });
			hdr.createDiv({ cls: "ldr-section-label", text: "Series" });

			if (this.searchQuery.trim()) {
				hdr.createDiv({
					cls: "ldr-search-count",
					text: `${seriesGroups.length} series`,
				});
			}

			const grid = section.createDiv({ cls: "ldr-series-grid" });
			seriesGroups.forEach((group) =>
				this.renderSeriesCard(grid, group),
			);
		}

		// ── Standalone comics ─────────────────────────────────────
		if (standalone.length > 0) {
			const sorted = sortBooks(standalone, this.sortKey);
			const section = this.contentArea.createDiv({ cls: "ldr-section" });
			const hdr = section.createDiv({ cls: "ldr-section-hdr" });
			hdr.createDiv({
				cls: "ldr-section-label",
				text: seriesGroups.length > 0 ? "Singles" : "Comics",
			});

			if (this.searchQuery.trim() && seriesGroups.length === 0) {
				hdr.createDiv({
					cls: "ldr-search-count",
					text: `${sorted.length} result${sorted.length !== 1 ? "s" : ""}`,
				});
			}

			this.gridEl = section.createDiv({ cls: "ldr-grid" });
			sorted.forEach((book) =>
				this.renderBookCard(this.gridEl!, book, false),
			);
		}
	}

	private groupComicsBySeries(books: Book[]): {
		seriesGroups: SeriesGroup[];
		standalone: Book[];
	} {
		const groupMap = new Map<string, SeriesGroup>();
		const standalone: Book[] = [];

		for (const book of books) {
			const rawSeries = book.series ?? "";
			if (!rawSeries.trim()) {
				standalone.push(book);
				continue;
			}

			const key = normalizeSeriesName(rawSeries);
			if (!groupMap.has(key)) {
				groupMap.set(key, {
					normalizedName: key,
					displayName: rawSeries,
					volumes: [],
				});
			}
			groupMap.get(key)!.volumes.push(book);
		}

		// Sort volumes within each group by volume number (natural sort)
		for (const group of groupMap.values()) {
			group.volumes.sort((a, b) =>
				(a.volume ?? "").localeCompare(b.volume ?? "", undefined, {
					numeric: true,
					sensitivity: "base",
				}),
			);
		}

		// Sort series groups alphabetically
		const seriesGroups = Array.from(groupMap.values()).sort((a, b) =>
			a.displayName.localeCompare(b.displayName),
		);

		return { seriesGroups, standalone };
	}

	private renderSeriesCard(parent: HTMLElement, group: SeriesGroup) {
		const card = parent.createDiv({ cls: "ldr-series-card" });

		// Cover: first volume
		const coverWrap = card.createDiv({ cls: "ldr-series-cover-wrap" });
		this.buildCover(coverWrap, group.volumes[0], "grid");

		// Badge de volúmenes
		const badge = coverWrap.createDiv({
			cls: "ldr-series-vol-badge",
			text: `${group.volumes.length} vol${group.volumes.length !== 1 ? "s" : ""}`,
		});
		badge.setAttribute("aria-label", `${group.volumes.length} volumes`);

		// Info
		const info = card.createDiv({ cls: "ldr-series-info" });
		info.createDiv({ cls: "ldr-series-name", text: group.displayName });

		// Progreso del volumen más reciente
		const lastReadVol = this.getLastReadVolume(group.volumes);
		if (lastReadVol) {
			const state = this.plugin.store.getReadingState(lastReadVol.id);
			const progress = this.computeProgress(lastReadVol, state);
			if (progress > 0) {
				const pb = info.createDiv({
					cls: "ldr-progress-bar ldr-progress-bar--card",
				});
				pb.createDiv({
					cls: "ldr-progress-fill",
					attr: { style: `width:${progress}%` },
				});
			}
		}

		card.addEventListener("click", () => {
			if (!this.editMode) {
				this.expandedSeries = group.normalizedName;
				this.render();
			}
		});

		if (this.editMode) {
			const overlay = coverWrap.createDiv({ cls: "ldr-edit-overlay" });
			const catBtn = overlay.createDiv({ cls: "ldr-edit-action" });
			catBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
			catBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				// En edit mode, categorizar el primer volumen de la serie
				this.showCategoryMenu(e, group.volumes[0]);
			});
		}
	}

	private renderSeriesExpanded(normalizedSeriesName: string) {
		const allCbz = this.plugin.store
			.getAllBooks()
			.filter((b) => b.contentType === "cbz");
		const volumes = allCbz
			.filter(
				(b) =>
					normalizeSeriesName(b.series ?? "") === normalizedSeriesName,
			)
			.sort((a, b) =>
				(a.volume ?? "").localeCompare(b.volume ?? "", undefined, {
					numeric: true,
					sensitivity: "base",
				}),
			);

		const seriesName = volumes[0]?.series ?? "Series";

		// Header con botón de volver
		const catHeader = this.contentArea.createDiv({ cls: "ldr-cat-header" });
		const back = catHeader.createDiv({ cls: "ldr-back-btn" });
		back.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>`;
		back.addEventListener("click", () => {
			this.expandedSeries = null;
			this.render();
		});
		catHeader.createDiv({ cls: "ldr-cat-title", text: seriesName });

		if (volumes.length === 0) {
			const empty = this.contentArea.createDiv({ cls: "ldr-empty" });
			empty.createDiv({ cls: "ldr-empty-title", text: "No volumes found" });
			return;
		}

		this.gridEl = this.contentArea.createDiv({ cls: "ldr-grid" });
		volumes.forEach((book) =>
			this.renderBookCard(this.gridEl!, book, false),
		);
	}

	private getLastReadVolume(volumes: Book[]): Book | null {
		let lastBook: Book | null = null;
		let lastTime = 0;
		for (const book of volumes) {
			const state = this.plugin.store.getReadingState(book.id);
			if (state && state.lastReadAt > lastTime) {
				lastTime = state.lastReadAt;
				lastBook = book;
			}
		}
		return lastBook;
	}

	private computeProgress(
		book: Book,
		state: ReturnType<typeof this.plugin.store.getReadingState>,
	): number {
		if (!state) return 0;
		if (book.contentType === "cbz" && book.pageCount) {
			return Math.min(
				100,
				Math.round(((state.pageIndex ?? 0) / book.pageCount) * 100),
			);
		}
		return state.progress ?? 0;
	}

	// ── PDFS TAB ──────────────────────────────────────────────────

	private renderPdfsTab() {
		const allPdfs = this.plugin.store
			.getAllBooks()
			.filter((b) => b.contentType === "pdf");

		const filtered = this.filterBooks(allPdfs);

		if (filtered.length === 0) {
			const empty = this.contentArea.createDiv({ cls: "ldr-empty" });
			empty.createDiv({ cls: "ldr-empty-icon", text: "📄" });
			empty.createDiv({
				cls: "ldr-empty-title",
				text: this.searchQuery ? "No results" : "No PDFs found",
			});
			empty.createDiv({
				cls: "ldr-empty-desc",
				text: this.searchQuery
					? "Try a different search term"
					: "Add .pdf files anywhere in your vault",
			});
			return;
		}

		const section = this.contentArea.createDiv({ cls: "ldr-section" });
		const hdr = section.createDiv({ cls: "ldr-section-hdr" });
		hdr.createDiv({ cls: "ldr-section-label", text: "PDFs" });

		if (this.searchQuery.trim()) {
			hdr.createDiv({
				cls: "ldr-search-count",
				text: `${filtered.length} result${filtered.length !== 1 ? "s" : ""}`,
			});
		}

		const sorted = sortBooks(filtered, this.sortKey);
		this.gridEl = section.createDiv({ cls: "ldr-grid" });
		sorted.forEach((book) => this.renderBookCard(this.gridEl!, book, false));
	}

	// ── BOOKS GRID ────────────────────────────────────────────────

	private renderBooksGrid(books: Book[], label = "Books") {
		const section = this.contentArea.createDiv({ cls: "ldr-section" });
		const hdr = section.createDiv({ cls: "ldr-section-hdr" });
		hdr.createDiv({ cls: "ldr-section-label", text: label });

		const filtered = this.filterBooks(books);
		const sorted = sortBooks(filtered, this.sortKey);

		if (this.searchQuery.trim()) {
			hdr.createDiv({
				cls: "ldr-search-count",
				text: `${sorted.length} result${sorted.length !== 1 ? "s" : ""}`,
			});
		}

		if (sorted.length === 0) {
			const empty = section.createDiv({ cls: "ldr-empty" });
			empty.createDiv({
				cls: "ldr-empty-icon",
				text: this.searchQuery ? "🔍" : "📚",
			});
			empty.createDiv({
				cls: "ldr-empty-title",
				text: this.searchQuery ? "No results" : "No books yet",
			});
			empty.createDiv({
				cls: "ldr-empty-desc",
				text: this.searchQuery
					? "Try a different search term"
					: `Add .epub files to the "${this.plugin.store.getLibraryFolder()}" folder`,
			});
			return;
		}

		this.gridEl = section.createDiv({ cls: "ldr-grid" });
		sorted.forEach((book) => this.renderBookCard(this.gridEl!, book, false));
	}

	private renderBookCard(
		parent: HTMLElement,
		book: Book,
		showTypeBadge: boolean,
	) {
		const card = parent.createDiv({ cls: "ldr-book-card" });
		const coverWrap = card.createDiv({ cls: "ldr-book-cover-wrap" });
		this.buildCover(coverWrap, book, "grid");

		// Badge de tipo (solo visible en Bookshelf donde conviven ambos tipos)
		if (showTypeBadge && book.contentType) {
			coverWrap.createDiv({
				cls: `ldr-type-badge ldr-type-badge--${book.contentType}`,
				text: book.contentType.toUpperCase(),
			});
		}

		if (this.editMode) {
			const overlay = coverWrap.createDiv({ cls: "ldr-edit-overlay" });

			const catBtn = overlay.createDiv({ cls: "ldr-edit-action" });
			catBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`;
			catBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.showCategoryMenu(e, book);
			});
		}

		const info = card.createDiv({ cls: "ldr-book-info" });
		info.createDiv({ cls: "ldr-book-title", text: book.title });

		// Para CBZ en vista expandida de serie, mostrar número de volumen en lugar de autor
		const subtitle =
			book.contentType === "cbz" && book.volume
				? `Vol. ${book.volume}`
				: book.author;
		info.createDiv({ cls: "ldr-book-author", text: subtitle });

		const state = this.plugin.store.getReadingState(book.id);
		const progress = this.computeProgress(book, state);
		if (state && progress > 0) {
			const pb = info.createDiv({
				cls: "ldr-progress-bar ldr-progress-bar--card",
			});
			pb.createDiv({
				cls: "ldr-progress-fill",
				attr: { style: `width:${progress}%` },
			});
		}

		if (!this.editMode) {
			card.addEventListener("click", () =>
				this.showBookDetailModal(book),
			);
		}
	}

	// ── BOOKSHELF ────────────────────────────────────────────────

	private renderBookshelf() {
		const cats = this.plugin.store.getCategories();
		const allBooks = this.plugin.store.getAllBooks();

		if (this.editMode) {
			const addBtn = this.contentArea.createDiv({
				cls: "ldr-add-cat-btn",
			});
			addBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> <span>New category</span>`;
			addBtn.addEventListener("click", () => this.promptNewCategory());
		}

		const grid = this.contentArea.createDiv({ cls: "ldr-cat-grid" });

		cats.forEach((cat) => {
			const books = allBooks.filter((b) => b.categories.includes(cat.id));
			const catCard = grid.createDiv({ cls: "ldr-cat-card" });
			this.buildCategoryPreview(catCard, books);
			catCard.createDiv({ cls: "ldr-cat-name", text: cat.name });
			catCard.createDiv({
				cls: "ldr-cat-count",
				text: `${books.length} book${books.length !== 1 ? "s" : ""}`,
			});
			catCard.addEventListener("click", () => {
				this.expandedCategory = cat.id;
				this.render();
			});

			if (this.editMode) {
				const del = catCard.createDiv({ cls: "ldr-cat-delete" });
				del.innerHTML = `<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
				del.addEventListener("click", async (e) => {
					e.stopPropagation();
					if (confirm(`Delete category "${cat.name}"?`)) {
						await this.plugin.store.removeCategory(cat.id);
						this.render();
					}
				});
			}
		});

		// Finished books (todos los tipos)
		const finished = allBooks.filter((b) => b.isFinished);
		const finCard = grid.createDiv({
			cls: "ldr-cat-card ldr-cat-card--finished",
		});
		this.buildCategoryPreview(finCard, finished);
		finCard.createDiv({ cls: "ldr-cat-name", text: "Finished" });
		finCard.createDiv({
			cls: "ldr-cat-count",
			text: `${finished.length} book${finished.length !== 1 ? "s" : ""}`,
		});
		finCard.addEventListener("click", () => {
			this.expandedCategory = "__finished__";
			this.render();
		});

		if (cats.length === 0 && !this.editMode) {
			const hint = this.contentArea.createDiv({ cls: "ldr-empty" });
			hint.createDiv({ cls: "ldr-empty-title", text: "No categories" });
			hint.createDiv({
				cls: "ldr-empty-desc",
				text: "Enable edit mode to create categories.",
			});
		}
	}

	// ── CATEGORY EXPANDED ────────────────────────────────────────

	private renderCategoryExpanded(categoryId: string) {
		const allBooks = this.plugin.store.getAllBooks();
		let title = "Finished";
		let books: Book[];

		if (categoryId === "__finished__") {
			books = allBooks.filter((b) => b.isFinished);
		} else {
			const cat = this.plugin.store
				.getCategories()
				.find((c) => c.id === categoryId);
			title = cat?.name ?? "Category";
			books = allBooks.filter((b) => b.categories.includes(categoryId));
		}

		const catHeader = this.contentArea.createDiv({ cls: "ldr-cat-header" });
		const back = catHeader.createDiv({ cls: "ldr-back-btn" });
		back.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>`;
		back.addEventListener("click", () => {
			this.expandedCategory = null;
			this.render();
		});
		catHeader.createDiv({ cls: "ldr-cat-title", text: title });

		if (books.length === 0) {
			const empty = this.contentArea.createDiv({ cls: "ldr-empty" });
			empty.createDiv({ cls: "ldr-empty-title", text: "No books" });
			empty.createDiv({
				cls: "ldr-empty-desc",
				text: "Assign books using edit mode.",
			});
			return;
		}

		// En Bookshelf expandido conviven EPUB y CBZ → mostrar badge de tipo
		this.gridEl = this.contentArea.createDiv({ cls: "ldr-grid" });
		books.forEach((book) => this.renderBookCard(this.gridEl!, book, true));
	}

	// ── BOOK DETAIL MODAL ────────────────────────────────────────

	private showBookDetailModal(book: Book) {
		this.detailModalEl?.remove();

		const root = this.containerEl.children[1] as HTMLElement;
		this.detailModalEl = root.createDiv({ cls: "ldr-detail-modal" });

		const overlay = this.detailModalEl.createDiv({
			cls: "ldr-detail-overlay",
		});
		overlay.addEventListener("click", () => this.closeBookDetailModal());

		const panel = this.detailModalEl.createDiv({
			cls: "ldr-detail-panel",
		});

		const closeBtn = panel.createDiv({ cls: "ldr-detail-close" });
		closeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
		closeBtn.addEventListener("click", () => this.closeBookDetailModal());

		const content = panel.createDiv({ cls: "ldr-detail-content" });

		// Cover
		const coverSection = content.createDiv({
			cls: "ldr-detail-cover-section",
		});
		const coverWrap = coverSection.createDiv({
			cls: "ldr-detail-cover-wrap",
		});
		this.buildCover(coverWrap, book, "grid");

		const state = this.plugin.store.getReadingState(book.id);
		const progress = this.computeProgress(book, state);
		if (state && progress > 0) {
			coverSection.createDiv({
				cls: "ldr-detail-progress-badge",
				text: `${Math.round(progress)}%`,
			});
		}

		// Metadata
		const metaSection = content.createDiv({
			cls: "ldr-detail-meta-section",
		});
		metaSection.createDiv({
			cls: "ldr-detail-title",
			text: book.title,
		});
		metaSection.createDiv({
			cls: "ldr-detail-author",
			text: book.author,
		});

		const metaGrid = metaSection.createDiv({
			cls: "ldr-detail-meta-grid",
		});

		const addRow = (label: string, value: string) => {
			if (!value || !value.trim()) return;
			const row = metaGrid.createDiv({ cls: "ldr-detail-meta-row" });
			row.createDiv({ cls: "ldr-detail-meta-label", text: label });
			row.createDiv({ cls: "ldr-detail-meta-value", text: value });
		};

		if (book.contentType === "cbz") {
			// Metadatos específicos de cómic
			addRow("Series", book.series ?? "");
			addRow("Volume", book.volume ?? "");
			addRow("Genre", book.genre);
			addRow("Publisher", book.publisher);
			addRow("Year", book.year ?? book.publishDate);
			if (book.pageCount) {
				addRow("Pages", String(book.pageCount));
			}
		} else {
			// Metadatos EPUB (comportamiento original)
			addRow("Genre", book.genre);
			addRow("Language", book.language);
			addRow("Publisher", book.publisher);
			addRow("Published", book.publishDate);
			addRow("ISBN", book.isbn);
		}

		if (book.categories.length > 0) {
			const cats = this.plugin.store.getCategories();
			const catNames = book.categories
				.map((cid) => cats.find((c) => c.id === cid)?.name)
				.filter(Boolean)
				.join(", ");
			if (catNames) addRow("Categories", catNames);
		}

		if (book.synopsis?.trim()) {
			metaSection.createDiv({ cls: "ldr-detail-sep" });
			metaSection.createDiv({
				cls: "ldr-detail-meta-label",
				text: book.contentType === "cbz" ? "Summary" : "Synopsis",
			});
			metaSection.createDiv({
				cls: "ldr-detail-synopsis",
				text: book.synopsis,
			});
		}

		// Progreso de lectura
		if (state) {
			metaSection.createDiv({ cls: "ldr-detail-sep" });
			const progInfo = metaSection.createDiv({
				cls: "ldr-detail-progress-info",
			});
			progInfo.createDiv({
				cls: "ldr-detail-meta-label",
				text: "Reading progress",
			});
			const bar = progInfo.createDiv({ cls: "ldr-progress-bar" });
			bar.createDiv({
				cls: "ldr-progress-fill",
				attr: { style: `width:${progress}%` },
			});

			let progressText: string;
			if (book.contentType === "cbz") {
				const pageIdx = state.pageIndex ?? 0;
				const total = book.pageCount ?? 0;
				progressText = total
					? `Page ${pageIdx + 1} of ${total} · ${Math.round(progress)}%`
					: `Page ${pageIdx + 1}`;
			} else {
				progressText = `Page ${state.currentPage} of ${state.totalPages} · ${Math.round(state.progress)}%`;
			}
			progInfo.createDiv({
				cls: "ldr-detail-progress-text",
				text: progressText,
			});
		}

		// Acciones
		const actions = panel.createDiv({ cls: "ldr-detail-actions" });

		const readBtn = actions.createDiv({
			cls: "ldr-detail-btn ldr-detail-btn--primary",
		});
		readBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg> <span>${state && progress > 0 ? "Continue reading" : "Read"}</span>`;
		readBtn.addEventListener("click", () => {
			this.closeBookDetailModal();
			this.plugin.openReaderForBook(book.id);
		});

		if (book.contentType === "cbz") {
			const editBtn = actions.createDiv({
				cls: "ldr-detail-btn ldr-detail-btn--secondary",
			});
			editBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> <span>Edit metadata</span>`;
			editBtn.addEventListener("click", () =>
				this.showMetadataEditor(book, content, actions),
			);
		}

		const backBtn = actions.createDiv({
			cls: "ldr-detail-btn ldr-detail-btn--secondary",
		});
		backBtn.innerHTML = `<span>Back</span>`;
		backBtn.addEventListener("click", () => this.closeBookDetailModal());

		const onEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				this.closeBookDetailModal();
				document.removeEventListener("keydown", onEscape);
			}
		};
		document.addEventListener("keydown", onEscape);

		requestAnimationFrame(() => {
			this.detailModalEl?.addClass("is-visible");
		});
	}

	private showMetadataEditor(
		book: Book,
		content: HTMLElement,
		actions: HTMLElement,
	) {
		content.empty();
		actions.empty();

		// Campos editables
		const form = content.createDiv({ cls: "ldr-meta-editor" });
		const vals: Record<string, string> = {
			title: book.title,
			author: book.author,
			series: book.series ?? "",
			volume: book.volume ?? "",
			year: book.year ?? "",
			genre: book.genre ?? "",
			publisher: book.publisher ?? "",
			synopsis: book.synopsis ?? "",
		};

		const addField = (label: string, key: string, multiline = false) => {
			const row = form.createDiv({ cls: "ldr-meta-editor-row" });
			row.createDiv({ cls: "ldr-meta-editor-label", text: label });
			if (multiline) {
				const ta = row.createEl("textarea", {
					cls: "ldr-meta-editor-input ldr-meta-editor-textarea",
				});
				ta.value = vals[key];
				ta.addEventListener("input", () => {
					vals[key] = ta.value;
				});
			} else {
				const inp = row.createEl("input", {
					cls: "ldr-meta-editor-input",
					attr: { type: "text", value: vals[key] },
				});
				inp.addEventListener("input", () => {
					vals[key] = inp.value;
				});
			}
		};

		addField("Title", "title");
		addField("Author / Writer", "author");
		addField("Series", "series");
		addField("Volume", "volume");
		addField("Year", "year");
		addField("Genre", "genre");
		addField("Publisher", "publisher");
		addField("Summary", "synopsis", true);

		// Botón guardar
		const saveBtn = actions.createDiv({
			cls: "ldr-detail-btn ldr-detail-btn--primary",
		});
		saveBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> <span>Save</span>`;
		saveBtn.addEventListener("click", async () => {
			const updatedMeta = book.comicMetadata
				? {
						...book.comicMetadata,
						title: vals.title,
						writer: vals.author,
						series: vals.series,
						number: vals.volume,
						year: vals.year,
						genre: vals.genre,
						publisher: vals.publisher,
						summary: vals.synopsis,
						isManuallyEdited: true,
					}
				: null;

			const updated: Book = {
				...book,
				title: vals.title,
				author: vals.author,
				series: vals.series,
				volume: vals.volume,
				year: vals.year,
				genre: vals.genre,
				publisher: vals.publisher,
				synopsis: vals.synopsis,
				comicMetadata: updatedMeta,
			};

			await this.plugin.store.upsertBook(updated);
			this.closeBookDetailModal();
			this.render();
		});

		// Botón cancelar
		const cancelBtn = actions.createDiv({
			cls: "ldr-detail-btn ldr-detail-btn--secondary",
		});
		cancelBtn.innerHTML = `<span>Cancel</span>`;
		cancelBtn.addEventListener("click", () => {
			this.closeBookDetailModal();
			this.showBookDetailModal(book);
		});
	}

	private closeBookDetailModal() {
		if (!this.detailModalEl) return;
		this.detailModalEl.removeClass("is-visible");
		const el = this.detailModalEl;
		this.detailModalEl = null;
		setTimeout(() => el.remove(), 250);
	}

	// ── COVER ────────────────────────────────────────────────────

	private buildCover(
		parent: HTMLElement,
		book: Book,
		size: "grid" | "fan" | "recent",
	) {
		const cover = parent.createDiv({ cls: `ldr-cover ldr-cover--${size}` });

		if (book.coverPath) {
			const img = cover.createEl("img", {
				cls: "ldr-cover-img",
				attr: { alt: book.title },
			});
			// Leer el binario y crear un blob URL para evitar problemas con
			// getResourcePath en Linux (doble barra) y carpetas ocultas (.ldr-covers).
			this.app.vault.adapter.readBinary(book.coverPath).then((data) => {
				const p = book.coverPath!;
				const mime = p.endsWith(".png")
					? "image/png"
					: p.endsWith(".webp")
						? "image/webp"
						: "image/jpeg";
				const blob = new Blob([data], { type: mime });
				img.src = URL.createObjectURL(blob);
			}).catch(() => {
				img.remove();
				this.buildCoverFallback(cover, book);
			});
			return;
		}

		this.buildCoverFallback(cover, book);
	}

	private buildCoverFallback(cover: HTMLElement, book: Book) {
		cover.addClass("ldr-cover--fallback");
		cover.style.setProperty(
			"--cover-hue",
			String(this.stringToHue(book.title)),
		);
		cover.createDiv({ cls: "ldr-cover-fallback-title", text: book.title });
		cover.createDiv({
			cls: "ldr-cover-fallback-author",
			text: book.author,
		});
	}

	private buildCategoryPreview(parent: HTMLElement, books: Book[]) {
		const preview = parent.createDiv({ cls: "ldr-cat-preview" });
		books.slice(0, 4).forEach((b) => {
			const mini = preview.createDiv({ cls: "ldr-cat-mini-cover" });
			this.buildCover(mini, b, "grid");
		});
		for (let i = books.length; i < 4; i++) {
			preview.createDiv({
				cls: "ldr-cat-mini-cover ldr-cat-mini-cover--empty",
			});
		}
	}

	private stringToHue(str: string): number {
		let h = 0;
		for (let i = 0; i < str.length; i++)
			h = str.charCodeAt(i) + ((h << 5) - h);
		return Math.abs(h) % 360;
	}

	// ── MENUS ────────────────────────────────────────────────────

	private showSortMenu(e: MouseEvent) {
		const menu = new Menu();

		const baseOptions: { key: SortKey; label: string }[] = [
			{ key: "dateAdded", label: "Date added" },
			{ key: "title", label: "Title" },
			{ key: "author", label: "Author" },
		];

		// "Series" solo disponible en tab Comics
		if (this.currentTab === "comics") {
			baseOptions.push({ key: "series" as SortKey, label: "Series" });
		}

		baseOptions.forEach(({ key, label }) => {
			menu.addItem((item) => {
				item.setTitle(label);
				if (this.sortKey === key) item.setIcon("check");
				item.onClick(() => {
					this.sortKey = key;
					this.render();
				});
			});
		});
		menu.showAtMouseEvent(e);
	}

	private showCategoryMenu(e: MouseEvent, book: Book) {
		const menu = new Menu();
		const cats = this.plugin.store.getCategories();

		if (cats.length === 0) {
			menu.addItem((i) =>
				i
					.setTitle("No categories — create them in Bookshelf")
					.setDisabled(true),
			);
		} else {
			cats.forEach((cat) => {
				const inCat = book.categories.includes(cat.id);
				menu.addItem((item) => {
					item.setTitle(cat.name);
					if (inCat) item.setIcon("check");
					item.onClick(async () => {
						book.categories = inCat
							? book.categories.filter((id) => id !== cat.id)
							: [...book.categories, cat.id];
						await this.plugin.store.upsertBook(book);
						this.render();
					});
				});
			});
		}

		menu.addSeparator();
		menu.addItem((item) => {
			item.setTitle(
				book.isFinished ? "Mark as unfinished" : "Mark as finished",
			);
			item.setIcon(book.isFinished ? "x" : "check-circle");
			item.onClick(async () => {
				book.isFinished = !book.isFinished;
				await this.plugin.store.upsertBook(book);
				this.render();
			});
		});

		menu.showAtMouseEvent(e);
	}

	private promptNewCategory() {
		new CategoryModal(this.app, async (name) => {
			await this.plugin.store.addCategory(name);
			this.render();
		}).open();
	}

	refresh() {
		this.render();
	}
}
