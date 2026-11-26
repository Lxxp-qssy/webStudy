import { pad } from "../lib/util.js";

/* =========================================================================
   实验 02 · STP 选举与收敛
   -------------------------------------------------------------------------
   三台 S5700 两两互联成三角，PC1 接 SW1 GE0/0/1，PC2 接 SW3 GE0/0/1。
   这一层只描述「生成树这台机器怎么算」：

     assign      → 由 (优先级, MAC, 端口开销) 推出 根桥 / 端口角色 / 端口状态
     topology    → 角色 → 端口色带与链路标签；被阻塞的链路 flow = 0
     stpScene    → 数据面沿「生成树」而不是「物理最短路径」走
     guide       → 从状态反推下一条该敲什么

   简化：端口状态是收敛后的稳态结果，不模拟 Hello / BPDU 的逐 tick 交互；
   收敛窗口按真实设备 30~50s（Max Age 20s + Listening 15s + Learning 15s）标注。
   ========================================================================= */

const COL = {
  root: "#35E08A",
  desi: "#38E1FF",
  alte: "#FF4D5E",
  edge: "#A78BFA",
  off:  "#7E93AB"
};

const DEV_ORDER = ["SW1", "SW2", "SW3"];
const GE_COST = 20000;

/* 三条互联链路：端口号与「SW3 GE0/0/2 是备用口」这条主线对齐 */
const LINKS = [
  { id: "l12", a: "SW1", pa: "GE0/0/2", b: "SW2", pb: "GE0/0/2" },
  { id: "l23", a: "SW2", pa: "GE0/0/3", b: "SW3", pb: "GE0/0/2" },
  { id: "l13", a: "SW1", pa: "GE0/0/3", b: "SW3", pb: "GE0/0/3" }
];

/* ---------------- 拓扑几何 ---------------- */
const DEV = {
  SW1: { x: 60,   y: 62, w: 300, h: 74 },
  SW2: { x: 540,  y: 62, w: 300, h: 74 },
  SW3: { x: 1030, y: 62, w: 300, h: 74 }
};

const PORT_GEO = {
  SW1: [
    { name: "GE0/0/1", kind: "rj45", x: 90,  y: 44, label: "1" },
    { name: "GE0/0/2", kind: "sfp",  x: 256, y: 44, label: "2" },
    { name: "GE0/0/3", kind: "rj45", x: 220, y: 44, label: "3" }
  ],
  SW2: [
    { name: "GE0/0/2", kind: "sfp", x: 2,   y: 44, label: "2" },
    { name: "GE0/0/3", kind: "sfp", x: 256, y: 44, label: "3" }
  ],
  SW3: [
    { name: "GE0/0/1", kind: "rj45", x: 250, y: 44, label: "1" },
    { name: "GE0/0/2", kind: "sfp",  x: 2,   y: 44, label: "2" },
    { name: "GE0/0/3", kind: "rj45", x: 70,  y: 44, label: "3" }
  ]
};

const PORT_ABS = {
  "SW1/GE0/0/1": [150, 122],
  "SW1/GE0/0/2": [358, 115],
  "SW1/GE0/0/3": [280, 122],
  "SW2/GE0/0/2": [542, 115],
  "SW2/GE0/0/3": [838, 115],
  "SW3/GE0/0/1": [1280, 122],
  "SW3/GE0/0/2": [1032, 115],
  "SW3/GE0/0/3": [1100, 122]
};

const ROUTES = {
  "pc1-to-sw1": "M150 200 L150 122",
  "sw1-to-pc1": "M150 122 L150 200",
  "pc2-to-sw3": "M1280 200 L1280 122",
  "sw3-to-pc2": "M1280 122 L1280 200",
  "l12-ab": "M358 115 L542 115",
  "l12-ba": "M542 115 L358 115",
  "l23-ab": "M838 115 L1032 115",
  "l23-ba": "M1032 115 L838 115",
  "l13-ab": "M280 122 C280 178 380 186 690 186 C1000 186 1100 178 1100 122",
  "l13-ba": "M1100 122 C1100 178 1000 186 690 186 C380 186 280 178 280 122"
};

/* ---------------- 初始状态 ---------------- */
function makeSwitch(name, priority, mac){
  const ports = {};
  PORT_GEO[name].forEach(function(g){
    ports[g.name] = { up: true, role: "—", state: "Discarding", cost: GE_COST, edge: false };
  });
  return { name: name, priority: priority, mac: mac, ports: ports, tcn: 0, tcReason: "—" };
}

/* ---------------- 选举与角色判定（简化模型） ---------------- */
function cmpBridge(a, b){
  if(a.priority !== b.priority) return a.priority - b.priority;
  const x = a.mac.toLowerCase(), y = b.mac.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
}

function rootOf(S){
  let best = DEV_ORDER[0];
  DEV_ORDER.forEach(function(d){ if(cmpBridge(S[d], S[best]) < 0) best = d; });
  return best;
}

function findLink(id){
  for(let i = 0; i < LINKS.length; i++){ if(LINKS[i].id === id) return LINKS[i]; }
  return null;
}

function linkUp(S, lk){
  return S[lk.a].ports[lk.pa].up && S[lk.b].ports[lk.pb].up;
}

function linkCarries(S, lk){
  if(!linkUp(S, lk)) return false;
  return S[lk.a].ports[lk.pa].state === "Forwarding" && S[lk.b].ports[lk.pb].state === "Forwarding";
}

function isLinkPort(dev, pn){
  for(let i = 0; i < LINKS.length; i++){
    const lk = LINKS[i];
    if(lk.a === dev && lk.pa === pn) return true;
    if(lk.b === dev && lk.pb === pn) return true;
  }
  return false;
}

/* 到根桥的路径开销：沿路累加的「本端端口开销」，收到无效值就不参与比较 */
function costMap(S, root){
  const INF = 1e9;
  const d = {};
  DEV_ORDER.forEach(function(k){ d[k] = INF; });
  d[root] = 0;
  for(let it = 0; it < LINKS.length + 2; it++){
    LINKS.forEach(function(lk){
      if(!linkUp(S, lk)) return;
      const ca = S[lk.a].ports[lk.pa].cost;
      const cb = S[lk.b].ports[lk.pb].cost;
      if(d[lk.b] + ca < d[lk.a]) d[lk.a] = d[lk.b] + ca;
      if(d[lk.a] + cb < d[lk.b]) d[lk.b] = d[lk.a] + cb;
    });
  }
  return d;
}

function rootPortOf(S, dev, root, d){
  if(dev === root) return "";
  let best = null;
  LINKS.forEach(function(lk){
    let pn = "", peer = "";
    if(lk.a === dev){ pn = lk.pa; peer = lk.b; }
    else if(lk.b === dev){ pn = lk.pb; peer = lk.a; }
    else return;
    if(!linkUp(S, lk)) return;
    if(d[peer] >= 1e9) return;
    const via = d[peer] + S[dev].ports[pn].cost;
    if(!best || via < best.via ||
       (via === best.via && cmpBridge(S[peer], S[best.peer]) < 0) ||
       (via === best.via && peer === best.peer && pn < best.pn)){
      best = { via: via, peer: peer, pn: pn };
    }
  });
  return best ? best.pn : "";
}

function assign(S){
  const root = rootOf(S);
  const d = costMap(S, root);
  const rp = {};
  DEV_ORDER.forEach(function(dev){ rp[dev] = rootPortOf(S, dev, root, d); });

  /* ① 物理 down 的口不参与生成树 */
  DEV_ORDER.forEach(function(dev){
    Object.keys(S[dev].ports).forEach(function(pn){
      const p = S[dev].ports[pn];
      if(!p.up){ p.role = "—"; p.state = "Discarding"; }
    });
  });

  /* ② 接主机的口对端没有网桥，永远是 Designated */
  DEV_ORDER.forEach(function(dev){
    Object.keys(S[dev].ports).forEach(function(pn){
      const p = S[dev].ports[pn];
      if(!p.up) return;
      if(isLinkPort(dev, pn)) return;
      p.role = "Designated";
      p.state = "Forwarding";
    });
  });

  /* ③ 每条互联链路：比 (到根开销, 桥 ID)，赢的一侧 Designated，输的一侧 Root 或 Alternate */
  LINKS.forEach(function(lk){
    if(!linkUp(S, lk)) return;
    const pa = S[lk.a].ports[lk.pa];
    const pb = S[lk.b].ports[lk.pb];
    const aWins = d[lk.a] < d[lk.b] || (d[lk.a] === d[lk.b] && cmpBridge(S[lk.a], S[lk.b]) < 0);
    const winPort = aWins ? pa : pb;
    const loseDev = aWins ? lk.b : lk.a;
    const losePort = aWins ? pb : pa;
    const loseName = aWins ? lk.pb : lk.pa;
    winPort.role = "Designated";
    winPort.state = "Forwarding";
    if(rp[loseDev] === loseName){
      losePort.role = "Root";
      losePort.state = "Forwarding";
    }else{
      losePort.role = "Alternate";
      losePort.state = "Discarding";
    }
  });
}

function roleSig(S){
  return DEV_ORDER.map(function(dev){
    return Object.keys(S[dev].ports).sort().map(function(pn){
      const p = S[dev].ports[pn];
      return pn + ":" + p.role + ":" + p.state;
    }).join(",");
  }).join("|");
}

/* 状态一变就重算；角色真的变了才算一次拓扑变更（TCN 计数） */
function recalc(S, reason){
  const before = roleSig(S);
  assign(S);
  const changed = roleSig(S) !== before;
  if(changed && reason){
    DEV_ORDER.forEach(function(dev){
      S[dev].tcn += 1;
      S[dev].tcReason = reason;
    });
  }
  return changed;
}

function setLink(S, id, up){
  const lk = findLink(id);
  if(!lk) return false;
  S[lk.a].ports[lk.pa].up = up;
  S[lk.b].ports[lk.pb].up = up;
  return recalc(S, up ? "链路恢复" : "链路断开");
}

export function createState(){
  const S = {
    SW1: makeSwitch("SW1", 32768, "4c1f-cc00-00a3"),
    SW2: makeSwitch("SW2", 32768, "4c1f-cc00-002e"),
    SW3: makeSwitch("SW3", 32768, "4c1f-cc00-0061")
  };
  recalc(S, "");
  return S;
}

/* ---------------- 视图 ---------------- */
const VIEW_NAME = { user: "用户视图", system: "系统视图", if: "接口视图" };
const VIEW_HINT = { system: "system-view", if: "interface GigabitEthernet 0/0/3" };

function prompt(ctx){
  if(ctx.view === "user") return "<" + ctx.dev + ">";
  if(ctx.view === "system") return "[" + ctx.dev + "]";
  return "[" + ctx.dev + "-" + shortIf(ctx.ifName) + "]";
}
function shortIf(n){ return String(n).replace("GigabitEthernet", "GE"); }
function ifPort(ctx){ return "GE" + String(ctx.ifName).replace("GigabitEthernet", ""); }
function portName(pn){ return "GigabitEthernet" + pn.slice(2); }
function portIdOf(pn){ return "128." + pn.split("/")[2]; }
function roleCode(r){
  if(r === "Root") return "ROOT";
  if(r === "Designated") return "DESI";
  if(r === "Alternate") return "ALTE";
  return "—";
}
function stateCode(s){ return s === "Forwarding" ? "FORWARDING" : "DISCARDING"; }
function portColor(p){
  if(!p.up) return COL.off;
  if(p.edge) return COL.edge;
  if(p.role === "Root") return COL.root;
  if(p.role === "Alternate") return COL.alte;
  return COL.desi;
}

/* ---------------- 命令表 ---------------- */
const IF_RE = /^interface (?:(?:GigabitEthernet|GE)\s*)?([\d/]+)$/i;

const commands = [
  {
    id: "system-view", match: /^(system-view|sys)$/, view: null, kind: "view", usage: "system-view",
    run(api){
      if(api.ctx.view !== "user"){ api.say("Error: Unrecognized command found at '^' position.", "err"); return; }
      api.ctx.view = "system"; api.ctx.ifName = "";
      api.say("Enter system view, return user view with Ctrl+Z.", "dim");
    }
  },
  {
    id: "quit", match: /^(quit|q)$/, view: null, kind: "view", usage: "quit",
    run(api){
      const c = api.ctx;
      if(c.view === "if"){ c.view = "system"; c.ifName = ""; }
      else if(c.view === "system"){ c.view = "user"; }
      else { api.say("Error: Unrecognized command found at '^' position.", "err"); }
    }
  },
  {
    id: "return", match: /^(return|ctrl\+z)$/, view: null, kind: "view", usage: "return",
    run(api){ api.ctx.view = "user"; api.ctx.ifName = ""; }
  },
  {
    id: "interface", match: IF_RE, view: "system", kind: "view", usage: "interface GigabitEthernet 0/0/3",
    run(api, m){
      const key = "GE" + m[1];
      if(!api.S[api.ctx.dev].ports[key]){ api.say("Error: The port does not exist.", "err"); return; }
      api.ctx.view = "if"; api.ctx.ifName = "GigabitEthernet" + m[1];
    }
  },
  {
    id: "stp-priority", match: /^stp priority (\d+)$/, view: "system", kind: "config",
    usage: "stp priority <4096>",
    explain: [
      { h: "选举的第一关键字", p: "根桥先比桥优先级，相同才比 MAC。把 SW1 压到 4096，它立刻取代 MAC 更小的 SW2。" },
      { h: "取值", p: "必须是 4096 的整数倍：0、4096、8192 … 61440，缺省 32768。" }
    ],
    run(api, m){
      const sw = api.S[api.ctx.dev];
      const v = parseInt(m[1], 10);
      const dev = api.ctx.dev;
      if(v > 61440 || v % 4096 !== 0){
        api.say("// 桥优先级必须是 4096 的整数倍（0 / 4096 / … / 61440），本次不生效。", "op");
        return;
      }
      if(sw.priority === v){
        api.say("// " + dev + " 的桥优先级本来就是 " + v + "，命令未产生状态变化。", "op");
        return;
      }
      const from = sw.priority;
      sw.priority = v;
      api.change(dev + ".优先级", from, v, { row: "b-" + dev });
      api.change("桥 ID", from + "." + sw.mac, v + "." + sw.mac, { row: "m-" + dev });
      const changed = recalc(api.S, "桥优先级变更");
      api.tab("bridge");
      api.say("// " + dev + " 桥优先级 " + from + " → " + v + "，全网重新选举", "op");
      if(changed) api.say("// 根桥变了，端口角色跟着重算 —— 看拓扑上阻塞的位置有没有换地方。", "op");
      api.fx({ kind: "scan", box: [DEV[dev].x, DEV[dev].y, DEV[dev].w, DEV[dev].h], color: COL.root });
    }
  },
  {
    id: "stp-root", match: /^stp root primary$/, view: "system", kind: "config",
    usage: "stp root primary",
    explain: [
      { h: "等价于", p: "把桥优先级设成 0，比任何手工配的 4096 都低，只要它在线就一定是根桥。" },
      { h: "注意", p: "同一网络里配两台 root primary 没有意义，最后还是比 MAC。" }
    ],
    run(api){
      const sw = api.S[api.ctx.dev], dev = api.ctx.dev;
      if(sw.priority === 0){
        api.say("// " + dev + " 已经是根桥（优先级 0），命令未产生状态变化。", "op");
        return;
      }
      const from = sw.priority;
      sw.priority = 0;
      api.change(dev + ".优先级", from, 0, { row: "b-" + dev });
      api.change("桥 ID", from + "." + sw.mac, "0." + sw.mac, { row: "m-" + dev });
      recalc(api.S, "桥优先级变更");
      api.tab("bridge");
      api.say("// " + dev + " 桥优先级 " + from + " → 0（stp root primary）", "op");
    }
  },
  {
    id: "stp-cost", match: /^stp cost (\d+)$/, view: "if", kind: "config",
    usage: "stp cost <100000>",
    explain: [
      { h: "改的是什么", p: "端口开销。本端用这条链路去根桥的代价就变了，根端口会重新挑。" },
      { h: "现象", p: "开销调大之后，原来走这条链路的方向会绕到另一条；被换下来的端口变成 Alternate，<b>物理 up 但不转发</b>。" }
    ],
    run(api, m){
      const pn = ifPort(api.ctx);
      const p = api.S[api.ctx.dev].ports[pn];
      const v = parseInt(m[1], 10);
      if(!p){ api.say("Error: The port does not exist.", "err"); return; }
      if(v < 1 || v > 200000000){
        api.say("// 端口开销取值范围 1 ~ 200000000。", "op");
        return;
      }
      if(p.cost === v){
        api.say("// " + pn + " 的开销本来就是 " + v + "，命令未产生状态变化。", "op");
        return;
      }
      const from = p.cost;
      p.cost = v;
      const changed = recalc(api.S, "端口开销变更");
      api.change(pn + ".cost", from, v, { row: "p-" + pn });
      api.tab("port");
      api.say("// " + pn + " 端口开销 " + from + " → " + v + "（GE 缺省 " + GE_COST + "）", "op");
      if(changed) api.say("// 这台设备到根桥的路径开销变了，端口角色重算 —— 看 ROLE 列。", "op");
      api.fx({ kind: "pulse", target: api.ctx.dev + "/" + pn, color: changed ? COL.alte : COL.desi });
    }
  },
  {
    id: "stp-edge", match: /^stp edged-port enable$/, view: "if", kind: "config",
    usage: "stp edged-port enable",
    explain: [
      { h: "边缘端口", p: "接终端的口不参与生成树计算，链路 up 后不经过 Listening / Learning，直接 Forwarding。" },
      { h: "代价", p: "它不再受人保护：一旦误接交换机，环路就没人挡了。所以要配 BPDU 保护兜底。" }
    ],
    run(api){
      const pn = ifPort(api.ctx);
      const p = api.S[api.ctx.dev].ports[pn];
      if(!p){ api.say("Error: The port does not exist.", "err"); return; }
      if(p.edge){
        api.say("// " + pn + " 已经是边缘端口，命令未产生状态变化。", "op");
        return;
      }
      p.edge = true;
      recalc(api.S, "");
      api.change(pn + ".edged-port", "disable", "enable", { row: "p-" + pn });
      api.tab("port");
      api.say("// " + pn + " 成为边缘端口：PC 换线、重启都省掉 30s 的端口状态迁移。", "op");
      api.fx({ kind: "pulse", target: api.ctx.dev + "/" + pn, color: COL.edge });
    }
  },
  {
    id: "undo-stp-edge", match: /^undo stp edged-port$/, view: "if", kind: "config",
    usage: "undo stp edged-port",
    explain: [{ h: "收回边缘属性", p: "这个口重新参与生成树，链路 up 后要走完整的 Listening → Learning → Forwarding。" }],
    run(api){
      const pn = ifPort(api.ctx);
      const p = api.S[api.ctx.dev].ports[pn];
      if(!p){ api.say("Error: The port does not exist.", "err"); return; }
      if(!p.edge){
        api.say("// " + pn + " 本来就不是边缘端口，命令未产生状态变化。", "op");
        return;
      }
      p.edge = false;
      recalc(api.S, "");
      api.change(pn + ".edged-port", "enable", "disable", { row: "p-" + pn });
      api.tab("port");
      api.say("// " + pn + " 取消边缘端口，重新参与生成树计算", "op");
    }
  },

  /* ---- 只读 ---- */
  {
    id: "disp-stp", match: /^display stp$/, view: null, kind: "doc", usage: "display stp",
    doc: "全局视图：这台设备的桥 ID、它认定的根桥 ID、到根桥的开销、根端口是谁、收到过几次 TC/TCN。<b>先看 CIST Root 和 CIST Bridge 是不是同一台</b>。",
    run(api){ dispStp(api); }
  },
  {
    id: "disp-brief", match: /^display stp brief$/, view: null, kind: "doc", usage: "display stp brief",
    doc: "按端口列出角色与状态。ROOT 是根端口，DESI 是指定端口，<b>ALTE 就是被阻塞的那一类</b>；状态在 MSTP 里只有 FORWARDING / DISCARDING。",
    run(api){ dispBrief(api); }
  },
  {
    id: "disp-root", match: /^display stp root$/, view: null, kind: "doc", usage: "display stp root",
    doc: "一行说清：谁是根桥、我到它有多远、我的根端口是哪个。对照 <b>Ext.Path Cost</b> 与 <b>Root Port</b> 就能验证选路。",
    run(api){ dispRoot(api); }
  }
];

/* ---------------- 只读命令的回显 ---------------- */
function dispBrief(api){
  const sw = api.S[api.ctx.dev];
  const down = [];
  api.say(pad("MSTID", 9) + pad("Port", 28) + pad("Role", 6) + pad("STP State", 14) + "Protection", "dim");
  Object.keys(sw.ports).sort().forEach(function(pn){
    const p = sw.ports[pn];
    if(!p.up){ down.push(pn); return; }
    api.say(pad(0, 9) + pad(portName(pn), 28) + pad(roleCode(p.role), 6) + pad(stateCode(p.state), 14) + "NONE");
  });
  api.tab("port");
  api.say("", "dim");
  if(down.length){
    api.say("// " + down.join("、") + " 物理 down，不参与生成树，这张表不列它们 —— 回显里少了一行不代表配置丢了。", "op");
  }
  api.say("// ROOT 根端口 / DESI 指定端口 / ALTE 备用端口。ALTE 的 PHY 是 up 的，但一个业务帧也不转。", "op");
}

function dispStp(api){
  const S = api.S, dev = api.ctx.dev, sw = S[dev];
  const root = rootOf(S);
  const d = costMap(S, root);
  const rp = rootPortOf(S, dev, root, d);
  api.say("-------[CIST Global Info][Mode MSTP]-------");
  api.say(pad("CIST Bridge", 20) + ":" + sw.priority + "." + sw.mac);
  api.say(pad("Config Times", 20) + ":Hello 2s MaxAge 20s FwDly 15s MaxHop 20");
  api.say(pad("Active Times", 20) + ":Hello 2s MaxAge 20s FwDly 15s MaxHop 20");
  api.say(pad("CIST Root/ERPC", 20) + ":" + S[root].priority + "." + S[root].mac + " / " + d[dev]);
  api.say(pad("CIST RegRoot/IRPC", 20) + ":" + sw.priority + "." + sw.mac + " / 0");
  api.say(pad("CIST RootPortId", 20) + ":" + (rp ? portIdOf(rp) + " (" + portName(rp) + ")" : "0.0"));
  api.say(pad("BPDU-Protection", 20) + ":Disabled");
  api.say(pad("TC or TCN received", 20) + ":" + sw.tcn);
  api.say("");
  api.say("-------[CIST Ports Info]-------", "dim");
  api.say(pad("Port", 28) + pad("Role", 6) + pad("STP State", 14) + "Cost", "dim");
  Object.keys(sw.ports).sort().forEach(function(pn){
    const p = sw.ports[pn];
    api.say(pad(portName(pn), 28) + pad(p.up ? roleCode(p.role) : "—", 6) +
      pad(stateCode(p.state), 14) + p.cost);
  });
  api.tab("port");
}

function dispRoot(api){
  const S = api.S, dev = api.ctx.dev;
  const root = rootOf(S);
  const d = costMap(S, root);
  const rp = rootPortOf(S, dev, root, d);
  api.say(pad("MSTID", 8) + pad("Root Bridge ID", 24) + pad("Ext.Path Cost", 15) +
    pad("Region Root ID", 24) + pad("Int.Path Cost", 15) + "Root Port", "dim");
  api.say(pad(0, 8) + pad(S[root].priority + "." + S[root].mac, 24) + pad(d[dev], 15) +
    pad(S[root].priority + "." + S[root].mac, 24) + pad(d[dev], 15) + (rp ? portName(rp) : "—"));
  api.tab("bridge");
  api.say("", "dim");
  api.say("// Root Bridge ID 全三台一样；Ext.Path Cost 与 Root Port 才是「我这台怎么去根桥」。", "op");
}

/* ---------------- 表项 ---------------- */
function tables(S, tab, ctx){
  const sw = S[ctx.dev];
  if(tab === "port"){
    return {
      head: ["PORT", "PHY", "ROLE", "STATE", "COST", "EDGE"],
      rows: Object.keys(sw.ports).sort().map(function(pn){
        const p = sw.ports[pn];
        return {
          key: "p-" + pn,
          cells: [
            { t: pn, cls: "c" },
            { t: p.up ? "up" : "down", cls: p.up ? "c" : "dim" },
            { t: p.up ? p.role : "—", cls: p.role === "Root" ? "ok" : p.role === "Alternate" ? "bad" : p.up ? "c" : "dim" },
            { t: p.state, cls: p.up && p.state === "Forwarding" ? "ok" : p.up ? "warn" : "dim" },
            { t: p.cost, cls: "c" },
            { t: p.edge ? "Y" : "—", cls: p.edge ? "warn" : "dim" }
          ]
        };
      }),
      empty: "没有端口",
      note: "MSTP 只有 Forwarding / Learning / Discarding 三种端口状态，STP 的 Blocking、Listening 都归入 Discarding。"
    };
  }
  if(tab === "bridge"){
    const root = rootOf(S);
    return {
      head: ["DEVICE", "PRIORITY", "MAC", "BRIDGE ID", "判定"],
      rows: DEV_ORDER.map(function(dev){
        const s = S[dev];
        return {
          key: "b-" + dev,
          cells: [
            { t: dev, cls: "c" },
            { t: s.priority, cls: s.priority !== 32768 ? "warn" : "c" },
            { t: s.mac.toUpperCase(), cls: "c" },
            { t: s.priority + "." + s.mac, cls: "c" },
            { t: dev === root ? "根桥" : "非根桥", cls: dev === root ? "ok" : "dim" }
          ]
        };
      }),
      note: "桥 ID = 桥优先级 + MAC，数字小的当根：先比优先级，优先级相同才比 MAC。"
    };
  }
  if(tab === "mac"){
    const root = rootOf(S);
    const rs = S[root];
    const sorted = DEV_ORDER.slice().sort(function(a, b){ return cmpBridge(S[a], S[b]); });
    return {
      head: ["顺序", "DEVICE", "MAC", "PRIORITY", "判读"],
      rows: sorted.map(function(dev, i){
        const s = S[dev];
        let why;
        if(dev === root) why = "桥 ID 最小，直接当选根桥";
        else if(s.priority !== rs.priority) why = "优先级 " + s.priority + " 比根桥大，MAC 再小也没用";
        else why = "优先级相同，MAC 比根桥大 → 落选";
        return {
          key: "m-" + dev,
          cells: [
            { t: "#" + (i + 1), cls: "c" },
            { t: dev, cls: "c" },
            { t: s.mac.toUpperCase(), cls: "c" },
            { t: s.priority, cls: "c" },
            { t: why, cls: dev === root ? "ok" : "dim" }
          ]
        };
      }),
      note: "三台都是缺省优先级时，胜负完全由 MAC 决定 —— 谁先上架、谁接了几台 PC，一点关系都没有。"
    };
  }
  /* tcn */
  const root = rootOf(S);
  const d = costMap(S, root);
  return {
    head: ["DEVICE", "TCN 计数", "最近一次拓扑变更", "ROOT PORT"],
    rows: DEV_ORDER.map(function(dev){
      const s = S[dev];
      const rp = rootPortOf(S, dev, root, d);
      return {
        key: "t-" + dev,
        cells: [
          { t: dev, cls: "c" },
          { t: s.tcn, cls: s.tcn > 0 ? "warn" : "dim" },
          { t: s.tcReason, cls: "c" },
          { t: dev === root ? "—（根桥）" : (rp || "—"), cls: "c" }
        ]
      };
    }),
    note: "角色一变就产生一次拓扑变更通知（TCN），根桥会向全网泛洪 TC 让各台的 MAC 表提前老化。本实验只统计次数，不模拟泛洪过程。"
  };
}

/* ---------------- 拓扑 ---------------- */
function topology(S, ui, ctx){
  const root = rootOf(S);
  const devices = DEV_ORDER.map(function(id){
    const d = DEV[id], sw = S[id];
    const isRoot = id === root;
    const ports = PORT_GEO[id].map(function(g){
      const p = sw.ports[g.name];
      return {
        name: g.name, kind: g.kind, x: g.x, y: g.y,
        color: portColor(p), up: p.up, label: g.label, dimBand: !p.up
      };
    });
    return {
      id: id, x: d.x, y: d.y, w: d.w, h: d.h, model: "S5700-28C-EI",
      silk: "M12 24 h60 M12 28 h44 M12 32 h60 M12 36 h44",
      leds: [
        { x: 272, y: 10, color: "#35E08A", glow: true, label: "PWR", tx: 278, ty: 12.5 },
        { x: 258, y: 10, color: "#38E1FF", glow: true, label: "SYS", tx: 232, ty: 12.5 }
      ],
      ports: ports,
      tags: [
        { x: 0, y: -8, text: id, cls: "dev-label" },
        { x: 34, y: -8, text: "PRI " + sw.priority + (isRoot ? " · ROOT" : ""), cls: "dev-sub" }
      ]
    };
  });

  const links = LINKS.map(function(lk){
    const st = linkState(S, lk);
    return {
      id: "lk-" + lk.id,
      d: ROUTES[lk.id + "-ab"],
      cls: !st.up ? "down" : (st.carries ? "trunk on" : "trunk"),
      flow: st.carries ? 1 : 0,
      flowColor: st.carries ? "56,225,255" : "126,147,171"
    };
  });

  const pc1 = S.SW1.ports["GE0/0/1"];
  const pc2 = S.SW3.ports["GE0/0/1"];
  links.push({ id: "lk-pc1", d: ROUTES["sw1-to-pc1"], cls: "", flow: pc1.up ? 0.4 : 0, flowColor: "167,139,250" });
  links.push({ id: "lk-pc2", d: ROUTES["sw3-to-pc2"], cls: "", flow: pc2.up ? 0.4 : 0, flowColor: "167,139,250" });

  const hosts = [
    { id: "PC1", x: 150, y: 200, ip: "192.168.1.10", mac: "5489-98D1-0001", vlan: 1, color: COL.edge, up: pc1.up },
    { id: "PC2", x: 1280, y: 200, ip: "192.168.1.20", mac: "5489-98D1-0002", vlan: 1, color: COL.edge, up: pc2.up }
  ];

  const labels = [];
  labels.push({ text: "ROOT", x: DEV[root].x + 150, y: 152, anchor: "middle", cls: "lk-tag on" });

  LINKS.forEach(function(lk){
    const st = linkState(S, lk);
    let txt = "FORWARDING", cls = "lk-tag on";
    if(!st.up){ txt = "LINK DOWN"; cls = "lk-tag bad"; }
    else if(!st.carries){ txt = "BLOCKED"; cls = "lk-tag bad"; }
    const x = lk.id === "l12" ? 450 : lk.id === "l23" ? 935 : 690;
    const y = lk.id === "l13" ? 204 : 107;
    labels.push({ text: txt, x: x, y: y, anchor: "middle", cls: cls });
  });

  return {
    viewBox: "0 0 1400 300",
    devices: devices, hosts: hosts, links: links, routes: ROUTES,
    anchors: PORT_ABS, labels: labels
  };
}

function linkState(S, lk){
  const pa = S[lk.a].ports[lk.pa];
  const pb = S[lk.b].ports[lk.pb];
  const up = pa.up && pb.up;
  return { up: up, carries: up && pa.state === "Forwarding" && pb.state === "Forwarding" };
}

/* ---------------- 数据面：沿生成树转发 ---------------- */
function routeOf(lk, from){ return lk.id + "-" + (lk.a === from ? "ab" : "ba"); }

function stpPath(S){
  const seen = { SW1: true };
  const prev = {};
  const q = ["SW1"];
  while(q.length){
    const cur = q.shift();
    for(let i = 0; i < LINKS.length; i++){
      const lk = LINKS[i];
      let other = "";
      if(lk.a === cur) other = lk.b;
      else if(lk.b === cur) other = lk.a;
      else continue;
      if(seen[other]) continue;
      if(!linkCarries(S, lk)) continue;
      seen[other] = true;
      prev[other] = { from: cur, link: lk };
      q.push(other);
    }
  }
  if(!seen.SW3) return null;
  const hops = [];
  let cur = "SW3";
  while(cur !== "SW1"){
    const pv = prev[cur];
    if(!pv) return null;
    hops.unshift({ from: pv.from, to: cur, link: pv.link });
    cur = pv.from;
  }
  return hops;
}

function blockedDesc(S){
  const out = [];
  LINKS.forEach(function(lk){
    if(!linkUp(S, lk)) return;
    if(linkCarries(S, lk)) return;
    const pa = S[lk.a].ports[lk.pa];
    const pb = S[lk.b].ports[lk.pb];
    if(pa.state !== "Forwarding") out.push(lk.a + " " + lk.pa);
    if(pb.state !== "Forwarding") out.push(lk.b + " " + lk.pb);
  });
  return out;
}

export function stpScene(S, opts){
  const conv = !!(opts && opts.conv);
  const hops = stpPath(S);
  const frames = [];
  const trace = [];
  const sc = {
    name: "PC1 → PC2 · 沿生成树转发", realSec: 3.6, dur: 1,
    traceTitle: "逐跳判读", frames: frames, trace: trace, drop: null, verdict: null
  };

  frames.push({ route: "pc1-to-sw1", t0: 0, t1: 0.10, kind: "broadcast" });

  if(conv){
    trace.push({
      h: "⓪ 收敛窗口",
      p: "链路刚断时端口还没算完：Max Age 20s 等 BPDU 超时，再 Listening 15s、Learning 15s，合计 <b>30~50s</b> 才 Forwarding。本实验跳过这段时间，直接给你收敛后的结果。",
      cls: ""
    });
  }

  if(!hops){
    sc.drop = { x: 150, y: 168, at: 0.14, label: "NO PATH · 生成树里没有路" };
    trace.push({ h: "① 入方向 · SW1 GE0/0/1", p: "帧进入 SW1，剩下的交给转发表和生成树。", cls: "" });
    trace.push({ h: "② 没有转发出口", p: "SW1 上能去 SW3 的口全都不在 Forwarding 状态。生成树里不存在 SW1 → SW3 的路径，帧在 SW1 上被丢弃。", cls: "drop" });
    sc.verdict = { bad: true, text: "生成树被切成了两半。这种时候先看 display stp brief：每个口的状态才是真相，链路灯只说明物理层通。" };
    return sc;
  }

  trace.push({
    h: "① 入方向 · SW1 GE0/0/1",
    p: "PC1 的帧进入 SW1。该口接主机，Role <b>Designated</b>、State <b>Forwarding</b>，本身不做任何过滤。",
    cls: ""
  });

  let t = 0.14;
  hops.forEach(function(h, i){
    const lk = h.link;
    const nearPort = lk.a === h.from ? lk.pa : lk.pb;
    const farPort = lk.a === h.from ? lk.pb : lk.pa;
    frames.push({ route: routeOf(lk, h.from), t0: t, t1: t + 0.22, kind: "broadcast" });
    t += 0.25;
    trace.push({
      h: (i === 0 ? "② " : "③ ") + "转发 · " + h.from + " → " + h.to,
      p: h.from + " " + nearPort + " Role <b>" + S[h.from].ports[nearPort].role + "</b>；对端 " + h.to + " " +
        farPort + " Role <b>" + S[h.to].ports[farPort].role + "</b>。这一段在生成树里是唯一可走的物理链路。",
      cls: ""
    });
  });

  const tEnd = Math.min(t + 0.09, 0.95);
  frames.push({ route: "sw3-to-pc2", t0: Math.min(t, 0.86), t1: tEnd, kind: "broadcast" });
  if(t + 0.14 <= 1){
    frames.push({ route: "pc2-to-sw3", t0: t + 0.14, t1: Math.min(t + 0.2, 1), kind: "unicast" });
  }

  trace.push({
    h: "④ 出方向 · SW3 GE0/0/1",
    p: "目的主机挂在 SW3 的 GE0/0/1 上，帧从该口送到 PC2。回程路径完全对称。",
    cls: "pass"
  });

  const blocked = blockedDesc(S);
  if(blocked.length){
    trace.push({
      h: "⑤ 被阻塞的那条",
      p: blocked.join("、") + " 是 <b>Alternate / Discarding</b>：链路 up、端口灯亮、一个业务帧也不转。生成树把三角形砍成了一棵无环的树。",
      cls: "drop"
    });
  }

  sc.verdict = {
    bad: false,
    text: "二层可达。转发路径由 STP 的逻辑树决定，不是物理最短路径 —— 那条看着好好的链路可能正被阻塞着。"
  };
  return sc;
}

export function failScene(S){
  const frames = [
    { route: "pc1-to-sw1", t0: 0, t1: 0.10, kind: "broadcast" },
    { route: "l13-ab", t0: 0.14, t1: 0.26, kind: "broadcast" }
  ];
  return {
    name: "拔掉 SW1—SW3 · 业务中断",
    realSec: 3.2, dur: 1,
    traceTitle: "扰动判读",
    frames: frames,
    drop: { route: "l13-ab", p: 0.35, at: 0.24, label: "LINK DOWN" },
    trace: [
      { h: "① 物理层", p: "SW1 GE0/0/3 与 SW3 GE0/0/3 两端同时 down，这条链路从生成树里消失。", cls: "drop" },
      { h: "② 原来的路径没了", p: "PC1 → SW1 → SW3 正好走这条直连。链路一断，这条转发路径直接失效。", cls: "drop" },
      { h: "③ 备份端口被唤醒", p: "SW3 的 GE0/0/2 原来是 Alternate / Discarding，它就是为这一刻准备的：先变 Root 口，再经过 Listening、Learning 才 Forwarding。", cls: "" },
      { h: "④ 中断窗口", p: "Max Age 20s 等 BPDU 超时 + Listening 15s + Learning 15s，真实设备 <b>30~50s</b>。这段时间 PC1 → PC2 不通。", cls: "" }
    ],
    verdict: {
      bad: true,
      text: "STP 的价值不是「不断网」，而是「断了能自己恢复」。恢复前那几十秒，是二层防环必须付的代价。"
    }
  };
}

export function edgeScene(S){
  const hops = stpPath(S);
  const on = S.SW1.ports["GE0/0/1"].edge && S.SW3.ports["GE0/0/1"].edge;
  const frames = [{ route: "pc1-to-sw1", t0: 0, t1: 0.12, kind: "broadcast" }];
  const trace = [];
  if(hops){
    let t = 0.16;
    hops.forEach(function(h){
      frames.push({ route: routeOf(h.link, h.from), t0: t, t1: t + 0.2, kind: "broadcast" });
      t += 0.23;
    });
    frames.push({ route: "sw3-to-pc2", t0: Math.min(t, 0.88), t1: Math.min(t + 0.08, 0.96), kind: "broadcast" });
  }
  trace.push({ h: "① 边缘端口是什么", p: "接终端的口不可能成环，没必要让它参与生成树。开启后它<b>不参与角色竞争</b>，链路 up 直接 Forwarding。", cls: "" });
  trace.push({ h: "② 省掉了什么", p: "普通端口从 up 到转发要经过 Listening 15s + Learning 15s，约 <b>30s</b>；边缘端口是 0。PC 每天开机都省这 30 秒。", cls: "" });
  trace.push({ h: "③ 还少了一次泛洪", p: "PC 上下线不再触发 TCN，根桥也就不会向全网泛洪 TC、让所有交换机的 MAC 表提前老化。", cls: "" });
  trace.push({ h: "④ BPDU 保护", p: "边缘端口不设防：万一有人把交换机接到这个口上，环路就没人挡了。所以要配 <b>stp bpdu-protection</b>：一旦收到 BPDU 就自动 shutdown 并告警。", cls: "" });
  return {
    name: on ? "边缘端口 · 上线即转发" : "边缘端口还没开",
    realSec: 3.2, dur: 1,
    traceTitle: "边缘端口判读",
    frames: frames,
    drop: null,
    trace: trace,
    verdict: {
      bad: !on,
      text: on
        ? "边缘端口只配在真正接终端的口上（PC1 / PC2 两侧）。省下的是收敛时间，代价是必须用 BPDU 保护兜底。"
        : "PC1 / PC3 侧的口还没开边缘端口。它们每次链路 up 都要走完整的 30s 状态迁移。"
    }
  };
}

/* ---------------- 引导 ---------------- */
function guide(S, ctx){
  const G = (phase, why, cmd) => ({ phase: phase, why: why, cmd: cmd || "" });
  const dev = ctx.dev, sw = S[dev];

  if(ctx.view === "if"){
    const pn = ifPort(ctx);
    const p = sw.ports[pn];
    if(!p) return G("enter", "这个端口不存在，quit 退出去。", "quit");
    if(pn === "GE0/0/1"){
      if(!p.edge)
        return G("edge", pn + " 接的是主机。开成边缘端口后不参与生成树，链路 up 立刻 Forwarding，不用等 30s。", "stp edged-port enable");
      return G("edge", pn + " 已经是边缘端口。quit 退出，回到系统视图。", "quit");
    }
    if(dev === "SW3" && pn === "GE0/0/3" && p.cost !== 100000)
      return G("cost", "把这条链路的端口开销调大，SW3 会改用 GE0/0/2 那条路去根桥 —— 根端口随之转移，直连反而变成备份。", "stp cost 100000");
    return G("cost", pn + " 不是这一步要改的口。quit 退出。", "quit");
  }

  if(ctx.view === "system"){
    if(dev === "SW1" && sw.priority !== 4096 && sw.priority !== 0)
      return G("elect", "三台优先级都是 32768 时只能比 MAC。把 SW1 的桥优先级压到 4096，它立刻成为根桥。", "stp priority 4096");
    if(dev === "SW1" && !sw.ports["GE0/0/1"].edge)
      return G("edge", "根桥定下来了。接着把接 PC1 的口开成边缘端口。", "interface GigabitEthernet 0/0/1");
    if(dev === "SW3"){
      if(!linkUp(S, findLink("l13")))
        return G("restore", "SW1—SW3 这条链路现在是断的。先点下方「插回 SW1—SW3」把它接上，再改 cost 才有对比。", "");
      const p3 = sw.ports["GE0/0/3"];
      if(p3.cost !== 100000)
        return G("cost", "试着把 SW3 GE0/0/3 的 cost 调到 100000，看根端口会不会换到 GE0/0/2。", "interface GigabitEthernet 0/0/3");
      if(!sw.ports["GE0/0/1"].edge)
        return G("edge", "SW3 这边的 PC 口也开成边缘端口。", "interface GigabitEthernet 0/0/1");
    }
    return G("verify", "这台设备的配置齐了。用 display stp brief 按端口核对角色与状态。", "display stp brief");
  }

  return G("enter", "<" + dev + "> 是用户视图，只能看不能改。改配置前先 system-view。", "system-view");
}

/* ---------------- 板块 ---------------- */
const steps = [
  {
    id: 1, name: "基线 · 谁当根",
    run: api => { api.setDev("SW1"); return api.run(["display stp", "display stp root", "display stp brief"]); },
    summary: "三台优先级都是 32768，MAC 最小的 SW2 成为根桥",
    detail: [
      { h: "反直觉的点", p: "三台配置一模一样，谁当根<b>不是</b>看位置、不是看接了几台 PC，而是比 MAC。MAC 是出厂烧死的，等于根桥在上架那一刻就被决定了。" },
      { h: "现场后果", p: "换一台新设备上架、或者改了一台的老化时间，都可能让根桥漂移，全网重算一次 —— 这就是为什么生产网一定要手工指定根桥。" }
    ]
  },
  {
    id: 2, name: "改桥优先级",
    done: S => S.SW1.priority === 4096 || S.SW1.priority === 0,
    run: async api => { api.setDev("SW1"); await api.run(["system-view", "stp priority 4096", "display stp root"]); },
    summary: "SW1 优先级 32768 → 4096，根桥易主",
    detail: [
      { h: "选举顺序", p: "先比桥优先级，相同才比 MAC。4096 比 32768 小，SW1 直接拿走根桥，MAC 再大也没关系。" },
      { h: "全网联动", p: "根桥一换，<b>每台设备的根端口都要重算</b>。注意拓扑上「BLOCKED」的标记已经换了位置。" }
    ]
  },
  {
    id: 3, name: "看端口角色",
    run: async api => {
      api.setDev("SW1"); await api.run(["display stp brief"]);
      api.setDev("SW2"); await api.run(["display stp brief"]);
      api.setDev("SW3"); await api.run(["display stp brief"]);
    },
    summary: "根桥全是 DESI；非根桥各有一个 ROOT；剩下的那条是 ALTE",
    detail: [
      { h: "三种角色", p: "根桥的所有口都是 <b>DESI</b>（指定端口）。非根桥通向根桥的那个口是 <b>ROOT</b>。既不是根口、又没争到指定的，就是 <b>ALTE</b>。" },
      { h: "SW2 与 SW3 的差别", p: "SW2 有 ROOT + DESI；SW3 有 ROOT + ALTE。ALTE 那个口就是被砍掉的环。" }
    ]
  },
  {
    id: 4, name: "阻塞端口", key: true,
    run: async api => {
      api.setDev("SW3");
      await api.run(["display stp brief"]);
      api.fx({ kind: "pulse", target: "SW3/GE0/0/2", color: COL.alte });
      api.say("// GE0/0/2 的 PHY 是 up，Role=ALTE、State=DISCARDING。", "op");
    },
    summary: "SW3 GE0/0/2 物理 up，但一个业务帧也不转",
    detail: [
      { h: "两条路径谁赢", p: "SW3 去根桥：直连 GE0/0/3 只要 20000，经 SW2 要 40000，所以 GE0/0/3 当根口。GE0/0/2 这条就下岗了。" },
      { h: "别只看灯", p: "端口灯全绿、链路利用率 0%。<b>物理层通 ≠ 二层在转发</b>，这是二层排障最容易踩的坑。" }
    ]
  },
  {
    id: 5, name: "数据面 · 沿树转发", key: true, keepTrace: true,
    run: api => { api.play(stpScene(api.S)); },
    summary: "PC1 → PC2 走 SW1 → SW3 直连，绕开被阻塞的那条",
    detail: [
      { h: "路径怎么定的", p: "PC2 挂在 SW3，SW1 到 SW3 的直连两端都在 Forwarding，这就是唯一可走的一段。经 SW2 的路在 SW3 侧是 Discarding。" }
    ]
  },
  {
    id: 6, name: "扰动 · 拔掉直连", key: true, keepTrace: true,
    run: api => {
      setLink(api.S, "l13", false);
      api.fx({ kind: "pulse", target: "SW1/GE0/0/3", color: COL.alte });
      api.fx({ kind: "pulse", target: "SW3/GE0/0/3", color: COL.alte });
      api.tab("port");
      api.play(failScene(api.S));
    },
    summary: "SW1—SW3 断开，PC1 → PC2 立刻不通",
    detail: [{ h: "为什么要留备份", p: "刚才那个「被阻塞的」GE0/0/2 不是浪费 —— 它就是为了这一刻。没有它，这条链路一断，网络就分裂了。" }]
  },
  {
    id: 7, name: "重新收敛", key: true, keepTrace: true,
    done: S => !linkUp(S, findLink("l13")) && S.SW3.ports["GE0/0/2"].role === "Root",
    run: async api => {
      api.setDev("SW3");
      await api.run(["display stp brief"]);
      api.play(stpScene(api.S, { conv: true }));
    },
    summary: "SW3 GE0/0/2 从 ALTE 变 ROOT 并 Forwarding，业务绕 SW2 恢复",
    detail: [
      { h: "状态迁移", p: "Alternate → Root，状态还要走 Discarding → Listening → Learning → Forwarding。真实设备 <b>30~50s</b>。" },
      { h: "简化声明", p: "本实验直接给出收敛后的稳态结果，不模拟逐 tick 的 BPDU 交互。真实环境里这段时间业务是断的。" }
    ]
  },
  {
    id: 8, name: "改 cost 影响选路",
    done: S => S.SW3.ports["GE0/0/3"].cost === 100000,
    run: async api => {
      setLink(api.S, "l13", true);
      api.setDev("SW3");
      await api.run(["system-view", "interface GigabitEthernet 0/0/3", "stp cost 100000", "quit", "display stp brief"]);
    },
    summary: "GE0/0/3 开销 20000 → 100000，根端口转到 GE0/0/2",
    detail: [
      { h: "开销就是「远近」", p: "端口开销越大，这条路在生成树里就越「远」。直连被抬到 100000 之后，经 SW2 的 40000 反而更划算。" },
      { h: "结果", p: "SW3 的根端口换成 GE0/0/2，直连 GE0/0/3 变成 ALTE —— <b>链路明明是通的、还是最短的，却不再转发</b>。" }
    ]
  },
  {
    id: 9, name: "边缘端口",
    done: S => S.SW1.ports["GE0/0/1"].edge && S.SW3.ports["GE0/0/1"].edge,
    run: async api => {
      api.setDev("SW1");
      await api.run(["system-view", "interface GigabitEthernet 0/0/1", "stp edged-port enable", "quit"]);
      api.setDev("SW3");
      await api.run(["system-view", "interface GigabitEthernet 0/0/1", "stp edged-port enable", "quit"]);
      api.play(edgeScene(api.S));
    },
    summary: "接 PC 的两个口不参与生成树，链路 up 直接 Forwarding",
    detail: [
      { h: "省了什么", p: "普通口 up 后要 Listening 15s + Learning 15s 才转发；边缘端口是 0，而且 PC 上下线不再触发 TCN 泛洪。" },
      { h: "BPDU 保护", p: "边缘端口不设防：误接交换机就可能成环。所以还要配 <b>stp bpdu-protection</b>，收到 BPDU 就自动 shutdown 并告警。" }
    ]
  },
  {
    id: 10, name: "校验 · 角色与状态",
    run: async api => {
      api.setDev("SW1"); await api.run(["display stp brief", "display stp root"]);
      api.setDev("SW3"); await api.run(["display stp brief", "display stp root"]);
    },
    summary: "对照根桥 ID、根端口与端口状态，收尾",
    detail: [
      { h: "三行结论", p: "① Root Bridge ID 三台一致；② 每台非根桥的 Root Port 都指向开销更小的方向；③ 全环只有一个口是 ALTE。" },
      { h: "排障顺序", p: "先 display stp root 看根桥是不是你以为的那台，再 display stp brief 逐口看角色，最后才去看物理链路。" }
    ]
  }
];

/* ---------------- 导出 ---------------- */
export default {
  id: "02",
  title: "STP 选举与收敛",
  meta: "HUAWEI S5700 · VRP V200R005C00",
  stageLabel: "L2 LOOP PREVENTION · 3 × S5700 · TRIANGLE",
  totalSteps: steps.length,
  devices: ["SW1", "SW2", "SW3"],
  tabs: [
    { key: "port", label: "端口角色与状态", hint: "当前设备的 STP 端口表" },
    { key: "bridge", label: "桥优先级", hint: "三台设备的桥 ID 对照" },
    { key: "mac", label: "MAC 地址", hint: "MAC 决定胜负时的比较顺序" },
    { key: "tcn", label: "拓扑变更", hint: "TCN 计数与根端口" }
  ],
  legend: [
    { c: "#35E08A", label: "Root 根端口" },
    { c: "#38E1FF", label: "Designated 指定端口" },
    { c: "#FF4D5E", label: "Alternate 阻塞" },
    { c: "#A78BFA", label: "边缘端口 / 主机" },
    { c: "#7E93AB", label: "物理 down" }
  ],
  phases: {
    enter: "进系统视图",
    elect: "改桥优先级",
    cost: "改端口开销",
    edge: "开边缘端口",
    restore: "插回链路",
    verify: "校验"
  },
  viewName: VIEW_NAME,
  viewHint: VIEW_HINT,
  actions: [
    { id: "path", label: "PC1 → PC2", run: l => l.playScene(stpScene(l.S)) },
    {
      id: "pull", label: "拔掉 SW1—SW3",
      run: l => {
        setLink(l.S, "l13", false);
        l.write("--- 已拔掉 SW1—SW3 的直连链路（两端物理 down）---", "op");
        l.write("", "dim");
        l.playScene(failScene(l.S));
      }
    },
    {
      id: "plug", label: "插回 SW1—SW3",
      run: l => {
        setLink(l.S, "l13", true);
        l.write("--- 已插回 SW1—SW3 的直连链路 ---", "op");
        l.write("", "dim");
        l.playScene(stpScene(l.S, { conv: true }));
      }
    }
  ],
  createState, prompt, commands, tables, topology, guide, steps,

  idle: {
    title: "判读顺序",
    items: [
      { h: "① 先看桥 ID", p: "桥优先级 + MAC，数字最小的那台是根桥，它的所有端口都是 Designated。" },
      { h: "② 再看根端口", p: "非根桥上通向根桥、路径开销最小的那个口是 Root 口。" },
      { h: "③ 最后看剩下的", p: "既不是根口、又没争到指定端口的，就是 Alternate —— 它 up 但不转发。" },
      { h: "④ 数据面验证", p: "PC1 → PC2 的帧沿着这棵树走；被阻塞的链路一个业务帧也不会经过。" },
      { h: "⑤ 简化声明", p: "端口状态是收敛后的稳态结果，不模拟 Hello / BPDU 的逐 tick 交互；收敛窗口按真实设备 30~50s 标注。VRP 默认跑 MSTP，本实验按 MSTP 单实例（等价于 STP）表述。" }
    ]
  },

  viewRows(ctx){
    return [
      { h: "<" + ctx.dev + "> 用户视图", p: "只读：display stp / brief / root。", cls: ctx.view === "user" ? "pass" : "" },
      { h: "[" + ctx.dev + "] 系统视图", p: "全局：stp priority、stp root primary、interface。", cls: ctx.view === "system" ? "pass" : "" },
      { h: "[" + ctx.dev + "-GE0/0/x] 接口视图", p: "单端口：stp cost、stp edged-port enable。", cls: ctx.view === "if" ? "pass" : "" }
    ];
  },

  boot(write, printGuide){
    write("Info: 已加载 SW1 / SW2 / SW3 三台 S5700 的出厂配置：桥优先级均为 32768，MSTP 单实例（CIST 0）。", "dim");
    write("      三台两两互联成三角；PC1 接 SW1 GE0/0/1，PC2 接 SW3 GE0/0/1，全部端口在默认 VLAN 1。", "dim");
    write("      简化声明：收敛时序为稳态模型，不模拟逐 tick 的 BPDU 交互，收敛窗口按真实值 30~50s 标注。", "dim");
    write("", "dim");
    printGuide();
  }
};
