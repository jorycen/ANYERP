<template>
  <el-sub-menu v-if="hasChildren" :index="menu.menuCode">
    <template #title>
      <el-icon><component :is="iconMap[menu.icon] || House" /></el-icon>
      <span>{{ menu.name }}</span>
    </template>
    <SidebarMenuItem
      v-for="child in menu.children"
      :key="child.menuCode"
      :menu="child"
      :icon-map="iconMap"
    />
  </el-sub-menu>
  <el-menu-item v-else :index="menu.path || menu.menuCode">
    <el-icon><component :is="iconMap[menu.icon] || House" /></el-icon>
    <span>{{ menu.name }}</span>
  </el-menu-item>
</template>

<script setup>
import { computed } from 'vue'
import { House } from '@element-plus/icons-vue'

defineOptions({ name: 'SidebarMenuItem' })

const props = defineProps({
  menu: { type: Object, required: true },
  iconMap: { type: Object, required: true }
})

const hasChildren = computed(() => Array.isArray(props.menu.children) && props.menu.children.length > 0)
</script>
