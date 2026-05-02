/**
 * vite.vendor.config.js
 * ──────────────────────────────────────────────────────────
 * Separate Vite config for building the vendor globals bundle.
 *
 * Usage:
 *   cd apps/web
 *   npm run build:vendor
 *
 * Output: C:\Users\aidan\Desktop\Argus\vendor\vendor.js
 * Served:  /vendor/vendor.js  (Netlify publish = ".")
 *
 * Format: IIFE — executes immediately like a synchronous <script src>.
 * This is required because the main index.html has inline scripts that
 * reference window.THREE and window.ThreeGlobe without any deferred init.
 * A <script type="module"> would run after those inline scripts — wrong order.
 * An IIFE script runs synchronously during HTML parsing — correct order.
 * ──────────────────────────────────────────────────────────
 */

import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry:   './src/vendor-globals.js',
      name:    'ArgusVendor',
      formats: ['iife'],
      fileName: () => 'vendor.js',
    },
    outDir:      '../../vendor',
    emptyOutDir: false,   // don't wipe other files in vendor/ if any
    minify:      true,
    rollupOptions: {
      output: {
        sourcemap: false,
      },
    },
  },
});
