import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import fs from 'node:fs'
import path from 'node:path'

function historyRouteFallbacks() {
  let outputDirectory = ''
  let routerFile = ''

  return {
    name: 'history-route-fallbacks',
    apply: 'build',
    configResolved(config) {
      outputDirectory = path.resolve(config.root, config.build.outDir)
      routerFile = path.resolve(config.root, 'src/router/index.js')
    },
    closeBundle() {
      const entryFile = path.join(outputDirectory, 'index.html')
      if (!fs.existsSync(entryFile) || !fs.existsSync(routerFile)) return

      const routeSource = fs.readFileSync(routerFile, 'utf8')
      const routePaths = [...routeSource.matchAll(/path:\s*['"]([^'"]+)['"]/g)]
        .map(([, routePath]) => routePath)
        .filter((routePath) => routePath && routePath !== '/' && !routePath.includes(':'))
        .map((routePath) => routePath.replace(/^\//, ''))

      for (const routePath of new Set(routePaths)) {
        const routeDirectory = path.join(outputDirectory, ...routePath.split('/'))
        fs.mkdirSync(routeDirectory, { recursive: true })
        fs.copyFileSync(entryFile, path.join(routeDirectory, 'index.html'))
      }
    }
  }
}

export default defineConfig({
  plugins: [vue(), historyRouteFallbacks()],
  // The site is deployed at the domain root. Use absolute asset URLs so
  // refreshing any History-mode route does not resolve assets under that route.
  base: '/',
  build: {
    outDir: 'dist'
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        secure: false
      }
    }
  }
})
