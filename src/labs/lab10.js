import { pad } from "../lib/util.js";

/* =========================================================================
   实验 10 · VRRP 主备切换
   -------------------------------------------------------------------------
   SW1 / SW2 各有一个 Vlanif10，跑同一个虚拟组（VRID 1，VIP 192.168.10.254），
   两台各有一条 GE0/0/2 上行到出口路由器 R1。这一层只描述「VRRP 怎么算」：

     createState → 两台的三层接口 / VRRP 组 / 上行口 / PC 网关
     vrrpRoles   → 由 (生效优先级, 接口 IP) 推出 Master / Backup，只有一台 Master
     recalc      → 每次状态变化重算角色，Master 换人时记一次切换
     topology    → Master 的上行有业务流量，Backup 只有心跳；虚拟 MAC 挂在 Master 上
     vrrpScene   → 数据面：PC → 虚拟 MAC → Master → R1，以及倒换与黑洞
     guide       → 从状态反推下一条该敲什么

   简化：角色按稳态计算，不跑逐秒计时器；切换窗口按 3 × Advertisement(1s) 标注；
   不模拟 skew time、认证、ARP 老化与抢占延时的等待过程（延时只影响时刻，不影响终态）。
   ========================================================================= */

const VRID = 1;
const VIP = "192.168.10.254";
const VMAC = "0000-5e00-0101";      /* VRRP 虚拟 MAC：0000-5e00-01 + VRID */
const ADV = 1;                       /* Advertisement Interval，秒 */
const MDI = 3;                       /* Master Down Interval = 3 × ADV（简化，不含 skew time） */

const COL = {
  master: "#38E1FF",
  backup: "#FFB545",
  bad: "#FF4D5E",
  pc: "#A78BFA",
  off: "#7E93AB",
  ok: "#35E08A"
};

/* ---------------- 拓扑几何 ---------------- */
const DEV = {
  SW1: { x: 130, y: 62, w: 300, h: 74 },
  SW2: { x: 970, y: 62, w: 300, h: 74 },
  R1:  { x: 560, y: 62, w: 280, h: 74 }
};

/* 端口相对设备的坐标；rj45 以中心定位，sfp 以左边缘定位（与 lab02 一致） */
const PORT_GEO = {
  SW1: [
    { name: "GE0/0/1", kind: "rj45", x: 100, y: 44, label: "1" },
    { name: "GE0/0/2", kind: "sfp",  x: 256, y: 44, label: "2" }
  ],
  SW2: [
    { name: "GE0/0/1", kind: "rj45", x: 100, y: 44, label: "1" },
    { name: "GE0/0/2", kind: "sfp",  x: 2,   y: 44, label: "2" }
  ]
};

const ROUTES = {
  "pc1-up":   "M230 240 L230 122",
  "pc1-down": "M230 122 L230 240",
  "pc2-up":   "M1070 240 L1070 122",
  "pc2-down": "M1070 122 L1070 240",
  "sw1-r1":   "M428 115 L562 115",
  "r1-sw1":   "M562 115 L428 115",
  "sw2-r1":   "M838 115 L972 115",
  "r1-sw2":   "M972 115 L838 115",
  "r1-wan":   "M700 62 L700 26",
  "wan-r1":   "M700 26 L700 62",
  /* 两台交换机之间的 VLAN 10 二层域：本图不画链路，只在转交帧时用到这条路径 */
  "l2-s1-s2": "M400 136 C480 205 920 205 1000 136",
  "l2-s2-s1": "M1000 136 C920 205 480 205 400 136"
};

const ANCHORS = {
  "SW1/GE0/0/1": [230, 122],
  "SW1/GE0/0/2": [428, 115],
  "SW2/GE0/0/1": [1070, 122],
  "SW2/GE0/0/2": [972, 115],
  "R1/GE0/0/1": [562, 115],
  "R1/GE0/0/2": [838, 115],
  "SW1/Vlanif10": [280, 136],
  "SW2/Vlanif10": [1120, 136]
};

const HOSTS = {
  PC1: { id: "PC1", sw: "SW1", port: "GE0/0/1", ip: "192.168.10.10", mac: "5489-98e1-0010", x: 230,
         routeUp: "pc1-up", routeDown: "pc1-down" },
  PC2: { id: "PC2", sw: "SW2", port: "GE0/0/1", ip: "192.168.10.20", mac: "5489-98e1-0020", x: 1070,
         routeUp: "pc2-up", routeDown: "pc2-down" }
};

/* ---------------- 初始状态 ---------------- */
function makeSwitch(name, ip, mac){
  return {
    name: name,
    mac: mac,
    vlanif: { 10: { ip: ip, mask: 24, up: true } },
    vrrp: {
      enabled: false, vrid: VRID, vip: "", priority: 100,
      preempt: true, delay: 0,
      track: { iface: "GE0/0/2", reduced: 0 }
    },
    up: { "GE0/0/1": true, "GE0/0/2": true }
  };
}

export function createState(){
  const S = {
    SW1: makeSwitch("SW1", "192.168.10.252", "4c1f-cc10-0a01"),
    SW2: makeSwitch("SW2", "192.168.10.253", "4c1f-cc10-0a02"),
    R1: { name: "R1", up: { "GE0/0/1": true, "GE0/0/2": true } },
    /* PC 的网关是本实验最关键的配置项：它决定「切换时要不要动终端」 */
    pc: { PC1: { gw: "192.168.10.252" }, PC2: { gw: "192.168.10.252" } },
    /* 切换记录：tr 是每台设备的 Transitions to Master 次数 */
    stat: { tr: { SW1: 0, SW2: 0 }, last: "—", master: null }
  };
  recalc(S, "");
  return S;
}

/* ---------------- VRRP 选举（简化模型） ---------------- */
function ipInt(ip){
  const a = String(ip == null ? "" : ip).split(".");
  if(a.length !== 4) return -1;
  let n = 0;
  for(let i = 0; i < 4; i++){
    const v = parseInt(a[i], 10);
    if(isNaN(v) || v < 0 || v > 255) return -1;
    n = n * 256 + v;
  }
  return n;
}

function sameSubnet24(a, b){
  const x = ipInt(a), y = ipInt(b);
  if(x < 0 || y < 0) return false;
  return (x >> 8) === (y >> 8);
}

/* 生效优先级：被 track 的接口 down 时，PriorityRun = PriorityConfig − Reduced */
function effPriority(sw){
  const v = sw.vrrp;
  let p = v.priority;
  if(v.track && v.track.reduced > 0 && !sw.up[v.track.iface]){
    p = Math.max(1, p - v.track.reduced);
  }
  return p;
}

/* 先比生效优先级，相同再比接口 IP（大的当 Master）；接口 down 的直接退出选举 */
function vrrpRoles(S){
  const cand = [];
  ["SW1", "SW2"].forEach(function(d){
    const sw = S[d], v = sw.vrrp;
    if(v.enabled && v.vip && sw.vlanif[10].up){
      cand.push({ dev: d, pri: effPriority(sw), ip: ipInt(sw.vlanif[10].ip) });
    }
  });
  let best = null;
  cand.forEach(function(c){
    if(!best){ best = c; return; }
    if(c.pri > best.pri || (c.pri === best.pri && c.ip > best.ip)) best = c;
  });
  const roles = {};
  ["SW1", "SW2"].forEach(function(d){
    const sw = S[d], v = sw.vrrp;
    if(!v.enabled || !v.vip) roles[d] = { role: "—", code: "未启用" };
    else if(!sw.vlanif[10].up) roles[d] = { role: "Initialize", code: "Initialize" };
    else if(best && best.dev === d) roles[d] = { role: "Master", code: "Master" };
    else if(best) roles[d] = { role: "Backup", code: "Backup" };
    else roles[d] = { role: "—", code: "未启用" };
  });
  return { master: best ? best.dev : null, roles: roles, best: best };
}

function recalc(S, reason){
  const prev = S.stat.master;
  const R = vrrpRoles(S);
  S.stat.master = R.master;
  if(reason && R.master !== prev){
    if(R.master) S.stat.tr[R.master] += 1;
    S.stat.last = (prev || "—") + " → " + (R.master || "无") + "（" + reason + "）";
  }
  return R;
}

function rolesSnapshot(S){
  const R = vrrpRoles(S);
  return { SW1: R.roles.SW1.code, SW2: R.roles.SW2.code };
}

/* 改完状态后统一提交：重算角色 + 把状态变化记进表项变更 */
function commit(api, before, reason){
  const R = recalc(api.S, reason);
  ["SW1", "SW2"].forEach(function(d){
    if(before[d] !== R.roles[d].code){
      api.change(d + " · VRRP 状态", before[d], R.roles[d].code, { row: "v-" + d });
    }
  });
  return R;
}

function uplinkUp(S, dev){
  const r1Port = dev === "SW1" ? "GE0/0/1" : "GE0/0/2";
  return S[dev].up["GE0/0/2"] && S.R1.up[r1Port];
}

function setUplink(S, dev, up){
  S[dev].up["GE0/0/2"] = up;
  recalc(S, up ? "上行恢复" : "上行断开");
}

function setGateway(S, ip){
  S.pc.PC1.gw = ip;
  S.pc.PC2.gw = ip;
}

/* ---------------- 视图 ---------------- */
const VIEW_NAME = { user: "用户视图", system: "系统视图", if: "接口视图" };
const VIEW_HINT = { system: "system-view", if: "interface Vlanif 10" };

function shortIf(n){
  const s = String(n);
  if(s.indexOf("Vlanif") === 0) return s;
  return s.replace("GigabitEthernet", "GE");
}

function prompt(ctx){
  if(ctx.view === "user") return "<" + ctx.dev + ">";
  if(ctx.view === "system") return "[" + ctx.dev + "]";
  return "[" + ctx.dev + "-" + shortIf(ctx.ifName) + "]";
}

function isVlanif(n){ return String(n).indexOf("Vlanif") === 0; }
function geKey(n){ return "GE" + String(n).replace("GigabitEthernet", ""); }

/* ---------------- 命令表 ---------------- */
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
    id: "interface-vlanif", match: /^interface (?:Vlanif|vlanif)\s*(\d+)$/, view: "system", kind: "view",
    usage: "interface Vlanif 10",
    run(api, m){
      const v = parseInt(m[1], 10);
      if(!api.S[api.ctx.dev].vlanif[v]){ api.say("Error: The interface does not exist.", "err"); return; }
      api.ctx.view = "if"; api.ctx.ifName = "Vlanif" + v;
    }
  },
  {
    id: "interface-ge", match: /^interface (?:GigabitEthernet|GE)\s*([\d/]+)$/i, view: "system", kind: "view",
    usage: "interface GigabitEthernet 0/0/2",
    run(api, m){
      const key = "GE" + m[1];
      const sw = api.S[api.ctx.dev];
      if(!(key in sw.up)){
        api.say("Error: The port does not exist.", "err");
        api.say("      本实验只用到 " + Object.keys(sw.up).join(" / ") + "。", "dim");
        return;
      }
      api.ctx.view = "if"; api.ctx.ifName = "GigabitEthernet" + m[1];
    }
  },
  {
    id: "ip-address", match: /^ip address ([\d.]+) (\d+|[\d.]+)$/, view: "if", kind: "config",
    usage: "ip address 192.168.10.252 24",
    explain: [
      { h: "改的是接口地址", p: "Vlanif10 的实地址变了。VRRP 虚拟组还挂在同一个接口上，VIP 不变。" },
      { h: "顺带的后果", p: "两台优先级相同时，比较的就是<b>接口 IP</b>，大的当 Master。改地址可能直接改写选举结果。" }
    ],
    run(api, m){
      if(!isVlanif(api.ctx.ifName)){
        api.say("Error: Unrecognized command found at '^' position.", "err");
        api.say("      地址配在三层接口上：interface Vlanif 10。", "dim");
        return;
      }
      const dev = api.ctx.dev, sw = api.S[dev], vif = sw.vlanif[10];
      const ip = m[1];
      const mask = m[2] === "255.255.255.0" ? 24 : parseInt(m[2], 10);
      if(ipInt(ip) < 0){ api.say("// 地址格式不对。", "op"); return; }
      if(mask !== 24){ api.say("// 本实验只模拟 /24 掩码。", "op"); return; }
      if(ip === sw.vrrp.vip){
        api.say("// 接口实地址不能和虚拟 IP 相同，本次不生效。", "op");
        return;
      }
      if(vif.ip === ip){ api.say("// " + dev + " Vlanif10 的地址本来就是 " + ip + "/24，命令未产生状态变化。", "op"); return; }
      const before = rolesSnapshot(api.S);
      const from = vif.ip + "/24";
      vif.ip = ip;
      api.change(dev + " · Vlanif10 地址", from, ip + "/24", { row: "i-" + dev + "-10" });
      api.tab("iface");
      commit(api, before, "接口 IP 变更");
      api.say("// " + dev + " Vlanif10 " + from + " → " + ip + "/24", "op");
      api.say("// 优先级相同时靠接口 IP 决胜：目前 SW1 .252 / SW2 .253，SW2 更大。", "op");
    }
  },
  {
    id: "vrrp-vip", match: /^vrrp vrid (\d+) virtual-ip ([\d.]+)$/, view: "if", kind: "config",
    usage: "vrrp vrid 1 virtual-ip 192.168.10.254",
    explain: [
      { h: "建一个虚拟组", p: "VRID 是组的编号，两台必须一样；VIP 是终端要指的那个网关，两台也必须一样。" },
      { h: "虚拟 MAC 自动生成", p: "VRID 1 → <b>0000-5e00-0101</b>。它由 VRID 算出，和设备的物理 MAC 无关。" },
      { h: "只配一台不算冗余", p: "只有一台成员时它当然是 Master，但它挂了就没人接。" }
    ],
    run(api, m){
      if(!isVlanif(api.ctx.ifName)){
        api.say("Error: Unrecognized command found at '^' position.", "err");
        api.say("      VRRP 配在三层接口上：interface Vlanif 10。", "dim");
        return;
      }
      const vrid = parseInt(m[1], 10), vip = m[2];
      if(vrid !== VRID){
        api.say("// 本实验只模拟 VRID " + VRID + "（虚拟 MAC 与之对应）。", "op");
        return;
      }
      const dev = api.ctx.dev, sw = api.S[dev], v = sw.vrrp, vif = sw.vlanif[10];
      if(ipInt(vip) < 0){ api.say("// 虚拟 IP 格式不对。", "op"); return; }
      if(vip === vif.ip){
        api.say("// 虚拟 IP 不能等于本接口的实地址 " + vif.ip + "。", "op");
        return;
      }
      if(!sameSubnet24(vip, vif.ip)){
        api.say("// 虚拟 IP 必须与 Vlanif10 在同一网段（" + vif.ip + "/24）。", "op");
        return;
      }
      if(v.enabled && v.vip === vip){
        api.say("// 虚拟组 " + vrid + " 已经存在（VIP " + vip + "），命令未产生状态变化。", "op");
        return;
      }
      const before = rolesSnapshot(api.S);
      const from = v.enabled ? v.vip : "不存在";
      v.enabled = true; v.vip = vip; v.vrid = vrid;
      api.change(dev + " · vrid " + vrid, from, "virtual-ip " + vip, { row: "v-" + dev, kind: from === "不存在" ? "enter" : "chg" });
      api.tab("vrrp");
      const R = commit(api, before, "VRRP 上线");
      api.say("// " + dev + " 加入虚拟组 " + vrid + "：VIP " + vip + "，虚拟 MAC " + VMAC + "。", "op");
      if(R.master === dev){
        api.say("// 现在组里只有它自己（或它优先级最高），所以它是 Master。", "op");
      }else{
        api.say("// " + R.master + " 优先级更高，本机是 Backup。", "op");
      }
      api.fx({ kind: "pulse", target: dev + "/GE0/0/1", color: COL.master });
    }
  },
  {
    id: "vrrp-priority", match: /^vrrp vrid (\d+) priority (\d+)$/, view: "if", kind: "config",
    usage: "vrrp vrid 1 priority 120",
    explain: [
      { h: "第一关键字", p: "先比优先级，大的当 Master；优先级相同才比接口 IP，大的当 Master。" },
      { h: "取值范围", p: "1 ~ 254。缺省 100；255 是保留值，留给「接口 IP 拥有者」。" },
      { h: "抢占", p: "优先级更高的 Backup 会主动抢回 Master（缺省 Preempt YES）。" }
    ],
    run(api, m){
      if(!isVlanif(api.ctx.ifName)){
        api.say("Error: Unrecognized command found at '^' position.", "err");
        api.say("      VRRP 配在三层接口上：interface Vlanif 10。", "dim");
        return;
      }
      const vrid = parseInt(m[1], 10), v = parseInt(m[2], 10);
      if(vrid !== VRID){ api.say("// 本实验只模拟 VRID " + VRID + "。", "op"); return; }
      if(v < 1 || v > 254){
        api.say("// VRRP 优先级范围 1 ~ 254（255 保留给接口 IP 拥有者）。", "op");
        return;
      }
      const dev = api.ctx.dev, sw = api.S[dev], vv = sw.vrrp;
      if(vv.priority === v){
        api.say("// " + dev + " 的优先级本来就是 " + v + "，命令未产生状态变化。", "op");
        return;
      }
      const before = rolesSnapshot(api.S);
      const from = vv.priority;
      vv.priority = v;
      api.change(dev + " · priority", from, v, { row: "v-" + dev });
      api.tab("vrrp");
      const R = commit(api, before, "优先级 " + from + " → " + v);
      api.say("// " + dev + " 优先级 " + from + " → " + v +
        (vv.track.reduced > 0 ? "（PriorityRun 仍是 " + effPriority(sw) + "，track 会在此基础上扣）" : ""), "op");
      if(!vv.enabled) api.say("// 还没有 virtual-ip，这个 vrid 暂时不会进入 Master 选举。", "op");
      else if(R.master === dev) api.say("// 优先级最高，本机是 Master。", "op");
      else api.say("// " + R.master + " 仍然是 Master。", "op");
    }
  },
  {
    id: "vrrp-preempt", match: /^vrrp vrid (\d+) preempt-mode timer delay (\d+)$/, view: "if", kind: "config",
    usage: "vrrp vrid 1 preempt-mode timer delay 20",
    explain: [
      { h: "抢占默认就开着", p: "Preempt YES、Delay 0：只要优先级更高，立刻抢回 Master。" },
      { h: "为什么要延时", p: "设备刚恢复时上行、路由都还没收敛。这时抢回 Master，流量会吸过来又丢，于是来回切。延时的意思是「先等一会儿，稳了再抢」。" }
    ],
    run(api, m){
      if(!isVlanif(api.ctx.ifName)){
        api.say("Error: Unrecognized command found at '^' position.", "err");
        api.say("      VRRP 配在三层接口上：interface Vlanif 10。", "dim");
        return;
      }
      const vrid = parseInt(m[1], 10), d = parseInt(m[2], 10);
      if(vrid !== VRID){ api.say("// 本实验只模拟 VRID " + VRID + "。", "op"); return; }
      if(d > 3600){ api.say("// 抢占延时范围 0 ~ 3600 秒。", "op"); return; }
      const dev = api.ctx.dev, vv = api.S[dev].vrrp;
      if(vv.delay === d){
        api.say("// " + dev + " 的抢占延时本来就是 " + d + " s，命令未产生状态变化。", "op");
        return;
      }
      const from = vv.delay;
      vv.delay = d;
      api.change(dev + " · preempt delay", from + " s", d + " s", { row: "v-" + dev });
      api.tab("timer");
      api.say("// " + dev + " 抢占延时 " + from + " s → " + d + " s。", "op");
      if(d > 0) api.say("// 延时只推迟「抢回」的时刻，不改变最终谁是 Master；本模型直接给稳态结果。", "op");
      else api.say("// 延时归零：优先级更高就立刻抢回。", "op");
    }
  },
  {
    id: "vrrp-track", match: /^vrrp vrid (\d+) track interface (?:GigabitEthernet|GE)\s*([\d/]+) reduced (\d+)$/i,
    view: "if", kind: "config",
    usage: "vrrp vrid 1 track interface GigabitEthernet 0/0/2 reduced 30",
    explain: [
      { h: "把接口状态接进优先级", p: "被跟踪的接口 down，PriorityRun 立即下调 reduced。优先级掉到对手之下，Master 就让出去。" },
      { h: "为什么必须配", p: "上行断了但 Vlanif 还是 up，VRRP 完全察觉不到 —— 本机会继续当 Master，把流量收进来再丢掉，这就是<b>黑洞</b>。" },
      { h: "注意降多少", p: "120 − 30 = 90 < 100，才能被 100 的备机盖过。减得太少（比如 10）等于没配。" }
    ],
    run(api, m){
      if(!isVlanif(api.ctx.ifName)){
        api.say("Error: Unrecognized command found at '^' position.", "err");
        api.say("      VRRP 配在三层接口上：interface Vlanif 10。", "dim");
        return;
      }
      const vrid = parseInt(m[1], 10), red = parseInt(m[3], 10);
      const key = "GE" + m[2];
      if(vrid !== VRID){ api.say("// 本实验只模拟 VRID " + VRID + "。", "op"); return; }
      const dev = api.ctx.dev, sw = api.S[dev], vv = sw.vrrp;
      if(!(key in sw.up)){
        api.say("Error: The port does not exist.", "err");
        return;
      }
      if(red < 1 || red > 255){
        api.say("// Priority reduced 范围 1 ~ 255。", "op");
        return;
      }
      if(vv.track.iface === key && vv.track.reduced === red){
        api.say("// 已经在跟踪 " + key + "（reduced " + red + "），命令未产生状态变化。", "op");
        return;
      }
      const before = rolesSnapshot(api.S);
      const from = vv.track.reduced ? vv.track.iface + " reduced " + vv.track.reduced : "未跟踪";
      vv.track.iface = key;
      vv.track.reduced = red;
      api.change(dev + " · track", from, key + " reduced " + red, { row: "i-" + dev + "-" + key, kind: from === "未跟踪" ? "enter" : "chg" });
      api.tab("iface");
      const reason = (!sw.up[key] && red > 0)
        ? "track " + key + " down · 优先级 −" + red
        : "配置 track";
      commit(api, before, reason);
      api.say("// " + dev + " 跟踪 " + key + "，接口 down 时优先级 −" + red + "：" +
        vv.priority + " → " + Math.max(1, vv.priority - red) + "。", "op");
      if(!vv.enabled) api.say("// 虚拟组还没建（没有 virtual-ip），track 先记着，暂不影响选举。", "op");
    }
  },
  {
    id: "undo-vrrp", match: /^undo vrrp vrid (\d+)$/, view: "if", kind: "config",
    usage: "undo vrrp vrid 1",
    explain: [
      { h: "删掉整个虚拟组", p: "VIP、优先级、抢占延时、track 一起清掉，回到「只有实地址」的状态。" }
    ],
    run(api, m){
      if(!isVlanif(api.ctx.ifName)){
        api.say("Error: Unrecognized command found at '^' position.", "err");
        api.say("      VRRP 配在三层接口上：interface Vlanif 10。", "dim");
        return;
      }
      const vrid = parseInt(m[1], 10);
      const dev = api.ctx.dev, vv = api.S[dev].vrrp;
      if(!vv.enabled){
        api.say("// " + dev + " 上没有虚拟组 " + vrid + "，命令未产生状态变化。", "op");
        return;
      }
      const before = rolesSnapshot(api.S);
      const from = "vrid " + vv.vrid + " / " + vv.vip;
      vv.enabled = false; vv.vip = "";
      vv.priority = 100; vv.preempt = true; vv.delay = 0;
      vv.track.reduced = 0;
      api.change(dev + " · vrid " + vrid, from, "已删除", { row: "v-" + dev, kind: "exit" });
      api.tab("vrrp");
      commit(api, before, "虚拟组删除");
      api.say("// " + dev + " 的虚拟组 " + vrid + " 已删除：VIP、优先级、track 全部清掉。", "op");
      api.say("// 如果 PC 的网关是这个 VIP，业务立刻就断了。", "op");
    }
  },
  {
    id: "shutdown", match: /^shutdown$/, view: "if", kind: "config", usage: "shutdown",
    explain: [
      { h: "管理性关闭", p: "接口 down 是「人为关掉」，不是链路坏。对 VRRP 来说，Vlanif down = 退出选举（Initialize）。" },
      { h: "两种 down 不一样", p: "Vlanif10 down 会让整台设备失去三层接口；GE0/0/2 down 只是上行没了，Vlanif 还 up —— 后者必须靠 track 才能被发现。" }
    ],
    run(api){
      const dev = api.ctx.dev, n = String(api.ctx.ifName), sw = api.S[dev];
      if(isVlanif(n)){
        const vif = sw.vlanif[10];
        if(!vif.up){ api.say("// " + dev + " Vlanif10 已经是 down，命令未产生状态变化。", "op"); return; }
        const before = rolesSnapshot(api.S);
        vif.up = false;
        api.change(dev + " · Vlanif10", "up", "down", { row: "i-" + dev + "-10" });
        api.tab("iface");
        commit(api, before, "Vlanif10 shutdown");
        api.say("// " + dev + " Vlanif10 关闭：接口 down，这个虚拟组进入 Initialize，退出 Master 选举。", "op");
        api.say("// 这相当于整台设备的三层网关没了 —— 与「上行断但接口还在」不是一回事。", "op");
        api.fx({ kind: "pulse", target: dev + "/Vlanif10", color: COL.bad });
        return;
      }
      const key = geKey(n);
      if(!(key in sw.up)){ api.say("// " + dev + " 上没有 " + key + "。", "op"); return; }
      if(!sw.up[key]){ api.say("// " + dev + " " + key + " 已经是 down，命令未产生状态变化。", "op"); return; }
      const before = rolesSnapshot(api.S);
      sw.up[key] = false;
      api.change(dev + " · " + key, "up", "down", { row: "i-" + dev + "-" + key });
      api.tab("iface");
      const R = commit(api, before, key + " shutdown");
      api.say("// " + dev + " " + key + " 关闭。", "op");
      if(sw.vrrp.track.reduced > 0 && sw.vrrp.track.iface === key){
        api.say("// track 生效：PriorityRun " + sw.vrrp.priority + " → " + effPriority(sw) + "，角色随之重算。", "op");
      }else{
        api.say("// 这个口没有配 track：VRRP 看不到它，Vlanif 还 up 的话本机仍然是 Master —— 这正是黑洞。", "op");
      }
      api.fx({ kind: "pulse", target: dev + "/" + key, color: R.master === dev ? COL.bad : COL.backup });
    }
  },
  {
    id: "undo-shutdown", match: /^undo shutdown$/, view: "if", kind: "config", usage: "undo shutdown",
    explain: [
      { h: "恢复接口", p: "接口回到 up。Vlanif 恢复后重新进入选举，优先级高的那台会按抢占规则拿回 Master。" }
    ],
    run(api){
      const dev = api.ctx.dev, n = String(api.ctx.ifName), sw = api.S[dev];
      if(isVlanif(n)){
        const vif = sw.vlanif[10];
        if(vif.up){ api.say("// " + dev + " Vlanif10 本来就是 up，命令未产生状态变化。", "op"); return; }
        const before = rolesSnapshot(api.S);
        vif.up = true;
        api.change(dev + " · Vlanif10", "down", "up", { row: "i-" + dev + "-10" });
        api.tab("iface");
        commit(api, before, "Vlanif10 恢复");
        api.say("// " + dev + " Vlanif10 恢复 up，重新加入虚拟组选举。", "op");
        return;
      }
      const key = geKey(n);
      if(!(key in sw.up)){ api.say("// " + dev + " 上没有 " + key + "。", "op"); return; }
      if(sw.up[key]){ api.say("// " + dev + " " + key + " 本来就是 up，命令未产生状态变化。", "op"); return; }
      const before = rolesSnapshot(api.S);
      sw.up[key] = true;
      api.change(dev + " · " + key, "down", "up", { row: "i-" + dev + "-" + key });
      api.tab("iface");
      commit(api, before, key + " 恢复");
      api.say("// " + dev + " " + key + " 恢复 up。", "op");
      if(sw.vrrp.track.reduced > 0 && sw.vrrp.track.iface === key)
        api.say("// track 恢复：PriorityRun 回到 " + effPriority(sw) + "。", "op");
    }
  },

  /* ---- 只读命令 ---- */
  {
    id: "disp-vrrp", match: /^display vrrp$/, view: null, kind: "doc", usage: "display vrrp",
    doc: "本机每个虚拟组的明细：State、Master IP、PriorityRun / PriorityConfig、抢占延时、Virtual MAC、track。判读顺序是 <b>State → Master IP → PriorityRun</b>。",
    run(api){ dispVrrp(api); }
  },
  {
    id: "disp-vrrp-brief", match: /^display vrrp brief$/, view: null, kind: "doc", usage: "display vrrp brief",
    doc: "一行摘要：本机是 Master 还是 Backup、配置优先级与生效优先级、当前 Master 的接口地址。多台设备对照着看最直观。",
    run(api){ dispBrief(api); }
  },
  {
    id: "disp-vrrp-stat", match: /^display vrrp statistics$/, view: null, kind: "doc", usage: "display vrrp statistics",
    doc: "通告收发计数与状态切换次数。<b>Master 只发不收、Backup 只收不发</b>；Transitions to Master 是这台设备当过几次 Master。",
    run(api){ dispStats(api); }
  },
  {
    id: "disp-arp", match: /^display arp$/, view: null, kind: "doc", usage: "display arp",
    doc: "三层接口学到的邻居。关键不是这张表本身，而是<b>PC 侧</b>缓存的是哪个 MAC —— 网关是 VIP 时，PC 缓存的是虚拟 MAC。",
    run(api){ dispArp(api); }
  }
];

/* ---------------- 只读命令的回显 ---------------- */
function dispVrrp(api){
  const S = api.S, dev = api.ctx.dev, sw = S[dev], v = sw.vrrp;
  api.tab("vrrp");
  if(!v.enabled || !v.vip){
    api.say("// " + dev + " 上还没有 VRRP 虚拟组，display vrrp 没有内容可显示。", "op");
    api.say("// 先 interface Vlanif 10 → vrrp vrid " + VRID + " virtual-ip " + VIP + "。", "op");
    return;
  }
  const R = vrrpRoles(S);
  const role = R.roles[dev];
  const eff = effPriority(sw);
  const masterIp = R.master ? S[R.master].vlanif[10].ip : "0.0.0.0";
  const masterPri = R.master ? effPriority(S[R.master]) : 0;

  api.say("Vlanif10 | Virtual Router " + v.vrid);
  api.say(pad("State", 19) + ": " + role.code);
  api.say(pad("Virtual IP", 19) + ": " + v.vip);
  api.say(pad("Master IP", 19) + ": " + masterIp);
  api.say(pad("PriorityRun", 19) + ": " + eff);
  api.say(pad("PriorityConfig", 19) + ": " + v.priority);
  api.say(pad("MasterPriority", 19) + ": " + masterPri);
  api.say(pad("Preempt", 19) + ": " + (v.preempt ? "YES" : "NO") + "   Delay Time : " + v.delay + " s");
  api.say(pad("TimerRun", 19) + ": " + ADV + " s");
  api.say(pad("TimerConfig", 19) + ": " + ADV + " s");
  api.say(pad("Virtual MAC", 19) + ": " + VMAC);
  api.say(pad("Check TTL", 19) + ": YES");
  api.say(pad("Config type", 19) + ": normal-vrrp");
  if(v.track && v.track.reduced > 0){
    api.say(pad("Track interface", 19) + ": " + v.track.iface + "  Priority reduced : " + v.track.reduced);
  }
  api.say(pad("Total switch times", 19) + ": " + S.stat.tr[dev]);
  api.say("", "dim");

  if(role.code === "Master"){
    api.say("// 本机是 Master：持有 VIP " + v.vip + " 和虚拟 MAC " + VMAC + "，每秒发一次通告，业务从本机上行转发。", "op");
  }else if(role.code === "Backup"){
    api.say("// 本机是 Backup：只收通告、不转发虚拟 MAC 的业务。3s 收不到通告就接管（MDI = " + MDI + "s）。", "op");
  }else{
    api.say("// 本机是 Initialize：Vlanif10 down，虚拟组还没开始工作，不参与选举。", "op");
  }
  if(eff !== v.priority){
    api.say("// PriorityRun(" + eff + ") 比 PriorityConfig(" + v.priority + ") 低 " + (v.priority - eff) +
      "：track 的 " + v.track.iface + " 已经 down，优先级被自动下调。", "op");
  }
  api.say("// Virtual MAC 由 VRID 算出，两台完全一致；但它只在 Master 上真正承载业务。", "op");
}

function dispBrief(api){
  const S = api.S, dev = api.ctx.dev, sw = S[dev], v = sw.vrrp;
  api.tab("vrrp");
  if(!v.enabled || !v.vip){
    api.say("// " + dev + " 没有 VRRP 配置。", "op");
    return;
  }
  const R = vrrpRoles(S);
  const role = R.roles[dev];
  const eff = effPriority(sw);
  const masterIp = R.master ? S[R.master].vlanif[10].ip : "0.0.0.0";
  api.say(pad("VRID", 6) + pad("State", 11) + pad("Interface", 14) + pad("Grp-Pri", 9) +
    pad("Run-Pri", 9) + pad("Master IP", 17) + "Virtual IP", "dim");
  api.say("--------------------------------------------------------------------------------", "dim");
  api.say(pad(v.vrid, 6) + pad(role.code, 11) + pad("Vlanif10", 14) + pad(v.priority, 9) +
    pad(eff, 9) + pad(masterIp, 17) + v.vip);
  api.say("", "dim");
  api.say("// Grp-Pri 是配置值，Run-Pri 是生效值；两者不等就说明 track 在起作用。", "op");
}

function dispStats(api){
  const S = api.S, dev = api.ctx.dev, v = S[dev].vrrp;
  api.tab("timer");
  if(!v.enabled || !v.vip){
    api.say("// " + dev + " 没有 VRRP 配置，没有统计。", "op");
    return;
  }
  const R = vrrpRoles(S);
  const role = R.roles[dev].code;
  const sent = role === "Master" ? 128 : 0;
  const recv = role === "Backup" ? 128 : 0;

  api.say("VRRP statistics for Vlanif10", "dim");
  api.say("--------------------------------------------------------------", "dim");
  api.say(pad("  Checksum errors", 36) + ": 0");
  api.say(pad("  Version errors", 36) + ": 0");
  api.say(pad("  Vrid errors", 36) + ": 0");
  api.say(pad("  Advertisement interval errors", 36) + ": 0");
  api.say(pad("  Advertisement packets received", 36) + ": " + recv);
  api.say(pad("  Advertisement packets sent", 36) + ": " + sent);
  api.say(pad("  Transitions to Master", 36) + ": " + S.stat.tr[dev]);
  api.say("", "dim");
  api.say("// Master 只发、Backup 只收 —— 所以两边的收/发计数必然一边倒。", "op");
  api.say("// 计数是模型值（按每秒 1 条折算）；Transitions to Master 才是本实验真实推演出来的。", "op");
}

function dispArp(api){
  const S = api.S, dev = api.ctx.dev;
  api.tab("arp");
  api.say(pad("IP ADDRESS", 17) + pad("MAC ADDRESS", 17) + pad("EXPIRE(M)", 11) + pad("TYPE", 12) + "INTERFACE", "dim");
  api.say("-------------------------------------------------------------------------------", "dim");
  ["PC1", "PC2"].forEach(function(id){
    api.say(pad(HOSTS[id].ip, 17) + pad(HOSTS[id].mac, 17) + pad("20", 11) + pad("D-0", 12) + "Vlanif10");
  });
  api.say("", "dim");
  const gw = S.pc.PC1.gw;
  if(gw === VIP){
    api.say("// 这是 " + dev + " 自己的邻居表。PC 侧缓存的是网关 " + VIP + " → " + VMAC + "（虚拟 MAC）。", "op");
    api.say("// 这个映射由 VRID 决定，Master 换人时一个字节都不变。", "op");
  }else{
    const ownerDev = gw === S.SW1.vlanif[10].ip ? "SW1" : gw === S.SW2.vlanif[10].ip ? "SW2" : null;
    api.say("// PC 侧缓存的是网关 " + gw + " → " + (ownerDev ? S[ownerDev].mac : "无法解析") +
      "（" + (ownerDev || "网关") + " 的物理 MAC）。", "op");
    api.say("// 物理 MAC 会随着设备更换而变：这就是「换网关要改每台 PC」的根源。", "op");
  }
}

/* ---------------- 表项 ---------------- */
function tables(S, tab, ctx){
  const R = vrrpRoles(S);

  if(tab === "vrrp"){
    const rows = ["SW1", "SW2"].map(function(d){
      const sw = S[d], v = sw.vrrp;
      const role = R.roles[d];
      const eff = effPriority(sw);
      const pri = v.enabled ? (eff !== v.priority ? v.priority + " → " + eff : String(v.priority)) : "—";
      return {
        key: "v-" + d,
        cells: [
          { t: d, cls: "c" },
          { t: v.enabled ? v.vrid : "—", cls: "c" },
          { t: pri, cls: eff !== v.priority ? "warn" : "c" },
          {
            t: role.code,
            cls: role.code === "Master" ? "ok" : role.code === "Backup" ? "warn" : role.code === "Initialize" ? "bad" : "dim"
          },
          { t: v.enabled ? v.vip : "—", cls: "c" },
          { t: v.enabled ? VMAC : "—", cls: v.enabled ? "c" : "dim" },
          { t: v.enabled ? "ADV " + ADV + "s / MDI " + MDI + "s" : "—", cls: "c" }
        ]
      };
    });
    return {
      head: ["DEVICE", "VRID", "PRIORITY", "STATE", "VIRTUAL IP", "VIRTUAL MAC", "TIMERS"],
      rows: rows,
      note: "PRIMARY 一列显示「配置值 → 生效值」（track 扣减后的结果）。State 由「生效优先级高者胜、相同则接口 IP 大者胜」算出：缺省都是 100 时 SW2 的 .253 更大，所以 SW2 先当 Master。"
    };
  }

  if(tab === "iface"){
    const rows = [];
    ["SW1", "SW2"].forEach(function(d){
      const sw = S[d];
      const role = R.roles[d];
      let roleTxt, roleCls;
      if(!sw.vrrp.enabled){ roleTxt = "未启用 VRRP"; roleCls = "dim"; }
      else if(!sw.vlanif[10].up){ roleTxt = "Initialize · 退出选举"; roleCls = "bad"; }
      else if(role.code === "Master"){ roleTxt = "Master · 持有 VIP"; roleCls = "ok"; }
      else { roleTxt = "Backup · 只收通告"; roleCls = "warn"; }
      rows.push({
        key: "i-" + d + "-10",
        cells: [
          { t: d + " Vlanif10", cls: "c" },
          { t: sw.vlanif[10].ip + "/24", cls: "c" },
          { t: sw.vlanif[10].up ? "up" : "down", cls: sw.vlanif[10].up ? "ok" : "bad" },
          { t: roleTxt, cls: roleCls }
        ]
      });
      rows.push({
        key: "i-" + d + "-GE0/0/2",
        cells: [
          { t: d + " GE0/0/2（上行→R1）", cls: "c" },
          { t: "—", cls: "dim" },
          { t: sw.up["GE0/0/2"] ? "up" : "down", cls: sw.up["GE0/0/2"] ? "ok" : "bad" },
          {
            t: sw.vrrp.track.reduced > 0 ? "track 对象 · down 时 −" + sw.vrrp.track.reduced : "未被 track",
            cls: sw.vrrp.track.reduced > 0 ? (sw.up["GE0/0/2"] ? "warn" : "bad") : "dim"
          }
        ]
      });
      rows.push({
        key: "i-" + d + "-GE0/0/1",
        cells: [
          { t: d + " GE0/0/1（接 PC）", cls: "c" },
          { t: "—", cls: "dim" },
          { t: sw.up["GE0/0/1"] ? "up" : "down", cls: sw.up["GE0/0/1"] ? "ok" : "bad" },
          { t: "二层接入口", cls: "c" }
        ]
      });
    });
    return {
      head: ["INTERFACE", "IP", "状态", "角色"],
      rows: rows,
      note: "Vlanif10 down 会让设备直接退出选举（Initialize）；GE0/0/2 down 只是上行没了，Vlanif 还 up —— 只有配了 track，VRRP 才会知道这件事。"
    };
  }

  if(tab === "arp"){
    const rows = ["PC1", "PC2"].map(function(id){
      const gw = S.pc[id].gw;
      const isVip = gw === VIP;
      let mac, note, cls;
      if(isVip){
        mac = VMAC;
        note = "虚拟 MAC：Master 换人也不变";
        cls = "ok";
      }else{
        const owner = gw === S.SW1.vlanif[10].ip ? "SW1" : gw === S.SW2.vlanif[10].ip ? "SW2" : null;
        mac = owner ? S[owner].mac : "未解析";
        note = owner ? owner + " 的物理 MAC：设备一换就得重新 ARP" : "网关不在线，ARP 解析失败";
        cls = "warn";
      }
      return {
        key: "a-" + id,
        cells: [
          { t: id, cls: "c" },
          { t: gw, cls: "c" },
          { t: mac, cls: cls },
          { t: note, cls: "c" }
        ]
      };
    });
    return {
      head: ["HOST", "GATEWAY", "ARP 解析到的 MAC", "判读"],
      rows: rows,
      note: "网关写成 VIP 时，PC 的 ARP 缓存里是 0000-5e00-0101（虚拟 MAC），与谁当 Master 无关；写成实地址时缓存的是那台设备的物理 MAC，设备一换就必须重新 ARP。"
    };
  }

  /* timer */
  const tr = S.SW1.vrrp.track;
  const trackVal = tr.reduced > 0
    ? tr.iface + " −" + tr.reduced + (S.SW1.up[tr.iface] ? "（当前 up）" : "（当前 down）")
    : "未配置";
  return {
    head: ["项目", "值", "说明"],
    rows: [
      {
        key: "t-adv",
        cells: [
          { t: "Advertisement Interval", cls: "c" },
          { t: ADV + " s", cls: "c" },
          { t: "Master 每秒向 224.0.0.18 发一次通告；Backup 只收不发", cls: "c" }
        ]
      },
      {
        key: "t-mdi",
        cells: [
          { t: "Master Down Interval", cls: "c" },
          { t: MDI + " s", cls: "c" },
          { t: "3 × Advertisement：连续 3 秒收不到通告，就认为 Master 已失效", cls: "c" }
        ]
      },
      {
        key: "t-pre",
        cells: [
          { t: "Preempt Delay（SW1）", cls: "c" },
          { t: S.SW1.vrrp.delay + " s", cls: "c" },
          { t: "抢占延时：上行未收敛就抢回 Master 会让流量来回切", cls: "c" }
        ]
      },
      {
        key: "t-track",
        cells: [
          { t: "Track（SW1）", cls: "c" },
          { t: trackVal, cls: tr.reduced > 0 ? "warn" : "dim" },
          { t: "被跟踪接口 down → PriorityRun 立即下调 reduced", cls: "c" }
        ]
      },
      {
        key: "t-last",
        cells: [
          { t: "最近切换", cls: "c" },
          { t: S.stat.last, cls: "c" },
          { t: "每次 Master 换人记一条，从哪台到哪台、因为什么", cls: "c" }
        ]
      },
      {
        key: "t-cnt",
        cells: [
          { t: "切换次数", cls: "c" },
          { t: "SW1 " + S.stat.tr.SW1 + " · SW2 " + S.stat.tr.SW2, cls: "c" },
          { t: "对应 display vrrp statistics 的 Transitions to Master", cls: "c" }
        ]
      }
    ],
    note: "简化：本实验按 Advertisement 1s / Master Down 3s 计时，不模拟 skew time、认证与 ARP 老化；切换记录是状态推演的结果，不是真实时钟。"
  };
}

/* ---------------- 拓扑 ---------------- */
function topology(S, ui, ctx){
  const R = vrrpRoles(S);
  const up1 = uplinkUp(S, "SW1");
  const up2 = uplinkUp(S, "SW2");

  /* 这台设备此刻是否真的在转发网关流量：Master，或者 PC 的网关还指向它的实地址 */
  function serving(dev){
    const sw = S[dev];
    if(!sw.vlanif[10].up) return false;
    if(R.roles[dev].code === "Master") return true;
    return S.pc.PC1.gw === sw.vlanif[10].ip || S.pc.PC2.gw === sw.vlanif[10].ip;
  }
  function flowOf(dev, up){
    if(!up) return 0;
    if(serving(dev)) return 1;
    if(S[dev].vrrp.enabled && R.roles[dev].code === "Backup") return 0.06;  /* 心跳 */
    return 0;
  }
  function flowColorOf(dev){
    if(serving(dev)) return "56,225,255";
    if(S[dev].vrrp.enabled && R.roles[dev].code === "Backup") return "255,181,69";
    return "126,147,171";
  }
  const wanOn = (up1 && serving("SW1")) || (up2 && serving("SW2"));

  function portColor(dev, pn){
    if(!S[dev].up[pn]) return COL.off;
    if(pn === "GE0/0/2"){
      if(serving(dev)) return COL.master;
      if(S[dev].vrrp.enabled && R.roles[dev].code === "Backup") return COL.backup;
      return COL.off;
    }
    return COL.pc;
  }

  const devices = ["SW1", "SW2"].map(function(id){
    const d = DEV[id];
    return {
      id: id, x: d.x, y: d.y, w: d.w, h: d.h, model: "S5700-28C-EI",
      silk: "M12 24 h60 M12 28 h44 M12 32 h60 M12 36 h44",
      leds: [
        { x: 272, y: 10, color: COL.ok, glow: true, label: "PWR", tx: 278, ty: 12.5 },
        { x: 258, y: 10, color: COL.master, glow: true, label: "SYS", tx: 232, ty: 12.5 }
      ],
      ports: PORT_GEO[id].map(function(g){
        return {
          name: g.name, kind: g.kind, x: g.x, y: g.y,
          color: portColor(id, g.name), up: S[id].up[g.name],
          label: g.label, dimBand: !S[id].up[g.name]
        };
      }),
      tags: [
        { x: 0, y: -8, text: id, cls: "dev-label" },
        { x: 34, y: -8, text: "S5700 · Vlanif10 " + S[id].vlanif[10].ip, cls: "dev-sub" }
      ]
    };
  });

  devices.push({
    id: "R1", x: DEV.R1.x, y: DEV.R1.y, w: DEV.R1.w, h: DEV.R1.h, model: "AR2220",
    silk: "M12 24 h52 M12 28 h40 M12 32 h52 M12 36 h40",
    leds: [
      { x: 236, y: 10, color: COL.ok, glow: true, label: "PWR", tx: 242, ty: 12.5 }
    ],
    ports: [
      { name: "GE0/0/1", kind: "sfp", x: 2, y: 44, color: COL.master, up: S.R1.up["GE0/0/1"], label: "1" },
      { name: "GE0/0/2", kind: "sfp", x: 236, y: 44, color: COL.master, up: S.R1.up["GE0/0/2"], label: "2" }
    ],
    tags: [
      { x: 0, y: -8, text: "R1", cls: "dev-label" },
      { x: 34, y: -8, text: "AR2220 · 出口 10.0.0.1", cls: "dev-sub" }
    ]
  });

  const hosts = ["PC1", "PC2"].map(function(id){
    const h = HOSTS[id];
    return {
      id: id, x: h.x, y: 240, ip: h.ip, mac: h.mac, vlan: 10,
      color: S.pc[id].gw === VIP ? COL.ok : COL.backup,
      up: S[h.sw].up[h.port]
    };
  });

  const links = [
    {
      id: "lk-sw1-r1", d: ROUTES["sw1-r1"],
      cls: up1 ? (serving("SW1") ? "trunk on" : "trunk") : "down",
      flow: flowOf("SW1", up1), flowColor: flowColorOf("SW1")
    },
    {
      id: "lk-sw2-r1", d: ROUTES["sw2-r1"],
      cls: up2 ? (serving("SW2") ? "trunk on" : "trunk") : "down",
      flow: flowOf("SW2", up2), flowColor: flowColorOf("SW2")
    },
    {
      id: "lk-pc1", d: ROUTES["pc1-up"], cls: "",
      flow: S.SW1.up["GE0/0/1"] ? 0.35 : 0, flowColor: "167,139,250"
    },
    {
      id: "lk-pc2", d: ROUTES["pc2-up"], cls: "",
      flow: S.SW2.up["GE0/0/1"] ? 0.35 : 0, flowColor: "167,139,250"
    },
    {
      id: "lk-wan", d: ROUTES["r1-wan"], cls: "",
      flow: wanOn ? 0.7 : 0, flowColor: "53,224,138"
    }
  ];

  const labels = [];
  ["SW1", "SW2"].forEach(function(d){
    const code = R.roles[d].code;
    const cx = d === "SW1" ? 280 : 1120;
    let t1, t2, c1;
    if(code === "Master"){
      t1 = "MASTER · PRI " + effPriority(S[d]);
      t2 = "VIP " + VIP + " / " + VMAC;
      c1 = "lk-tag on";
    }else if(code === "Backup"){
      t1 = "BACKUP · PRI " + effPriority(S[d]);
      t2 = "监听通告 · 3s 超时切换";
      c1 = "lk-tag warn";
    }else if(code === "Initialize"){
      t1 = "INITIALIZE · 接口 down";
      t2 = "不参与选举";
      c1 = "lk-tag bad";
    }else{
      t1 = "VRRP 未启用";
      t2 = "网关只有实地址";
      c1 = "lk-tag";
    }
    labels.push({ text: t1, x: cx, y: 158, anchor: "middle", cls: c1 });
    labels.push({ text: t2, x: cx, y: 172, anchor: "middle", cls: "lk-tag" });
  });

  labels.push({ text: "上行", x: 495, y: 104, anchor: "middle", cls: "lk-tag" });
  labels.push({ text: "上行", x: 905, y: 104, anchor: "middle", cls: "lk-tag" });
  if(S.SW1.vrrp.track.reduced > 0){
    labels.push({
      text: S.SW1.up["GE0/0/2"] ? "TRACK −" + S.SW1.vrrp.track.reduced : "TRACK · DOWN",
      x: 495, y: 132, anchor: "middle",
      cls: S.SW1.up["GE0/0/2"] ? "lk-tag warn" : "lk-tag bad"
    });
  }
  labels.push({ text: "Internet 8.8.8.8", x: 700, y: 16, anchor: "middle", cls: "lk-tag" });

  const gwVip = S.pc.PC1.gw === VIP && S.pc.PC2.gw === VIP;
  labels.push({
    text: gwVip ? "PC 网关 = VIP " + VIP : "PC 网关 = " + S.pc.PC1.gw + "（SW1 实地址）",
    x: 700, y: 250, anchor: "middle",
    cls: gwVip ? "lk-tag on" : "lk-tag warn"
  });

  return {
    viewBox: "0 0 1400 320",
    devices: devices,
    hosts: hosts,
    links: links,
    routes: ROUTES,
    anchors: ANCHORS,
    labels: labels
  };
}

/* ---------------- 数据面场景 ---------------- */
function gwOwner(S, gw){
  if(gw === VIP){
    const R = vrrpRoles(S);
    return R.master;
  }
  if(S.SW1.vlanif[10].ip === gw) return "SW1";
  if(S.SW2.vlanif[10].ip === gw) return "SW2";
  return null;
}

function flowScene(S, hostId){
  const H = HOSTS[hostId];
  const gw = S.pc[hostId].gw;
  const isVip = gw === VIP;
  const owner = gwOwner(S, gw);
  const frames = [];
  const trace = [];
  const sc = {
    name: hostId + " " + H.ip + " → 8.8.8.8 · 网关 " + gw,
    realSec: 4.4, dur: 1,
    traceTitle: "逐跳判读",
    frames: frames, trace: trace, drop: null, verdict: null
  };

  frames.push({ route: H.routeUp, t0: 0, t1: .07, kind: "broadcast", color: COL.pc });

  trace.push({
    h: "① 源主机判路",
    p: "<b>" + H.ip + "/24</b> 访问 <b>8.8.8.8</b>，目的不在本网段 → 交给默认网关 <b>" + gw + "</b>。" +
      (isVip
        ? "PC 的 ARP 缓存里，这个网关 IP 对应 <b>" + VMAC + "</b>（虚拟 MAC）。"
        : "这个网关是实接口地址，PC 缓存的是那台设备的<b>物理 MAC</b>。"),
    cls: ""
  });

  if(!S[H.sw].up[H.port]){
    sc.drop = { route: H.routeUp, p: .55, at: .07, label: "接入口 DOWN" };
    trace.push({
      h: "② 接入链路断了",
      p: H.sw + " " + H.port + " 被 shutdown，PC 连网关的边都摸不到。",
      cls: "drop"
    });
    sc.verdict = { bad: true, text: "接入口 down，与 VRRP 无关。可用 interface GigabitEthernet 0/0/1 → undo shutdown 恢复。" };
    return sc;
  }

  if(!owner){
    sc.drop = { route: H.routeUp, p: .95, at: .07, label: isVip ? "虚拟组没有 Master" : "网关不在线" };
    trace.push({
      h: "② 网关不可达",
      p: isVip
        ? "VIP " + VIP + " 现在没有任何一台设备在当 Master（两台都没起 VRRP，或都 down），ARP 没人应答。"
        : gw + " 不在这两台设备的 Vlanif 上。",
      cls: "drop"
    });
    sc.verdict = { bad: true, text: "网关不存在，报文在源主机就发不出去。先确认 Vlanif10 与 VRRP 虚拟组的状态。" };
    return sc;
  }

  if(!S[owner].vlanif[10].up){
    sc.drop = { route: H.routeUp, p: .95, at: .07, label: "网关接口 DOWN" };
    trace.push({
      h: "② 网关设备的三层接口 down",
      p: gw + " 在 " + owner + " 的 Vlanif10 上，但这个接口被 shutdown 了 —— PC 的 ARP 得不到应答。",
      cls: "drop"
    });
    sc.verdict = { bad: true, text: "PC 只会找自己配置的那个网关。网关设备一故障它没有任何自动切换能力 —— 除非网关是 VIP。" };
    return sc;
  }

  if(owner !== H.sw){
    frames.push({
      route: H.sw === "SW1" ? "l2-s1-s2" : "l2-s2-s1",
      t0: .1, t1: .3, kind: "data", color: COL.pc
    });
    trace.push({
      h: "② 二层转交",
      p: "网关在 " + owner + " 上，而 " + hostId + " 挂在 " + H.sw +
        "。帧的目的 MAC 是" + (isVip ? "虚拟 MAC" : "网关的物理 MAC") +
        "，VLAN 10 是同一个二层域，" + H.sw + " 按二层把它交给 " + owner +
        "（图中省略了两台之间的二层链路）。",
      cls: ""
    });
  }else{
    trace.push({
      h: "② 进入三层接口",
      p: "帧到达网关所在的 " + owner + "，目的 MAC 是" + (isVip ? "虚拟 MAC" : "实接口 MAC") +
        "，进入 Vlanif10 做三层转发。",
      cls: ""
    });
  }

  const uplinkKey = owner === "SW1" ? "sw1-r1" : "sw2-r1";
  if(!uplinkUp(S, owner)){
    sc.drop = { route: uplinkKey, p: .1, at: .32, label: "上行 DOWN · 黑洞" };
    trace.push({
      h: "③ 出方向 · 上行断了",
      p: owner + " 的 GE0/0/2 是它去 R1 的唯一出口，现在 down。报文查完路由没有出口，被丢弃。",
      cls: "drop"
    });
    trace.push({
      h: "④ 为什么 VRRP 没反应",
      p: "VRRP 只看 Vlanif10 的状态。Vlanif 还 up、优先级也没变，所以 " + owner +
        " 仍然是 Master —— 它是「活着但不通」的黑洞。",
      cls: "drop"
    });
    sc.verdict = {
      bad: true,
      text: "这就是不带 track 的 VRRP：网关活着、ARP 能应答、PC 毫无察觉，但流量全丢。修法是 vrrp vrid 1 track interface GigabitEthernet 0/0/2 reduced 30。"
    };
    return sc;
  }

  frames.push({ route: uplinkKey, t0: .34, t1: .56, kind: "data", color: COL.master });
  frames.push({ route: "r1-wan", t0: .58, t1: .72, kind: "data", color: COL.ok });
  trace.push({
    h: "③ 出方向 · " + owner + " GE0/0/2",
    p: "查路由命中默认路由，下一跳 10.0.0.1（R1），从上行口发出。这条链路上有业务流量，说明 " + owner +
      " 是真正在转发的 Master。",
    cls: ""
  });
  trace.push({
    h: "④ 出口路由器 R1",
    p: "R1 把报文送向 Internet 8.8.8.8，回程按路由返回（NAT 不在本实验范围）。",
    cls: "pass"
  });

  frames.push({ route: "wan-r1", t0: .74, t1: .8, kind: "data", color: COL.ok });
  frames.push({ route: "r1-" + owner.toLowerCase(), t0: .8, t1: .9, kind: "data", color: COL.master });
  if(owner !== H.sw){
    frames.push({
      route: H.sw === "SW1" ? "l2-s2-s1" : "l2-s1-s2",
      t0: .9, t1: .97, kind: "data", color: COL.master
    });
  }
  frames.push({ route: H.routeDown, t0: .97, t1: 1, kind: "data", color: COL.master });

  trace.push({
    h: "⑤ 回程",
    p: "回程目的 " + H.ip + "，交给 " + owner + " 的 Vlanif10，再按二层送回主机。",
    cls: "pass"
  });

  sc.verdict = {
    bad: false,
    text: isVip
      ? "通。PC 只知道虚拟 MAC " + VMAC + "，谁是 Master 它并不关心 —— 这就是 VRRP 对终端透明的根本原因。"
      : "通 —— 但 PC 的网关是 " + owner + " 的实地址：" + owner + " 一旦故障，PC 必须手工改网关才能恢复。这正是本实验要消除的单点。"
  };
  return sc;
}

function heartbeatScene(S){
  const R = vrrpRoles(S);
  const m = R.master;
  const frames = [];
  const trace = [];
  const sc = {
    name: "VRRP 通告 · 1s 一次", realSec: 2.4, dur: 1,
    traceTitle: "心跳判读", frames: frames, trace: trace, drop: null, verdict: null
  };

  if(!m){
    trace.push({ h: "没有 Master", p: "虚拟组里没有成员在跑（未配置或接口都 down），所以没有任何通告。", cls: "drop" });
    sc.verdict = { bad: true, text: "没有 Master 就没有通告，也就没有切换 —— 先让至少一台设备进入 Master。" };
    return sc;
  }

  const to = m === "SW1" ? "SW2" : "SW1";
  const key = m === "SW1" ? "l2-s1-s2" : "l2-s2-s1";
  for(let i = 0; i < 3; i++){
    frames.push({ route: key, t0: i * .3, t1: i * .3 + .14, kind: "data", color: COL.backup });
  }
  trace.push({
    h: "① 只有 Master 在发",
    p: "Master " + m + " 每隔 <b>" + ADV + "s</b> 向组播地址 <b>224.0.0.18</b> 发一条 Advertisement。Backup " + to + " 只收不发。",
    cls: ""
  });
  trace.push({
    h: "② 通告里有什么",
    p: "VRID、优先级、Master 的接口 IP、Advertisement Interval。Backup 靠它判断 Master 还活着、优先级有没有变化。",
    cls: ""
  });
  trace.push({
    h: "③ 什么时候接管",
    p: "连续 <b>" + MDI + " 个间隔（3s）</b>收不到通告，Backup 就认为 Master 失效，自己升为 Master 并发免费 ARP。",
    cls: "pass"
  });
  sc.verdict = {
    bad: false,
    text: "备份不是「闲着」，它每秒都在听。切换速度的上限就是这 3 秒 —— 想更快只能缩短 Advertisement Interval。"
  };
  return sc;
}

function failoverScene(S){
  const R = vrrpRoles(S);
  const to = R.master || "SW2";
  const from = to === "SW1" ? "SW2" : "SW1";
  const frames = [];
  const trace = [];
  const sc = {
    name: from + " 失效 · " + to + " 接管",
    realSec: 5.2, dur: 1,
    traceTitle: "切换判读",
    frames: frames, trace: trace, drop: null, verdict: null
  };

  frames.push({ route: to === "SW1" ? "l2-s1-s2" : "l2-s2-s1", t0: .08, t1: .3, kind: "data", color: COL.backup });

  trace.push({
    h: "① " + from + " 的 Vlanif10 被 shutdown",
    p: "接口 down → 这个虚拟组进入 <b>Initialize</b>，立刻停止发通告。注意它不是「优先级变低」，而是直接退出选举。",
    cls: "drop"
  });
  trace.push({
    h: "② " + to + " 等满 Master Down Interval",
    p: "Backup 每秒等一条通告。连续 <b>" + MDI + " 个间隔（3 × " + ADV + "s = " + MDI + "s）</b>收不到，就认定 Master 已失效，自己升为 Master。",
    cls: ""
  });

  frames.push({ route: to === "SW1" ? "sw1-r1" : "sw2-r1", t0: .34, t1: .5, kind: "data", color: COL.backup });

  trace.push({
    h: "③ 免费 ARP（Gratuitous ARP）",
    p: to + " 以 <b>" + VMAC + "</b> 为源 MAC 发免费 ARP，把「VIP " + VIP + " 在这个 MAC 上」通告给二层域和上游 R1。",
    cls: ""
  });
  trace.push({
    h: "④ 终端和上游都不用改",
    p: "PC 的 ARP 缓存里，网关 IP 对应的还是 <b>" + VMAC + "</b> —— 一个字节都没变；R1 看到的也还是同一个 MAC。变化的只是这个 MAC 背后是哪台交换机。",
    cls: "pass"
  });

  frames.push({ route: to === "SW1" ? "sw1-r1" : "sw2-r1", t0: .55, t1: .7, kind: "data", color: COL.master });
  frames.push({ route: "r1-wan", t0: .71, t1: .84, kind: "data", color: COL.ok });
  frames.push({ route: "wan-r1", t0: .85, t1: .9, kind: "data", color: COL.ok });
  frames.push({ route: "r1-" + to.toLowerCase(), t0: .9, t1: .96, kind: "data", color: COL.master });

  trace.push({
    h: "⑤ 业务恢复",
    p: "后续报文经 " + to + " 上行到 R1。中断窗口 ≈ " + MDI + " × " + ADV + "s + 收敛，真实设备通常 3~5s。",
    cls: "pass"
  });

  sc.verdict = {
    bad: false,
    text: "主备切换对终端透明：网关 MAC 是虚拟的，PC 不需要重新 ARP，更不需要改配置。这就是「换网关不用改每台 PC」的实现方式。"
  };
  return sc;
}

function blackholeScene(S){
  const R = vrrpRoles(S);
  const m = R.master || "SW1";
  const frames = [];
  const trace = [];
  const sc = {
    name: m + " 仍是 Master · 上行已断",
    realSec: 4.2, dur: 1,
    traceTitle: "黑洞判读",
    frames: frames, trace: trace, drop: null, verdict: null
  };

  frames.push({ route: "pc1-up", t0: 0, t1: .08, kind: "broadcast", color: COL.pc });
  if(m === "SW2"){
    frames.push({ route: "l2-s1-s2", t0: .1, t1: .28, kind: "data", color: COL.pc });
  }

  const upKey = m === "SW1" ? "sw1-r1" : "sw2-r1";
  sc.drop = { route: upKey, p: .12, at: .32, label: "上行 DOWN · 没有出口" };

  trace.push({
    h: "① 网关还是活的",
    p: "PC 的网关 " + VIP + " 由 " + m + " 的 Vlanif10 承载，接口 up、ARP 正常应答。从终端看，一切正常。",
    cls: ""
  });
  trace.push({
    h: "② " + m + " 仍然是 Master",
    p: "VRRP 只看 Vlanif10 与优先级。GE0/0/2 断了，但没人告诉 VRRP —— 所以它继续当 Master，继续收流量。",
    cls: "drop"
  });
  trace.push({
    h: "③ 报文在出方向被丢",
    p: "查路由的出接口就是 GE0/0/2，链路 down、没有下一跳，报文被丢弃。PC 只看到 ping 超时。",
    cls: "drop"
  });
  trace.push({
    h: "④ 备机在干嘛",
    p: "另一台的优先级比它低，按规则不会接管；它甚至还在正常收通告，认为 Master 好得很。",
    cls: "drop"
  });

  sc.verdict = {
    bad: true,
    text: "黑洞：网关活着但不转发。用 track 把上行口接进优先级，接口 down 就自动降优先级，让备机接管 —— vrrp vrid 1 track interface GigabitEthernet 0/0/2 reduced 30。"
  };
  return sc;
}

export function vrrpScene(S, phase){
  if(phase === "heartbeat") return heartbeatScene(S);
  if(phase === "failover") return failoverScene(S);
  if(phase === "blackhole") return blackholeScene(S);
  return flowScene(S, "PC1");
}

/* ---------------- 引导 ---------------- */
function guide(S, ctx){
  const G = function(phase, why, cmd){ return { phase: phase, why: why, cmd: cmd || "" }; };
  const dev = ctx.dev, sw = S[dev], v = sw.vrrp;
  const peer = dev === "SW1" ? "SW2" : "SW1";
  const bothOn = S.SW1.vrrp.enabled && S.SW2.vrrp.enabled;

  if(ctx.view === "if"){
    const n = String(ctx.ifName);
    if(isVlanif(n)){
      if(!v.enabled)
        return G("vrrp", "VRRP 虚拟组还不存在。一条命令建组：VRID 相同 + 一个虚拟 IP（终端要指的那个网关）。", "vrrp vrid 1 virtual-ip " + VIP);
      if(!bothOn)
        return G("peer", dev + " 的虚拟组已经起来了。对端 " + peer + " 还没有 —— 切到 " + peer + " 配同一个 VRID 和同一个 VIP，才叫冗余。", "");
      if(S.SW1.vrrp.priority === S.SW2.vrrp.priority && dev === "SW1")
        return G("prio", "两台优先级都是 100。相同优先级就比接口 IP：SW2 的 .253 > SW1 的 .252，所以 Master 是 SW2 —— 跟谁先配、谁是主设备都没关系。把 SW1 抬到 120 才能抢回来。", "vrrp vrid 1 priority 120");
      if(dev === "SW1" && v.priority > S.SW2.vrrp.priority && v.delay === 0)
        return G("preempt", "SW1 已经是最高优先级。给抢占加个延时：设备刚恢复时上行还没收敛，立刻抢回 Master 会让流量吸过来又丢，来回切。", "vrrp vrid 1 preempt-mode timer delay 20");
      if(dev === "SW1" && v.track.reduced === 0)
        return G("track", "还差最后一环：让 VRRP 盯住上行口。上行断了 Vlanif 还是 up，不做 track 它就继续当 Master 却转发不出去 —— 黑洞。", "vrrp vrid 1 track interface GigabitEthernet 0/0/2 reduced 30");
      return G("verify", "这个 Vlanif 配完了。display vrrp 核对 State / PriorityRun / Virtual MAC。", "display vrrp");
    }
    if(n === "GigabitEthernet0/0/2"){
      if(sw.up["GE0/0/2"])
        return G("track", "上行口现在是 up。断开它，看 track 会不会把 Master 让给 " + peer + "。", "shutdown");
      return G("verify", "上行已断开。display vrrp 看 PriorityRun 是不是降了，State 有没有让出去。", "display vrrp");
    }
    return G("verify", "这个接口不在实验主线里。quit 退出去。", "quit");
  }

  if(ctx.view === "system"){
    if(!v.enabled)
      return G("vrrp", dev + " 的 Vlanif10 还没有 VRRP 虚拟组。先建组：VRID 1 + VIP " + VIP + "。", "interface Vlanif 10");
    if(!S[peer].vrrp.enabled)
      return G("peer", dev + " 的虚拟组已经起来了。" + peer + " 还是空的 —— 点命令层右上角的 " + peer + " 标签切过去，用同样的 VRID 和 VIP 再配一遍。", "");
    if(dev === "SW1"){
      if(S.SW1.vrrp.priority <= S.SW2.vrrp.priority)
        return G("prio", "两台优先级相同，按接口 IP 决胜 —— SW2 的 .253 更大，它才是 Master。改 SW1 的优先级。", "interface Vlanif 10");
      if(S.pc.PC1.gw !== VIP)
        return G("gw", "PC 的网关还指向 SW1 的实地址 " + S.pc.PC1.gw + "。点下方「PC 网关 → VIP」把它改成 " + VIP + "，Master 换人时终端才不用动。", "");
      if(S.SW1.vrrp.delay === 0)
        return G("preempt", "优先级已经够高。给抢占加 20s 延时，避免上行没收敛就抢回造成来回切。", "interface Vlanif 10");
      if(S.SW1.vrrp.track.reduced === 0)
        return G("track", "最后一步：track 上行口，接口 down 就自动降优先级，别让 Master 变成黑洞。", "interface Vlanif 10");
    }
    return G("verify", "配置齐了。display vrrp / brief / statistics 三条命令交叉核对。", "display vrrp brief");
  }

  return G("enter", "<" + dev + "> 是用户视图，只能看不能改。改配置前先 system-view。", "system-view");
}

/* ---------------- 板块 ---------------- */
const steps = [
  {
    id: 1, name: "基线 · 网关写死在 SW1",
    run: async function(api){
      api.setDev("SW1");
      await api.run(["display vrrp"]);
      api.play(flowScene(api.S, "PC1"));
    },
    summary: "两台 PC 的网关都是 192.168.10.252，业务能通 —— 但这是单点",
    detail: [
      { h: "现在的样子", p: "SW1 / SW2 各有一个 Vlanif10，但只有 SW1 的地址被 PC 当网关用。PC1、PC2 的默认网关都写成 <b>192.168.10.252</b>。" },
      { h: "问题在哪", p: "业务确实通（点下方「PC1 → 8.8.8.8」验证）。但 SW1 的 Vlanif10 一挂，两台 PC 同时断网；而且换网关必须<b>逐台 PC 改配置</b>。" },
      { h: "为什么不能填两个网关", p: "PC 的 IP 配置里只有一个默认网关字段。想要「网关自动切换」，必须在网关这一侧做冗余 —— 这就是 VRRP。" }
    ]
  },
  {
    id: 2, name: "两台都起 VRRP",
    done: function(S){ return S.SW1.vrrp.enabled && S.SW2.vrrp.enabled; },
    run: async function(api){
      api.setDev("SW1");
      await api.run([
        "system-view",
        "interface Vlanif 10",
        "vrrp vrid 1 virtual-ip 192.168.10.254",
        "quit"
      ]);
      api.setDev("SW2");
      await api.run([
        "system-view",
        "interface Vlanif 10",
        "vrrp vrid 1 virtual-ip 192.168.10.254",
        "quit"
      ]);
    },
    summary: "两台加入同一个虚拟组：VRID 1 / VIP 192.168.10.254",
    detail: [
      { h: "三要素必须一致", p: "VRID（1）、VIP（192.168.10.254）、所在的二层域，两台完全一样，才在同一个虚拟组里。" },
      { h: "SW1 先配的时候它是 Master", p: "因为组里只有它一个成员。SW2 一加入，两台优先级都是 100，按接口 IP 比大小 —— Master 立刻换成 SW2。" },
      { h: "VIP 不是任何一台的实地址", p: "192.168.10.254 谁都没有配在接口上，它由当前 Master 持有并对外代表网关。" }
    ]
  },
  {
    id: 3, name: "看状态 · 谁先当 Master", key: true, keepTrace: true,
    run: async function(api){
      api.setDev("SW1");
      await api.run(["display vrrp"]);
      api.setDev("SW2");
      await api.run(["display vrrp"]);
      api.play(heartbeatScene(api.S));
    },
    summary: "优先级都是 100，接口 IP 大的 SW2（.253）先当 Master",
    detail: [
      { h: "反直觉的点", p: "两台配置一字不差，结果却是「右边那台」当 Master。VRRP 的规则是：<b>先比优先级，优先级相同比接口 IP，大的当 Master</b>。SW2 的 .253 > SW1 的 .252。" },
      { h: "现场后果", p: "如果只按「谁是主设备 / 谁先配」去猜 Master，排障时会一开始就看错设备。判断依据只有 State 和 Master IP 两行。" },
      { h: "此刻业务走谁", p: "注意：PC 的网关还是 SW1 的实地址 .252，业务流量仍然走 SW1 —— 谁当 Master 对终端暂时没有影响。点拓扑上的「PC 网关 → VIP」之后，Master 才真正接管。" }
    ]
  },
  {
    id: 4, name: "改优先级抢回 Master",
    done: function(S){ return S.SW1.vrrp.priority === 120; },
    run: async function(api){
      api.setDev("SW1");
      await api.run([
        "system-view",
        "interface Vlanif 10",
        "vrrp vrid 1 priority 120",
        "quit",
        "display vrrp"
      ]);
    },
    summary: "SW1 优先级 100 → 120，抢占成为 Master",
    detail: [
      { h: "第一关键字", p: "120 > 100，SW1 直接拿到 Master，接口 IP 大小不再参与比较。" },
      { h: "Master / Backup 的差别", p: "Master 持有 VIP 与虚拟 MAC，来自虚拟 MAC 的业务从它上行转发；Backup 只收通告，不转发虚拟 MAC 的流量。" },
      { h: "为什么不是 254", p: "优先级范围 1~254，255 是保留值（留给接口 IP 拥有者）。实际工程里常用 120 / 110 这种小步长，留出加减空间。" }
    ]
  },
  {
    id: 5, name: "虚拟 MAC · 切换不断的关键", key: true, keepTrace: true,
    run: async function(api){
      api.setDev("SW1");
      await api.run(["display vrrp"]);
      api.setDev("SW2");
      await api.run(["display vrrp"]);
      api.tab("vrrp");
      api.say("// 两台的 Virtual MAC 都是 0000-5e00-0101（VRID 1），但真正承载业务的是 Master。", "op");
    },
    summary: "Virtual MAC = 0000-5e00-0101，PC 缓存的是它，不是任何一台物理 MAC",
    detail: [
      { h: "虚拟 MAC 怎么来的", p: "VRRP 规定虚拟 MAC 为 <b>0000-5e00-01 + VRID</b>，VRID 1 → 0000-5e00-0101。两台设备的配置里都是这个值，与物理 MAC 无关。" },
      { h: "PC 看到的是谁", p: "PC 对网关 " + VIP + " 做 ARP，Master 用<b>虚拟 MAC</b> 应答。所以 PC 的 ARP 缓存里永远是 0000-5e00-0101。" },
      { h: "为什么切换不断", p: "Master 换人时，这个 IP→MAC 的映射没有变。PC 不需要重新 ARP，也不改任何配置；变的只是这个 MAC 背后是哪台交换机在转发。" },
      { h: "别把它当成两台都在转发", p: "虚拟 MAC 两台都知道，但只有 Master 用它承载业务。Backup 收到目的为虚拟 MAC 的帧时，只在二层域里转交给 Master。" }
    ]
  },
  {
    id: 6, name: "PC 网关改成 VIP", keepTrace: true,
    done: function(S){ return S.pc.PC1.gw === VIP && S.pc.PC2.gw === VIP; },
    run: function(api){
      const from = api.S.pc.PC1.gw;
      setGateway(api.S, VIP);
      api.change("PC1 · 默认网关", from, VIP, { row: "a-PC1" });
      api.change("PC2 · 默认网关", from, VIP, { row: "a-PC2" });
      api.tab("arp");
      api.say("// 两台 PC 的默认网关从 " + from + " 改成 VIP " + VIP + "。", "op");
      api.play(flowScene(api.S, "PC1"));
    },
    summary: "网关指向 192.168.10.254，业务照常，但终端从此与「谁当 Master」解耦",
    detail: [
      { h: "改了什么", p: "只改了 PC 的默认网关。交换机上的 VRRP 配置一个字没动。" },
      { h: "为什么这一步是分水岭", p: "之前网关是 SW1 的实地址，SW1 一挂就断；现在网关是 VIP，Master 换人 PC 完全无感 —— 这就是 VRRP 对终端透明的兑现方式。" },
      { h: "ARP 表看什么", p: "切到「ARP 表」页：网关 IP 对应的 MAC 是 <b>0000-5e00-0101</b>（虚拟 MAC），不是 SW1 的 4c1f-cc10-0a01。" }
    ]
  },
  {
    id: 7, name: "抢占延时 · 别抢得太急",
    done: function(S){ return S.SW1.vrrp.delay === 20; },
    run: async function(api){
      api.setDev("SW1");
      await api.run([
        "system-view",
        "interface Vlanif 10",
        "vrrp vrid 1 preempt-mode timer delay 20",
        "quit",
        "display vrrp"
      ]);
    },
    summary: "preempt-mode timer delay 20：恢复后先等 20s，稳了再抢回",
    detail: [
      { h: "抢占默认就开着", p: "Preempt YES、Delay 0：优先级更高的 Backup 会立刻抢回 Master。平时没问题，故障恢复时最容易出事。" },
      { h: "为什么要延时", p: "设备刚重启 / 接口刚恢复，路由和上行还没收敛。这时抢回 Master，流量被吸过来却转发不出去，于是又切走，来回震荡。" },
      { h: "取值", p: "20s 是常见值，要覆盖「接口 up 到路由收敛」的时间。本实验只算稳态角色，延时影响的只是抢回的时刻，不改变最终谁是 Master。" }
    ]
  },
  {
    id: 8, name: "扰动 · SW1 的 Vlanif10 挂掉", key: true, keepTrace: true,
    done: function(S){ return !S.SW1.vlanif[10].up; },
    run: async function(api){
      api.setDev("SW1");
      await api.run([
        "system-view",
        "interface Vlanif 10",
        "shutdown",
        "quit",
        "display vrrp"
      ]);
      api.setDev("SW2");
      await api.run(["display vrrp"]);
      api.play(failoverScene(api.S));
    },
    summary: "SW1 退出选举，SW2 在 3s 内变 Master，PC 不用改任何配置",
    detail: [
      { h: "Vlanif down 意味着什么", p: "接口 down → 虚拟组进入 <b>Initialize</b>，不是「优先级降低」。SW1 立刻停止发通告，也不再持有 VIP。" },
      { h: "中断窗口", p: "Backup 连续 <b>3 × Advertisement Interval（3 × 1s = 3s）</b>收不到通告才接管，加上免费 ARP 与收敛，真实设备通常 3~5s。" },
      { h: "终端视角", p: "PC 的网关 MAC 一直是 0000-5e00-0101，ARP 缓存不用更新。整个切换对 PC 就是「丢了两三个包」。" },
      { h: "恢复之后", p: "SW1 的 Vlanif 恢复后会按优先级和抢占延时重新抢回 Master —— 这正是上一步那个 20s 延时想控制的事。" }
    ]
  },
  {
    id: 9, name: "上行联动 · track 治黑洞", key: true, keepTrace: true,
    done: function(S){ return S.SW1.vrrp.track.reduced > 0 && !S.SW1.up["GE0/0/2"]; },
    run: async function(api){
      api.setDev("SW1");
      await api.run([
        "system-view",
        "interface Vlanif 10",
        "undo shutdown",
        "quit",
        "display vrrp"
      ]);
      await api.run([
        "interface GigabitEthernet 0/0/2",
        "shutdown",
        "quit",
        "display vrrp"
      ]);
      api.play(blackholeScene(api.S));
      await api.run([
        "interface Vlanif 10",
        "vrrp vrid 1 track interface GigabitEthernet 0/0/2 reduced 30",
        "quit",
        "display vrrp"
      ]);
      api.play(flowScene(api.S, "PC1"));
    },
    summary: "上行断了但 Vlanif 还 up → 不配 track 就是黑洞；配了 track 才让 SW2 接管",
    detail: [
      { h: "反直觉的点", p: "上一步的倒换靠 Vlanif down 触发，太「干净」了。真实故障更多是<b>上行断了、设备还活着</b>：Vlanif up、ARP 能应答、PC 毫无察觉，但流量全丢。" },
      { h: "为什么会这样", p: "VRRP 默认只看 Vlanif 的状态，不看上行链路。SW1 仍是 Master（优先级 120），报文到它这里查出接口 GE0/0/2，链路 down，直接丢弃。" },
      { h: "track 做了什么", p: "track 把 GE0/0/2 的状态接进优先级：接口 down → PriorityRun = 120 − 30 = 90 < 100，SW2 立刻接管。减法要减够，减 10 就还是 110，等于没配。" },
      { h: "看哪个字段", p: "display vrrp 里 <b>PriorityConfig 120 / PriorityRun 90</b> 这一对，就是 track 正在起作用的直接证据。" }
    ]
  },
  {
    id: 10, name: "校验 · 三张表交叉核对",
    run: async function(api){
      api.setDev("SW1");
      await api.run(["display vrrp", "display vrrp statistics", "display arp"]);
      api.setDev("SW2");
      await api.run(["display vrrp brief", "display vrrp statistics"]);
      api.tab("vrrp");
    },
    summary: "对照 State / PriorityRun / 切换次数，确认主备关系与计时器",
    detail: [
      { h: "display vrrp", p: "单台详情：State、Master IP、PriorityConfig 与 PriorityRun（差值是 track）、Preempt Delay、Virtual MAC、Track interface。" },
      { h: "display vrrp brief", p: "一行摘要，适合两台对照：Grp-Pri 是配置值，Run-Pri 是生效值，两者不等就说明 track 在起作用。" },
      { h: "display vrrp statistics", p: "通告收发与 Transitions to Master。Master 的 sent 在涨、Backup 的 received 在涨 —— 一边倒才是正常。" },
      { h: "收尾判读", p: "先看谁 State=Master，再看它的上行是否真的有业务流量，最后看 PriorityRun 有没有被 track 拉低。三步都过，主备才算配对。" }
    ]
  }
];

/* ---------------- 导出 ---------------- */
export default {
  id: "10",
  title: "VRRP 主备切换",
  meta: "HUAWEI S5700 · VRP V200R005C00",
  stageLabel: "GATEWAY REDUNDANCY · 2 × S5700 + 1 × AR2220",
  totalSteps: steps.length,
  devices: ["SW1", "SW2"],
  tabs: [
    { key: "vrrp", label: "VRRP 状态", hint: "两台设备的虚拟组状态对照" },
    { key: "iface", label: "接口与 IP", hint: "Vlanif 与上行口的当前状态" },
    { key: "arp", label: "ARP 表", hint: "PC 侧看到的网关 MAC" },
    { key: "timer", label: "切换计时", hint: "通告间隔、Master Down 与切换记录" }
  ],
  legend: [
    { c: "#35E08A", label: "Master · 转发业务" },
    { c: "#FFB545", label: "Backup · 只收通告" },
    { c: "#FF4D5E", label: "Initialize / 接口 down" },
    { c: "#A78BFA", label: "PC 接入链路" },
    { c: "#38E1FF", label: "上行业务流" }
  ],
  phases: {
    enter: "进系统视图",
    vrrp: "起 VRRP",
    peer: "换设备",
    prio: "改优先级",
    gw: "改 PC 网关",
    preempt: "配抢占延时",
    track: "配上行 track",
    verify: "校验"
  },
  viewName: VIEW_NAME,
  viewHint: VIEW_HINT,
  actions: [
    { id: "pc-out", label: "PC1 → 8.8.8.8", run: function(l){ l.playScene(vrrpScene(l.S)); } },
    {
      id: "gw-vip", label: "PC 网关 → VIP",
      run: function(l){
        setGateway(l.S, VIP);
        l.write("--- 两台 PC 的默认网关已改为 " + VIP + "（VIP）---", "op");
        l.write("", "dim");
        l.playScene(vrrpScene(l.S));
      }
    },
    {
      id: "gw-real", label: "PC 网关 → .252",
      run: function(l){
        setGateway(l.S, "192.168.10.252");
        l.write("--- 两台 PC 的默认网关已改回 192.168.10.252（SW1 实地址）---", "op");
        l.write("", "dim");
        l.playScene(vrrpScene(l.S));
      }
    },
    {
      id: "kill1", label: "切断 SW1 上行",
      run: function(l){
        setUplink(l.S, "SW1", false);
        l.write("--- 已 shutdown SW1 GE0/0/2（上行）---", "op");
        l.write("", "dim");
        l.playScene(vrrpScene(l.S));
      }
    },
    {
      id: "restore1", label: "恢复 SW1 上行",
      run: function(l){
        setUplink(l.S, "SW1", true);
        l.write("--- 已 undo shutdown SW1 GE0/0/2 ---", "op");
        l.write("", "dim");
        l.playScene(vrrpScene(l.S));
      }
    }
  ],
  createState, prompt, commands, tables, topology, guide, steps,

  idle: {
    title: "判读顺序",
    items: [
      { h: "① 先看谁是 Master", p: "display vrrp 的 State 行，或 display vrrp brief 一行摘要。规则：生效优先级高者胜，相同则接口 IP 大者胜。" },
      { h: "② 再看优先级为什么是它", p: "PriorityConfig 是配置值，PriorityRun 是生效值。两者差一个 reduced，就说明 track 正在因为某个接口 down 而扣分。" },
      { h: "③ 最后看终端", p: "PC 的网关是 VIP 时，ARP 缓存里是虚拟 MAC 0000-5e00-0101；写成实地址时缓存的是物理 MAC —— 后者换设备就必须改 PC。" },
      { h: "④ 拓扑怎么读", p: "只有 Master 那台的上行有业务流量；Backup 的上行接近 0（心跳 0.06）。两台之间没有直连链路，VLAN 10 的二层域在图中省略 —— Backup 收到的、目的为虚拟 MAC 的帧会在二层域内转交给 Master。" },
      { h: "⑤ 简化声明", p: "角色按稳态计算，不跑逐秒计时器；切换窗口按 Advertisement 1s / Master Down 3s 标注，不模拟 skew time、认证、ARP 老化与抢占延时的等待过程。" }
    ]
  },

  viewRows(ctx){
    return [
      { h: "<" + ctx.dev + "> 用户视图", p: "只读：display vrrp / brief / statistics / arp。", cls: ctx.view === "user" ? "pass" : "" },
      { h: "[" + ctx.dev + "] 系统视图", p: "入口：interface Vlanif 10、interface GigabitEthernet 0/0/2。", cls: ctx.view === "system" ? "pass" : "" },
      { h: "[" + ctx.dev + "-Vlanif10] VLANIF 视图", p: "VRRP 全在这里配：virtual-ip、priority、preempt-mode、track、ip address。", cls: ctx.view === "if" && isVlanif(ctx.ifName) ? "pass" : "" },
      { h: "[" + ctx.dev + "-GE0/0/2] 接口视图", p: "shutdown / undo shutdown：模拟上行断开与恢复。", cls: ctx.view === "if" && !isVlanif(ctx.ifName) ? "pass" : "" }
    ];
  },

  boot(write, printGuide){
    write("Info: 已加载 SW1 / SW2 两台 S5700 与出口路由器 R1。", "dim");
    write("      SW1 Vlanif10 192.168.10.252/24，SW2 Vlanif10 192.168.10.253/24；两台各有一条 GE0/0/2 上行到 R1（10.0.0.1）。", "dim");
    write("      PC1 接 SW1 GE0/0/1，PC2 接 SW2 GE0/0/1，两台 PC 的网关暂时都指向 192.168.10.252。", "dim");
    write("      简化声明：切换计时按 Advertisement 1s / Master Down 3s 模拟，不模拟 skew time 与认证；VRRP 角色直接按稳态计算。", "dim");
    write("", "dim");
    printGuide();
  }
};
