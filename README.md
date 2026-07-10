# Axis

**General-purpose comparison & ranking tool**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Built with Tauri](https://img.shields.io/badge/Built%20with-Tauri-24C8DB?logo=tauri&logoColor=white)](https://tauri.app)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-informational)](https://github.com/PR0Gorib/Axis/releases)

![Main View](assets/Axis-main.png)

Axis is an open-source desktop application built with HTML, CSS, JavaScript, and Tauri that lets you compare, rank, and organize virtually anything.

Games, movies, anime, phones, PC hardware, books, cars — if it can be rated, it can be ranked.

---

## Download

Grab the latest build for your platform from the **[Releases page](https://github.com/PR0Gorib/Axis/releases)** — no build step required.

---

## Screenshots

<table>
  <tr>
    <td width="50%">
      <img src="assets/Axis-compare.png" alt="Compare view with radar chart"><br>
      <sub><b>Side-by-side comparison with radar chart</b></sub>
    </td>
    <td width="50%">
      <img src="assets/Axis-panel.png" alt="Item detail panel"><br>
      <sub><b>Item detail panel — images, tags & stats</b></sub>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="assets/Axis-light_theme.png" alt="Light mode"><br>
      <sub><b>Light mode</b></sub>
    </td>
    <td width="50%">
      <img src="assets/Axis-settings.png" alt="Settings panel"><br>
      <sub><b>Settings panel</b></sub>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="assets/Axis-share.png" alt="Share as image export"><br>
      <sub><b>Share-as-image export</b></sub>
    </td>
    <td width="50%">
      <img src="assets/Axis-list.png" alt="List view"><br>
      <sub><b>List view</b></sub>
    </td>
  </tr>
</table>

---

## Features

- 📊 Custom ranking categories
- ⚖️ Side-by-side comparison mode
- 📈 Radar & bar chart visualizations
- 🏆 Dynamic rankings, podiums & score tiers
- 🖼️ Advanced image manager (up to 5 images per item)
- 💾 Automatic backups & restore manager
- 🧮 Bulk stat editing tools
- ⌨️ Keyboard shortcuts
- ⚙️ Centralized settings panel
- 🔍 Search, tags & advanced filtering
- 📋 Category templates
- 📤 Beautiful Share as Image exports
- 📌 Favorites / pinned items
- 🌙 Dark & Light themes
- 🖥️ Native desktop app via Tauri
- 🔒 Fully offline & privacy-friendly

---

## Built With

- HTML
- CSS
- JavaScript
- Tauri

### Required Tauri Plugins

```rust
tauri_plugin_opener
tauri_plugin_fs
tauri_plugin_dialog
```

---

## Development

### Prerequisites

Before building from source, make sure you have:

- [Node.js](https://nodejs.org/) (LTS recommended)
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- Platform-specific Tauri dependencies — see the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/) for your OS (e.g. WebView2 on Windows, `webkit2gtk` on Linux)

### Setup

```bash
git clone https://github.com/PR0Gorib/Axis.git
cd Axis
npm install
npm run tauri dev
```

### Build a release

```bash
npm run tauri build
```

The built installer/binary will be under `src-tauri/target/release/`.

---

## Project Structure

```text
Axis/
├── src/
│   ├── index.html
│   ├── storage.js
│   └── tauri-close-guard.js
├── src-tauri/
├── package.json
└── icon.png
```

---

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

---

## Contributing

Issues and pull requests are welcome. If you're changing UI, please test both light and dark mode before submitting.

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
