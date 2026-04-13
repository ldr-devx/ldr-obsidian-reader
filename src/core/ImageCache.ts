// ============================================================
// src/core/ImageCache.ts
// Caché LRU (Least Recently Used) para imágenes decodificadas.
// Evita re-extraer del ZIP páginas visitadas recientemente.
// ============================================================

export class ImageCache {
	/** key → data URL completo: "data:image/jpeg;base64,..." */
	private cache = new Map<string, string>();
	/** LRU order: índice 0 = menos reciente, último = más reciente */
	private order: string[] = [];
	private readonly maxSize: number;

	/**
	 * @param maxSize Máximo de imágenes en caché.
	 *   Recomendado: 20 (desktop) / 10 (mobile)
	 */
	constructor(maxSize = 10) {
		this.maxSize = maxSize;
	}

	/** Devuelve el data URL cacheado o null si no está. Actualiza LRU. */
	get(key: string): string | null {
		const val = this.cache.get(key);
		if (val === undefined) return null;
		// Mover al final (más recientemente usado)
		this.order = this.order.filter((k) => k !== key);
		this.order.push(key);
		return val;
	}

	/** Almacena imagen. Desaloja LRU si está a capacidad máxima. */
	set(key: string, dataUrl: string): void {
		if (this.cache.has(key)) {
			// Ya existe: actualizar posición LRU
			this.order = this.order.filter((k) => k !== key);
		} else if (this.cache.size >= this.maxSize) {
			// Desalojar el menos recientemente usado
			const lru = this.order.shift();
			if (lru) this.cache.delete(lru);
		}
		this.cache.set(key, dataUrl);
		this.order.push(key);
	}

	has(key: string): boolean {
		return this.cache.has(key);
	}

	/** Vaciar todo el caché. Llamar al cerrar un libro. */
	clear(): void {
		this.cache.clear();
		this.order = [];
	}

	get size(): number {
		return this.cache.size;
	}
}
