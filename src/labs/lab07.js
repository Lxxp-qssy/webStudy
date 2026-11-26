import { pad } from "../lib/util.js";

/* =========================================================================
   实验 07 · DHCP 四步交互
   -------------------------------------------------------------------------
   上半段：SW1 自己做 DHCP 服务器，PC1 / PC2 在 VLAN 10（192.168.10.0/24）。
   下半段：R1 做远端 DHCP 服务器（192.168.100.1/24），SW1 的 Vlanif20
           （192.168.20.1/24）对 VLAN 20 做中继，PC3 跨网段拿地址。

   状态（唯一事实来源）：
     vlans / ports        二层：VLAN 与端口 PVID
     vlanif[vid]          三层：虚拟接口、IP、up
     dhcp.enabled         全局开关（总闸）
     dhcp.pools[name]     地址池：network / gateway / dns / range / used / lease
     ifDhcp[vid]          接口级模式：none | global | relay
     relay["Vlanif20"]    中继指向的服务器 IP

   两个关键机关：
     1. global 模式靠「接口网段」匹配地址池，网段不一致就静默失败
     2. 中继把广播改写成单播，giaddr 是服务器选池的唯一依据
   ========================================================================= */

const VLAN_COLOR = { 1: "#7E93AB", 10: "#38E1FF", 20: "#FFB545" };
const vlanColor = v => VLAN_COLOR[v] || "#7C8B9E";
function hexRgb(h){
  const n = parseInt(h.slice(1), 16);
  return ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255);
}

const PORTS = ["GE0/0/1", "GE0/0/2", "GE0/0/3", "GE0/0/23"];
const DEV = {
  SW1: { x: 550, y: 62, w: 300, h: 74, rjRel: [60, 150, 250], sfpRel: 272 },
  R1:  { x: 1010, y: 62, w: 280, h: 74, rjRel: [60] }
};

const HOSTS = {
  PC1: { id: "PC1", mac: "5489-98a1-0001", vlan: 10, port: "GE0/0/1", x: 430, y: 240, gw: "192.168.10.1" },
  PC2: { id: "PC2", mac: "5489-98a1-0002", vlan: 10, port: "GE0/0/2", x: 600, y: 240, gw: "192.168.10.1" },
  PC3: { id: "PC3", mac: "5489-98a1-0003", vlan: 20, port: "GE0/0/3", x: 880, y: 240, gw: "192.168.20.1" }
};

/* 拓扑几何：PC 在下方一排，R1 在 SW1 右上方 */
const ROUTES = {
  "pc1-up":   "M430 236 C430 192 560 168 610 136",
  "pc1-down": "M610 136 C560 168 430 192 430 236",
  "pc2-up":   "M600 236 C600 192 660 168 700 136",
  "pc2-down": "M700 136 C660 168 600 192 600 236",
  "pc3-up":   "M880 236 C880 194 830 168 800 136",
  "pc3-down": "M800 136 C830 168 880 194 880 236",
  "relay-r":  "M843 106 L1070 106",
  "relay-l":  "M1070 106 L843 106"
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
function prefixToMask(p){ return intToIp(maskInt(p)); }
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
function isIp(s){
  const p = String(s).split(".");
  if(p.length !== 4) return false;
  return p.every(x => /^\d+$/.test(x) && +x >= 0 && +x <= 255);
}

/* ---------------- 派生：Vlanif 状态 ---------------- */
function vlanPortUp(sw, vid){
  return Object.keys(sw.ports).some(function(pn){
    const p = sw.ports[pn];
    return p.up && p.type === "access" && p.pvid === vid;
  });
}
function sync(sw){
  Object.keys(sw.vlanif).forEach(function(k){
    const v = Number(k), f = sw.vlanif[v];
    f.phy = !!(f.exists && sw.vlans[v] && vlanPortUp(sw, v));
    f.up = !!(f.phy && f.ip);
  });
}

/* ---------------- 初始状态 ---------------- */
function makeStats(){
  return { discover: 0, offer: 0, request: 0, ack: 0, nak: 0, decline: 0, release: 0, inform: 0 };
}

export function createState(){
  const sw = {
    name: "SW1",
    vlans: {
      1: { name: "VLAN 0001" },
      10: { name: "VLAN 0010" },
      20: { name: "VLAN 0020" }
    },
    ports: {
      "GE0/0/1":  { type: "access", pvid: 10, up: true, ip: "", mask: 0 },
      "GE0/0/2":  { type: "access", pvid: 10, up: true, ip: "", mask: 0 },
      "GE0/0/3":  { type: "access", pvid: 20, up: true, ip: "", mask: 0 },
      "GE0/0/23": { type: "route", pvid: 1, up: true, ip: "192.168.100.2", mask: 24 }
    },
    vlanif: {
      10: { exists: true, ip: "192.168.10.1", mask: 24, up: true, phy: true },
      20: { exists: true, ip: "192.168.20.1", mask: 24, up: true, phy: true }
    },
    ifDhcp: { 10: "none", 20: "none" },
    relay: {},
    dhcp: { enabled: false, pools: {}, stats: makeStats() },
    arp: []
  };
  sync(sw);

  const r1 = {
    name: "R1",
    ports: {
      "GE0/0/0": { type: "route", up: true, ip: "192.168.100.1", mask: 24 }
    },
    vlanif: {},
    ifDhcp: {},
    relay: {},
    dhcp: {
      enabled: true,
      pools: {
        vlan20: {
          name: "vlan20",
          network: "192.168.20.0", mask: 24,
          gateway: "192.168.20.1", dns: "223.5.5.5",
          range: ["192.168.20.1", "192.168.20.254"],
          used: [], lease: 1
        }
      },
      stats: makeStats()
    },
    arp: []
  };

  return { SW1: sw, R1: r1 };
}

/* ---------------- 地址池与绑定 ---------------- */
function poolsOf(dev){
  return dev && dev.dhcp && dev.dhcp.pools ? dev.dhcp.pools : {};
}
function rangeOf(ip, prefix){
  const net = ipToInt(netOf(ip, prefix));
  const size = Math.pow(2, 32 - prefix);
  if(prefix >= 31) return [intToIp(net + 1), intToIp(net + size - 1)];
  return [intToIp(net + 1), intToIp(net + size - 2)];
}
function poolSize(pool){
  if(!pool || !pool.range || !pool.range[0] || !pool.range[1]) return 0;
  const a = ipToInt(pool.range[0]), b = ipToInt(pool.range[1]);
  if(b < a) return 0;
  let n = b - a + 1;
  if(pool.gateway && isIp(pool.gateway)){
    const g = ipToInt(pool.gateway);
    if(g >= a && g <= b) n--;
  }
  return n;
}
function availableIp(pool){
  if(!pool || !pool.network || !pool.range || !pool.range[0]) return null;
  const a = ipToInt(pool.range[0]), b = ipToInt(pool.range[1]);
  for(let n = b; n >= a; n--){
    const ip = intToIp(n);
    if(pool.gateway && ip === pool.gateway) continue;
    if(pool.used.some(u => u.ip === ip)) continue;
    return ip;
  }
  return null;
}
function poolForIf(dev, ifIp, ifMask){
  const pools = poolsOf(dev);
  const names = Object.keys(pools);
  for(let i = 0; i < names.length; i++){
    const p = pools[names[i]];
    if(!p.network || !p.mask) continue;
    if(netOf(p.network, p.mask) === netOf(ifIp, ifMask)) return p;
  }
  return null;
}
function matchingVlanif(sw, pool){
  if(!sw.vlanif || !pool.network || !pool.mask) return null;
  const keys = Object.keys(sw.vlanif).map(Number);
  for(let i = 0; i < keys.length; i++){
    const v = keys[i], f = sw.vlanif[v];
    if(f.exists && f.ip && netOf(f.ip, f.mask) === netOf(pool.network, pool.mask)) return v;
  }
  return null;
}
function reachable(dev, ip){
  if(!isIp(ip)) return false;
  const pn = Object.keys(dev.ports || {});
  for(let i = 0; i < pn.length; i++){
    const p = dev.ports[pn[i]];
    if(p.ip && p.mask && netOf(p.ip, p.mask) === netOf(ip, p.mask)) return true;
  }
  const vn = Object.keys(dev.vlanif || {});
  for(let i = 0; i < vn.length; i++){
    const f = dev.vlanif[vn[i]];
    if(f.exists && f.ip && f.mask && netOf(f.ip, f.mask) === netOf(ip, f.mask)) return true;
  }
  return false;
}
function findBinding(S, hostId){
  const devs = [S.SW1, S.R1];
  for(let i = 0; i < devs.length; i++){
    const dev = devs[i];
    if(!dev || !dev.dhcp) continue;
    const names = Object.keys(dev.dhcp.pools);
    for(let j = 0; j < names.length; j++){
      const p = dev.dhcp.pools[names[j]];
      for(let k = 0; k < p.used.length; k++){
        if(p.used[k].host === hostId) return { dev: dev, pool: p, binding: p.used[k] };
      }
    }
  }
  return null;
}
function hostIp(S, hostId){
  const r = findBinding(S, hostId);
  return r ? r.binding.ip : "0.0.0.0";
}
function plannedIp(S, hostId){
  const ex = findBinding(S, hostId);
  if(ex) return ex.binding.ip;
  const p = dhcpProbe(S, hostId);
  return p.ok ? (availableIp(p.pool) || "") : "";
}

function fail(reason){
  return { ok: false, reason: reason };
}

/* 只判「能不能发地址」，不写绑定 */
function dhcpProbe(S, hostId){
  const h = HOSTS[hostId];
  if(!h) return fail("UNKNOWN HOST");
  const sw = S.SW1;

  if(hostId === "PC3"){
    if(!sw.dhcp.enabled) return fail("DHCP DISABLED");
    if(sw.ifDhcp[20] !== "relay") return fail("NO DHCP SERVICE ON Vlanif20");
    const sip = sw.relay["Vlanif20"];
    if(!sip) return fail("NO RELAY SERVER");
    if(!S.R1 || !S.R1.dhcp.enabled) return fail("SERVER DHCP DISABLED");
    if(!reachable(sw, sip)) return fail("RELAY SERVER UNREACHABLE");
    const f = sw.vlanif[20];
    if(!f || !f.exists || !f.up) return fail("VLANIF20 DOWN");
    const pool = poolForIf(S.R1, f.ip, f.mask);
    if(!pool) return fail("NO POOL ON SERVER");
    if(!availableIp(pool)) return fail("POOL EXHAUSTED");
    return { ok: true, pool: pool, server: "R1", mode: "relay", vlan: 20 };
  }

  const vid = h.vlan;
  if(!sw.dhcp.enabled) return fail("DHCP DISABLED");
  if(sw.ifDhcp[vid] !== "global") return fail("NO DHCP SERVICE ON Vlanif" + vid);
  const f = sw.vlanif[vid];
  if(!f || !f.exists || !f.up) return fail("VLANIF" + vid + " DOWN");
  const pool = poolForIf(sw, f.ip, f.mask);
  if(!pool) return fail("NO POOL MATCH");
  if(!availableIp(pool)) return fail("POOL EXHAUSTED");
  return { ok: true, pool: pool, server: "SW1", mode: "global", vlan: vid };
}

function allocateHost(S, hostId){
  const ex = findBinding(S, hostId);
  if(ex) return { ok: true, ip: ex.binding.ip, existed: true, pool: ex.pool, server: ex.dev.name };
  const p = dhcpProbe(S, hostId);
  if(!p.ok) return p;
  const ip = availableIp(p.pool);
  if(!ip) return fail("POOL EXHAUSTED");
  const h = HOSTS[hostId];
  const b = { ip: ip, mac: h.mac, host: hostId, iface: "Vlanif" + h.vlan, type: "DHCP", lease: p.pool.lease };
  p.pool.used.push(b);
  const srv = hostId === "PC3" ? S.R1 : S.SW1;
  srv.dhcp.stats.discover++;
  srv.dhcp.stats.offer++;
  srv.dhcp.stats.request++;
  srv.dhcp.stats.ack++;
  return { ok: true, ip: ip, existed: false, pool: p.pool, server: srv.name, binding: b };
}

function releaseHost(S, hostId){
  let n = 0;
  [S.SW1, S.R1].forEach(function(dev){
    if(!dev || !dev.dhcp) return;
    Object.keys(dev.dhcp.pools).forEach(function(name){
      const p = dev.dhcp.pools[name];
      const before = p.used.length;
      p.used = p.used.filter(u => u.host !== hostId);
      if(p.used.length < before){
        n += before - p.used.length;
        dev.dhcp.stats.release++;
      }
    });
  });
  return n;
}

/* ---------------- 视图 ---------------- */
const VIEW_NAME = { user: "用户视图", system: "系统视图", if: "接口视图", pool: "地址池视图" };
const VIEW_HINT = { system: "system-view", if: "interface Vlanif 10", pool: "ip pool vlan10" };

function prompt(ctx){
  if(ctx.view === "user") return "<" + ctx.dev + ">";
  if(ctx.view === "system") return "[" + ctx.dev + "]";
  if(ctx.view === "pool") return "[" + ctx.dev + "-ip-pool-" + (ctx.pool || "") + "]";
  return "[" + ctx.dev + "-Vlanif" + ctx.ifName + "]";
}

function modeLabel(m){
  if(m === "global") return "global";
  if(m === "relay") return "relay";
  return "未启用";
}

/* ---------------- 命令表 ---------------- */
const commands = [
  {
    id: "system-view", match: /^(system-view|sys)$/, view: null, kind: "view", usage: "system-view",
    run(api){
      if(api.ctx.view !== "user"){ api.say("Error: Unrecognized command found at '^' position.", "err"); return; }
      api.ctx.view = "system"; api.ctx.ifName = ""; api.ctx.pool = "";
      api.say("Enter system view, return user view with Ctrl+Z.", "dim");
    }
  },
  {
    id: "quit", match: /^(quit|q)$/, view: null, kind: "view", usage: "quit",
    run(api){
      const c = api.ctx;
      if(c.view === "if" || c.view === "pool"){ c.view = "system"; c.ifName = ""; c.pool = ""; }
      else if(c.view === "system"){ c.view = "user"; }
      else api.say("Error: Unrecognized command found at '^' position.", "err");
    }
  },
  {
    id: "return", match: /^(return|ctrl\+z)$/, view: null, kind: "view", usage: "return",
    run(api){ api.ctx.view = "user"; api.ctx.ifName = ""; api.ctx.pool = ""; }
  },
  {
    id: "dhcp-enable", match: /^dhcp enable$/, view: "system", kind: "config", usage: "dhcp enable",
    explain: [
      { h: "总闸", p: "dhcp enable 是全局开关。它不开，地址池、dhcp select、中继全部不生效——报文进来连解析都不做。" },
      { h: "最常见的坑", p: "池配好了、接口也 select global 了，但忘了这一条，PC 永远拿不到地址，而且没有任何报错。" }
    ],
    run(api){
      const sw = api.S[api.ctx.dev];
      if(!sw.dhcp){ api.say("// 当前设备不支持 DHCP 配置。", "op"); return; }
      if(sw.dhcp.enabled){
        api.say("// DHCP 全局开关已经是 enable，命令未产生状态变化。", "op");
        return;
      }
      sw.dhcp.enabled = true;
      api.change("DHCP 全局开关", "disable", "enable", { row: "cfg-10" });
      api.say("// 全局 DHCP 开关已打开。它只是总闸：还要建地址池、在接口上 dhcp select，才会真正发地址。", "op");
      const d = DEV[api.ctx.dev] || DEV.SW1;
      api.fx({ kind: "scan", box: [d.x, d.y, d.w, d.h], color: "#35E08A" });
    }
  },
  {
    id: "ip-pool", match: /^ip pool (\S+)$/, view: "system", kind: "view", usage: "ip pool <vlan10>",
    explain: [
      { h: "建的是空池", p: "ip pool 只创建一张空表：没有网段、没有网关、没有 DNS。真正决定发什么地址的是后面的 network / gateway-list。" },
      { h: "池名是本地标识", p: "vlan10 只是池的名字，和 VLAN 10 没有强制关系；真正对齐的是池的 network 与接口网段。" }
    ],
    run(api, m){
      const sw = api.S[api.ctx.dev];
      const name = m[1];
      if(!/^[A-Za-z0-9_-]{1,31}$/.test(name)){
        api.say("Error: Wrong parameter found at '^' position.", "err");
        api.say("      池名只能用字母、数字、下划线、连字符，最长 31 个字符。", "dim");
        return;
      }
      if(!sw.dhcp.pools[name]){
        sw.dhcp.pools[name] = { name: name, network: "", mask: 0, gateway: "", dns: "", range: ["", ""], used: [], lease: 1 };
        api.change("地址池 " + name, "不存在", "已创建 · 未配置网段", { row: "pool-" + name, kind: "enter" });
        api.say("// 新建地址池 " + name + "：空池，还没有网段、网关、DNS。", "op");
      }else{
        api.say("// 地址池 " + name + " 已存在，直接进入编辑视图。", "op");
      }
      api.ctx.view = "pool"; api.ctx.pool = name; api.ctx.ifName = "";
      api.tab("pool");
    }
  },
  {
    id: "network", match: /^network ([\d.]+) mask (\d+|[\d.]+)$/, view: "pool", kind: "config",
    usage: "network <192.168.10.0> mask <255.255.255.0>",
    explain: [
      { h: "决定可分配范围", p: "network 决定池的网段，可用范围随之变成「网络地址 +1 ~ 广播地址 -1」。" },
      { h: "必须和接口网段一致", p: "global 模式下，设备拿收到请求的接口 IP + 掩码去匹配池的 network。不一致就选不中池：不回 Offer，也不回 NAK。" }
    ],
    run(api, m){
      const sw = api.S[api.ctx.dev];
      const pool = sw.dhcp.pools[api.ctx.pool];
      if(!pool){ api.say("Error: The address pool does not exist.", "err"); return; }
      if(!isIp(m[1])){ api.say("Error: Wrong parameter found at '^' position.", "err"); return; }
      const mask = maskToPrefix(m[2]);
      if(!mask){ api.say("Error: Wrong parameter found at '^' position.", "err"); return; }
      const net = netOf(m[1], mask);
      if(pool.network === net && pool.mask === mask){
        api.say("// 池 " + pool.name + " 的网段本来就是 " + net + "/" + mask + "，命令未产生状态变化。", "op");
        return;
      }
      const old = pool.network ? pool.network + "/" + pool.mask : "未配置";
      pool.network = net;
      pool.mask = mask;
      pool.range = rangeOf(net, mask);
      pool.used = [];
      api.change("池 " + pool.name + " · network", old, net + "/" + mask, { row: "pool-" + pool.name });
      api.say("// 池 " + pool.name + " 的网段设为 " + net + "/" + mask + "，可分配范围 " + pool.range[0] + " ~ " + pool.range[1] + "；换网段会清空旧绑定。", "op");
      if(sw.name === "SW1"){
        const hit = matchingVlanif(sw, pool);
        if(hit) api.say("// 与 Vlanif" + hit + "（" + sw.vlanif[hit].ip + "/" + sw.vlanif[hit].mask + "）匹配，global 模式可以选中它。", "op");
        else api.say("// 注意：没有任何 Vlanif 的网段与这个池一致。global 模式会匹配不到，客户端拿不到地址（静默失败）。", "op");
      }
      api.tab("pool");
    }
  },
  {
    id: "gateway-list", match: /^gateway-list ([\d.]+)$/, view: "pool", kind: "config",
    usage: "gateway-list <192.168.10.1>",
    explain: [
      { h: "发给客户端的默认网关", p: "这个地址不会自动配置到设备上，它只是随 Offer / ACK 下发给客户端。通常就是对应 Vlanif 的 IP。" }
    ],
    run(api, m){
      const sw = api.S[api.ctx.dev];
      const pool = sw.dhcp.pools[api.ctx.pool];
      if(!pool){ api.say("Error: The address pool does not exist.", "err"); return; }
      if(!isIp(m[1])){ api.say("Error: Wrong parameter found at '^' position.", "err"); return; }
      if(pool.gateway === m[1]){
        api.say("// 池 " + pool.name + " 的 gateway-list 本来就是 " + m[1] + "，命令未产生状态变化。", "op");
        return;
      }
      const old = pool.gateway || "未配置";
      pool.gateway = m[1];
      api.change("池 " + pool.name + " · gateway-list", old, m[1], { row: "pool-" + pool.name });
      api.say("// 池 " + pool.name + " 的默认网关为 " + m[1] + "，会随 Offer / ACK 下发给客户端。", "op");
      api.tab("pool");
    }
  },
  {
    id: "dns-list", match: /^dns-list ([\d.]+)$/, view: "pool", kind: "config",
    usage: "dns-list <223.5.5.5>",
    explain: [
      { h: "随租约一起下发", p: "DNS 也是 DHCP 选项之一（Option 6）。客户端拿到地址的同时，也会把 DNS 配到网卡上。" }
    ],
    run(api, m){
      const sw = api.S[api.ctx.dev];
      const pool = sw.dhcp.pools[api.ctx.pool];
      if(!pool){ api.say("Error: The address pool does not exist.", "err"); return; }
      if(!isIp(m[1])){ api.say("Error: Wrong parameter found at '^' position.", "err"); return; }
      if(pool.dns === m[1]){
        api.say("// 池 " + pool.name + " 的 dns-list 本来就是 " + m[1] + "，命令未产生状态变化。", "op");
        return;
      }
      const old = pool.dns || "未配置";
      pool.dns = m[1];
      api.change("池 " + pool.name + " · dns-list", old, m[1], { row: "pool-" + pool.name });
      api.say("// 池 " + pool.name + " 的 DNS 为 " + m[1] + "（Option 6），随租约下发。", "op");
      api.tab("pool");
    }
  },
  {
    id: "lease", match: /^lease day (\d+)$/, view: "pool", kind: "config", usage: "lease day <1>",
    explain: [
      { h: "租期", p: "租期决定客户端多久续租一次。本实验只演示首次分配，不模拟 T1/T2 续租过程。" }
    ],
    run(api, m){
      const sw = api.S[api.ctx.dev];
      const pool = sw.dhcp.pools[api.ctx.pool];
      if(!pool){ api.say("Error: The address pool does not exist.", "err"); return; }
      const n = parseInt(m[1], 10);
      if(n < 1 || n > 999){ api.say("Error: Wrong parameter found at '^' position.", "err"); return; }
      if(pool.lease === n){
        api.say("// 池 " + pool.name + " 的租期本来就是 " + n + " 天，命令未产生状态变化。", "op");
        return;
      }
      const old = pool.lease + " 天";
      pool.lease = n;
      api.change("池 " + pool.name + " · lease", old, n + " 天", { row: "pool-" + pool.name });
      api.say("// 池 " + pool.name + " 的租期改为 " + n + " 天。", "op");
      api.tab("pool");
    }
  },
  {
    id: "if-vlanif", match: /^interface\s+[Vv]lanif\s*(\d+)$/, view: "system", kind: "view",
    usage: "interface Vlanif <10>",
    explain: [
      { h: "接口级开关", p: "Vlanif 是三层口。DHCP 服务不是全局一开就自动挂在每个接口上，必须在需要发地址的接口上 dhcp select。" }
    ],
    run(api, m){
      const sw = api.S[api.ctx.dev];
      const vid = parseInt(m[1], 10);
      if(!sw.vlanif || !sw.vlanif[vid] || !sw.vlanif[vid].exists){
        api.say("Error: The VLANIF interface does not exist.", "err");
        return;
      }
      api.ctx.view = "if"; api.ctx.ifName = String(vid); api.ctx.pool = "";
      api.tab("dhcp");
    }
  },
  {
    id: "dhcp-select", match: /^dhcp select (global|relay)$/, view: "if", kind: "config",
    usage: "dhcp select <global|relay>",
    explain: [
      { h: "接口告诉设备用哪种模式", p: "global：用本机的全局地址池；relay：把报文转给远端服务器。没有 select，接口就不提供 DHCP 服务。" },
      { h: "配了一半的典型", p: "只建池不 select，等于池摆在那里没人用；只 select 不建池，客户端会静默超时。" }
    ],
    run(api, m){
      const sw = api.S[api.ctx.dev];
      const vid = parseInt(api.ctx.ifName, 10);
      const f = sw.vlanif && sw.vlanif[vid];
      if(!f || !f.exists){ api.say("Error: The VLANIF interface does not exist.", "err"); return; }
      const mode = m[1];
      const old = sw.ifDhcp[vid] || "none";
      if(old === mode){
        api.say("// Vlanif" + vid + " 已经是 " + mode + " 模式，命令未产生状态变化。", "op");
        return;
      }
      sw.ifDhcp[vid] = mode;
      api.change("Vlanif" + vid + ".dhcp-select", modeLabel(old), modeLabel(mode), { row: "cfg-" + vid });
      api.tab("dhcp");
      if(!sw.dhcp.enabled) api.say("// 全局 DHCP 还没开（dhcp enable），这条配置先记下，但不会生效。", "op");
      if(mode === "global"){
        const pool = poolForIf(sw, f.ip, f.mask);
        if(pool) api.say("// Vlanif" + vid + " 选择全局地址池，按接口网段 " + netOf(f.ip, f.mask) + "/" + f.mask + " 匹配到池 " + pool.name + "。", "op");
        else api.say("// Vlanif" + vid + " 选了 global，但当前没有网段匹配的地址池 —— 客户端拿不到地址，也收不到 NAK（静默失败）。", "op");
        const port = vid === 10 ? "GE0/0/1" : vid === 20 ? "GE0/0/3" : "";
        if(port) api.fx({ kind: "pulse", target: api.ctx.dev + "/" + port, color: "#35E08A" });
      }else{
        api.say("// Vlanif" + vid + " 改为 DHCP 中继模式，还需要 dhcp relay server-ip 指定服务器。", "op");
      }
    }
  },
  {
    id: "relay-server", match: /^dhcp relay server-ip ([\d.]+)$/, view: "if", kind: "config",
    usage: "dhcp relay server-ip <192.168.100.1>",
    explain: [
      { h: "只写在 relay 接口上", p: "这条命令告诉 Vlanif20：收到的 DHCP 广播要单播给哪个服务器。接口不是 relay 模式时，它不会生效。" },
      { h: "giaddr 从哪来", p: "SW1 转发时把 giaddr 改写成收到广播的接口地址 192.168.20.1，服务器靠它判断客户端属于哪个网段。" }
    ],
    run(api, m){
      const sw = api.S[api.ctx.dev];
      const vid = parseInt(api.ctx.ifName, 10);
      const ip = m[1];
      if(!sw.vlanif || !sw.vlanif[vid]){ api.say("Error: The VLANIF interface does not exist.", "err"); return; }
      if(!isIp(ip)){ api.say("Error: Wrong parameter found at '^' position.", "err"); return; }
      const key = "Vlanif" + vid;
      const old = sw.relay[key] || "未配置";
      sw.relay[key] = ip;
      api.change(key + ".relay-server", old, ip, { row: "cfg-" + vid });
      api.tab("dhcp");
      if(sw.ifDhcp[vid] !== "relay") api.say("// 当前 " + key + " 不是 relay 模式，先 dhcp select relay，这条 server-ip 才会被使用。", "op");
      if(!reachable(sw, ip)) api.say("// SW1 上没有覆盖 " + ip + " 的三层接口，中继报文发不出去。", "op");
      else api.say("// " + key + " 的 DHCP 中继指向 " + ip + "；收到广播后会把 giaddr 改写为 " + sw.vlanif[vid].ip + " 再单播过去。", "op");
    }
  },

  /* ---- 只读命令 ---- */
  {
    id: "display-ip-pool", match: /^display ip pool$/, view: null, kind: "doc", usage: "display ip pool",
    doc: "地址池表回答：每个池的网段、网关、已用 / 空闲。global 模式下，接口按<b>自己的网段</b>去匹配池；网段不一致就静默失败。",
    run(api){
      const sw = api.S[api.ctx.dev];
      const names = Object.keys(poolsOf(sw));
      if(!names.length){
        api.say("// 当前设备没有任何地址池。先 system-view → dhcp enable → ip pool <name>。", "op");
        api.tab("pool");
        return;
      }
      names.forEach(function(n, i){
        if(i) api.say("", "dim");
        printPool(api, poolsOf(sw)[n], sw);
      });
      if(sw.name === "R1") api.say("// R1 是远端服务器：按中继报文里的 giaddr（192.168.20.1）选池 vlan20。", "op");
      api.tab("pool");
    }
  },
  {
    id: "display-ip-pool-name", match: /^display ip pool name (\S+)$/, view: null, kind: "doc",
    usage: "display ip pool name <vlan10>",
    doc: "按名字看一个池的细节。重点对照：Network 是否等于对应 Vlanif 的网段、Used / Idle 是否与绑定表一致。",
    run(api, m){
      const sw = api.S[api.ctx.dev];
      const pool = poolsOf(sw)[m[1]];
      if(!pool){ api.say("Error: The address pool does not exist.", "err"); return; }
      printPool(api, pool, sw);
      api.tab("pool");
    }
  },
  {
    id: "display-dhcp-stats", match: /^display dhcp server statistics$/, view: null, kind: "doc",
    usage: "display dhcp server statistics",
    doc: "统计计数回答：服务器收到多少 Discover / Request、发出多少 Offer / ACK / NAK。<b>NAK 为 0 不代表没问题</b>——池没匹配上时服务器根本不会回 NAK。",
    run(api){
      const sw = api.S[api.ctx.dev];
      const st = sw.dhcp.stats;
      api.say("DHCP Server Statistics:", "dim");
      api.say("  Dhcp Packet Received:", "dim");
      api.say(pad("    Discover", 28) + ": " + st.discover);
      api.say(pad("    Request", 28) + ": " + st.request);
      api.say(pad("    Decline", 28) + ": " + st.decline);
      api.say(pad("    Release", 28) + ": " + st.release);
      api.say(pad("    Inform", 28) + ": " + st.inform);
      api.say("  Dhcp Packet Sent:", "dim");
      api.say(pad("    Offer", 28) + ": " + st.offer);
      api.say(pad("    ACK", 28) + ": " + st.ack);
      api.say(pad("    NAK", 28) + ": " + st.nak);
      api.say("", "dim");
      if(sw.name === "SW1") api.say("// 这里只统计 SW1 作为本地服务器处理过的报文。PC3 走中继，Discover 转发给 R1，不计入这张表。", "op");
      else api.say("// R1 作为远端服务器，统计的是经 SW1 中继过来的请求。", "op");
    }
  },
  {
    id: "display-dhcp-relay", match: /^display dhcp relay information$/, view: null, kind: "doc",
    usage: "display dhcp relay information",
    doc: "中继配置表回答：哪个接口开了 relay、指向哪台服务器、改写后的 giaddr 是什么。",
    run(api){
      const sw = api.S[api.ctx.dev];
      const keys = Object.keys(sw.relay || {});
      if(!keys.length){
        api.say("// 当前没有配置 DHCP 中继。", "op");
        return;
      }
      api.say(" DHCP relay agent information", "dim");
      api.say(" ------------------------------------------------------------------------------", "dim");
      api.say(pad(" Interface", 24) + pad("Server-IP", 20) + "giaddr", "dim");
      api.say(" ------------------------------------------------------------------------------", "dim");
      keys.forEach(function(k){
        const vid = parseInt(String(k).replace("Vlanif", ""), 10);
        const f = sw.vlanif[vid];
        api.say(pad(" " + k, 24) + pad(sw.relay[k], 20) + (f ? f.ip : "—"));
      });
      api.say(" ------------------------------------------------------------------------------", "dim");
      api.say("// 客户端看到的是广播，服务器看到的是「giaddr = 192.168.20.1」的单播。中继设备夹在中间改写。", "op");
      api.tab("dhcp");
    }
  },
  {
    id: "display-ip-in-use", match: /^display dhcp server ip-in-use$/, view: null, kind: "doc",
    usage: "display dhcp server ip-in-use",
    doc: "绑定表回答：哪个 IP 分给了哪个 MAC、租期多久、属于哪个接口。中继场景下，绑定写在<b>服务器</b>上，不写在转发设备上。",
    run(api){
      const sw = api.S[api.ctx.dev];
      const rows = [];
      const pools = poolsOf(sw);
      Object.keys(pools).forEach(function(n){
        pools[n].used.forEach(function(u){
          rows.push({ ip: u.ip, mac: u.mac, lease: u.lease, type: u.type, iface: u.iface });
        });
      });
      if(!rows.length){
        api.say("// 地址池里还没有绑定记录。", "op");
        api.tab("bind");
        return;
      }
      rows.sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
      api.say(pad("IP ADDRESS", 18) + pad("MAC ADDRESS", 18) + pad("LEASE", 9) + pad("TYPE", 8) + "INTERFACE", "dim");
      api.say(" ------------------------------------------------------------------------------", "dim");
      rows.forEach(function(r){
        api.say(pad(r.ip, 18) + pad(r.mac, 18) + pad(r.lease + "d", 9) + pad(r.type, 8) + r.iface);
      });
      api.say("", "dim");
      if(sw.name === "SW1") api.say("// PC3 走中继，绑定记录在 R1 的池 vlan20 里，不在 SW1。", "op");
      api.tab("bind");
    }
  },
  {
    id: "display-ip-brief", match: /^display ip interface brief$/, view: null, kind: "doc",
    usage: "display ip interface brief",
    doc: "接口表回答：哪些三层口 up、地址是什么。DHCP 要正常工作，对应 Vlanif 必须 Protocol up。",
    run(api){
      const sw = api.S[api.ctx.dev];
      api.lines(["PHY: Physical", "*down: administratively down", "(l): loopback", "(s): spoofing", ""], "dim");
      api.say(pad("Interface", 30) + pad("IP Address/Mask", 22) + pad("Physical", 11) + "Protocol", "dim");
      api.say(" ------------------------------------------------------------------------------", "dim");
      if(sw.name === "SW1"){
        Object.keys(sw.vlanif).map(Number).sort((a, b) => a - b).forEach(function(v){
          const f = sw.vlanif[v];
          if(!f.exists) return;
          api.say(pad("Vlanif" + v, 30) + pad(f.ip ? f.ip + "/" + f.mask : "unassigned", 22) +
            pad(f.phy ? "up" : "down", 11) + (f.up ? "up" : "down"));
        });
      }
      Object.keys(sw.ports).forEach(function(pn){
        const p = sw.ports[pn];
        if(!p.ip) return;
        api.say(pad("GigabitEthernet" + pn.slice(2), 30) + pad(p.ip + "/" + p.mask, 22) +
          pad(p.up ? "up" : "down", 11) + (p.up ? "up" : "down"));
      });
      api.tab("if");
    }
  },
  {
    id: "display-current", match: /^display current-configuration$/, view: null, kind: "doc",
    usage: "display current-configuration",
    doc: "设备上真正生效的配置。把它和表项对照：dhcp enable、地址池、Vlanif 上的 select，三样齐了才会发地址。",
    run(api){
      const sw = api.S[api.ctx.dev];
      api.say("#", "dim");
      api.say("sysname " + sw.name);
      api.say("#", "dim");
      if(sw.dhcp.enabled) api.say("dhcp enable");
      const pools = poolsOf(sw);
      Object.keys(pools).forEach(function(n){
        const p = pools[n];
        api.say("#", "dim");
        api.say("ip pool " + p.name);
        if(p.network) api.say(" network " + p.network + " mask " + prefixToMask(p.mask));
        if(p.gateway) api.say(" gateway-list " + p.gateway);
        if(p.dns) api.say(" dns-list " + p.dns);
        if(p.lease !== 1) api.say(" lease day " + p.lease);
      });
      Object.keys(sw.vlanif || {}).map(Number).sort((a, b) => a - b).forEach(function(v){
        const f = sw.vlanif[v];
        if(!f.exists) return;
        api.say("#", "dim");
        api.say("interface Vlanif" + v);
        if(f.ip) api.say(" ip address " + f.ip + " " + prefixToMask(f.mask));
        if(sw.ifDhcp[v] === "global") api.say(" dhcp select global");
        if(sw.ifDhcp[v] === "relay"){
          api.say(" dhcp select relay");
          if(sw.relay["Vlanif" + v]) api.say(" dhcp relay server-ip " + sw.relay["Vlanif" + v]);
        }
      });
      Object.keys(sw.ports).forEach(function(pn){
        const p = sw.ports[pn];
        if(!p.ip) return;
        api.say("#", "dim");
        api.say("interface GigabitEthernet" + pn.slice(2));
        api.say(" ip address " + p.ip + " " + prefixToMask(p.mask));
      });
      api.say("#", "dim");
      api.say("return");
    }
  },
  {
    id: "ipconfig", match: /^ipconfig(\s+\/all)?$/, view: null, kind: "doc", usage: "ipconfig",
    doc: "ipconfig 读的是<b>主机自己的网卡配置</b>，不是交换机表项。地址来自 DHCP 租约；租约没建立时 IPv4 地址、掩码、网关全是 0.0.0.0。",
    run(api){
      api.say("// PC 侧命令：本实验把 PC1 / PC2 / PC3 的 ipconfig 合并显示。", "op");
      api.say("", "dim");
      api.say("Windows IP Configuration", "dim");
      ["PC1", "PC2", "PC3"].forEach(function(k){
        const h = HOSTS[k];
        const ip = hostIp(api.S, k);
        const has = ip !== "0.0.0.0";
        api.say("", "dim");
        api.say("以太网适配器 Ethernet0:  （" + k + " · VLAN " + h.vlan + "）");
        api.say("   IPv4 地址 . . . . . . . : " + (has ? ip : "0.0.0.0"));
        api.say("   子网掩码  . . . . . . . : " + (has ? "255.255.255.0" : "0.0.0.0"));
        api.say("   默认网关. . . . . . . . : " + (has ? h.gw : "0.0.0.0"));
      });
      api.say("", "dim");
      api.say("// 0.0.0.0 表示 DHCP 还没拿到租约；拿到地址后，网关和 DNS 也会随租约一起落到网卡上。", "op");
    }
  }
];

/* ---------------- 地址池打印 ---------------- */
function printPool(api, p, sw){
  api.say("  Pool-name      : " + p.name);
  api.say("  Gateway-list   : " + (p.gateway || "--"));
  api.say("  Network        : " + (p.network ? p.network + " mask " + prefixToMask(p.mask) : "unconfigured"));
  api.say("  DNS-list       : " + (p.dns || "--"));
  api.say("  Lease          : " + p.lease + " day 0 hour 0 minute");
  api.say("  Used           : " + p.used.length);
  api.say("  Idle           : " + Math.max(0, poolSize(p) - p.used.length));
  if(sw && sw.name === "SW1" && p.network && !matchingVlanif(sw, p))
    api.say("  // 网段与任何 Vlanif 都不匹配：global 模式选不中这个池", "op");
}

/* ---------------- 表项 ---------------- */
function poolNote(dev){
  if(dev.name === "R1")
    return "R1 是远端服务器：按中继报文里的 giaddr 选池。池内同样从<b>最大</b>地址开始分配（.254 → .253）。";
  return "USED = 已绑定数，IDLE = 剩余可分配。VRP 默认从池内<b>最大</b>的地址开始分配（.254 → .253）。global 模式下接口按自己的网段匹配池。";
}

function poolTable(S, dev){
  const pools = poolsOf(dev);
  const names = Object.keys(pools);
  const head = ["POOL", "NETWORK", "GATEWAY", "USED", "IDLE", "LEASE"];
  if(!names.length){
    return { head: head, rows: [], empty: "还没有地址池 · 先 dhcp enable，再 ip pool vlan10", note: poolNote(dev) };
  }
  const rows = names.map(function(n){
    const p = pools[n];
    const used = p.used.length;
    const idle = Math.max(0, poolSize(p) - used);
    const mism = dev.name === "SW1" && p.network && !matchingVlanif(dev, p);
    return {
      key: "pool-" + n,
      cells: [
        { t: n, cls: "c" },
        { t: p.network ? p.network + "/" + p.mask : "未配置", cls: mism ? "bad" : "c" },
        { t: p.gateway || "—", cls: "c" },
        { t: used, cls: used ? "ok" : "c" },
        { t: idle, cls: "c" },
        { t: p.lease + " 天", cls: "c" }
      ]
    };
  });
  return { head: head, rows: rows, note: poolNote(dev) };
}

function bindTable(S, dev){
  const pools = poolsOf(dev);
  const rows = [];
  Object.keys(pools).forEach(function(n){
    pools[n].used.forEach(function(u){
      rows.push({
        key: "bind-" + u.ip,
        cells: [
          { t: u.ip, cls: "c" },
          { t: u.mac, cls: "c" },
          { t: u.lease + " 天", cls: "c" },
          { t: "DHCP", cls: "ok" },
          { t: u.iface, cls: u.iface === "Vlanif10" ? "v10" : u.iface === "Vlanif20" ? "v20" : "c" }
        ]
      });
    });
  });
  rows.sort(function(a, b){ return ipToInt(a.cells[0].t) - ipToInt(b.cells[0].t); });
  return {
    head: ["IP", "MAC", "LEASE", "TYPE", "INTERFACE"],
    rows: rows,
    empty: "还没有绑定 · 让 PC 跑一次 DHCP 交互",
    note: "绑定是服务器侧的租约记录：IP、客户端 MAC、租期、类型。中继场景下，记录写在 R1 上，SW1 只转发报文。"
  };
}

function dhcpStatus(S, v){
  const sw = S.SW1;
  const f = sw.vlanif[v];
  const mode = sw.ifDhcp[v] || "none";
  if(!sw.dhcp.enabled) return { server: "—", status: "全局 DHCP 未开启", cls: "bad" };
  if(mode === "none") return { server: "—", status: "未提供 DHCP", cls: "dim" };
  if(mode === "global"){
    const p = poolForIf(sw, f.ip, f.mask);
    if(p) return { server: p.name, status: "运行中 · 地址池匹配", cls: "ok" };
    if(Object.keys(poolsOf(sw)).length) return { server: "池网段不匹配", status: "无匹配地址池 · 静默失败", cls: "bad" };
    return { server: "—", status: "还没有地址池", cls: "bad" };
  }
  const sip = sw.relay["Vlanif" + v];
  if(!sip) return { server: "—", status: "缺 relay server-ip", cls: "bad" };
  if(!S.R1 || !S.R1.dhcp.enabled) return { server: sip, status: "服务器未开 DHCP", cls: "bad" };
  const p = poolForIf(S.R1, f.ip, f.mask);
  if(p) return { server: sip, status: "中继运行中 · 池 " + p.name, cls: "ok" };
  return { server: sip, status: "服务器无匹配池", cls: "bad" };
}

function dhcpTable(S, dev){
  const head = ["VLANIF", "模式", "服务器", "状态"];
  if(dev.name === "R1"){
    const p = poolsOf(dev).vlan20;
    return {
      head: head,
      rows: [{
        key: "cfg-r1",
        cells: [
          { t: "Vlanif20（远端）", cls: "c" },
          { t: "server", cls: "ok" },
          { t: "192.168.100.1", cls: "c" },
          { t: dev.dhcp.enabled ? (p ? "运行中 · 池 vlan20" : "无地址池") : "未开启",
            cls: dev.dhcp.enabled && p ? "ok" : "bad" }
        ]
      }],
      note: "R1 是远端 DHCP 服务器。它听不到 PC3 的广播，只收到 SW1 中继过来的单播报文，靠 giaddr 判断网段。"
    };
  }
  const sw = S.SW1;
  const rows = [10, 20].map(function(v){
    const st = dhcpStatus(S, v);
    return {
      key: "cfg-" + v,
      cells: [
        { t: "Vlanif" + v, cls: "c" },
        { t: modeLabel(sw.ifDhcp[v] || "none"), cls: sw.ifDhcp[v] === "global" ? "ok" : sw.ifDhcp[v] === "relay" ? "warn" : "dim" },
        { t: st.server, cls: "c" },
        { t: st.status, cls: st.cls }
      ]
    };
  });
  return {
    head: head,
    rows: rows,
    note: "global 靠接口网段匹配池；relay 把广播改写成单播，靠 giaddr 让服务器选池。两种模式都要求全局 dhcp enable 已打开。"
  };
}

function ifTable(S, dev){
  const rows = [];
  if(dev.name === "SW1"){
    Object.keys(dev.vlanif).map(Number).sort((a, b) => a - b).forEach(function(v){
      const f = dev.vlanif[v];
      rows.push({
        key: "if-Vlanif" + v,
        cells: [
          { t: "Vlanif" + v, cls: "c" },
          { t: "三层", cls: "c" },
          { t: f.exists ? f.ip + "/" + f.mask : "unassigned", cls: f.up ? (v === 10 ? "v10" : "v20") : "c" },
          { t: f.phy ? "up" : "down", cls: "c" },
          { t: f.up ? "up" : "down", cls: "c" }
        ]
      });
    });
  }
  Object.keys(dev.ports).forEach(function(pn){
    const p = dev.ports[pn];
    rows.push({
      key: "if-" + pn,
      cells: [
        { t: pn, cls: "c" },
        { t: p.type === "route" ? "三层（路由口）" : "access · PVID " + p.pvid,
          cls: p.pvid === 10 ? "v10" : p.pvid === 20 ? "v20" : "c" },
        { t: p.ip ? p.ip + "/" + p.mask : "—", cls: "c" },
        { t: p.up ? "up" : "down", cls: "c" },
        { t: p.up ? "up" : "down", cls: "c" }
      ]
    });
  });
  return {
    head: ["INTERFACE", "类型", "地址 / 归属", "PHY", "PROTOCOL"],
    rows: rows,
    note: "Vlanif 是交换机内部的虚拟三层口；GE0/0/23 是通向 R1 的三层互联口，中继报文从这里单播出去。"
  };
}

function tables(S, tab, ctx){
  const dev = S[ctx.dev] || S.SW1;
  if(tab === "pool") return poolTable(S, dev);
  if(tab === "bind") return bindTable(S, dev);
  if(tab === "dhcp") return dhcpTable(S, dev);
  return ifTable(S, dev);
}

/* ---------------- 拓扑 ---------------- */
function vlanifLabel(sw, v){
  const f = sw.vlanif[v];
  if(!f || !f.exists) return "Vlanif" + v + "  —";
  if(!f.ip) return "Vlanif" + v + "  unassigned";
  const mode = sw.ifDhcp[v];
  return "Vlanif" + v + "  " + f.ip + "/" + f.mask + (mode === "global" ? "  global" : mode === "relay" ? "  relay" : "");
}
function vlanifCls(sw, v){
  const f = sw.vlanif[v];
  if(!f || !f.exists || !f.up) return "lk-tag warn";
  if(!sw.dhcp.enabled || !sw.ifDhcp[v] || sw.ifDhcp[v] === "none") return "lk-tag";
  return "lk-tag on";
}

function topology(S, ui, ctx){
  const sw = S.SW1;
  const relayOn = sw.ifDhcp[20] === "relay" && !!sw.relay["Vlanif20"];
  const pc3Ip = hostIp(S, "PC3");

  const devices = [{
    id: "SW1", x: DEV.SW1.x, y: DEV.SW1.y, w: DEV.SW1.w, h: DEV.SW1.h, model: "S5700-28C-EI",
    silk: "M12 24 h60 M12 28 h44 M12 32 h60 M12 36 h44",
    leds: [
      { x: 272, y: 10, color: "#35E08A", glow: true, label: "PWR", tx: 278, ty: 12.5 },
      { x: 258, y: 10, color: "#38E1FF", glow: true, label: "SYS", tx: 232, ty: 12.5 }
    ],
    ports: [
      { name: "GE0/0/1", kind: "rj45", x: DEV.SW1.rjRel[0], y: 44, color: vlanColor(10), up: true, label: "1" },
      { name: "GE0/0/2", kind: "rj45", x: DEV.SW1.rjRel[1], y: 44, color: vlanColor(10), up: true, label: "2" },
      { name: "GE0/0/3", kind: "rj45", x: DEV.SW1.rjRel[2], y: 44, color: vlanColor(20), up: true, label: "3" },
      { name: "GE0/0/23", kind: "sfp", x: DEV.SW1.sfpRel, y: 44, color: "#35E08A", up: true, label: "23" }
    ],
    tags: [
      { x: 0, y: -8, text: "SW1", cls: "dev-label" },
      { x: 34, y: -8, text: "S5700-28C-EI · DHCP 服务器 / 中继", cls: "dev-sub" },
      { x: 150, y: 88, text: vlanifLabel(sw, 10), cls: vlanifCls(sw, 10), anchor: "middle" },
      { x: 150, y: 102, text: vlanifLabel(sw, 20), cls: vlanifCls(sw, 20), anchor: "middle" }
    ]
  }, {
    id: "R1", x: DEV.R1.x, y: DEV.R1.y, w: DEV.R1.w, h: DEV.R1.h, model: "AR2220",
    silk: "M12 24 h60 M12 28 h44 M12 32 h60 M12 36 h44",
    leds: [
      { x: 252, y: 10, color: "#35E08A", glow: true, label: "PWR", tx: 258, ty: 12.5 },
      { x: 238, y: 10, color: "#FFB545", glow: true, label: "ACT", tx: 212, ty: 12.5 }
    ],
    ports: [
      { name: "GE0/0/0", kind: "rj45", x: DEV.R1.rjRel[0], y: 44, color: "#FFB545", up: true, label: "0" }
    ],
    tags: [
      { x: 0, y: -8, text: "R1", cls: "dev-label" },
      { x: 34, y: -8, text: "AR2220 · 远端 DHCP 服务器", cls: "dev-sub" },
      { x: 140, y: 88, text: "192.168.100.1/24", cls: "lk-tag on", anchor: "middle" }
    ]
  }];

  const hosts = ["PC1", "PC2", "PC3"].map(function(k){
    const h = HOSTS[k];
    return {
      id: h.id, x: h.x, y: h.y, ip: hostIp(S, k), mac: h.mac,
      vlan: h.vlan, color: vlanColor(h.vlan), up: true
    };
  });

  const links = ["PC1", "PC2", "PC3"].map(function(k){
    const h = HOSTS[k];
    const has = hostIp(S, k) !== "0.0.0.0";
    return {
      id: "lk-" + h.id.toLowerCase(),
      d: ROUTES[h.id.toLowerCase() + "-down"],
      cls: "",
      flow: has ? 0.42 : 0,
      flowColor: "56,225,255"
    };
  });

  links.push({
    id: "lk-relay",
    d: ROUTES["relay-r"],
    cls: relayOn ? "trunk on" : "trunk",
    flow: relayOn ? (pc3Ip !== "0.0.0.0" ? 0.55 : 0.28) : 0,
    flowColor: "255,181,69"
  });

  const anchors = {
    "SW1/GE0/0/1": [DEV.SW1.x + DEV.SW1.rjRel[0], DEV.SW1.y + 44],
    "SW1/GE0/0/2": [DEV.SW1.x + DEV.SW1.rjRel[1], DEV.SW1.y + 44],
    "SW1/GE0/0/3": [DEV.SW1.x + DEV.SW1.rjRel[2], DEV.SW1.y + 44],
    "SW1/GE0/0/23": [DEV.SW1.x + DEV.SW1.sfpRel + 21, DEV.SW1.y + 44],
    "R1/GE0/0/0": [DEV.R1.x + DEV.R1.rjRel[0], DEV.R1.y + 44]
  };

  const labels = [
    { text: "VLAN 10", x: 520, y: 214, anchor: "middle", cls: hostIp(S, "PC1") !== "0.0.0.0" ? "lk-tag on" : "lk-tag warn" },
    { text: relayOn ? "VLAN 20 · 中继" : "VLAN 20", x: 920, y: 214, anchor: "middle", cls: relayOn ? "lk-tag on" : "lk-tag warn" },
    { text: "DHCP RELAY", x: 956, y: 94, anchor: "middle", cls: relayOn ? "lk-tag on" : "lk-tag" }
  ];
  if(relayOn) labels.push({ text: "giaddr 192.168.20.1", x: 860, y: 124, anchor: "start", cls: "lk-tag on" });

  return {
    viewBox: "0 0 1400 320",
    devices: devices, hosts: hosts, links: links, routes: ROUTES, anchors: anchors, labels: labels
  };
}

/* ---------------- 数据面场景 ---------------- */
function stageInfo(S, hostId, probe, stage){
  const ip = plannedIp(S, hostId) || "192.168.10.254";
  const h = HOSTS[hostId];
  if(stage === "discover")
    return {
      h: "① Discover · 客户端广播",
      p: h.id + " 上电后没有任何 IP，源地址 <b>0.0.0.0:68</b>，目的 <b>255.255.255.255:67</b>。它不知道服务器在哪，只能广播。"
    };
  if(stage === "offer")
    return {
      h: "② Offer · 服务器给地址",
      p: "SW1 在 Vlanif" + h.vlan + " 上按接口网段 <b>" + netOf(probe.pool.network, probe.pool.mask) + "/" + probe.pool.mask + "</b> 找到池 <b>" + probe.pool.name + "</b>；从范围内<b>最大的地址</b>开始选，挑中 <b>" + ip + "</b>，回 Offer（带掩码、网关、DNS、租期）。"
    };
  if(stage === "request")
    return {
      h: "③ Request · 仍然是广播",
      p: "客户端选定 Offer 后发 Request，源地址还是 0.0.0.0，目的还是 255.255.255.255。为什么广播？因为可能有<b>多个服务器</b>都发了 Offer，客户端必须让所有服务器都听到「我选了谁」，没被选中的服务器才能回收自己预分配的地址。"
    };
  return {
    h: "④ ACK · 租约生效",
    p: "SW1 回 ACK，租期 " + probe.pool.lease + " 天。<b>" + ip + "/24</b> 正式写到 " + h.id + " 的网卡上，默认网关 <b>" + h.gw + "</b>。绑定表随之多一行：IP ↔ MAC ↔ 租期。"
  };
}

function stageFrame(stage){
  if(stage === "discover") return { dir: "up", kind: "broadcast", color: "#38E1FF" };
  if(stage === "offer") return { dir: "down", kind: "data", color: "#35E08A" };
  if(stage === "request") return { dir: "up", kind: "broadcast", color: "#FFB545" };
  return { dir: "down", kind: "data", color: "#35E08A" };
}

function localStageScene(S, hostId, probe, stage){
  const h = HOSTS[hostId];
  const f = stageFrame(stage);
  const info = stageInfo(S, hostId, probe, stage);
  const route = h.id.toLowerCase() + "-" + f.dir;
  return {
    name: h.id + " · DHCP " + stage,
    realSec: 2.6,
    dur: 1,
    traceTitle: "逐跳判读",
    frames: [{ route: route, t0: 0, t1: .72, kind: f.kind, vlan: h.vlan, color: f.color }],
    drop: null,
    trace: [
      info,
      { h: "判读要点", p: "四步里只有 Discover 和 Request 由客户端发起，而且都是广播；Offer 和 ACK 由服务器回，方向相反。", cls: "pass" }
    ],
    verdict: { bad: false, text: "单看这一步：" + info.h.replace(/^[①②③④]\s*/, "") + "。" }
  };
}

function localOkScene(S, hostId, probe){
  const h = HOSTS[hostId];
  const ip = plannedIp(S, hostId) || "192.168.10.254";
  const up = h.id.toLowerCase() + "-up";
  const down = h.id.toLowerCase() + "-down";
  const stages = ["discover", "offer", "request", "ack"];
  return {
    name: h.id + " · DHCP 四步交互 · " + ip,
    realSec: 5.4,
    dur: 1,
    traceTitle: "逐跳判读 · Discover / Offer / Request / ACK",
    frames: [
      { route: up, t0: 0, t1: .10, kind: "broadcast", vlan: h.vlan, color: "#38E1FF" },
      { route: down, t0: .16, t1: .26, kind: "data", vlan: h.vlan, color: "#35E08A" },
      { route: up, t0: .32, t1: .42, kind: "broadcast", vlan: h.vlan, color: "#FFB545" },
      { route: down, t0: .48, t1: .58, kind: "data", vlan: h.vlan, color: "#35E08A" },
      { route: up, t0: .68, t1: .76, kind: "broadcast", vlan: h.vlan, color: "#FFB545" },
      { route: down, t0: .80, t1: .88, kind: "data", vlan: h.vlan, color: "#FFB545" }
    ],
    drop: null,
    trace: stages.map(s => stageInfo(S, hostId, probe, s)).concat([
      { h: "⑤ 拿到地址后 ARP 网关", p: h.id + " 要访问网关 " + h.gw + "，先发 ARP 请求（广播）；Vlanif" + h.vlan + " 用自己的 MAC 应答。DHCP 只负责「发地址」，ARP 负责「找到网关的 MAC」，两件事不要混。", cls: "" },
      { h: "⑥ 判读口诀", p: "Discover / Request 广播，Offer / ACK 单播；地址要经过「服务器给（Offer）→ 客户端确认（Request）→ 服务器确认（ACK）」才定下来。", cls: "pass" }
    ]),
    verdict: { bad: false, text: h.id + " 拿到 " + ip + "/24，网关 " + h.gw + "。VRP 默认从地址池<b>最大</b>的地址开始分配：第一个客户端拿 .254，第二个拿 .253，依次往下。" }
  };
}

function failureNote(reason){
  if(reason === "DHCP DISABLED")
    return {
      check: "全局 DHCP 开关是 <b>disable</b>。设备根本不解 DHCP 报文，地址池、接口 select 全都白配。",
      drop: "没有 DHCP 服务，Discover 直接被忽略。客户端只能反复重传直到超时。",
      fix: "system-view → dhcp enable。"
    };
  if(reason === "NO DHCP SERVICE ON Vlanif10")
    return {
      check: "地址池可能已经建好，但 <b>Vlanif10 上没有 dhcp select global</b> —— 接口没被指定去使用全局池。",
      drop: "接口不提供 DHCP 服务，Discover 无回应。",
      fix: "interface Vlanif 10 → dhcp select global。"
    };
  if(reason === "NO POOL MATCH")
    return {
      check: "Vlanif10 是 <b>192.168.10.0/24</b>，而池 vlan10 的 network 写成了 <b>192.168.11.0/24</b>。global 模式拿<b>接口网段</b>去和池的 network 比，比不中就选不中池。",
      drop: "匹配不到池就当作没有 DHCP 服务：<b>不回 Offer，也不回 NAK</b>。NAK 只在「客户端请求的地址不可用」时才发；这里连池都没选上。PC 只能反复重传直到超时。",
      fix: "ip pool vlan10 → network 192.168.10.0 mask 255.255.255.0。"
    };
  if(reason === "POOL EXHAUSTED")
    return {
      check: "池里所有地址都已被绑定，<b>Idle = 0</b>。",
      drop: "没有可用地址，服务器不会发 Offer。",
      fix: "扩大 range，或释放旧绑定（等租期到期 / 手工清理）。"
    };
  if(reason === "NO DHCP SERVICE ON Vlanif20")
    return {
      check: "Vlanif20 上没有 <b>dhcp select relay</b>：SW1 听到了 PC3 的广播，但没被指定要把报文转给谁。",
      drop: "广播在 VLAN 20 内终止，没有 Offer。",
      fix: "interface Vlanif 20 → dhcp select relay。"
    };
  if(reason === "NO RELAY SERVER")
    return {
      check: "Vlanif20 已经是 relay 模式，但缺 <b>dhcp relay server-ip</b> —— SW1 不知道服务器地址。",
      drop: "Discover 没有下一跳，报文被丢弃。",
      fix: "dhcp relay server-ip 192.168.100.1。"
    };
  if(reason === "SERVER DHCP DISABLED")
    return {
      check: "R1 的全局 DHCP 没开。SW1 把报文送过去了，但服务器不处理。",
      drop: "R1 不回 Offer，PC3 超时。",
      fix: "在 R1 上 dhcp enable，并确认地址池 vlan20 存在。"
    };
  if(reason === "RELAY SERVER UNREACHABLE")
    return {
      check: "SW1 上没有覆盖 <b>192.168.100.1</b> 的三层接口，中继报文发不出去。",
      drop: "报文在 SW1 上无处可出。",
      fix: "确认 GE0/0/23 的 192.168.100.2/24 已配置且 up。"
    };
  if(reason === "NO POOL ON SERVER")
    return {
      check: "R1 上没有网段等于 <b>giaddr 192.168.20.1 所在的 192.168.20.0/24</b> 的地址池。",
      drop: "服务器无法为这个网段选池，不回 Offer。",
      fix: "在 R1 上 ip pool vlan20 → network 192.168.20.0 mask 255.255.255.0。"
    };
  if(reason === "VLANIF10 DOWN" || reason === "VLANIF20 DOWN")
    return {
      check: "对应的 Vlanif 没有 up（缺 IP 或没有 up 的成员口）。",
      drop: "接口不提供三层服务，DHCP 报文无处落脚。",
      fix: "先 display ip interface brief 确认 Vlanif 的 Physical / Protocol 都为 up。"
    };
  return {
    check: "前置配置不完整。",
    drop: "报文没有完成 DHCP 交互。",
    fix: "按左侧引导逐条补齐。"
  };
}

function localFailScene(S, hostId, probe){
  const h = HOSTS[hostId];
  const up = h.id.toLowerCase() + "-up";
  const note = failureNote(probe.reason);
  const verdictText = probe.reason === "NO POOL MATCH"
    ? "反直觉的点：地址池的 network 写错，不会报错，也不会回 NAK；设备只是「找不到匹配的池」，然后一言不发。查这种问题只能对照 display ip pool 的 Network 与 Vlanif 的地址。"
    : "失败原因：" + probe.reason + "。" + note.check + " 修复：" + note.fix;
  return {
    name: h.id + " · DHCP 失败 · " + probe.reason,
    realSec: 3.6,
    dur: 1,
    traceTitle: "逐跳判读 · 为什么拿不到地址",
    frames: [
      { route: up, t0: 0, t1: .12, kind: "broadcast", vlan: h.vlan, color: "#38E1FF" },
      { route: up, t0: .30, t1: .42, kind: "broadcast", vlan: h.vlan, color: "#38E1FF" },
      { route: up, t0: .60, t1: .72, kind: "broadcast", vlan: h.vlan, color: "#38E1FF" }
    ],
    drop: { route: up, p: .93, at: .44, label: probe.reason },
    trace: [
      { h: "① Discover · 广播", p: h.id + " 没有 IP，源 0.0.0.0:68，目的 255.255.255.255:67，反复广播寻找服务器。", cls: "" },
      { h: "② SW1 检查", p: note.check, cls: "" },
      { h: "③ 静默丢弃 · 没有 Offer 也没有 NAK", p: note.drop, cls: "drop" },
      { h: "④ 现象与修复", p: h.id + " 的 ipconfig 一直是 0.0.0.0。修复：<b>" + note.fix + "</b>", cls: "drop" }
    ],
    verdict: { bad: true, text: verdictText }
  };
}

function relayOkScene(S, probe){
  const ip = plannedIp(S, "PC3") || "192.168.20.254";
  return {
    name: "PC3 · DHCP 中继 · 跨网段拿 " + ip,
    realSec: 5.8,
    dur: 1,
    traceTitle: "逐跳判读 · 广播 → giaddr 改写 → 单播 → 回程",
    frames: [
      { route: "pc3-up", t0: 0, t1: .08, kind: "broadcast", vlan: 20, color: "#38E1FF" },
      { route: "relay-r", t0: .12, t1: .28, kind: "data", color: "#FFB545" },
      { route: "relay-l", t0: .32, t1: .48, kind: "data", color: "#FFB545" },
      { route: "pc3-down", t0: .50, t1: .58, kind: "data", vlan: 20, color: "#35E08A" },
      { route: "pc3-up", t0: .62, t1: .68, kind: "broadcast", vlan: 20, color: "#FFB545" },
      { route: "relay-r", t0: .70, t1: .82, kind: "data", color: "#FFB545" },
      { route: "relay-l", t0: .84, t1: .93, kind: "data", color: "#FFB545" },
      { route: "pc3-down", t0: .94, t1: .99, kind: "data", vlan: 20, color: "#35E08A" }
    ],
    drop: null,
    trace: [
      { h: "① PC3 · Discover 广播", p: "PC3 没有 IP，源 <b>0.0.0.0:68</b>，目的 <b>255.255.255.255:67</b>。广播出不了 VLAN 20，而 VLAN 20 里没有 DHCP 服务器。", cls: "" },
      { h: "② SW1 · 改写 giaddr 后单播", p: "Vlanif20 上配了 <b>dhcp select relay</b> 和 <b>dhcp relay server-ip 192.168.100.1</b>。SW1 把报文里的 <b>giaddr 改写为 192.168.20.1</b>（收到广播的接口地址），再按 192.168.100.0/24 的路由单播给 R1。", cls: "" },
      { h: "③ R1 · 按 giaddr 选池", p: "R1 不关心 PC3 的 MAC 在哪个 VLAN，它只看 giaddr：<b>192.168.20.1</b> 属于 <b>192.168.20.0/24</b>，于是选中池 vlan20，从最大地址开始分配 <b>" + ip + "</b>，回 Offer。回包目的地址是 giaddr，经 SW1 转回 PC3。", cls: "" },
      { h: "④ Request / ACK · 仍然中继", p: "PC3 的 Request 还是广播，SW1 继续改写 giaddr 后单播；R1 回 ACK。PC3 最终拿到 <b>" + ip + "/24</b>，网关 <b>192.168.20.1</b>。", cls: "" },
      { h: "⑤ 关键分工", p: "地址由 <b>R1</b> 给，网关由 <b>SW1 的 Vlanif20</b> 当。PC3 的 DHCP 服务器和默认网关不在同一台设备上——这正是中继要解决的问题。", cls: "pass" }
    ],
    verdict: { bad: false, text: "PC3 拿到 " + ip + "/24。中继的关键不是「转发」，而是 <b>giaddr</b>：服务器靠它知道请求来自哪个网段，回程也靠它找到中继设备。" }
  };
}

function relayFailScene(S, probe){
  const note = failureNote(probe.reason);
  const atRelay = probe.reason === "NO POOL ON SERVER" || probe.reason === "SERVER DHCP DISABLED";
  const frames = [{ route: "pc3-up", t0: 0, t1: .12, kind: "broadcast", vlan: 20, color: "#38E1FF" }];
  if(atRelay) frames.push({ route: "relay-r", t0: .18, t1: .42, kind: "data", color: "#FFB545" });
  frames.push({ route: "pc3-up", t0: .60, t1: .72, kind: "broadcast", vlan: 20, color: "#38E1FF" });
  return {
    name: "PC3 · DHCP 中继失败 · " + probe.reason,
    realSec: 4.0,
    dur: 1,
    traceTitle: "逐跳判读 · 中继为什么没成功",
    frames: frames,
    drop: atRelay
      ? { route: "relay-r", p: .94, at: .44, label: probe.reason }
      : { route: "pc3-up", p: .93, at: .30, label: probe.reason },
    trace: [
      { h: "① PC3 · Discover 广播", p: "PC3 在 VLAN 20 里广播寻找 DHCP 服务器。", cls: "" },
      { h: "② SW1 检查", p: note.check, cls: "" },
      { h: "③ 丢弃", p: note.drop, cls: "drop" },
      { h: "④ 修复", p: "<b>" + note.fix + "</b> 修好后 PC3 才能跨网段拿到 192.168.20.x。", cls: "drop" }
    ],
    verdict: { bad: true, text: "中继链路两端都要对：SW1 要 select relay 并指定服务器，R1 要开 DHCP 且有 giaddr 网段的池。缺任何一环，PC3 都只能超时。" }
  };
}

export function dhcpScene(S, phase, hostId){
  const p = phase || "all";
  const id = hostId || (p === "relay" ? "PC3" : "PC1");
  if(p === "relay" || id === "PC3"){
    const probe = dhcpProbe(S, "PC3");
    return probe.ok ? relayOkScene(S, probe) : relayFailScene(S, probe);
  }
  const probe = dhcpProbe(S, id);
  if(!probe.ok) return localFailScene(S, id, probe);
  if(p === "discover" || p === "offer" || p === "request" || p === "ack")
    return localStageScene(S, id, probe, p);
  return localOkScene(S, id, probe);
}

/* ---------------- 引导 ---------------- */
function guide(S, ctx){
  const G = (phase, why, cmd) => ({ phase: phase, why: why, cmd: cmd || "" });
  const sw = S.SW1;

  if(ctx.dev === "R1"){
    if(ctx.view === "user")
      return G("peer", "R1 已预配置为远端 DHCP 服务器：192.168.100.1/24 + 地址池 vlan20（192.168.20.0/24）。点命令层上方的 SW1 标签切回去配中继。", "display ip pool");
    return G("peer", "R1 侧已经就绪。quit / return 回到用户视图，再切回 SW1 配 Vlanif20 的中继。", "quit");
  }

  if(ctx.view === "pool"){
    if(!sw.dhcp.enabled)
      return G("enable", "全局 DHCP 还没开。先 quit 回系统视图执行 dhcp enable，否则池配得再对也不发地址。", "quit");
    if(ctx.pool !== "vlan10")
      return G("param", "本实验只使用池 vlan10；配完就 quit 出去。", "quit");
    const p = sw.dhcp.pools.vlan10;
    if(!p) return G("pool", "这个地址池不存在，quit 出去重新 ip pool vlan10。", "quit");
    if(!p.network)
      return G("param", "池 vlan10 还没有网段。network 必须写成 Vlanif10 所在的网段。", "network 192.168.10.0 mask 255.255.255.0");
    if(p.network !== "192.168.10.0" || p.mask !== 24)
      return G("param", "池 vlan10 的 network 现在是 " + p.network + "/" + p.mask + "，与 Vlanif10 的 192.168.10.0/24 不匹配。改回 192.168.10.0/24。", "network 192.168.10.0 mask 255.255.255.0");
    if(!p.gateway)
      return G("param", "池的网段对了，还缺 gateway-list。", "gateway-list 192.168.10.1");
    if(!p.dns)
      return G("param", "网关有了，再给客户端一个 DNS。", "dns-list 223.5.5.5");
    return G("global", "池参数齐了。quit 出去，到 Vlanif10 上 dhcp select global。", "quit");
  }

  if(ctx.view === "if"){
    const vid = parseInt(ctx.ifName, 10);
    if(!sw.dhcp.enabled)
      return G("enable", "全局 DHCP 没开。quit 回系统视图先 dhcp enable，接口上的 select 不会生效。", "quit");
    if(vid === 10){
      if(sw.ifDhcp[10] !== "global")
        return G("global", "Vlanif10 还没选 DHCP 模式。global 表示「用全局地址池」。", "dhcp select global");
      return G("test", "Vlanif10 已用全局地址池。quit 出去，让 PC1 发 Discover。", "quit");
    }
    if(vid === 20){
      if(sw.ifDhcp[20] !== "relay")
        return G("relay", "PC3 在 VLAN 20，服务器却在 R1 的 192.168.100.0/24。Vlanif20 必须选 relay。", "dhcp select relay");
      if(!sw.relay["Vlanif20"])
        return G("relay", "relay 模式已选，还缺服务器地址。", "dhcp relay server-ip 192.168.100.1");
      return G("test", "中继配置完成。quit 出去，让 PC3 试一次。", "quit");
    }
    return G("verify", "这个 Vlanif 不在本实验范围内。quit 出去。", "quit");
  }

  if(ctx.view === "system"){
    if(!sw.dhcp.enabled)
      return G("enable", "第一件事永远是 dhcp enable。全局开关不开，后面的池、select global、中继全部不生效。", "dhcp enable");
    if(!sw.dhcp.pools.vlan10)
      return G("pool", "全局开关已开。建 VLAN 10 的地址池。", "ip pool vlan10");
    const p = sw.dhcp.pools.vlan10;
    if(p.network !== "192.168.10.0" || p.mask !== 24)
      return G("param", "池 vlan10 的网段现在是 " + (p.network ? p.network + "/" + p.mask : "未配置") + "，必须与 Vlanif10 的 192.168.10.0/24 一致。", "ip pool vlan10");
    if(!p.gateway)
      return G("param", "池 vlan10 还缺 gateway-list 192.168.10.1。", "ip pool vlan10");
    if(!p.dns)
      return G("param", "池 vlan10 还缺 dns-list 223.5.5.5。", "ip pool vlan10");
    if(sw.ifDhcp[10] !== "global")
      return G("global", "池配好了，但 Vlanif10 还没选 global —— 设备不知道这个接口要用全局地址池。", "interface Vlanif 10");
    if(hostIp(S, "PC1") === "0.0.0.0")
      return G("test", "配置齐了。让 PC1 跑四步交互（点 S6，或右下角「PC1 获取地址」）。", "ipconfig");
    if(sw.ifDhcp[20] !== "relay")
      return G("relay", "局部 DHCP 已成功。现在做中继：让 Vlanif20 用 relay 模式。", "interface Vlanif 20");
    if(!sw.relay["Vlanif20"])
      return G("relay", "Vlanif20 已是 relay，但还没指定服务器。", "dhcp relay server-ip 192.168.100.1");
    if(hostIp(S, "PC3") === "0.0.0.0")
      return G("test", "中继配好了。让 PC3 发 Discover，SW1 会改写 giaddr 后单播给 R1。", "ipconfig");
    return G("verify", "全部就绪。用 display ip pool / display dhcp server statistics / display dhcp relay information 对照。", "display ip pool");
  }

  if(!sw.dhcp.enabled)
    return G("enter", "<SW1> 用户视图只能看。先 system-view，再 dhcp enable —— 这是后面所有配置的总闸。", "system-view");
  return G("enter", "<SW1> 是用户视图，改配置先 system-view。", "system-view");
}

/* ---------------- 板块 ---------------- */
const steps = [
  {
    id: 1, name: "基线 · 网关在线，但没有 DHCP",
    run: async api => {
      api.setDev("SW1");
      await api.run(["display ip interface brief", "ipconfig", "display ip pool"]);
    },
    summary: "Vlanif10 / Vlanif20 都有 IP，但三台 PC 全是 0.0.0.0",
    detail: [
      { h: "看到什么", p: "display ip interface brief 里两个 Vlanif 都是 up/up；ipconfig 里三台 PC 的地址、掩码、网关全是 0.0.0.0；display ip pool 里一个池都没有。" },
      { h: "为什么", p: "网关在线 ≠ 有地址可发。Vlanif 只提供三层接口和直连路由；DHCP 是独立的服务，需要<b>全局开关 + 地址池 + 接口选择模式</b>三件事。" },
      { h: "关键区别", p: "ARP 是「问一个已知 IP 的 MAC」，DHCP 是「连 IP 都还没有，先要一个」。没有 DHCP，PC 连网关的 ARP 都发不出去。" }
    ]
  },
  {
    id: 2, name: "打开全局 DHCP 开关",
    done: S => S.SW1.dhcp.enabled,
    run: async api => {
      api.setDev("SW1");
      await api.run(["system-view", "dhcp enable"]);
    },
    summary: "dhcp enable 是总闸，不开后面全不生效",
    detail: [
      { h: "命令是静默的", p: "真实 VRP 上 dhcp enable 成功没有回显。表项里只看得到全局开关从 disable 变 enable。" },
      { h: "最常见的坑", p: "池建好了、接口也 select global 了，唯独忘了这一条：PC 永远拿不到地址，而且没有任何报错。排查 DHCP 问题，第一眼先看全局开关。" }
    ]
  },
  {
    id: 3, name: "建地址池 vlan10",
    done: S => !!S.SW1.dhcp.pools.vlan10,
    run: async api => {
      api.setDev("SW1");
      await api.run(["system-view", "ip pool vlan10"]);
    },
    summary: "得到一张空池，提示符进入 [SW1-ip-pool-vlan10]",
    detail: [
      { h: "只是建表", p: "ip pool vlan10 只创建一张空表：没有网段、没有网关、没有 DNS。此时它还发不出任何地址。" },
      { h: "视图变化", p: "提示符从 [SW1] 变成 [SW1-ip-pool-vlan10]。network / gateway-list / dns-list 这些命令只属于地址池视图。" }
    ]
  },
  {
    id: 4, name: "配网段、网关、DNS",
    done: S => {
      const p = S.SW1.dhcp.pools.vlan10;
      return !!p && p.network === "192.168.10.0" && p.mask === 24 &&
        p.gateway === "192.168.10.1" && p.dns === "223.5.5.5";
    },
    run: async api => {
      api.setDev("SW1");
      await api.run(["system-view", "ip pool vlan10",
        "network 192.168.10.0 mask 255.255.255.0",
        "gateway-list 192.168.10.1",
        "dns-list 223.5.5.5"]);
    },
    summary: "池的网段与 Vlanif10 对齐，网关 / DNS 随租约下发",
    detail: [
      { h: "network 决定范围", p: "192.168.10.0/24 → 可分配 192.168.10.1 ~ 192.168.10.254；网关 192.168.10.1 会被自动跳过。" },
      { h: "为第 8 步埋雷", p: "network 不只是「写个网段」，它还是 global 模式匹配池的唯一依据。写成 192.168.11.0/24，后面就会静默失败。" },
      { h: "gateway / dns", p: "这两个地址不会配到交换机上，它们只是随 Offer / ACK 下发给客户端的选项。" }
    ]
  },
  {
    id: 5, name: "Vlanif10 启用全局地址池",
    done: S => S.SW1.ifDhcp[10] === "global",
    run: async api => {
      api.setDev("SW1");
      await api.run(["system-view", "interface Vlanif 10", "dhcp select global"]);
    },
    summary: "接口告诉设备：这个口用全局地址池",
    detail: [
      { h: "两个动作缺一不可", p: "建池是「准备地址」，dhcp select global 是「让这个接口去用池」。只建池不 select，等于池摆在那里没人用。" },
      { h: "匹配规则", p: "global 模式下，设备拿 Vlanif10 的 192.168.10.1/24 去和池的 network 比。现在两者都是 192.168.10.0/24，匹配成功。" }
    ]
  },
  {
    id: 6, name: "四步交互 · PC1 拿到地址", key: true, keepTrace: true,
    done: S => hostIp(S, "PC1") !== "0.0.0.0",
    run: api => {
      api.setDev("SW1");
      const r = allocateHost(api.S, "PC1");
      if(r.ok && !r.existed){
        api.change("DHCP 绑定 · PC1", "未分配", r.ip + " · " + HOSTS.PC1.mac, { row: "bind-" + r.ip, kind: "enter" });
        api.say("// ACK 后 PC1 的租约为 " + r.ip + "/24，绑定写入池 " + r.pool.name + "。", "op");
      }else if(r.ok){
        api.say("// PC1 已经有租约 " + r.ip + "。", "op");
      }else{
        api.say("// 分配失败：" + r.reason + "。按左侧引导先补齐前置配置。", "op");
      }
      api.play(dhcpScene(api.S, "all", "PC1"));
    },
    summary: "Discover(广播) → Offer → Request(广播) → ACK，PC1 拿到 .254",
    detail: [
      { h: "看帧的方向", p: "Discover 和 Request 从 PC 发向交换机，虚线广播；Offer 和 ACK 从交换机回 PC，实线单播。最后两帧是拿到地址后 ARP 网关。" },
      { h: "Request 为什么广播", p: "PC 可能收到多个服务器给的 Offer，它必须大声告诉<b>所有</b>服务器「我选了谁」；没被选中的服务器听到后回收自己预分配的地址。" },
      { h: "为什么是 .254", p: "VRP 默认从地址池<b>最大</b>的地址开始分配。池范围是 .1 ~ .254，网关 .1 被跳过，所以第一个拿到的是 .254。" }
    ]
  },
  {
    id: 7, name: "看地址池与绑定表",
    run: async api => {
      api.setDev("SW1");
      await api.run(["display ip pool", "display ip pool name vlan10", "display dhcp server ip-in-use"]);
    },
    summary: "Used 1 / Idle 252，PC1 的 MAC 绑定 192.168.10.254，租期 1 天",
    detail: [
      { h: "三个数字", p: "池大小 253（.1~.254 去掉网关 .1），已用 1，空闲 252。display dhcp server ip-in-use 里能看到完整的 IP ↔ MAC ↔ 租期。" },
      { h: "分配顺序", p: "VRP 从池内最大地址往下分：第一个 .254，第二个 .253。这不是随机，是设备习惯。" },
      { h: "绑定在哪", p: "绑定记录写在<b>服务器</b>上。PC3 走中继时，记录会写在 R1 的池 vlan20 里，不在 SW1。" }
    ]
  },
  {
    id: 8, name: "反直觉 · 地址池网段写错", key: true, keepTrace: true,
    done: S => {
      const p = S.SW1.dhcp.pools.vlan10;
      return !!p && p.network === "192.168.11.0";
    },
    run: async api => {
      api.setDev("SW1");
      api.say("// 先释放 PC1 的租约，制造「池里没有任何绑定」的干净起点。", "op");
      releaseHost(api.S, "PC1");
      await api.run(["system-view", "ip pool vlan10", "network 192.168.11.0 mask 255.255.255.0"]);
      api.play(dhcpScene(api.S, "all", "PC1"));
      api.say("// 下一步（S9）开头会先把 network 改回 192.168.10.0 mask 255.255.255.0，用同一次分配验证恢复。", "op");
    },
    summary: "池网段与 Vlanif10 不匹配 → 没有 Offer、也没有 NAK，只能超时",
    detail: [
      { h: "反直觉在哪", p: "network 写错不会报错，也不会回 NAK。global 模式只是「找不到匹配的池」，然后一言不发。NAK 只在「客户端请求的地址不可用」时才发。" },
      { h: "为什么", p: "Vlanif10 是 192.168.10.0/24，池是 192.168.11.0/24。设备拿接口网段去比，比不中就选不中池；没有池，就没有 Offer。" },
      { h: "怎么查", p: "对照 display ip pool 的 Network 与 display ip interface brief 里 Vlanif10 的地址。两者不一致，就是这个故障。" },
      { h: "改回来", p: "network 192.168.10.0 mask 255.255.255.0 之后，池重新与接口匹配，PC1 再跑一次即可恢复（第 9 步开头会先修回来）。" }
    ]
  },
  {
    id: 9, name: "中继 · PC3 跨网段拿地址", key: true, keepTrace: true,
    done: S => S.SW1.ifDhcp[20] === "relay" && S.SW1.relay["Vlanif20"] === "192.168.100.1" && hostIp(S, "PC3") !== "0.0.0.0",
    run: async api => {
      api.setDev("SW1");
      await api.run(["system-view", "ip pool vlan10", "network 192.168.10.0 mask 255.255.255.0", "quit"]);
      const r1 = allocateHost(api.S, "PC1");
      if(r1.ok && !r1.existed) api.say("// 池网段改回 192.168.10.0/24 后，PC1 重新拿到 " + r1.ip + "。", "op");

      api.setDev("R1");
      await api.run(["display ip pool", "display ip pool name vlan20"]);

      api.setDev("SW1");
      await api.run(["system-view", "interface Vlanif 20", "dhcp select relay", "dhcp relay server-ip 192.168.100.1"]);

      const r3 = allocateHost(api.S, "PC3");
      if(r3.ok && !r3.existed){
        api.change("DHCP 绑定 · PC3", "未分配", r3.ip + " · " + HOSTS.PC3.mac, { row: "bind-" + r3.ip, kind: "enter" });
        api.say("// PC3 跨网段拿到 " + r3.ip + "/24，绑定写在 R1 的池 vlan20 里。", "op");
      }else if(r3.ok){
        api.say("// PC3 已经有租约 " + r3.ip + "。", "op");
      }else{
        api.say("// PC3 分配失败：" + r3.reason + "。", "op");
      }
      api.play(dhcpScene(api.S, "relay", "PC3"));
    },
    summary: "Vlanif20 改 relay → giaddr 192.168.20.1 → R1 池 vlan20 分配 .254",
    detail: [
      { h: "为什么需要中继", p: "PC3 的 Discover 是广播，出不了 VLAN 20；而 DHCP 服务器 R1 在 192.168.100.0/24。中继让 SW1 替 PC3 跑一趟：把广播改成单播发给 R1。" },
      { h: "giaddr 是核心", p: "SW1 把报文里的 giaddr 改写成收到广播的接口地址 <b>192.168.20.1</b>。R1 靠 giaddr 判断「客户端在 192.168.20.0/24」，从而选中池 vlan20。" },
      { h: "地址与网关分开", p: "地址由 R1 给，默认网关 192.168.20.1 由 SW1 的 Vlanif20 当。回包按 giaddr 送回 SW1，再由 SW1 转给 PC3。" },
      { h: "R1 侧", p: "R1 上是 192.168.100.1/24 + 池 vlan20（192.168.20.0/24）。它不需要在 VLAN 20 里，只需要能和中继口互通。" },
      { h: "R1 的回程", p: "真实环境里 R1 还需要一条指向 192.168.20.0/24 的回程路由（下一跳 192.168.100.2）。本实验按「已可达」处理，不展开静态路由。" }
    ]
  },
  {
    id: 10, name: "收尾 · 对照校验",
    run: async api => {
      api.setDev("SW1");
      await api.run(["display dhcp relay information", "display dhcp server statistics", "display dhcp server ip-in-use", "display ip pool name vlan10", "display ip pool"]);
    },
    summary: "地址池利用率、服务器统计、中继配置三张表互相对照",
    detail: [
      { h: "对照顺序", p: "display ip pool 看池的 Network 与 Used / Idle → display dhcp server ip-in-use 看绑定 → display dhcp relay information 看中继指向 → display dhcp server statistics 看收发计数。" },
      { h: "判读口诀", p: "池网段对不上 → 没有 Offer；接口没 select → 没有服务；中继缺 server-ip → 报文无处去；服务器没池 → 服务器沉默。四种失败现象都是超时。" },
      { h: "最后确认", p: "PC1 的绑定在 SW1，PC3 的绑定在 R1；两条链路都从「0 流量」变成有业务流。地址和网关各由哪台设备提供，是这道题的落点。" }
    ]
  }
];

/* ---------------- 导出 ---------------- */
export default {
  id: "07",
  title: "DHCP 四步交互",
  meta: "HUAWEI S5700 / AR2220 · VRP V200R005C00",
  stageLabel: "DHCP SERVICE · 1 × S5700 + 1 × AR2220 · 3 × HOST",
  totalSteps: steps.length,
  devices: ["SW1", "R1"],
  tabs: [
    { key: "pool", label: "地址池", hint: "每个池的网段、网关、已用 / 空闲" },
    { key: "bind", label: "地址绑定", hint: "IP ↔ MAC ↔ 租期" },
    { key: "dhcp", label: "DHCP 配置", hint: "Vlanif 的 global / relay 模式" },
    { key: "if", label: "接口与 IP", hint: "Vlanif 与三层互联口" }
  ],
  legend: [
    { c: "#38E1FF", label: "VLAN 10 / 业务流量" },
    { c: "#FFB545", label: "VLAN 20 / DHCP 控制报文" },
    { c: "#35E08A", label: "DHCP 服务可用" },
    { c: "#7E93AB", label: "未分配 / 未启用" }
  ],
  phases: {
    enter: "进系统视图",
    enable: "开 DHCP",
    pool: "建地址池",
    param: "配池参数",
    global: "接口启用",
    test: "拿地址",
    relay: "配中继",
    verify: "校验",
    peer: "换设备"
  },
  viewName: VIEW_NAME,
  viewHint: VIEW_HINT,
  actions: [
    {
      id: "pc1-get", label: "PC1 获取地址",
      run: l => {
        l.setDev("SW1");
        const r = allocateHost(l.S, "PC1");
        if(r.ok) l.write("// PC1 获得 " + r.ip + "/24（" + (r.existed ? "已有租约" : "新分配") + "）。", "op");
        else l.write("// PC1 分配失败：" + r.reason + "。检查 dhcp enable、池网段与 dhcp select global。", "op");
        l.playScene(dhcpScene(l.S, "all", "PC1"));
      }
    },
    {
      id: "pc2-get", label: "PC2 获取地址",
      run: l => {
        l.setDev("SW1");
        const r = allocateHost(l.S, "PC2");
        if(r.ok) l.write("// PC2 获得 " + r.ip + "/24（" + (r.existed ? "已有租约" : "新分配") + "）。", "op");
        else l.write("// PC2 分配失败：" + r.reason + "。", "op");
        l.playScene(dhcpScene(l.S, "all", "PC2"));
      }
    },
    {
      id: "pc3-get", label: "PC3 中继获取",
      run: l => {
        l.setDev("SW1");
        const r = allocateHost(l.S, "PC3");
        if(r.ok) l.write("// PC3 获得 " + r.ip + "/24（经中继）。", "op");
        else l.write("// PC3 分配失败：" + r.reason + "。检查 Vlanif20 的 relay 与 R1 的池。", "op");
        l.playScene(dhcpScene(l.S, "relay", "PC3"));
      }
    },
    {
      id: "pc1-release", label: "释放 PC1 地址",
      run: l => {
        const n = releaseHost(l.S, "PC1");
        l.write(n ? "// 已释放 PC1 的租约，地址回到 Idle。" : "// PC1 本来就没有租约。", "op");
        l.setTab("bind");
      }
    }
  ],
  createState, prompt, commands, tables, topology, guide, steps,

  idle: {
    title: "DHCP 四步交互怎么读",
    items: [
      { h: "① 两台广播，两台单播", p: "Discover 和 Request 由客户端发起，都是广播（源 0.0.0.0）；Offer 和 ACK 由服务器回。Request 之所以广播，是因为客户端可能收到多个 Offer，必须公开宣布自己选了谁。" },
      { h: "② 地址池匹配靠接口网段", p: "global 模式下，设备拿「收到请求的接口 IP + 掩码」去和每个池的 network 比。网段不一致就当作没有 DHCP 服务：不回 Offer，也不回 NAK，客户端只能超时。" },
      { h: "③ 中继的关键是 giaddr", p: "SW1 把客户端广播改成单播发给 R1 时，会把 giaddr 改写成收到广播的接口地址 192.168.20.1。R1 靠 giaddr 选 192.168.20.0/24 的池，回包也按 giaddr 送回 SW1。" },
      { h: "④ 简化声明", p: "DHCP 报文时序为简化模型：不模拟租期续租（T1/T2）、DECLINE / RELEASE 的完整报文、ARP 冲突探测，也不模拟多个服务器同时回 Offer 的竞争过程。地址分配按 VRP 习惯从池内最大地址开始。" }
    ]
  },

  viewRows(ctx){
    const rows = [
      { h: "<" + ctx.dev + "> 用户视图", p: "只读：display、ipconfig。改配置一律被拒。", cls: ctx.view === "user" ? "pass" : "" },
      { h: "[" + ctx.dev + "] 系统视图", p: "全局入口：dhcp enable、ip pool、interface Vlanif。", cls: ctx.view === "system" ? "pass" : "" }
    ];
    if(ctx.dev === "SW1"){
      rows.push({ h: "[" + ctx.dev + "-Vlanif" + (ctx.view === "if" && ctx.ifName ? ctx.ifName : "10") + "] 接口视图", p: "接口级开关：dhcp select global|relay、dhcp relay server-ip。", cls: ctx.view === "if" ? "pass" : "" });
      rows.push({ h: "[" + ctx.dev + "-ip-pool-" + (ctx.view === "pool" && ctx.pool ? ctx.pool : "vlan10") + "] 地址池视图", p: "池参数：network、gateway-list、dns-list、lease day。", cls: ctx.view === "pool" ? "pass" : "" });
    }else{
      rows.push({ h: "[R1-GigabitEthernet0/0/0] 接口视图", p: "R1 的接口 IP 已预配置为 192.168.100.1/24，本实验不改。", cls: ctx.view === "if" ? "pass" : "" });
      rows.push({ h: "[R1-ip-pool-vlan20] 地址池视图", p: "R1 的池 vlan20 已预配置：192.168.20.0/24。", cls: ctx.view === "pool" ? "pass" : "" });
    }
    return rows;
  },

  boot(write, printGuide){
    write("Info: 已加载 SW1 / R1 配置。SW1 的 Vlanif10 / Vlanif20 已配 IP，但全局 DHCP 关闭、没有任何地址池。", "dim");
    write("      R1 已预配置为远端 DHCP 服务器：192.168.100.1/24 + 地址池 vlan20（192.168.20.0/24）。", "dim");
    write("      PC1 / PC2 在 VLAN 10，PC3 在 VLAN 20，三台都没有 IP。", "dim");
    write("      简化说明：DHCP 报文时序为教学模型，不模拟 T1/T2 续租、DECLINE、RELEASE。", "dim");
    write("", "dim");
    printGuide();
  }
};

export { hostIp, allocateHost, releaseHost };
