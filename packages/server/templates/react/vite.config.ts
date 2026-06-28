import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Runs inside the project's Docker container (see @cascade/server PreviewManager).
const hmrClientPort = process.env.VITE_HMR_CLIENT_PORT ? Number(process.env.VITE_HMR_CLIENT_PORT) : undefined

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    // The project dir is a host bind-mount; native fs events don't cross it, so poll for edits.
    watch: { usePolling: true, interval: 120 },
    // The dev server is published on a random host port; tell the HMR client to use it (else it tries 5173).
    hmr: hmrClientPort ? { clientPort: hmrClientPort } : true,
  },
})
