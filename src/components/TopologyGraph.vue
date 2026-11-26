<script setup>
import { ref, computed, onMounted, watch, nextTick } from "vue";
import { useParticles } from "../composables/useParticles.js";

const props = defineProps({
  model: { type: Object, required: true },
  frames: { type: Array, default: () => [] },
  drop: { type: Object, default: null },
  fx: { type: Array, default: () => [] }
});

const root = ref(null);
const pcv = ref(null);
const routeEls = {};
const lens = ref({});

/* 粒子层：画在 SVG 底下，链路一变就重新取样 */
useParticles(pcv, root, () => props.model);

function setRoute(key, el){
  if(el) routeEls[key] = el;
}

function measure(){
  const next = {};
  Object.keys(routeEls).forEach(function(k){
    const el = routeEls[k];
    try{ next[k] = el.getTotalLength(); }catch(e){ next[k] = 0; }
  });
  lens.value = next;
}

onMounted(() => nextTick(measure));
watch(() => props.model.routes, () => nextTick(measure), { deep: false });

function pointOn(route, p){
  const len = lens.value[route];
  const el = routeEls[route];
  if(!len || !el) return null;
  try{
    const pt = el.getPointAtLength(Math.max(0, Math.min(1, p)) * len);
    return { x: pt.x, y: pt.y };
  }catch(e){ return null; }
}

/* 帧位置：每次时间轴推进都重算，帧数很少（<10） */
const placed = computed(() => {
  const out = [];
  props.frames.forEach(function(f){
    const pt = pointOn(f.route, f.p);
    if(pt) out.push(Object.assign({}, f, pt));
  });
  return out;
});

const dropAt = computed(() => {
  if(!props.drop) return null;
  if(typeof props.drop.x === "number") return props.drop;
  const pt = pointOn(props.drop.route, props.drop.p);
  return pt ? Object.assign({}, props.drop, pt) : null;
});

function anchorOf(fx){
  if(fx.target && props.model.anchors && props.model.anchors[fx.target]) return props.model.anchors[fx.target];
  return null;
}

function routeD(route){
  const r = props.model.routes || {};
  return r[route] || r[Object.keys(r)[0]] || "";
}

const pcs = computed(() => props.model.hosts || []);
</script>

<template>
  <div class="topo-wrap">
    <canvas ref="pcv" class="topo-particles" aria-hidden="true"></canvas>
    <svg ref="root" id="topo" :viewBox="model.viewBox || '0 0 1200 372'" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="panelGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#141C26"/><stop offset="0.5" stop-color="#101821"/><stop offset="1" stop-color="#0B1119"/>
        </linearGradient>
        <linearGradient id="glass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#7FB6D8" stop-opacity=".12"/><stop offset="1" stop-color="#7FB6D8" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="pcGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#151D27"/><stop offset="1" stop-color="#0C121A"/>
        </linearGradient>
        <linearGradient id="scrGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#0A2230"/><stop offset="1" stop-color="#071620"/>
        </linearGradient>
        <filter id="glowC" x="-120%" y="-120%" width="340%" height="340%">
          <feGaussianBlur stdDeviation="2.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="glowG" x="-160%" y="-160%" width="420%" height="420%">
          <feGaussianBlur stdDeviation="1.8" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="glowA" x="-160%" y="-160%" width="420%" height="420%">
          <feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>

      <!-- 背景网格 -->
      <g opacity=".18">
        <path d="M0 200 H1200 M0 300 H1200" stroke="#16202C" stroke-width=".6"/>
        <path d="M200 0 V470 M400 0 V470 M600 0 V470 M800 0 V470 M1000 0 V470" stroke="#16202C" stroke-width=".6"/>
      </g>

      <!-- 链路 -->
      <g id="links">
        <path v-for="l in model.links" :key="l.id" :data-lid="l.id" class="link" :class="l.cls" :d="l.d"/>
      </g>

      <!-- 设备 -->
      <g v-for="d in model.devices" :key="d.id" :transform="'translate(' + d.x + ',' + d.y + ')'" class="dev-g">
        <rect class="sw-panel" x="0" y="0" :width="d.w" :height="d.h" rx="2"/>
        <rect x="0" y="0" :width="d.w" height="22" fill="url(#glass)" pointer-events="none"/>
        <text class="sw-logo" x="10" y="13">HUAWEI</text>
        <text class="sw-model" x="64" y="13">{{ d.model }}</text>

        <g v-for="(l, i) in d.leds" :key="'led' + i">
          <circle :cx="l.x" :cy="l.y" r="1.8" :fill="l.color" :filter="l.glow ? 'url(#glowG)' : ''"/>
          <text class="sw-model" :x="l.tx" :y="l.ty">{{ l.label }}</text>
        </g>

        <g class="silkscreen"><path :d="d.silk"/></g>

        <!-- 端口 -->
        <g v-for="p in d.ports" :key="p.name" class="port-g" :class="p.pulse ? 'is-pulse' : ''">
          <template v-if="p.kind === 'sfp'">
            <rect :x="p.x" :y="p.y - 1" width="42" height="19" rx="1.2" fill="#0A0E14" stroke="#3A4E64" stroke-width=".9"/>
            <rect :x="p.x + 3" :y="p.y + 2" width="36" height="12" rx=".6" fill="#0D141C"/>
            <path :d="'M' + (p.x + 7) + ' ' + (p.y + 5) + ' h28'" stroke="#2A3A4C" stroke-width=".8"/>
            <circle class="led" :class="p.up ? 'up' : 'down'" :cx="p.x + 3" :cy="p.y - 7" r="1.7"/>
            <rect :x="p.x + 6" :y="p.y + 18" width="30" height="2.5" :fill="p.color" opacity=".85" class="vband"/>
            <text :x="p.x + 21" :y="p.y - 8" class="topo-tip" text-anchor="middle">{{ p.label }}</text>
          </template>
          <template v-else>
            <rect class="vband" :x="p.x - 12" :y="p.y - 5" width="24" height="2.5" :fill="p.color" :opacity="p.dimBand ? .55 : .9"/>
            <rect class="port-body" :class="p.up ? 'up' : ''" :x="p.x - 12" :y="p.y" width="24" height="16" rx="1"/>
            <rect class="port-face" :x="p.x - 9" :y="p.y + 3" width="18" height="7" rx=".6"/>
            <path :d="'M' + (p.x - 7) + ' ' + (p.y + 3) + ' v2 M' + (p.x - 4) + ' ' + (p.y + 3) + ' v2 M' + (p.x - 1) + ' ' + (p.y + 3) + ' v2 M' + (p.x + 2) + ' ' + (p.y + 3) + ' v2 M' + (p.x + 5) + ' ' + (p.y + 3) + ' v2'" stroke="#2A3A4C" stroke-width=".7"/>
            <path :d="'M' + (p.x - 3) + ' ' + (p.y + 16) + ' l6 0'" stroke="#1C2836" stroke-width="1.4"/>
            <circle class="led" :class="p.up ? 'up' : 'down'" :cx="p.x - 9" :cy="p.y - 10" r="1.6"/>
            <text :x="p.x + 4" :y="p.y - 8" class="topo-tip" text-anchor="end">{{ p.label }}</text>
          </template>
        </g>

        <text v-for="(t, i) in (d.tags || [])" :key="'tg' + i" :x="t.x" :y="t.y" :class="t.cls || 'dev-sub'" :text-anchor="t.anchor || 'start'">{{ t.text }}</text>
      </g>

      <!-- 主机 -->
      <g v-for="h in pcs" :key="h.id" class="pc-g">
        <ellipse :cx="h.x" :cy="h.y + 62" rx="34" ry="4" fill="#000" opacity=".45"/>
        <rect :x="h.x - 33" :y="h.y" width="66" height="46" rx="2.2" fill="url(#pcGrad)" stroke="#28384A" stroke-width="1"/>
        <rect :x="h.x - 29" :y="h.y + 4" width="58" height="36" rx="1" fill="url(#scrGrad)" :stroke="h.color" :stroke-opacity="h.up ? .35 : .12" class="pc-screen"/>
        <text :x="h.x" :y="h.y + 18" text-anchor="middle" class="pc-label" :fill="h.color">{{ h.id }}</text>
        <text :x="h.x" :y="h.y + 31" text-anchor="middle" class="pc-ip">{{ h.ip }}</text>
        <path :d="'M' + (h.x - 27) + ' ' + (h.y + 34) + ' h54'" :stroke="h.color" stroke-opacity=".22" stroke-width=".8"/>
        <path :d="'M' + (h.x - 7) + ' ' + (h.y + 46) + ' h14 l4 8 h-22 z'" fill="#141C26" stroke="#28384A" stroke-width=".8"/>
        <text :x="h.x" :y="h.y + 62" text-anchor="middle" class="pc-mac">{{ h.mac }}</text>
        <text :x="h.x" :y="h.y + 72" text-anchor="middle" class="pc-vlan" :fill="h.color">VLAN {{ h.vlan }}</text>
      </g>

      <!-- 链路标签 -->
      <g class="lk-labels">
        <text v-for="(t, i) in (model.labels || [])" :key="'lb' + i"
              :x="t.x" :y="t.y" :class="t.cls" :text-anchor="t.anchor || 'start'">{{ t.text }}</text>
      </g>

      <!-- 静态路由（供测长，不可见） -->
      <g class="routes" aria-hidden="true">
        <path v-for="(d, k) in model.routes" :key="k" :ref="el => setRoute(k, el)" :d="d" fill="none" stroke="none"/>
      </g>

      <!-- 帧 -->
      <g class="frame-layer">
        <g v-for="f in placed" :key="f.id" :transform="'translate(' + f.x + ',' + f.y + ')'" class="pkt-g">
          <rect x="-20" y="-8.5" width="40" height="17" rx="1.5"
                :fill="f.tagged ? 'rgba(255,181,69,.16)' : 'rgba(56,225,255,.13)'"
                :stroke="f.color" stroke-width="1"
                :stroke-dasharray="f.kind === 'broadcast' ? '3 2' : ''"/>
          <template v-if="f.tagged">
            <rect x="2" y="-6.5" width="15" height="13" rx="1" fill="rgba(255,181,69,.28)"/>
            <text x="9.5" y="3.2" text-anchor="middle" font-family="monospace" font-size="8" fill="#FFD79B">{{ f.vlan }}</text>
            <text x="19" y="3.2" font-family="monospace" font-size="7.5" :fill="f.color">{{ f.kind === 'broadcast' ? 'ARP!' : 'DATA' }}</text>
          </template>
          <template v-else>
            <text x="0" y="3.2" text-anchor="middle" font-family="monospace" font-size="7.5" :fill="f.color">{{ f.kind === 'broadcast' ? 'ARP-B' : 'ETH' }}</text>
          </template>
        </g>
      </g>

      <!-- 丢弃标记 -->
      <g v-if="dropAt" :transform="'translate(' + dropAt.x + ',' + dropAt.y + ')'" class="drop-g">
        <g class="drop-pop">
          <circle r="8" fill="rgba(255,77,94,.14)" stroke="#FF4D5E" stroke-width="1.2"/>
          <path d="M-3.2 -3.2 L3.2 3.2 M3.2 -3.2 L-3.2 3.2" stroke="#FF4D5E" stroke-width="1.5"/>
          <text x="12" y="3" font-family="monospace" font-size="8" fill="#FF7B87">{{ dropAt.label }}</text>
        </g>
      </g>

      <!-- 命令动效 -->
      <g class="fx-layer">
        <template v-for="f in fx" :key="f.id">
          <g v-if="f.kind === 'pulse' && anchorOf(f)" :transform="'translate(' + anchorOf(f)[0] + ',' + anchorOf(f)[1] + ')'">
            <circle class="fx-ring" r="4" :stroke="f.color || '#38E1FF'"/>
            <circle class="fx-ring d2" r="4" :stroke="f.color || '#38E1FF'"/>
          </g>

          <g v-else-if="f.kind === 'scan' && f.box">
            <rect class="fx-scan" :x="f.box[0]" :y="f.box[1]" :width="f.box[2]" :height="f.box[3]" rx="2"/>
          </g>

          <g v-else-if="f.kind === 'chip'">
            <g class="fx-chip" :style="{ offsetPath: 'path(' + JSON.stringify(routeD(f.route)) + ')', animationDuration: (f.dur || 900) + 'ms' }">
              <rect x="-9" y="-7" width="18" height="14" rx="2" fill="rgba(255,181,69,.2)" :stroke="f.color || '#FFB545'" stroke-width="1"/>
              <text x="0" y="3" text-anchor="middle" font-family="monospace" font-size="8" fill="#FFD79B">{{ f.text }}</text>
            </g>
          </g>

          <g v-else-if="f.kind === 'beam'">
            <path class="fx-beam" :d="routeD(f.route)" :stroke="f.color || '#38E1FF'"/>
          </g>

          <g v-else-if="f.kind === 'success'" class="fx-success">
            <rect x="0" y="0" width="1200" height="420" class="fx-flash"/>
            <g transform="translate(700,268)">
              <circle r="16" class="fx-ok-ring"/>
              <path d="M-7 1 L-2 6 L8 -5" class="fx-ok-tick"/>
            </g>
          </g>
        </template>
      </g>
    </svg>
  </div>
</template>
