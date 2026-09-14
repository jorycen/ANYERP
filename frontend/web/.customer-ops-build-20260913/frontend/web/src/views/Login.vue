<template>
  <div class="login-container">
    <section class="brand-panel">
      <div class="brand-content">
        <div class="brand-name">
          <span class="brand-logo-tile"><img src="/brand/aino-cloud-logo.jpg" alt="艾诺云标志"></span>
          <div class="brand-system-name"><strong>艾诺云</strong><small>ANY-ERP 连锁经营管理平台</small></div>
        </div>
        <div class="brand-message">
          <p class="brand-kicker">连锁经营管理平台</p>
          <h1>让门店经营数据<br>清晰、准确、可追溯</h1>
          <p class="brand-description">统一管理销售、库存、采购、财务与经营分析，帮助团队更快完成每天的关键工作。</p>
        </div>
        <div class="brand-points">
          <span>多门店协同</span>
          <span>业务全流程</span>
          <span>数据实时可查</span>
        </div>
      </div>
      <div class="brand-glow glow-one"></div>
      <div class="brand-glow glow-two"></div>
    </section>

    <section class="login-panel">
      <div class="login-box">
        <img class="company-wordmark" src="/brand/aino-cloud-wordmark.png" alt="成都艾诺云科技有限公司">
        <div class="login-header">
          <p>欢迎回来</p>
          <h2>登录 ANY-ERP</h2>
          <span>使用你的员工账号进入系统</span>
        </div>
        <el-form ref="formRef" :model="form" :rules="rules" class="login-form" label-position="top">
          <el-form-item prop="phone" label="手机号">
            <el-input v-model="form.phone" placeholder="请输入手机号" size="large" :prefix-icon="User" autocomplete="username" />
          </el-form-item>
          <el-form-item prop="password" label="密码">
            <el-input v-model="form.password" type="password" show-password placeholder="请输入密码" size="large" :prefix-icon="Lock" autocomplete="current-password" @keyup.enter="handleLogin" />
          </el-form-item>
          <el-form-item class="login-action">
            <el-button type="primary" size="large" :loading="loading" class="login-button" @click="handleLogin">登录系统</el-button>
          </el-form-item>
        </el-form>
        <p class="login-support">账号或权限问题请联系系统管理员</p>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { User, Lock } from '@element-plus/icons-vue'
import api from '../api'

const router = useRouter()
const formRef = ref(null)
const loading = ref(false)

const form = reactive({
  phone: '',
  password: ''
})

onMounted(() => {
  localStorage.removeItem('token')
  localStorage.removeItem('userInfo')
})

const rules = {
  phone: [{ required: true, message: '请输入手机号', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }]
}

const handleLogin = async () => {
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return

  loading.value = true
  try {
    const res = await api.login(form)
    if (res.code === 0 && res.data) {
      localStorage.setItem('token', res.data.token)
      localStorage.setItem('userInfo', JSON.stringify(res.data.userInfo))
      ElMessage.success('登录成功')
      router.push('/')
    } else {
      ElMessage.error(res.message || '登录失败')
    }
  } catch (err) {
    ElMessage.error(err.response?.data?.message || err.message || '登录失败')
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-container {
  width: 100%;
  min-height: 100vh;
  display: flex;
  background: #fff;
}

.brand-panel {
  position: relative;
  display: flex;
  flex: 1.1;
  min-width: 560px;
  overflow: hidden;
  color: #fff;
  background: linear-gradient(145deg, #101828 0%, #172554 55%, #1e3a8a 100%);
}

.brand-content {
  position: relative;
  z-index: 2;
  display: flex;
  width: min(680px, 82%);
  min-height: 100%;
  margin: 0 auto;
  padding: 54px 0 58px;
  flex-direction: column;
}

.brand-name { display: flex; align-items: center; gap: 13px; }
.brand-logo-tile { display: inline-flex; width: 50px; height: 50px; align-items: center; justify-content: center; overflow: hidden; border-radius: 12px; background: #fff; box-shadow: 0 8px 24px rgba(0, 0, 0, .16); }
.brand-logo-tile img { width: 44px; height: 44px; object-fit: contain; }
.brand-system-name { display: flex; flex-direction: column; }
.brand-system-name strong { color: #fff; font-size: 20px; font-weight: 700; letter-spacing: .04em; }
.brand-system-name small { margin-top: 3px; color: #a9b9d2; font-size: 11px; letter-spacing: .03em; }
.brand-message { margin: auto 0; }
.brand-kicker { margin-bottom: 18px; color: #93c5fd; font-size: 14px; font-weight: 600; letter-spacing: .12em; }
.brand-message h1 { max-width: 620px; margin: 0; font-size: clamp(38px, 4vw, 58px); font-weight: 650; line-height: 1.2; letter-spacing: -.035em; }
.brand-description { max-width: 550px; margin-top: 26px; color: #cbd5e1; font-size: 17px; line-height: 1.8; }
.brand-points { display: flex; flex-wrap: wrap; gap: 10px; }
.brand-points span { padding: 7px 12px; border: 1px solid rgba(255, 255, 255, .14); border-radius: 999px; color: #dbeafe; background: rgba(255, 255, 255, .06); font-size: 12px; }
.brand-glow { position: absolute; border-radius: 50%; filter: blur(2px); pointer-events: none; }
.glow-one { right: -120px; top: 18%; width: 360px; height: 360px; background: rgba(37, 99, 235, .3); }
.glow-two { left: 12%; bottom: -190px; width: 420px; height: 420px; background: rgba(14, 165, 233, .12); }

.login-panel {
  display: flex;
  flex: .9;
  min-width: 500px;
  align-items: center;
  justify-content: center;
  padding: 48px;
  background: #fff;
}

.login-box {
  width: 100%;
  max-width: 390px;
}

.company-wordmark { display: block; width: min(100%, 350px); height: auto; margin: 0 0 36px; }

.login-header {
  margin-bottom: 34px;
}

.login-header p { margin-bottom: 8px; color: #2563eb; font-size: 13px; font-weight: 650; }
.login-header h2 { margin: 0; color: #182230; font-size: 30px; font-weight: 680; letter-spacing: -.025em; }
.login-header span { display: block; margin-top: 10px; color: #667085; font-size: 14px; }

.login-form :deep(.el-form-item) { margin-bottom: 22px; }
.login-form :deep(.el-form-item__label) { padding-bottom: 8px; color: #344054; font-size: 13px; font-weight: 600; }
.login-form :deep(.el-input__wrapper) { min-height: 46px; padding-inline: 13px; border-radius: 8px; }
.login-action { margin-top: 30px; margin-bottom: 0 !important; }

.login-button {
  width: 100%;
  height: 46px;
  border-radius: 8px;
  font-size: 15px;
  font-weight: 600;
}

.login-support { margin-top: 22px; color: #98a2b3; text-align: center; font-size: 12px; }

@media (max-width: 1100px) {
  .brand-panel { min-width: 470px; }
  .login-panel { min-width: 430px; padding: 40px; }
}

@media (max-width: 760px) {
  .login-container { min-width: 0; }
  .brand-panel { display: none; }
  .login-panel { min-width: 0; padding: 28px; background: #f4f6fa; }
  .login-box { padding: 30px 26px; border: 1px solid #e4e7ec; border-radius: 14px; background: #fff; box-shadow: 0 12px 30px rgba(16, 24, 40, .08); }
  .company-wordmark { width: min(100%, 300px); margin-bottom: 28px; }
}
</style>
