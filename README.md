# STL ArUco Embedder

A browser-based PWA for embedding ArUco markers into STL files and scanning them with a camera. Runs entirely offline — no server, no login, no data leaves your device.

## What it does

1. **Embed** — Upload an STL file, choose a placement preset (floor, top, bottom) or position the marker manually, then generate a print-ready STL with the ArUco pattern carved in.
2. **Scan** — Point your phone or webcam at a printed part. The app detects the ArUco marker and looks up the part in your local library.
3. **Library** — All parts are stored in your browser (IndexedDB). Export your entire library as a ZIP and import it on another device.

## Tech stack

| | |
|---|---|
| UI | React 19 + TypeScript + Tailwind CSS |
| Bundler | Vite 8 (Rolldown) |
| 3D | Three.js r185 |
| Boolean ops | manifold-3d (WASM) |
| ArUco detection | js-aruco2 (loaded via script tag) |
| Database | Dexie.js v4 (IndexedDB) |
| PWA | vite-plugin-pwa + Workbox |

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Build

```bash
npm run build
```

Output goes to `dist/`. Can be served from any static host (GitHub Pages, Netlify, etc.).

## Sample files

The `sample/` directory contains a test STL and photos showing a printed Benchy with an embedded ArUco marker scanned from the bottom face.

## Author

Kağan ŞAHİN
