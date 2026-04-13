// ============================================================
// src/core/EpubParser.ts
// Extrae metadatos de un archivo .epub leyéndolo como ZIP.
// Todo se lee del contenido interno del epub (OPF + portada).
// ============================================================

import JSZip from "jszip";
import { EpubMetadata } from "../models";

export class EpubParser {
	/**
	 * Parsea un .epub y extrae metadatos internos.
	 * Lee el OPF interno via META-INF/container.xml y extrae
	 * Dublin Core metadata + portada del manifest.
	 */
	static async parse(buffer: ArrayBuffer): Promise<EpubMetadata> {
		try {
			const zip = await JSZip.loadAsync(buffer);
			const opfPath = await this.findOpfPath(zip);
			if (!opfPath) return this.emptyMetadata();

			const opfContent = await zip.file(opfPath)?.async("string");
			if (!opfContent) return this.emptyMetadata();

			const opfDir = opfPath.includes("/")
				? opfPath.substring(0, opfPath.lastIndexOf("/") + 1)
				: "";

			const parser = new DOMParser();
			const opfDoc = parser.parseFromString(
				opfContent,
				"application/xml",
			);
			const metadata = this.extractDublinCore(opfDoc);
			const { coverBase64, coverMimeType } = await this.extractCover(
				zip,
				opfDoc,
				opfDir,
			);

			return { ...metadata, coverBase64, coverMimeType };
		} catch {
			return this.emptyMetadata();
		}
	}

	// ── UTILS INTERNOS ───────────────────────────────────────────

	private static async findOpfPath(zip: JSZip): Promise<string | null> {
		const containerFile = zip.file("META-INF/container.xml");
		if (!containerFile) return null;
		const containerXml = await containerFile.async("string");
		const parser = new DOMParser();
		const doc = parser.parseFromString(containerXml, "application/xml");
		return doc.querySelector("rootfile")?.getAttribute("full-path") ?? null;
	}

	private static extractDublinCore(
		opfDoc: Document,
	): Omit<EpubMetadata, "coverBase64" | "coverMimeType"> {
		// Helper: busca un elemento DC con múltiples estrategias de namespace
		const dcText = (localName: string): string => {
			const el =
				opfDoc.querySelector(`dc\\:${localName}`) ??
				opfDoc.querySelector(`[*|${localName}]`) ??
				opfDoc.getElementsByTagNameNS(
					"http://purl.org/dc/elements/1.1/",
					localName,
				)[0] ??
				opfDoc.getElementsByTagName(`dc:${localName}`)[0];
			return el?.textContent?.trim() ?? "";
		};

		const dcAll = (localName: string): string[] => {
			const els = opfDoc.querySelectorAll(
				`dc\\:${localName}, [*|${localName}]`,
			);
			if (els.length > 0) {
				return Array.from(els)
					.map((el) => el.textContent?.trim() ?? "")
					.filter(Boolean);
			}
			const byNS = opfDoc.getElementsByTagNameNS(
				"http://purl.org/dc/elements/1.1/",
				localName,
			);
			if (byNS.length > 0) {
				return Array.from(byNS)
					.map((el) => el.textContent?.trim() ?? "")
					.filter(Boolean);
			}
			const byTag = opfDoc.getElementsByTagName(`dc:${localName}`);
			return Array.from(byTag)
				.map((el) => el.textContent?.trim() ?? "")
				.filter(Boolean);
		};

		const author = dcAll("creator").join(", ");
		const genre = dcAll("subject").join(", ");

		let isbn = "";
		for (const text of dcAll("identifier")) {
			if (text.toLowerCase().includes("isbn")) {
				isbn = text.replace(/isbn[:\s-]*/i, "").trim();
				break;
			}
		}

		return {
			title: dcText("title"),
			author,
			genre,
			synopsis: dcText("description"),
			publishDate: dcText("date"),
			language: dcText("language"),
			publisher: dcText("publisher"),
			isbn,
		};
	}

	private static async extractCover(
		zip: JSZip,
		opfDoc: Document,
		opfDir: string,
	): Promise<{ coverBase64: string | null; coverMimeType: string | null }> {
		const coverPath = this.findCoverPath(opfDoc, opfDir);
		if (!coverPath) return { coverBase64: null, coverMimeType: null };
		const coverFile = zip.file(coverPath);
		if (!coverFile) return { coverBase64: null, coverMimeType: null };
		try {
			const base64 = await coverFile.async("base64");
			return {
				coverBase64: base64,
				coverMimeType: this.getMimeType(coverPath),
			};
		} catch {
			return { coverBase64: null, coverMimeType: null };
		}
	}

	private static findCoverPath(
		opfDoc: Document,
		opfDir: string,
	): string | null {
		// Recolectar todos los <item> del manifest de forma robusta
		// (querySelectorAll con child combinator falla con namespaces)
		const allItems = Array.from(opfDoc.getElementsByTagName("item"));

		// Helper: buscar item por atributo
		const itemById = (id: string) =>
			allItems.find((el) => el.getAttribute("id") === id);

		// 1. <meta name="cover" content="coverId"/> → buscar item en manifest
		const metas = Array.from(opfDoc.getElementsByTagName("meta"));
		const coverMeta = metas.find((m) => m.getAttribute("name") === "cover");
		if (coverMeta) {
			const coverId = coverMeta.getAttribute("content");
			if (coverId) {
				const item = itemById(coverId);
				const href = item?.getAttribute("href");
				if (href) return opfDir + href;
			}
		}

		// 2. <item properties="cover-image"/>
		const coverItem = allItems.find(
			(el) => el.getAttribute("properties") === "cover-image",
		);
		if (coverItem) {
			const href = coverItem.getAttribute("href");
			if (href) return opfDir + href;
		}

		// 3. <guide> <reference type="cover"/> que apunte a imagen
		const refs = Array.from(opfDoc.getElementsByTagName("reference"));
		const guideRef = refs.find((r) => r.getAttribute("type") === "cover");
		if (guideRef) {
			const href = guideRef.getAttribute("href")?.split("#")[0];
			if (href && /\.(jpe?g|png|gif|webp|svg)$/i.test(href)) {
				return opfDir + href;
			}
		}

		// 4. Cualquier imagen en manifest con "cover" en id o href
		for (const item of allItems) {
			const id = item.getAttribute("id") ?? "";
			const href = item.getAttribute("href") ?? "";
			const mt = item.getAttribute("media-type") ?? "";
			if (
				mt.startsWith("image/") &&
				(id.toLowerCase().includes("cover") ||
					href.toLowerCase().includes("cover"))
			) {
				return opfDir + href;
			}
		}
		return null;
	}

	private static getMimeType(filePath: string): string {
		const ext = filePath.split(".").pop()?.toLowerCase();
		const map: Record<string, string> = {
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			png: "image/png",
			gif: "image/gif",
			webp: "image/webp",
			svg: "image/svg+xml",
		};
		return map[ext ?? ""] ?? "image/jpeg";
	}

	private static emptyMetadata(): EpubMetadata {
		return {
			title: "",
			author: "",
			genre: "",
			synopsis: "",
			publishDate: "",
			language: "",
			publisher: "",
			isbn: "",
			coverBase64: null,
			coverMimeType: null,
		};
	}
}
