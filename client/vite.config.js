import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      usePolling: process.env.WATCH_POLL === 'true',
      interval: 100,
    },
    hmr: {
      clientPort: 5173,
    },
  },
})