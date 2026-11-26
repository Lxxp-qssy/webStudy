<script setup>
/**
 * 动态背景：极光色雾 + 网络星图（双层）
 * -------------------------------------------------------------------------
 * 第一层：缓慢漂移的极光色雾（纯 CSS 位移动画，GPU 合成层），提供氛围色；
 * 第二层：tsParticles 星图 —— 带辉光的节点 + 近距连线 + 闪烁，贴合网络互联主题。
 * 固定铺底、零鼠标/点击交互；prefers-reduced-motion 时星图不渲染、极光定格。
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

/* 网络星图预设：节点带辉光、间歇闪烁、连线可见 */
const options = {
  fullScreen: { enable: false },
  background: { color: { value: "transparent" } },
  fpsLimit: 60,
  detectRetina: true,
  particles: {
    number: {
      value: 72,
      density: { enable: true, width: 1600, height: 900 }
    },
    color: { value: ["#38E1FF", "#5CE6FF", "#2FB6D9"] },
    opacity: {
      value: { min: 0.18, max: 0.52 }
    },
    size: {
      value: { min: 0.8, max: 2.4 }
    },
    /* 节点辉光：把星点变成「发光节点」 */
    shadow: {
      enable: true,
      blur: 10,
      color: { value: "#38E1FF" }
    },
    /* 闪烁：节点周期性亮起，画面活起来 */
    twinkle: {
      particles: {
        enable: true,
        frequency: 0.06,
        opacity: 0.95
      }
    },
    links: {
      enable: true,
      distance: 150,
      color: "#38E1FF",
      opacity: 0.13,
      width: 1
    },
    move: {
      enable: true,
      speed: 0.38,
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
  <!-- 第一层：极光色雾（4 个色团错峰漂移） -->
  <div class="bg-aurora" aria-hidden="true">
    <i class="au au-1"></i>
    <i class="au au-2"></i>
    <i class="au au-3"></i>
    <i class="au au-4"></i>
  </div>
  <!-- 第二层：网络星图 -->
  <VueParticles
    v-if="enabled"
    id="netlab-bg"
    class="bg-net"
    :options="options"
  />
</template>
