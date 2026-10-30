import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/STL-ArUco-Embedder/',
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png', 'favicon.svg'],
      manifest: {
        name: 'ArUco Embedder',
        short_name: 'ArUco',
        description: 'Embed ArUco markers into STL files and identify printed parts with a webcam',
        theme_color: '#0f0f0f',
        background_color: '#0f0f0f',
        display: 'standalone',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,wasm,json,png,svg}'],
        // opencv.js (~13 MB) is kept OUT of the precache so it doesn't bloat the
        // first load. It enters the runtime cache on first scanner use
        // (CacheFirst below) and works offline from then on.
        globIgnores: ['**/opencv/opencv.js'],
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
        runtimeCaching: [
          {
            urlPattern: /\/opencv\/opencv\.js$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'opencv-runtime',
              expiration: { maxEntries: 2 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  optimizeDeps: {
    // manifold-3d ESM module — exclude it from Vite's dependency pre-bundling
    exclude: ['manifold-3d'],
  },
  build: {
    target: 'esnext', // required for WASM + top-level await
  },
})
