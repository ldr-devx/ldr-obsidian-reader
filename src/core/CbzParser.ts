// ============================================================
// src/core/CbzParser.ts
// Parsea archivos .cbz (ZIP de imágenes).
// Extrae lista de imágenes, ComicInfo.xml y portada.
// ============================================================

import JSZip from "jszip";
import { ComicMetadata } from "../models";

// ── TIPOS ─────────────────────────────────────────────────────

export interface CbzParseResult {
	/** Lista ordenada de rutas de imágenes dentro del ZIP */
	images: string[];
	/** Número total de archivos de imagen */
	pageCount: number;
	/** ComicInfo.xml parseado, null si no está presente */
	metadata: ComicMetadata | null;
	/** Portada en Base64, null si no se encontró */
	coverBase64: string | null;
	/** MIME type de la portada */
	coverMimeType: string | null;
}

// ── CONSTANTES ────────────────────────────────────────────────

const IMAGE_EXT = /\.(jpe?g|png|gif|webp)$/i;
const MIME_MAP: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};

// ── PARSER ────────────────────────────────────────────────────

export class CbzParser {
	/**
	 * Punto de entrada principal para el scanner.
	 * Carga el ZIP, extrae lista de imágenes, metadatos y portada.
	 * La instancia JSZip se crea internamente y se descarta al terminar.
	 */
	static async parse(buffer: ArrayBuffer): Promise<CbzParseResult> {
		try {
			const zip = await JSZip.loadAsync(buffer);
			const images = this.getImageList(zip);
			const metadata = await this.parseComicInfo(zip);
			const { coverBase64, coverMimeType } = await this.extractCover(
				zip,
				images,
				metadata,
			);

			return {
				images,
				pageCount: images.length,
				metadata,
				coverBase64,
				coverMimeType,
			};
		} catch (err) {
			console.error("[LDR] CbzParser.parse error:", err);
			return {
				images: [],
				pageCount: 0,
				metadata: null,
				coverBase64: null,
				coverMimeType: null,
			};
		}
	}

	/**
	 * Devuelve la lista de rutas de imágenes ordenadas naturalmente.
	 * Recibe una instancia JSZip ya cargada (evita re-cargar el ZIP).
	 * Usado por el scanner Y por ImageReaderView durante la lectura.
	 */
	static getImageList(zip: JSZip): string[] {
		return Object.keys(zip.files)
			.filter((name) => {
				const file = zip.files[name];
				if (file.dir) return false;
				// Ignorar artefactos de macOS
				if (name.startsWith("__MACOSX/")) return false;
				// Ignorar archivos ocultos
				const basename = name.split("/").pop() ?? "";
				if (basename.startsWith(".")) return false;
				return IMAGE_EXT.test(name);
			})
			.sort((a, b) =>
				a.localeCompare(b, undefined, {
					numeric: true,
					sensitivity: "base",
				}),
			);
	}

	/**
	 * Extrae una imagen individual por índice desde una instancia JSZip.
	 * Usado por ImageReaderView para carga lazy bajo demanda.
	 */
	static async extractImageAtIndex(
		zip: JSZip,
		images: string[],
		index: number,
	): Promise<{ base64: string; mimeType: string } | null> {
		const path = images[index];
		if (!path) return null;
		try {
			const file = zip.file(path);
			if (!file) return null;
			const base64 = await file.async("base64");
			return { base64, mimeType: this.getMimeType(path) };
		} catch {
			return null;
		}
	}

	/**
	 * Extrae un rango de imágenes. Usado para precarga.
	 * Las entradas fallidas se omiten silenciosamente.
	 */
	static async extractImagesRange(
		zip: JSZip,
		images: string[],
		start: number,
		count: number,
	): Promise<Array<{ index: number; base64: string; mimeType: string }>> {
		const end = Math.min(start + count, images.length);
		const results: Array<{ index: number; base64: string; mimeType: string }> =
			[];

		for (let i = start; i < end; i++) {
			const img = await this.extractImageAtIndex(zip, images, i);
			if (img) results.push({ index: i, ...img });
		}

		return results;
	}

	// ── PRIVADOS ─────────────────────────────────────────────────

	/**
	 * Parsea ComicInfo.xml si existe en el ZIP.
	 * Devuelve null si el archivo no existe o no es parseable.
	 */
	private static async parseComicInfo(
		zip: JSZip,
	): Promise<ComicMetadata | null> {
		// ComicInfo.xml puede estar en la raíz o en un subdirectorio
		const comicInfoFile =
			zip.file("ComicInfo.xml") ??
			zip.file(/^.*\/ComicInfo\.xml$/i)?.[0] ??
			null;

		if (!comicInfoFile) return null;

		try {
			const xmlString = await comicInfoFile.async("string");
			const parser = new DOMParser();
			const doc = parser.parseFromString(xmlString, "application/xml");

			// Detectar errores de parseo
			if (doc.querySelector("parsererror")) return null;

			const text = (tag: string): string =>
				doc.querySelector(tag)?.textContent?.trim() ?? "";

			const pageCountRaw = parseInt(text("PageCount"), 10);

			return {
				title: text("Title"),
				series: text("Series"),
				number: text("Number"),
				year: text("Year"),
				month: text("Month"),
				writer: text("Writer"),
				penciller: text("Penciller"),
				inker: text("Inker"),
				colorist: text("Colorist"),
				letterer: text("Letterer"),
				coverArtist: text("CoverArtist"),
				publisher: text("Publisher"),
				genre: text("Genre"),
				summary: text("Summary"),
				pageCount: isNaN(pageCountRaw) ? 0 : pageCountRaw,
				languageISO: text("LanguageISO"),
				manga: this.parseManga(text("Manga")),
				isManuallyEdited: false,
			};
		} catch (err) {
			console.warn("[LDR] CbzParser: Could not parse ComicInfo.xml:", err);
			return null;
		}
	}

	/**
	 * Detecta la portada según prioridad:
	 * 1. Archivo llamado cover.* en la raíz
	 * 2. Primera imagen en lista ordenada (fallback)
	 */
	private static async extractCover(
		zip: JSZip,
		images: string[],
		_metadata: ComicMetadata | null,
	): Promise<{ coverBase64: string | null; coverMimeType: string | null }> {
		if (images.length === 0)
			return { coverBase64: null, coverMimeType: null };

		// Prioridad 1: archivo explícito llamado cover.*
		const coverEntry = Object.keys(zip.files).find((name) => {
			const basename = name.split("/").pop() ?? "";
			return (
				/^cover\.(jpe?g|png|gif|webp)$/i.test(basename) &&
				!zip.files[name].dir
			);
		});

		const targetPath = coverEntry ?? images[0];

		try {
			const file = zip.file(targetPath);
			if (!file) return { coverBase64: null, coverMimeType: null };
			const base64 = await file.async("base64");
			return { coverBase64: base64, coverMimeType: this.getMimeType(targetPath) };
		} catch {
			return { coverBase64: null, coverMimeType: null };
		}
	}

	private static getMimeType(filePath: string): string {
		const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
		return MIME_MAP[ext] ?? "image/jpeg";
	}

	private static parseManga(value: string): "Yes" | "No" | "Unknown" {
		const v = value.toLowerCase();
		if (v === "yes") return "Yes";
		if (v === "no") return "No";
		return "Unknown";
	}
}
