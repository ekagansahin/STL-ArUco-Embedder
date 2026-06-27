# STL ArUco Embedder

> A browser-based PWA that carves ArUco fiducial markers into STL files and scans them back with a camera — fully offline, no server, no login.

![Demo](sample/Benchy_modified.jpeg)

---

## Overview

3D-printed parts are difficult to identify once removed from the printer. Labels fall off, similar-looking parts get mixed up, and tracking material or print settings after the fact is tedious.

**STL ArUco Embedder** solves this by permanently embedding an ArUco marker into the bottom face of any STL file before printing. The marker is carved directly into the geometry using boolean subtraction. After printing, a phone camera can scan the part and instantly retrieve its name, material, notes, and creation date from a local database.

Everything runs in the browser. No data is sent anywhere.

---

## Screenshots

| Embedder | Scanner | Library |
|---|---|---|
| *(screenshot)* | *(screenshot)* | *(screenshot)* |

> **Contributing screenshots:** Run the app locally, take screenshots of each tab, and open a PR adding them to `sample/screenshots/`.

---

## How it works

### 1. Embed

Upload any binary or ASCII STL file. The app analyses the mesh and suggests placement presets based on the geometry:

- **Floor** — bottom face (recommended for flat-bottom parts)
- **Top** — top face
- **Bottom** — inverted bottom

You can also position and resize the marker manually using sliders. When you click **Embed ArUco & Download**, the app:

1. Rotates the mesh to the chosen orientation
2. Generates the ArUco pattern for the next available ID (4×4, 1000-marker dictionary)
3. Performs a boolean subtraction using [manifold-3d](https://github.com/elalish/manifold) (WASM) to carve the pattern into the surface
4. Exports the result as a print-ready STL and saves both the original and print-ready files to IndexedDB

### 2. Scan

Open the Scanner tab and point your camera at a printed part. The app reads frames in real time using [js-aruco2](https://github.com/nicolasalber/js-aruco2) and draws a green polygon around detected markers. On detection it queries the local database and displays the part's details.

Works with the rear camera on mobile devices.

### 3. Library

All parts are stored locally in IndexedDB (via [Dexie.js](https://dexie.org/)). The Library tab shows all saved parts with options to:

- Download the original or print-ready STL for any part
- Export the entire library as a ZIP (one folder per part + a `database.json` metadata file)
- Import a previously exported ZIP on another device
- Clear all data

---

## Tech stack

| Layer | Technology |
|---|---|
| UI framework | React 19 + TypeScript |
| Styling | Tailwind CSS v4 |
| Bundler | Vite 8 (Rolldown) |
| 3D rendering | Three.js r185 + OrbitControls |
| Boolean subtraction | manifold-3d (WASM) |
| ArUco detection | js-aruco2 (script-tag loaded, CJS-incompatible with Vite) |
| Local database | Dexie.js v4 (IndexedDB) |
| ZIP export/import | JSZip |
| PWA | vite-plugin-pwa + Workbox |

---

## Getting started

### Prerequisites

- Node.js 18+
- npm 9+

### Install & run

```bash
git clone https://github.com/ekagansahin/STL-ArUco-Embedder.git
cd STL-ArUco-Embedder
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

For mobile testing on the same network:

```bash
npm run dev -- --host
```

Then open the displayed network URL on your phone.

### Build

```bash
npm run build
```

Output goes to `dist/`. Deploy to any static host.

---


## License

MIT — see [LICENSE](LICENSE).

---

## Author

**E. Kağan ŞAHİN**
