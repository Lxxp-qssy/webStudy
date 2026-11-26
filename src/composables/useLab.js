import { reactive, computed, onUnmounted } from "vue";
import { normalize, stateless, uid, clamp } from "../lib/util.js";
import { writeLab, readLab, clearLab } from "../lib/store.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 实验运行时 —— 所有实验共用的一套引擎。
 * 实验模块（src/labs/*.js）只提供数据与规则，不碰 DOM。
 *
 * 三层模型在这一层被串起来：
 *   ① 命令层  execute(line) → 命中命令表 → 改 S（响应式状态）
 *   ② 机制层  def.tables(S, tab) 直接从 S 派生，状态一变表就重算
 *   ③ 现象层  scene + frames 由 clock.t 驱动，是时间的纯函数
 */
export function useLab(def){
  /* ---------------- 状态 ---------------- */
  const S = reactive(def.createState());
  const ctx = reactive({ dev: def.devices[0], view: "user", ifName: "" });

  const term = reactive({ lines: [], history: [], hIdx: 0 });
  const why = reactive({ seq: 0, mode: "idle", cmd: "", rows: [], items: [], verdict: null, note: "", title: "" });
  const clock = reactive({ t: 0, dur: 1, playing: false, speed: 1, scene: null, name: "就绪 · 选择一个板块开始" });
  const ui = reactive({
    tab: def.tabs[0].key,
    active: 0,
    done: {},
    marks: {},
    fx: [],
    toast: null,
    guide: null,
    inScript: 0
  });

  /* 撤回栈：每条真正改了状态的命令/板块入栈一份快照 */
  const hist = reactive({ stack: [] });
  const canUndo = computed(() => hist.stack.length > 0);
  const undoLabel = computed(() => hist.stack.length ? hist.stack[hist.stack.length - 1].label : "");

  let rafId = 0, lastTs = 0, markTimer = 0, toastTimer = 0;

  /* ---------------- 派生 ---------------- */
  const promptText = computed(() => def.prompt(ctx));

  const tableModel = computed(() => def.tables(S, ui.tab, ctx));

  const topo = computed(() => def.topology(S, ui, ctx));

  const guide = computed(() => def.guide(S, ctx));

  const placeholder = computed(() => {
    const g = guide.value;
    return g && g.cmd
      ? "输入命令，回车执行  ·  下一步：" + g.cmd
      : "输入命令，回车执行  ·  Tab 补全  ·  Ctrl+Z 回用户视图";
  });

  const progress = computed(() => {
    const n = Object.keys(ui.done).length;
    return { done: n, total: def.totalSteps, pct: Math.round(n / def.totalSteps * 100) };
  });

  const frames = computed(() => {
    const sc = clock.scene;
    if(!sc || !sc.frames) return [];
    const t = clock.t;
    const out = [];
    sc.frames.forEach(function(f, i){
      if(t < f.t0 || t > f.t1) return;
      const span = Math.max(1e-6, f.t1 - f.t0);
      out.push({
        id: f.id || "f" + i,
        route: f.route,
        p: clamp((t - f.t0) / span, 0, 1),
        tagged: !!f.tagged,
        vlan: f.vlan,
        kind: f.kind || "data",
        color: f.color || (f.tagged ? "#FFB545" : "#38E1FF")
      });
    });
    return out;
  });

  const dropMark = computed(() => {
    const sc = clock.scene;
    if(!sc || !sc.drop) return null;
    return clock.t >= sc.drop.at ? sc.drop : null;
  });

  /* ---------------- 终端 ---------------- */
  function write(text, kind){
    term.lines.push({ id: uid("l"), text: text == null ? "" : text, kind: kind || "out" });
    if(term.lines.length > 600) term.lines.splice(0, term.lines.length - 600);
  }

  function writeCard(card){
    term.lines.push(Object.assign({ id: uid("l"), kind: "card" }, card));
  }

  function printGuide(){
    const g = guide.value;
    if(!g) return;
    term.lines.push({ id: uid("l"), kind: "guide", text: "↳ 引导 · " + ((def.phases && def.phases[g.phase]) || g.phase), cmd: g.cmd || "" });
    term.lines.push({ id: uid("l"), kind: "guide-note", text: g.why });
  }

  /* ---------------- 表项高亮 ---------------- */
  function mark(rowKey, kind){
    if(!rowKey) return;
    ui.marks = Object.assign({}, ui.marks, { [rowKey]: kind || "chg" });
    clearTimeout(markTimer);
    markTimer = setTimeout(function(){ ui.marks = {}; }, 1700);
  }

  /* ---------------- 动效 ---------------- */
  function pushFx(fx){
    const item = Object.assign({ id: uid("fx") }, fx);
    ui.fx.push(item);
    setTimeout(function(){
      const i = ui.fx.findIndex(x => x.id === item.id);
      if(i >= 0) ui.fx.splice(i, 1);
    }, fx.life || 1100);
  }

  function toast(payload){
    ui.toast = Object.assign({ id: uid("t") }, payload);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ ui.toast = null; }, 3600);
  }

  /* ---------------- 撤回 ---------------- */
  function clone(v){ return JSON.parse(JSON.stringify(v)); }

  /* 快照覆盖「看得见的一切」：设备状态、视图、已完成板块、终端长度、时间轴、现象层 */
  function takeSnap(label){
    return {
      label: label,
      S: clone(S),
      ctx: { dev: ctx.dev, view: ctx.view, ifName: ctx.ifName },
      done: Object.assign({}, ui.done),
      tab: ui.tab,
      termLen: term.lines.length,
      clock: { scene: clock.scene, t: clock.t, dur: clock.dur, name: clock.name },
      why: {
        mode: why.mode, cmd: why.cmd, title: why.title,
        rows: clone(why.rows), items: clone(why.items),
        verdict: why.verdict ? Object.assign({}, why.verdict) : null,
        note: why.note
      }
    };
  }

  function pushSnap(snap){
    hist.stack.push(snap);
    if(hist.stack.length > 60) hist.stack.shift();
  }

  /* 顶层键可能被命令新增（如 S.trunk），直接 Object.assign 会留下幽灵字段，先删后写 */
  function hardAssign(target, src){
    Object.keys(target).forEach(function(k){ if(!(k in src)) delete target[k]; });
    Object.keys(src).forEach(function(k){ target[k] = src[k]; });
  }

  /* 指纹只看设备状态 S：
     视图切换（system-view / interface / quit）不产生撤销点，
     否则配完一串之后按撤回，先撤掉的是一条切视图命令，看着像没反应。 */
  function stateFingerprint(){
    return JSON.stringify(S);
  }

  /* 把一组操作（板块脚本、演示按钮）折叠成一个撤销点 */
  function groupSnap(depth, snap){
    const changed = stateFingerprint() !== JSON.stringify(snap.S) || clock.name !== snap.clock.name;
    if(!changed){ hist.stack.length = depth; return; }
    hist.stack.length = depth;
    pushSnap(snap);
  }

  async function runGroup(label, fn){
    const depth = hist.stack.length;
    const snap = takeSnap(label);
    await fn();
    groupSnap(depth, snap);
  }

  function undo(){
    const snap = hist.stack.pop();
    if(!snap) return false;

    hardAssign(S, clone(snap.S));
    ctx.dev = snap.ctx.dev; ctx.view = snap.ctx.view; ctx.ifName = snap.ctx.ifName;
    ui.done = Object.assign({}, snap.done);
    ui.tab = snap.tab;
    ui.marks = {};
    ui.fx = [];

    /* 终端回滚：这条命令连同它的回显一起收回 */
    if(term.lines.length > snap.termLen) term.lines.splice(snap.termLen);

    /* 时间轴与现象层回到当时那一刻 */
    clock.scene = snap.clock.scene;
    clock.t = snap.clock.t;
    clock.dur = snap.clock.dur;
    clock.name = snap.clock.name;
    clock.playing = false;
    Object.assign(why, snap.why);
    why.seq++;

    writeCard({
      variant: "undo",
      title: "已撤回 · " + snap.label,
      summary: "设备状态回到执行它之前",
      note: "表项、拓扑、提示符、时间轴一起回退。要重来就再敲一遍。"
    });
    save();
    printGuide();
    return true;
  }

  /* ---------------- Tab 补全 ---------------- */
  /* usage 里的 <10 20> 是占位，补全时只补到占位之前 */
  function stripUsage(u){ return u.replace(/\s*<[^>]*>/g, "").replace(/\s+$/, ""); }
  /* 端口号 / VLAN ID 这类「值」不替你猜：遇到含数字的 token 就停 */
  function completable(u){
    const toks = stripUsage(u).split(/\s+/);
    const out = [];
    for(const t of toks){
      if(/\d/.test(t)) break;
      out.push(t);
    }
    return out.length ? out.join(" ") : toks[0];
  }

  function complete(input){
    const raw = String(input || "");
    const u = raw.replace(/\s+$/, "");
    const pool = def.commands.filter(c => c.usage && (!c.view || c.view === ctx.view));
    const usages = [];
    pool.forEach(function(c){ if(usages.indexOf(c.usage) < 0) usages.push(c.usage); });

    /* 空输入：列出当前视图能用的命令 */
    if(!u) return { value: "", list: usages.map(stripUsage), label: "当前视图可用命令" };

    const low = u.toLowerCase();
    const hits = usages.filter(function(x){ return x.toLowerCase().indexOf(low) === 0; });
    if(!hits.length){
      const vn = (def.viewName && def.viewName[ctx.view]) || ctx.view;
      return {
        value: raw, list: [],
        label: "「" + u + "」在" + vn + "里没有匹配" + (ctx.view === "user" ? "；配置命令要先 system-view" : "")
      };
    }

    /* 唯一命中：补到占位或参数值之前 */
    if(hits.length === 1){
      const v = completable(hits[0]);
      if(v.length > u.length) return { value: v, list: [] };
      return { value: raw, list: [], label: "已经补到最具体的形式，后面自己填" };
    }

    /* 多个命中：先把公共前缀补上，补不动了再列候选 */
    let cp = hits[0];
    hits.forEach(function(h){
      while(cp && h.toLowerCase().indexOf(cp.toLowerCase()) !== 0) cp = cp.slice(0, -1);
    });
    cp = cp.replace(/\s+$/, "");
    if(cp.length > u.length) return { value: cp, list: [] };

    return { value: raw, list: hits.map(completable), label: "候选" };
  }

  /* ---------------- 命令执行 ---------------- */
  function makeApi(cmd){
    const bag = { out: [], changed: [], tab: null };
    return {
      S, ctx, clock, bag,
      say: function(t, kind){ bag.out.push({ t: t, kind: kind || "out" }); },
      lines: function(arr, kind){ arr.forEach(function(t){ bag.out.push({ t: t, kind: kind || "out" }); }); },
      change: function(k, from, to, opts){
        bag.changed.push(Object.assign({ k: k, from: from, to: to }, opts || {}));
        if(opts && opts.row) mark(opts.row, opts.kind || "chg");
      },
      tab: function(k){ bag.tab = k; },
      fx: pushFx,
      play: playScene,
      playScene: playScene,
      toast: toast,
      setDev: setDev,
      run: cmdSeq,
      after: function(ms, fn){ setTimeout(fn, ms); },
      refresh: function(){ /* 响应式，无需手动刷新 */ }
    };
  }

  function dispatch(line){
    const hit = def.commands.find(function(c){ return stateless(c.match).test(line); });
    if(!hit) return { error: "unknown" };

    if(hit.view && ctx.view !== hit.view)
      return { error: "view", cmd: hit };

    const api = makeApi(hit);
    let m = null;
    try{ m = stateless(hit.match).exec(line); }catch(e){ m = null; }
    let res = {};
    try{ res = hit.run(api, m, line) || {}; }
    catch(e){ api.say("Error: 命令执行异常（" + e.message + "）", "err"); }
    return { cmd: hit, api: api, bag: api.bag, res: res };
  }

  function execute(raw, silent, quiet){
    const line = normalize(raw);
    if(!line) return;
    if(!silent){
      term.history.push(line);
      term.hIdx = term.history.length;
    }
    /* 先拍快照：这条命令若能改变状态，撤回时就回到此刻 */
    const snap = takeSnap(line);
    const fpBefore = stateFingerprint();
    /* quiet：快捷键触发的命令不当作「用户敲的字」回显（如 Ctrl+Z 等价 return） */
    if(!quiet) write(promptText.value + line, "cmd");
    ui.marks = {};

    const r = dispatch(line);

    if(r.error === "unknown"){
      writeErrorWhy(line, "unknown");
      write("Error: Unrecognized command found at '^' position.", "err");
      write("", "dim");
      if(!ui.inScript) printGuide();
      return;
    }
    if(r.error === "view"){
      writeErrorWhy(line, "view", r.cmd);
      write("Error: Unrecognized command found at '^' position.", "err");
      write("      " + viewHintText(r.cmd.view), "dim");
      write("", "dim");
      if(!ui.inScript) printGuide();
      return;
    }

    const bag = r.bag;
    bag.out.forEach(function(l){ write(l.t, l.kind); });
    write("", "dim");

    if(bag.tab) ui.tab = bag.tab;

    /* 现象层：每条命令都要有解读 */
    routeWhy(line, r);

    if(typeof def.onCommand === "function") def.onCommand(r.api, line, bag.changed);

    /* 只有真的改了东西才入栈：只读命令、无变化的重复命令不留撤销点 */
    if(stateFingerprint() !== fpBefore) pushSnap(snap);

    checkSteps();
    save();
    if(!ui.inScript) printGuide();
  }

  function routeWhy(line, r){
    const cmd = r.cmd, bag = r.bag;
    if(cmd.kind === "test") return;                    /* 测试类自带解读 */
    if(bag.changed.length) return showDiff(line, bag.changed);
    if(cmd.kind === "view") return showView(line);
    if(cmd.kind === "doc") return showDoc(line, cmd);
    return showNoChange(line, cmd);
  }

  async function cmdSeq(lines){
    ui.inScript++;
    for(const l of lines){
      execute(l);
      await sleep(190);
    }
    ui.inScript--;
    if(ui.inScript === 0) printGuide();
  }

  /* ---------------- 现象层面板 ---------------- */
  function bump(){ why.seq++; }

  function showDiff(cmd, changed){
    why.mode = "diff"; why.cmd = cmd; why.rows = changed.slice(); why.items = []; why.verdict = null; bump();
  }

  function showDoc(cmd, hit){
    why.mode = "doc"; why.cmd = cmd; why.rows = []; why.verdict = null;
    why.items = hit.doc ? [{ h: "判读要点", p: hit.doc, cls: "pass" }] : [{ h: "只读命令", p: "不改变任何表项。", cls: "pass" }];
    bump();
  }

  function showNoChange(cmd, hit){
    why.mode = "nochange"; why.cmd = cmd; why.rows = []; why.verdict = null;
    why.items = hit && hit.explain ? hit.explain : [{ h: "无表项变化", p: "命令被接受，但当前状态下没有需要改的内容。", cls: "" }];
    bump();
  }

  function showView(cmd){
    why.mode = "view"; why.cmd = cmd; why.rows = []; why.verdict = null;
    why.items = def.viewRows(ctx);
    bump();
  }

  function writeErrorWhy(line, kind, cmd){
    why.mode = "error"; why.cmd = line; why.rows = []; why.verdict = null;
    let h, p, f;
    if(kind === "view"){
      const need = cmd.view;
      h = "这条命令只属于" + (def.viewName[need] || need);
      p = "当前在 " + promptText.value + "（" + (def.viewName[ctx.view] || ctx.view) + "）。" +
          "命令的作用范围由视图决定：视图不对，设备根本不会去解析后面的参数。";
      f = "先 " + viewHintText(need).replace("请先执行 ", "").replace("。", "") + "。";
    }else{
      h = "命令不在解析表里";
      p = "可能是拼写不全、参数缺失，或本实验没有实现这条命令。";
      f = "本实验实现：" + def.commands.filter(c => c.usage).map(c => c.usage).join("、");
    }
    why.items = [{ h: h, p: p, cls: "drop" }, { h: "怎么改", p: f, cls: "" }];
    bump();
  }

  function showTrace(scene){
    if(!scene || !scene.trace) return;
    why.mode = "trace";
    why.cmd = scene.name || "";
    why.title = scene.traceTitle || "逐跳判读";
    why.rows = [];
    why.items = scene.trace;
    why.verdict = scene.verdict || null;
    bump();
  }

  function showComplete(step){
    why.mode = "done";
    why.cmd = "S" + step.id + " · " + step.name;
    why.title = "本板块达成";
    why.rows = [];
    why.items = step.detail || [];
    why.verdict = step.summary ? { text: step.summary, bad: false } : null;
    bump();
  }

  function viewHintText(view){
    return def.viewHint[view] ? "请先执行 " + def.viewHint[view] + "。" : "";
  }

  /* ---------------- 时间轴 ---------------- */
  function playScene(scene){
    if(!scene) return;
    clock.scene = scene;
    clock.dur = scene.dur || 1;
    clock.t = 0;
    clock.name = scene.name || "";
    clock.playing = true;
    showTrace(scene);
    if(!rafId) startLoop();
  }

  function startLoop(){
    lastTs = performance.now();
    const tick = function(ts){
      const dt = Math.min(0.06, (ts - lastTs) / 1000);
      lastTs = ts;
      if(clock.playing){
        const dur = clock.scene && clock.scene.realSec ? clock.scene.realSec : 2.4;
        clock.t += dt * clock.speed / dur;
        if(clock.t >= 1){ clock.t = 1; clock.playing = false; }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function togglePlay(){
    if(!clock.scene) return;
    if(clock.t >= 1) clock.t = 0;
    clock.playing = !clock.playing;
  }

  function stepFrame(){
    if(!clock.scene) return;
    clock.playing = false;
    clock.t = clamp(clock.t + 1 / 24, 0, 1);
  }

  function replay(){
    if(!clock.scene) return;
    clock.t = 0; clock.playing = true;
  }

  function seek(p){
    if(!clock.scene) return;
    clock.playing = false;
    clock.t = clamp(p, 0, 1);
  }

  /* ---------------- 步骤 ---------------- */
  function checkSteps(){
    def.steps.forEach(function(s){
      if(ui.done[s.id] || typeof s.done !== "function") return;
      if(s.done(S, ctx)) completeStep(s);
    });
  }

  function completeStep(step){
    if(ui.done[step.id]) return;
    ui.done[step.id] = Date.now();
    writeCard({
      title: "S" + step.id + " 完成 · " + step.name,
      summary: step.summary || "",
      note: step.note || "",
      stepId: step.id
    });
    toast({ title: "S" + step.id + " " + step.name, text: step.summary || "", stepId: step.id });
    pushFx({ kind: "success", life: 1300 });
    /* 测试类板块的结论就在逐跳判读里，不要被「完成」面板盖掉 */
    if(!(step.keepTrace && why.mode === "trace")) showComplete(step);
    save();
  }

  async function runStep(id){
    const step = def.steps.find(function(s){ return s.id === id; });
    if(!step) return;
    /* 上一个板块的脚本还没跑完时不接受新点击，避免两条脚本的命令在终端里交错 */
    if(ui.inScript > 0) return;
    ui.active = id;
    const depth = hist.stack.length;
    const snap = takeSnap("S" + step.id + " " + step.name);
    if(typeof step.run === "function"){
      ui.inScript++;
      try{ await step.run(makeApi({ id: "step" + id }), S); }
      finally{
        ui.inScript--;
        if(ui.inScript === 0) printGuide();
      }
    }
    /* 板块脚本里的多条命令合并成一步，按一次撤回退回整个板块之前 */
    groupSnap(depth, snap);
    if(!ui.done[id]) completeStep(step);
    save();
  }

  function save(){
    writeLab(def.id, Object.keys(ui.done).length, def.totalSteps);
  }

  function setDev(dev){
    if(ctx.dev === dev && ctx.view === "user") return;
    ctx.dev = dev; ctx.view = "user"; ctx.ifName = "";
    write("--- 已切换到 " + dev + " 的命令行，视图回到用户视图 ---", "op");
    write("", "dim");
    printGuide();
  }

  function setTab(k){ ui.tab = k; }

  function reset(){
    /* 脚本跑一半时拒绝重置，避免异步尾巴污染新状态 */
    if(ui.inScript > 0) return false;
    Object.assign(S, def.createState());
    Object.assign(ctx, { dev: def.devices[0], view: "user", ifName: "" });
    term.lines = [];
    term.history = []; term.hIdx = 0;
    ui.done = {}; ui.active = 0; ui.marks = {}; ui.fx = [];
    ui.tab = def.tabs[0].key;
    hist.stack.length = 0;
    clock.scene = null; clock.t = 0; clock.playing = false;
    why.mode = "idle"; why.seq++;
    clearLab(def.id);
    def.boot(write, printGuide);
    write("// 实验已重置：配置、表项、拓扑、进度全部回到初始状态，历史进度已清除。", "op");
    return true;
  }

  function boot(){
    const prev = readLab(def.id);
    def.boot(write, printGuide);
    if(prev.done > 0){
      write("历史进度 " + prev.done + " / " + def.totalSteps + " 步。本次为全新配置，进度记录已保留。", "dim");
      write("", "dim");
      printGuide();
    }
  }

  onUnmounted(function(){
    if(rafId) cancelAnimationFrame(rafId);
    clearTimeout(markTimer);
    clearTimeout(toastTimer);
  });

  return {
    def, S, ctx, term, why, clock, ui,
    promptText, placeholder, tableModel, topo, guide, progress, frames, dropMark,
    write, execute, runStep, setDev, setTab, reset, boot, runGroup, complete,
    playScene, togglePlay, stepFrame, replay, seek, fx: pushFx, toast,
    undo, canUndo, undoLabel, hist,
    marks: computed(() => ui.marks)
  };
}


