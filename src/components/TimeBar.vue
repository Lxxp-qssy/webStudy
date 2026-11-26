<script setup>
import { computed } from "vue";

const props = defineProps({
  name: String,
  t: { type: Number, default: 0 },
  playing: Boolean,
  speed: { type: Number, default: 1 },
  scene: Boolean
});
const emit = defineEmits(["toggle", "step", "replay", "seek", "speed"]);

const pct = computed(() => Math.round(props.t * 1000));

function onSeek(e){
  emit("seek", Number(e.target.value) / 1000);
}
</script>

<template>
  <div class="tl">
    <button class="tl-btn" :class="{ on: playing }" title="播放 / 暂停" @click="emit('toggle')">
      <svg v-if="!playing" viewBox="0 0 12 12"><path d="M3 1.5v9l7-4.5z"/></svg>
      <svg v-else viewBox="0 0 12 12"><rect x="2.5" y="1.5" width="2.6" height="9"/><rect x="6.9" y="1.5" width="2.6" height="9"/></svg>
    </button>
    <button class="tl-btn" title="单步" @click="emit('step')">
      <svg viewBox="0 0 12 12"><path d="M3 1.5v9l5.5-4.5z"/><rect x="9" y="1.5" width="1.6" height="9"/></svg>
    </button>
    <button class="tl-btn" title="重放当前场景" @click="emit('replay')">
      <svg viewBox="0 0 12 12"><path d="M6 1.6a4.4 4.4 0 1 1-4.2 5.6h1.7A2.8 2.8 0 1 0 6 3.2v1.9L3 2.6 6 .7z"/></svg>
    </button>

    <span class="tl-name">{{ name }}</span>

    <span class="tl-seek">
      <span class="seek-track"><span class="seek-fill" :style="{ width: (t * 100) + '%' }"></span></span>
      <input type="range" min="0" max="1000" :value="pct" :disabled="!scene" @input="onSeek">
    </span>

    <span class="tl-time">{{ (t * (scene ? 1 : 0)).toFixed(2) }}</span>

    <select class="tl-speed" :value="speed" @change="$emit('speed', Number($event.target.value))">
      <option :value="0.25">0.25×</option>
      <option :value="0.5">0.5×</option>
      <option :value="1">1.0×</option>
      <option :value="2">2.0×</option>
    </select>
  </div>
</template>
