<script setup>
import PaneFrame from "./PaneFrame.vue";
defineProps({
  tabs: { type: Array, default: () => [] },
  tab: String,
  model: { type: Object, default: () => ({ head: [], rows: [] }) },
  marks: { type: Object, default: () => ({}) },
  legend: { type: Array, default: () => [] },
  hint: String
});
const emit = defineEmits(["tab"]);
</script>

<template>
  <PaneFrame tag="02" title="机制层 · 表项" cls="pane-table">
    <template #head><span class="hint">{{ hint }}</span></template>

    <div class="tabs">
      <button v-for="t in tabs" :key="t.key" class="tab" :class="{ on: t.key === tab }" @click="emit('tab', t.key)">
        {{ t.label }}
      </button>
    </div>

    <div class="table-wrap">
      <table v-if="model.rows && model.rows.length">
        <thead>
          <tr><th v-for="(h, i) in model.head" :key="i">{{ h }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in model.rows" :key="r.key" :class="[marks[r.key] || '', r.cls || '']">
            <td v-for="(c, i) in r.cells" :key="i" :class="c.cls || ''">{{ c.t }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">{{ model.empty || "暂无表项" }}</div>
      <div v-if="model.note" class="tbl-note">{{ model.note }}</div>
    </div>

    <div class="legend">
      <span v-for="(l, i) in legend" :key="i">
        <i :style="{ background: l.c }"></i>{{ l.label }}
      </span>
    </div>
  </PaneFrame>
</template>
