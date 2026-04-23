import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: './',
  build: {
    outDir: 'dist'
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'https://cloud1-249791-6-1410946266.sh.run.tcloudbase.com',
        changeOrigin: true,
        secure: false
      }
    }
  }
})
