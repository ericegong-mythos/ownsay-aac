import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const APP_VERSION = '1.0.0'

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      minify: false,
      includeAssets: ['favicon.svg', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'],
      manifest: {
        id: '/',
        name: 'OwnSay',
        short_name: 'OwnSay',
        description: 'A calm paediatric communication board with five everyday worlds and optional on-device intelligence.',
        theme_color: '#0B1F3A',
        background_color: '#EEF2F6',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        lang: 'en-GB',
        categories: ['education', 'medical'],
        icons: [
          {
            src: 'icons/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Explicit OwnSay shell identity: the precache name starts with
        // "ownsay-", which the Device Check uses as offline-shell evidence
        // (diagnostic "ownsay-diag-*" caches are excluded there).
        cacheId: 'ownsay',
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        // Model/runtime chunks and the social image are not part of the
        // deterministic offline communication shell.
        globIgnores: ['**/*webllm*', 'og.png'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: '/index.html',
        runtimeCaching: [],
        mode: 'production',
      },
    }),
  ],
  build: {
    // A portable static PWA that can be served by Vercel, Netlify, Cloudflare
    // Pages, or any HTTPS host with an index.html navigation fallback.
    outDir: 'dist/client',
    // Conservative engine floor (Fire-tablet-era Chromium / Silk): esbuild
    // transpiles syntax beyond Chrome 110. CSS keeps hand-written fallbacks
    // for color-mix() and modern media syntax on top of this target.
    target: 'chrome110',
    chunkSizeWarningLimit: 6200,
    rollupOptions: {
      output: {
        // Name the lazy WebLLM chunk so it stays recognisable and outside the
        // service-worker precache. Do NOT force it together with shared
        // modules via manualChunks: that hoists Vite's preload helper into
        // the chunk and makes the entry statically import megabytes of model
        // code on every load.
        chunkFileNames(chunkInfo) {
          const moduleIds = [...chunkInfo.moduleIds].join(' ')
          if (moduleIds.includes('@mlc-ai/web-llm') || moduleIds.includes('webllm-loader')) {
            return 'assets/webllm-[name]-[hash].js'
          }
          return 'assets/[name]-[hash].js'
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    globals: false,
    restoreMocks: true,
    exclude: ['**/node_modules/**', 'e2e/**', 'dist/**'],
  },
})
