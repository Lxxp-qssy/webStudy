import { onMounted, onUnmounted, watch, nextTick } from "vue";

/**
 * 链路流量粒子 —— 只画「链路上真的在跑数据」这件事。
 *
 * 不做背景装饰粒子：舞台上每一颗光点都代表一条链路当前的转发流量，
 * 所以它的出现/消失直接对应命令有没有把两端打通。
 *
 * 数据来源：model.links[] 里每条链路的 `flow`（0 或 0.3~1 的强度）与 `flowColor`（"r,g,b"）。
 *   flow = 0     链路不通 / 没放行 VLAN / 成员未 Selected → 不画
 *   flow 越大    光点越多、跑得越快
 *
 * 几何：沿 #links path.link 用 getTotalLength/getPointAtLength 实时取点，曲线也能贴线；
 * 点沿法线偏 3px 画在线条外侧，否则会被 SVG 的描边盖住。
 *
 * 性能：DPR 封顶 2；只在 flow 变化时重建粒子（其余帧只推进位置）；
 * 页面隐藏停 rAF；prefers-reduced-motion 只画一帧静帧。
 */
export function useParticles(canvasRef, svgRef, modelGetter){
  let c2d = null;
  let raf = 0, last = 0, w = 0, h = 0, scale = 1;
  let paths = [];
  let motes = [], fading = [];
  let stopped = false;
  let ro = null;
  let lastSig = "";

  const reduce = typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;

  /* ---------- 读取链路几何 + 流量标记 ---------- */
  function readPaths(){
    const svg = svgRef.value;
    if(!svg) return;
    const model = (modelGetter && modelGetter()) || {};
    const vb = (svg.getAttribute("viewBox") || "0 0 1200 372").trim().split(/\s+/).map(Number);
    const vbW = vb[2] || 1200;
    scale = w / vbW;

    const byId = {};
    (model.links || []).forEach(function(l){ byId[l.id] = l; });

    paths = [];
    svg.querySelectorAll("#links path.link").forEach(function(el){
      let len = 0;
      try{ len = el.getTotalLength(); }catch(e){ return; }
      if(!len) return;
      const id = el.getAttribute("data-lid") || "";
      const meta = byId[id] || {};
      paths.push({
        el: el,
        len: len,
        id: id,
        flow: typeof meta.flow === "number" ? meta.flow : 0,
        rgb: meta.flowColor || "56,225,255"
      });
    });
  }

  /* ---------- 按流量重建光点 ---------- */
  function syncMotes(){
    const now = performance.now();
    const sig = paths.map(function(p){ return p.id + ":" + p.flow + ":" + p.rgb; }).join("|");
    const same = sig === lastSig;
    lastSig = sig;
    if(same && motes.length) return;

    const next = [];
    paths.forEach(function(p, i){
      if(p.flow <= 0) return;
      /* 光点数量按时长定：长链路铺得开，短链路一颗就够 */
      const byLen = Math.max(1, Math.min(5, Math.round(p.len / 170)));
      const want = p.flow > 0.75 ? byLen : p.flow > 0.45 ? Math.max(1, byLen - 1) : 1;
      const keep = motes.filter(function(m){ return m.pi === i; });
      keep.slice(0, want).forEach(function(m){
        m.rgb = p.rgb;
        m.sp = 0.10 + 0.10 * p.flow;
        next.push(m);
      });
      for(let j = keep.length; j < want; j++){
        next.push({
          pi: i,
          p: (j + Math.random() * 0.55) / want,
          sp: 0.10 + 0.10 * p.flow,
          gap: 0.0075,
          rgb: p.rgb,
          born: now
        });
      }
    });

    motes.forEach(function(m){
      if(next.indexOf(m) < 0) fading.push({ m: m, dieAt: now });
    });
    motes = next;
  }

  function resize(){
    const cv = canvasRef.value;
    if(!cv || !cv.parentElement) return;
    const box = cv.parentElement.getBoundingClientRect();
    w = Math.max(1, Math.round(box.width));
    h = Math.max(1, Math.round(box.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = w + "px";
    cv.style.height = h + "px";
    c2d = cv.getContext("2d");
    if(!c2d) return;
    c2d.setTransform(dpr, 0, 0, dpr, 0, 0);

    lastSig = "";
    motes = [];
    fading = [];
    readPaths();
    syncMotes();
  }

  /* 沿路径取点，并按法线偏到线条外侧（否则被 SVG 描边盖住） */
  const _pt = { x: 0, y: 0 };
  function pointAt(path, pos, off){
    const l = Math.max(0, Math.min(1, pos)) * path.len;
    let a, b;
    try{
      a = path.el.getPointAtLength(l);
      b = path.el.getPointAtLength(Math.min(path.len, l + 6));
    }catch(e){ return null; }
    let dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    dx /= d; dy /= d;
    _pt.x = (a.x - dy * off) * scale;
    _pt.y = (a.y + dx * off) * scale;
    return _pt;
  }

  function drawMote(m, alpha){
    const path = paths[m.pi];
    if(!path) return;

    /* 尾迹 */
    for(let t = 4; t >= 0; t--){
      const pos = m.p - t * m.gap;
      if(pos < 0) continue;
      const pt = pointAt(path, pos, 3);
      if(!pt) continue;
      const k = t === 0 ? 1 : Math.max(0, 0.58 - t * 0.13);
      const r = t === 0 ? 2 : Math.max(0.35, 1.25 - t * 0.18);
      c2d.beginPath();
      c2d.arc(pt.x, pt.y, r, 0, 6.2832);
      c2d.fillStyle = "rgba(" + m.rgb + "," + (0.9 * k * alpha).toFixed(3) + ")";
      c2d.fill();
    }

    /* 头部光晕 */
    const h = pointAt(path, m.p, 3);
    if(!h) return;
    const g = c2d.createRadialGradient(h.x, h.y, 0, h.x, h.y, 9);
    g.addColorStop(0, "rgba(" + m.rgb + "," + (0.36 * alpha).toFixed(3) + ")");
    g.addColorStop(1, "rgba(" + m.rgb + ",0)");
    c2d.fillStyle = g;
    c2d.beginPath();
    c2d.arc(h.x, h.y, 9, 0, 6.2832);
    c2d.fill();
  }

  function frame(ts){
    if(stopped) return;
    const dt = last ? Math.min(0.05, (ts - last) / 1000) : 0.016;
    last = ts;
    const now = ts;

    if(!c2d || !w || !h){ raf = requestAnimationFrame(frame); return; }
    c2d.clearRect(0, 0, w, h);

    for(let i = 0; i < motes.length; i++){
      const m = motes[i];
      m.p += m.sp * dt;
      if(m.p > 1.1){ m.p = -0.05; m.sp = 0.09 + Math.random() * 0.1; }
      /* 打通瞬间淡入 600ms */
      const a = Math.min(1, (now - m.born) / 600);
      drawMote(m, a);
    }

    /* 链路断开时残留的光点 400ms 内淡出 */
    if(fading.length){
      const stay = [];
      fading.forEach(function(f){
        const k = 1 - (now - f.dieAt) / 400;
        if(k <= 0) return;
        drawMote(f.m, k);
        stay.push(f);
      });
      fading = stay;
    }

    raf = requestAnimationFrame(frame);
  }

  function start(){
    if(reduce){
      resize();
      if(c2d){
        c2d.clearRect(0, 0, w, h);
        motes.forEach(function(m){ drawMote(m, 1); });
      }
      return;
    }
    if(raf) return;
    stopped = false;
    last = 0;
    raf = requestAnimationFrame(frame);
  }

  function stop(){
    stopped = true;
    if(raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function onVisible(){
    if(document.hidden) stop();
    else start();
  }

  onMounted(function(){
    nextTick(function(){
      resize();
      const host = canvasRef.value && canvasRef.value.parentElement;
      if(typeof ResizeObserver !== "undefined" && host){
        ro = new ResizeObserver(function(){ resize(); });
        ro.observe(host);
      }
      document.addEventListener("visibilitychange", onVisible);
      start();
    });
  });

  /* 链路状态变了（命令打通 / 断开）→ 重新取流量标记，光点随之进出 */
  if(modelGetter){
    watch(function(){ return (modelGetter() || {}).links; }, function(){
      nextTick(function(){
        if(!c2d) return;
        readPaths();
        syncMotes();
      });
    }, { deep: true });
  }

  onUnmounted(function(){
    stop();
    if(ro) ro.disconnect();
    document.removeEventListener("visibilitychange", onVisible);
  });
}
