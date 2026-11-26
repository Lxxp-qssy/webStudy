import { pad, padL } from "../lib/util.js";

/* =========================================================================
   实验 04 · VLAN 间路由
   -------------------------------------------------------------------------
   一台三层交换机 SW1，两台 PC 分别落在 VLAN 10 / VLAN 20。
   核心矛盾：VLAN 隔离了广播域，跨网段必须靠三层接口（Vlanif）——
   没有 Vlanif，网关 IP 就没有人回答 ARP；有了 Vlanif，直连路由出现，三层才成立。

   状态（唯一事实来源）：
     vlans / ports       二层：VLAN 表与端口 PVID
     vlanif[vid]         三层：虚拟接口的存在、IP、up 状态
     arp                 网关学到的邻居
     routeTable          完全由 vlanif 派生，不手写
   ========================================================================= */

const VLANS = [10, 20];
const PORTS = ["GE0/0/1", "GE0/0/2"];
const DEV = { x: 550, y: 62, w: 300, h: 74, rjRel: [80, 220] };

const GW = { 10: "192.168.10.1", 20: "192.168.20.1" };
const VIF_MAC = { 10: "5489-98c4-0010", 20: "5489-98c4-0020" };

const HOSTS = {
  PC1: { id: "PC1", port: "GE0/0/1", ip: "192.168.10.10", mask: 24, net: "192.168.10.0", gw: "192.168.10.1", mac: "5489-98a1-0001", vlan: 10, x: 560, y: 200 },
  PC2: { id: "PC2", port: "GE0/0/2", ip: "192.168.20.10", mask: 24, net: "192.168.20.0", gw: "192.168.20.1", mac: "5489-98a1-0002", vlan: 20, x: 840, y: 200 }
};

const VLAN_COLOR = { 1: "#7E93AB", 10: "#38E1FF", 20: "#FFB545" };
const vlanColor = v => VLAN_COLOR[v] || "#7C8B9E";
function hexRgb(h){
  const n = parseInt(h.slice(1), 16);
  return ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255);
}

/* 拓扑几何：一条接入链路一条垂直短线，三层转发画成设备内部的一段弧 */
const ROUTES = {
  "pc1-up":   "M560 196 C560 172 630 162 630 136",
  "pc1-down": "M630 136 C630 162 560 172 560 196",
  "pc2-up":   "M840 196 C840 172 770 162 770 136",
  "pc2-down": "M770 136 C770 162 840 172 840 196",
  "l3-a":     "M630 106 C676 82 724 82 770 106",
  "l3-b":     "M770 106 C724 82 676 82 630 106"
};

/* ---------------- 地址工具 ---------------- */
function ipToInt(ip){
  return String(ip).split(".").reduce((a, b) => (a << 8) + (+b), 0) >>> 0;
}
function intToIp(n){
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}
function maskInt(p){ return p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0; }
function netOf(ip, p){ return intToIp((ipToInt(ip) & maskInt(p)) >>> 0); }
function maskToPrefix(s){
  if(/^\d+$/.test(s)){
    const n = parseInt(s, 10);
    return n >= 8 && n <= 30 ? n : 0;
  }
  const parts = String(s).split(".").map(Number);
  if(parts.length !== 4 || parts.some(x => isNaN(x))) return 0;
  let bits = 0, zero = false;
  for(const b of parts){
    for(let i = 7; i >= 0; i--){
      if(b & (1 << i)){ if(zero) return 0; bits++; }
      else zero = true;
    }
  }
  return bits;
}

/* ---------------- 派生：Vlanif 状态与路由表 ---------------- */
/* Physical：VLAN 存在 + 至少一个 up 的成员口
   Protocol：Physical up + 配了 IP
   直连路由只在 Protocol up 时进表 —— 这就是「配了一半」不通的根源 */
function vlanPortUp(sw, vid){
  return Object.keys(sw.ports).some(function(pn){
    const p = sw.ports[pn];
    return p.up && p.type === "access" && p.pvid === vid;
  });
}

function derivedRoutes(sw){
  const rows = [];
  Object.keys(sw.vlanif).map(Number).sort((a, b) => a - b).forEach(function(v){
    const f = sw.vlanif[v];
    if(!f || !f.exists || !f.ip || !f.up) return;
    rows.push({ dest: netOf(f.ip, f.mask) + "/" + f.mask, proto: "Direct", pre: "0", cost: "0", flags: "D", nexthop: f.ip, iface: "Vlanif" + v, sys: false });
    rows.push({ dest: f.ip + "/32", proto: "Direct", pre: "0", cost: "0", flags: "D", nexthop: "127.0.0.1", iface: "Vlanif" + v, sys: false });
  });
  rows.push({ dest: "127.0.0.0/8", proto: "Direct", pre: "0", cost: "0", flags: "D", nexthop: "127.0.0.1", iface: "InLoopBack0", sys: true });
  rows.push({ dest: "127.0.0.1/32", proto: "Direct", pre: "0", cost: "0", flags: "D", nexthop: "127.0.0.1", iface: "InLoopBack0", sys: true });
  rows.push({ dest: "255.255.255.255/32", proto: "Direct", pre: "0", cost: "0", flags: "D", nexthop: "127.0.0.1", iface: "InLoopBack0", sys: true });
  return rows;
}

function sync(sw){
  Object.keys(sw.vlanif).forEach(function(k){
    const v = Number(k), f = sw.vlanif[v];
    const vlanOk = !!sw.vlans[v];
    const portOk = vlanPortUp(sw, v);
    f.phy = !!(f.exists && vlanOk && portOk);
    f.up = !!(f.phy && f.ip);
  });
  sw.routeTable = derivedRoutes(sw);
}

/* ---------------- 初始状态 ---------------- */
export function createState(){
  const ports = {};
  PORTS.forEach(function(pn){ ports[pn] = { type: "access", pvid: 1, up: true }; });
  const sw = {
    name: "SW1",
    vlans: { 1: { name: "VLAN 0001" } },
    ports: ports,
    vlanif: {
      10: { exists: false, ip: "", mask: 0, up: false, phy: false, ever: false },
      20: { exists: false, ip: "", mask: 0, up: false, phy: false, ever: false }
    },
    arp: [],
    routeTable: []
  };
  sync(sw);
  return { SW1: sw };
}

/* ---------------- 视图 ---------------- */
const VIEW_NAME = { user: "用户视图", system: "系统视图", if: "接口视图", vlanif: "VLANIF 接口视图" };
const VIEW_HINT = { system: "system-view", if: "interface GigabitEthernet 0/0/1", vlanif: "interface Vlanif 10" };

function prompt(ctx){
  if(ctx.view === "user") return "<" + ctx.dev + ">";
  if(ctx.view === "system") return "[" + ctx.dev + "]";
  if(ctx.view === "vlanif") return "[" + ctx.dev + "-Vlanif" + ctx.ifName + "]";
  return "[" + ctx.dev + "-" + ctx.ifName + "]";
}
function ifPort(ctx){ return "GE" + String(ctx.ifName).replace("GigabitEthernet", ""); }

/* ---------------- 命令表 ---------------- */
const P = "GigabitEthernet|GE|gigabitethernet";

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
      if(c.view === "if" || c.view === "vlanif"){ c.view = "system"; c.ifName = ""; }
      else if(c.view === "system"){ c.view = "user"; }
      else api.say("Error: Unrecognized command found at '^' position.", "err");
    }
  },
  {
    id: "return", match: /^(return|ctrl\+z)$/, view: null, kind: "view", usage: "return",
    run(api){ api.ctx.view = "user"; api.ctx.ifName = ""; }
  },
  {
    id: "vlan-batch", match: /^vlan batch (.+)$/, view: "system", kind: "config",
    usage: "vlan batch <10 20>",
    explain: [
      { h: "只是建表", p: "VLAN 表里插入 10、20 两行。此时<b>没有任何端口属于它们</b>，也还没有三层接口，转发行为一点没变。" },
      { h: "为什么先建表", p: "port default vlan 会校验 VLAN 是否存在；Vlanif 也要有 VLAN 才有广播域可挂。" }
    ],
    run(api, m){
      const sw = api.S[api.ctx.dev];
      const added = [];
      m[1].split(" ").filter(x => /^\d+$/.test(x)).forEach(function(tk){
        const vid = parseInt(tk, 10);
        if(vid < 1 || vid > 4094) return;
        if(!sw.vlans[vid]){
          sw.vlans[vid] = { name: "VLAN " + String(vid).padStart(4, "0") };
          added.push(vid);
          api.change("vlan " + vid, "不存在", "common / enable", { row: "vlan-" + vid, kind: "enter" });
        }
      });
      sync(sw);
      api.say("Info: This operation may take a few seconds. Please wait for a moment...done.", "dim");
      if(added.length){
        api.tab("vlan");
        api.say("// 新建 " + added.length + " 个 VLAN：" + added.join("、") + "（此时还没有端口、也没有 Vlanif）", "op");
        api.fx({ kind: "scan", box: [DEV.x, DEV.y, DEV.w, DEV.h], color: "#38E1FF" });
      }else{
        api.say("// 上述 VLAN 均已存在，本次无变更。", "op");
      }
    }
  },
  {
    id: "interface", match: new RegExp("^interface (?:" + P + ")\\s*([\\d/]+)$", "i"),
    view: "system", kind: "view", usage: "interface GigabitEthernet 0/0/1",
    run(api, m){
      const key = "GE" + m[1];
      const sw = api.S[api.ctx.dev];
      if(!sw.ports[key]){ api.say("Error: The port does not exist.", "err"); return; }
      api.ctx.view = "if"; api.ctx.ifName = "GigabitEthernet" + m[1];
    }
  },
  {
    id: "if-vlanif", match: /^interface\s+[Vv]lanif\s*(\d+)$/, view: "system", kind: "view",
    usage: "interface Vlanif 10",
    explain: [
      { h: "这是三层口", p: "Vlanif 不是物理端口，而是交换机内部<b>为某个 VLAN 创建的虚拟三层接口</b>。一个 VLAN 一个，IP 就配在它上面。" },
      { h: "前提", p: "VLAN 不存在时接口照样能创建，但 Physical 会一直是 down —— 没有广播域可承载。" }
    ],
    run(api, m){
      const vid = parseInt(m[1], 10);
      const sw = api.S[api.ctx.dev];
      if(vid < 1 || vid > 4094){ api.say("Error: Wrong parameter found at '^' position.", "err"); return; }
      if(!sw.vlanif[vid]) sw.vlanif[vid] = { exists: false, ip: "", mask: 0, up: false, phy: false, ever: false };
      const f = sw.vlanif[vid];
      if(!f.exists){
        f.exists = true;
        api.change("Vlanif" + vid, "不存在", "已创建 / unassigned", { row: "if-v" + vid, kind: "enter" });
        api.say("// 已创建三层接口 Vlanif" + vid + "（当前 unassigned，还没有 IP）", "op");
        if(!sw.vlans[vid]) api.say("// 注意：VLAN " + vid + " 还不存在，Vlanif" + vid + " 的 Physical 状态会是 down。", "op");
      }
      sync(sw);
      api.ctx.view = "vlanif"; api.ctx.ifName = String(vid);
      api.tab("if");
      api.fx({ kind: "chip", route: "l3-a", text: "V" + vid, color: vlanColor(vid), dur: 900, life: 1000 });
    }
  },
  {
    id: "link-type", match: /^port link-type (access|trunk|hybrid)$/, view: "if", kind: "config",
    usage: "port link-type access",
    explain: [
      { h: "改链路类型", p: "本实验的两个接入端口都用 access：进来的无标签帧按 PVID 归 VLAN，出去的帧去掉标签。" },
      { h: "trunk", p: "trunk 用来承载多个 VLAN 的带标签帧，常见于交换机之间；本实验只有一台交换机，用不上。" }
    ],
    run(api, m){
      const sw = api.S[api.ctx.dev], pn = ifPort(api.ctx), p = sw.ports[pn];
      const nt = m[1];
      if(nt === "trunk" || nt === "hybrid"){
        api.say("// 本实验只用 access 接入主机，trunk / hybrid 不在范围内，命令未产生状态变化。", "op");
        return;
      }
      if(p.type === nt){ api.say("// " + pn + " 本来就是 " + nt + " 类型，命令未产生状态变化。", "op"); return; }
      const from = p.type;
      p.type = nt;
      sync(sw);
      api.change(pn + ".link-type", from, nt, { row: "if-" + pn });
      api.say("// " + pn + " 链路类型改为 access（主机接入口的默认选择）", "op");
      api.fx({ kind: "pulse", target: api.ctx.dev + "/" + pn, color: "#FFB545" });
    }
  },
  {
    id: "default-vlan", match: /^port default vlan (\d+)$/, view: "if", kind: "config",
    usage: "port default vlan <10>",
    explain: [
      { h: "改 PVID", p: "此后从这个口进来的无标签帧归入新 VLAN；出去的帧属于该 VLAN 时去掉标签。这是「把主机放进 VLAN」的唯一动作。" },
      { h: "连带影响", p: "端口换 VLAN 会改变 Vlanif 的 Physical 状态：原来那个 VLAN 可能失去唯一的成员口。" }
    ],
    run(api, m){
      const sw = api.S[api.ctx.dev], pn = ifPort(api.ctx), p = sw.ports[pn];
      const vid = parseInt(m[1], 10);
      if(p.type !== "access"){ api.say("Error: The port is not an access port.", "err"); return; }
      if(!sw.vlans[vid]){
        api.say("Error: The VLAN does not exist.", "err");
        api.say("      先执行 vlan batch " + vid + " 创建该 VLAN。", "dim");
        return;
      }
      if(p.pvid === vid){ api.say("// " + pn + " 的 PVID 已经是 " + vid + "，命令未产生状态变化。", "op"); return; }
      const from = p.pvid;
      const before = sw.vlanif[vid] ? sw.vlanif[vid].up : false;
      p.pvid = vid;
      sync(sw);
      api.change(pn + ".PVID", from, vid, { row: "if-" + pn });
      api.tab("if");
      api.say("// " + pn + " PVID " + from + " → " + vid + "：该口从此属于 VLAN " + vid + " 的广播域", "op");
      const f = sw.vlanif[vid];
      if(f && f.exists && !before && f.up){
        api.say("// 连带效果：Vlanif" + vid + " 的 Physical 变 up，Protocol 也 up，直连路由 " + netOf(f.ip, f.mask) + "/" + f.mask + " 进表。", "op");
      }else if(f && f.exists && f.phy && !f.ip){
        api.say("// Vlanif" + vid + " 现在 Physical up，但还没有 IP，Protocol 仍是 down。", "op");
      }
      api.fx({ kind: "pulse", target: api.ctx.dev + "/" + pn, color: vlanColor(vid) });
    }
  },
  {
    id: "ip-address", match: /^ip address ([\d.]+)\s+(\d+|[\d.]+)$/, view: "vlanif", kind: "config",
    usage: "ip address <192.168.10.1 24>",
    explain: [
      { h: "配的是谁", p: "给 Vlanif 配 IP。这个地址会成为该 VLAN 内所有主机的默认网关。" },
      { h: "自动产物", p: "Protocol up 之后，设备会<b>自动派生</b>一条直连路由（192.168.x.0/24 → Vlanif）和一条接口地址的 /32 主机路由。" }
    ],
    run(api, m){
      const sw = api.S[api.ctx.dev];
      const vid = parseInt(api.ctx.ifName, 10);
      const f = sw.vlanif[vid];
      if(!f || !f.exists){ api.say("Error: The VLANIF interface does not exist.", "err"); return; }
      const ip = m[1];
      const mask = maskToPrefix(m[2]);
      if(!mask){ api.say("Error: Wrong parameter found at '^' position.", "err"); return; }
      if(f.ip === ip && f.mask === mask){
        api.say("// Vlanif" + vid + " 的地址本来就是 " + ip + "/" + mask + "，命令未产生状态变化。", "op");
        return;
      }
      const from = f.ip ? f.ip + "/" + f.mask : "unassigned";
      f.ip = ip; f.mask = mask; f.ever = true;
      sync(sw);
      api.change("Vlanif" + vid + ".ip", from, ip + "/" + mask, { row: "if-v" + vid, kind: "enter" });
      api.tab("if");
      api.say("// Vlanif" + vid + " → " + ip + "/" + mask + "：VLAN " + vid + " 从此有了默认网关 " + ip, "op");
      if(f.up){
        api.say("// 直连路由 " + netOf(ip, mask) + "/" + mask + " 与 " + ip + "/32 自动进表（Proto Direct），出接口 Vlanif" + vid + "。", "op");
        if(vid === 10 || vid === 20)
          api.fx({ kind: "pulse", target: api.ctx.dev + "/" + (vid === 10 ? "GE0/0/1" : "GE0/0/2"), color: vlanColor(vid) });
      }else{
        api.say("// 但 Vlanif" + vid + " 的 Protocol 还是 down（VLAN " + vid + " 没有 up 的成员口），路由表暂时不会出现这条直连路由。", "op");
      }
    }
  },
  {
    id: "undo-vlanif", match: /^undo interface\s+[Vv]lanif\s*(\d+)$/, view: "system", kind: "config",
    usage: "undo interface Vlanif <20>",
    explain: [
      { h: "删掉的是什么", p: "Vlanif 的 IP、直连路由、以及这个 VLAN 的网关一起消失；<b>VLAN 本身和端口都还在</b>。" },
      { h: "现象", p: "该 VLAN 内部二层转发不受影响，但它和其它 VLAN 之间的三层通路立即中断。" }
    ],
    run(api, m){
      const sw = api.S[api.ctx.dev];
      const vid = parseInt(m[1], 10);
      const f = sw.vlanif[vid];
      if(!f || !f.exists){
        api.say("// Vlanif" + vid + " 本来就不存在，命令未产生状态变化。", "op");
        return;
      }
      const old = f.ip ? f.ip + "/" + f.mask : "unassigned";
      const net = f.ip ? netOf(f.ip, f.mask) + "/" + f.mask : "";
      f.exists = false; f.ip = ""; f.mask = 0; f.up = false; f.phy = false;
      sw.arp = sw.arp.filter(e => e.vlan !== vid);
      sync(sw);
      api.change("Vlanif" + vid, old, "已删除", { row: "if-v" + vid, kind: "exit" });
      api.tab("route");
      api.say("// Vlanif" + vid + " 已删除" + (net ? "：直连路由 " + net + " 同时从路由表消失" : "") + "。", "op");
      api.say("// VLAN " + vid + " 和它的 access 端口都还在——同 VLAN 内二层照样通，缺的是出口网关。", "op");
    }
  },

  /* ---- 只读命令 ---- */
  {
    id: "display-vlan", match: /^display vlan$/, view: null, kind: "doc", usage: "display vlan",
    doc: "这张表只有二层信息：VLAN 有几个、成员端口是谁。<b>Vlanif 不在里面</b>——三层口要到 display ip interface brief 里看。",
    run(api){
      const sw = api.S[api.ctx.dev];
      api.say("The total number of vlans is : " + Object.keys(sw.vlans).length);
      api.lines(["--------------------------------------------------------------------------------",
        "U: Up;         D: Down;         TG: Tagged;         UT: Untagged;",
        "MP: Vlan-mapping;               ST: Vlan-stacking;",
        "#: ProtocolTransparent-vlan;    *: Management-vlan;",
        "--------------------------------------------------------------------------------", ""], "dim");
      api.say(pad("VID", 5) + pad("Type", 8) + "Ports", "dim");
      api.say("--------------------------------------------------------------------------------", "dim");
      Object.keys(sw.vlans).map(Number).sort((a, b) => a - b).forEach(function(vid){
        const line = vlanPorts(sw, vid).map(s => pad(s, 22)).join("");
        api.say(pad(vid, 5) + pad("common", 8) + (line.trim() || "-"));
      });
      api.tab("vlan");
    }
  },
  {
    id: "display-ip-brief", match: /^display ip interface brief$/, view: null, kind: "doc",
    usage: "display ip interface brief",
    doc: "判 Vlanif 的两个状态：<b>Physical</b> 看 VLAN 有没有 up 的成员口，<b>Protocol</b> 还要再加一个「配了 IP」。只有两个都 up，路由表里才会出现直连路由。",
    run(api){
      const sw = api.S[api.ctx.dev];
      api.lines(["PHY: Physical", "*down: administratively down", "(l): loopback", "(s): spoofing", ""], "dim");
      api.say(pad("Interface", 34) + pad("IP Address/Mask", 20) + pad("Physical", 11) + "Protocol", "dim");
      api.say("--------------------------------------------------------------------------------", "dim");
      let n = 0;
      Object.keys(sw.vlanif).map(Number).sort((a, b) => a - b).forEach(function(v){
        const f = sw.vlanif[v];
        if(!f.exists) return;
        n++;
        api.say(pad("Vlanif" + v, 34) + pad(f.ip ? f.ip + "/" + f.mask : "unassigned", 20) +
          pad(f.phy ? "up" : "down", 11) + (f.up ? "up" : "down"));
      });
      api.say(pad("NULL0", 34) + pad("unassigned", 20) + pad("up", 11) + "up(s)");
      if(!n){
        api.say("", "dim");
        api.say("// 没有任何 Vlanif —— 交换机现在是一台纯二层设备，两个网段之间没有三层出口。", "op");
      }else{
        Object.keys(sw.vlanif).map(Number).forEach(function(v){
          const f = sw.vlanif[v];
          if(f.exists && f.phy && !f.ip) api.say("// Vlanif" + v + " 的 Physical 是 up、Protocol 是 down：三层口建出来了，但还没配 IP。", "op");
        });
      }
      api.tab("if");
    }
  },
  {
    id: "display-route", match: /^display ip routing-table$/, view: null, kind: "doc",
    usage: "display ip routing-table",
    doc: "路由表每行回答「去哪个网段、从哪个接口出」。<b>直连路由是 Vlanif 的副产品</b>：接口 Protocol down 或 IP 被删，行就消失。",
    run(api){
      const sw = api.S[api.ctx.dev];
      const rows = sw.routeTable;
      api.lines(["Route Flags: R - relay, D - download to fib",
        "------------------------------------------------------------------------------",
        "Routing Tables: Public",
        "         Destinations : " + rows.length + "        Routes : " + rows.length, "",
        "Destination/Mask    Proto   Pre  Cost      Flags NextHop         Interface", ""], "dim");
      rows.forEach(function(r){
        api.say(pad(padL(r.dest, 18), 20) + pad(r.proto, 8) + pad(r.pre, 5) + pad(r.cost, 10) +
          pad(r.flags, 6) + pad(r.nexthop, 16) + r.iface, r.sys ? "dim" : "out");
      });
      api.tab("route");
      const biz = rows.filter(r => !r.sys);
      if(!biz.length){
        api.say("", "dim");
        api.say("// 表里只有设备自带的 127.0.0.0/8 等系统路由。没有 Vlanif 就没有直连路由，跨网段无从转发。", "op");
      }
    }
  },
  {
    id: "display-arp", match: /^display arp$/, view: null, kind: "doc", usage: "display arp",
    doc: "ARP 表记录「IP ↔ MAC」的对应。网关要转发给主机，先得知道主机 MAC；主机要发往网关，先得知道 Vlanif 的 MAC。",
    run(api){
      const sw = api.S[api.ctx.dev];
      api.say(pad("IP ADDRESS", 16) + pad("MAC ADDRESS", 16) + pad("EXPIRE(M)", 10) + pad("TYPE", 12) + pad("INTERFACE", 12) + "VPN-INSTANCE", "dim");
      api.say(pad("", 42) + "VLAN/CEVLAN PVC", "dim");
      api.say("------------------------------------------------------------------------------", "dim");
      sw.arp.slice().sort((a, b) => a.vlan - b.vlan).forEach(function(e){
        api.say(pad(e.ip, 16) + pad(e.mac, 16) + pad("", 10) + pad("D", 12) + pad(e.iface, 12));
        api.say(pad("", 42) + e.vlan + "/-");
      });
      api.say("------------------------------------------------------------------------------", "dim");
      api.say("Total:" + sw.arp.length + "       Dynamic:" + sw.arp.length + "       Static:0", "dim");
      api.tab("arp");
      if(!sw.arp.length){
        api.say("", "dim");
        api.say("// ARP 表为空：网关还没有和任何主机完成过 ARP 交互。跑一次 PC1 → PC2 再看。", "op");
      }else{
        api.say("// " + hostSideNote(sw), "op");
      }
    }
  },
  {
    id: "display-conf", match: /^display current-configuration$/, view: null, kind: "doc",
    usage: "display current-configuration",
    doc: "设备上真正生效的配置。把它和表项对照：哪一行配置产生了哪一行表项，一目了然。",
    run(api){
      const sw = api.S[api.ctx.dev];
      api.say("#", "dim");
      api.say("sysname " + sw.name);
      api.say("#", "dim");
      const vs = Object.keys(sw.vlans).map(Number).filter(v => v !== 1).sort((a, b) => a - b);
      if(vs.length){ api.say("vlan batch " + vs.join(" ")); api.say("#", "dim"); }
      Object.keys(sw.vlanif).map(Number).sort((a, b) => a - b).forEach(function(v){
        const f = sw.vlanif[v];
        if(!f.exists) return;
        api.say("interface Vlanif" + v);
        if(f.ip) api.say(" ip address " + f.ip + " " + intToIp(maskInt(f.mask)));
        api.say("#", "dim");
      });
      PORTS.forEach(function(pn){
        const p = sw.ports[pn];
        api.say("interface GigabitEthernet" + pn.slice(2));
        api.say(" port link-type " + p.type);
        api.say(" port default vlan " + p.pvid);
        api.say("#", "dim");
      });
      api.say("return");
    }
  },
  {
    id: "ping", match: /^ping ([\d.]+)$/, view: null, kind: "test", usage: "ping <192.168.20.10>",
    run(api, m){
      const sw = api.S[api.ctx.dev];
      const ip = m[1];
      const host = Object.keys(HOSTS).map(k => HOSTS[k]).find(h => h.ip === ip);
      const f = host ? sw.vlanif[host.vlan] : null;
      const ok = !!(host && f && f.up);
      api.say("  PING " + ip + ": 56  data bytes, press CTRL_C to break");
      if(ok){
        for(let i = 1; i <= 5; i++){
          api.say("    Reply from " + ip + ": bytes=56 Sequence=" + i + " ttl=128 time=1 ms");
        }
        api.lines(["", "  --- " + ip + " ping statistics ---",
          "    5 packet(s) transmitted", "    5 packet(s) received", "    0.00% packet loss",
          "    round-trip min/avg/max = 1/1/1 ms"]);
        learnArp(sw, host);
        api.say("// 这是交换机自己发起 ping，源地址是 Vlanif" + host.vlan + " 的 " + f.ip + "，属于直连网段，不经过网关。", "op");
        api.say("// 要验证「一台 PC 跨 VLAN 找另一台 PC」，请用右下角的 PC1 → PC2 按钮。", "op");
      }else{
        for(let i = 1; i <= 5; i++) api.say("    Request time out");
        api.lines(["", "  --- " + ip + " ping statistics ---",
          "    5 packet(s) transmitted", "    0 packet(s) received", "    100.00% packet loss"], "err");
        if(host) api.say("// Vlanif" + host.vlan + " 没有上线（不存在 / 没有 IP / 没有成员口），直连路由不存在，设备不知道从哪个口发。", "op");
        else api.say("// 本实验只实现了 PC1（192.168.10.10）与 PC2（192.168.20.10）。", "op");
      }
      sync(sw);
    }
  }
];

/* ---------------- 表项 ---------------- */
function vlanPorts(sw, vid){
  const arr = [];
  Object.keys(sw.ports).forEach(function(pn){
    const p = sw.ports[pn];
    if(p.type === "access" && p.pvid === vid) arr.push("UT:" + pn + "(" + (p.up ? "U" : "D") + ")");
  });
  return arr;
}

function vifState(f){
  if(!f.exists) return "—";
  if(!f.ip) return "unassigned";
  return f.ip + "/" + f.mask;
}

/* 主机侧的 ARP 缓存不在交换机表里，但它是理解「网关 MAC」的关键 */
function hostSideNote(sw){
  const parts = VLANS.filter(v => sw.vlanif[v] && sw.vlanif[v].up).map(function(v){
    return (v === 10 ? "PC1" : "PC2") + " 记录「" + GW[v] + " → " + VIF_MAC[v] + "」";
  });
  if(!parts.length) return "主机侧缓存（网关 IP ↔ 网关 MAC）在 PC 上，交换机表里看不到。";
  return "主机侧缓存：" + parts.join("，") + "（主机自己的表，交换机表里没有）。";
}

function tables(S, tab, ctx){
  const sw = S[ctx.dev];

  if(tab === "vlan"){
    const rows = Object.keys(sw.vlans).map(Number).sort((a, b) => a - b).map(function(vid){
      const f = sw.vlanif[vid];
      const ps = vlanPorts(sw, vid);
      return {
        key: "vlan-" + vid,
        cells: [
          { t: vid, cls: vid === 10 ? "v10" : vid === 20 ? "v20" : "v1" },
          { t: "common", cls: "c" },
          { t: sw.vlans[vid].name, cls: "c" },
          { t: ps.length ? ps.join("  ") : "—", cls: "c" },
          { t: f && f.exists ? "Vlanif" + vid + " · " + (f.up ? "up" : (f.phy ? "protocol down" : "down")) : "—",
            cls: f && f.up ? "v10" : "c" }
        ]
      };
    });
    return {
      head: ["VID", "TYPE", "NAME", "PORTS", "VLANIF"],
      rows: rows,
      note: "VLAN 表只管二层。Vlanif 是三层口，它的 up/down 在「接口与 IP」里看。"
    };
  }

  if(tab === "if"){
    const rows = [];
    Object.keys(sw.vlanif).map(Number).sort((a, b) => a - b).forEach(function(v){
      const f = sw.vlanif[v];
      rows.push({
        key: "if-v" + v,
        cells: [
          { t: "Vlanif" + v, cls: "c" },
          { t: f.exists ? "三层" : "未创建", cls: "c" },
          { t: vifState(f), cls: f.up ? "v10" : "c" },
          { t: f.phy ? "up" : "down", cls: "c" },
          { t: f.up ? "up" : "down", cls: "c" }
        ]
      });
    });
    PORTS.forEach(function(pn){
      const p = sw.ports[pn];
      rows.push({
        key: "if-" + pn,
        cells: [
          { t: pn, cls: "c" },
          { t: "二层", cls: "c" },
          { t: "access · PVID " + p.pvid, cls: p.pvid === 10 ? "v10" : p.pvid === 20 ? "v20" : "v1" },
          { t: p.up ? "up" : "down", cls: "c" },
          { t: p.up ? "up" : "down", cls: "c" }
        ]
      });
    });
    return {
      head: ["INTERFACE", "层", "地址 / 归属", "PHY", "PROTOCOL"],
      rows: rows,
      note: "Physical = VLAN 存在且有 up 的成员口；Protocol = Physical up 且配了 IP。两个都 up 才会有直连路由。"
    };
  }

  if(tab === "arp"){
    if(!sw.arp.length){
      return {
        head: ["IP ADDRESS", "MAC ADDRESS", "TYPE", "INTERFACE", "VLAN"],
        rows: [],
        empty: "ARP 表为空 · 网关还没和任何主机通过 ARP"
      };
    }
    return {
      head: ["IP ADDRESS", "MAC ADDRESS", "TYPE", "INTERFACE", "VLAN"],
      rows: sw.arp.slice().sort((a, b) => a.vlan - b.vlan).map(function(e){
        return {
          key: "arp-" + e.ip,
          cells: [
            { t: e.ip, cls: "c" },
            { t: e.mac, cls: "c" },
            { t: "dynamic", cls: "c" },
            { t: e.iface, cls: "c" },
            { t: e.vlan, cls: e.vlan === 10 ? "v10" : "v20" }
          ]
        };
      }),
      note: "这里只有交换机自己学到的表项。" + hostSideNote(sw)
    };
  }

  /* route */
  return {
    head: ["DESTINATION/MASK", "PROTO", "PRE", "COST", "FLAGS", "NEXTHOP", "INTERFACE"],
    rows: sw.routeTable.map(function(r){
      const cls = r.iface === "Vlanif10" ? "v10" : r.iface === "Vlanif20" ? "v20" : "c";
      return {
        key: "rt-" + r.dest,
        cells: [
          { t: r.dest, cls: r.sys ? "c" : cls },
          { t: r.proto, cls: "c" },
          { t: r.pre, cls: "c" },
          { t: r.cost, cls: "c" },
          { t: r.flags, cls: "c" },
          { t: r.nexthop, cls: "c" },
          { t: r.iface, cls: r.sys ? "c" : cls }
        ]
      };
    }),
    note: "整张表由 Vlanif 派生：接口 Protocol down、IP 被删或 undo 掉，对应直连路由立即消失。127.x 与 255.255.255.255 是设备自带的系统路由。"
  };
}

/* ---------------- 拓扑 ---------------- */
function vlanifLabel(sw, v){
  const f = sw.vlanif[v];
  if(!f || !f.exists) return "Vlanif" + v + "  —";
  if(!f.ip) return "Vlanif" + v + "  unassigned";
  return "Vlanif" + v + "  " + f.ip + "/" + f.mask;
}
function vlanifCls(sw, v){
  const f = sw.vlanif[v];
  if(!f || !f.exists) return "dev-sub";
  return f.up ? "lk-tag on" : "lk-tag warn";
}

function topology(S, ui, ctx){
  const sw = S[ctx.dev] || S.SW1;

  const ports = PORTS.map(function(pn, i){
    const p = sw.ports[pn];
    return {
      name: pn, kind: "rj45", x: DEV.rjRel[i], y: 44,
      color: vlanColor(p.pvid), up: p.up, label: pn.slice(-1)
    };
  });

  const devices = [{
    id: "SW1", x: DEV.x, y: DEV.y, w: DEV.w, h: DEV.h, model: "S5700-28C-EI",
    silk: "M12 24 h60 M12 28 h44 M12 32 h60 M12 36 h44",
    leds: [
      { x: 272, y: 10, color: "#35E08A", glow: true, label: "PWR", tx: 278, ty: 12.5 },
      { x: 258, y: 10, color: "#38E1FF", glow: true, label: "SYS", tx: 232, ty: 12.5 }
    ],
    ports: ports,
    tags: [
      { x: 0, y: -8, text: "SW1", cls: "dev-label" },
      { x: 34, y: -8, text: "S5700-28C-EI · 三层特性", cls: "dev-sub" },
      { x: 150, y: 90, text: vlanifLabel(sw, 10), cls: vlanifCls(sw, 10), anchor: "middle" },
      { x: 150, y: 104, text: vlanifLabel(sw, 20), cls: vlanifCls(sw, 20), anchor: "middle" }
    ]
  }];

  const hosts = ["PC1", "PC2"].map(function(k){
    const h = HOSTS[k];
    return {
      id: h.id, x: h.x, y: h.y, ip: h.ip, mac: h.mac,
      vlan: h.vlan, color: vlanColor(h.vlan), up: true
    };
  });

  /* 接入链路：端口 up 就有心跳流量；对应 Vlanif 不在线时业务断了，流量归 0 */
  const links = ["PC1", "PC2"].map(function(k){
    const h = HOSTS[k];
    const p = sw.ports[h.port];
    const f = sw.vlanif[h.vlan];
    const live = !!(p.up && f && f.up);
    return {
      id: "lk-" + h.id.toLowerCase(),
      d: ROUTES[h.id.toLowerCase() + "-down"],
      cls: p.up ? "" : "down",
      flow: live ? 0.42 : 0,
      flowColor: hexRgb(vlanColor(h.vlan))
    };
  });

  const anchors = {
    "SW1/GE0/0/1": [DEV.x + DEV.rjRel[0], DEV.y + 44],
    "SW1/GE0/0/2": [DEV.x + DEV.rjRel[1], DEV.y + 44]
  };

  const labels = [
    { text: "VLAN 10", x: 545, y: 178, anchor: "middle", cls: "lk-tag on" },
    { text: "VLAN 20", x: 855, y: 178, anchor: "middle", cls: "lk-tag warn" }
  ];

  return {
    viewBox: "0 0 1400 300",
    devices: devices, hosts: hosts, links: links, routes: ROUTES, anchors: anchors, labels: labels
  };
}

/* ---------------- 数据面场景 ---------------- */
function upRoute(h){ return h.id.toLowerCase() + "-up"; }
function downRoute(h){ return h.id.toLowerCase() + "-down"; }

function learnArp(sw, host){
  if(sw.arp.some(e => e.ip === host.ip)) return;
  sw.arp.push({ ip: host.ip, mac: host.mac, type: "dynamic", iface: host.port, vlan: host.vlan });
  sw.arp.sort((a, b) => a.vlan - b.vlan);
}

/* direction: "fwd" = PC1 → PC2，其它（"rev"）= PC2 → PC1 */
export function routeScene(S, direction){
  const sw = S.SW1;
  sync(sw);

  const fwd = direction !== "rev";
  const A = fwd ? HOSTS.PC1 : HOSTS.PC2;
  const B = fwd ? HOSTS.PC2 : HOSTS.PC1;
  const fa = sw.vlanif[A.vlan], fb = sw.vlanif[B.vlan];
  const aUp = !!(fa && fa.up), bUp = !!(fb && fb.up);
  const colA = vlanColor(A.vlan), colB = vlanColor(B.vlan);
  const inAB = A.vlan === 10 ? "l3-a" : "l3-b";
  const inBA = A.vlan === 10 ? "l3-b" : "l3-a";

  const scene = {
    name: A.id + " → " + B.id + " · " + A.ip + " → " + B.ip,
    realSec: 4.8,
    dur: 1,
    traceTitle: "逐跳判读",
    frames: [],
    drop: null,
    trace: [],
    verdict: null
  };

  /* ---- 情况一：源侧的 Vlanif 不在线，ARP 就没有人应答 ---- */
  if(!aUp){
    scene.frames.push({ route: upRoute(A), t0: 0, t1: .34, kind: "broadcast", vlan: A.vlan, color: colA });
    scene.drop = { route: upRoute(A), p: .9, at: .36, label: "NO ARP REPLY" };
    scene.trace.push({ h: "① 源主机判路", p: "<b>" + A.ip + "/24</b> 与 <b>" + B.ip + "</b> 不在同一网段，必须交给默认网关 <b>" + A.gw + "</b>；本机 ARP 缓存里没有它的 MAC，先发 ARP 请求（广播）。", cls: "" });
    scene.trace.push({
      h: "② 广播只在 VLAN " + A.vlan + " 内",
      p: "ARP 请求被打上 VLAN <b>" + A.vlan + "</b> 的归属，只在 VLAN " + A.vlan + " 的广播域里泛洪。网关 " + A.gw + " 本应挂在 Vlanif" + A.vlan + " 上，而它" +
        (fa && fa.exists ? "现在没有 IP / Protocol down" : "还不存在") + " —— 这个 IP 在 VLAN " + A.vlan + " 里没有任何人持有。",
      cls: ""
    });
    scene.trace.push({ h: "③ 结果 · 丢弃", p: "源主机等不到 ARP 应答，ICMP 报文根本没有发出去。ping 的现象是 Request time out，而不是 Destination unreachable。", cls: "drop" });
    scene.verdict = { bad: true, text: "网关不是一台独立的设备，而是交换机上的虚拟三层口。Vlanif 不配，网关 IP 就没有人回答 ARP —— 这就是第 1 步的现象。" };
    return scene;
  }

  /* ---- 情况二：源侧网关在，但目的网段没有直连路由 ---- */
  if(!bUp){
    scene.frames.push({ route: upRoute(A), t0: 0, t1: .07, kind: "broadcast", vlan: A.vlan, color: colA });
    scene.frames.push({ route: downRoute(A), t0: .08, t1: .15, kind: "unicast", vlan: A.vlan, color: colA });
    scene.frames.push({ route: upRoute(A), t0: .17, t1: .26, kind: "unicast", vlan: A.vlan, color: colA });
    scene.frames.push({ route: inAB, t0: .26, t1: .46, kind: "unicast", color: "#35E08A" });
    scene.drop = { route: inAB, p: .56, at: .46, label: "NO ROUTE" };
    learnArp(sw, A);
    scene.trace.push({ h: "① 源主机 → 网关", p: A.id + " 的 ARP 请求被 <b>Vlanif" + A.vlan + "</b> 接住，网关把自己的 MAC <b>" + VIF_MAC[A.vlan] + "</b> 回给它。随后 ICMP 报文被封装成「目的 IP " + B.ip + "、目的 MAC 网关」。", cls: "" });
    scene.trace.push({ h: "② 入方向 · " + A.port, p: "access / PVID " + A.vlan + "，无标签帧归入 VLAN " + A.vlan + "；目的 MAC 是 Vlanif" + A.vlan + "，交换机判定「发给我的三层口」，交给路由转发。", cls: "" });
    scene.trace.push({
      h: "③ 查路由 · 丢弃",
      p: "路由表里只有 <b>" + netOf(fa.ip, fa.mask) + "/" + fa.mask + "</b> 等直连条目，目的网段 <b>" + B.net + "/24</b> 没有匹配表项（Vlanif" + B.vlan + " " +
        (fb && fb.exists ? "Protocol 还没 up" : "不存在") + "）。没有出接口，报文被丢弃。",
      cls: "drop"
    });
    scene.verdict = { bad: true, text: "配了一半：VLAN " + A.vlan + " 侧的 VLAN、端口、Vlanif 全对，VLAN " + B.vlan + " 侧缺一个 Vlanif，跨网段就断。VLAN " + B.vlan + " 内部仍然能通，这叫「有交换、没路由」。" };
    return scene;
  }

  /* ---- 情况三：两侧网关都在，完整走一遍 ---- */
  scene.frames.push({ route: upRoute(A), t0: 0, t1: .08, kind: "broadcast", vlan: A.vlan, color: colA });
  scene.frames.push({ route: downRoute(A), t0: .10, t1: .18, kind: "unicast", vlan: A.vlan, color: colA });
  scene.frames.push({ route: upRoute(A), t0: .20, t1: .30, kind: "unicast", vlan: A.vlan, color: colA });
  scene.frames.push({ route: inAB, t0: .30, t1: .44, kind: "unicast", color: "#35E08A" });
  scene.frames.push({ route: downRoute(B), t0: .46, t1: .54, kind: "broadcast", vlan: B.vlan, color: colB });
  scene.frames.push({ route: upRoute(B), t0: .56, t1: .64, kind: "unicast", vlan: B.vlan, color: colB });
  scene.frames.push({ route: downRoute(B), t0: .66, t1: .76, kind: "unicast", vlan: B.vlan, color: colB });
  scene.frames.push({ route: upRoute(B), t0: .78, t1: .86, kind: "unicast", vlan: B.vlan, color: colB });
  scene.frames.push({ route: inBA, t0: .86, t1: .93, kind: "unicast", color: "#35E08A" });
  scene.frames.push({ route: downRoute(A), t0: .94, t1: 1, kind: "unicast", vlan: A.vlan, color: colA });

  learnArp(sw, A);
  learnArp(sw, B);

  scene.trace.push({ h: "① 源主机判路", p: "<b>" + A.ip + "/24</b> 的目的 <b>" + B.ip + "</b> 不在同一网段，交给默认网关 <b>" + A.gw + "</b>。ARP 缓存里没有网关 MAC，先发 ARP 请求（广播，只在 VLAN " + A.vlan + " 内传播）。", cls: "" });
  scene.trace.push({ h: "② 网关应答", p: "ARP 请求被 <b>Vlanif" + A.vlan + "</b> 接住 —— 它就是交换机自己的三层口，直接回 MAC <b>" + VIF_MAC[A.vlan] + "</b>。VLAN " + B.vlan + " 的主机看不到这个广播。", cls: "" });
  scene.trace.push({ h: "③ 入方向 · " + A.port, p: "access / PVID " + A.vlan + "，无标签帧归入 VLAN " + A.vlan + "；目的 MAC 是 Vlanif" + A.vlan + "，交给三层转发。", cls: "" });
  scene.trace.push({ h: "④ 查路由", p: "目的 <b>" + B.ip + "</b> 命中直连路由 <b>" + B.net + "/24 → Vlanif" + B.vlan + "</b>（Proto Direct）。三层转发要重写二层头：源 MAC 换成本口 MAC，IP 头一个字节都不动。", cls: "" });
  scene.trace.push({ h: "⑤ 出方向 ARP", p: "Vlanif" + B.vlan + " 不知道 " + B.id + " 的 MAC，在 VLAN " + B.vlan + " 里发 ARP 请求；" + B.id + " 应答，交换机学到 <b>" + B.mac + "</b>。（ARP 命中后 20 分钟内不会重发，这里每次都完整画出，便于观察。）", cls: "" });
  scene.trace.push({ h: "⑥ 送到 " + B.id, p: "从 " + B.port + " 发出，untagged（VLAN " + B.vlan + "）。" + B.id + " 收到的报文源 IP 仍然是 <b>" + A.ip + "</b>。", cls: "" });
  scene.trace.push({ h: "⑦ 回程", p: B.id + " 的网关是 " + B.gw + "，回包同样「ARP 网关 → 查直连 " + A.net + "/24 → 从 Vlanif" + A.vlan + " 发出」，MAC 再被重写一次。", cls: "" });
  scene.trace.push({ h: "⑧ 结论", p: "两台 PC 的广播域始终是分开的，却有了完整的三层通路 —— 这就是三层交换机的价值。", cls: "pass" });
  scene.verdict = { bad: false, text: "ping 通。全程 IP 不变、MAC 被重写多次（PC1 → 网关 → PC2 → 网关 → PC1），这就是「路由」与「交换」的分界线。" };
  return scene;
}

/* ---------------- 引导 ---------------- */
const GOAL = {
  vlans: [10, 20],
  access: [{ port: "GE0/0/1", vid: 10 }, { port: "GE0/0/2", vid: 20 }],
  vlanif: [{ vid: 10 }, { vid: 20 }]
};

function configComplete(sw){
  if(GOAL.vlans.some(v => !sw.vlans[v])) return false;
  if(GOAL.access.some(a => {
    const p = sw.ports[a.port];
    return !p || p.type !== "access" || p.pvid !== a.vid;
  })) return false;
  return GOAL.vlanif.every(x => sw.vlanif[x.vid].exists && sw.vlanif[x.vid].ip);
}

/* 配置齐了之后：没跑过数据面就建议测一下，ARP 有了才收尾校验 */
function finishGuide(sw){
  if(!configComplete(sw)) return null;
  if(!sw.arp.length)
    return { phase: "test", why: "配置齐了：两个 Vlanif 的直连路由都已进表。点右下角 PC1 → PC2 跑一次数据面，看报文怎么在交换机内部被转一次。", cmd: "display ip routing-table" };
  return { phase: "verify", why: "数据面也通了（ARP 表里已有邻居）。用 display ip interface brief 与 display ip routing-table 做最后对照。", cmd: "display ip interface brief" };
}

function guide(S, ctx){
  const sw = S[ctx.dev];
  const G = (phase, why, cmd) => ({ phase, why, cmd: cmd || "" });

  if(ctx.view === "if"){
    const pn = ifPort(ctx), p = sw.ports[pn];
    if(!p) return G("access", "端口不存在，quit 退回系统视图。", "quit");
    const goal = GOAL.access.find(a => a.port === pn);
    if(!goal) return G("access", pn + " 不在本实验规划里（PVID 现在是 " + p.pvid + "），quit 出去。", "quit");
    if(p.type !== "access")
      return G("access", pn + " 现在是 " + p.type + " 口。port default vlan 只对 access 生效，先改类型。", "port link-type access");
    if(p.pvid !== goal.vid)
      return G("access", pn + " 的 PVID 现在是 " + p.pvid + "，要改成 " + goal.vid + "，从该口进来的无标签帧才会归进 VLAN " + goal.vid + "。", "port default vlan " + goal.vid);
    return G("access", pn + " 已完成（access / VLAN " + goal.vid + "）。quit 退出，换下一个端口。", "quit");
  }

  if(ctx.view === "vlanif"){
    const vid = parseInt(ctx.ifName, 10);
    const f = sw.vlanif[vid];
    if(!f || !f.ip)
      return G("ip", "Vlanif" + vid + " 现在是 " + (f && f.phy ? "Physical up / Protocol down" : "down") + "，还没有 IP。网关地址就配在这里。", "ip address " + (GW[vid] || "192.168." + vid + ".1") + " 24");
    return G("ip", "Vlanif" + vid + " 已是 " + f.ip + "/" + f.mask + "（Protocol " + (f.up ? "up" : "down") + "）。quit 出去，继续下一步。", "quit");
  }

  if(ctx.view === "system"){
    const mv = GOAL.vlans.filter(v => !sw.vlans[v]);
    if(mv.length) return G("vlan", "VLAN 表里还没有 " + mv.join("、") + "。先把表建出来，端口和 Vlanif 才有地方可挂。", "vlan batch " + mv.join(" "));
    const a = GOAL.access.find(function(x){
      const p = sw.ports[x.port];
      return p.type !== "access" || p.pvid !== x.vid;
    });
    if(a) return G("access", "VLAN 有了。" + a.port + " 现在是 PVID " + sw.ports[a.port].pvid + "，把它划进 VLAN " + a.vid + "。", "interface GigabitEthernet " + a.port.slice(2));
    const v = GOAL.vlanif.find(x => !sw.vlanif[x.vid].exists);
    if(v){
      if(sw.vlanif[v.vid].ever)
        return G("vlanif", "Vlanif" + v.vid + " 刚被删除，VLAN " + v.vid + " 已经没有网关，跨网段通路断开。要恢复就重建这个虚拟三层口。", "interface Vlanif " + v.vid);
      return G("vlanif", "两个接入端口都划好了。现在建三层口：interface Vlanif " + v.vid + " —— 这是交换机内部的虚拟接口，不是物理端口。", "interface Vlanif " + v.vid);
    }
    const n = GOAL.vlanif.find(x => !sw.vlanif[x.vid].ip);
    if(n) return G("ip", "Vlanif" + n.vid + " 已创建但地址是 unassigned，Protocol 还是 down。给它配上网关地址。", "interface Vlanif " + n.vid);
    const fin = finishGuide(sw);
    if(fin) return G(fin.phase, fin.why, fin.cmd);
    return G("verify", "配置齐了：两个 VLAN、两个 access 口、两个带 IP 的 Vlanif。先 display ip routing-table 看直连路由，再跑 PC1 → PC2。", "display ip routing-table");
  }

  const done = finishGuide(sw);
  if(done) return G(done.phase, done.why, done.cmd);
  return G("enter", "<" + ctx.dev + "> 是用户视图，只能看不能改。改配置前先 system-view。", "system-view");
}

/* ---------------- 板块 ---------------- */
function portOk(S, pn, vid){
  const p = S.SW1.ports[pn];
  return !!p && p.type === "access" && p.pvid === vid;
}

const steps = [
  {
    id: 1, name: "基线 · 网关不在线", key: true, keepTrace: true,
    run: async api => {
      await api.run(["display ip routing-table", "display arp"]);
      api.play(routeScene(api.S, "fwd"));
    },
    summary: "两台 PC 都有 IP 和网关，但网关 IP 没有人在线",
    detail: [
      { h: "看到什么", p: "路由表里只有 127.x 那几条系统路由，一个业务网段都没有；ARP 表为空。" },
      { h: "为什么 ping 不通", p: "PC1 要发给网关 192.168.10.1，先发 ARP 问「谁是这个地址」。交换机上<b>没有 Vlanif10</b>，这个 IP 就没有主，ARP 没有应答，ICMP 根本发不出去。" },
      { h: "反直觉的点", p: "两台 PC 的网关都配得没错、链路也都 up，但「网关」不是一台真实存在的设备，而是交换机上的一个虚拟三层口——不配它，地址就是空的。" }
    ]
  },
  {
    id: 2, name: "建 VLAN 表", key: false,
    done: S => !!S.SW1.vlans[10] && !!S.SW1.vlans[20],
    run: async api => { await api.run(["return", "system-view", "vlan batch 10 20"]); },
    summary: "VLAN 表新增 10、20",
    detail: [
      { h: "只是建表", p: "VLAN 表多两行，但<b>没有端口属于它们</b>，也没有三层接口，转发行为一点没变。" },
      { h: "为什么先建", p: "port default vlan 会校验 VLAN 是否存在；Vlanif 也需要 VLAN 才有广播域可挂。" }
    ]
  },
  {
    id: 3, name: "两个 access 口划 VLAN", key: false,
    done: S => portOk(S, "GE0/0/1", 10) && portOk(S, "GE0/0/2", 20),
    run: async api => {
      await api.run(["return", "system-view",
        "interface GigabitEthernet 0/0/1", "port link-type access", "port default vlan 10", "quit",
        "interface GigabitEthernet 0/0/2", "port link-type access", "port default vlan 20", "quit"]);
    },
    summary: "PC1 进 VLAN 10，PC2 进 VLAN 20，广播域被切开",
    detail: [
      { h: "PVID 的意义", p: "GE0/0/1 PVID 10、GE0/0/2 PVID 20。此后两个口收到的无标签帧分别归入各自 VLAN，二层互不相通。" },
      { h: "此时还缺一层", p: "VLAN 有了、端口划好了，但两个网段之间没有任何三层出口——比「全在 VLAN 1」时更不通。" }
    ]
  },
  {
    id: 4, name: "Vlanif10 + 网关 IP", key: false,
    done: S => S.SW1.vlanif[10].ip === "192.168.10.1" && S.SW1.vlanif[10].mask === 24,
    run: async api => {
      await api.run(["return", "system-view", "interface Vlanif 10", "ip address 192.168.10.1 24"]);
    },
    summary: "三层口 Vlanif10 建立，192.168.10.1 成为 VLAN 10 的网关",
    detail: [
      { h: "两条命令两件事", p: "interface Vlanif 10 只是把三层口建出来（unassigned，Protocol down）；ip address 才让它真正可用。" },
      { h: "虚拟接口", p: "Vlanif 没有任何物理形态，它是交换机内部「VLAN 10 这个广播域的三层出口」。PC1 的网关卡就卡在这个地址上。" }
    ]
  },
  {
    id: 5, name: "看直连路由", key: false,
    run: async api => { await api.run(["display ip routing-table", "display ip interface brief"]); },
    summary: "路由表出现 192.168.10.0/24 → Vlanif10",
    detail: [
      { h: "路由从哪来", p: "没人手写这条路由。Vlanif10 的 IP 配上、Protocol up 之后，设备<b>自动派生</b>直连路由 192.168.10.0/24，出接口 Vlanif10。" },
      { h: "还有一条 /32", p: "192.168.10.1/32 指向 127.0.0.1，是接口地址自己的主机路由，也是自动生成的。" }
    ]
  },
  {
    id: 6, name: "Vlanif20 + 网关 IP", key: false,
    done: S => S.SW1.vlanif[20].ip === "192.168.20.1" && S.SW1.vlanif[20].mask === 24,
    run: async api => {
      await api.run(["return", "system-view", "interface Vlanif 20", "ip address 192.168.20.1 24"]);
    },
    summary: "第二个三层口就位，两个网段各有一个网关",
    detail: [
      { h: "为什么要两个", p: "三层转发是「一个口进、另一个口出」。只有 Vlanif10 时，去 192.168.20.0/24 的报文查不到出接口。" },
      { h: "地址归属", p: "192.168.20.1 与 PC2 同网段，PC2 的默认网关才真正有人应答。" }
    ]
  },
  {
    id: 7, name: "测试 · 应该成功", key: true, keepTrace: true,
    run: api => { api.play(routeScene(api.S, "fwd")); },
    summary: "PC1 → PC2 通，报文在交换机内部被三层转发一次",
    detail: [
      { h: "看帧的形状", p: "前两段是 ARP（广播虚线），中间绿色那段是设备内部的三层跳，后面的帧 MAC 已经换了——但 IP 一直是 PC1 → PC2。" },
      { h: "关键判读", p: "源 MAC 每跳都变，目的 IP 始终不变。二层靠 MAC 走一段，三层靠 IP 走到底。" }
    ]
  },
  {
    id: 8, name: "看 ARP 表", key: false,
    run: async api => { await api.run(["display arp"]); },
    summary: "网关学到两台 PC 的 MAC，主机学到网关的 MAC",
    detail: [
      { h: "两个方向", p: "交换机侧：192.168.10.10 → 5489-98a1-0001、192.168.20.10 → 5489-98a1-0002。" },
      { h: "主机侧", p: "PC1 的 ARP 缓存记录「192.168.10.1 → " + VIF_MAC[10] + "」，PC2 记录「192.168.20.1 → " + VIF_MAC[20] + "」。交换机表里看不到主机自己的缓存。" }
    ]
  },
  {
    id: 9, name: "扰动 · 删掉 Vlanif20", key: true, keepTrace: true,
    done: S => S.SW1.vlanif[20].ever && !S.SW1.vlanif[20].exists && S.SW1.vlanif[10].up,
    run: async api => {
      await api.run(["return", "system-view", "undo interface Vlanif 20"]);
      api.play(routeScene(api.S, "fwd"));
    },
    summary: "VLAN 20 的直连路由消失，PC1 → PC2 立即不通",
    detail: [
      { h: "同时消失的东西", p: "Vlanif20 的 IP、网关 192.168.20.1、直连路由 192.168.20.0/24，以及 VLAN 20 的 ARP 表项。" },
      { h: "没有消失的东西", p: "VLAN 20 本身、GE0/0/2 的 PVID、链路灯。VLAN 20 内部两台主机仍然二层相通——断的只是跨网段那一段。" },
      { h: "反直觉的点", p: "物理口全 up、VLAN 全在，业务却断了。三层问题只能到路由表和接口状态里找，看灯永远看不出来。" }
    ]
  },
  {
    id: 10, name: "收尾 · 对照校验", key: false,
    run: async api => {
      await api.run(["display ip routing-table", "display ip interface brief", "display arp"]);
    },
    summary: "路由表与接口状态互相对照",
    detail: [
      { h: "对照顺序", p: "display ip interface brief 看 Vlanif 的 Physical / Protocol → display ip routing-table 看有没有对应的直连路由 → display arp 看邻居学到没有。" },
      { h: "判读口诀", p: "接口 Protocol down 就不会有直连路由；没有直连路由，跨网段就没有出接口；没有 ARP，帧封不出来。" }
    ]
  }
];

/* ---------------- 导出 ---------------- */
export default {
  id: "04",
  title: "VLAN 间路由",
  meta: "HUAWEI S5700 · VRP V200R005C00",
  stageLabel: "INTER-VLAN ROUTING · 1 × S5700 · 2 × HOST",
  totalSteps: steps.length,
  devices: ["SW1"],
  tabs: [
    { key: "vlan", label: "VLAN 表", hint: "VLAN 与成员端口" },
    { key: "if", label: "接口与 IP", hint: "Vlanif / 物理口状态" },
    { key: "arp", label: "ARP 表", hint: "网关学到的邻居" },
    { key: "route", label: "路由表", hint: "由 Vlanif 派生的直连路由" }
  ],
  legend: [
    { c: "#38E1FF", label: "VLAN 10" },
    { c: "#FFB545", label: "VLAN 20" },
    { c: "#35E08A", label: "Vlanif 已启用" },
    { c: "#7E93AB", label: "Vlanif 未启用" }
  ],
  phases: { enter: "进系统视图", vlan: "建 VLAN", access: "划端口", vlanif: "建 Vlanif", ip: "配 IP", test: "跑数据面", verify: "校验" },
  viewName: VIEW_NAME,
  viewHint: VIEW_HINT,
  actions: [
    { id: "pc1pc2", label: "PC1 → PC2", run: l => l.playScene(routeScene(l.S, "fwd")) },
    { id: "pc2pc1", label: "PC2 → PC1", run: l => l.playScene(routeScene(l.S, "rev")) },
    {
      id: "undo20", label: "undo Vlanif20",
      run: l => {
        const f = l.S.SW1.vlanif[20];
        if(!f.exists){ l.write("// Vlanif20 本来就不存在。", "op"); return; }
        f.exists = false; f.ip = ""; f.mask = 0; f.up = false; f.phy = false;
        l.S.SW1.arp = l.S.SW1.arp.filter(e => e.vlan !== 20);
        sync(l.S.SW1);
        l.write("// 已删除 Vlanif20（等效 undo interface Vlanif 20）：路由与网关一起消失。", "op");
        l.playScene(routeScene(l.S, "fwd"));
      }
    }
  ],
  createState, prompt, commands, tables, topology, guide, steps,

  idle: {
    title: "三层交换机怎么一回事",
    items: [
      { h: "① 一台设备，两套逻辑", p: "二层交换按 VLAN 隔离广播域；三层转发按路由表把报文从一个 Vlanif 送到另一个 Vlanif。三层交换机就是这两件事做在同一块芯片上。" },
      { h: "② 每个 VLAN 一个虚拟三层口", p: "Vlanif10 / Vlanif20 不是物理端口，而是交换机内部为该 VLAN 创建的三层出口。IP 配在它上面，它就是该 VLAN 所有主机的网关。" },
      { h: "③ 网关不是一个地址，是一个「有人应答」的接口", p: "没有 Vlanif，网关 IP 就没人回 ARP；有了 Vlanif，ARP 有应答、直连路由进表，跨网段才成立。" },
      { h: "④ 判读顺序", p: "VLAN 表（有没有这个广播域）→ 接口与 IP（Vlanif 的 Physical / Protocol）→ 路由表（有没有直连路由）→ ARP 表（邻居学到没有）。" }
    ]
  },

  viewRows(ctx){
    return [
      { h: "<" + ctx.dev + "> 用户视图", p: "只读：display、ping。改配置一律被拒。", cls: ctx.view === "user" ? "pass" : "" },
      { h: "[" + ctx.dev + "] 系统视图", p: "全局入口：vlan batch、interface、undo interface Vlanif。", cls: ctx.view === "system" ? "pass" : "" },
      { h: "[" + ctx.dev + "-GigabitEthernet0/0/1] 接口视图", p: "只作用于当前物理口：port link-type、port default vlan。", cls: ctx.view === "if" ? "pass" : "" },
      { h: "[" + ctx.dev + "-Vlanif10] VLANIF 视图", p: "只作用于这个虚拟三层口：ip address。", cls: ctx.view === "vlanif" ? "pass" : "" }
    ];
  },

  boot(write, printGuide){
    write("Info: 已加载 SW1 出厂配置，两个接入端口都在 VLAN 1，尚未创建任何 Vlanif。", "dim");
    write("      PC1 192.168.10.10/24 · 网关 192.168.10.1 ｜ PC2 192.168.20.10/24 · 网关 192.168.20.1", "dim");
    write("      网关还不在线。输入命令，或点击上方 S1…S10 按顺序执行实验步骤。", "dim");
    write("", "dim");
    printGuide();
  }
};

export { HOSTS };
