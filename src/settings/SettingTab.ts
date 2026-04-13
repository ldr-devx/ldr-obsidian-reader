// ============================================================
// src/settings/SettingTab.ts
// Plugin settings panel in Obsidian Settings.
// ============================================================

import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type LdrEpubReaderPlugin from "../../main";

export class LdrSettingTab extends PluginSettingTab {
	plugin: LdrEpubReaderPlugin;

	constructor(app: App, plugin: LdrEpubReaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ── HEADER ──────────────────────────────────────────────
		containerEl.createEl("h2", { text: "LDR | Reader" });
		containerEl.createEl("p", {
			text: "Read .epub books and .cbz comics directly inside your vault.",
			cls: "setting-item-description",
		});

		// ── LIBRARY ──────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Library" });

		new Setting(containerEl)
			.setName("Books folder")
			.setDesc(
				"Vault-relative path where your .epub and .cbz files are stored. " +
					"The plugin scans this folder automatically on load.",
			)
			.addText((text) => {
				text
					.setPlaceholder("Books")
					.setValue(this.plugin.store.getLibraryFolder())
					.onChange(async (value) => {
						const trimmed = value.trim().replace(/\/$/, "");
						await this.plugin.store.updateSettings({
							libraryFolder: trimmed || "Books",
						});
					});
			});

		new Setting(containerEl)
			.setName("Update library")
			.setDesc(
				"Manually search for new .epub and .cbz files in the configured folder.",
			)
			.addButton((btn) => {
				btn
					.setButtonText("Scan now")
					.setCta()
					.onClick(async () => {
						btn.setButtonText("Scanning…").setDisabled(true);
						try {
							await this.plugin.scanner.scan(false);
							this.display(); // refresh counts
						} finally {
							btn.setButtonText("Scan now").setDisabled(false);
						}
					});
			});

		// ── INFORMATION ──────────────────────────────────────────
		containerEl.createEl("h3", { text: "Information" });

		const allBooks = this.plugin.store.getAllBooks();
		const epubCount = allBooks.filter(
			(b) => !b.contentType || b.contentType === "epub",
		).length;
		const cbzCount = allBooks.filter(
			(b) => b.contentType === "cbz",
		).length;

		new Setting(containerEl)
			.setName("Indexed items")
			.setDesc(
				`${epubCount} EPUB · ${cbzCount} CBZ · ${allBooks.length} total`,
			)
			.addExtraButton((btn) => {
				btn
					.setIcon("refresh-cw")
					.setTooltip("Refresh count")
					.onClick(() => this.display());
			});

		// ── COMICS ───────────────────────────────────────────────
		containerEl.createEl("h3", { text: "Comics" });

		const comicSettings = this.plugin.store.getComicReaderSettings();

		new Setting(containerEl)
			.setName("Default reading mode")
			.setDesc(
				"Mode used when opening a CBZ for the first time. Each book remembers its last mode.",
			)
			.addDropdown((d) => {
				d.addOption("paginated", "Single page")
					.addOption("webtoon", "Scroll (webtoon)")
					.addOption("double", "Double page")
					.setValue(comicSettings.readingMode)
					.onChange(async (v) => {
						await this.plugin.store.updateComicReaderSettings({
							readingMode: v as "paginated" | "webtoon" | "double",
						});
					});
			});

		new Setting(containerEl)
			.setName("Default fit mode")
			.setDesc("How images are scaled when opening a comic.")
			.addDropdown((d) => {
				d.addOption("width", "Fit to width")
					.addOption("height", "Fit to height")
					.addOption("contain", "Fit full page")
					.addOption("original", "Original size (1:1)")
					.setValue(comicSettings.fitMode)
					.onChange(async (v) => {
						await this.plugin.store.updateComicReaderSettings({
							fitMode: v as "width" | "height" | "contain" | "original",
						});
					});
			});

		new Setting(containerEl)
			.setName("Auto double page in landscape")
			.setDesc(
				"Automatically switch to double page mode when the screen is wider than tall.",
			)
			.addToggle((t) => {
				t.setValue(comicSettings.autoDoubleOnLandscape).onChange(
					async (v) => {
						await this.plugin.store.updateComicReaderSettings({
							autoDoubleOnLandscape: v,
						});
					},
				);
			});

		new Setting(containerEl)
			.setName("Background color")
			.setDesc("Color behind comic pages. Accepts any CSS color (e.g. #000000, #1a1a2e).")
			.addText((t) => {
				t.setPlaceholder("#000000")
					.setValue(comicSettings.backgroundColor)
					.onChange(async (v) => {
						const color = v.trim();
						if (/^#[0-9a-fA-F]{3,8}$/.test(color) || CSS.supports("color", color)) {
							await this.plugin.store.updateComicReaderSettings({
								backgroundColor: color,
							});
						}
					});
			});

		new Setting(containerEl)
			.setName("Preload pages")
			.setDesc(
				"Number of pages to preload ahead and behind the current page (desktop). Mobile uses 2.",
			)
			.addSlider((s) => {
				s.setLimits(1, 8, 1)
					.setValue(comicSettings.preloadPages)
					.setDynamicTooltip()
					.onChange(async (v) => {
						await this.plugin.store.updateComicReaderSettings({
							preloadPages: v,
						});
					});
			});

		// ── DANGER ZONE ──────────────────────────────────────────
		containerEl.createEl("h3", { text: "Danger zone" });

		new Setting(containerEl)
			.setName("Clear library")
			.setDesc(
				"Removes all library data (books, reading progress, categories). " +
					"Your .epub and .cbz files are NOT deleted from the vault.",
			)
			.addButton((btn) => {
				btn
					.setButtonText("Clear all data")
					.setWarning()
					.onClick(async () => {
						const confirmed = window.confirm(
							"Are you sure? All library data, reading progress, and categories will be removed. " +
								"Your files will remain intact.",
						);
						if (!confirmed) return;
						await this.plugin.store.clearAll();
						new Notice("LDR Reader: Library cleared.", 4000);
						this.display();
					});
			});
	}
}
