<script setup>
import { ref, onMounted, onUnmounted } from "vue";

/**
 * 实验页启动遮罩：一秒钟的「设备上电」仪式感。
 * 纯展示组件 —— 只负责进场动画与自动退场，不碰实验状态。
 */
defineProps({
  def: { type: Object, required: true }
});
const emit = defineEmits(["done"]);

const leaving = ref(false);
let t1 = 0, t2 = 0;

const reduce = typeof window !== "undefined" && window.matchMedia
  ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
  : false;

onMounted(function(){
  if(reduce){ emit("done"); return; }
  t1 = setTimeout(function(){ leaving.value = true; }, 880);
  t2 = setTimeout(function(){ emit("done"); }, 1150);
});

onUnmounted(function(){
  clearTimeout(t1);
  clearTimeout(t2);
});
</script>

<template>
  <div class="boot-veil" :class="{ out: leaving }">
    <div class="boot-grid"></div>
    <div class="boot-glow"></div>

    <div class="boot-core">
      <div class="boot-tag">
        <i></i>NETLAB · LAB {{ def.id }}
      </div>
      <div class="boot-title">{{ def.title }}</div>
      <div class="boot-meta">{{ def.meta }}</div>

      <div class="boot-bar"><i></i></div>

      <div class="boot-steps">
        <span>载入拓扑</span>
        <span>挂载命令表</span>
        <span>同步板块状态</span>
      </div>
    </div>

    <div class="boot-foot">{{ def.stageLabel }}</div>
  </div>
</template>
