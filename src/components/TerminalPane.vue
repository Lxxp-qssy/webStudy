<script setup>
import { ref, watch, nextTick } from "vue";
import PaneFrame from "./PaneFrame.vue";

const props = defineProps({
  prompt: String,
  placeholder: String,
  lines: { type: Array, default: () => [] },
  steps: { type: Array, default: () => [] },
  active: { type: Number, default: 0 },
  done: { type: Object, default: () => ({}) },
  devs: { type: Array, default: () => [] },
  dev: String,
  complete: { type: Function, default: null }
});
const emit = defineEmits(["submit", "step", "dev", "ctrlz", "hint"]);

const termEl = ref(null);
const inputEl = ref(null);
const value = ref("");
const hIdx = ref(0);
const history = [];

watch(() => props.lines.length, () => {
  nextTick(() => {
    if(termEl.value) termEl.value.scrollTop = termEl.value.scrollHeight;
  });
});

function send(){
  const v = value.value;
  if(!v.trim()) return;
  history.push(v.trim());
  hIdx.value = history.length;
  emit("submit", v);
  value.value = "";
}

function onKey(e){
  if(e.key === "Enter"){ send(); return; }
  /* 真实 VRP：Ctrl+Z 等价于 return，回用户视图（system-view 的回显里就写着这句） */
  if((e.ctrlKey || e.metaKey) && (e.key === "z" || e.key === "Z")){
    e.preventDefault();
    emit("ctrlz");
    return;
  }
  if(e.key === "ArrowUp"){
    if(hIdx.value > 0){ hIdx.value--; value.value = history[hIdx.value] || ""; e.preventDefault(); }
    return;
  }
  if(e.key === "ArrowDown"){
    if(hIdx.value < history.length - 1){ hIdx.value++; value.value = history[hIdx.value] || ""; }
    else { hIdx.value = history.length; value.value = ""; }
    e.preventDefault();
    return;
  }
  /* Tab：按当前视图与已输入前缀补全；补不动就列出候选 */
  if(e.key === "Tab"){
    e.preventDefault();
    if(!props.complete) return;
    const r = props.complete(value.value);
    if(!r) return;
    if(r.value && r.value !== value.value){
      value.value = r.value;
      nextTick(() => inputEl.value && inputEl.value.focus());
      return;
    }
    if(r.list && r.list.length) emit("hint", { items: r.list, label: r.label });
    else if(r.label) emit("hint", { items: [], label: r.label });
    return;
  }
}

function fill(cmd){
  value.value = cmd;
  nextTick(() => inputEl.value && inputEl.value.focus());
}

defineExpose({ fill });
</script>

<template>
  <PaneFrame tag="01" title="命令层" cls="pane-cmd">
    <template #head>
      <div class="dev-tabs">
        <button v-for="d in devs" :key="d" class="dev-tab" :class="{ on: d === dev }" @click="emit('dev', d)">{{ d }}</button>
      </div>
    </template>

    <div class="steps-strip" id="stepsStrip">
      <button v-for="s in steps" :key="s.id"
              class="step-btn"
              :class="{ key: s.key, done: done[s.id], active: active === s.id }"
              @click="emit('step', s.id)">
        <span v-if="done[s.id]" class="tick">✓</span>S{{ s.id }} {{ s.name }}
      </button>
    </div>

    <div class="term" id="term" ref="termEl">
      <template v-for="l in lines" :key="l.id">
        <div v-if="l.kind === 'card'" class="done-card" :class="l.variant">
          <div class="done-head">
            <svg v-if="l.variant === 'undo'" viewBox="0 0 12 12" class="done-ico">
              <circle cx="6" cy="6" r="5.2"/>
              <path d="M4.5 3.1 L2.4 4.9 L4.5 6.7 M2.6 4.9 H6.6 A2.2 2.2 0 0 1 6.6 9.3 H4.9"/>
            </svg>
            <svg v-else viewBox="0 0 12 12" class="done-ico"><circle cx="6" cy="6" r="5.2"/><path d="M3.4 6.1 L5.2 7.9 L8.7 4.3"/></svg>
            <span>{{ l.title }}</span>
          </div>
          <div v-if="l.summary" class="done-sum">{{ l.summary }}</div>
          <div v-if="l.note" class="done-note">{{ l.note }}</div>
        </div>

        <div v-else-if="l.kind === 'guide'" class="ln guide">
          <span class="g-lbl">{{ l.text }}</span>
          <template v-if="l.cmd"><span class="g-sep">｜</span>
            <span class="g-cmd" @click="fill(l.cmd)">{{ l.cmd }}</span>
          </template>
        </div>

        <div v-else-if="l.kind === 'guide-note'" class="ln guide-note">{{ l.text }}</div>

        <div v-else class="ln" :class="l.kind">{{ l.text }}</div>
      </template>
    </div>

    <div class="inline">
      <span class="ps1">{{ prompt }}</span>
      <input ref="inputEl" id="cmdInput" v-model="value" autocomplete="off" spellcheck="false"
             :placeholder="placeholder" @keydown="onKey">
      <span class="tab-hint" @click="inputEl && inputEl.focus()">Tab 补全</span>
    </div>
  </PaneFrame>
</template>
