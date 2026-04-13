# LDR | Epub Reader

A minimal plugin to read `.epub` files directly inside Obsidian.

**Current status:** Sprint 0 — Core foundations (no UI yet)

---

## Quick Setup

### 1. Clone and install

```bash
git clone https://github.com/ldr-devx/ldr-obsidian-epub-reader
cd ldr-obsidian-epub-reader
npm install
```

### 2. Development with hot-reload

```bash
npm run dev
```

### 3. Install in Obsidian (development)

Copy the project folder (or create a symlink) inside your vault:

```
YourVault/.obsidian/plugins/ldr-obsidian-epub-reader/
```

Required files: `main.js`, `manifest.json`, `styles.css` (once it exists).

Then in Obsidian: **Settings → Community plugins → Installed plugins → enable LDR Epub Reader**.

### 4. Configure the books folder

**Settings → LDR Epub Reader → Books folder**

Default is `Books`. Place your `.epub` files there and the plugin will detect them automatically.

---

## Project Structure

```
ldr-obsidian-epub-reader/
├── src/
│   ├── core/
│   │   ├── DataStore.ts       # Data persistence
│   │   ├── EpubParser.ts      # OPF metadata extraction
│   │   └── LibraryScanner.ts  # Vault folder scanning
│   ├── views/                 # (Phase 1+) HomeView, ReaderView
│   ├── components/            # (Phase 1+) UI components
│   ├── settings/
│   │   └── SettingTab.ts      # Settings panel
│   ├── models/
│   │   └── index.ts           # TypeScript interfaces
│   └── styles/                # (Phase 1+) Plugin CSS
├── assets/fonts/              # (Phase 3) Bundled fonts
├── main.ts                    # Entry point
├── manifest.json
└── package.json
```

---

## Development Phases

| Phase | Contents | Status |
|-------|----------|--------|
| **0** | Setup, models, scanner, DataStore | In progress |
| **1** | HomeView, library, Top 10, Bookshelf | Pending |
| **2** | ReaderView, pagination, page flip | Pending |
| **3** | Settings panel, fonts, chapters | Pending |
| **4** | Fullscreen, mobile, search | Pending |
| **5** | Testing, polish, release | Pending |

---

## Available Commands (Sprint 0)

- `LDR Epub Reader: Open book library`
- `LDR Epub Reader: Scan books folder`
- `LDR Epub Reader: Open active epub in reader`

---

## License

MIT License — see [LICENSE](LICENSE) for details.

---

Made by [LDR_Dev](https://github.com/ldr-devx)
