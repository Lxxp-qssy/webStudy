import { pad, padL } from "../lib/util.js";

/* =========================================================================
   实验 06 · OSPF 邻居与选路
   -------------------------------------------------------------------------
   三台 AR2220 组成一个三角形：R1 — R2 — R3，另有一条 R1 — R3 直连。
   全实验只围绕一件事：OSPF 如何把「邻居关系」变成「路由表里的下一跳」。

     createState   → 接口地址已配好、OSPF 未启用（基线）
     adjacency     → 每条链路的邻居状态：Full / 2-Way / Down / 未启用
     ospfRoutesOf  → 从 Full 邻居图跑一遍最短路，按接口 cost 累加
     ospfPathScene → 逐跳：查表 → 下一跳 → 重写二层 → TTL 递减

   简化声明：SPF 是稳态实现，按接口 cost 做最短路径，不模拟 LSA 泛洪时序、
   DR/BDR 选举与 Hello 定时器。area 不一致时用 2-Way 表示「Hello 能收到但
   参数对不上」，真实 VRP 上这种情况通常连邻居表都不会出现。
   ========================================================================= */

/* ---------------- 拓扑常量 ---------------- */
const ROUTERS = ["R1", "R2", "R3"];

const DEV = {
  R1: {
    x: 70, y: 62, w: 300, h: 74,
    portX: { "GE0/0/0": 70, "GE0/0/1": 190, "GE0/0/2": 270 }
  },
  R2: {
    x: 540, y: 62, w: 300, h: 74,
    portX: { "GE0/0/0": 70, "GE0/0/1": 270 }
  },
  R3: {
    x: 1010, y: 62, w: 300, h: 74,
    portX: { "GE0/0/0": 70, "GE0/0/1": 190, "GE0/0/2": 270 }
  }
};

const ROUTER_MAC = {
  R1: "00e0-fc12-3401",
  R2: "00e0-fc12-3402",
  R3: "00e0-fc12-3403"
};

const HOSTS = {
  PC1: {
    id: "PC1", ip: "192.168.1.10", net: "192.168.1.0", mask: 24,
    gw: "192.168.1.1", router: "R1", port: "GE0/0/0",
    mac: "5489-98a1-0001", x: 140, y: 240
  },
  PC2: {
    id: "PC2", ip: "192.168.2.10", net: "192.168.2.0", mask: 24,
    gw: "192.168.2.1", router: "R3", port: "GE0/0/1",
    mac: "5489-98a2-0002", x: 1200, y: 240
  }
};

/* 链路表：物理拓扑与 OSPF 邻接都从这里派生 */
const LINKS = [
  {
    id: "l12", a: "R1", ap: "GE0/0/1", b: "R2", bp: "GE0/0/0",
    net: "10.0.12.0", mask: 30, route: "r12", rev: "r21"
  },
  {
    id: "l23", a: "R2", ap: "GE0/0/1", b: "R3", bp: "GE0/0/0",
    net: "10.0.23.0", mask: 30, route: "r23", rev: "r32"
  },
  {
    id: "l13", a: "R1", ap: "GE0/0/2", b: "R3", bp: "GE0/0/2",
    net: "10.0.13.0", mask: 30, route: "r13", rev: "r31"
  }
];

/* 场景路径：与拓扑里的链路几何严格一致 */
const ROUTES = {
  "pc1-up": "M140 236 L140 136",
  "pc1-down": "M140 136 L140 236",
  "pc2-up": "M1200 236 L1200 136",
  "pc2-down": "M1200 136 L1200 236",
  "r12": "M260 106 L610 106",
  "r21": "M610 106 L260 106",
  "r23": "M810 106 L1080 106",
  "r32": "M1080 106 L810 106",
  "r13": "M340 106 C420 224 1200 224 1280 106",
  "r31": "M1280 106 C1200 224 420 224 340 106"
};

/* 本实验的规划值：引导与目标判定都以它为准 */
const PLAN = {
  R1: {
    rid: "1.1.1.1",
    nets: [
      { net: "10.0.12.0", wild: "0.0.0.3" },
      { net: "192.168.1.0", wild: "0.0.0.255" },
      { net: "10.0.13.0", wild: "0.0.0.3" }
    ]
  },
  R2: {
    rid: "2.2.2.2",
    nets: [
      { net: "10.0.12.0", wild: "0.0.0.3" },
      { net: "10.0.23.0", wild: "0.0.0.3" }
    ]
  },
  R3: {
    rid: "3.3.3.3",
    nets: [
      { net: "10.0.23.0", wild: "0.0.0.3" },
      { net: "192.168.2.0", wild: "0.0.0.255" },
      { net: "10.0.13.0", wild: "0.0.0.3" }
    ]
  }
};

/* ---------------- IP / 掩码工具 ---------------- */
function ipToInt(ip){
  const p = String(ip).split(".");
  if(p.length !== 4) return null;
  let v = 0;
  for(let i = 0; i < 4; i++){
    if(!/^\d{1,3}$/.test(p[i])) return null;
    const n = parseInt(p[i], 10);
    if(n > 255) return null;
    v = v * 256 + n;
  }
  return v >>> 0;
}

function intToIp(v){
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join(".");
}

function maskInt(len){
  if(len <= 0) return 0;
  if(len >= 32) return 0xFFFFFFFF;
  return (0xFFFFFFFF << (32 - len)) >>> 0;
}

function lenToMask(len){
  return intToIp(maskInt(len));
}

function maskToLen(m){
  if(/^\d+$/.test(String(m))){
    const n = parseInt(m, 10);
    return (n >= 0 && n <= 32) ? n : -1;
  }
  const v = ipToInt(m);
  if(v === null) return -1;
  let len = 0, zero = false;
  for(let i = 31; i >= 0; i--){
    if((v >>> i) & 1){
      if(zero) return -1;
      len++;
    }else{
      zero = true;
    }
  }
  return len;
}

function netOf(ip, len){
  const v = ipToInt(ip);
  if(v === null) return "";
  return intToIp((v & maskInt(len)) >>> 0);
}

function wildMask(w){
  const v = ipToInt(w);
  if(v === null) return null;
  return (~v) >>> 0;
}

function netMatch(ip, net, wild){
  const m = wildMask(wild);
  const a = ipToInt(ip);
  const b = ipToInt(net);
  if(m === null || a === null || b === null) return false;
  return ((a & m) >>> 0) === ((b & m) >>> 0);
}

function areaId(x){
  const s = String(x);
  if(/^\d+$/.test(s)){
    const n = parseInt(s, 10);
    if(n < 0 || n > 4294967295) return "";
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  }
  const v = ipToInt(s);
  if(v === null) return "";
  return intToIp(v);
}

function areaShort(a){
  return a === "0.0.0.0" ? "0" : a;
}

function shortIf(n){
  return String(n).replace("GigabitEthernet", "GE");
}

function fullIf(n){
  const s = String(n);
  if(s.indexOf("GigabitEthernet") === 0) return s;
  if(s.indexOf("GE") === 0) return "GigabitEthernet" + s.slice(2);
  return s;
}

/* ---------------- 初始状态 ---------------- */
function makeRouter(name, rows){
  const ports = {};
  rows.forEach(function(r){
    ports[r[0]] = { ip: r[1], mask: r[2], up: true, cost: r[3] };
  });
  return {
    name: name,
    routerId: "",
    ospf: { enabled: false, area: "0.0.0.0", nets: [] },
    ports: ports,
    static: []
  };
}

export function createState(){
  return {
    R1: makeRouter("R1", [
      ["GE0/0/0", "192.168.1.1", 24, 1],
      ["GE0/0/1", "10.0.12.1", 30, 1],
      ["GE0/0/2", "10.0.13.1", 30, 30]
    ]),
    R2: makeRouter("R2", [
      ["GE0/0/0", "10.0.12.2", 30, 1],
      ["GE0/0/1", "10.0.23.1", 30, 1]
    ]),
    R3: makeRouter("R3", [
      ["GE0/0/0", "10.0.23.2", 30, 1],
      ["GE0/0/1", "192.168.2.1", 24, 1],
      ["GE0/0/2", "10.0.13.2", 30, 1]
    ]),
    flags: { areaDrill: false }
  };
}

/* ---------------- 基础查询 ---------------- */
function involves(link, dev){
  return link.a === dev || link.b === dev;
}

function otherEnd(link, dev){
  return link.a === dev ? link.b : link.a;
}

function localPort(link, dev){
  return link.a === dev ? link.ap : link.bp;
}

function peerPort(link, dev){
  return link.a === dev ? link.bp : link.ap;
}

function dirRoute(link, dev){
  return link.a === dev ? link.route : link.rev;
}

function linkByIface(dev, iface){
  for(let i = 0; i < LINKS.length; i++){
    const l = LINKS[i];
    if(l.a === dev && l.ap === iface) return l;
    if(l.b === dev && l.bp === iface) return l;
  }
  return null;
}

function autoRid(r){
  let best = -1;
  Object.keys(r.ports).forEach(function(pn){
    const p = r.ports[pn];
    const v = ipToInt(p.ip);
    if(v !== null && v > best) best = v;
  });
  return best < 0 ? "0.0.0.0" : intToIp(best);
}

function routerIdOf(r){
  return r.routerId || autoRid(r);
}

/* 接口是否被某条 network 语句覆盖；最后一条匹配的 area 生效 */
function ifaceOspf(r, pn){
  const p = r.ports[pn];
  if(!p || !p.ip) return null;
  let hit = null;
  for(let i = 0; i < r.ospf.nets.length; i++){
    const n = r.ospf.nets[i];
    if(netMatch(p.ip, n.net, n.wild)) hit = { area: n.area, prefix: netOf(p.ip, p.mask), mask: p.mask };
  }
  return hit;
}

function ospfIfaces(r){
  const out = [];
  Object.keys(r.ports).forEach(function(pn){
    const p = r.ports[pn];
    if(!p.ip) return;
    const hit = ifaceOspf(r, pn);
    if(!hit) return;
    out.push({
      pn: pn, p: p, area: hit.area,
      prefix: hit.prefix, mask: hit.mask, cost: p.cost
    });
  });
  return out;
}

/* 邻居状态：物理 up + 两端都启用 OSPF + 两端在同一个 area */
function adjacency(S, link){
  const A = S[link.a], B = S[link.b];
  const pa = A.ports[link.ap], pb = B.ports[link.bp];
  if(!pa.up || !pb.up){
    return { state: "Down", full: false, reason: "物理接口 shutdown" };
  }
  if(!A.ospf.enabled || !B.ospf.enabled){
    return { state: "—", full: false, reason: "一端未启用 OSPF" };
  }
  const ia = ifaceOspf(A, link.ap);
  const ib = ifaceOspf(B, link.bp);
  if(!ia || !ib){
    return { state: "—", full: false, reason: "接口未被 network 宣告" };
  }
  if(ia.area !== ib.area){
    return {
      state: "2-Way", full: false,
      areaA: ia.area, areaB: ib.area,
      reason: "area " + ia.area + " ≠ area " + ib.area
    };
  }
  return { state: "Full", full: true, area: ia.area, reason: "Hello 参数一致" };
}

function linkStates(S){
  const out = {};
  LINKS.forEach(function(l){ out[l.id] = adjacency(S, l).state; });
  return out;
}

/* ---------------- 最短路（三台路由器，手写枚举简单路径） ---------------- */
function fullEdges(S){
  const E = {};
  ROUTERS.forEach(function(id){ E[id] = []; });
  LINKS.forEach(function(l){
    if(!adjacency(S, l).full) return;
    const a = S[l.a], b = S[l.b];
    const pa = a.ports[l.ap], pb = b.ports[l.bp];
    E[l.a].push({ to: l.b, iface: l.ap, nhIp: pb.ip, cost: pa.cost, link: l.id });
    E[l.b].push({ to: l.a, iface: l.bp, nhIp: pa.ip, cost: pb.cost, link: l.id });
  });
  return E;
}

function bestPaths(S, src, dst){
  if(src === dst) return [{ cost: 0, first: null, links: [] }];
  const E = fullEdges(S);
  const all = [];
  function dfs(node, visited, cost, first, links){
    const arr = E[node] || [];
    for(let i = 0; i < arr.length; i++){
      const e = arr[i];
      if(visited[e.to]) continue;
      const f = first || { to: e.to, iface: e.iface, nhIp: e.nhIp, link: e.link };
      const ls = links.concat([e.link]);
      if(e.to === dst){
        all.push({ cost: cost + e.cost, first: f, links: ls });
        continue;
      }
      visited[e.to] = true;
      dfs(e.to, visited, cost + e.cost, f, ls);
      visited[e.to] = false;
    }
  }
  const v = {};
  v[src] = true;
  dfs(src, v, 0, null, []);
  if(!all.length) return [];
  let min = Infinity;
  all.forEach(function(p){ if(p.cost < min) min = p.cost; });
  return all.filter(function(p){ return p.cost === min; });
}

/* 某台路由器是否已经直连这个前缀 */
function directHas(S, dev, dest, mask){
  const r = S[dev];
  const names = Object.keys(r.ports);
  for(let i = 0; i < names.length; i++){
    const p = r.ports[names[i]];
    if(p.up && p.ip && p.mask === mask && netOf(p.ip, p.mask) === dest) return true;
  }
  return false;
}

/* OSPF 路由：先收集所有 Router LSA 宣告的前缀，再按 cost 选路 */
function ospfRoutesOf(S, dev){
  const r = S[dev];
  if(!r.ospf.enabled) return [];

  const prefixes = {};
  ROUTERS.forEach(function(rid){
    const rr = S[rid];
    if(!rr.ospf.enabled) return;
    ospfIfaces(rr).forEach(function(it){
      if(!it.p.up) return;
      const key = it.prefix + "/" + it.mask;
      if(!prefixes[key]) prefixes[key] = { dest: it.prefix, mask: it.mask, advs: [] };
      prefixes[key].advs.push({ router: rid, cost: it.cost });
    });
  });

  const out = [];
  Object.keys(prefixes).forEach(function(key){
    const p = prefixes[key];
    if(directHas(S, dev, p.dest, p.mask)) return;

    let best = Infinity;
    let cands = [];
    p.advs.forEach(function(adv){
      const paths = bestPaths(S, dev, adv.router);
      paths.forEach(function(path){
        const total = path.cost + adv.cost;
        if(total < best){
          best = total;
          cands = [{ path: path, adv: adv, total: total }];
        }else if(total === best){
          cands.push({ path: path, adv: adv, total: total });
        }
      });
    });

    const seen = {};
    cands.forEach(function(c){
      if(!c.path.first) return;
      const nh = c.path.first.nhIp;
      const iface = c.path.first.iface;
      const k = nh + "|" + iface;
      if(seen[k]) return;
      seen[k] = true;
      out.push({
        dest: p.dest, mask: p.mask, proto: "OSPF", pre: 10, cost: c.total,
        nextHop: nh, iface: iface, active: true,
        advRouter: routerIdOf(S[c.adv.router])
      });
    });
  });
  return out;
}

function routesOf(S, dev){
  const r = S[dev];
  const list = [];

  Object.keys(r.ports).forEach(function(pn){
    const p = r.ports[pn];
    if(!p.ip || !p.up) return;
    const d = netOf(p.ip, p.mask);
    list.push({
      dest: d, mask: p.mask, proto: "Direct", pre: 0, cost: 0,
      nextHop: p.ip, iface: pn, active: true
    });
    list.push({
      dest: p.ip, mask: 32, proto: "Local", pre: 0, cost: 0,
      nextHop: "127.0.0.1", iface: pn, active: true
    });
  });

  ospfRoutesOf(S, dev).forEach(function(rt){ list.push(rt); });

  list.sort(function(a, b){
    const d = (ipToInt(a.dest) || 0) - (ipToInt(b.dest) || 0);
    if(d) return d;
    if(a.mask !== b.mask) return b.mask - a.mask;
    if(a.pre !== b.pre) return a.pre - b.pre;
    return String(a.nextHop).localeCompare(String(b.nextHop));
  });
  return list;
}

function lookupAll(S, dev, dst){
  const v = ipToInt(dst);
  if(v === null) return [];
  const list = routesOf(S, dev).filter(function(rt){
    if(!rt.active) return false;
    return ((v & maskInt(rt.mask)) >>> 0) === ipToInt(rt.dest);
  });
  if(!list.length) return [];

  let bestMask = -1, bestPre = 999;
  list.forEach(function(rt){
    if(rt.mask > bestMask){ bestMask = rt.mask; bestPre = rt.pre; }
    else if(rt.mask === bestMask && rt.pre < bestPre) bestPre = rt.pre;
  });
  return list.filter(function(rt){ return rt.mask === bestMask && rt.pre === bestPre; });
}

function routeKey(rt){
  if(rt.proto === "Local") return "rt-Local-" + rt.dest + "-32";
  if(rt.proto === "OSPF") return "rt-OSPF-" + rt.dest + "-" + rt.mask + "-" + rt.nextHop;
  return "rt-" + rt.proto + "-" + rt.dest + "-" + rt.mask;
}

function firstRouteKey(S, dev, dest, mask){
  const list = routesOf(S, dev).filter(function(rt){
    return rt.dest === dest && rt.mask === mask && rt.proto === "OSPF";
  });
  return list.length ? routeKey(list[0]) : "";
}

function ospfRoutesFor(S, dev, dest, mask){
  return routesOf(S, dev).filter(function(rt){
    return rt.dest === dest && rt.mask === mask && rt.proto === "OSPF";
  });
}

function routeSig(S, dev, dest, mask){
  const list = ospfRoutesFor(S, dev, dest, mask);
  if(!list.length) return "无";
  return list.map(function(rt){
    return rt.nextHop + "/" + shortIf(rt.iface) + " cost " + rt.cost;
  }).join(" + ");
}

/* ---------------- 路径与流量 ---------------- */
function linkCounts(S, dev, dst, depth){
  if(depth > 4) return [];
  const rts = lookupAll(S, dev, dst);
  if(!rts.length) return null;
  let out = [];
  rts.forEach(function(rt){
    if(rt.proto === "Direct" || rt.proto === "Local"){
      out.push([]);
      return;
    }
    const link = linkByIface(dev, rt.iface);
    if(!link){
      out.push([]);
      return;
    }
    const sub = linkCounts(S, otherEnd(link, dev), dst, depth + 1);
    if(!sub || !sub.length){
      out.push([link.id]);
      return;
    }
    sub.forEach(function(arr){ out.push([link.id].concat(arr)); });
  });
  return out;
}

/* 拓扑光点只按 PC1 → PC2 的去程画：这是本实验的观察方向 */
function flowMap(S){
  const paths = linkCounts(S, "R1", "192.168.2.10", 0) || [];
  const counts = {};
  paths.forEach(function(arr){
    arr.forEach(function(id){ counts[id] = (counts[id] || 0) + 1; });
  });
  const out = {};
  const n = Math.max(1, paths.length);
  Object.keys(counts).forEach(function(id){ out[id] = Math.min(1, counts[id] / n); });
  return out;
}

function endToEnd(S){
  return lookupAll(S, "R1", "192.168.2.10").length > 0 &&
    lookupAll(S, "R3", "192.168.1.10").length > 0;
}

/* 逐跳走一遍，给场景用 */
function walk(S, start, dstIp){
  const steps = [];
  let dev = start;
  for(let i = 0; i < 4; i++){
    const rts = lookupAll(S, dev, dstIp);
    if(!rts.length) return { ok: false, dev: dev, steps: steps, why: "no-route" };
    const rt = rts[0];
    if(rt.proto === "Direct" || rt.proto === "Local"){
      steps.push({ dev: dev, rt: rt, link: null, next: null, ecmp: rts.length });
      return { ok: true, dev: dev, steps: steps };
    }
    const link = linkByIface(dev, rt.iface);
    if(!link) return { ok: false, dev: dev, steps: steps, why: "no-iface" };
    const next = otherEnd(link, dev);
    steps.push({ dev: dev, rt: rt, link: link, next: next, ecmp: rts.length });
    dev = next;
  }
  return { ok: false, dev: dev, steps: steps, why: "loop" };
}

/* ---------------- 视图 ---------------- */
const VIEW_NAME = {
  user: "用户视图",
  system: "系统视图",
  ospf: "OSPF 视图",
  area: "OSPF 区域视图",
  if: "接口视图"
};

const VIEW_HINT = {
  system: "system-view",
  ospf: "ospf 1",
  area: "ospf 1 → area 0",
  if: "interface GigabitEthernet 0/0/1"
};

function portKey(ctx){
  return "GE" + String(ctx.ifName).replace("GigabitEthernet", "");
}

function prompt(ctx){
  if(ctx.view === "user") return "<" + ctx.dev + ">";
  if(ctx.view === "system") return "[" + ctx.dev + "]";
  if(ctx.view === "ospf") return "[" + ctx.dev + "-ospf-1]";
  if(ctx.view === "area") return "[" + ctx.dev + "-ospf-1-area-" + (ctx.areaId || "0.0.0.0") + "]";
  return "[" + ctx.dev + "-" + fullIf(ctx.ifName) + "]";
}

/* ---------------- 展示辅助 ---------------- */
function neighborCellCls(state){
  if(state === "Full") return "ok";
  if(state === "2-Way") return "warn";
  if(state === "Down") return "bad";
  return "dim";
}

function peerIp(S, link, dev){
  const peer = otherEnd(link, dev);
  return S[peer].ports[peerPort(link, dev)].ip;
}

function lsaRouters(S, dev){
  const r = S[dev];
  if(!r.ospf.enabled) return [];
  const seen = {};
  seen[dev] = true;
  const queue = [dev];
  while(queue.length){
    const cur = queue.shift();
    LINKS.forEach(function(l){
      if(!involves(l, cur)) return;
      if(!adjacency(S, l).full) return;
      const n = otherEnd(l, cur);
      if(seen[n]) return;
      seen[n] = true;
      queue.push(n);
    });
  }
  return ROUTERS.filter(function(id){ return seen[id]; });
}

function firstStuck(S, dev){
  for(let i = 0; i < LINKS.length; i++){
    const l = LINKS[i];
    if(!involves(l, dev)) continue;
    const ad = adjacency(S, l);
    if(ad.state === "2-Way") return { link: l, ad: ad };
  }
  return null;
}

function localAreaOf(S, link, dev){
  const hit = ifaceOspf(S[dev], localPort(link, dev));
  return hit ? hit.area : "—";
}

function peerAreaOf(S, link, dev){
  const peer = otherEnd(link, dev);
  const hit = ifaceOspf(S[peer], peerPort(link, dev));
  return hit ? hit.area : "—";
}

function hasNet(r, net, wild, area){
  return r.ospf.nets.some(function(n){
    return n.net === net && n.wild === wild && n.area === area;
  });
}

function missingNets(S, dev){
  const r = S[dev];
  return PLAN[dev].nets.filter(function(n){
    return !hasNet(r, n.net, n.wild, "0.0.0.0");
  });
}

function devTodo(S, dev){
  const r = S[dev];
  if(!r.ospf.enabled) return 1;
  let n = 0;
  if(r.routerId !== PLAN[dev].rid) n++;
  n += missingNets(S, dev).length;
  return n;
}

function allFull(S){
  return LINKS.every(function(l){ return adjacency(S, l).full; });
}

/* 展示用的邻居列表：物理链路都列出来，OSPF 没起就是「—」 */
function neighborRows(S, dev){
  const out = [];
  LINKS.forEach(function(l){
    if(!involves(l, dev)) return;
    const peer = otherEnd(l, dev);
    const ad = adjacency(S, l);
    const peerRid = S[peer].ospf.enabled ? routerIdOf(S[peer]) : "—";
    let state = ad.state;
    if(state === "—" && !S[dev].ospf.enabled) state = "—";
    out.push({
      link: l, peer: peer, ad: ad,
      address: peerIp(S, l, dev),
      rid: peerRid,
      state: state,
      iface: localPort(l, dev),
      dead: ad.full ? "36s" : "—"
    });
  });
  return out;
}

/* ---------------- 命令表 ---------------- */
const commands = [
  {
    id: "system-view", match: /^(system-view|sys)$/, view: null, kind: "view",
    usage: "system-view",
    run(api){
      if(api.ctx.view !== "user"){
        api.say("Error: Unrecognized command found at '^' position.", "err");
        return;
      }
      api.ctx.view = "system"; api.ctx.ifName = ""; api.ctx.areaId = "";
      api.say("Enter system view, return user view with Ctrl+Z.", "dim");
    }
  },
  {
    id: "quit", match: /^(quit|q)$/, view: null, kind: "view", usage: "quit",
    run(api){
      const c = api.ctx;
      if(c.view === "if"){ c.view = "system"; c.ifName = ""; }
      else if(c.view === "area"){ c.view = "ospf"; c.areaId = ""; }
      else if(c.view === "ospf"){ c.view = "system"; }
      else if(c.view === "system"){ c.view = "user"; }
      else api.say("Error: Unrecognized command found at '^' position.", "err");
    }
  },
  {
    id: "return", match: /^(return|ctrl\+z)$/, view: null, kind: "view", usage: "return",
    run(api){ api.ctx.view = "user"; api.ctx.ifName = ""; api.ctx.areaId = ""; }
  },
  {
    id: "interface", match: /^interface (?:GigabitEthernet|GE)\s*([\d/]+)$/i,
    view: "system", kind: "view", usage: "interface GigabitEthernet 0/0/1",
    run(api, m){
      const key = "GE" + m[1];
      if(!api.S[api.ctx.dev].ports[key]){
        api.say("Error: The port does not exist.", "err");
        return;
      }
      api.ctx.view = "if";
      api.ctx.ifName = "GigabitEthernet" + m[1];
      api.ctx.areaId = "";
    }
  },
  {
    id: "ip-address", match: /^ip address ([\d.]+) ([\d.]+)$/, view: "if", kind: "config",
    usage: "ip address <192.168.1.1> <24>",
    explain: [
      { h: "接口地址是 OSPF 的入口", p: "接口 up 且配了 IP，才可能被 network 语句匹配到。地址变了，它所属的网段和能匹配的 network 语句都会变。" },
      { h: "本实验基线已配好", p: "三台路由器的接口地址在实验开始时就已就绪。这条命令保留下来，方便你改地址后观察 OSPF 邻居与路由的连锁变化。" }
    ],
    run(api, m){
      const dev = api.ctx.dev, pn = portKey(api.ctx);
      const p = api.S[dev].ports[pn];
      if(!p){ api.say("Error: The port does not exist.", "err"); return; }
      const ip = m[1];
      const len = maskToLen(m[2]);
      if(ipToInt(ip) === null || len < 0){
        api.say("Error: Wrong parameter found at '^' position.", "err");
        return;
      }
      if(p.ip === ip && p.mask === len){
        api.say("// " + pn + " 的地址已经是 " + ip + "/" + len + "，命令未产生状态变化。", "op");
        return;
      }
      const before = linkStates(api.S);
      const beforeSigs = snapshotSigs(api.S);
      const old = p.ip ? p.ip + "/" + p.mask : "unassigned";
      p.ip = ip; p.mask = len;
      api.change(pn + ".ip", old, ip + "/" + len, { row: "if-" + pn });
      api.say("// " + pn + " 地址 " + old + " → " + ip + "/" + len + "。如果它落在某条 network 语句里，OSPF 会重新宣告这个网段。", "op");
      diffLinks(api, before, dev);
      diffSigs(api, beforeSigs);
      api.fx({ kind: "pulse", target: dev + "/" + pn, color: "#38E1FF" });
      api.tab("cost");
    }
  },
  {
    id: "ospf", match: /^ospf 1(?: router-id (\d+\.\d+\.\d+\.\d+))?$/, view: "system", kind: "config",
    usage: "ospf 1 router-id <1.1.1.1>",
    explain: [
      { h: "起的是进程，不是接口", p: "ospf 1 只是在本机启动一个 OSPF 进程并指定 Router ID。此时还没有任何接口跑 OSPF。" },
      { h: "Router ID 必须唯一", p: "Router ID 用来在 LSDB 里标识「这条 LSA 是谁发的」。三台路由器用 1.1.1.1 / 2.2.2.2 / 3.3.3.3，方便在表里对照。" }
    ],
    run(api, m){
      const dev = api.ctx.dev, r = api.S[dev];
      const rid = m[1];
      if(rid && ipToInt(rid) === null){
        api.say("Error: Wrong parameter found at '^' position.", "err");
        return;
      }
      const was = r.ospf.enabled;
      r.ospf.enabled = true;
      if(rid) r.routerId = rid;
      else if(!r.routerId) r.routerId = autoRid(r);
      api.ctx.view = "ospf"; api.ctx.areaId = r.ospf.area;
      if(!was){
        api.say("// " + dev + " 启动 OSPF 进程 1，Router ID " + r.routerId + "。进程起来不等于接口跑 OSPF，还要在 area 里 network 宣告。", "op");
      }else if(rid && rid !== r.routerId){
        api.say("// OSPF 进程 1 已存在，Router ID 改为 " + rid + "。", "op");
      }else{
        api.say("// 进入已存在的 OSPF 进程 1（Router ID " + r.routerId + "）。", "op");
      }
    }
  },
  {
    id: "area", match: /^area (\d+|\d+\.\d+\.\d+\.\d+)$/, view: "ospf", kind: "config",
    usage: "area <0>",
    explain: [
      { h: "区域是 Hello 的参数", p: "接口属于哪个 area，由它匹配到的 network 语句决定。两台路由器只有 area ID 相同，Hello 才能被接受。" },
      { h: "本实验简化", p: "同一 network 语句在另一个 area 下重新输入，视为「改挂区域」。真实 VRP 会拒绝重复宣告，需要先 undo network。" }
    ],
    run(api, m){
      const r = api.S[api.ctx.dev];
      const a = areaId(m[1]);
      if(!a){
        api.say("Error: Wrong parameter found at '^' position.", "err");
        return;
      }
      const old = r.ospf.area;
      r.ospf.area = a;
      api.ctx.view = "area"; api.ctx.areaId = a;
      if(old !== a){
        api.say("// 当前区域 " + areaShort(old) + " → " + areaShort(a) + "。接下来 network 的网段会挂到 area " + a + "。", "op");
      }else{
        api.say("// 进入 area " + a + "。", "op");
      }
    }
  },
  {
    id: "network", match: /^network ([\d.]+) ([\d.]+)$/, view: "area", kind: "config",
    usage: "network <10.0.12.0> <0.0.0.3>",
    explain: [
      { h: "三个要素", p: "网段地址、反掩码、所在区域。反掩码 0.0.0.3 表示只匹配最后两位，对应一个 /30 点对点网段。" },
      { h: "宣告 ≠ 立即有路由", p: "network 只是让接口上的 OSPF 跑起来并进入 LSDB。要等邻居 Full、SPF 算完，路由才会进路由表。" }
    ],
    run(api, m){
      const dev = api.ctx.dev, r = api.S[dev];
      const wm = wildMask(m[2]);
      const ip = ipToInt(m[1]);
      if(wm === null || ip === null){
        api.say("Error: Wrong parameter found at '^' position.", "err");
        return;
      }
      const dest = intToIp((ip & wm) >>> 0);
      const area = r.ospf.area;
      const before = linkStates(api.S);
      const beforeR1 = routeSig(api.S, "R1", "192.168.2.0", 24);

      let entry = null;
      for(let i = 0; i < r.ospf.nets.length; i++){
        const n = r.ospf.nets[i];
        if(n.net === dest && n.wild === m[2]) entry = n;
      }

      let row = "";
      const names = Object.keys(r.ports);
      for(let i = 0; i < names.length; i++){
        const p = r.ports[names[i]];
        if(p.ip && netMatch(p.ip, dest, m[2])) row = "if-" + names[i];
      }

      if(entry){
        if(entry.area === area){
          api.say("// " + dest + " " + m[2] + " 已经在 area " + area + " 里，命令未产生状态变化。", "op");
          return;
        }
        const old = entry.area;
        entry.area = area;
        api.change("network " + dest + " " + m[2], "area " + old, "area " + area, { row: row });
        api.say("// 同一网段从 area " + old + " 改挂到 area " + area + "（简化实现，真实 VRP 需先 undo network）。", "op");
      }else{
        r.ospf.nets.push({ net: dest, wild: m[2], area: area });
        api.change("network " + dest + " " + m[2], "不存在", "area " + area, { row: row, kind: "enter" });
      }

      if(!row){
        api.say("// 警告：" + dest + " " + m[2] + " 不匹配任何已配置的接口地址，OSPF 不会在任何接口上运行。", "op");
      }else{
        api.say("// " + shortIf(row.slice(3)) + " 进入 OSPF area " + area + "；对端也宣告同一网段后，Hello 才能协商成 Full。", "op");
      }

      diffLinks(api, before, dev);
      const afterR1 = routeSig(api.S, "R1", "192.168.2.0", 24);
      if(beforeR1 !== afterR1){
        api.change("OSPF 路由 192.168.2.0/24", beforeR1, afterR1, {
          row: firstRouteKey(api.S, "R1", "192.168.2.0", 24), kind: "enter"
        });
      }
      api.tab("neighbor");
    }
  },
  {
    id: "ospf-cost", match: /^ospf cost (\d+)$/, view: "if", kind: "config",
    usage: "ospf cost <50>",
    explain: [
      { h: "只改 OSPF 的算路开销", p: "ospf cost 不改变接口带宽，只是给 SPF 的边加一个权重。开销越小，越容易被选进最短路径。" },
      { h: "反直觉", p: "开销调大之后，流量可能切到一条「跳数更少」或「跳数更多」的链路——SPF 比的是总开销，不是跳数。" }
    ],
    run(api, m){
      const dev = api.ctx.dev, pn = portKey(api.ctx);
      const p = api.S[dev].ports[pn];
      const n = parseInt(m[1], 10);
      if(!p){ api.say("Error: The port does not exist.", "err"); return; }
      if(n < 1 || n > 65535){
        api.say("Error: Wrong parameter found at '^' position.", "err");
        return;
      }
      if(p.cost === n){
        api.say("// " + pn + " 的 OSPF 开销已经是 " + n + "，命令未产生状态变化。", "op");
        return;
      }
      const old = p.cost;
      const before = snapshotSigs(api.S);
      p.cost = n;
      api.change(pn + ".cost", old, n, { row: "if-" + pn });
      api.say("// " + pn + " 的 OSPF 开销 " + old + " → " + n + "；只影响 OSPF 选路，不改接口速率。", "op");
      diffSigs(api, before);
      api.tab("cost");
    }
  },
  {
    id: "shutdown", match: /^shutdown$/, view: "if", kind: "config", usage: "shutdown",
    explain: [
      { h: "管理性关闭", p: "接口 down 后，直连路由立刻消失，跑在它上面的 OSPF 邻居也会 Down。SPF 会重新计算。" }
    ],
    run(api){
      const dev = api.ctx.dev, pn = portKey(api.ctx);
      const p = api.S[dev].ports[pn];
      if(!p){ api.say("Error: The port does not exist.", "err"); return; }
      if(!p.up){
        api.say("// " + pn + " 已经是 shutdown，命令未产生状态变化。", "op");
        return;
      }
      const before = linkStates(api.S);
      const beforeSigs = snapshotSigs(api.S);
      p.up = false;
      api.change(pn + ".state", "up", "shutdown", { row: "if-" + pn });
      api.say("// " + pn + " 管理性关闭：物理层 down，接口直连路由撤销，OSPF 邻居随之 Down。", "op");
      diffLinks(api, before, dev);
      diffSigs(api, beforeSigs);
      api.fx({ kind: "pulse", target: dev + "/" + pn, color: "#FF4D5E" });
      api.tab("neighbor");
    }
  },
  {
    id: "undo-shutdown", match: /^undo shutdown$/, view: "if", kind: "config", usage: "undo shutdown",
    explain: [
      { h: "恢复接口", p: "接口重新 up，直连路由回来，OSPF 重新发 Hello。邻居重新 Full 后，SPF 才会把这条链路加回最短路径。" }
    ],
    run(api){
      const dev = api.ctx.dev, pn = portKey(api.ctx);
      const p = api.S[dev].ports[pn];
      if(!p){ api.say("Error: The port does not exist.", "err"); return; }
      if(p.up){
        api.say("// " + pn + " 已经是 up，命令未产生状态变化。", "op");
        return;
      }
      const before = linkStates(api.S);
      const beforeSigs = snapshotSigs(api.S);
      p.up = true;
      api.change(pn + ".state", "shutdown", "up", { row: "if-" + pn });
      api.say("// " + pn + " 重新 up；如果两端参数一致，OSPF 邻居会重新协商到 Full。", "op");
      diffLinks(api, before, dev);
      diffSigs(api, beforeSigs);
      api.fx({ kind: "pulse", target: dev + "/" + pn, color: "#35E08A" });
      api.tab("neighbor");
    }
  },

  /* ---- 只读命令 ---- */
  {
    id: "display-ip-brief", match: /^display ip interface brief$/, view: null, kind: "doc",
    usage: "display ip interface brief",
    doc: "按接口看三层状态：<b>Physical</b> 是链路，<b>Protocol</b> 要接口 up 且配了 IP 才是 up。Protocol up 的接口才会贡献直连路由。",
    run(api){
      const r = api.S[api.ctx.dev];
      api.say(pad("Interface", 31) + pad("IP Address/Mask", 21) + pad("Physical", 11) + "Protocol", "dim");
      api.say("--------------------------------------------------------------------------------", "dim");
      Object.keys(r.ports).forEach(function(pn){
        const p = r.ports[pn];
        api.say(pad(fullIf(pn), 31) + pad(p.ip ? p.ip + "/" + p.mask : "unassigned", 21) +
          pad(p.up ? "up" : "*down", 11) + (p.up && p.ip ? "up" : "down"));
      });
      api.say("");
      api.say("// 本实验基线：接口全部 up、地址已配好，只差 OSPF。", "op");
      api.tab("cost");
    }
  },
  {
    id: "display-ospf-peer", match: /^display ospf peer brief$/, view: null, kind: "doc",
    usage: "display ospf peer brief",
    doc: "邻居表回答：<b>和谁、在哪个接口、到了什么状态</b>。只有 <b>Full</b> 才会交换完整的 Router LSA；2-Way / ExStart 都学不到路由。",
    run(api){
      const S = api.S, dev = api.ctx.dev, r = S[dev];
      if(!r.ospf.enabled){
        api.say("Error: The OSPF process does not exist.", "err");
        api.say("      先 system-view → ospf 1 router-id " + PLAN[dev].rid + "。", "dim");
        return;
      }
      api.say("OSPF Process 1 with Router ID " + routerIdOf(r));
      api.say("                  Peer Statistic Information");
      api.say("----------------------------------------------------------------------------", "dim");
      api.say(pad("Area Id", 17) + pad("Interface", 32) + pad("Neighbor id", 17) + "State", "dim");
      api.say("----------------------------------------------------------------------------", "dim");
      const rows = [];
      LINKS.forEach(function(l){
        if(!involves(l, dev)) return;
        const peer = otherEnd(l, dev);
        const pa = r.ports[localPort(l, dev)];
        const pb = S[peer].ports[peerPort(l, dev)];
        if(!pa.up || !pb.up) return;
        if(!S[peer].ospf.enabled) return;
        const ia = ifaceOspf(r, localPort(l, dev));
        const ib = ifaceOspf(S[peer], peerPort(l, dev));
        if(!ia || !ib) return;
        const ad = adjacency(S, l);
        rows.push({
          area: ia.area, iface: localPort(l, dev),
          rid: routerIdOf(S[peer]), state: ad.state
        });
      });
      if(!rows.length) api.say("（没有邻居：对端未起 OSPF、接口未宣告，或链路 down）", "dim");
      rows.forEach(function(x){
        api.say(pad(x.area, 17) + pad(fullIf(x.iface), 32) + pad(x.rid, 17) + x.state);
      });
      api.say("");
      if(rows.some(function(x){ return x.state === "2-Way"; })){
        api.say("// 有邻居停在 2-Way：Hello 能收到，但 area ID 不一致，永远进不了 Full。", "op");
      }else if(rows.some(function(x){ return x.state === "Full"; })){
        api.say("// Full 表示 LSDB 已同步，可以开始 SPF 计算。", "op");
      }
      api.tab("neighbor");
    }
  },
  {
    id: "display-ospf-lsdb", match: /^display ospf lsdb$/, view: null, kind: "doc",
    usage: "display ospf lsdb",
    doc: "LSDB 是<b>同一个区域里所有路由器发来的 LSA 集合</b>。每台路由器一条 Router LSA，Link State ID 就是它的 Router ID。",
    run(api){
      const S = api.S, dev = api.ctx.dev, r = S[dev];
      if(!r.ospf.enabled){
        api.say("Error: The OSPF process does not exist.", "err");
        return;
      }
      const nodes = lsaRouters(S, dev);
      api.say("OSPF Process 1 with Router ID " + routerIdOf(r));
      api.say("Link State Database");
      api.say("                         Area: " + r.ospf.area);
      api.say(pad("Type", 10) + pad("LinkState ID", 16) + pad("AdvRouter", 16) +
        padL("Age", 6) + padL("Len", 6) + padL("Sequence", 12) + padL("Metric", 8), "dim");
      api.say("------------------------------------------------------------------------------", "dim");
      nodes.forEach(function(id, i){
        const rid = routerIdOf(S[id]);
        api.say(pad("Router", 10) + pad(rid, 16) + pad(rid, 16) +
          padL(1234 + i, 6) + padL(48, 6) + padL("0x80000003", 12) + padL(1, 8));
      });
      api.say("");
      api.say("// 当前 LSDB 里有 " + nodes.length + " 条 Router LSA。数量对不上，先查邻居是不是都 Full。", "op");
      api.tab("lsdb");
    }
  },
  {
    id: "display-ospf-routing", match: /^display ospf routing$/, view: null, kind: "doc",
    usage: "display ospf routing",
    doc: "这张表是<b>SPF 算出来的结果</b>：目的前缀、累计开销、下一跳、是谁宣告的。和路由表对照，可以看到 OSPF 路由怎么来的。",
    run(api){
      const S = api.S, dev = api.ctx.dev;
      if(!S[dev].ospf.enabled){
        api.say("Error: The OSPF process does not exist.", "err");
        return;
      }
      const list = ospfRoutesOf(S, dev);
      api.say("Routing Tables");
      api.say("Routing for Network");
      api.say(pad("Destination", 20) + padL("Cost", 6) + pad("  Type", 10) +
        pad("NextHop", 17) + pad("AdvRouter", 17) + "Area", "dim");
      api.say("--------------------------------------------------------------------------------", "dim");
      if(!list.length){
        api.say("（没有 OSPF 路由：邻居没 Full，或者对端没有宣告网段）", "dim");
      }
      list.forEach(function(rt){
        let type = "Stub";
        LINKS.forEach(function(l){
          if(l.net === rt.dest && l.mask === rt.mask) type = "Transit";
        });
        api.say(pad(rt.dest + "/" + rt.mask, 20) + padL(rt.cost, 6) + pad("  " + type, 10) +
          pad(rt.nextHop, 17) + pad(rt.advRouter, 17) + "0.0.0.0");
      });
      const dests = {};
      list.forEach(function(rt){ dests[rt.dest + "/" + rt.mask] = true; });
      api.say("");
      api.say("Total Nets: " + Object.keys(dests).length + "    Total Routes: " + list.length, "dim");
      api.tab("route");
    }
  },
  {
    id: "display-ospf-interface", match: /^display ospf interface$/, view: null, kind: "doc",
    usage: "display ospf interface",
    doc: "看<b>哪些接口在跑 OSPF、属于哪个 area、开销是多少</b>。开销是 SPF 的边权，改它就会改编路结果。",
    run(api){
      const S = api.S, dev = api.ctx.dev, r = S[dev];
      if(!r.ospf.enabled){
        api.say("Error: The OSPF process does not exist.", "err");
        return;
      }
      const list = ospfIfaces(r);
      if(!list.length){
        api.say("// 没有接口跑 OSPF：network 语句还没覆盖任何接口地址。", "op");
        return;
      }
      const areas = {};
      list.forEach(function(it){ areas[it.area] = true; });
      Object.keys(areas).forEach(function(a){
        api.say("Area: " + a);
        api.say(pad("Interface", 33) + pad("IP Address/Mask", 19) + padL("Cost", 6) + "  State", "dim");
        api.say("--------------------------------------------------------------------------------", "dim");
        list.filter(function(it){ return it.area === a; }).forEach(function(it){
          const st = !it.p.up ? "Down" : (it.mask === 30 ? "P2P" : "Broadcast");
          api.say(pad(fullIf(it.pn), 33) + pad(it.p.ip + "/" + it.p.mask, 19) +
            padL(it.cost, 6) + "  " + st);
        });
        api.say("");
      });
      api.say("// P2P / Broadcast 是接口网络类型；本实验不模拟 DR/BDR 选举。邻居状态看 display ospf peer brief。", "op");
      api.tab("cost");
    }
  },
  {
    id: "display-route", match: /^display ip routing-table$/, view: null, kind: "doc",
    usage: "display ip routing-table",
    doc: "真正的转发表：<b>目的、协议、优先级、开销、下一跳、出接口</b>。OSPF 路由优先级 10，Direct 是 0。",
    run(api){
      const S = api.S, dev = api.ctx.dev;
      const list = routesOf(S, dev);
      api.lines([
        "Route Flags: R - relay, D - download to fib",
        "------------------------------------------------------------------------------",
        "Routing Tables: Public",
        "         Destinations : " + list.length + "        Routes : " + list.length,
        ""
      ], "dim");
      api.say(pad("Destination/Mask", 19) + pad("Proto", 8) + padL("Pre", 5) + padL("Cost", 6) +
        " " + pad("Flags", 7) + pad("NextHop", 16) + "Interface", "dim");
      api.say("------------------------------------------------------------------------------", "dim");
      if(!list.length) api.say("// 路由表为空。", "op");
      list.forEach(function(rt){
        api.say(pad(rt.dest + "/" + rt.mask, 19) + pad(rt.proto, 8) +
          padL(rt.pre, 5) + padL(rt.cost, 6) + " " + pad("D", 7) +
          pad(rt.nextHop, 16) + fullIf(rt.iface));
      });
      api.say("");
      const ospf = list.filter(function(rt){ return rt.proto === "OSPF"; });
      if(ospf.length){
        api.say("// 其中 " + ospf.length + " 条 OSPF 路由：Pre 10，Cost 是沿途出接口开销的累加。", "op");
      }else{
        api.say("// 没有任何 OSPF 路由：邻居没 Full，或对端没宣告目的网段。", "op");
      }
      api.tab("route");
    }
  },
  {
    id: "display-route-ospf", match: /^display ip routing-table protocol ospf$/, view: null, kind: "doc",
    usage: "display ip routing-table protocol ospf",
    doc: "只筛出 OSPF 路由。和 display ospf routing 对照，确认「SPF 算出来的」和「真正进表的」一致。",
    run(api){
      const S = api.S, dev = api.ctx.dev;
      const list = routesOf(S, dev).filter(function(rt){ return rt.proto === "OSPF"; });
      const dests = {};
      list.forEach(function(rt){ dests[rt.dest + "/" + rt.mask] = true; });
      api.say("Public routing table : OSPF");
      api.say("         Destinations : " + Object.keys(dests).length + "        Routes : " + list.length);
      api.say("");
      api.say("OSPF routing table status : <Active>", "dim");
      api.say(pad("Destination/Mask", 19) + pad("Proto", 8) + padL("Pre", 5) + padL("Cost", 6) +
        " " + pad("Flags", 7) + pad("NextHop", 16) + "Interface", "dim");
      api.say("------------------------------------------------------------------------------", "dim");
      if(!list.length){
        api.say("（OSPF 路由表为空）", "dim");
      }
      list.forEach(function(rt){
        api.say(pad(rt.dest + "/" + rt.mask, 19) + pad("OSPF", 8) + padL(rt.pre, 5) +
          padL(rt.cost, 6) + " " + pad("D", 7) + pad(rt.nextHop, 16) + fullIf(rt.iface));
      });
      api.say("");
      api.say("// 同一条前缀出现多行、下一跳不同，就是等价路由（ECMP）。", "op");
      api.tab("route");
    }
  },
  {
    id: "ping", match: /^ping ([\d.]+)$/, view: null, kind: "test", usage: "ping <192.168.2.10>",
    run(api, m){
      const dst = m[1], dev = api.ctx.dev;
      if(ipToInt(dst) === null){
        api.say("Error: Wrong parameter found at '^' position.", "err");
        return;
      }
      const rts = lookupAll(api.S, dev, dst);
      if(!rts.length){
        pingOut(api, dst, false);
        api.say("// " + dev + " 的路由表里没有能匹配 " + dst + " 的表项，ICMP 在查表这一步就被丢弃。", "op");
        api.tab("route");
        return;
      }
      const ep = endpointOf(api.S, dst);
      if(!ep){
        pingOut(api, dst, false);
        api.say("// 路由命中 " + rts[0].dest + "/" + rts[0].mask + "，报文从 " + shortIf(rts[0].iface) +
          " 发出；但该地址没有主机应答 ARP，收不到 ICMP Reply。", "op");
        return;
      }
      if(!ep.up){
        pingOut(api, dst, false);
        api.say("// 路由命中 " + rts[0].dest + "/" + rts[0].mask + "，但目的接口处于 down / shutdown。", "op");
        return;
      }
      const srcPort = api.S[dev].ports[rts[0].iface];
      if(ep.router){
        const back = lookupAll(api.S, ep.router, srcPort.ip);
        if(!back.length){
          pingOut(api, dst, false);
          api.say("// 去程命中，但 " + ep.router + " 没有回 " + srcPort.ip + " 的路由，Echo Reply 回不来。", "op");
          return;
        }
      }
      pingOut(api, dst, true, 254);
      api.say("// 命中 " + rts[0].proto + " 路由 " + rts[0].dest + "/" + rts[0].mask +
        "，下一跳 " + rts[0].nextHop + "，出接口 " + shortIf(rts[0].iface) + "。", "op");
    }
  }
];

function pingOut(api, dst, ok, ttl){
  api.say("  PING " + dst + ": 56  data bytes, press CTRL_C to break");
  if(ok){
    for(let i = 1; i <= 5; i++){
      api.say("    Reply from " + dst + ": bytes=56 Sequence=" + i + " ttl=" + (ttl || 254) +
        " time=" + (i === 3 ? 2 : 1) + " ms");
    }
    api.lines(["", "  --- " + dst + " ping statistics ---",
      "    5 packet(s) transmitted", "    5 packet(s) received", "    0.00% packet loss",
      "    round-trip min/avg/max = 1/2/3 ms"]);
  }else{
    for(let i = 0; i < 5; i++) api.say("    Request time out", "err");
    api.lines(["", "  --- " + dst + " ping statistics ---",
      "    5 packet(s) transmitted", "    0 packet(s) received", "    100.00% packet loss"], "err");
  }
}

function endpointOf(S, ip){
  const keys = Object.keys(HOSTS);
  for(let i = 0; i < keys.length; i++){
    const h = HOSTS[keys[i]];
    if(h.ip === ip) return { host: true, router: h.router, up: S[h.router].ports[h.port].up };
  }
  for(let i = 0; i < ROUTERS.length; i++){
    const d = ROUTERS[i];
    const names = Object.keys(S[d].ports);
    for(let k = 0; k < names.length; k++){
      const p = S[d].ports[names[k]];
      if(p.ip === ip) return { host: false, router: d, up: p.up };
    }
  }
  return null;
}

function diffLinks(api, before, dev){
  LINKS.forEach(function(l){
    if(!involves(l, dev)) return;
    const peer = otherEnd(l, dev);
    const b = before[l.id];
    const a = adjacency(api.S, l).state;
    if(b !== a){
      api.change("OSPF 邻居 " + peer, b, a, {
        row: "nb-" + l.id, kind: a === "Full" ? "enter" : "chg"
      });
    }
  });
}

function snapshotSigs(S){
  return [
    routeSig(S, "R1", "192.168.2.0", 24),
    routeSig(S, "R3", "192.168.1.0", 24)
  ];
}

function diffSigs(api, before){
  const now = snapshotSigs(api.S);
  if(before[0] !== now[0]){
    api.change("R1 去 192.168.2.0/24", before[0], now[0], {
      row: firstRouteKey(api.S, "R1", "192.168.2.0", 24), kind: "chg"
    });
  }
  if(before[1] !== now[1]){
    api.change("R3 去 192.168.1.0/24", before[1], now[1], {
      row: firstRouteKey(api.S, "R3", "192.168.1.0", 24), kind: "chg"
    });
  }
}

/* ---------------- 表项 ---------------- */
function tables(S, tab, ctx){
  const dev = ctx.dev, r = S[dev];

  if(tab === "neighbor"){
    const rows = neighborRows(S, dev).map(function(x){
      return {
        key: "nb-" + x.link.id,
        cells: [
          { t: x.address + " (" + x.peer + ")", cls: "c" },
          { t: x.rid, cls: "c" },
          { t: x.state, cls: neighborCellCls(x.state) },
          { t: x.iface, cls: "c" },
          { t: x.dead, cls: "c" }
        ]
      };
    });
    return {
      head: ["NEIGHBOR", "ROUTER-ID", "STATE", "INTERFACE", "DEAD TIME"],
      rows: rows,
      empty: "没有邻居 · 先 system-view → ospf 1 起进程，再在 area 0 里 network 宣告",
      note: "只有 Full 才会交换完整 Router LSA。2-Way 表示 Hello 能收到但参数不一致，Down 表示物理链路或接口不可用。"
    };
  }

  if(tab === "lsdb"){
    const nodes = lsaRouters(S, dev);
    const rows = nodes.map(function(id, i){
      const rid = routerIdOf(S[id]);
      return {
        key: "lsa-" + rid,
        cells: [
          { t: "Router", cls: "c" },
          { t: rid, cls: "c" },
          { t: rid, cls: "c" },
          { t: 1234 + i, cls: "c" },
          { t: "0x80000003", cls: "c" }
        ]
      };
    });
    return {
      head: ["TYPE", "LINK-ID", "ADV ROUTER", "AGE", "SEQ"],
      rows: rows,
      empty: "LSDB 为空 · OSPF 未启用",
      note: "每台路由器一条 Router LSA，描述自己的接口、邻居和直连网段。Link State ID 等于 Router ID。"
    };
  }

  if(tab === "route"){
    const list = routesOf(S, dev);
    return {
      head: ["目的地址", "掩码", "协议", "优先级", "开销", "下一跳", "出接口"],
      rows: list.map(function(rt){
        return {
          key: routeKey(rt),
          cells: [
            { t: rt.dest, cls: "c" },
            { t: lenToMask(rt.mask), cls: "c" },
            { t: rt.proto, cls: rt.proto === "OSPF" ? "v10" : rt.proto === "Local" ? "dim" : "ok" },
            { t: rt.pre, cls: "c" },
            { t: rt.cost, cls: "c" },
            { t: rt.nextHop, cls: "c" },
            { t: rt.iface, cls: "c" }
          ]
        };
      }),
      empty: "路由表为空 · 接口 up 后先有 Direct / Local",
      note: "OSPF 路由优先级 10，Direct 0。同一前缀出现多行、下一跳不同，就是等价路由 ECMP。"
    };
  }

  /* cost */
  const rows = Object.keys(r.ports).map(function(pn){
    const p = r.ports[pn];
    const hit = ifaceOspf(r, pn);
    let state = "Up", cls = "ok";
    if(!p.up){ state = "Down"; cls = "bad"; }
    else if(!hit){ state = "Up · 未宣告"; cls = "warn"; }
    else state = "Up · OSPF";
    return {
      key: "if-" + pn,
      cells: [
        { t: pn, cls: "c" },
        { t: p.ip ? p.ip + "/" + p.mask : "unassigned", cls: p.ip ? "c" : "dim" },
        { t: p.cost, cls: "c" },
        { t: hit ? hit.area : "—", cls: "c" },
        { t: state, cls: cls }
      ]
    };
  });
  return {
    head: ["INTERFACE", "IP", "COST", "AREA", "STATE"],
    rows: rows,
    note: "GE 默认 cost 1；R1 GE0/0/2 预置 30，模拟低带宽备份链路。ospf cost 只改 SPF 的边权，不改接口速率。"
  };
}

/* ---------------- 拓扑 ---------------- */
function portColor(p, hit){
  if(!p.up) return "#7E93AB";
  if(hit) return "#35E08A";
  return p.ip ? "#38E1FF" : "#FFB545";
}

function linkTagCls(state){
  if(state === "Full") return "lk-tag on";
  if(state === "2-Way") return "lk-tag warn";
  if(state === "Down") return "lk-tag bad";
  return "lk-tag";
}

function linkTagText(state){
  if(state === "Full") return "FULL";
  if(state === "2-Way") return "2-WAY";
  if(state === "Down") return "LINK DOWN";
  return "NO OSPF";
}

function topology(S, ui, ctx){
  const flows = flowMap(S);

  const devices = ROUTERS.map(function(id){
    const d = DEV[id], r = S[id];
    const ports = Object.keys(d.portX).map(function(pn){
      const p = r.ports[pn];
      const hit = ifaceOspf(r, pn);
      return {
        name: pn, kind: "rj45",
        x: d.portX[pn], y: 44,
        color: portColor(p, hit), up: p.up, label: pn.slice(-1),
        dimBand: false
      };
    });
    return {
      id: id, x: d.x, y: d.y, w: d.w, h: d.h, model: "AR2220",
      silk: "M12 24 h60 M12 28 h44 M12 32 h60 M12 36 h44",
      leds: [
        { x: 272, y: 10, color: "#35E08A", glow: true, label: "PWR", tx: 278, ty: 12.5 },
        { x: 258, y: 10, color: "#38E1FF", glow: true, label: "SYS", tx: 232, ty: 12.5 }
      ],
      ports: ports,
      tags: [
        { x: 0, y: -8, text: id, cls: "dev-label" },
        {
          x: 34, y: -8,
          text: r.ospf.enabled
            ? "RID " + routerIdOf(r) + " · area " + areaShort(r.ospf.area)
            : "OSPF 未启用",
          cls: "dev-sub"
        }
      ]
    };
  });

  const reach = endToEnd(S);
  const hosts = ["PC1", "PC2"].map(function(k){
    const h = HOSTS[k];
    const up = S[h.router].ports[h.port].up;
    return {
      id: h.id, x: h.x, y: h.y, ip: h.ip, mac: h.mac,
      vlan: 1, color: up ? "#38E1FF" : "#7E93AB", up: up
    };
  });

  const links = LINKS.map(function(l){
    const ad = adjacency(S, l);
    const f = flows[l.id] || 0;
    const up = S[l.a].ports[l.ap].up && S[l.b].ports[l.bp].up;
    return {
      id: "lk-" + l.id, d: ROUTES[l.route],
      cls: !up ? "down" : (f > 0 ? "active" : ""),
      flow: f > 0 ? Math.min(1, f) : 0,
      flowColor: "56,225,255"
    };
  });

  links.push({
    id: "lk-pc1", d: ROUTES["pc1-down"],
    cls: S.R1.ports["GE0/0/0"].up ? "" : "down",
    flow: reach ? 0.42 : 0, flowColor: "56,225,255"
  });
  links.push({
    id: "lk-pc2", d: ROUTES["pc2-down"],
    cls: S.R3.ports["GE0/0/1"].up ? "" : "down",
    flow: reach ? 0.42 : 0, flowColor: "56,225,255"
  });

  const anchors = {};
  ROUTERS.forEach(function(id){
    const d = DEV[id];
    Object.keys(d.portX).forEach(function(pn){
      anchors[id + "/" + pn] = [d.x + d.portX[pn], d.y + 44];
    });
  });

  const labels = [
    { text: "10.0.12.0/30", x: 435, y: 96, anchor: "middle", cls: "lk-tag on" },
    { text: "10.0.23.0/30", x: 945, y: 96, anchor: "middle", cls: "lk-tag on" },
    {
      text: "10.0.13.0/30 · R1 COST " + S.R1.ports["GE0/0/2"].cost,
      x: 810, y: 214, anchor: "middle", cls: "lk-tag"
    },
    {
      text: linkTagText(adjacency(S, LINKS[0]).state), x: 435, y: 122, anchor: "middle",
      cls: linkTagCls(adjacency(S, LINKS[0]).state)
    },
    {
      text: linkTagText(adjacency(S, LINKS[1]).state), x: 945, y: 122, anchor: "middle",
      cls: linkTagCls(adjacency(S, LINKS[1]).state)
    },
    {
      text: linkTagText(adjacency(S, LINKS[2]).state), x: 810, y: 230, anchor: "middle",
      cls: linkTagCls(adjacency(S, LINKS[2]).state)
    },
    {
      text: "192.168.1.0/24 · GW .1", x: 154, y: 190, anchor: "start",
      cls: "lk-tag" + (S.R1.ports["GE0/0/0"].up ? " on" : " bad")
    },
    {
      text: "192.168.2.0/24 · GW .1", x: 1186, y: 190, anchor: "end",
      cls: "lk-tag" + (S.R3.ports["GE0/0/1"].up ? " on" : " bad")
    }
  ];

  return {
    viewBox: "0 0 1400 320",
    devices: devices,
    hosts: hosts,
    links: links,
    routes: ROUTES,
    anchors: anchors,
    labels: labels
  };
}

/* ---------------- 数据面场景 ---------------- */
function costNote(S, rt){
  const r1 = S.R1.ports, r2 = S.R2.ports, r3 = S.R3.ports;
  const via = r1["GE0/0/1"].cost + r2["GE0/0/1"].cost + r3["GE0/0/1"].cost;
  const dir = r1["GE0/0/2"].cost + r3["GE0/0/1"].cost;
  const l13 = LINKS[2];
  const directUp = adjacency(S, l13).full;
  let text = "经 R2：R1 GE0/0/1(" + r1["GE0/0/1"].cost + ") + R2 GE0/0/1(" + r2["GE0/0/1"].cost +
    ") + R3 GE0/0/1(" + r3["GE0/0/1"].cost + ") = " + via + "；直连：R1 GE0/0/2(" +
    r1["GE0/0/2"].cost + ") + R3 GE0/0/1(" + r3["GE0/0/1"].cost + ") = " + dir + "。";
  if(!directUp) text += "直连 GE0/0/2 当前不可用，只剩经 R2 的路径。";
  else if(rt.iface === "GE0/0/2") text += "本次选直连的 " + dir + "，哪怕它少经过一台路由器。";
  else text += "本次选经 R2 的 " + via + "，OSPF 比的是总开销，不是跳数。";
  return text;
}

export function ospfPathScene(S, dir){
  const fromPC1 = dir !== "PC2";
  const A = fromPC1 ? HOSTS.PC1 : HOSTS.PC2;
  const B = fromPC1 ? HOSTS.PC2 : HOSTS.PC1;
  const srcDev = fromPC1 ? "R1" : "R3";
  const dstDev = fromPC1 ? "R3" : "R1";
  const sc = {
    name: "PC " + A.ip + " → " + B.ip + " · OSPF 逐跳",
    realSec: 5.2,
    dur: 1,
    traceTitle: "逐跳判读",
    frames: [],
    trace: [],
    drop: null,
    verdict: null
  };
  let n = 0;
  const num = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];

  sc.trace.push({
    h: num[n++] + " 源主机判路",
    p: "<b>" + A.ip + "/24</b> 与 <b>" + B.ip + "/24</b> 不在同一网段，目的 MAC 填默认网关 <code>" +
      A.gw + "</code>，不是 " + B.id + " 的 MAC。",
    cls: ""
  });
  sc.frames.push({ route: fromPC1 ? "pc1-up" : "pc2-up", t0: 0, t1: .10, kind: "data" });

  const first = lookupAll(S, srcDev, B.ip);
  if(!first.length){
    const stuck = firstStuck(S, srcDev);
    if(stuck){
      const ad = stuck.ad;
      const la = localAreaOf(S, stuck.link, srcDev);
      const pa = peerAreaOf(S, stuck.link, srcDev);
      sc.drop = {
        route: dirRoute(stuck.link, srcDev), p: .55, at: .42,
        label: "STUCK · " + ad.state
      };
      sc.trace.push({
        h: num[n++] + " " + srcDev + " 查表 · 无匹配",
        p: "路由表里没有 <b>" + B.net + "/24</b>，也没有任何 OSPF 路由。OSPF 进程是起来的，但邻接关系没到 Full。",
        cls: "drop"
      });
      sc.trace.push({
        h: num[n++] + " 邻居协商 · 卡在 2-Way",
        p: srcDev + " 与 " + otherEnd(stuck.link, srcDev) + " 的接口都收到了 Hello，但 <b>本端 area " +
          la + " ≠ 对端 area " + pa + "</b>。Hello 参数不一致，邻居状态停在 2-Way，永远到不了 Full。",
        cls: "drop"
      });
      sc.trace.push({
        h: num[n++] + " 学不到路由",
        p: "没有 Full 邻居，Router LSA 就交换不完整，SPF 算不出 " + B.net + "/24。报文在 " +
          srcDev + " 查表这一步被丢弃。",
        cls: "drop"
      });
      sc.verdict = {
        bad: true,
        text: "Hello 能收到不等于邻居能建立：area ID、Hello/Dead 定时器、MTU、认证必须完全一致。少对一项，状态就停在 2-Way / ExStart。"
      };
      return sc;
    }

    const noOspf = !S[srcDev].ospf.enabled;
    sc.drop = {
      x: srcDev === "R1" ? 382 : 998, y: 106, at: .30,
      label: "NO ROUTE · " + B.net + "/24"
    };
    sc.trace.push({
      h: num[n++] + " " + srcDev + " 查表 · 无匹配",
      p: "路由表里只有直连网段，没有 <b>" + B.net + "/24</b>。报文在这里被丢弃。",
      cls: "drop"
    });
    sc.trace.push({
      h: num[n++] + (noOspf ? " OSPF 还没启用" : " 没有 Full 邻居"),
      p: noOspf
        ? srcDev + " 还没有 OSPF 进程，远端网段不会自己出现在路由表里。"
        : srcDev + " 起了 OSPF，但对端没起、接口没宣告，或者链路 down —— 没有 Full 邻居就没有 LSA，SPF 无从计算。",
      cls: "drop"
    });
    sc.verdict = {
      bad: true,
      text: noOspf
        ? "直连路由只覆盖接口自己的网段。跨网段要先起 OSPF，把网段宣告出去。"
        : "OSPF 路由不是配出来的，是邻居 Full 之后由 SPF 算出来的。先查 display ospf peer brief。"
    };
    return sc;
  }

  let dev = srcDev;
  let t = .12;
  let ttl = 64;
  let guard = 0;

  while(dev !== dstDev && guard++ < 4){
    const list = lookupAll(S, dev, B.ip);
    if(!list.length) break;
    const rt = list[0];
    if(rt.proto === "Direct" || rt.proto === "Local") break;
    const link = linkByIface(dev, rt.iface);
    if(!link) break;
    const next = otherEnd(link, dev);

    sc.frames.push({ route: dirRoute(link, dev), t0: t, t1: t + .24, kind: "data" });
    sc.trace.push({
      h: num[n++] + " " + dev + " 查表 · 命中 OSPF",
      p: "目的 " + B.ip + " 命中 <b>" + rt.dest + "/" + rt.mask + "</b>（OSPF，Pre 10，Cost " +
        rt.cost + "），下一跳 <b>" + rt.nextHop + "</b>，出接口 <b>" + shortIf(rt.iface) + "</b>。" +
        (list.length > 1 ? " 同一前缀还有 " + (list.length - 1) + " 个等价下一跳。" : ""),
      cls: ""
    });

    if(dev === "R1" && fromPC1){
      sc.trace.push({
        h: "   选路依据",
        p: costNote(S, rt),
        cls: ""
      });
    }

    sc.trace.push({
      h: "   重写二层 · TTL " + ttl + " → " + (ttl - 1),
      p: "目的 IP 不变；源 MAC 换成 " + dev + " " + shortIf(rt.iface) + " 的 <code>" +
        ROUTER_MAC[dev] + "</code>，目的 MAC 换成 " + next + " 入接口的 <code>" +
        ROUTER_MAC[next] + "</code>。" + link.net + "/30 是点对点链路，只有两端两个地址。",
      cls: ""
    });

    ttl--;
    t += .26;
    dev = next;
  }

  const last = lookupAll(S, dstDev, B.ip);
  sc.frames.push({ route: fromPC1 ? "pc2-down" : "pc1-down", t0: t, t1: t + .10, kind: "data" });
  sc.trace.push({
    h: num[n++] + " " + dstDev + " 查表 · 直连",
    p: "目的 " + B.ip + " 命中直连 <b>" + (last ? last[0].dest + "/" + last[0].mask : B.net + "/24") +
      "</b>，出接口 " + (last ? shortIf(last[0].iface) : "GE0/0/1") +
      "；ARP 解析到 " + B.id + " 的 MAC 后送到主机（TTL " + ttl + " → " + (ttl - 1) + "）。",
    cls: ""
  });
  sc.trace.push({
    h: num[n++] + " 回程 · 独立查表",
    p: B.id + " 的 Echo Reply 源 " + B.ip + "、目的 " + A.ip + "，重新交给网关 " + B.gw +
      "，再从 " + dstDev + " 开始逐跳查表。每一跳都只看自己的路由表，往返路径可以不同。",
    cls: "pass"
  });

  sc.verdict = {
    bad: false,
    text: "OSPF 只负责把前缀和下一跳放进路由表；转发仍然是逐跳查表、重写二层、TTL 递减。每一台路由器都独立做决定。"
  };
  return sc;
}

export function ecmpScene(S){
  const rts = ospfRoutesFor(S, "R1", "192.168.2.0", 24);
  const sc = {
    name: "等价路由 · 两条路径同时承载",
    realSec: 4.4,
    dur: 1,
    traceTitle: "ECMP 判读",
    frames: [],
    trace: [],
    drop: null,
    verdict: null
  };
  sc.frames.push({ route: "pc1-up", t0: 0, t1: .08, kind: "data" });

  if(rts.length < 2){
    if(!rts.length){
      sc.trace.push({
        h: "① 当前没有 OSPF 路由",
        p: "R1 的路由表里没有 192.168.2.0/24。先让邻居 Full，并在 R3 上宣告 192.168.2.0/24。",
        cls: "drop"
      });
      sc.verdict = { bad: true, text: "ECMP 的前提是先有一条 OSPF 路由。" };
      return sc;
    }
    const path = (linkCounts(S, "R1", "192.168.2.10", 0) || [])[0] || [];
    let t = .10;
    let dev = "R1";
    path.forEach(function(id){
      const link = LINKS.filter(function(x){ return x.id === id; })[0];
      if(!link) return;
      sc.frames.push({ route: dirRoute(link, dev), t0: t, t1: t + .26, kind: "data" });
      dev = otherEnd(link, dev);
      t += .28;
    });
    sc.frames.push({ route: "pc2-down", t0: t, t1: t + .10, kind: "data" });

    sc.trace.push({
      h: "① 当前只有一条最优路径",
      p: "R1 的 192.168.2.0/24 只有 1 个下一跳：" + rts[0].nextHop + " / " +
        shortIf(rts[0].iface) + "（cost " + rts[0].cost + "）。",
      cls: ""
    });
    sc.trace.push({
      h: "② 为什么没有 ECMP",
      p: "另一条路径的开销比它大，SPF 只把最优的一条装进转发表。开销不相等，就不会出现多个下一跳。",
      cls: ""
    });
    sc.trace.push({
      h: "③ 怎么才能出现",
      p: "把两条路径的累计 cost 调到完全相同（同一前缀、同一区域），SPF 才会把两个下一跳都留下。",
      cls: ""
    });
    sc.verdict = {
      bad: false,
      text: "当前是单路径转发。等价路由不是配出来的，是两条路径开销恰好相等的结果。"
    };
    return sc;
  }

  sc.frames.push({ route: "r12", t0: .10, t1: .38, kind: "data", color: "#38E1FF" });
  sc.frames.push({ route: "r13", t0: .10, t1: .60, kind: "data", color: "#35E08A" });
  sc.frames.push({ route: "r23", t0: .40, t1: .62, kind: "data", color: "#38E1FF" });
  sc.frames.push({ route: "pc2-down", t0: .64, t1: .74, kind: "data", color: "#35E08A" });

  const desc = rts.map(function(rt){
    return rt.nextHop + " / " + shortIf(rt.iface) + "（cost " + rt.cost + "）";
  }).join("、");

  sc.trace.push({
    h: "① 同一前缀两条表项",
    p: "R1 的 192.168.2.0/24 有 " + rts.length + " 个可用下一跳：" + desc + "。",
    cls: ""
  });
  sc.trace.push({
    h: "② 为什么都留下",
    p: "两条路径的累计开销完全相同（都是 " + rts[0].cost + "），SPF 认为它们一样好，于是都装进转发表。",
    cls: ""
  });
  sc.trace.push({
    h: "③ 怎么选",
    p: "真正转发时按五元组哈希选一条。同一条流始终走同一条路，避免乱序；不同流可以分到不同链路。",
    cls: ""
  });
  sc.trace.push({
    h: "④ 结果",
    p: "两条链路同时有流量，总带宽叠加。但<b>单条流仍然只走一条链路</b>，不会因为 ECMP 就变成两倍带宽。",
    cls: "pass"
  });
  sc.verdict = {
    bad: false,
    text: "等价路由的条件：同一前缀、同一开销、同一区域。开销一旦被改得不相等，就只剩一条。"
  };
  return sc;
}

export function failoverScene(S){
  const sc = {
    name: "shutdown GE0/0/2 · 重收敛",
    realSec: 4.2,
    dur: 1,
    traceTitle: "扰动判读",
    frames: [],
    trace: [],
    drop: null,
    verdict: null
  };
  sc.frames.push({ route: "pc1-up", t0: 0, t1: .08, kind: "data" });
  sc.frames.push({ route: "r12", t0: .10, t1: .38, kind: "data" });
  sc.frames.push({ route: "r23", t0: .40, t1: .66, kind: "data" });
  sc.frames.push({ route: "pc2-down", t0: .68, t1: .78, kind: "data" });

  const rts = ospfRoutesFor(S, "R1", "192.168.2.0", 24);
  const now = rts.length ? rts[0].nextHop + " / " + shortIf(rts[0].iface) + "（cost " + rts[0].cost + "）" : "无";

  sc.trace.push({
    h: "① 接口 shutdown",
    p: "R1 GE0/0/2 管理性关闭，物理层 down，这条链路上的直连路由立刻撤销。",
    cls: "drop"
  });
  sc.trace.push({
    h: "② 邻居 Down",
    p: "R3 侧收不到 Hello，Dead timer 到期后邻居从 Full 变 Down；R1 的邻居表里这条关系消失。",
    cls: "drop"
  });
  sc.trace.push({
    h: "③ SPF 重算",
    p: "Full 邻居图少了一条边，SPF 以 R1 为根重新算。原来经 GE0/0/2 的等价表项被删除。",
    cls: ""
  });
  sc.trace.push({
    h: "④ 收敛结果",
    p: "192.168.2.0/24 只剩一个下一跳：" + now + "。流量改走 R1 → R2 → R3。",
    cls: ""
  });
  sc.trace.push({
    h: "⑤ 业务影响",
    p: "切换瞬间可能丢一两个包，稳态业务继续。但两条路径变一条，<b>可用带宽减半</b>，ECMP 的负载分担消失。",
    cls: "pass"
  });
  sc.verdict = {
    bad: false,
    text: "OSPF 收敛的目标不是「不丢包」，而是「尽快恢复可达」。冗余链路减少后，可达性还在，带宽和冗余度下降。"
  };
  return sc;
}

/* ---------------- 引导 ---------------- */
function guide(S, ctx){
  const dev = ctx.dev, r = S[dev];
  const G = function(phase, why, cmd){ return { phase: phase, why: why, cmd: cmd || "" }; };

  if(ctx.view === "if"){
    const pn = portKey(ctx);
    const p = r.ports[pn];
    if(!p) return G("enter", "端口不存在，quit 退回系统视图。", "quit");
    if(!p.up){
      return G("cost", pn + " 处于 shutdown，物理层不工作，OSPF 邻居也起不来。", "undo shutdown");
    }
    return G("cost", pn + " 的 OSPF 开销是 " + p.cost + "。改开销用 ospf cost；它只改变 SPF 选路，不改变接口速率。", "quit");
  }

  if(ctx.view === "area"){
    if(r.ospf.area !== "0.0.0.0"){
      return G("area", "当前区域是 area " + areaShort(r.ospf.area) + "，对端是 area 0。Hello 的区域不一致，邻居只能停在 2-Way。先 quit 回 OSPF 视图改回 area 0。", "quit");
    }
    const miss = missingNets(S, dev);
    if(miss.length){
      return G("network", dev + " 还有 " + miss.length + " 个网段没在 area 0 宣告。先补 " + miss[0].net + " " + miss[0].wild + "。",
        "network " + miss[0].net + " " + miss[0].wild);
    }
    return G("verify", "网段都宣告进 area 0 了。quit 回系统视图，看邻居状态。", "quit");
  }

  if(ctx.view === "ospf"){
    if(r.routerId !== PLAN[dev].rid){
      return G("ospf", dev + " 的 Router ID 是 " + (r.routerId || "未配置") + "，按规划应为 " + PLAN[dev].rid +
        "。quit 回系统视图后用 ospf 1 router-id " + PLAN[dev].rid + " 重新进入。", "quit");
    }
    return G("area", "OSPF 进程已起。进入 area 0，准备 network 宣告。", "area 0");
  }

  if(ctx.view === "system"){
    if(!r.ospf.enabled){
      return G("ospf", dev + " 还没起 OSPF 进程，先 ospf 1 router-id " + PLAN[dev].rid + "。进程起来之后才有 area 和 network。",
        "ospf 1 router-id " + PLAN[dev].rid);
    }
    if(r.routerId !== PLAN[dev].rid){
      return G("ospf", dev + " 的 Router ID 是 " + (r.routerId || "未配置") + "，按规划应为 " + PLAN[dev].rid + "。",
        "ospf 1 router-id " + PLAN[dev].rid);
    }
    const stuck = firstStuck(S, dev);
    if(stuck){
      const peer = otherEnd(stuck.link, dev);
      const la = localAreaOf(S, stuck.link, dev);
      const pa = peerAreaOf(S, stuck.link, dev);
      if(la !== "0.0.0.0"){
        return G("area", "邻居 " + peer + " 停在 2-Way：本端 area " + la + "，对端 area " + pa +
          "。Hello 参数必须完全一致，把本端改回 area 0。", "ospf 1");
      }
      return G("peer", "本端 area 0 正常，但对端 " + peer + " 是 area " + pa +
        "。切到 " + peer + " 把它改回 area 0，邻居才能到 Full。", "");
    }
    const miss = missingNets(S, dev);
    if(miss.length){
      return G("area", "OSPF 进程有了，但还有 " + miss.length + " 个网段没在 area 0 宣告。进 area 0 补 network。", "ospf 1");
    }
    const other = ROUTERS.filter(function(x){ return x !== dev && devTodo(S, x) > 0; })[0];
    if(other){
      return G("peer", dev + " 已就绪。切到 " + other + "，它还没起 OSPF 或没宣告完。", "");
    }
    return G("verify", "配置齐了。display ospf peer brief 看邻居，display ip routing-table 看 OSPF 路由。", "display ospf peer brief");
  }

  if(devTodo(S, dev) > 0){
    return G("enter", "<" + dev + "> 是用户视图，只能看。改配置先 system-view。", "system-view");
  }
  const stuck = firstStuck(S, dev);
  if(stuck){
    const peer = otherEnd(stuck.link, dev);
    const la = localAreaOf(S, stuck.link, dev);
    if(la !== "0.0.0.0"){
      return G("enter", "本端 area " + la + " 与对端 " + peer + " 不一致，邻居停在 2-Way。先 system-view 改回 area 0。", "system-view");
    }
    return G("peer", "本端 area 0 正常，但对端 " + peer + " 是 area " + peerAreaOf(S, stuck.link, dev) +
      "。切到 " + peer + " 改回 area 0。", "");
  }
  const other = ROUTERS.filter(function(x){ return x !== dev && devTodo(S, x) > 0; })[0];
  if(other){
    return G("peer", dev + " 已就绪，切到 " + other + " —— 它还没起 OSPF 或没宣告完。", "");
  }
  return G("verify", "配置齐了。display ospf peer brief、display ip routing-table 交叉核对。", "display ospf peer brief");
}

/* ---------------- 板块 ---------------- */
const steps = [
  {
    id: 1, name: "基线 · 只有直连", key: false, keepTrace: true,
    run: async function(api){
      api.setDev("R1");
      await api.run(["display ip interface brief", "display ip routing-table"]);
      api.play(ospfPathScene(api.S, "PC1"));
    },
    summary: "接口全 up、直连都在，但 R1 没有 192.168.2.0/24，PC1 ping PC2 断在查表",
    detail: [
      { h: "看到什么", p: "三台路由器的 GE 接口都已配地址并 up，R1 路由表里只有 192.168.1.0/24、10.0.12.0/30、10.0.13.0/30 的 Direct / Local。" },
      { h: "为什么不通", p: "直连路由只覆盖接口自己所在的网段。192.168.2.0/24 在 R3 那边，R1 没有任何途径知道它，最长前缀匹配也救不了。" },
      { h: "记住这个对照", p: "后面所有「通了」都是 OSPF 把远端前缀放进路由表的结果；所有「不通」先怀疑邻居没 Full 或前缀没宣告。" }
    ]
  },
  {
    id: 2, name: "R1 · 起 OSPF 进程",
    done: function(S){ return S.R1.ospf.enabled && S.R1.routerId === "1.1.1.1"; },
    run: async function(api){
      api.setDev("R1");
      await api.run(["system-view", "ospf 1 router-id 1.1.1.1", "quit"]);
    },
    summary: "R1 启动 OSPF 进程 1，Router ID 1.1.1.1；但还没有接口跑 OSPF",
    detail: [
      { h: "进程 ≠ 接口", p: "ospf 1 只是在本机拉起一个进程。没有 network 语句，任何接口都不会发 Hello，也不会有邻居。" },
      { h: "Router ID 是什么", p: "LSA 用 Router ID 标识「谁发的」。本实验固定用 1.1.1.1 / 2.2.2.2 / 3.3.3.3，方便在 LSDB 里对照。" }
    ]
  },
  {
    id: 3, name: "R1 · area 0 宣告网段",
    done: function(S){
      return PLAN.R1.nets.every(function(n){ return hasNet(S.R1, n.net, n.wild, "0.0.0.0"); });
    },
    run: async function(api){
      api.setDev("R1");
      await api.run([
        "system-view", "ospf 1", "area 0",
        "network 10.0.12.0 0.0.0.3",
        "network 192.168.1.0 0.0.0.255",
        "network 10.0.13.0 0.0.0.3",
        "quit", "quit", "display ospf interface"
      ]);
    },
    summary: "三个接口进入 area 0：10.0.12.0/30、192.168.1.0/24、10.0.13.0/30",
    detail: [
      { h: "network 的三要素", p: "网段地址 + 反掩码 + 区域。0.0.0.3 对应 /30，只匹配点对点链路的两端地址。" },
      { h: "为什么会宣告 10.0.13.0/30", p: "R1 GE0/0/2 是到 R3 的直连备份链路，也要进 OSPF，否则第 9 步的等价路由没有第二条路径。" },
      { h: "现在还没有邻居", p: "只有 R1 自己在跑 OSPF，R2 / R3 还没起进程。display ospf interface 能看到接口，display ospf peer brief 是空的。" }
    ]
  },
  {
    id: 4, name: "R2 / R3 · 起 OSPF 并宣告",
    done: function(S){
      return S.R2.ospf.enabled && S.R3.ospf.enabled && allFull(S);
    },
    run: async function(api){
      api.setDev("R2");
      await api.run([
        "system-view", "ospf 1 router-id 2.2.2.2", "area 0",
        "network 10.0.12.0 0.0.0.3",
        "network 10.0.23.0 0.0.0.3",
        "quit", "quit"
      ]);
      api.setDev("R3");
      await api.run([
        "system-view", "ospf 1 router-id 3.3.3.3", "area 0",
        "network 10.0.23.0 0.0.0.3",
        "network 192.168.2.0 0.0.0.255",
        "network 10.0.13.0 0.0.0.3",
        "quit", "quit"
      ]);
      api.setDev("R1");
      await api.run(["display ospf peer brief", "display ip routing-table"]);
      api.play(ospfPathScene(api.S, "PC1"));
    },
    summary: "三台两两建立 Full 邻居，R1 路由表第一次出现 OSPF 路由",
    detail: [
      { h: "Hello 协商", p: "两端接口都在同一 area、Hello/Dead 定时器一致、MTU 一致，邻居才能从 Init 走到 2-Way，再走到 Full。" },
      { h: "三角形拓扑", p: "R1-R2、R2-R3、R1-R3 三条链路都 Full。邻居多不等于路径多，最终走哪条由 SPF 的开销决定。" },
      { h: "看表", p: "display ospf peer brief 里三台各自有 2 个 Full 邻居；R1 的路由表出现 OSPF 192.168.2.0/24，下一跳 10.0.12.2。" }
    ]
  },
  {
    id: 5, name: "看 LSDB · 三条 Router LSA",
    run: async function(api){
      api.setDev("R1");
      await api.run(["display ospf lsdb", "display ospf peer brief"]);
    },
    summary: "LSDB 里有 3 条 Router LSA，Advertising Router 分别是三台的 Router ID",
    detail: [
      { h: "LSDB 是什么", p: "同一个区域里所有路由器发来的 LSA 集合。每台路由器一条 Router LSA，描述自己的接口、邻居和直连网段。" },
      { h: "Link State ID", p: "Router LSA 的 Link State ID 就是 Router ID。数一数 1.1.1.1 / 2.2.2.2 / 3.3.3.3 是不是都在。" },
      { h: "数量不对怎么办", p: "LSDB 少一条，说明有一台路由器的 LSA 没泛洪过来——先回去查邻居是不是 Full，而不是直接怀疑 SPF。" }
    ]
  },
  {
    id: 6, name: "SPF 计算 · OSPF 路由进表",
    run: async function(api){
      api.setDev("R1");
      await api.run(["display ospf routing", "display ip routing-table"]);
      api.tab("route");
    },
    summary: "R1 去 192.168.2.0/24：下一跳 10.0.12.2，出接口 GE0/0/1，Cost 1+1+1=3",
    detail: [
      { h: "SPF 以自己为根", p: "每台路由器把自己放在树根，按接口 cost 累加找最短路径。R1 到 R3 有两条路：经 R2 是 1+1=2，直连是 30。" },
      { h: "路由开销再加一段", p: "到 R3 之后，还要加 R3 出 192.168.2.0/24 的接口开销 1，所以经 R2 的完整 cost 是 3。" },
      { h: "为什么不是直连", p: "直连 GE0/0/2 虽然少一跳，但预置开销 30（模拟低带宽备份链路），总 cost 31，远大于 3。OSPF 不看跳数。" }
    ]
  },
  {
    id: 7, name: "逐跳 · PC1 → PC2", key: true, keepTrace: true,
    run: function(api){
      api.setDev("R1");
      api.play(ospfPathScene(api.S, "PC1"));
    },
    summary: "PC1 → R1 查表命中 OSPF → 10.0.12.2 → R2 查表 → 10.0.23.2 → R3 直连 PC2",
    detail: [
      { h: "每一跳都独立查表", p: "R1 只看自己的表：192.168.2.0/24 下一跳 10.0.12.2。R2 再看自己的表：下一跳 10.0.23.2。R3 命中直连，送到 PC2。" },
      { h: "重写二层", p: "每经过一台路由器，源/目的 MAC 都被换成本段链路的地址；目的 IP 始终不变。" },
      { h: "TTL 递减", p: "64 → 63 → 62 → 61。TTL 归零时路由器会丢弃并回 ICMP Time Exceeded，这是防环的最后一道保险。" }
    ]
  },
  {
    id: 8, name: "反直觉 · 改 cost 切路径", key: true, keepTrace: true,
    done: function(S){
      const list = ospfRoutesFor(S, "R1", "192.168.2.0", 24);
      return S.R1.ports["GE0/0/1"].cost === 50 && list.length === 1 && list[0].iface === "GE0/0/2";
    },
    run: async function(api){
      api.setDev("R1");
      await api.run([
        "system-view", "interface GigabitEthernet 0/0/1",
        "ospf cost 50", "quit", "display ip routing-table"
      ]);
      api.play(ospfPathScene(api.S, "PC1"));
    },
    summary: "GE0/0/1 开销 1→50，R1 去 192.168.2.0/24 从 GE0/0/1 切到 GE0/0/2",
    detail: [
      { h: "算一遍开销", p: "经 R2：50 + 1 + 1 = 52；直连：30 + 1 = 31。SPF 选 31，所以出接口变成 GE0/0/2。" },
      { h: "反直觉在哪", p: "直连路径少经过一台路由器，看起来「更直接」，但真正决定的是总开销。把一条链路的 cost 调大，流量会绕路。" },
      { h: "工程含义", p: "OSPF cost 默认按带宽反比计算，也可以手工改。改 cost 是最常用的流量工程手段之一，但改错会造成次优路径。" }
    ]
  },
  {
    id: 9, name: "等价路由 · ECMP", key: true, keepTrace: true,
    done: function(S){
      return ospfRoutesFor(S, "R1", "192.168.2.0", 24).length >= 2;
    },
    run: async function(api){
      api.setDev("R1");
      await api.run([
        "system-view",
        "interface GigabitEthernet 0/0/1", "ospf cost 10", "quit",
        "interface GigabitEthernet 0/0/2", "ospf cost 11", "quit"
      ]);
      api.setDev("R3");
      await api.run([
        "system-view",
        "interface GigabitEthernet 0/0/2", "ospf cost 2", "quit"
      ]);
      api.setDev("R1");
      await api.run(["display ip routing-table"]);
      api.play(ecmpScene(api.S));
    },
    summary: "两条路径开销都调到 12，路由表出现 2 个下一跳，流量按哈希分流",
    detail: [
      { h: "两条路径的开销", p: "经 R2：R1 GE0/0/1(10) + R2 GE0/0/1(1) + R3 GE0/0/1(1) = 12；直连：R1 GE0/0/2(11) + R3 GE0/0/1(1) = 12。" },
      { h: "ECMP 条件", p: "同一前缀、同一开销、同一区域，SPF 才会把多个下一跳都装进转发表。任何一项不同，只剩一条。" },
      { h: "回程也要对称", p: "脚本同时把 R3 GE0/0/2 的开销调成 2，这样回程 192.168.1.0/24 的两条路径也都算成 3，往返都走 ECMP。" },
      { h: "分流方式", p: "按五元组哈希，不是逐包轮询。同一条流固定走一条链路，避免乱序；不同流可以分摊到两条链路。" }
    ]
  },
  {
    id: 10, name: "扰动 · shutdown 一条等价路径", key: true, keepTrace: true,
    done: function(S){
      return !S.R1.ports["GE0/0/2"].up &&
        ospfRoutesFor(S, "R1", "192.168.2.0", 24).length === 1;
    },
    run: async function(api){
      api.setDev("R1");
      await api.run([
        "system-view", "interface GigabitEthernet 0/0/2",
        "shutdown", "quit",
        "display ospf peer brief", "display ip routing-table"
      ]);
      api.play(failoverScene(api.S));
    },
    summary: "GE0/0/2 shutdown：邻居 Down、路由收敛到单条，业务继续但带宽减半",
    detail: [
      { h: "先发生什么", p: "接口 down → 直连路由撤销 → Hello 中断 → 邻居 Down → Full 邻居图少一条边。" },
      { h: "SPF 重算", p: "原来两条等价表项被删掉一条，192.168.2.0/24 只剩 10.0.12.2 / GE0/0/1。" },
      { h: "业务影响", p: "切换瞬间可能丢一两个包，稳态可达性还在；但两条路径变一条，带宽和冗余度都下降。这就是「不中断 ≠ 没影响」。" }
    ]
  },
  {
    id: 11, name: "反直觉 · 邻居卡在 2-Way", key: true, keepTrace: true,
    done: function(S){ return S.flags.areaDrill === true; },
    run: async function(api){
      api.setDev("R1");
      await api.run([
        "system-view", "ospf 1", "area 1",
        "network 10.0.12.0 0.0.0.3",
        "network 192.168.1.0 0.0.0.255",
        "network 10.0.13.0 0.0.0.3",
        "quit", "quit", "display ospf peer brief"
      ]);
      const stuck = ospfPathScene(api.S, "PC1");
      await api.run([
        "ospf 1", "area 0",
        "network 10.0.12.0 0.0.0.3",
        "network 192.168.1.0 0.0.0.255",
        "network 10.0.13.0 0.0.0.3",
        "quit", "quit", "display ospf peer brief"
      ]);
      api.S.flags.areaDrill = true;
      api.play(stuck);
    },
    summary: "R1 改成 area 1：Hello 能收到，但邻居停在 2-Way，路由学不到；改回 area 0 才恢复",
    detail: [
      { h: "为什么是 2-Way", p: "两端的 Hello 报文能到达，但 area ID 不一致，对端不会把它当成可用的邻居继续往下走。状态停在 2-Way，永远到不了 Full。" },
      { h: "为什么学不到路由", p: "Full 才交换完整的 Router LSA。邻居卡在 2-Way，LSDB 里没有对端的 LSA，SPF 算不出 192.168.2.0/24。" },
      { h: "Hello 参数必须完全一致", p: "area ID、Hello/Dead 定时器、MTU、认证，任何一项不一致都会卡住。真实 VRP 上 area 不一致通常连邻居都不显示——这里用 2-Way 表示「收到了但参数对不上」。" }
    ]
  },
  {
    id: 12, name: "校验 · OSPF 接口与路由表",
    run: async function(api){
      api.setDev("R1");
      await api.run([
        "system-view", "interface GigabitEthernet 0/0/2",
        "undo shutdown", "quit",
        "display ospf peer brief",
        "display ospf interface",
        "display ip routing-table protocol ospf"
      ]);
    },
    summary: "恢复 GE0/0/2 后 ECMP 回来；逐项对照接口 cost、下一跳与路由表项",
    detail: [
      { h: "display ospf interface", p: "看每个接口的 area 与 cost。R1 GE0/0/1 是 10、GE0/0/2 是 11，R3 GE0/0/2 是 2——这些数字就是 SPF 的边权。" },
      { h: "display ip routing-table protocol ospf", p: "192.168.2.0/24 应该出现两行，下一跳分别是 10.0.12.2 和 10.0.13.2，cost 都是 12。" },
      { h: "排障顺序", p: "邻居 Full？→ LSDB 有对端 LSA？→ OSPF 路由表有前缀？→ 路由表下一跳和出接口对不对？四步走完，问题一定定位。" }
    ]
  }
];

/* ---------------- 导出 ---------------- */
export default {
  id: "06",
  title: "OSPF 邻居与选路",
  meta: "HUAWEI AR2220 · VRP V200R005C00",
  stageLabel: "L3 ROUTING · OSPF · 3 × AR2220 · 2 × HOST",
  totalSteps: steps.length,
  devices: ["R1", "R2", "R3"],
  tabs: [
    { key: "neighbor", label: "OSPF 邻居", hint: "邻居状态（Full / 2-Way / Down）" },
    { key: "lsdb", label: "LSDB", hint: "链路状态数据库" },
    { key: "route", label: "路由表", hint: "IP 路由表（含 OSPF）" },
    { key: "cost", label: "接口开销", hint: "OSPF 接口 cost 与区域" }
  ],
  legend: [
    { c: "#35E08A", label: "Full / 直连" },
    { c: "#38E1FF", label: "OSPF 路由" },
    { c: "#FFB545", label: "2-Way / 未宣告" },
    { c: "#FF4D5E", label: "Down / 丢弃" },
    { c: "#7E93AB", label: "Local / 空闲" }
  ],
  phases: {
    enter: "进系统视图",
    ospf: "起 OSPF 进程",
    area: "选区域",
    network: "宣告网段",
    cost: "调开销",
    verify: "校验",
    peer: "换设备"
  },
  viewName: VIEW_NAME,
  viewHint: VIEW_HINT,
  actions: [
    { id: "pc1pc2", label: "PC1 → PC2", run: function(l){ l.playScene(ospfPathScene(l.S, "PC1")); } },
    { id: "pc2pc1", label: "PC2 → PC1", run: function(l){ l.playScene(ospfPathScene(l.S, "PC2")); } },
    { id: "ecmp", label: "看等价路由", run: function(l){ l.playScene(ecmpScene(l.S)); } },
    { id: "r1ping", label: "R1 ping PC2", run: function(l){ l.setDev("R1"); l.execute("ping 192.168.2.10"); } }
  ],
  createState: createState,
  prompt: prompt,
  commands: commands,
  tables: tables,
  topology: topology,
  guide: guide,
  steps: steps,

  idle: {
    title: "判读顺序",
    items: [
      { h: "① Hello 协商", p: "两端接口在同一 area、Hello/Dead 定时器一致、MTU 一致，邻居才能到 Full。卡在 2-Way / ExStart，先查参数，不要先怀疑 SPF。" },
      { h: "② LSDB", p: "Full 之后交换 Router LSA。每台路由器一条，Link State ID 就是 Router ID。LSDB 不全，SPF 一定算错。" },
      { h: "③ SPF", p: "以自己为根，按接口 cost 累加找最短路径。OSPF 比的是总开销，不是跳数——这就是 S8 反直觉的来源。" },
      { h: "④ 路由表与转发", p: "OSPF 路由优先级 10。转发仍然逐跳查表、重写二层、TTL 递减；等价路由按流哈希分流。" },
      { h: "简化声明", p: "SPF 为稳态简化实现：按接口 cost 做最短路径，不模拟 LSA 泛洪时序、DR/BDR 选举与 Hello 定时器。" }
    ]
  },

  viewRows: function(ctx){
    return [
      { h: "<" + ctx.dev + "> 用户视图", p: "只读：display、ping。改配置在这里一律被拒。", cls: ctx.view === "user" ? "pass" : "" },
      { h: "[" + ctx.dev + "] 系统视图", p: "全局入口：ospf、interface。", cls: ctx.view === "system" ? "pass" : "" },
      { h: "[" + ctx.dev + "-ospf-1] OSPF 视图", p: "只作用于进程 1：area 选择区域。Router ID 在系统视图用 ospf 1 router-id 重新指定。", cls: ctx.view === "ospf" ? "pass" : "" },
      { h: "[" + ctx.dev + "-ospf-1-area-0.0.0.0] 区域视图", p: "只作用于这个区域：network 把接口地址宣告进来。", cls: ctx.view === "area" ? "pass" : "" },
      { h: "[" + ctx.dev + "-GE0/0/x] 接口视图", p: "只作用于当前接口：ip address、ospf cost、shutdown。", cls: ctx.view === "if" ? "pass" : "" }
    ];
  },

  boot: function(write, printGuide){
    write("Info: 已加载 R1 / R2 / R3 的接口配置：GE 接口已配 IP 并 undo shutdown，OSPF 尚未启用。", "dim");
    write("      R1 GE0/0/2 的 OSPF 开销预置为 30（模拟低带宽备份链路），其余接口为默认 1。", "dim");
    write("      简化：SPF 按接口 cost 做稳态最短路径，不模拟 LSA 泛洪时序、DR/BDR 选举与 Hello 定时器。", "dim");
    write("", "dim");
    printGuide();
  }
};
