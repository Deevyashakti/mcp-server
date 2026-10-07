import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Must match PORT in backend/.env (5001 is used by the DivOS backend).
const API_TARGET = 'http://localhost:5050'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': API_TARGET,
      '/health': API_TARGET,
    },
  },
})
