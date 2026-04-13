// ============================================================
// src/utils/seriesDetector.ts
// Extrae nombre de serie y número de volumen desde el nombre
// de un archivo .cbz cuando no hay ComicInfo.xml disponible.
// ============================================================

export interface SeriesInfo {
	/** Nombre de la serie normalizado, o string vacío si no se detectó */
	series: string;
	/** Número de volumen como string, o string vacío si no se detectó */
	volume: string;
}

/**
 * Intenta extraer serie y volumen desde el nombre de archivo de un .cbz.
 * Prueba patrones en orden de prioridad. Primer match gana.
 *
 * Patrones soportados (ejemplos):
 *   Batman_vol01.cbz       → { series: "Batman", volume: "01" }
 *   Batman_v01.cbz         → { series: "Batman", volume: "01" }
 *   Batman_v01_Year_One    → { series: "Batman", volume: "01" }
 *   Batman (2024) #5.cbz   → { series: "Batman (2024)", volume: "5" }
 *   Batman - 04.cbz        → { series: "Batman", volume: "04" }
 *   Batman_03.cbz          → { series: "Batman", volume: "03" }
 */
export function detectSeriesInfo(filename: string): SeriesInfo {
	const base = filename.replace(/\.cbz$/i, "");

	// Patrón 1: vol / volume (mayor prioridad — más explícito)
	// Ejemplos: Batman_vol01, Batman Vol.2, Batman - Volume 3
	let m = base.match(/^(.+?)[\s_-]*vol(?:ume)?\.?\s*(\d+)/i);
	if (m) return { series: cleanName(m[1]), volume: m[2] };

	// Patrón 2: v## con límite de palabra (evita coincidir con "av", "tv", etc.)
	// Ejemplos: Batman_v01, Batman v2, Batman_v01_Year_One
	m = base.match(/^(.+?)[\s_-]+v(\d+)(?:[\s_-]|$)/i);
	if (m) return { series: cleanName(m[1]), volume: m[2] };

	// Patrón 3: #número (estilo issue de cómics)
	// Ejemplos: Batman (2024) #5, The_Amazing_Spider-Man_#003
	m = base.match(/^(.+?)\s*#(\d+)/);
	if (m) return { series: cleanName(m[1]), volume: m[2] };

	// Patrón 4: " - número" al final (guión + número solo)
	// Ejemplos: Batman - 04, My Hero Academia - 12
	m = base.match(/^(.+?)\s+-\s+(\d+)$/);
	if (m) return { series: cleanName(m[1]), volume: m[2] };

	// Patrón 5: número al final separado por espacio o guión bajo (menor prioridad)
	// Ejemplos: Batman_03, Dragon Ball 07
	// Solo 1-3 dígitos para evitar coincidir con años (2024)
	m = base.match(/^(.+?)[\s_](\d{1,3})$/);
	if (m) return { series: cleanName(m[1]), volume: m[2] };

	// Sin patrón detectado: el archivo es independiente
	return { series: "", volume: "" };
}

/**
 * Normaliza un nombre de serie: quita separadores del final,
 * convierte guiones bajos a espacios.
 */
function cleanName(raw: string): string {
	return raw
		.replace(/[\s_-]+$/, "") // quitar separadores al final
		.replace(/_/g, " ") // underscores → espacios
		.trim();
}

/**
 * Normaliza un nombre de serie para comparación (agrupar volúmenes
 * aunque tengan ligeras diferencias tipográficas).
 * Uso: para comparar si dos archivos pertenecen a la misma serie.
 */
export function normalizeSeriesName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, "") // quitar caracteres especiales
		.replace(/\s+/g, " ")
		.trim();
}
