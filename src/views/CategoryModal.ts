import { App, Modal, Setting } from "obsidian";

export class CategoryModal extends Modal {
	private result: string = "";
	private onSubmit: (result: string) => void;

	constructor(app: App, onSubmit: (result: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "New Category" });

		new Setting(contentEl)
			.setName("Category name")
			.addText((text) =>
				text.onChange((value) => {
					this.result = value;
				}),
			);

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText("Create")
				.setCta() // Le da el color de acento de Obsidian
				.onClick(() => {
					if (this.result.trim()) {
						this.close();
						this.onSubmit(this.result.trim());
					}
				}),
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}
