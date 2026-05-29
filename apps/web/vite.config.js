import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  server: {
    // Phase 2 proxy — activated automatically by adsbDiagnostic.js if direct
    // fetch fails with a CORS error. Maps /adsb/* → opendata.adsb.fi/*.
    // Only active during `vite dev`. Has no effect in production builds.
    proxy: {
      '/adsb': {
        target:      'https://opendata.adsb.fi',
        changeOrigin: true,
        rewrite:     (path) => path.replace(/^\/adsb/, ''),
      },
    },
  },
})
