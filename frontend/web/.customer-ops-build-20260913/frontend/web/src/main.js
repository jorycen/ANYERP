import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus, { ElMessage } from 'element-plus'
import 'element-plus/dist/index.css'
import './styles/theme.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import App from './App.vue'
import router from './router'

const app = createApp(App)

// Register Element Plus icons
for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, component)
}

app.use(createPinia())
app.use(router)
app.use(ElementPlus)

let lastRuntimeErrorAt = 0
app.config.errorHandler = (error, instance, info) => {
  console.error('[Vue Runtime Error]', info, error)
  const now = Date.now()
  if (now - lastRuntimeErrorAt > 2000) {
    lastRuntimeErrorAt = now
    ElMessage.error(`页面运行异常：${error?.message || '未知错误'}`)
  }
}

router.onError(error => {
  console.error('[Router Error]', error)
  ElMessage.error(`页面切换失败：${error?.message || '未知错误'}`)
})

app.mount('#app')
