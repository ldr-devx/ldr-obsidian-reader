// ============================================================
// src/core/DataStore.ts
// Wrapper tipado sobre loadData() / saveData() de Obsidian.
// Punto único de acceso a todos los datos persistidos.
// ============================================================

import { Plugin } from "obsidian";
import {
	PluginData,
	Book,
	ReadingState,
	Category,
	PluginSettings,
	ReaderSettings,
	ComicReaderSettings,
	DEFAULT_PLUGIN_DATA,
	DEFAULT_COMIC_READER_SETTINGS,
} from "../models";

export class DataStore {
	private data: PluginData;
	private plugin: Plugin;

	constructor(plugin: Plugin) {
		this.plugin = plugin;
		this.data = structuredClone(DEFAULT_PLUGIN_DATA);
	}

	// ── INIT ────────────────────────────────────────────────────

	async load(): Promise<void> {
		const saved = await this.plugin.loadData();
		if (!saved) {
			this.data = structuredClone(DEFAULT_PLUGIN_DATA);
			return;
		}
		// Merge con defaults para que campos nuevos tengan valor
		this.data = this.migrate({
			...structuredClone(DEFAULT_PLUGIN_DATA),
			...saved,
			settings: {
				...DEFAULT_PLUGIN_DATA.settings,
				...saved.settings,
				readerSettings: {
					...DEFAULT_PLUGIN_DATA.settings.readerSettings,
					...saved.settings?.readerSettings,
				},
				comicReaderSettings: {
					...DEFAULT_PLUGIN_DATA.settings.comicReaderSettings,
					...saved.settings?.comicReaderSettings,
				},
			},
		});
	}

	async save(): Promise<void> {
		await this.plugin.saveData(this.data);
	}

	// ── MIGRACIONES ─────────────────────────────────────────────

	private migrate(data: PluginData): PluginData {
		// Asegurarnos de que las colecciones base existen
		if (!data.library) data.library = {};
		if (!data.categories) data.categories = [];
		if (!data.readingStates) data.readingStates = {};

		// Migrar comicReaderSettings si no existe (datos de versiones anteriores)
		if (!data.settings.comicReaderSettings) {
			data.settings.comicReaderSettings = structuredClone(DEFAULT_COMIC_READER_SETTINGS);
		}

		// Revisar cada libro para actualizar su estructura sin borrar datos
		for (const bookId in data.library) {
			const book = data.library[bookId];

			if (!book.categories) {
				book.categories = [];
			}

			if (book.isFinished === undefined) {
				book.isFinished = false;
			}

			// Migrar campos CBZ: los libros existentes son todos EPUBs
			if (book.contentType === undefined) {
				book.contentType = "epub";
			}
			if (book.series === undefined) book.series = "";
			if (book.volume === undefined) book.volume = "";
			if (book.pageCount === undefined) book.pageCount = 0;
			if (book.year === undefined) book.year = "";
			if (book.comicMetadata === undefined) book.comicMetadata = null;
		}

		// Migrar readingStates: añadir campos CBZ opcionales si no existen
		for (const bookId in data.readingStates) {
			const state = data.readingStates[bookId];
			if (state.pageIndex === undefined) state.pageIndex = 0;
		}

		return data;
	}

	// ── SETTINGS ────────────────────────────────────────────────

	getSettings(): PluginSettings {
		return this.data.settings;
	}

	async updateSettings(partial: Partial<PluginSettings>): Promise<void> {
		this.data.settings = { ...this.data.settings, ...partial };
		await this.save();
	}

	getReaderSettings(): ReaderSettings {
		return this.data.settings.readerSettings;
	}

	async updateReaderSettings(
		partial: Partial<ReaderSettings>,
	): Promise<void> {
		this.data.settings.readerSettings = {
			...this.data.settings.readerSettings,
			...partial,
		};
		await this.save();
	}

	getComicReaderSettings(): ComicReaderSettings {
		return this.data.settings.comicReaderSettings;
	}

	async updateComicReaderSettings(
		partial: Partial<ComicReaderSettings>,
	): Promise<void> {
		this.data.settings.comicReaderSettings = {
			...this.data.settings.comicReaderSettings,
			...partial,
		};
		await this.save();
	}

	getLibraryFolder(): string {
		return this.data.settings.libraryFolder;
	}

	// ── LIBRARY ─────────────────────────────────────────────────

	getAllBooks(): Book[] {
		return Object.values(this.data.library).map((b) => ({ ...b }));
	}

	getBook(id: string): Book | null {
		const b = this.data.library[id];
		return b ? { ...b } : null;
	}

	async upsertBook(book: Book): Promise<void> {
		const existing = this.data.library[book.id];

		if (existing) {
			const merged: Book = {
				...existing,
				...book,
				// Rescatar categorías: si el libro que llega tiene vacío, conservar las guardadas
				categories:
					book.categories.length > 0
						? [...book.categories]
						: existing.categories?.length > 0
							? [...existing.categories]
							: [],
				// Rescatar estado de lectura
				isFinished: existing.isFinished || book.isFinished,
				// Mantener fecha original
				dateAdded: existing.dateAdded || book.dateAdded,
				// Rescatar metadatos editados manualmente por el usuario
				comicMetadata:
					existing.comicMetadata?.isManuallyEdited
						? existing.comicMetadata
						: book.comicMetadata ?? existing.comicMetadata ?? null,
			};
			this.data.library[book.id] = merged;
		} else {
			this.data.library[book.id] = { ...book };
		}

		await this.save();
	}

	async removeBook(id: string): Promise<void> {
		delete this.data.library[id];
		delete this.data.readingStates[id];
		await this.save();
	}

	/** Devuelve los IDs de libros que ya no existen en el vault */
	getOrphanedBookIds(existingPaths: Set<string>): string[] {
		return Object.values(this.data.library)
			.filter((b) => !existingPaths.has(b.filePath))
			.map((b) => b.id);
	}

	// ── READING STATE ────────────────────────────────────────────

	getReadingState(bookId: string): ReadingState | null {
		return this.data.readingStates[bookId] ?? null;
	}

	async saveReadingState(state: ReadingState): Promise<void> {
		this.data.readingStates[state.bookId] = state;
		await this.save();
	}

	/** Devuelve el libro leído más recientemente (para "Recently Read") */
	getLastReadBook(): Book | null {
		const states = Object.values(this.data.readingStates);
		if (states.length === 0) return null;
		const latest = states.reduce((a, b) =>
			a.lastReadAt > b.lastReadAt ? a : b,
		);
		return this.getBook(latest.bookId);
	}

	// ── CATEGORIES ───────────────────────────────────────────────

	getCategories(): Category[] {
		return this.data.categories;
	}

	async addCategory(name: string): Promise<Category> {
		const category: Category = {
			id: `cat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			name,
			createdAt: Date.now(),
		};
		this.data.categories.push(category);
		await this.save();
		return category;
	}

	async removeCategory(id: string): Promise<void> {
		this.data.categories = this.data.categories.filter((c) => c.id !== id);
		// Limpiar la categoría de todos los libros que la tenían
		for (const book of Object.values(this.data.library)) {
			book.categories = book.categories.filter((cid) => cid !== id);
		}
		await this.save();
	}

	// ── RESET TOTAL ──────────────────────────────────────────────

	async clearAll(): Promise<void> {
		const settings = this.data.settings; // preservar ajustes del usuario
		this.data = {
			...structuredClone(DEFAULT_PLUGIN_DATA),
			settings,
		};
		await this.save();
	}
}
