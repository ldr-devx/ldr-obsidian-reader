// ============================================================
// src/core/LibraryScanner.ts
// ============================================================
import { App, TFile, Notice } from "obsidian";
import { DataStore } from "./DataStore";
import { EpubParser } from "./EpubParser";
import { CbzParser } from "./CbzParser";
import { Book, EpubMetadata } from "../models";
import { detectSeriesInfo } from "../utils/seriesDetector";

export class LibraryScanner {
	private app: App;
	private store: DataStore;

	constructor(app: App, store: DataStore) {
		this.app = app;
		this.store = store;
	}

	async scan(silent = false): Promise<ScanResult> {
		const folderPath = this.store.getLibraryFolder();
		const result: ScanResult = {
			added: 0,
			removed: 0,
			total: 0,
			errors: [],
		};

		const epubFiles = this.getBookFiles(folderPath, "epub");
		const cbzFiles = this.getBookFiles(folderPath, "cbz");
		const pdfFiles = this.getAllPdfFiles();
		const allFiles = [...epubFiles, ...cbzFiles, ...pdfFiles];
		result.total = allFiles.length;

		if (allFiles.length === 0 && !silent) {
			new Notice(
				`LDR: No .epub, .cbz or .pdf files found in "${folderPath}"`,
				5000,
			);
		}

		// Solo eliminar huérfanos en scans manuales (no silenciosos).
		if (!silent) {
			const existingPaths = new Set(allFiles.map((f) => f.path));
			const orphanIds = this.store.getOrphanedBookIds(existingPaths);
			for (const id of orphanIds) {
				await this.store.removeBook(id);
				result.removed++;
			}
		}

		const existingByPath = new Map(
			this.store.getAllBooks().map((b) => [b.filePath, b]),
		);

		// ── Procesar EPUBs ──────────────────────────────────────
		for (const file of epubFiles) {
			const existing = existingByPath.get(file.path);
			if (existing && !this.needsMetadataRefresh(existing)) continue;

			try {
				const id = this.generateId(file.path);
				const oldData = existing || this.store.getBook(id);
				const book = await this.processEpubFile(file);

				if (oldData) {
					book.categories = oldData.categories || [];
					book.isFinished = oldData.isFinished || false;
					book.dateAdded = oldData.dateAdded || book.dateAdded;
				}

				await this.store.upsertBook(book);
				if (!existing) result.added++;
			} catch (err) {
				const msg = `Error processing "${file.name}": ${err}`;
				result.errors.push(msg);
				console.error(`[LDR] ${msg}`);
			}
		}

		// ── Procesar CBZs ───────────────────────────────────────
		for (const file of cbzFiles) {
			const existing = existingByPath.get(file.path);
			if (existing && !this.needsMetadataRefresh(existing)) continue;

			try {
				const id = this.generateId(file.path);
				const oldData = existing || this.store.getBook(id);
				const book = await this.processCbzFile(file);

				if (oldData) {
					book.categories = oldData.categories || [];
					book.isFinished = oldData.isFinished || false;
					book.dateAdded = oldData.dateAdded || book.dateAdded;
				}

				await this.store.upsertBook(book);
				if (!existing) result.added++;
			} catch (err) {
				const msg = `Error processing "${file.name}": ${err}`;
				result.errors.push(msg);
				console.error(`[LDR] ${msg}`);
			}
		}

		// ── Procesar PDFs ───────────────────────────────────────
		for (const file of pdfFiles) {
			const existing = existingByPath.get(file.path);
			if (existing) continue;

			try {
				const id = this.generateId(file.path);
				const oldData = this.store.getBook(id);
				const book = this.processPdfFile(file);

				if (oldData) {
					book.categories = oldData.categories || [];
					book.isFinished = oldData.isFinished || false;
					book.dateAdded = oldData.dateAdded || book.dateAdded;
				}

				// Generar portada desde la primera página del PDF
				if (!book.coverPath) {
					const coverPath = await this.generatePdfCover(file);
					if (coverPath) book.coverPath = coverPath;
				}

				await this.store.upsertBook(book);
				result.added++;
			} catch (err) {
				const msg = `Error processing "${file.name}": ${err}`;
				result.errors.push(msg);
				console.error(`[LDR] ${msg}`);
			}
		}

		if (!silent) this.showScanNotice(result, folderPath);
		return result;
	}

	// ── NEEDSREFRESH ─────────────────────────────────────────────

	private needsMetadataRefresh(book: Book): boolean {
		// Si el usuario editó metadatos manualmente, nunca refrescar
		if (book.comicMetadata?.isManuallyEdited) return false;

		if (book.contentType === "cbz") {
			// Para CBZ: refrescar si no tiene portada o no sabemos cuántas páginas tiene
			return !book.coverPath || !book.pageCount;
		}

		// Para EPUB: lógica original
		return (
			!book.author ||
			book.author === "Unknown author" ||
			book.author === "Autor desconocido" ||
			!book.coverPath ||
			(!book.genre &&
				!book.synopsis &&
				!book.publishDate &&
				!book.language)
		);
	}

	// ── PROCESS EPUB ─────────────────────────────────────────────

	private async processEpubFile(file: TFile): Promise<Book> {
		const buffer = await this.app.vault.readBinary(file);
		const meta = await EpubParser.parse(buffer);
		const coverPath = await this.saveCover(file, meta);
		const id = this.generateId(file.path);

		return {
			id,
			filePath: file.path,
			contentType: "epub",
			title: meta.title || this.titleFromFilename(file.name),
			author: meta.author || "Unknown author",
			coverPath,
			genre: meta.genre,
			synopsis: meta.synopsis,
			publishDate: meta.publishDate,
			language: meta.language,
			publisher: meta.publisher,
			isbn: meta.isbn,
			dateAdded: Date.now(),
			categories: [],
			isFinished: false,
		};
	}

	// ── PROCESS CBZ ──────────────────────────────────────────────

	private async processCbzFile(file: TFile): Promise<Book> {
		const buffer = await this.app.vault.readBinary(file);
		const parsed = await CbzParser.parse(buffer);
		const id = this.generateId(file.path);

		// Detectar serie/volumen desde metadatos, con fallback al nombre de archivo
		const seriesFromMeta = parsed.metadata?.series ?? "";
		const volumeFromMeta = parsed.metadata?.number ?? "";
		const { series: seriesFromFile, volume: volumeFromFile } =
			detectSeriesInfo(file.name);

		const series = seriesFromMeta || seriesFromFile;
		const volume = volumeFromMeta || volumeFromFile;

		// Título: desde ComicInfo > nombre de archivo
		const title =
			parsed.metadata?.title || this.titleFromFilename(file.name);

		// Autor: campo Writer de ComicInfo
		const author = parsed.metadata?.writer || "Unknown author";

		// Guardar portada
		const coverPath = await this.saveCoverFromBase64(
			id,
			parsed.coverBase64,
			parsed.coverMimeType,
		);

		return {
			id,
			filePath: file.path,
			contentType: "cbz",
			title,
			author,
			coverPath,
			genre: parsed.metadata?.genre ?? "",
			synopsis: parsed.metadata?.summary ?? "",
			publishDate: parsed.metadata?.year
				? `${parsed.metadata.year}`
				: "",
			language: parsed.metadata?.languageISO ?? "",
			publisher: parsed.metadata?.publisher ?? "",
			isbn: "",
			dateAdded: Date.now(),
			categories: [],
			isFinished: false,
			// Campos específicos de CBZ
			series,
			volume,
			pageCount: parsed.pageCount,
			year: parsed.metadata?.year ?? "",
			comicMetadata: parsed.metadata,
		};
	}

	// ── SAVE COVER (EPUB) ─────────────────────────────────────────

	private async saveCover(
		file: TFile,
		meta: EpubMetadata,
	): Promise<string | null> {
		if (!meta.coverBase64 || !meta.coverMimeType) return null;
		return this.saveCoverFromBase64(
			this.generateId(file.path),
			meta.coverBase64,
			meta.coverMimeType,
		);
	}

	// ── SAVE COVER (SHARED) ───────────────────────────────────────

	private async saveCoverFromBase64(
		bookId: string,
		coverBase64: string | null,
		coverMimeType: string | null,
	): Promise<string | null> {
		if (!coverBase64 || !coverMimeType) return null;
		try {
			const coverFolder = `${this.store.getLibraryFolder()}/.ldr-covers`;
			const ext =
				coverMimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
			const coverFileName = `${bookId}.${ext}`;
			const coverPath = `${coverFolder}/${coverFileName}`;
			const adapter = this.app.vault.adapter;

			if (!(await adapter.exists(coverFolder))) {
				await adapter.mkdir(coverFolder);
			}
			if (!(await adapter.exists(coverPath))) {
				const binary = this.base64ToArrayBuffer(coverBase64);
				await adapter.writeBinary(coverPath, binary);
			}
			return coverPath;
		} catch (err) {
			console.warn("[LDR] Could not save cover:", err);
			return null;
		}
	}

	// ── PROCESS PDF ──────────────────────────────────────────────

	private processPdfFile(file: TFile): Book {
		const id = this.generateId(file.path);
		return {
			id,
			filePath: file.path,
			contentType: "pdf",
			title: this.titleFromFilename(file.name, "pdf"),
			author: "Unknown author",
			coverPath: null,
			genre: "",
			synopsis: "",
			publishDate: "",
			language: "",
			publisher: "",
			isbn: "",
			dateAdded: Date.now(),
			categories: [],
			isFinished: false,
		};
	}

	// ── FILE DISCOVERY ────────────────────────────────────────────

	private getBookFiles(folderPath: string, ext: "epub" | "cbz"): TFile[] {
		const prefix = folderPath.endsWith("/")
			? folderPath
			: folderPath + "/";
		return this.app.vault
			.getFiles()
			.filter(
				(f) => f.extension === ext && f.path.startsWith(prefix),
			);
	}

	/** Escanea TODA la vault en busca de PDFs (no limitado a libraryFolder) */
	private getAllPdfFiles(): TFile[] {
		return this.app.vault.getFiles().filter((f) => f.extension === "pdf");
	}

	// ── UTILS ─────────────────────────────────────────────────────

	generateId(filePath: string): string {
		let hash = 0;
		for (let i = 0; i < filePath.length; i++) {
			hash = (hash << 5) - hash + filePath.charCodeAt(i);
			hash = hash & hash;
		}
		return `book-${Math.abs(hash).toString(36)}`;
	}

	private titleFromFilename(filename: string, ext?: string): string {
		const pattern = ext
			? new RegExp(`\\.${ext}$`, "i")
			: /\.(epub|cbz|pdf)$/i;
		return filename
			.replace(pattern, "")
			.replace(/[-_]/g, " ")
			.replace(/\b\w/g, (l) => l.toUpperCase());
	}

	private base64ToArrayBuffer(base64: string): ArrayBuffer {
		const bin = atob(base64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return bytes.buffer;
	}

	private showScanNotice(result: ScanResult, folderPath: string): void {
		const parts: string[] = [];
		if (result.added > 0) parts.push(`${result.added} book(s) added`);
		if (result.removed > 0) parts.push(`${result.removed} removed`);
		if (result.errors.length > 0)
			parts.push(`${result.errors.length} error(s)`);
		new Notice(
			parts.length === 0
				? `LDR: Library updated (${result.total} items)`
				: `LDR: ${parts.join(", ")}`,
			3000,
		);
	}

	/**
	 * Renderiza la primera página de un PDF como imagen JPEG y la guarda
	 * en la carpeta de portadas del plugin (.ldr-covers/).
	 *
	 * Usa OffscreenCanvas (disponible en Electron/Chromium) para renderizar
	 * sin necesidad de dependencias externas como node-canvas.
	 *
	 * Requiere que GlobalWorkerOptions.workerSrc ya esté configurado.
	 * Si el worker no está listo, la generación se omite sin error fatal.
	 */
	private async generatePdfCover(file: TFile): Promise<string | undefined> {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const pdfjsLib = require("pdfjs-dist/legacy/build/pdf");

			// Intentar inicializar el worker igual que en PdfReaderView
			if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
				// eslint-disable-next-line @typescript-eslint/no-require-imports
				const fs = require("fs") as typeof import("fs");
				// eslint-disable-next-line @typescript-eslint/no-require-imports
				const nodePath = require("path") as typeof import("path");
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const basePath = (this.app.vault.adapter as any).basePath as string | undefined;
				const candidates = basePath
					? [nodePath.join(basePath, ".obsidian", "plugins", "ldr-obsidian-reader", "pdf.worker.min.js")]
					: [];
				for (const p of candidates) {
					if (fs.existsSync(p)) {
						const code = fs.readFileSync(p, "utf8");
						const blob = new Blob([code], { type: "application/javascript" });
						pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
						break;
					}
				}
			}

			if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
				console.warn("[LDR] Worker de pdf.js no disponible, omitiendo portada para:", file.name);
				return undefined;
			}

			// Leer el PDF del vault
			const buffer = await this.app.vault.readBinary(file);
			const pdfDoc = await pdfjsLib.getDocument({ data: buffer }).promise;
			const page = await pdfDoc.getPage(1);

			// Escala pequeña para la miniatura (aprox. 150px de ancho)
			const viewport = page.getViewport({ scale: 0.4 });

			// OffscreenCanvas está disponible en Electron (Chromium)
			const canvas = new OffscreenCanvas(
				Math.floor(viewport.width),
				Math.floor(viewport.height),
			);
			const ctx = canvas.getContext("2d");
			if (!ctx) return undefined;

			await page.render({ canvasContext: ctx, viewport }).promise;

			// Convertir a JPEG
			const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
			const arrayBuffer = await blob.arrayBuffer();

			// Guardar en la carpeta de portadas
			const coverFolder = `${this.store.getLibraryFolder()}/.ldr-covers`;
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(coverFolder))) {
				await adapter.mkdir(coverFolder);
			}

			const safeName = file.basename.replace(/[/\\:*?"<>|]/g, "_");
			const coverPath = `${coverFolder}/${safeName}.jpg`;
			await adapter.writeBinary(coverPath, arrayBuffer);

			return coverPath;
		} catch (e) {
			console.warn("[LDR] Error generando portada PDF para", file.name, ":", e);
			return undefined;
		}
	}
}

export interface ScanResult {
	added: number;
	removed: number;
	total: number;
	errors: string[];
}
