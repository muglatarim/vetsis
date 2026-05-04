import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: '/vetsis/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'icons/*.png'],
      manifest: {
        name: 'VETSİS — Saha Kampanya Yönetimi',
        short_name: 'VETSİS',
        description: 'Veteriner saha aşılama ve küpeleme kampanya yönetim sistemi',
        theme_color: '#1a5276',
        background_color: '#0d1b2a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/vetsis/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        runtimeCaching: [
          {
            // Supabase API isteklerini önbelleğe alma (offline için)
            urlPattern: /^https:\/\/ulwntnofjziidvrfqbca\.supabase\.co\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-cache',
              expiration: { maxEntries: 200, maxAgeSeconds: 86400 }
            }
          }
        ]
      }
    })
  ],
  server: {
    port: 8080,
    host: true
  },
  preview: {
    port: 8080
  }
})
