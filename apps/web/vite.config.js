import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  server: {
    // Proxy /adsb/* -> https://api.adsb.fi/*
    // /adsb/api/v2/lat/40/lon/-75/dist/249 -> https://api.adsb.fi/api/v2/lat/40/lon/-75/dist/249
    // Only active during `vite dev`. Has no effect in production builds.
    proxy: {
      '/adsb': {
        target:       'https://opendata.adsb.fi',
        changeOrigin: true,
        secure:       true,
        rewrite:      (path) => path.replace(/^\/adsb/, ''),
      },
    },
  },
})
