import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// The API worker's address is a dev-server concern only: the browser always
// talks to relative `/api/...` URLs and Vite proxies them here. Override with
// LINESCOUT_API_URL / VITE_HOST in the environment or a local .env file.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, new URL('.', import.meta.url).pathname, ['LINESCOUT_', 'VITE_'])
  return {
    plugins: [react()],
    server: {
      host: env.VITE_HOST ?? '127.0.0.1',
      port: 5173,
      allowedHosts: true,
      proxy: {
        '/api': { target: env.LINESCOUT_API_URL ?? 'http://127.0.0.1:8000', changeOrigin: true },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
      css: true,
      include: ['src/**/*.test.{ts,tsx}'],
    },
  }
})
