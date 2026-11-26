<script setup>
import { ref, computed, onMounted } from "vue";
import { LABS } from "../labs/index.js";
import { readLab, overall } from "../lib/store.js";

const prog = ref({});
const stats = ref({ done: 0, total: 0, touched: 0, pct: 0 });
const ready = computed(() => LABS.filter(l => l.ready));
const groups = computed(() => {
  const g = {};
  LABS.forEach(function(l){
    (g[l.layer] = g[l.layer] || []).push(l);
  });
  return g;
});

onMounted(function(){
  const p = {};
  LABS.forEach(function(l){ p[l.id] = readLab(l.id); });
  prog.value = p;
  stats.value = overall(LABS);
});

function pctOf(l){
  const r = prog.value[l.id];
  if(!r || !r.done) return 0;
  return Math.min(100, Math.round(r.done / (l.steps || 1) * 100));
}
</script>

<template>
  <div class="home">
    <div class="bg-grid"></div>
    <div class="bg-glow"></div>
    <div class="bg-scan"></div>

    <header class="topbar">
      <a class="brand" href="./index.html">
        <svg width="26" height="20" viewBox="0 0 26 20" fill="none">
          <rect x=".8" y="3.4" width="24.4" height="13.2" rx="1.6" stroke="#38E1FF" stroke-opacity=".55"/>
          <path d="M4 8h4v4H4zM11 8h4v4h-4zM18 8h4v4h-4z" fill="#38E1FF" fill-opacity=".22" stroke="#38E1FF" stroke-opacity=".5"/>
        </svg>
        <div><b>NETLAB</b><span>配置 · 机制 · 现象</span></div>
      </a>
      <nav class="topnav">
        <a href="#labs">实验索引</a>
        <a href="#progress">学习进度</a>
      </nav>
    </header>

    <main class="wrap">
      <section class="hero">
        <div class="hero-copy">
          <div class="kicker">HUAWEI VRP V200R005 · CISCO IOS 15.2 对照</div>
          <h1>敲下一条命令，<br>看见它在设备内部<em>改了哪张表</em></h1>
          <p class="lead">
            不是文档站，是可操作的实验台。每个实验同时呈现三层并联动：命令层的真实 CLI 回显、
            机制层被改动的表项、现象层的数据面动画。每条命令之后都有一行浅灰引导，按当前进度提示
            下一条该敲什么；敲错了，现象层会说明为什么被拒绝。
          </p>

          <div class="hero-stats">
            <div><b>{{ LABS.length }}</b><span>实验规划</span></div>
            <div><b>{{ ready.length }}</b><span>已交付</span></div>
            <div><b>0</b><span>外部请求</span></div>
          </div>
        </div>

        <aside class="hero-side" aria-hidden="true">
          <svg class="hero-art" viewBox="0 0 520 300">
            <path d="M40 60 H480 M40 150 H480 M40 240 H480"/>
            <path d="M120 60 V240 M300 60 V240 M440 60 V240"/>
            <circle cx="120" cy="60" r="3"/><circle cx="300" cy="150" r="3"/><circle cx="440" cy="240" r="3"/>
            <circle cx="40" cy="150" r="2.4"/><circle cx="480" cy="60" r="2.4"/>
          </svg>

          <div class="layer-card">
            <div class="layer-h"><span>LAYER LINKAGE</span><b>LIVE</b></div>
            <div class="layer">
              <i></i>
              <div>
                <em>命令层 · CLI</em>
                <code>port default vlan 10</code>
              </div>
            </div>
            <div class="layer on-2">
              <i></i>
              <div>
                <em>机制层 · 表项</em>
                <code>GE0/0/1 &nbsp;PVID 1 → 10</code>
              </div>
            </div>
            <div class="layer on-3">
              <i></i>
              <div>
                <em>现象层 · 数据面</em>
                <code>FWD · VLAN 10 · Gi0/0/1</code>
              </div>
            </div>
            <div class="layer-tl">
              <span>逐跳回放</span>
              <div class="tl-track"><i></i></div>
              <span>0.00s</span>
            </div>
          </div>
        </aside>
      </section>

      <div class="section-h" id="labs"><b>实验索引</b><span>LAB INDEX</span></div>

      <div class="lab-groups">
        <section v-for="(list, layer) in groups" :key="layer" class="lab-group">
          <div class="section-h"><b>{{ layer }}</b></div>
          <div class="cards">
            <a v-for="(l, i) in list" :key="l.id"
               class="card"
               :class="{ locked: !l.ready }"
               :href="l.ready ? './' + l.file : null"
               :style="{ animationDelay: (i * 55) + 'ms' }">
              <div class="no">LAB {{ l.id }}</div>
              <h3>{{ l.title }}</h3>
              <p>{{ l.desc }}</p>
              <div class="foot">
                <span v-if="l.ready" class="badge">可实验 · {{ l.steps }} 步</span>
                <span v-else class="badge" style="border-color:rgba(160,190,220,.2);color:#55647A">规划中</span>
                <span v-if="pctOf(l) > 0">{{ pctOf(l) }}%</span>
              </div>
              <i v-if="pctOf(l) > 0" class="pbar" :style="{ width: pctOf(l) + '%' }"></i>
            </a>
          </div>
        </section>
      </div>

      <div class="section-h" id="progress"><b>学习进度</b><span>PROGRESS</span></div>
      <div class="prog-panel">
        <div class="prog-num">
          <b>{{ stats.done }}</b><span>/ {{ stats.total }} 步</span>
        </div>
        <div class="prog-bar"><i :style="{ width: stats.pct + '%' }"></i></div>
        <div class="prog-note">
          已完成 {{ stats.touched }} 个实验的部分内容 · 进度存在本机浏览器，不上传
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.brand{display:flex;align-items:center;gap:9px;text-decoration:none;color:inherit}
.topbar{padding:0 clamp(16px,3.2vw,64px)}
.brand b{font-family:var(--mono);font-size:12.5px;letter-spacing:.14em;color:var(--ink-hi);display:block}
.brand span{font-size:9.5px;color:var(--ink-faint);letter-spacing:.1em}
.topnav{margin-left:auto;display:flex;gap:18px}
.topnav a{font-size:11.5px;color:var(--ink-dim);text-decoration:none;transition:color .15s}
.topnav a:hover{color:var(--cyan)}
.kicker{font-family:var(--mono);font-size:9.5px;letter-spacing:.18em;color:var(--ink-faint);margin-bottom:16px}
.prog-panel{
  border:1px solid var(--line-soft);border-radius:3px;padding:18px 22px;background:rgba(13,18,25,.7);
  display:grid;grid-template-columns:auto minmax(160px,1fr) auto;
  gap:clamp(18px,3vw,48px);align-items:center;
}
@media (max-width:860px){
  .prog-panel{grid-template-columns:1fr;gap:12px}
}
.prog-num{display:flex;align-items:baseline}
.prog-num b{font-family:var(--mono);font-size:30px;line-height:1;color:var(--cyan);font-weight:500}
.prog-num span{font-family:var(--mono);font-size:11px;color:var(--ink-faint);margin-left:6px}
.prog-bar{height:3px;background:rgba(160,190,220,.12);border-radius:2px;overflow:hidden}
.prog-bar i{display:block;height:100%;background:linear-gradient(90deg,#1E8FA8,var(--cyan));transition:width .6s cubic-bezier(.2,1,.4,1);box-shadow:0 0 10px rgba(56,225,255,.6)}
.prog-note{font-size:11px;color:var(--ink-faint);max-width:34ch;text-align:right}
@media (max-width:860px){.prog-note{text-align:left;max-width:none}}
</style>
