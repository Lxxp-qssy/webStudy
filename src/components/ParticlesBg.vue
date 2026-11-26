<script setup>
/**
 * 动态背景：网络星图（tsParticles slim）
 * -------------------------------------------------------------------------
 * 低速漂移的节点 + 就近亮起的连线，语义贴合「网络设备互联」的主题；
 * 固定铺底、零鼠标/点击交互、整体低透明度 —— 只做氛围，不抢内容、不影响命令输入。
 * prefers-reduced-motion 用户直接不渲染粒子，退回静态背景。
 */
import { ref, onMounted, onBeforeUnmount } from "vue";

const enabled = ref(false);
let mq = null;

function sync() {
  enabled.value = !(mq && mq.matches);
}

onMounted(function () {
  mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  sync();
  if (mq.addEventListener) mq.addEventListener("change", sync);
  else if (mq.addListener) mq.addListener(sync);
});
onBeforeUnmount(function () {
  if (!mq) return;
  if (mq.removeEventListener) mq.removeEventListener("change", sync);
  else if (mq.removeListener) mq.removeListener(sync);
});

/* 网络星图预设：节点稀、连线短、速度慢、透明度低 */
const options = {
  fullScreen: { enable: false },
  background: { color: { value: "transparent" } },
  fpsLimit: 60,
  detectRetina: true,
  particles: {
    number: {
      value: 58,
      density: { enable: true, width: 1600, height: 900 }
    },
    color: { value: ["#38E1FF", "#2FB6D9", "#5CE6FF"] },
    opacity: {
      value: { min: 0.08, max: 0.34 }
    },
    size: {
      value: { min: 0.5, max: 1.8 }
    },
    links: {
      enable: true,
      distance: 150,
      color: "#38E1FF",
      opacity: 0.085,
      width: 1
    },
    move: {
      enable: true,
      speed: 0.32,
      direction: "none",
      random: true,
      straight: false,
      outModes: { default: "out" }
    }
  },
  interactivity: {
    detectsOn: "canvas",
    events: {
      onHover: { enable: false },
      onClick: { enable: false },
      resize: { enable: true }
    }
  }
};
</script>

<template>
  <VueParticles
    v-if="enabled"
    id="netlab-bg"
    class="bg-net"
    :options="options"
  />
</template>
