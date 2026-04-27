import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Lock the dev port so Tauri's webview always finds the bundle.
// strictPort makes vite fail loudly if 1420 is taken instead of silently
// drifting to 5174 (which leaves Tauri staring at an empty 5173).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
})
