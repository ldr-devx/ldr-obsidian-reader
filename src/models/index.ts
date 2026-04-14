// ============================================================
// src/models/index.ts
// Interfaces y tipos centrales del plugin LDR Epub Reader
// ============================================================

// ── BOOK ─────────────────────────────────────────────────────

export interface Book {
	/** Hash único generado desde el filePath */
	id: string;
	/** Ruta absoluta del archivo .epub o .cbz dentro del vault */
	filePath: string;
	/** Título extraído del epub (dc:title) o CBZ (ComicInfo / nombre de archivo) */
	title: string;
	/** Autor(es) del libro (dc:creator) o escritor del cómic */
	author: string;
	/** Ruta de la portada extraída o custom (null si no tiene) */
	coverPath: string | null;
	/** Género literario (dc:subject / dc:type / ComicInfo Genre) */
	genre: string;
	/** Sinopsis del libro (dc:description / ComicInfo Summary) */
	synopsis: string;
	/** Fecha de publicación del libro (dc:date) */
	publishDate: string;
	/** Idioma del libro (dc:language) */
	language: string;
	/** Editorial (dc:publisher / ComicInfo Publisher) */
	publisher: string;
	/** ISBN si está disponible (dc:identifier) */
	isbn: string;
	/** Fecha en que se añadió a la biblioteca */
	dateAdded: number; // timestamp ms
	/** Categorías asignadas por el usuario */
	categories: string[];
	/** Marcado como terminado */
	isFinished: boolean;
	/** Incluido en el carrusel Top 10 */
	//isTop10: boolean;
	/** Posición en el Top 10 (0-9), -1 si no está */
	//top10Position: number;

	// ── Campos CBZ (opcionales, default epub) ─────────────────
	/** Determina qué motor de lectura usar */
	contentType?: "epub" | "cbz" | "pdf";
	/** Nombre de serie/saga (desde ComicInfo <Series> o entrada manual) */
	series?: string;
	/** Número de volumen dentro de la serie */
	volume?: string;
	/** Total de páginas/imágenes en el archivo CBZ */
	pageCount?: number;
	/** Año de publicación (desde ComicInfo <Year> o manual) */
	year?: string;
	/** Metadatos completos de ComicInfo.xml, null para EPUBs */
	comicMetadata?: ComicMetadata | null;
}

// ── COMIC METADATA ────────────────────────────────────────────

export interface ComicMetadata {
	title: string;
	series: string;
	/** Número de volumen/issue dentro de la serie */
	number: string;
	year: string;
	month: string;
	writer: string;
	penciller: string;
	inker: string;
	colorist: string;
	letterer: string;
	coverArtist: string;
	publisher: string;
	genre: string;
	summary: string;
	/** Total de páginas (desde <PageCount> o contado desde imágenes) */
	pageCount: number;
	languageISO: string;
	/** Para futuro soporte RTL (manga) */
	manga: "Yes" | "No" | "Unknown";
	/** true si el usuario editó los metadatos manualmente */
	isManuallyEdited: boolean;
}

// ── READING STATE ─────────────────────────────────────────────

export interface ReadingState {
	/** ID del libro al que pertenece este estado */
	bookId: string;
	/**
	 * CFI (Canonical Fragment Identifier) de epub.js
	 * Guarda la posición exacta dentro del epub, independiente
	 * de fuente/tamaño (más confiable que número de página)
	 */
	cfi: string;
	/** Número de página actual (calculado dinámicamente) */
	currentPage: number;
	/** Total de páginas (cambia con ajustes tipográficos) */
	totalPages: number;
	/** ID del capítulo actual (href del spine) */
	currentChapterId: string;
	/** Porcentaje de lectura (0–100) */
	progress: number;
	/** Timestamp de la última lectura */
	lastReadAt: number;

	// ── Campos CBZ ────────────────────────────────────────────
	/** Índice de página actual para CBZ/PDF (basado en 0). */
	pageIndex?: number;
	/** Último modo de lectura usado para este libro específico */
	readingMode?: "paginated" | "webtoon" | "double";
	/** Zoom del lector PDF (escala de renderizado, e.g. 1.5 = 150%) */
	pdfZoom?: number;
	/** Modo de layout del lector PDF */
	pdfLayoutMode?: "single" | "double-odd" | "double-even";
	/** Estado del sidebar del lector PDF */
	pdfSidebarOpen?: boolean;
	/** Tab activo del sidebar PDF */
	pdfSidebarTab?: "thumbs" | "toc";
	/** Ancho del sidebar PDF en px */
	pdfSidebarWidth?: number;
	/** Modo oscuro del lector PDF */
	pdfDarkMode?: boolean;
}

// ── READER SETTINGS ───────────────────────────────────────────

export type BgColor = "white" | "black" | "sepia" | "gray" | "transparent";
export type FontFamily =
	| "Literata" // fuente literaria (lectura cómoda)
	| "Georgia" // serif clásica
	| "Inter" // sans-serif moderna
	| "OpenDyslexic" // accesibilidad
	| "SourceCodePro"; // monospace

export interface ReaderSettings {
	/** Color de fondo del área de lectura */
	bgColor: BgColor;
	/** Familia de fuente seleccionada */
	fontFamily: FontFamily;
	/** Tamaño de fuente en px */
	fontSize: number;
	/** Margen lateral del texto en px */
	margin: number;
	/** Interlineado (line-height), valor decimal ej: 1.6 */
	lineSpacing: number;
	/**
	 * Brillo del texto (0–100).
	 * Fondo blanco: ajusta opacidad del texto (más bajo = más gris).
	 * Fondo negro: ajusta claridad del texto (más alto = más blanco).
	 * Fondo sepia/gris: igual que blanco.
	 */
	brightness: number;
	/** Orientación forzada (auto = sigue el dispositivo) */
	orientation: "auto" | "portrait" | "landscape";
	/** Estado de pantalla completa */
	isFullscreen: boolean;
	/** Color de texto en modo transparente */
	transparentTextColor: "white" | "black";
}

// ── COMIC READER SETTINGS ─────────────────────────────────────

export interface ComicReaderSettings {
	/** Modo de lectura por defecto para cómics nuevos */
	readingMode: "paginated" | "webtoon" | "double";
	/** Cómo escalan las imágenes */
	fitMode: "width" | "height" | "original" | "contain";
	/** Color de fondo detrás de las imágenes */
	backgroundColor: string;
	/** Overlay de brillo de imagen (50–150) */
	brightness: number;
	/** Mostrar indicador de página actual / total */
	showPageIndicator: boolean;
	/** Cambiar automáticamente a doble página en orientación landscape */
	autoDoubleOnLandscape: boolean;
	/** Espacio entre páginas en modo webtoon (px) */
	pageGap: number;
	/** Número de páginas a precargar adelante/atrás */
	preloadPages: number;
}

// ── PLUGIN SETTINGS (configuración del SettingTab) ───────────

export interface PluginSettings {
	/** Carpeta del vault donde están los .epub y .cbz (relativa al vault root) */
	libraryFolder: string;
	/** Ajustes del lector EPUB (persistidos globalmente) */
	readerSettings: ReaderSettings;
	/** Ajustes del lector de cómics (persistidos globalmente) */
	comicReaderSettings: ComicReaderSettings;
}

// ── PLUGIN DATA (todo lo que se persiste con saveData) ────────

export interface PluginData {
	/** Versión del esquema de datos (para migraciones futuras) */
	schemaVersion: number;
	/** Configuración del plugin */
	settings: PluginSettings;
	/** Biblioteca de libros indexados */
	library: Record<string, Book>;
	/** Estado de lectura por bookId */
	readingStates: Record<string, ReadingState>;
	/** Categorías creadas por el usuario */
	categories: Category[];
}

// ── CATEGORY ──────────────────────────────────────────────────

export interface Category {
	/** ID único de la categoría */
	id: string;
	/** Nombre mostrado al usuario */
	name: string;
	/** Timestamp de creación */
	createdAt: number;
}

// ── EPUB METADATA (resultado del parser, antes de crear Book) ─

export interface EpubMetadata {
	title: string;
	author: string;
	genre: string;
	synopsis: string;
	publishDate: string;
	language: string;
	publisher: string;
	isbn: string;
	/** Base64 de la imagen de portada, null si no tiene */
	coverBase64: string | null;
	/** Mime type de la portada: image/jpeg, image/png, etc. */
	coverMimeType: string | null;
}

// ── DEFAULTS ──────────────────────────────────────────────────

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
	bgColor: "white",
	fontFamily: "Georgia",
	fontSize: 18,
	margin: 32,
	lineSpacing: 1.7,
	brightness: 80,
	orientation: "auto",
	isFullscreen: false,
	transparentTextColor: "black",
};

export const DEFAULT_COMIC_READER_SETTINGS: ComicReaderSettings = {
	readingMode: "paginated",
	fitMode: "width",
	backgroundColor: "#000000",
	brightness: 100,
	showPageIndicator: true,
	autoDoubleOnLandscape: true,
	pageGap: 0,
	preloadPages: 3,
};

export const DEFAULT_PLUGIN_SETTINGS: PluginSettings = {
	libraryFolder: "Books",
	readerSettings: DEFAULT_READER_SETTINGS,
	comicReaderSettings: DEFAULT_COMIC_READER_SETTINGS,
};

export const DEFAULT_PLUGIN_DATA: PluginData = {
	schemaVersion: 1,
	settings: DEFAULT_PLUGIN_SETTINGS,
	library: {},
	readingStates: {},
	categories: [],
};
