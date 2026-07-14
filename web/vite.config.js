import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(() => {
  const proxyTarget = process.env.VITE_API_PROXY_TARGET || 'https://cloud1-249791-6-1410946266.sh.run.tcloudbase.com'
  return {
    plugins: [vue()],
    // Keep the legacy frontend build aligned with the production frontend.
    base: '/',
    build: {
      outDir: 'dist'
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: proxyTarget,
          changeOrigin: true,
          secure: false
        }
      }
    }
  }
})
