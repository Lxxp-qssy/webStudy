import { pad, padL } from "../lib/util.js";

/* =========================================================================
   实验 08 · NAT / NAPT 转换
   -------------------------------------------------------------------------
   一台边界路由器 R1 挂两个方向：
     GE0/0/0 192.168.1.1/24  内网（SW1 → PC1 / PC2）
     GE0/0/1 200.1.1.1/24    外网（ISP → SRV 202.1.1.1）
   整个实验只围绕一件事：私网源地址怎么在出方向被换掉、回程又靠什么被换回来。

     createState   → 接口地址（已就绪）、空路由表、空 ACL、空 NAT、空会话表
     lookup        → 最长前缀匹配（默认路由就是掩码 0 的那一条）
     aclMatch      → 基本 ACL 按 rule id 升序首次匹配（NAT 里只有 permit 才转换）
     natOutboundOf → 某个出接口上挂的 nat outbound（动作）
     ensureSession → 真正建立/复用一条 NAPT 会话，端口按内网主机固定分配
     natScene      → 把一个报文沿「主机 → SW1 → R1 查表 → 出方向转换 → 回程反查」走一遍
   ========================================================================= */

const ACL_ID = 2000;

const HOSTS = {
  PC1: {
    id: "PC1", ip: "192.168.1.10", mask: 24, gw: "192.168.1.1",
    mac: "5489-98b1-0001", x: 140, color: "#38E1FF", sport: 5000, vlan: 1
  },
  PC2: {
    id: "PC2", ip: "192.168.1.11", mask: 24, gw: "192.168.1.1",
    mac: "5489-98b1-0002", x: 320, color: "#FFB545", sport: 5000, vlan: 1
  },
  SRV: {
    id: "SRV", ip: "202.1.1.1", mask: 24, gw: "202.1.1.254",
    mac: "5489-98c9-0101", x: 1060, color: "#35E08A", sport: 0, vlan: "—"
  }
};

const HOST_ORDER = ["192.168.1.10", "192.168.1.11"];

/* ---------------- 拓扑几何 ---------------- */
const DEV = {
  SW1: { x: 180, y: 62, w: 240, h: 74, portX: { "GE0/0/1": 60, "GE0/0/2": 160, "GE0/0/24": 210 } },
  R1: { x: 560, y: 62, w: 300, h: 74, portX: { "GE0/0/0": 40, "GE0/0/1": 240 } }
};

const ROUTES = {
  "pc1-up": "M140 200 C150 172 190 128 240 106",
  "pc1-down": "M240 106 C190 128 150 172 140 200",
  "pc2-up": "M320 200 C324 172 330 132 340 106",
  "pc2-down": "M340 106 C330 132 324 172 320 200",
  "sw-up": "M390 106 L600 106",
  "sw-down": "M600 106 L390 106",
  "r1-thru": "M600 106 C672 88 728 88 800 106",
  "r1-back": "M800 106 C728 88 672 88 600 106",
  "wan-up": "M800 106 C860 120 962 166 1060 200",
  "wan-down": "M1060 200 C962 166 860 120 800 106"
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

function sameSubnet(a, b, len){
  const va = ipToInt(a), vb = ipToInt(b);
  if(va === null || vb === null) return false;
  const m = maskInt(len);
  return ((va & m) >>> 0) === ((vb & m) >>> 0);
}

/* 反掩码匹配：wild 为 0 表示精确匹配一个地址 */
function inWild(ip, net, wild){
  const va = ipToInt(ip), vn = ipToInt(net);
  if(va === null || vn === null) return false;
  const w = (wild === "0" || wild === "") ? 0 : ipToInt(wild);
  if(w === null) return false;
  const m = (~w) >>> 0;
  return ((va & m) >>> 0) === ((vn & m) >>> 0);
}

/* ---------------- 初始状态 ---------------- */
export function createState(){
  return {
    R1: {
      name: "R1",
      ports: {
        "GE0/0/0": { ip: "192.168.1.1", mask: 24, up: true },
        "GE0/0/1": { ip: "200.1.1.1", mask: 24, up: true }
      },
      static: [],
      acl: {},
      hits: {},
      nat: { outbound: [], seq: 0 },
      session: []
    }
  };
}

/* ---------------- 路由表派生 ---------------- */
function ifaceFor(r, nh){
  const names = Object.keys(r.ports);
  for(let i = 0; i < names.length; i++){
    const p = r.ports[names[i]];
    if(p.up && p.ip && sameSubnet(nh, p.ip, p.mask)) return names[i];
  }
  return "";
}

function routesOf(S){
  const r = S.R1, list = [];
  Object.keys(r.ports).forEach(function(pn){
    const p = r.ports[pn];
    if(!p.ip || !p.up) return;
    list.push({
      dest: netOf(p.ip, p.mask), mask: p.mask, proto: "Direct", pre: 0,
      nextHop: p.ip, iface: pn, active: true
    });
    list.push({
      dest: p.ip, mask: 32, proto: "Local", pre: 0,
      nextHop: "127.0.0.1", iface: pn, active: true
    });
  });
  r.static.forEach(function(rt){
    const iface = ifaceFor(r, rt.nh);
    list.push({
      dest: rt.dest, mask: rt.mask, proto: "Static", pre: 60,
      nextHop: rt.nh, iface: iface || "—", active: !!iface
    });
  });
  list.sort(function(a, b){
    const d = (ipToInt(a.dest) || 0) - (ipToInt(b.dest) || 0);
    if(d) return d;
    if(a.mask !== b.mask) return b.mask - a.mask;
    return a.pre - b.pre;
  });
  return list;
}

/* 最长前缀匹配：掩码更长者优先，同长度比优先级 */
function lookup(S, dst){
  const v = ipToInt(dst);
  if(v === null) return null;
  let best = null;
  routesOf(S).forEach(function(rt){
    if(!rt.active) return;
    if(((v & maskInt(rt.mask)) >>> 0) !== ipToInt(rt.dest)) return;
    if(!best || rt.mask > best.mask || (rt.mask === best.mask && rt.pre < best.pre)) best = rt;
  });
  return best;
}

function routeKey(rt){
  if(rt.proto === "Local") return "rt-Local-" + rt.dest + "-32";
  return "rt-" + rt.proto + "-" + rt.dest + "-" + rt.mask;
}

function hasDefault(S){
  return S.R1.static.some(function(rt){ return rt.mask === 0 && rt.dest === "0.0.0.0"; });
}

/* ---------------- ACL（条件）与 NAT（动作） ---------------- */
function aclRules(S, aclId){
  const acl = S.R1.acl[aclId];
  if(!acl) return [];
  return acl.rules.slice().sort(function(a, b){ return a.id - b.id; });
}

/* 基本 ACL 只看源地址；NAT 的语义：只有命中 permit 才转换 */
function aclMatch(S, aclId, src){
  const acl = S.R1.acl[aclId];
  if(!acl) return { action: "nomatch", rule: null, noAcl: true };
  const rs = aclRules(S, aclId);
  for(let i = 0; i < rs.length; i++){
    if(inWild(src, rs[i].src, rs[i].wild)) return { action: rs[i].action, rule: rs[i] };
  }
  return { action: "nomatch", rule: null };
}

function ruleText(r){
  return r.action + " source " + r.src + " " + r.wild;
}

function natOutboundOf(S, iface){
  const list = S.R1.nat.outbound;
  for(let i = 0; i < list.length; i++){
    if(list[i].iface === iface) return list[i];
  }
  return null;
}

function aclHasPermit(S){
  const rs = aclRules(S, ACL_ID);
  for(let i = 0; i < rs.length; i++){
    if(rs[i].action === "permit") return true;
  }
  return false;
}

/* ---------------- 会话表 ---------------- */
function agingOf(proto){
  if(proto === "TCP") return 86400;
  if(proto === "UDP") return 300;
  return 60;
}

function fmtAging(sec){
  const z = function(n){ return (n < 10 ? "0" : "") + n; };
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return z(h) + ":" + z(m) + ":" + z(s);
}

/* 公网端口：内网主机按固定顺序拿 1024 / 1025，保证叙述稳定 */
function allocPort(S, inIp){
  const idx = HOST_ORDER.indexOf(inIp);
  let port = idx >= 0 ? 1024 + idx : 1024;
  const used = function(p){
    return S.R1.session.some(function(x){ return x.outPort === p; });
  };
  while(used(port)) port++;
  return port;
}

/* 同一内网 IP + 端口 → 复用同一条会话、同一个公网端口 */
function ensureSession(S, host, dstIp){
  const r = S.R1;
  let s = null;
  for(let i = 0; i < r.session.length; i++){
    if(r.session[i].inIp === host.ip && r.session[i].inPort === host.sport){
      s = r.session[i];
      break;
    }
  }
  if(!s){
    r.nat.seq++;
    s = {
      id: "s" + r.nat.seq,
      proto: "ICMP",
      inIp: host.ip,
      inPort: host.sport,
      outIp: r.ports["GE0/0/1"].ip,
      outPort: allocPort(S, host.ip),
      dstIp: dstIp,
      dstPort: 0,
      iface: "GE0/0/1",
      status: "Active",
      aging: agingOf("ICMP")
    };
    r.session.push(s);
  }
  s.dstIp = dstIp;
  return s;
}

function sessionLine(s){
  return s.inIp + ":" + s.inPort + " → " + s.outIp + ":" + s.outPort;
}

/* ---------------- 视图 ---------------- */
const VIEW_NAME = { user: "用户视图", system: "系统视图", if: "接口视图", acl: "ACL 视图" };
const VIEW_HINT = {
  system: "system-view",
  if: "interface GigabitEthernet 0/0/1",
  acl: "acl 2000"
};

function portKey(ctx){
  return "GE" + String(ctx.ifName).replace("GigabitEthernet", "");
}

function prompt(ctx){
  if(ctx.view === "user") return "<" + ctx.dev + ">";
  if(ctx.view === "system") return "[" + ctx.dev + "]";
  if(ctx.view === "acl") return "[" + ctx.dev + "-acl-basic-" + (ctx.aclId || ACL_ID) + "]";
  return "[" + ctx.dev + "-" + ctx.ifName + "]";
}

/* ---------------- 命令表 ---------------- */
const P = "GigabitEthernet|GE|gigabitethernet";
const WILD = "(\\d+\\.\\d+\\.\\d+\\.\\d+|0)";
const RULE_RE = new RegExp("^rule(?: (\\d+))? (permit|deny) source (\\d+\\.\\d+\\.\\d+\\.\\d+) " + WILD + "$");

const commands = [
  {
    id: "system-view", match: /^(system-view|sys)$/, view: null, kind: "view",
    usage: "system-view",
    run(api){
      if(api.ctx.view !== "user"){
        api.say("Error: Unrecognized command found at '^' position.", "err");
        return;
      }
      api.ctx.view = "system"; api.ctx.ifName = "";
      api.say("Enter system view, return user view with Ctrl+Z.", "dim");
    }
  },
  {
    id: "quit", match: /^(quit|q)$/, view: null, kind: "view", usage: "quit",
    run(api){
      const c = api.ctx;
      if(c.view === "if"){ c.view = "system"; c.ifName = ""; }
      else if(c.view === "acl"){ c.view = "system"; c.aclId = ""; }
      else if(c.view === "system"){ c.view = "user"; }
      else api.say("Error: Unrecognized command found at '^' position.", "err");
    }
  },
  {
    id: "return", match: /^(return|ctrl\+z)$/, view: null, kind: "view", usage: "return",
    run(api){ api.ctx.view = "user"; api.ctx.ifName = ""; api.ctx.aclId = ""; }
  },
  {
    id: "interface", match: new RegExp("^interface (?:" + P + ")?\\s*([\\d/]+)$", "i"),
    view: "system", kind: "view", usage: "interface GigabitEthernet 0/0/1",
    run(api, m){
      const key = "GE" + m[1];
      if(!api.S.R1.ports[key]){
        api.say("Error: The port does not exist.", "err");
        return;
      }
      api.ctx.view = "if";
      api.ctx.ifName = "GigabitEthernet" + m[1];
    }
  },
  {
    id: "ip-address", match: /^ip address ([\d.]+) ([\d.]+)$/, view: "if", kind: "config",
    usage: "ip address <192.168.1.1> <24>",
    explain: [
      { h: "改的是接口地址", p: "地址与掩码决定这个接口属于哪个网段，也决定 NAT 转换后用的公网地址。接口 up 时会同步刷新直连路由。" },
      { h: "注意", p: "本实验的两个接口开场就已配好，这条命令只在你想改地址时才用得到。" }
    ],
    run(api, m){
      const pn = portKey(api.ctx);
      const p = api.S.R1.ports[pn];
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
      const old = p.ip ? p.ip + "/" + p.mask : "unassigned";
      p.ip = ip; p.mask = len;
      api.change(pn + ".ip", old, ip + "/" + len, { row: "rt-Direct-" + netOf(ip, len) + "-" + len });
      api.tab("route");
      api.say("// " + pn + " 地址已改为 " + ip + "/" + len + "，直连路由与本机 /32 随之重算。", "op");
      api.fx({ kind: "pulse", target: "R1/" + pn, color: "#38E1FF" });
    }
  },
  {
    id: "undo-shutdown", match: /^undo shutdown$/, view: "if", kind: "config",
    usage: "undo shutdown",
    explain: [
      { h: "启用接口", p: "shutdown 是管理性关闭：线插着、灯不亮、协议不 up。undo shutdown 后接口才真正工作。" },
      { h: "本实验", p: "GE0/0/0 与 GE0/0/1 开场都是 up，这条命令只会得到「未产生状态变化」。" }
    ],
    run(api){
      const pn = portKey(api.ctx);
      const p = api.S.R1.ports[pn];
      if(!p){ api.say("Error: The port does not exist.", "err"); return; }
      if(p.up){
        api.say("// " + pn + " 已经是 up，命令未产生状态变化。", "op");
        return;
      }
      p.up = true;
      api.change(pn + ".state", "shutdown", "up", { row: "rt-Direct-" + netOf(p.ip, p.mask) + "-" + p.mask });
      api.tab("route");
      api.say("// " + pn + " 已 up，直连网段重新进入路由表。", "op");
      api.fx({ kind: "pulse", target: "R1/" + pn, color: "#35E08A" });
    }
  },
  {
    id: "ip-route-static", match: /^ip route-static ([\d.]+) (\d+|[0-9.]+) ([\d.]+)$/,
    view: "system", kind: "config",
    usage: "ip route-static <0.0.0.0> <0> <200.1.1.254>",
    explain: [
      { h: "默认路由", p: "目的 0.0.0.0、掩码 0 就是默认路由：任何在路由表里查不到的目的地址，都从这条走。这是内网访问任意外网地址的前提。" },
      { h: "先有路，再谈 NAT", p: "连出接口都选不出来时，NAT 根本不会被执行。所以排障顺序永远是：先路由表，再会话表。" }
    ],
    run(api, m){
      const r = api.S.R1;
      const len = maskToLen(m[2]);
      if(ipToInt(m[1]) === null || ipToInt(m[3]) === null || len < 0){
        api.say("Error: Wrong parameter found at '^' position.", "err");
        return;
      }
      const dest = netOf(m[1], len);
      const same = r.static.filter(function(x){ return x.dest === dest && x.mask === len; })[0];
      if(same && same.nh === m[3]){
        api.say("// 目的 " + dest + "/" + len + "、下一跳 " + m[3] + " 的静态路由已存在，命令未产生状态变化。", "op");
        return;
      }
      let old = "不存在";
      if(same){ old = same.nh; same.nh = m[3]; }
      else r.static.push({ dest: dest, mask: len, nh: m[3] });
      api.change("静态路由 " + dest + "/" + len, old, m[3], {
        row: "rt-Static-" + dest + "-" + len, kind: "enter"
      });
      api.tab("route");
      const iface = ifaceFor(r, m[3]);
      if(iface){
        api.say("// " + (len === 0 ? "默认路由 0.0.0.0/0" : dest + "/" + len) + " → 下一跳 " + m[3] +
          "，出接口 " + iface + "。", "op");
        if(len === 0) api.say("// 现在 R1 自己访问任意外网地址都能找到出口；但内网主机的私网源地址仍然出不了公网。", "op");
      }else{
        api.say("// 警告：下一跳 " + m[3] + " 不落在任何直连网段，路由无法生效。", "op");
      }
      api.fx({ kind: "pulse", target: "R1/" + (iface || "GE0/0/1"), color: "#38E1FF" });
    }
  },
  {
    id: "undo-ip-route-static", match: /^undo ip route-static ([\d.]+) (\d+|[0-9.]+) ([\d.]+)$/,
    view: "system", kind: "config",
    usage: "undo ip route-static <0.0.0.0> <0> <200.1.1.254>",
    explain: [
      { h: "删默认路由", p: "三个参数必须与配置一致。删掉后，所有依赖它的外部目的地址都会查表失败。" }
    ],
    run(api, m){
      const r = api.S.R1;
      const len = maskToLen(m[2]);
      if(ipToInt(m[1]) === null || ipToInt(m[3]) === null || len < 0){
        api.say("Error: Wrong parameter found at '^' position.", "err");
        return;
      }
      const dest = netOf(m[1], len);
      const i = r.static.findIndex(function(x){
        return x.dest === dest && x.mask === len && x.nh === m[3];
      });
      if(i < 0){
        api.say("// 配置里没有 " + dest + "/" + len + " 经 " + m[3] + " 的静态路由，命令未产生状态变化。", "op");
        return;
      }
      r.static.splice(i, 1);
      api.change("静态路由 " + dest + "/" + len, m[3], "已删除", { kind: "exit" });
      api.tab("route");
      api.say("// " + dest + "/" + len + " 已移除。", "op");
    }
  },
  {
    id: "acl", match: /^acl (\d+)$/, view: "system", kind: "view", usage: "acl 2000",
    run(api, m){
      const id = parseInt(m[1], 10);
      if(id < 2000 || id > 2999){
        api.say("Error: The ACL number is invalid.", "err");
        api.say("      2000–2999 是基本 ACL（只匹配源地址），NAT 用它来挑「哪些源要被转换」。3000–3999 是高级 ACL。", "dim");
        return;
      }
      if(!api.S.R1.acl[id]){
        api.S.R1.acl[id] = { rules: [] };
        api.change("ACL " + id, "不存在", "已创建 · 0 条规则", { row: "rule-default", kind: "enter" });
        api.say("// 新建基本 ACL " + id + "。注意：在 NAT 里，空表不是「放通一切」，而是「谁都不匹配 → 一条也不转换」。", "op");
      }else{
        api.say("// ACL " + id + " 已存在，直接进入编辑视图。", "op");
      }
      api.ctx.view = "acl"; api.ctx.aclId = id; api.ctx.ifName = "";
    }
  },
  {
    id: "rule", match: RULE_RE, view: "acl", kind: "config",
    usage: "rule permit source <192.168.1.0> <0.0.0.255>",
    explain: [
      { h: "ACL 只是条件", p: "写下这条规则不会转换任何流量。它只回答「这个源地址要不要做 NAT」，动作要等 nat outbound 来调用。" },
      { h: "permit / deny", p: "命中 permit 才转换；命中 deny 或整表未命中，报文照常转发，只是源地址保持私网不变。" }
    ],
    run(api, m){
      const aclId = api.ctx.aclId || ACL_ID;
      const acl = api.S.R1.acl[aclId];
      if(!acl){ api.say("Error: The ACL does not exist.", "err"); return; }
      if(ipToInt(m[3]) === null || (m[4] !== "0" && ipToInt(m[4]) === null)){
        api.say("Error: Wrong parameter found at '^' position.", "err");
        return;
      }
      let id = m[1] ? parseInt(m[1], 10) : 0;
      if(!id){
        const rs = aclRules(api.S, aclId);
        id = rs.length ? rs[rs.length - 1].id + 5 : 5;
      }
      const ex = acl.rules.filter(function(r){ return r.id === id; })[0];
      if(ex){
        const before = ruleText(ex);
        ex.action = m[2]; ex.src = m[3]; ex.wild = m[4];
        acl.rules.sort(function(a, b){ return a.id - b.id; });
        api.change("ACL " + aclId + " · rule " + id, before, ruleText(ex), { row: "rule-" + id });
        api.say("// rule " + id + " 已存在，按真实设备的行为被新内容覆盖。", "op");
      }else{
        acl.rules.push({ id: id, action: m[2], src: m[3], wild: m[4] });
        acl.rules.sort(function(a, b){ return a.id - b.id; });
        api.change("ACL " + aclId + " · rule " + id, "不存在", ruleText(acl.rules.filter(function(r){ return r.id === id; })[0]), {
          row: "rule-" + id, kind: "enter"
        });
        api.say("// 条件已写入 ACL " + aclId + "：" + m[2] + " source " + m[3] + " " + m[4] +
          "。这只是一张筛选表，还没有任何动作引用它。", "op");
      }
      api.tab("acl");
    }
  },
  {
    id: "undo-rule", match: /^undo rule (\d+)$/, view: "acl", kind: "config", usage: "undo rule 5",
    explain: [
      { h: "删条件", p: "删掉 permit 规则后，这条流量就落进「未命中」→ 不做 NAT。nat outbound 动作还在，只是没有条件能命中。" }
    ],
    run(api, m){
      const id = parseInt(m[1], 10);
      const aclId = api.ctx.aclId || ACL_ID;
      const acl = api.S.R1.acl[aclId];
      if(!acl){ api.say("Error: The ACL does not exist.", "err"); return; }
      const i = acl.rules.findIndex(function(r){ return r.id === id; });
      if(i < 0){
        api.say("// ACL " + aclId + " 里没有 rule " + id + "，命令未产生状态变化。", "op");
        return;
      }
      const before = ruleText(acl.rules[i]);
      acl.rules.splice(i, 1);
      api.change("ACL " + aclId + " · rule " + id, before, "已删除", { kind: "exit" });
      api.tab("acl");
      api.say("// rule " + id + " 已删除。" + (acl.rules.length ? "" : "ACL 现在是空表：一条流量都不会被转换。"), "op");
    }
  },
  {
    id: "nat-outbound", match: /^nat outbound (\d+)$/, view: "if", kind: "config",
    usage: "nat outbound <2000>",
    explain: [
      { h: "动作挂在哪", p: "nat outbound 必须挂在<b>流量离开设备</b>的那个接口上。挂在报文进入的接口上，设备根本不会在这个方向执行它。" },
      { h: "Easy IP", p: "不带地址池时，直接用出接口的地址做转换，这叫 Easy IP，本质就是 NAPT：IP 和端口一起换。" }
    ],
    run(api, m){
      const id = parseInt(m[1], 10);
      const ifn = portKey(api.ctx);
      if(!api.S.R1.ports[ifn]){ api.say("Error: The port does not exist.", "err"); return; }
      if(!api.S.R1.acl[id]){
        api.say("Error: The ACL does not exist.", "err");
        api.say("      先 system-view → acl " + id + " 建条件表，再回来绑定动作。", "dim");
        return;
      }
      const cur = natOutboundOf(api.S, ifn);
      if(cur && cur.acl === id){
        api.say("// " + ifn + " 已经绑定 ACL " + id + "，命令未产生状态变化。", "op");
        return;
      }
      let old = "未配置";
      if(cur){ old = "outbound acl " + cur.acl; cur.acl = id; }
      else api.S.R1.nat.outbound.push({ iface: ifn, acl: id });
      api.change("NAT " + ifn, old, "outbound acl " + id, {
        row: "nat-app-" + ifn, kind: cur ? "chg" : "enter"
      });
      api.tab("nat");
      if(ifn === "GE0/0/1"){
        api.say("// ACL " + id + " 已绑定到 " + ifn + " 的出方向：报文离开这个接口时，源地址换成 " +
          api.S.R1.ports[ifn].ip + "，并写入会话表。", "op");
      }else{
        api.say("// 命令被设备接受了，但 " + ifn + " 是内网口 —— 报文从这里进入设备，出方向根本不经过它。", "op");
        api.say("// 这条配置看起来存在，却不会转换任何一个报文。", "op");
      }
      api.fx({ kind: "pulse", target: "R1/" + ifn, color: ifn === "GE0/0/1" ? "#38E1FF" : "#FFB545" });
    }
  },
  {
    id: "undo-nat-outbound", match: /^undo nat outbound(?: (\d+))?$/, view: "if", kind: "config",
    usage: "undo nat outbound <2000>",
    explain: [
      { h: "删的是动作", p: "undo nat outbound 摘掉接口上的转换动作，ACL 的规则一条都不会少。动作没了，条件还在。" }
    ],
    run(api, m){
      const ifn = portKey(api.ctx);
      const cur = natOutboundOf(api.S, ifn);
      if(!cur){
        api.say("// " + ifn + " 上没有 nat outbound，命令未产生状态变化。", "op");
        return;
      }
      if(m[1] && String(cur.acl) !== m[1]){
        api.say("// 当前绑定的是 ACL " + cur.acl + "，命令里的编号是 " + m[1] + "，未做改动。", "op");
        return;
      }
      const list = api.S.R1.nat.outbound;
      const i = list.findIndex(function(x){ return x.iface === ifn; });
      if(i >= 0) list.splice(i, 1);
      api.change("NAT " + ifn, "outbound acl " + cur.acl, "未配置", { row: "nat-app-" + ifn, kind: "exit" });
      api.tab("nat");
      api.say("// " + ifn + " 上的 nat outbound 已移除。ACL " + cur.acl + " 的规则一条没动 —— 动作没了，条件还在。", "op");
      api.say("// 会话表里的旧条目不会立刻消失（真实设备上会继续转换到老化），但新报文已经没有转换动作。", "op");
    }
  },

  /* ---- 只读命令 ---- */
  {
    id: "display-nat-session", match: /^display nat session all$/, view: null, kind: "doc",
    usage: "display nat session all",
    doc: "这张表回答：<b>哪些连接正在被转换、内外网地址与端口怎么对应、还有多久老化</b>。它是 NAT 唯一的记忆，表没了，回程就不知道该还给谁。",
    run(api){
      const list = api.S.R1.session.slice().sort(function(a, b){ return a.outPort - b.outPort; });
      api.say("  NAT Session Information:");
      api.say("  Total : " + list.length, "dim");
      api.say("", "dim");
      api.say(pad("PROTOCOL", 10) + pad("INSIDE-SOURCE", 22) + pad("OUTSIDE-SOURCE", 20) +
        pad("DESTINATION", 16) + pad("STATUS", 9) + "REMAIN", "dim");
      api.say("-------------------------------------------------------------------------------------", "dim");
      if(!list.length){
        api.say("  (会话表为空 · 还没有一条被转换的连接)", "dim");
      }
      list.forEach(function(s){
        api.say(pad(s.proto, 10) + pad(s.inIp + ":" + s.inPort, 22) +
          pad(s.outIp + ":" + s.outPort, 20) + pad(s.dstIp, 16) +
          pad(s.status, 9) + fmtAging(s.aging));
      });
      api.say("-------------------------------------------------------------------------------------", "dim");
      api.say("// ICMP 没有端口，这里用 Identifier 充当会话键；TCP 默认老化 24h、UDP 300s、ICMP 60s。", "op");
      api.tab("session");
    }
  },
  {
    id: "display-nat-outbound", match: /^display nat outbound$/, view: null, kind: "doc",
    usage: "display nat outbound",
    doc: "这张表回答：<b>转换动作挂在哪个接口、引用哪个 ACL</b>。必须挂在流量真正离开设备的那个接口上，否则配置存在也不生效。",
    run(api){
      const list = api.S.R1.nat.outbound;
      api.say("NAT Outbound Information:");
      api.say("  Total : " + list.length, "dim");
      api.say("------------------------------------------------------------------------", "dim");
      api.say(pad("Interface", 32) + pad("Acl", 7) + pad("Address", 18) + "Type", "dim");
      api.say("------------------------------------------------------------------------", "dim");
      if(!list.length){
        api.say("  (没有配置 nat outbound)", "dim");
      }
      list.forEach(function(o){
        const addr = api.S.R1.ports[o.iface] ? api.S.R1.ports[o.iface].ip : "—";
        api.say(pad("GigabitEthernet" + o.iface.slice(2), 32) + pad(o.acl, 7) + pad(addr, 18) + "Easy IP");
      });
      api.say("------------------------------------------------------------------------", "dim");
      if(list.some(function(o){ return o.iface === "GE0/0/0"; })){
        api.say("// 注意：GE0/0/0 是内网口，流量只会从这里进入设备。挂在这里的 nat outbound 不会被出方向执行。", "op");
      }
      api.tab("nat");
    }
  },
  {
    id: "display-acl", match: /^display acl (\d+)$/, view: null, kind: "doc",
    usage: "display acl 2000",
    doc: "这张表回答：<b>哪些源地址会被转换、每条规则命中多少次</b>。NAT 的 ACL 与包过滤的 ACL 语义不同：这里未命中 = 不转换，不是丢包。",
    run(api, m){
      const id = parseInt(m[1], 10);
      const acl = api.S.R1.acl[id];
      if(!acl){
        api.say("Error: The ACL does not exist.", "err");
        api.say("      还没有建 ACL " + id + "。", "dim");
        return;
      }
      const rs = aclRules(api.S, id);
      api.say("Basic ACL " + id + ", " + rs.length + " rule" + (rs.length === 1 ? "" : "s"));
      api.say("Acl's step is 5", "dim");
      rs.forEach(function(r){
        api.say(" rule " + r.id + " " + ruleText(r) + " (match-counter " + (api.S.R1.hits[r.id] || 0) + ")");
      });
      if(!rs.length) api.say(" (空表：没有任何源地址命中 permit → 一条也不转换)", "dim");
      api.tab("acl");
    }
  },
  {
    id: "display-route", match: /^display ip routing-table$/, view: null, kind: "doc",
    usage: "display ip routing-table",
    doc: "先有路，才谈得上转换。默认路由 0.0.0.0/0 让 R1 能找到任何外网目的地的出口；NAT 只在出接口确定之后才执行。",
    run(api){
      const list = routesOf(api.S).filter(function(rt){ return rt.active; });
      api.say("Route Flags: R - relay, D - download to fib", "dim");
      api.say("------------------------------------------------------------------------------", "dim");
      api.say("Routing Tables: Public", "dim");
      api.say("         Destinations : " + list.length + "        Routes : " + list.length, "dim");
      api.say("", "dim");
      api.say(pad("Destination/Mask", 20) + pad("Proto", 8) + padL("Pre", 5) + padL("Cost", 5) + " " +
        pad("Flags", 6) + pad("NextHop", 17) + "Interface", "dim");
      api.say("------------------------------------------------------------------------------", "dim");
      if(!list.length) api.say("// 路由表为空。", "op");
      list.forEach(function(rt){
        api.say(pad(rt.dest + "/" + rt.mask, 20) + pad(rt.proto, 8) + padL(rt.pre, 5) + padL(0, 5) + " " +
          pad(rt.proto === "Static" ? "RD" : "D", 6) + pad(rt.nextHop, 17) +
          (rt.iface === "—" ? "—" : "GigabitEthernet" + rt.iface.slice(2)));
      });
      api.tab("route");
      if(!hasDefault(api.S)) api.say("// 没有默认路由：内网访问任意外网地址都会在 R1 查表失败。", "op");
    }
  },
  {
    id: "display-ip-brief", match: /^display ip interface brief$/, view: null, kind: "doc",
    usage: "display ip interface brief",
    doc: "接口地址与三层状态。两个接口一内一外；NAT 只会发生在朝外的那个方向上。",
    run(api){
      const r = api.S.R1;
      api.say(pad("Interface", 34) + pad("IP Address/Mask", 21) + pad("Physical", 11) + "Protocol", "dim");
      api.say("--------------------------------------------------------------------------------", "dim");
      Object.keys(r.ports).forEach(function(pn){
        const p = r.ports[pn];
        api.say(pad("GigabitEthernet" + pn.slice(2), 34) +
          pad(p.ip ? p.ip + "/" + p.mask : "unassigned", 21) +
          pad(p.up ? "up" : "*down", 11) +
          (p.up && p.ip ? "up" : "down"));
      });
    }
  },
  {
    id: "ping", match: /^ping ([\d.]+)$/, view: null, kind: "test", usage: "ping <202.1.1.1>",
    run(api, m){
      const dst = m[1];
      if(ipToInt(dst) === null){
        api.say("Error: Wrong parameter found at '^' position.", "err");
        return;
      }
      if(dst === "200.1.1.1" || dst === "192.168.1.1"){
        pingOut(api, dst, true, 255);
        api.say("// 目的地址就是 R1 自己的接口地址，本机直接应答，不查路由、也不经过 NAT。", "op");
        return;
      }
      const rt = lookup(api.S, dst);
      if(!rt){
        pingOut(api, dst, false);
        api.say("// R1 的路由表里没有能匹配 " + dst + " 的表项，ICMP 在查表这一步就被丢弃。", "op");
        api.tab("route");
        return;
      }
      pingOut(api, dst, true, 254);
      if(rt.proto === "Local"){
        api.say("// 目的是本机地址，直接上送 CPU。", "op");
      }else{
        api.say("// 命中 " + rt.proto + " 路由 " + rt.dest + "/" + rt.mask + "，下一跳 " + rt.nextHop +
          "，出接口 " + rt.iface + "。", "op");
        if(rt.proto === "Static" && rt.mask === 0){
          api.say("// 源地址是 R1 自己的 " + api.S.R1.ports[rt.iface].ip +
            "，本身就是公网地址，回程不需要任何转换 —— 这就是「R1 能通、PC 不通」的原因。", "op");
        }
      }
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

/* ---------------- 表项 ---------------- */
function tables(S, tab, ctx){
  const r = S.R1;

  if(tab === "session"){
    const list = r.session.slice().sort(function(a, b){ return a.outPort - b.outPort; });
    let note = "NAT 的全部记忆都在这一张表：回程报文靠它反查该还给谁。TCP 默认 24h、UDP 300s、ICMP 60s。简化：老化按固定时长展示，不模拟 TCP 状态机与 ALG（FTP/SIP 等）。";
    if(list.length && !natOutboundOf(S, "GE0/0/1")){
      note = "出接口上已经没有 nat outbound，但表里还留着 " + list.length +
        " 条历史会话 —— 新报文不会被转换。真实设备上这些旧条目会继续转换到老化，本实验按「没有动作就不转换」简化。";
    }
    return {
      head: ["PROTOCOL", "内网源", "公网源", "目的", "状态", "剩余时间"],
      rows: list.map(function(s){
        return {
          key: "nat-" + s.id,
          cells: [
            { t: s.proto, cls: "c" },
            { t: s.inIp + ":" + s.inPort, cls: "c" },
            { t: s.outIp + ":" + s.outPort, cls: "v10" },
            { t: s.dstIp, cls: "c" },
            { t: s.status, cls: "ok" },
            { t: fmtAging(s.aging), cls: "c" }
          ]
        };
      }),
      empty: "会话表为空 · 还没有一条被 NAT 转换的连接",
      note: note
    };
  }

  if(tab === "nat"){
    const rows = ["GE0/0/0", "GE0/0/1"].map(function(pn){
      const ob = natOutboundOf(S, pn);
      let note, cls;
      if(!ob){
        note = pn === "GE0/0/1" ? "未配置 · 出方向没有转换动作" : "未配置";
        cls = "dim";
      }else if(pn === "GE0/0/1"){
        note = "生效中 · 流量从此外发";
        cls = "v10";
      }else{
        note = "不生效 · 报文从这里进入，不会从这里出去";
        cls = "bad";
      }
      return {
        key: "nat-app-" + pn,
        cells: [
          { t: pn, cls: "c" },
          { t: ob ? "outbound" : "—", cls: ob ? "c" : "dim" },
          { t: ob ? ob.acl : "—", cls: "c" },
          { t: note, cls: cls }
        ]
      };
    });
    let note = "nat outbound 是动作，挂在「流量离开设备」的接口上。挂在入口接口上配置合法，但永远不会被执行。";
    if(hasDefault(S) && !natOutboundOf(S, "GE0/0/1") && !natOutboundOf(S, "GE0/0/0")){
      note = "还没有任何 nat outbound。内网报文会带着私网源地址直接出公网，回程在 ISP 就被丢掉。";
    }
    return {
      head: ["接口", "方向", "ACL", "状态"],
      rows: rows,
      note: note
    };
  }

  if(tab === "acl"){
    const acl = r.acl[ACL_ID];
    const rs = aclRules(S, ACL_ID);
    const onWan = !!natOutboundOf(S, "GE0/0/1");
    const onLan = !!natOutboundOf(S, "GE0/0/0");
    const rows = rs.map(function(rule, i){
      let note;
      if(rule.action === "deny") note = "命中即不转换（报文照常发出）";
      else if(!onWan && !onLan) note = "NAT 未绑定：规则永远不会被调用";
      else if(onLan && !onWan) note = "绑在内网口：出方向不经过它，规则空转";
      else note = i === 0 ? "最先被查：命中即转换" : "排在后面，只兜底没被 permit 的流量";
      return {
        key: "rule-" + rule.id,
        cells: [
          { t: rule.id, cls: "c" },
          { t: rule.action, cls: rule.action === "deny" ? "v20" : "v10" },
          { t: rule.src, cls: "c" },
          { t: rule.wild, cls: "c" },
          { t: S.R1.hits[rule.id] || 0, cls: "c" },
          { t: note, cls: "c" }
        ]
      };
    });
    if(rows.length){
      rows.push({
        key: "rule-default",
        cells: [
          { t: "default", cls: "c" },
          { t: "不转换", cls: "dim" },
          { t: "any", cls: "c" },
          { t: "—", cls: "dim" },
          { t: "—", cls: "dim" },
          { t: "未命中任何 permit → 不做 NAT，不是丢包", cls: "dim" }
        ]
      });
    }
    return {
      head: ["RULE", "ACTION", "SOURCE", "通配符", "命中", "判读"],
      rows: rows,
      empty: acl ? "ACL 2000 里还没有规则 · 空表 = 一条也不转换" : "还没有 ACL · 执行 acl 2000 建条件表",
      note: "按 rule id 升序首次匹配。NAT 与包过滤的区别：这里只有 permit 才转换，未命中只是「不转换」，报文仍然转发。"
    };
  }

  /* route */
  const list = routesOf(S).filter(function(rt){ return rt.active; });
  return {
    head: ["DESTINATION/MASK", "PROTO", "PRE", "NEXTHOP", "INTERFACE", "判读"],
    rows: list.map(function(rt){
      let note;
      if(rt.proto === "Static") note = rt.mask === 0 ? "默认路由：查不到的都走它" : "静态路由";
      else if(rt.proto === "Local") note = "本机 /32 · 直接上送 CPU";
      else note = rt.dest === "192.168.1.0" ? "内网直连" : "外网直连";
      return {
        key: routeKey(rt),
        cells: [
          { t: rt.dest + "/" + rt.mask, cls: "c" },
          { t: rt.proto, cls: rt.proto === "Static" ? "v10" : (rt.proto === "Local" ? "dim" : "ok") },
          { t: rt.pre, cls: "c" },
          { t: rt.nextHop, cls: "c" },
          { t: rt.iface, cls: "c" },
          { t: note, cls: "c" }
        ]
      };
    }),
    empty: "路由表为空",
    note: "最长前缀匹配：192.168.1.10 命中直连 /24；202.1.1.1 只能落到默认 0.0.0.0/0。NAT 会话不参与查表，它只在出接口确定之后才被执行。"
  };
}

/* ---------------- 拓扑 ---------------- */
function portColor(p){
  if(!p.up) return "#7E93AB";
  return p.ip ? "#38E1FF" : "#FFB545";
}

function natSummary(S){
  const ob = natOutboundOf(S, "GE0/0/1");
  if(ob) return "NAT acl " + ob.acl + " · " + S.R1.session.length + " session";
  if(natOutboundOf(S, "GE0/0/0")) return "NAT 挂错口 · 不生效";
  return "未做 NAT";
}

function topology(S, ui, ctx){
  const devices = ["SW1", "R1"].map(function(id){
    const d = DEV[id], r = id === "R1" ? S.R1 : null;
    const ports = Object.keys(d.portX).map(function(pn){
      if(id === "SW1"){
        const toHost = pn === "GE0/0/1" ? "#38E1FF" : pn === "GE0/0/2" ? "#FFB545" : "#38E1FF";
        return { name: pn, kind: "rj45", x: d.portX[pn], y: 44, color: toHost, up: true, label: pn.slice(-2) };
      }
      const p = r.ports[pn];
      return {
        name: pn, kind: "rj45", x: d.portX[pn], y: 44,
        color: pn === "GE0/0/1" ? "#FFB545" : portColor(p), up: p.up, label: pn.slice(-1)
      };
    });
    const leds = id === "SW1"
      ? [
          { x: 216, y: 10, color: "#35E08A", glow: true, label: "PWR", tx: 222, ty: 12.5 },
          { x: 202, y: 10, color: "#38E1FF", glow: true, label: "SYS", tx: 176, ty: 12.5 }
        ]
      : [
          { x: 272, y: 10, color: "#35E08A", glow: true, label: "PWR", tx: 278, ty: 12.5 },
          { x: 258, y: 10, color: "#38E1FF", glow: true, label: "SYS", tx: 232, ty: 12.5 }
        ];
    return {
      id: id, x: d.x, y: d.y, w: d.w, h: d.h,
      model: id === "SW1" ? "S5700-28C-EI" : "AR2220",
      silk: "M12 24 h60 M12 28 h44 M12 32 h60 M12 36 h44",
      leds: leds,
      ports: ports,
      tags: [
        { x: 0, y: -8, text: id, cls: "dev-label" },
        {
          x: 34, y: -8,
          text: id === "SW1" ? "S5700 · 二层接入" : "边界路由器 · " + natSummary(S),
          cls: "dev-sub"
        }
      ]
    };
  });

  const hosts = ["PC1", "PC2", "SRV"].map(function(k){
    const h = HOSTS[k];
    return {
      id: h.id, x: h.x, y: 200, ip: h.ip, mac: h.mac,
      vlan: h.vlan, color: h.color, up: true
    };
  });

  const natOnWan = !!natOutboundOf(S, "GE0/0/1");
  const routeOk = hasDefault(S);
  const wanFlow = !routeOk ? 0 : (natOnWan ? (S.R1.session.length ? 0.8 : 0.42) : 0);
  const wanColor = routeOk && natOnWan ? "56,225,255" : "255,77,94";

  const links = [
    { id: "lk-pc1", d: ROUTES["pc1-down"], cls: "", flow: 0.42, flowColor: "56,225,255" },
    { id: "lk-pc2", d: ROUTES["pc2-down"], cls: "", flow: 0.42, flowColor: "255,181,69" },
    { id: "lk-sw", d: ROUTES["sw-up"], cls: "", flow: 0.42, flowColor: "56,225,255" },
    { id: "lk-wan", d: ROUTES["wan-up"], cls: "", flow: wanFlow, flowColor: wanColor }
  ];

  const anchors = {
    "SW1/GE0/0/1": [DEV.SW1.x + DEV.SW1.portX["GE0/0/1"], DEV.SW1.y + 44],
    "SW1/GE0/0/2": [DEV.SW1.x + DEV.SW1.portX["GE0/0/2"], DEV.SW1.y + 44],
    "SW1/GE0/0/24": [DEV.SW1.x + DEV.SW1.portX["GE0/0/24"], DEV.SW1.y + 44],
    "R1/GE0/0/0": [DEV.R1.x + DEV.R1.portX["GE0/0/0"], DEV.R1.y + 44],
    "R1/GE0/0/1": [DEV.R1.x + DEV.R1.portX["GE0/0/1"], DEV.R1.y + 44]
  };

  let wanTag, wanCls;
  if(!routeOk){
    wanTag = "默认路由缺失 · 出不去";
    wanCls = "lk-tag bad";
  }else if(natOutboundOf(S, "GE0/0/0")){
    wanTag = "nat 挂在内网口 · 不生效";
    wanCls = "lk-tag warn";
  }else if(!natOnWan){
    wanTag = "未做 NAT · 私网源出不去";
    wanCls = "lk-tag bad";
  }else if(!S.R1.session.length){
    wanTag = "Easy IP 就绪 · 尚无会话";
    wanCls = "lk-tag on";
  }else{
    wanTag = "Easy IP · " + S.R1.session.length + " 条会话";
    wanCls = "lk-tag on";
  }

  const labels = [
    { text: "192.168.1.0/24 · 内网", x: 196, y: 176, anchor: "start", cls: "lk-tag on" },
    { text: "200.1.1.0/24 · 外网", x: 900, y: 172, anchor: "start", cls: "lk-tag on" },
    { text: wanTag, x: 900, y: 188, anchor: "start", cls: wanCls },
    { text: "INTERNET · 公网", x: 1058, y: 178, anchor: "middle", cls: "lk-tag" }
  ];

  return { viewBox: "0 0 1400 320", devices: devices, hosts: hosts, links: links, routes: ROUTES, anchors: anchors, labels: labels };
}

/* ---------------- 数据面场景 ---------------- */
export function natScene(S, from){
  const A = HOSTS[from] || HOSTS.PC1;
  const B = HOSTS.SRV;
  const egress = "GE0/0/1";
  const ob = natOutboundOf(S, egress);
  const aclRes = ob ? aclMatch(S, ob.acl, A.ip) : null;
  const natReady = !!(ob && aclRes && aclRes.action === "permit");
  const rt = lookup(S, B.ip);
  const kUp = A.id === "PC1" ? "pc1-up" : "pc2-up";
  const kDown = A.id === "PC1" ? "pc1-down" : "pc2-down";

  const sc = {
    name: A.id + " " + A.ip + " → " + B.ip,
    realSec: 5.2,
    dur: 1,
    traceTitle: "逐跳判读",
    frames: [],
    trace: [],
    drop: null,
    verdict: null
  };

  sc.frames.push({ route: kUp, t0: 0, t1: .14, kind: "data", color: A.color });
  sc.trace.push({
    h: "① 源主机判路",
    p: A.ip + "/24 访问 " + B.ip + "，目的不在本网段，交给默认网关 " + A.gw +
      "。此刻源地址还是私网 " + A.ip + ":" + A.sport + "。",
    cls: ""
  });

  sc.frames.push({ route: "sw-up", t0: .16, t1: .34, kind: "data", color: A.color });
  sc.trace.push({
    h: "② SW1 二层转发",
    p: "SW1 只查 MAC 表，把帧从接入口转到上联口，IP 一个字节都不碰。真正的三层处理在 R1。",
    cls: ""
  });

  if(!rt){
    sc.frames.push({ route: "r1-thru", t0: .36, t1: .5, kind: "data", color: A.color });
    sc.drop = { route: "r1-thru", p: .55, at: .5, label: "NO ROUTE · 0.0.0.0/0" };
    sc.trace.push({
      h: "③ R1 查表 · 无匹配",
      p: "路由表里只有两个直连 /24 和两个本机 /32，没有能覆盖 202.1.1.1 的表项。报文在 R1 内部被丢弃，根本没机会走到 NAT。",
      cls: "drop"
    });
    sc.verdict = {
      bad: true,
      text: "不通的原因不是 NAT，而是没有默认路由。先补 0.0.0.0/0，否则 NAT 连执行的机会都没有。"
    };
    return sc;
  }

  sc.frames.push({ route: "r1-thru", t0: .36, t1: .52, kind: "data", color: A.color });
  sc.trace.push({
    h: "③ R1 查表 · 命中默认路由",
    p: "202.1.1.1 不匹配任何直连网段，落到 " + (rt.mask === 0 ? "0.0.0.0/0" : rt.dest + "/" + rt.mask) +
      "（" + rt.proto + "），下一跳 " + rt.nextHop + "，出接口 " + rt.iface + "。",
    cls: ""
  });

  /* ---- 出方向没有可执行的 NAT 动作 ---- */
  if(!natReady){
    let why;
    if(!ob && natOutboundOf(S, "GE0/0/0")){
      why = "GE0/0/0 上确实配了 nat outbound " + natOutboundOf(S, "GE0/0/0").acl +
        "，但那是<b>内网口</b>：报文从它进入设备，出方向是 GE0/0/1，那里没有动作。";
    }else if(!ob){
      why = "GE0/0/1 上没有 nat outbound。私网源地址会原样带出公网。";
    }else if(aclRes && aclRes.noAcl){
      why = "nat outbound 引用了 ACL " + ob.acl + "，但这张表不存在 → 没有任何 permit → 不转换。";
    }else if(aclRes && aclRes.action === "deny"){
      why = "ACL " + ob.acl + " 命中 rule " + aclRes.rule.id + " deny → 明确不做转换。";
    }else{
      why = "ACL " + ob.acl + " 里没有能匹配 " + A.ip + " 的 permit 规则 → 不转换。";
    }
    sc.frames.push({ route: "wan-up", t0: .54, t1: .74, kind: "data", color: A.color });
    sc.trace.push({
      h: "④ 出方向 · 没有转换",
      p: why + "报文带着源 <b>" + A.ip + ":" + A.sport + "</b> 直接上了公网。",
      cls: "drop"
    });
    sc.trace.push({
      h: "⑤ 服务器回包",
      p: "服务器只看到 " + A.ip + "，回包目的就是它。可这是私网地址 —— 公网路由表里没有 192.168.1.0/24，回程在 ISP 侧就被丢弃。",
      cls: "drop"
    });
    sc.frames.push({ route: "wan-down", t0: .76, t1: .84, kind: "data", color: B.color });
    sc.drop = { route: "wan-down", p: .22, at: .8, label: "NO NAT SESSION · 回程无处可去" };
    sc.verdict = {
      bad: true,
      text: "去程出得去，回程回不来。NAT 的全部意义就是让公网只看到 200.1.1.1，并由会话表把回包还给 " + A.ip + "。"
    };
    return sc;
  }

  /* ---- 真正建立/复用会话 ---- */
  const sess = ensureSession(S, A, B.ip);
  if(aclRes.rule){
    S.R1.hits[aclRes.rule.id] = (S.R1.hits[aclRes.rule.id] || 0) + 1;
  }

  sc.trace.push({
    h: "④ 出方向 · 执行转换（关键一步）",
    p: "GE0/0/1 挂着 nat outbound " + ob.acl + "；ACL " + ob.acl + " 首条命中 " +
      (aclRes.rule ? "rule " + aclRes.rule.id + " permit" : "permit") + "。报文离开这个接口的瞬间被改写：" +
      "<b>" + A.ip + ":" + A.sport + " → " + sess.outIp + ":" + sess.outPort + "</b>，同时写入一条会话。",
    cls: ""
  });

  sc.frames.push({ route: "wan-up", t0: .54, t1: .72, kind: "data", color: "#35E08A" });
  sc.trace.push({
    h: "⑤ 服务器收到请求",
    p: "服务器看到的是 " + sess.outIp + ":" + sess.outPort + "，完全不知道 192.168.1.0/24 的存在。回包：源 " +
      B.ip + "、目的 <b>" + sess.outIp + ":" + sess.outPort + "</b>。",
    cls: ""
  });

  sc.frames.push({ route: "wan-down", t0: .74, t1: .85, kind: "data", color: B.color });
  sc.trace.push({
    h: "⑥ 回程 · 反查会话表",
    p: "R1 从 GE0/0/1 收到目的 " + sess.outIp + ":" + sess.outPort + " 的包。这个地址是 R1 自己的，光看它无法知道该给谁；" +
      "查会话表得到 " + sess.inIp + ":" + sess.inPort + "，改写目的地址后从 GE0/0/0 送出。回程不经过 ACL，只认这张表。",
    cls: ""
  });

  sc.frames.push({ route: "r1-back", t0: .86, t1: .9, kind: "data", color: A.color });
  sc.frames.push({ route: "sw-down", t0: .9, t1: .96, kind: "data", color: A.color });
  sc.frames.push({ route: kDown, t0: .96, t1: 1, kind: "data", color: A.color });
  sc.trace.push({
    h: "⑦ 回到源主机",
    p: "PC 收到源 " + B.ip + "、目的 " + A.ip + " 的 Echo Reply。往返成立 —— 中间经历了两次地址改写，主机对此一无所知。",
    cls: "pass"
  });

  if(S.R1.session.length > 1){
    const pairs = S.R1.session.slice().sort(function(a, b){ return a.outPort - b.outPort; })
      .map(sessionLine).join("；");
    sc.trace.push({
      h: "⑧ 端口复用",
      p: "会话表现在有 " + S.R1.session.length + " 条：" + pairs +
        "。公网地址只有一个 " + sess.outIp + "，靠不同的公网端口区分不同内网会话 —— 这就是 NAPT。",
      cls: "pass"
    });
  }

  sc.verdict = {
    bad: false,
    text: "通。转换只发生在 R1 出 GE0/0/1 的那一瞬间：去程改写源地址与端口，回程按会话表改写目的地址。" +
      (S.R1.session.length > 1 ? " 一个公网 IP 同时承载 " + S.R1.session.length + " 条会话。" : "")
  };
  return sc;
}

/* 内网到网关：用来确认「内网这一段是好的」，把故障范围锁在 R1 的出网方向 */
export function gatewayScene(S, from){
  const A = HOSTS[from] || HOSTS.PC1;
  const kUp = A.id === "PC1" ? "pc1-up" : "pc2-up";
  const kDown = A.id === "PC1" ? "pc1-down" : "pc2-down";
  return {
    name: A.id + " → 网关 " + A.gw,
    realSec: 2.2,
    dur: 1,
    traceTitle: "逐跳判读",
    frames: [
      { route: kUp, t0: 0, t1: .45, kind: "data", color: A.color },
      { route: kDown, t0: .55, t1: 1, kind: "data", color: "#38E1FF" }
    ],
    trace: [
      {
        h: "① 同网段直达",
        p: A.ip + " 与 " + A.gw + " 都在 192.168.1.0/24。PC 先 ARP 解析到 R1 的 GE0/0/0 MAC，帧直接送过去，不需要网关再转发。",
        cls: ""
      },
      {
        h: "② R1 本机应答",
        p: "目的是 R1 自己的接口地址，报文直接上送 CPU 回复，不查路由表、不经过 NAT。",
        cls: ""
      },
      {
        h: "③ 基线结论",
        p: "内网这一段是好的：接口 up、地址对、二层可达。等会儿 ping 外网不通，问题一定在 R1 的出网方向。",
        cls: "pass"
      }
    ],
    drop: null,
    verdict: { bad: false, text: "通。先确认内网没问题，才能把排障范围收窄到「默认路由 / NAT」这两件事上。" }
  };
}

export function outsideScene(S, dst){
  const B = HOSTS.SRV;
  const sc = {
    name: "外网 " + B.ip + " → " + dst,
    realSec: 4.2,
    dur: 1,
    traceTitle: "逐跳判读",
    frames: [],
    trace: [],
    drop: null,
    verdict: null
  };

  if(dst === "200.1.1.1"){
    sc.frames.push({ route: "wan-down", t0: 0, t1: .45, kind: "data", color: "#35E08A" });
    sc.trace.push({
      h: "① 外网主机判路",
      p: B.ip + " 访问 200.1.1.1，不在本网段，交给自己的网关，最终由 ISP 送到 R1 的 GE0/0/1。",
      cls: ""
    });
    sc.trace.push({
      h: "② 到达 R1 · 目的是本机地址",
      p: "200.1.1.1 就是 R1 出接口的地址。报文直接上送 CPU 处理，不查转发表，也不查 NAT 会话。",
      cls: ""
    });
    sc.frames.push({ route: "wan-up", t0: .55, t1: 1, kind: "data", color: "#38E1FF" });
    sc.trace.push({
      h: "③ 本机直接应答",
      p: "ICMP Echo Reply 从 200.1.1.1 发回。整个过程中 NAT 完全没有参与 —— 访问路由器自己的地址，和访问内网主机是两件事。",
      cls: "pass"
    });
    sc.verdict = {
      bad: false,
      text: "通。ping 的是 R1 自己的公网接口地址，属于本机处理，不需要任何会话或映射。"
    };
    return sc;
  }

  sc.frames.push({ route: "wan-down", t0: 0, t1: .26, kind: "data", color: "#35E08A" });
  sc.drop = { route: "wan-down", p: .26, at: .3, label: "NO ROUTE · 192.168.1.0/24" };
  sc.trace.push({
    h: "① 外网主机查表",
    p: B.ip + " 要去 " + dst + "，本网段只有 202.1.1.0/24，只能交给默认网关（ISP）。",
    cls: ""
  });
  sc.trace.push({
    h: "② 公网没有私网路由",
    p: "192.168.1.0/24 是私网地址，ISP 的路由表里不存在，报文在公网侧就被丢弃，根本到不了 R1。",
    cls: "drop"
  });
  sc.trace.push({
    h: "③ 就算送到 R1 也没用",
    p: "nat outbound 只建立「内 → 外」的映射，不会为外部主动访问开放入口。R1 上没有任何一条指向 " + dst +
      " 的会话，无法判断该交给哪台内网主机。",
    cls: "drop"
  });
  sc.trace.push({
    h: "④ 正确做法",
    p: "要允许外部访问内网，必须配置 nat server（静态一对一或端口映射），把某个公网地址/端口固定指向某台内网主机。nat outbound 永远解决不了入向访问。",
    cls: ""
  });
  sc.verdict = {
    bad: true,
    text: "不通。NAT 是单向的：出方向做地址转换，入方向需要 nat server 显式开放。"
  };
  return sc;
}

/* ---------------- 引导 ---------------- */
function guide(S, ctx){
  const G = function(phase, why, cmd){ return { phase: phase, why: why, cmd: cmd || "" }; };

  if(ctx.view === "acl"){
    const acl = S.R1.acl[ctx.aclId || ACL_ID];
    if(!acl) return G("acl", "ACL 已经不在了，quit 回系统视图重建。", "quit");
    if(!acl.rules.length)
      return G("rule", "规则表是空的。在 NAT 里空表等于「谁都不转换」。先 permit 内网网段。", "rule permit source 192.168.1.0 0.0.0.255");
    if(!aclHasPermit(S))
      return G("rule", "表里只有 deny，没有任何源地址会被转换。补一条 permit。", "rule permit source 192.168.1.0 0.0.0.255");
    return G("nat", "条件齐了。quit 出去，把这张表绑到出方向接口上才会真的转换。", "quit");
  }

  if(ctx.view === "if"){
    const pn = portKey(ctx);
    if(!S.R1.ports[pn]) return G("nat", "接口不存在，quit 退出去。", "quit");
    const ob = natOutboundOf(S, pn);
    if(pn === "GE0/0/1"){
      if(!S.R1.acl[ACL_ID] || !aclHasPermit(S))
        return G("acl", "ACL 2000 还没有可用的 permit 规则，nat outbound 没有条件可引用。先 quit 回系统视图补规则。", "quit");
      if(!ob) return G("nat", "GE0/0/1 是流量离开设备的那一侧，NAT 动作必须挂在这里。", "nat outbound " + ACL_ID);
      return G("verify", "GE0/0/1 的 outbound 已绑定 ACL " + ob.acl + "。quit 出去跑一次 PC1 → 202.1.1.1。", "quit");
    }
    if(pn === "GE0/0/0"){
      if(ob) return G("nat", "这里是内网口，报文只会从这里进入设备。nat outbound 挂在这里等于没有动作，删掉。", "undo nat outbound " + ob.acl);
      return G("nat", "GE0/0/0 只负责收内网流量。NAT 要配在出口 GE0/0/1 上，quit 出去。", "quit");
    }
  }

  if(ctx.view === "system"){
    if(!hasDefault(S))
      return G("route", "路由表里没有默认路由，PC1 的包在 R1 就查不到出口。先解决「有没有路」，别急着怀疑 NAT。", "ip route-static 0.0.0.0 0 200.1.1.254");
    if(!S.R1.acl[ACL_ID]) return G("acl", "有了默认路由，R1 自己能出网；但内网主机的私网源地址还需要 NAT。第一步：建条件表。", "acl " + ACL_ID);
    if(!aclHasPermit(S)) return G("acl", "ACL 2000 还没有 permit 规则，谁都不会被转换。进去补一条。", "acl " + ACL_ID);
    const wrong = natOutboundOf(S, "GE0/0/0");
    if(wrong) return G("nat", "nat outbound " + wrong.acl + " 挂在内网口 GE0/0/0 上，出方向不经过它，等于没配。进接口删掉。", "interface GigabitEthernet 0/0/0");
    if(!natOutboundOf(S, "GE0/0/1"))
      return G("nat", "条件有了，还差动作：进外网口把 ACL 2000 绑到 outbound 上。", "interface GigabitEthernet 0/0/1");
    if(!S.R1.session.length)
      return G("verify", "配置齐了，但会话表还是空的 —— NAT 只在有流量时才建表。点右下角「PC1 → 202.1.1.1」跑一次。", "");
    return G("verify", "会话表已有 " + S.R1.session.length + " 条。display nat session all 对照内外网地址与端口，再和 display nat outbound / display acl 2000 交叉核对。", "display nat session all");
  }

  return G("enter", "<" + ctx.dev + "> 是用户视图，只能看。改配置先 system-view。", "system-view");
}

/* ---------------- 板块 ---------------- */
const steps = [
  {
    id: 1, name: "基线 · 内网通、外网不通", keepTrace: true,
    run: async function(api){
      api.setDev("R1");
      await api.run(["display ip interface brief", "display ip routing-table"]);
      api.play(natScene(api.S, "PC1"));
    },
    summary: "PC1 能通网关，ping 202.1.1.1 超时 —— 因为 R1 没有默认路由，和 NAT 还没关系",
    detail: [
      { h: "先看到什么", p: "display ip interface brief：GE0/0/0 是 192.168.1.1/24、GE0/0/1 是 200.1.1.1/24，都 up。路由表里只有两个直连 /24 和两个本机 /32。" },
      { h: "为什么不通", p: "PC1 的目的 202.1.1.1 不匹配任何直连网段，R1 查表失败，报文在 R1 内部就被丢弃。<b>此时还没有 NAT，但问题不在 NAT。</b>点右下角「PC1 → 网关」可以单独确认内网这一段是通的。" },
      { h: "排障顺序", p: "先确认有没有路（路由表），再确认地址换不换（NAT 会话表）。连出接口都选不出来时，讨论 NAT 毫无意义。" }
    ]
  },
  {
    id: 2, name: "默认路由 · R1 出得去，PC 出不去", keepTrace: true,
    done: function(S){ return hasDefault(S); },
    run: async function(api){
      api.setDev("R1");
      await api.run([
        "system-view",
        "ip route-static 0.0.0.0 0 200.1.1.254",
        "quit",
        "display ip routing-table",
        "ping 202.1.1.1"
      ]);
      api.play(natScene(api.S, "PC1"));
    },
    summary: "R1 自己 ping 202.1.1.1 通了；PC1 还是不通 —— 去程出得去，回程没有私网路由",
    detail: [
      { h: "R1 为什么通", p: "R1 的源地址是 200.1.1.1，本身就是公网地址。服务器回包目的 200.1.1.1 在公网可路由，全程没有私网地址，不需要任何转换。" },
      { h: "PC1 为什么不通", p: "去程报文带着源 192.168.1.10 出了公网；服务器回包目的 192.168.1.10 是私网地址，公网没有这条路由，回程在 ISP 侧就被丢掉。" },
      { h: "这正是 NAT 要解决的", p: "私网地址不能在公网出现。要么改写源地址（NAT），要么让公网认识私网网段（不可能）。" }
    ]
  },
  {
    id: 3, name: "建 ACL 2000 · 只有条件", key: false,
    done: function(S){
      const acl = S.R1.acl[ACL_ID];
      return !!(acl && acl.rules.some(function(r){ return r.action === "permit"; }));
    },
    run: async function(api){
      api.setDev("R1");
      await api.run([
        "system-view",
        "acl 2000",
        "rule permit source 192.168.1.0 0.0.0.255",
        "quit"
      ]);
    },
    summary: "ACL 2000 里多了一条 permit，但转发行为一点没变",
    detail: [
      { h: "ACL 在 NAT 里的角色", p: "它不丢包，只回答一个问题：<b>这条流量要不要做地址转换</b>。permit = 转换；deny 或未命中 = 不转换，报文照常转发、源地址不变。" },
      { h: "反掩码", p: "0.0.0.255 表示前 24 位必须一致，匹配 192.168.1.0～192.168.1.255。写成 255.255.255.0 语义完全不同。" },
      { h: "空表不是放通", p: "ACL 2000 存在但没有规则时，没有任何报文命中 permit → 一条也不转换。这和包过滤里「空表默认放通」正好相反。" }
    ]
  },
  {
    id: 4, name: "绑定 nat outbound · 条件接到动作",
    done: function(S){
      const ob = natOutboundOf(S, "GE0/0/1");
      return !!(ob && ob.acl === ACL_ID);
    },
    run: async function(api){
      api.setDev("R1");
      await api.run([
        "system-view",
        "interface GigabitEthernet 0/0/1",
        "nat outbound 2000",
        "quit"
      ]);
    },
    summary: "GE0/0/1 上挂起 nat outbound 2000：ACL 是条件，nat outbound 是动作",
    detail: [
      { h: "谁是动作", p: "nat outbound 在报文离开接口时把源地址换成该接口的地址（Easy IP，不配地址池）。ACL 只负责筛选。" },
      { h: "为什么是出接口", p: "NAT 在<b>流量离开设备的那一侧</b>执行。R1 只有从 GE0/0/1 出去才是去公网，所以绑在这里。" },
      { h: "还没看到效果", p: "配置是静默的，现象要等流量才出现：不跑数据，会话表永远是空的。" }
    ]
  },
  {
    id: 5, name: "第一次转换 · 逐跳", key: true, keepTrace: true,
    done: function(S){
      return S.R1.session.some(function(s){ return s.inIp === HOSTS.PC1.ip; });
    },
    run: function(api){
      api.setDev("R1");
      api.play(natScene(api.S, "PC1"));
    },
    summary: "192.168.1.10:5000 → 200.1.1.1:1024，改写只发生在 R1 出 GE0/0/1 的瞬间",
    detail: [
      { h: "转换点", p: "同一台设备上：报文进 GE0/0/0 时源地址还是私网，出 GE0/0/1 时已经变成公网地址 + 新端口。地址改写只发生在出方向。" },
      { h: "为什么还要改端口", p: "只改 IP 不够：PC1、PC2 都用 5000 端口访问同一台服务器，回包无法区分。端口是会话的第二把钥匙。" },
      { h: "回程靠什么", p: "回程不查 ACL：R1 先拿目的 200.1.1.1:1024 反查会话表，得到 192.168.1.10:5000，改写目的地址后从 GE0/0/0 送回去。" }
    ]
  },
  {
    id: 6, name: "会话表 · NAT 的全部记忆", keepTrace: true,
    run: async function(api){
      api.setDev("R1");
      await api.run(["display nat session all"]);
    },
    summary: "display nat session all 出现第一条：ICMP · 192.168.1.10:5000 ⇄ 200.1.1.1:1024",
    detail: [
      { h: "表里有什么", p: "协议、内网源、公网源、目的、状态、老化时间。回程报文就是靠这张表反查该还给哪台内网主机。" },
      { h: "没有表会怎样", p: "会话表一空（老化或设备重启），这条连接立刻断：新的回包到了 R1，200.1.1.1:1024 就没有对应的主人。" },
      { h: "老化时间", p: "TCP 默认 24 小时，UDP 约 5 分钟，ICMP 只有 1 分钟。本实验按固定时长展示，不模拟 TCP 状态机与 ALG（FTP/SIP 等）。" }
    ]
  },
  {
    id: 7, name: "端口复用 · 一个公网 IP 带整栋楼", key: true, keepTrace: true,
    done: function(S){
      return S.R1.session.some(function(s){ return s.inIp === HOSTS.PC2.ip; });
    },
    run: function(api){
      api.setDev("R1");
      /* 先生成 PC1 的会话（不播放），让端口复用的对照成立 */
      natScene(api.S, "PC1");
      api.play(natScene(api.S, "PC2"));
    },
    summary: "PC2 也访问 202.1.1.1：公网 IP 不变，端口从 1024 变 1025",
    detail: [
      { h: "两组映射", p: "PC1 192.168.1.10:5000 → 200.1.1.1:1024；PC2 192.168.1.11:5000 → 200.1.1.1:1025。内网端口相同没关系，<b>公网端口必须不同</b>。" },
      { h: "为什么叫 NAPT", p: "NAT 只换 IP；NAPT（Network Address <b>Port</b> Translation）连端口一起换。华为的 Easy IP 就是 NAPT。" },
      { h: "上限在哪", p: "一个公网 IP 理论上能带六万多条并发（每协议 65535 个端口）。这就是「一个公网地址带一栋楼」的全部秘密。" }
    ]
  },
  {
    id: 8, name: "反直觉 A · 动作配到内网口", key: true, keepTrace: true,
    done: function(S){
      return !!natOutboundOf(S, "GE0/0/0");
    },
    run: async function(api){
      api.setDev("R1");
      await api.run([
        "system-view",
        "interface GigabitEthernet 0/0/1",
        "undo nat outbound 2000",
        "quit",
        "interface GigabitEthernet 0/0/0",
        "nat outbound 2000",
        "quit"
      ]);
      api.play(natScene(api.S, "PC1"));
    },
    summary: "nat outbound 2000 挂到 GE0/0/0：配置存在、ACL 也命中，却完全不生效",
    detail: [
      { h: "错在哪", p: "NAT 执行在<b>出方向</b>。报文从 GE0/0/0 进入、从 GE0/0/1 离开，动作却挂在 GE0/0/0 上，等于挂在收件的那一侧。" },
      { h: "最容易误判", p: "display nat outbound 里明明有一条 2000，ACL 2000 的 permit 也完好无损，会话表里甚至还留着之前的旧条目 —— 只看这些，很容易以为一切正常。" },
      { h: "判定方法", p: "先问「这个接口是不是流量的出口」，再看有没有 nat outbound。挂错口的配置是合法的，但永远不会被执行。" }
    ]
  },
  {
    id: 9, name: "扰动 · 删动作不删条件", keepTrace: true,
    done: function(S){ return S.R1.nat.outbound.length === 0; },
    run: async function(api){
      api.setDev("R1");
      const lines = ["system-view"];
      if(natOutboundOf(api.S, "GE0/0/0")) lines.push("interface GigabitEthernet 0/0/0", "undo nat outbound 2000", "quit");
      if(natOutboundOf(api.S, "GE0/0/1")) lines.push("interface GigabitEthernet 0/0/1", "undo nat outbound 2000", "quit");
      lines.push("display acl 2000");
      await api.run(lines);
      api.play(natScene(api.S, "PC1"));
    },
    summary: "undo nat outbound 之后立刻不通，ACL 2000 却一条规则都没少",
    detail: [
      { h: "只删了动作", p: "ACL 是条件表，nat outbound 是动作。undo 只摘动作，条件留在设备上，随时可以再挂回去。" },
      { h: "计数停住了", p: "display acl 2000 里 rule 5 还在，但 match-counter 不再增长 —— 没有动作去调用这张表。" },
      { h: "旧会话还在表里", p: "真实设备上已建立的会话会继续转换到老化；本实验简化成「没有动作就不转换」，但表里的旧条目保留，提醒你「表存在 ≠ 功能存在」。" }
    ]
  },
  {
    id: 10, name: "反直觉 B · 外网主动进不来", keepTrace: true,
    run: function(api){
      api.setDev("R1");
      api.play(outsideScene(api.S, "192.168.1.10"));
    },
    summary: "外网 ping 200.1.1.1 能通，ping 192.168.1.10 不通：nat outbound 只开一个方向",
    detail: [
      { h: "200.1.1.1 为什么通", p: "那是 R1 自己的接口地址，报文到达后直接上送 CPU 由本机应答，不查会话表、不做转换。点右下角「外网 → 200.1.1.1」对比。" },
      { h: "192.168.1.10 为什么不通", p: "公网路由表里根本没有 192.168.1.0/24；即便有人把包送到 R1，R1 也没有这条会话，不知道该往哪台主机送。" },
      { h: "怎么才能进", p: "需要 nat server（静态一对一或端口映射），让 200.1.1.1 的某个端口固定指向某台内网主机。nat outbound 永远解决不了入向访问。" }
    ]
  },
  {
    id: 11, name: "校验 · 三张表交叉核对",
    done: function(S){
      const ob = natOutboundOf(S, "GE0/0/1");
      return !!(ob && ob.acl === ACL_ID);
    },
    run: async function(api){
      api.setDev("R1");
      const lines = ["system-view"];
      if(natOutboundOf(api.S, "GE0/0/0")) lines.push("interface GigabitEthernet 0/0/0", "undo nat outbound 2000", "quit");
      lines.push(
        "interface GigabitEthernet 0/0/1",
        "nat outbound 2000",
        "quit",
        "display nat session all",
        "display nat outbound",
        "display acl 2000"
      );
      await api.run(lines);
    },
    summary: "会话数、NAT 应用、ACL 命中三者对上，才算一次完整的验证",
    detail: [
      { h: "display nat session all", p: "看条目数、内外网地址与端口、剩余老化时间。TCP 24h、ICMP 1min —— 短会话老化后回包就会失败。" },
      { h: "display nat outbound", p: "看动作挂在哪个接口。必须挂在流量真正离开的那个接口上，挂错口一切归零。" },
      { h: "display acl 2000", p: "看条件和命中计数。计数涨 = 有流量命中 permit 并做了转换；计数不涨 = 条件没被调用。" },
      { h: "简化声明", p: "会话老化按固定时长模拟，不模拟 TCP 状态机与 ALG（FTP/SIP 等）；不做 nat server 与双向 NAT。" }
    ]
  }
];

/* ---------------- 导出 ---------------- */
export default {
  id: "08",
  title: "NAT / NAPT 转换",
  meta: "HUAWEI AR2220 · VRP V200R005C00",
  stageLabel: "L3 NAT · 1 × AR2220 · 1 × S5700 · 2 × HOST",
  totalSteps: steps.length,
  devices: ["R1"],
  tabs: [
    { key: "session", label: "NAT 会话", hint: "转换表：内外网地址与端口、老化时间" },
    { key: "nat", label: "NAT 应用", hint: "nat outbound 挂在哪个接口" },
    { key: "acl", label: "ACL 2000", hint: "哪些源地址需要转换" },
    { key: "route", label: "路由表", hint: "默认路由与直连" }
  ],
  legend: [
    { c: "#38E1FF", label: "内网 / 已转换流量" },
    { c: "#FFB545", label: "PC2 / 第二条会话" },
    { c: "#35E08A", label: "外网服务器" },
    { c: "#FF4D5E", label: "无路由 / 无会话 · 丢弃" }
  ],
  phases: {
    enter: "进系统视图",
    route: "配默认路由",
    acl: "建 ACL",
    rule: "加规则",
    nat: "绑定 NAT",
    verify: "校验"
  },
  viewName: VIEW_NAME,
  viewHint: VIEW_HINT,
  actions: [
    { id: "pc1gw", label: "PC1 → 网关", run: function(l){ l.playScene(gatewayScene(l.S, "PC1")); } },
    { id: "pc1srv", label: "PC1 → 202.1.1.1", run: function(l){ l.playScene(natScene(l.S, "PC1")); } },
    { id: "pc2srv", label: "PC2 → 202.1.1.1", run: function(l){ l.playScene(natScene(l.S, "PC2")); } },
    { id: "outwan", label: "外网 → 200.1.1.1", run: function(l){ l.playScene(outsideScene(l.S, "200.1.1.1")); } },
    { id: "outpc", label: "外网 → 192.168.1.10", run: function(l){ l.playScene(outsideScene(l.S, "192.168.1.10")); } }
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
      { h: "① 路由", p: "先确认默认路由 0.0.0.0/0 在不在。查不到出口时，NAT 根本不会被调用 —— 很多「NAT 不通」其实是没路由。" },
      { h: "② 条件", p: "ACL 2000 决定谁被转换。NAT 里只有命中 permit 才转换，未命中 = 不转换，不是丢包。" },
      { h: "③ 动作", p: "nat outbound 必须挂在流量<b>离开</b>设备的接口上。挂在内网口配置合法，但永远不会执行。" },
      { h: "④ 记忆", p: "会话表是 NAT 的全部状态：去程改写源、回程按表改写目的。表没了，回程就不知道该给谁。" }
    ]
  },

  viewRows: function(ctx){
    return [
      { h: "<" + ctx.dev + "> 用户视图", p: "只读：display、ping。改配置在这里一律被拒。", cls: ctx.view === "user" ? "pass" : "" },
      { h: "[" + ctx.dev + "] 系统视图", p: "全局入口：interface、ip route-static、acl。", cls: ctx.view === "system" ? "pass" : "" },
      { h: "[" + ctx.dev + "-GigabitEthernet0/0/x] 接口视图", p: "作用域收窄到当前接口：ip address、nat outbound。NAT 动作绑定在这一层。", cls: ctx.view === "if" ? "pass" : "" },
      { h: "[" + ctx.dev + "-acl-basic-2000] ACL 视图", p: "只作用于这张条件表：rule permit source。规则本身不做转换。", cls: ctx.view === "acl" ? "pass" : "" }
    ];
  },

  boot: function(write, printGuide){
    write("Info: 已加载 R1 配置 —— GE0/0/0 192.168.1.1/24 接内网（SW1 → PC1 / PC2），GE0/0/1 200.1.1.1/24 接外网。", "dim");
    write("      当前没有默认路由、没有 ACL、没有 NAT；内网主机网关指向 192.168.1.1。", "dim");
    write("      简化：NAT 会话老化按固定时长模拟，不模拟 TCP 状态机与 ALG（FTP/SIP 等）。", "dim");
    write("", "dim");
    printGuide();
  }
};
