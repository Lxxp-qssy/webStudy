<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useLab } from "../composables/useLab.js";
import TopologyGraph from "../components/TopologyGraph.vue";
import TerminalPane from "../components/TerminalPane.vue";
import TablePane from "../components/TablePane.vue";
import WhyPane from "../components/WhyPane.vue";
import TimeBar from "../components/TimeBar.vue";
import Toast from "../components/Toast.vue";
import BootVeil from "../components/BootVeil.vue";
import ParticlesBg from "../components/ParticlesBg.vue";

const props = defineProps({ def: { type: Object, required: true } });

const lab = useLab(props.def);
const termRef = ref(null);
const booting = ref(true);

/* 舞台 HUD：节点数 / 链路数 / 当前有流量的链路数，直接从拓扑模型派生 */
const hud = computed(function(){
  const m = lab.topo.value || {};
  const links = m.links || [];
  return {
    nodes: (m.devices || []).length + (m.hosts || []).length,
    links: links.length,
    flow: links.filter(function(l){ return l.flow > 0; }).length
  };
});

/* 撤回：Alt+Z。Ctrl+Z 留给设备语义（等价 return），别和 VRP 打架 */
function onKeydown(e){
  if(!e.altKey || e.ctrlKey || e.metaKey) return;
  if(e.key.toLowerCase() !== "z") return;
  if(!lab.canUndo.value) return;
  e.preventDefault();
  lab.undo();
}

onMounted(function(){
  lab.boot();
  window.addEventListener("keydown", onKeydown);
});
onUnmounted(function(){ window.removeEventListener("keydown", onKeydown); });

const next = computed(() => lab.guide.value);
const hint = computed(() => props.def.tabs.find(t => t.key === lab.ui.tab)?.hint || props.def.title);

const progressTitle = computed(function(){
  const done = props.def.steps.filter(s => lab.ui.done[s.id]).map(s => "S" + s.id + " " + s.name);
  if(!done.length) return "共 " + props.def.totalSteps + " 个板块。每完成一个目标配置，这里亮一格，暗格 = 还没做";
  return "已完成 " + done.length + " / " + props.def.totalSteps + " 个板块：\n" + done.join("\n");
});

const undoTitle = computed(function(){
  return lab.canUndo.value
    ? "撤回上一步：" + lab.undoLabel.value + "（Alt+Z）"
    : "没有可撤回的操作";
});

/* 重置：两段式确认，第一次点击进入待确认态，3 秒内再点才执行 */
const resetArmed = ref(false);
let resetTimer = 0;
const canReset = computed(() => lab.progress.value.done > 0 || lab.canUndo.value);
const resetTitle = computed(function(){
  if(resetArmed.value) return "再点一次确认重置（3 秒后自动取消）";
  if(!canReset.value) return "还没有任何操作，无需重置";
  return "重置实验：清空本次全部配置与进度，回到初始状态";
});
function onReset(){
  if(!canReset.value) return;
  if(!resetArmed.value){
    resetArmed.value = true;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(function(){ resetArmed.value = false; }, 3000);
    return;
  }
  clearTimeout(resetTimer);
  resetArmed.value = false;
  if(lab.reset()) lab.toast({ title: "实验已重置", text: "配置、表项、拓扑与进度回到初始状态" });
}
onUnmounted(function(){ clearTimeout(resetTimer); });

function submit(v){ lab.execute(v); }
async function runAction(id){
  const a = props.def.actions.find(x => x.id === id);
  if(!a) return;
  /* 一个演示按钮 = 一个撤销点 */
  await lab.runGroup("操作 · " + a.label, () => a.run(lab));
}
function fillInput(cmd){
  if(termRef.value) termRef.value.fill(cmd);
}
/* Tab 补不出唯一结果时，把候选写进终端 */
function onHint(payload){
  const items = (payload && payload.items) || [];
  const label = (payload && payload.label) || "";
  if(!items.length){
    if(label) lab.write(label, "dim");
    return;
  }
  lab.write(label + " · " + items.length + " 条：", "dim");
  for(let i = 0; i < items.length; i += 3){
    lab.write("  " + items.slice(i, i + 3).join("   "), "dim");
  }
}
function togglePlay(){ lab.togglePlay(); }
</script>

<template>
  <div class="page">
    <div class="bg-grid"></div>
    <div class="bg-glow"></div>
    <ParticlesBg />

    <BootVeil v-if="booting" :def="def" @done="booting = false" />

    <header class="topbar">
      <a class="back" href="./index.html">
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M7 2 L3.4 5.5 L7 9" stroke="currentColor" stroke-width="1.2"/></svg>
        索引
      </a>
      <div class="crumb">
        <span class="no">LAB {{ def.id }}</span>
        <h1>{{ def.title }}</h1>
        <span class="meta">{{ def.meta }}</span>
      </div>
      <div class="top-right">
        <button class="undo-btn" :disabled="!lab.canUndo.value" :title="undoTitle" @click="lab.undo()">
          <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M4.3 2.3 L1.6 4.6 L4.3 6.9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M1.9 4.6 H7.1 A3 3 0 0 1 7.1 10.6 H4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
          </svg>
          撤回
          <kbd>Alt+Z</kbd>
        </button>
        <button class="undo-btn reset-btn" :class="{ armed: resetArmed }" :disabled="!canReset" :title="resetTitle" @click="onReset">
          <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M10.2 6 A4.2 4.2 0 1 1 6 1.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            <path d="M6.2 0.4 L9.6 2 L7 4.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          {{ resetArmed ? "确认重置" : "重置" }}
        </button>
        <div class="prog-mini" :title="progressTitle">
          <span class="pm-k">板块</span>
          <b class="pm-n">{{ lab.progress.value.done }}</b>
          <span class="pm-t">/ {{ def.totalSteps }}</span>
          <span class="bar">
            <i v-for="s in def.steps" :key="s.id"
               :class="{ on: lab.ui.done[s.id], cur: !lab.ui.done[s.id] && lab.ui.active === s.id }"></i>
          </span>
        </div>
      </div>
    </header>

    <div class="shell">
      <section class="stage">
        <div class="stage-corner">TOPOLOGY <b>·</b> {{ def.stageLabel }}</div>
        <div class="stage-hud">
          <span><b>{{ hud.nodes }}</b>NODES</span>
          <span><b>{{ hud.links }}</b>LINKS</span>
          <span class="live"><b>{{ hud.flow }}</b>FLOW</span>
        </div>
        <div class="stage-key"><i></i>光点 = 当前链路流量，配置打通才出现</div>
        <div class="swipe-hint">← 横向滑动查看完整拓扑 →</div>
        <div class="stage-scroll">
          <TopologyGraph
            :model="lab.topo.value"
            :frames="lab.frames.value"
            :drop="lab.dropMark.value"
            :fx="lab.ui.fx" />
        </div>
      </section>

      <TimeBar
        :name="lab.clock.name"
        :t="lab.clock.t"
        :playing="lab.clock.playing"
        :speed="lab.clock.speed"
        :scene="!!lab.clock.scene"
        @toggle="lab.togglePlay"
        @step="lab.stepFrame"
        @replay="lab.replay"
        @seek="lab.seek"
        @speed="lab.clock.speed = $event" />

      <div class="workspace">
        <TerminalPane
          ref="termRef"
          :prompt="lab.promptText.value"
          :placeholder="lab.placeholder.value"
          :lines="lab.term.lines"
          :steps="def.steps"
          :active="lab.ui.active"
          :done="lab.ui.done"
          :devs="def.devices"
          :dev="lab.ctx.dev"
          @submit="submit"
          @step="lab.runStep"
          @ctrlz="lab.execute('return', true, true)"
          @hint="onHint"
          :complete="lab.complete"
          @dev="lab.setDev" />

        <TablePane
          :tabs="def.tabs"
          :tab="lab.ui.tab"
          :model="lab.tableModel.value"
          :marks="lab.ui.marks"
          :legend="def.legend"
          :hint="hint"
          @tab="lab.setTab" />

        <WhyPane
          :model="lab.why"
          :next="next"
          :actions="def.actions.map(a => ({ id: a.id, label: a.label }))"
          :idle="def.idle"
          @action="runAction"
          @fill="fillInput" />
      </div>
    </div>

    <Toast :toast="lab.ui.toast" />
  </div>
</template>
