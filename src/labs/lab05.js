import { pad, padL } from "../lib/util.js";

/* =========================================================================
   实验 05 · 静态路由
   -------------------------------------------------------------------------
   两台 AR2220 各挂一个网段，中间用 10.0.0.0/30 点对点互联。
   整个实验只围绕一件事：路由表怎么来、查表怎么命中、为什么必须双向配置。

     createState  → 接口地址与静态路由配置（响应式，命令直接改它）
     routesOf     → 路由表由状态派生：接口 up + IP → Direct / Local，
                    静态路由数组 → Static（下一跳递归解析出接口）
     commands     → ip address / undo shutdown / ip route-static / display / ping
     topology     → 端口颜色、互联链路流量全部由路由表推导
     steps        → 9 个板块，含「只配一半反而不通」的反直觉节点
   ========================================================================= */

/* ---------------- 拓扑常量 ---------------- */
const DEV = {
  R1: { x: 70, y: 62, w: 300, h: 74, portX: { "GE0/0/0": 110, "GE0/0/1": 250 } },
  R2: { x: 1040, y: 62, w: 300, h: 74, portX: { "GE0/0/0": 190, "GE0/0/1": 50 } }
};

const HOSTS = {
  PC1: {
    id: "PC1", router: "R1", port: "GE0/0/0", gwPort: "GE0/0/0",
    ip: "192.168.1.10", net: "192.168.1.0", mask: 24, gw: "192.168.1.1",
    mac: "5489-98a1-0001", x: 180, y: 200
  },
  PC2: {
    id: "PC2", router: "R2", port: "GE0/0/0", gwPort: "GE0/0/0",
    ip: "192.168.2.10", net: "192.168.2.0", mask: 24, gw: "192.168.2.1",
    mac: "5489-98a2-0002", x: 1230, y: 200
  }
};

const ROUTER_MAC = { R1: "00e0-fc12-3401", R2: "00e0-fc12-3402" };

/* 场景路径：与拓扑里的链路几何严格一致 */
const ROUTES = {
  "pc1-up": "M180 196 L180 136",
  "pc1-down": "M180 136 L180 196",
  "pc2-up": "M1230 196 L1230 136",
  "pc2-down": "M1230 136 L1230 196",
  "lk-r": "M370 106 L1040 106",
  "lk-l": "M1040 106 L370 106"
};

/* 本实验的规划值：引导与目标判定都以它为准 */
const PLAN = {
  R1: {
    ports: [
      { name: "GE0/0/0", ip: "192.168.1.1", mask: 24 },
      { name: "GE0/0/1", ip: "10.0.0.1", mask: 30 }
    ],
    statics: [{ dest: "192.168.2.0", mask: 24, nextHop: "10.0.0.2" }]
  },
  R2: {
    ports: [
      { name: "GE0/0/1", ip: "10.0.0.2", mask: 30 },
      { name: "GE0/0/0", ip: "192.168.2.1", mask: 24 }
    ],
    statics: [{ dest: "192.168.1.0", mask: 24, nextHop: "10.0.0.1" }]
  }
};

const PLAN_FWD = ["192.168.2.10", "192.168.2.200", "192.168.1.10", "10.0.0.2", "8.8.8.8"];

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

function sameSubnet(a, b, len){
  const va = ipToInt(a), vb = ipToInt(b);
  if(va === null || vb === null) return false;
  const m = maskInt(len);
  return ((va & m) >>> 0) === ((vb & m) >>> 0);
}

/* ---------------- 初始状态 ---------------- */
function makeRouter(name){
  return {
    name: name,
    ports: {
      "GE0/0/0": { ip: "", mask: 24, up: false },
      "GE0/0/1": { ip: "", mask: 30, up: false }
    },
    static: [],
    removedBack: false
  };
}

export function createState(){
  return { R1: makeRouter("R1"), R2: makeRouter("R2") };
}

/* ---------------- 路由表派生 ---------------- */
/* 下一跳落在哪个直连网段，就从哪个接口出去。VRP 的「递归查找」简化成这一步。 */
function ifaceFor(router, nh){
  const names = Object.keys(router.ports);
  for(let i = 0; i < names.length; i++){
    const p = router.ports[names[i]];
    if(p.up && p.ip && sameSubnet(nh, p.ip, p.mask)) return names[i];
  }
  return "";
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
  r.static.forEach(function(rt){
    const iface = ifaceFor(r, rt.nextHop);
    list.push({
      dest: rt.dest, mask: rt.mask, proto: "Static", pre: 60, cost: 0,
      nextHop: rt.nextHop, iface: iface || "—", active: !!iface
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

/* 最长前缀匹配：先比掩码长度，再比优先级 */
function lookup(S, dev, dst){
  const v = ipToInt(dst);
  if(v === null) return null;
  const list = routesOf(S, dev);
  let best = null;
  list.forEach(function(rt){
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

function directList(S, dev){
  return routesOf(S, dev).filter(function(rt){ return rt.proto === "Direct"; });
}
function directSummary(S, dev){
  const arr = directList(S, dev).map(function(rt){ return rt.dest + "/" + rt.mask; });
  return arr.length ? arr.join("、") : "没有直连路由";
}
function hasStatic(S, dev, dest, mask, nh){
  return S[dev].static.some(function(rt){
    return rt.dest === dest && rt.mask === mask && rt.nextHop === nh;
  });
}
function canForward(S){
  if(!S.R1.ports["GE0/0/1"].up || !S.R2.ports["GE0/0/1"].up) return false;
  if(!S.R1.ports["GE0/0/0"].up || !S.R2.ports["GE0/0/0"].up) return false;
  return !!lookup(S, "R1", "192.168.2.10") && !!lookup(S, "R2", "192.168.1.10");
}

/* ---------------- 视图 ---------------- */
const VIEW_NAME = { user: "用户视图", system: "系统视图", if: "接口视图" };
const VIEW_HINT = { system: "system-view", if: "interface GigabitEthernet 0/0/0" };

function shortIf(n){ return String(n).replace("GigabitEthernet", "GE"); }
function portKey(ctx){ return "GE" + String(ctx.ifName).replace("GigabitEthernet", ""); }

function prompt(ctx){
  if(ctx.view === "user") return "<" + ctx.dev + ">";
  if(ctx.view === "system") return "[" + ctx.dev + "]";
  return "[" + ctx.dev + "-" + shortIf(ctx.ifName) + "]";
}

/* ---------------- 命令表 ---------------- */
const P = "GigabitEthernet|GE|gigabitethernet";

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
      else if(c.view === "system"){ c.view = "user"; }
      else api.say("Error: Unrecognized command found at '^' position.", "err");
    }
  },
  {
    id: "return", match: /^(return|ctrl\+z)$/, view: null, kind: "view", usage: "return",
    run(api){ api.ctx.view = "user"; api.ctx.ifName = ""; }
  },
  {
    id: "interface", match: new RegExp("^interface (?:" + P + ")?\\s*([\\d/]+)$", "i"),
    view: "system", kind: "view", usage: "interface GigabitEthernet 0/0/0",
    run(api, m){
      const key = "GE" + m[1];
      if(!api.S[api.ctx.dev].ports[key]){
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
      { h: "改的是接口地址", p: "地址与掩码决定这个接口属于哪个网段。接口 up 时，设备会自动往路由表里塞两条直连表项。" },
      { h: "注意", p: "光配 IP 不够：接口还处于 shutdown 时，物理层不工作，这两条直连表项不会生效。" }
    ],
    run(api, m){
      const pn = portKey(api.ctx);
      const p = api.S[api.ctx.dev].ports[pn];
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
      api.change(pn + ".ip", old, ip + "/" + len, { row: "port-" + pn });
      if(p.up){
        const d = netOf(ip, len);
        api.change("直连路由 " + d + "/" + len, "不存在", "Direct", { row: "rt-Direct-" + d + "-" + len, kind: "enter" });
        api.say("// " + pn + " 地址就绪，路由表自动生成 " + d + "/" + len + "（Direct）与 " + ip + "/32（Local）。", "op");
      }else{
        api.say("// " + pn + " 地址已写入配置，但接口仍处于 shutdown，直连路由暂不生效。", "op");
      }
      api.fx({ kind: "pulse", target: api.ctx.dev + "/" + pn, color: "#38E1FF" });
    }
  },
  {
    id: "undo-shutdown", match: /^undo shutdown$/, view: "if", kind: "config",
    usage: "undo shutdown",
    explain: [
      { h: "启用接口", p: "shutdown 是管理性关闭：线插着、灯不亮、协议不 up。undo shutdown 后物理层与协议层才起来。" },
      { h: "连带结果", p: "接口一旦 up，已配的 IP 立刻生成 Direct / Local 两条路由。这就是「路由表从接口派生」的入口。" }
    ],
    run(api){
      const pn = portKey(api.ctx);
      const p = api.S[api.ctx.dev].ports[pn];
      if(!p){ api.say("Error: The port does not exist.", "err"); return; }
      if(p.up){
        api.say("// " + pn + " 已经是 up，命令未产生状态变化。", "op");
        return;
      }
      p.up = true;
      api.change(pn + ".state", "shutdown", "up", { row: "port-" + pn });
      if(p.ip){
        const d = netOf(p.ip, p.mask);
        api.change("直连路由 " + d + "/" + p.mask, "不存在", "Direct", { row: "rt-Direct-" + d + "-" + p.mask, kind: "enter" });
        api.say("// " + pn + " 物理层与协议层 up；" + d + "/" + p.mask + " 以 Direct 进入路由表。", "op");
      }else{
        api.say("// " + pn + " 已 up，但还没有 IP 地址，路由表仍不会有这个网段。", "op");
      }
      api.fx({ kind: "pulse", target: api.ctx.dev + "/" + pn, color: "#35E08A" });
    }
  },
  {
    id: "ip-route-static", match: /^ip route-static ([\d.]+) (\d+|[0-9.]+) ([\d.]+)$/,
    view: "system", kind: "config",
    usage: "ip route-static <192.168.2.0> <24> <10.0.0.2>",
    explain: [
      { h: "写一条静态路由", p: "三个要素：目的网段、掩码、下一跳。出接口由下一跳递归解析得到，不需要手写。" },
      { h: "语法校验", p: "下一跳必须落在某个直连网段里。解析不到出接口时，这条路由不会进入转发表。" }
    ],
    run(api, m){
      const dev = api.ctx.dev, r = api.S[dev];
      const ipOk = ipToInt(m[1]), nhOk = ipToInt(m[3]);
      const len = maskToLen(m[2]);
      if(ipOk === null || nhOk === null || len < 0){
        api.say("Error: Wrong parameter found at '^' position.", "err");
        return;
      }
      const dest = netOf(m[1], len);
      const nextHop = m[3];
      const same = r.static.find(function(x){ return x.dest === dest && x.mask === len; });
      if(same && same.nextHop === nextHop){
        api.say("// 目的 " + dest + "/" + len + "、下一跳 " + nextHop + " 的静态路由已存在，命令未产生状态变化。", "op");
        return;
      }
      let oldNh = "不存在";
      if(same){
        oldNh = same.nextHop;
        same.nextHop = nextHop;
      }else{
        r.static.push({ dest: dest, mask: len, nextHop: nextHop });
      }
      if(dev === "R2" && dest === "192.168.1.0" && len === 24 && nextHop === "10.0.0.1") r.removedBack = false;
      api.change("静态路由 " + dest + "/" + len, oldNh, nextHop, {
        row: "rt-Static-" + dest + "-" + len, kind: "enter"
      });
      api.tab("route");
      const iface = ifaceFor(r, nextHop);
      if(iface){
        api.say("// " + dest + "/" + len + " → 下一跳 " + nextHop + "，递归出接口 " + iface +
          "；路由表新增 Static（Pre 60）。", "op");
      }else{
        api.say("// 警告：下一跳 " + nextHop + " 不落在任何直连网段，无法递归出接口。", "op");
        api.say("// 这条路由会留在配置里，但不会进入路由表，也不会被查表命中。", "op");
      }
      api.fx({ kind: "pulse", target: dev + "/GE0/0/1", color: "#38E1FF" });
    }
  },
  {
    id: "undo-ip-route-static", match: /^undo ip route-static ([\d.]+) (\d+|[0-9.]+) ([\d.]+)$/,
    view: "system", kind: "config",
    usage: "undo ip route-static <192.168.1.0> <24> <10.0.0.1>",
    explain: [
      { h: "删一条静态路由", p: "目的网段、掩码、下一跳三者都要对上才会删除。只写目的网段不会动到别的下一跳。" },
      { h: "现象", p: "删掉回程路由后，去程表项一点没变——但 ping 立刻断在回程查表这一步。" }
    ],
    run(api, m){
      const dev = api.ctx.dev, r = api.S[dev];
      const len = maskToLen(m[2]);
      if(ipToInt(m[1]) === null || ipToInt(m[3]) === null || len < 0){
        api.say("Error: Wrong parameter found at '^' position.", "err");
        return;
      }
      const dest = netOf(m[1], len);
      const idx = r.static.findIndex(function(x){
        return x.dest === dest && x.mask === len && x.nextHop === m[3];
      });
      if(idx < 0){
        api.say("// 配置里没有 " + dest + "/" + len + " 经 " + m[3] + " 的静态路由，命令未产生状态变化。", "op");
        return;
      }
      r.static.splice(idx, 1);
      if(dev === "R2" && dest === "192.168.1.0" && len === 24 && m[3] === "10.0.0.1") r.removedBack = true;
      api.change("静态路由 " + dest + "/" + len, m[3], "已删除");
      api.tab("route");
      api.say("// " + dest + "/" + len + " 经 " + m[3] + " 的 Static 表项已移除，该前缀回到「无路由」状态。", "op");
    }
  },

  /* ---- 只读命令 ---- */
  {
    id: "display-ip-brief", match: /^display ip interface brief$/, view: null, kind: "doc",
    usage: "display ip interface brief",
    doc: "按接口看三层状态：<b>Physical</b> 是链路，<b>Protocol</b> 要 IP 配好且接口 up 才是 up。Protocol down 的接口不会向路由表贡献直连表项。",
    run(api){
      const r = api.S[api.ctx.dev];
      api.say(pad("Interface", 34) + pad("IP Address/Mask", 21) + pad("Physical", 11) + "Protocol", "dim");
      api.say("--------------------------------------------------------------------------------", "dim");
      Object.keys(r.ports).forEach(function(pn){
        const p = r.ports[pn];
        api.say(pad("GigabitEthernet" + pn.slice(2), 34) +
          pad(p.ip ? p.ip + "/" + p.mask : "unassigned", 21) +
          pad(p.up ? "up" : "*down", 11) +
          (p.up && p.ip ? "up" : "down"));
      });
      api.tab("port");
    }
  },
  {
    id: "display-route", match: /^display ip routing-table$/, view: null, kind: "doc",
    usage: "display ip routing-table",
    doc: "这张表回答：<b>去某个目的网段，下一跳是谁、从哪个接口出去</b>。Direct / Local 由接口地址自动生成，Static 是手工写的。",
    run(api){
      const S = api.S, dev = api.ctx.dev;
      const list = routesOf(S, dev).filter(function(rt){ return rt.proto !== "Static" || rt.active; });
      const dead = S[dev].static.filter(function(rt){ return !ifaceFor(S[dev], rt.nextHop); });
      api.lines(["Route Flags: R - relay, D - download to fib",
        "------------------------------------------------------------------------------",
        "Routing Tables: Public",
        "         Destinations : " + list.length + "        Routes : " + list.length,
        ""], "dim");
      api.say(pad("Destination/Mask", 19) + pad("Proto", 8) + padL("Pre", 5) + padL("Cost", 6) +
        pad("Flags", 7) + pad("NextHop", 16) + "Interface", "dim");
      api.say("------------------------------------------------------------------------------", "dim");
      if(!list.length){
        api.say("// 路由表为空：没有任何接口地址，也没有静态路由。", "op");
      }
      list.forEach(function(rt){
        const flags = rt.proto === "Static" ? "RD" : "D";
        api.say(padL(rt.dest + "/" + rt.mask, 19) + pad(rt.proto, 8) +
          padL(rt.pre, 5) + padL(rt.cost, 6) + pad(flags, 7) +
          pad(rt.nextHop, 16) + "GigabitEthernet" + rt.iface.slice(2));
      });
      if(dead.length){
        api.say("", "dim");
        api.say("// 另有 " + dead.length + " 条静态路由因下一跳不可达，没有进入这张表。", "op");
      }
      api.tab("route");
    }
  },
  {
    id: "display-arp", match: /^display arp$/, view: null, kind: "doc",
    usage: "display arp",
    doc: "ARP 表回答：某个 IP 对应的 MAC 是谁。<b>三层转发必须先解析出下一跳的 MAC</b>，否则包出不去。",
    run(api){
      const S = api.S, dev = api.ctx.dev;
      const rows = arpRows(S, dev);
      api.say(pad("IP ADDRESS", 16) + pad("MAC ADDRESS", 17) + pad("EXPIRE(M)", 11) +
        pad("TYPE", 12) + "INTERFACE", "dim");
      api.say("-------------------------------------------------------------------------------", "dim");
      if(!rows.length){
        api.say("// ARP 表为空：接口没有地址或还没有邻居。", "op");
      }
      rows.forEach(function(e){
        api.say(pad(e.ip, 16) + pad(e.mac, 17) + pad("20", 11) + pad("D-0", 12) + e.iface);
      });
      api.tab("arp");
    }
  },
  {
    id: "display-conf", match: /^display current-configuration$/, view: null, kind: "doc",
    usage: "display current-configuration",
    doc: "设备上真正生效的配置。和 display ip routing-table 对照，可以看出哪些路由是接口派生的、哪些是手工写进去的。",
    run(api){
      const r = api.S[api.ctx.dev];
      api.say("#", "dim");
      api.say(" sysname " + r.name);
      api.say("#", "dim");
      Object.keys(r.ports).forEach(function(pn){
        const p = r.ports[pn];
        api.say("interface GigabitEthernet" + pn.slice(2));
        if(p.ip) api.say(" ip address " + p.ip + " " + lenToMask(p.mask));
        if(!p.up) api.say(" shutdown");
        api.say("#", "dim");
      });
      r.static.forEach(function(rt){
        api.say("ip route-static " + rt.dest + " " + lenToMask(rt.mask) + " " + rt.nextHop);
      });
      if(r.static.length) api.say("#", "dim");
      api.say("return");
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
      const rt = lookup(api.S, dev, dst);
      if(!rt){
        pingOut(api, dst, false);
        api.say("// " + dev + " 的路由表里没有能匹配 " + dst + " 的表项，ICMP 在查表这一步就被丢弃。", "op");
        api.tab("route");
        return;
      }
      const reach = endpointUp(api.S, dst);
      if(reach === false){
        pingOut(api, dst, false);
        api.say("// 路由命中 " + rt.dest + "/" + rt.mask + "，但目的接口处于 down / shutdown，报文发到对端后无人接收。", "op");
        return;
      }
      if(reach === null){
        pingOut(api, dst, false);
        api.say("// 路由命中 " + rt.dest + "/" + rt.mask + "，报文从 " + rt.iface + " 发出；但该地址没有主机应答 ARP，收不到 ICMP Reply。", "op");
        return;
      }
      const ttl = rt.proto === "Local" ? 255 : 254;
      pingOut(api, dst, true, ttl);
      if(rt.proto === "Local"){
        api.say("// 目的地址就是 " + dev + " 自己的接口地址，ICMP 由本机直接应答，不经过转发。", "op");
      }else{
        api.say("// 命中 " + rt.proto + " 路由 " + rt.dest + "/" + rt.mask + "，下一跳 " + rt.nextHop +
          "，出接口 " + rt.iface + "。", "op");
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

/* 目的端是否活着：主机看所属接口，路由器地址看该接口，其它地址视为未知 */
function endpointUp(S, ip){
  const keys = Object.keys(HOSTS);
  for(let i = 0; i < keys.length; i++){
    const h = HOSTS[keys[i]];
    if(h.ip === ip) return S[h.router].ports[h.port].up;
  }
  const devs = Object.keys(S);
  for(let i = 0; i < devs.length; i++){
    const d = devs[i];
    const names = Object.keys(S[d].ports);
    for(let k = 0; k < names.length; k++){
      if(S[d].ports[names[k]].ip === ip) return S[d].ports[names[k]].up;
    }
  }
  return null;
}

/* ---------------- ARP 表派生 ---------------- */
function arpRows(S, dev){
  const r = S[dev];
  const peer = dev === "R1" ? "R2" : "R1";
  const rows = [];
  const lan = r.ports["GE0/0/0"];
  const link = r.ports["GE0/0/1"];
  if(lan.up && lan.ip){
    const h = dev === "R1" ? HOSTS.PC1 : HOSTS.PC2;
    rows.push({ ip: h.ip, mac: h.mac, iface: "GE0/0/0" });
  }
  if(link.up && link.ip && S[peer].ports["GE0/0/1"].up){
    rows.push({ ip: S[peer].ports["GE0/0/1"].ip, mac: ROUTER_MAC[peer], iface: "GE0/0/1" });
  }
  return rows;
}

/* ---------------- 表项 ---------------- */
function tables(S, tab, ctx){
  const dev = ctx.dev, r = S[dev];

  if(tab === "port"){
    return {
      head: ["接口", "IP 地址", "掩码", "物理", "协议", "判读"],
      rows: Object.keys(r.ports).map(function(pn){
        const p = r.ports[pn];
        let note;
        if(!p.up) note = "shutdown：物理层不工作，IP 也不生效";
        else if(!p.ip) note = "未配 IP：不产生直连路由";
        else note = "直连 " + netOf(p.ip, p.mask) + "/" + p.mask + " 已进路由表";
        return {
          key: "port-" + pn,
          cells: [
            { t: pn, cls: "c" },
            { t: p.ip || "unassigned", cls: p.ip ? "c" : "dim" },
            { t: p.ip ? lenToMask(p.mask) : "—", cls: "c" },
            { t: p.up ? "up" : "*down", cls: p.up ? "ok" : "bad" },
            { t: p.up && p.ip ? "up" : "down", cls: p.up && p.ip ? "ok" : "bad" },
            { t: note, cls: "c" }
          ]
        };
      }),
      note: "接口是路由表的源头：up + IP 两条都满足，才会派生 Direct 与 Local。"
    };
  }

  if(tab === "route"){
    const list = routesOf(S, dev).filter(function(rt){ return rt.proto !== "Static" || rt.active; });
    return {
      head: ["目的地址", "掩码", "协议", "优先级", "开销", "下一跳", "出接口"],
      rows: list.map(function(rt){
        return {
          key: routeKey(rt),
          cells: [
            { t: rt.dest, cls: "c" },
            { t: lenToMask(rt.mask), cls: "c" },
            { t: rt.proto, cls: rt.proto === "Static" ? "v10" : rt.proto === "Local" ? "dim" : "ok" },
            { t: rt.pre, cls: "c" },
            { t: rt.cost, cls: "c" },
            { t: rt.nextHop, cls: "c" },
            { t: rt.iface, cls: "c" }
          ]
        };
      }),
      empty: "路由表为空 · 接口配上 IP 并 undo shutdown 后才会有直连路由",
      note: "全部由状态派生：每个 up 且配了 IP 的接口 → Direct（网段）+ Local（本机 /32）；每条静态路由 → Static（Pre 60）。部分 VRP 版本把本机 /32 也显示为 Direct，这里标成 Local 便于区分。"
    };
  }

  if(tab === "arp"){
    const rows = arpRows(S, dev);
    return {
      head: ["IP 地址", "MAC 地址", "类型", "出接口", "说明"],
      rows: rows.map(function(e){
        return {
          key: "arp-" + e.ip,
          cells: [
            { t: e.ip, cls: "c" },
            { t: e.mac, cls: "c" },
            { t: "dynamic", cls: "ok" },
            { t: e.iface, cls: "c" },
            { t: "三层转发前必须先解析到下一跳 MAC", cls: "c" }
          ]
        };
      }),
      empty: "ARP 表为空 · 接口配了 IP 且 up 之后才会有邻居",
      note: "简化：ARP 表按拓扑稳态直接给出，不模拟 ARP 请求时序与老化计时。"
    };
  }

  /* 转发判读 */
  return {
    head: ["目的地址", "命中前缀", "协议", "下一跳", "出接口", "判读"],
    rows: PLAN_FWD.map(function(ip){
      const hit = lookup(S, dev, ip);
      let why, cls;
      if(!hit){
        why = "无匹配 → 查表失败，报文丢弃";
        cls = "bad";
      }else if(hit.proto === "Local"){
        why = "本机地址，直接上送 CPU";
        cls = "ok";
      }else if(hit.proto === "Direct"){
        why = "直连网段，ARP 解析后直接二层封装";
        cls = "ok";
      }else{
        why = "命中静态路由，递归出接口 " + hit.iface;
        cls = "v10";
      }
      return {
        key: "fwd-" + ip,
        cells: [
          { t: ip, cls: "c" },
          { t: hit ? hit.dest + "/" + hit.mask : "—", cls: "c" },
          { t: hit ? hit.proto : "—", cls: "c" },
          { t: hit ? hit.nextHop : "—", cls: "c" },
          { t: hit ? hit.iface : "—", cls: "c" },
          { t: why, cls: cls }
        ]
      };
    }),
    note: "最长前缀匹配：掩码更长的表项优先，与配置先后无关。本实验不涉及多协议、等价路由与默认路由。"
  };
}

/* ---------------- 拓扑 ---------------- */
function portColor(p){
  if(!p.up) return "#7E93AB";
  return p.ip ? "#38E1FF" : "#FFB545";
}

function addrTag(S, dev){
  const a = S[dev].ports["GE0/0/0"];
  const b = S[dev].ports["GE0/0/1"];
  const f = function(p){ return p.ip ? p.ip + "/" + p.mask : "未配"; };
  return f(a) + " · " + f(b);
}

function topology(S, ui, ctx){
  const devices = ["R1", "R2"].map(function(id){
    const d = DEV[id], r = S[id];
    const ports = Object.keys(d.portX).map(function(pn){
      const p = r.ports[pn];
      return {
        name: pn, kind: "rj45",
        x: d.portX[pn], y: 44,
        color: portColor(p), up: p.up, label: pn.slice(2),
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
        { x: 34, y: -8, text: addrTag(S, id), cls: "dev-sub" }
      ]
    };
  });

  const hosts = Object.keys(HOSTS).map(function(k){
    const h = HOSTS[k];
    const up = S[h.router].ports[h.port].up;
    return {
      id: h.id, x: h.x, y: h.y, ip: h.ip, mac: h.mac,
      vlan: 1, color: up ? "#38E1FF" : "#7E93AB", up: up
    };
  });

  const r1Host = S.R1.ports["GE0/0/0"].up;
  const r2Host = S.R2.ports["GE0/0/0"].up;
  const interUp = S.R1.ports["GE0/0/1"].up && S.R2.ports["GE0/0/1"].up;
  const fwd = canForward(S);

  const links = [
    { id: "lk-pc1", d: ROUTES["pc1-down"], cls: r1Host ? "" : "down", flow: r1Host ? 0.42 : 0, flowColor: "56,225,255" },
    { id: "lk-pc2", d: ROUTES["pc2-down"], cls: r2Host ? "" : "down", flow: r2Host ? 0.42 : 0, flowColor: "56,225,255" },
    {
      id: "lk-r12", d: ROUTES["lk-r"],
      cls: !interUp ? "down" : (fwd ? "active" : ""),
      flow: fwd ? 1 : 0,
      flowColor: "56,225,255"
    }
  ];

  const anchors = {};
  Object.keys(DEV).forEach(function(id){
    const d = DEV[id];
    Object.keys(d.portX).forEach(function(pn){
      anchors[id + "/" + pn] = [d.x + d.portX[pn], d.y + 44];
    });
  });

  const labels = [
    {
      text: "10.0.0.0/30", x: 705, y: 96, anchor: "middle",
      cls: "lk-tag" + (fwd ? " on" : "")
    },
    {
      text: "192.168.1.0/24", x: 196, y: 170, anchor: "start",
      cls: "lk-tag" + (r1Host ? " on" : " bad")
    },
    {
      text: "192.168.2.0/24", x: 1246, y: 170, anchor: "start",
      cls: "lk-tag" + (r2Host ? " on" : " bad")
    }
  ];

  return { viewBox: "0 0 1400 300", devices, hosts, links, routes: ROUTES, anchors, labels };
}

/* ---------------- 数据面场景 ---------------- */
function hostRoute(h, dir){ return h.id.toLowerCase() + (dir === "up" ? "-up" : "-down"); }

export function pingScene(S, fromId, toId){
  const A = HOSTS[fromId || "PC1"];
  const B = HOSTS[toId || "PC2"];
  const ga = S[A.router].ports[A.gwPort];
  const frames = [], trace = [];
  const scene = {
    name: "PC " + A.ip + " → " + B.ip,
    realSec: 4.4,
    frames: frames,
    trace: trace,
    traceTitle: "逐跳判读",
    drop: null,
    verdict: null
  };

  trace.push({
    h: "① 源主机判路",
    p: "<b>" + A.ip + "/24</b> 与 <b>" + B.ip + "/24</b> 不在同一网段，目的 MAC 填默认网关 <code>" + A.gw + "</code>，不是 PC2 的 MAC。",
    cls: ""
  });

  if(!ga.ip || !ga.up){
    trace.push({
      h: "② 网关不可用",
      p: A.router + " 的 " + A.gwPort + (ga.ip ? " 处于 shutdown" : " 还没有 IP 地址") +
        "，主机的 ARP 请求没人应答，ICMP 在源主机就发不出去。",
      cls: "drop"
    });
    scene.drop = { x: A.x, y: 168, at: .25, label: "NO GATEWAY" };
    scene.verdict = { bad: true, text: "接口没配 IP 或没 undo shutdown，主机连网关都解析不到，报文根本没有进入路由器。" };
    return scene;
  }

  frames.push({ route: hostRoute(A, "up"), t0: 0, t1: .10, kind: "data" });
  trace.push({
    h: "② 源主机 → 网关",
    p: "帧从 PC 进入 " + A.router + " 的 " + A.port + "；路由器拆掉二层头，拿目的 IP <b>" + B.ip + "</b> 去查路由表。",
    cls: ""
  });

  const fwd = lookup(S, A.router, B.ip);
  if(!fwd){
    trace.push({
      h: "③ " + A.router + " 查表 · 无匹配",
      p: "路由表里只有 " + directSummary(S, A.router) + "，没有 <b>" + B.net + "/24</b>。" +
        "最长前缀也救不了——根本没有能覆盖该目的地址的表项，报文在 " + A.router + " 被丢弃。",
      cls: "drop"
    });
    scene.drop = { x: A.router === "R1" ? 382 : 1028, y: 106, at: .34, label: "NO ROUTE · " + B.net + "/24" };
    scene.verdict = {
      bad: true,
      text: "去程路由缺失：报文到了网关就查不到出口。静态路由是单向的，每台路由器都要各自指路。"
    };
    return scene;
  }

  trace.push({
    h: "③ " + A.router + " 查表 · 命中",
    p: "最长前缀命中 <b>" + fwd.dest + "/" + fwd.mask + "</b>（" + fwd.proto + "，Pre " + fwd.pre +
      "），下一跳 <b>" + fwd.nextHop + "</b>，出接口 <b>" + fwd.iface + "</b>。",
    cls: ""
  });

  const fwdLink = A.router === "R1" ? "lk-r" : "lk-l";
  const backLink = A.router === "R1" ? "lk-l" : "lk-r";
  frames.push({ route: fwdLink, t0: .14, t1: .44, kind: "data" });
  trace.push({
    h: "④ 互联链路",
    p: "按下一跳 " + fwd.nextHop + " 重新封装二层头，从 " + fwd.iface + " 发到 10.0.0.0/30 点对点链路的另一端。",
    cls: ""
  });

  const dstLook = lookup(S, B.router, B.ip);
  frames.push({ route: hostRoute(B, "down"), t0: .46, t1: .56, kind: "data" });
  trace.push({
    h: "⑤ " + B.router + " 查表 → 主机",
    p: "目的 " + B.ip + " 命中 " + (dstLook ? "<b>" + dstLook.dest + "/" + dstLook.mask + "</b>（" + dstLook.proto + "）" : "直连网段") +
      "，出接口 " + B.port + "，ARP 解析到 PC2 的 MAC 后送到主机。",
    cls: ""
  });
  trace.push({
    h: "⑥ PC2 收到请求",
    p: "ICMP Echo Request 到达。主机要回一个 Echo Reply，源 " + B.ip + "、目的 " + A.ip + "，再次交给网关 " + B.gw + "。",
    cls: ""
  });

  frames.push({ route: hostRoute(B, "up"), t0: .60, t1: .66, kind: "data" });
  const back = lookup(S, B.router, A.ip);
  if(!back){
    trace.push({
      h: "⑦ " + B.router + " 查回程表 · 无匹配",
      p: B.router + " 的路由表里只有 " + directSummary(S, B.router) + "，没有 <b>" + A.net + "/24</b>。" +
        "请求能到 PC2，但回应在这里被丢掉——PC1 那边只会看到 Request time out。",
      cls: "drop"
    });
    scene.drop = { x: B.router === "R2" ? 1028 : 382, y: 106, at: .70, label: "NO RETURN ROUTE · " + A.net + "/24" };
    scene.verdict = {
      bad: true,
      text: "去程通了，回程没有：PC1 的请求到了 PC2，但 PC2 的回应在 R2 回不来。静态路由必须两端都指。"
    };
    return scene;
  }

  trace.push({
    h: "⑦ " + B.router + " 查回程表 · 命中",
    p: "命中 <b>" + back.dest + "/" + back.mask + "</b>（" + back.proto + "，Pre " + back.pre +
      "），下一跳 <b>" + back.nextHop + "</b>，出接口 <b>" + back.iface + "</b>。",
    cls: ""
  });

  frames.push({ route: backLink, t0: .70, t1: .92, kind: "data" });
  frames.push({ route: hostRoute(A, "down"), t0: .93, t1: 1, kind: "data" });
  trace.push({
    h: "⑧ 回到源主机",
    p: "回应沿原路返回 " + A.router + "，再由直连网段 <b>" + A.net + "/24</b> 送到 PC1。一次完整往返成立。",
    cls: "pass"
  });

  scene.verdict = {
    bad: false,
    text: "两端各有一条指向对端网段的静态路由，去程与回程都成立。缺任何一条，ping 都不通。"
  };
  return scene;
}

/* ---------------- 引导 ---------------- */
function missingPort(S, dev){
  const list = PLAN[dev].ports;
  for(let i = 0; i < list.length; i++){
    const want = list[i];
    const p = S[dev].ports[want.name];
    if(p.ip !== want.ip || p.mask !== want.mask || !p.up) return { want: want, now: p };
  }
  return null;
}

function devTodo(S, dev){
  let n = 0;
  PLAN[dev].ports.forEach(function(w){
    const p = S[dev].ports[w.name];
    if(p.ip !== w.ip || p.mask !== w.mask || !p.up) n++;
  });
  PLAN[dev].statics.forEach(function(st){
    if(!hasStatic(S, dev, st.dest, st.mask, st.nextHop)) n++;
  });
  return n;
}

function peerReady(S, dev){
  if(missingPort(S, dev)) return false;
  return PLAN[dev].statics.every(function(st){
    return hasStatic(S, dev, st.dest, st.mask, st.nextHop);
  });
}

function guide(S, ctx){
  const dev = ctx.dev;
  const peer = dev === "R1" ? "R2" : "R1";
  const G = function(phase, why, cmd){ return { phase: phase, why: why, cmd: cmd || "" }; };

  if(ctx.view === "if"){
    const pn = portKey(ctx);
    const p = S[dev].ports[pn];
    const want = PLAN[dev].ports.find(function(x){ return x.name === pn; });
    if(!p) return G("enter", "端口不存在，quit 退回系统视图。", "quit");
    if(!want) return G("enter", pn + " 不在本实验的规划里，quit 退出去配 0/0/0 或 0/0/1。", "quit");
    if(p.ip !== want.ip || p.mask !== want.mask){
      const now = p.ip ? p.ip + "/" + p.mask : "unassigned";
      return G("ip", pn + " 现在是 " + now + "，按规划应为 " + want.ip + "/" + want.mask + "。", "ip address " + want.ip + " " + want.mask);
    }
    if(!p.up) return G("shutdown", pn + " 已配 " + p.ip + "/" + p.mask + "，但接口还是 shutdown，物理层不 up，这条直连进不了路由表。", "undo shutdown");
    return G("ip", pn + " 已就绪（" + p.ip + "/" + p.mask + "）。quit 退出，换下一个接口。", "quit");
  }

  if(ctx.view === "system"){
    const miss = missingPort(S, dev);
    if(miss){
      const w = miss.want, now = miss.now;
      let why;
      if(!now.ip) why = "接口表里 " + w.name + " 还是 unassigned，没有 IP 就不会生成直连路由。";
      else if(now.ip !== w.ip || now.mask !== w.mask) why = w.name + " 现在是 " + now.ip + "/" + now.mask + "，按规划应为 " + w.ip + "/" + w.mask + "。";
      else why = w.name + " 已配 " + now.ip + "/" + now.mask + "，但仍然是 shutdown，直连路由没有生效。";
      return G("ip", why, "interface GigabitEthernet " + w.name.slice(2));
    }
    /* 对端接口也要先起来：下一跳所在的链路两端都 up，静态路由才不是黑洞 */
    const pm = missingPort(S, peer);
    if(pm){
      const now = pm.now;
      return G("peer", peer + " 的 " + pm.want.name + " 还没按规划配好（" +
        (now.ip ? now.ip + "/" + now.mask : "unassigned") + "）。先切过去把接口起来，否则本端的静态路由会把包送进黑洞。", "");
    }
    /* 演示顺序：先 R1 去程，再 R2 回程，中间才看得到「只配一半」 */
    if(dev === "R2" && !hasStatic(S, "R1", "192.168.2.0", 24, "10.0.0.2")){
      return G("peer", "两边接口都起来了。先切到 R1 配去程 192.168.2.0/24 —— 这样下一步才能看到「只配一半，ping 仍然不通」。", "");
    }
    const st = PLAN[dev].statics.find(function(x){
      return !hasStatic(S, dev, x.dest, x.mask, x.nextHop);
    });
    if(st){
      let why;
      if(dev === "R1"){
        why = "R1 的路由表里只有 " + directSummary(S, "R1") + "，没有 192.168.2.0/24。PC1 的包到 R1 查表就没有出口。";
      }else{
        why = "R2 上还没有回 192.168.1.0/24 的路由，PC1 的请求到了也回不来。";
      }
      return G("route", why, "ip route-static " + st.dest + " " + st.mask + " " + st.nextHop);
    }
    if(!peerReady(S, peer)){
      let why;
      if(dev === "R1") why = "R1 的去程已配好。但静态路由是单向的，R2 还不知道 192.168.1.0/24 怎么回，PC1 的 ping 仍然断在回程。切到 R2 补上。";
      else why = "R2 的回程已配好。R1 还没有 192.168.2.0/24 的去程路由，PC2 的回应到了 R1 也送不回去。切到 R1 补上。";
      return G("peer", why, "");
    }
    return G("verify", "两端路由都齐了。display ip routing-table 对照 Direct 与 Static 两种表项。", "display ip routing-table");
  }

  if(devTodo(S, dev) > 0){
    return G("enter", "<" + dev + "> 是用户视图，只能看不能改。接口 IP 与静态路由都要先 system-view。", "system-view");
  }
  if(devTodo(S, peer) > 0){
    return G("peer", dev + " 已配完。切到 " + peer + " —— 静态路由是单向的，对端不指回来，ping 还是不通。", "");
  }
  return G("verify", "两端都配完了。display ip routing-table 对照两边的表，再跑一次 PC1 → PC2。", "display ip routing-table");
}

/* ---------------- 板块 ---------------- */
const steps = [
  {
    id: 1, name: "基线 · 只有物理连接", keepTrace: true,
    run: async function(api){
      api.setDev("R1");
      await api.run(["display ip interface brief", "display ip routing-table"]);
      api.play(pingScene(api.S, "PC1", "PC2"));
    },
    summary: "接口未配 IP、路由表为空，PC1 ping PC2 直接不可达",
    detail: [
      { h: "看到什么", p: "三根线都插着，但 GE0/0/0 与 GE0/0/1 全是 <b>*down</b>（shutdown），IP 为 unassigned，路由表 0 条。" },
      { h: "为什么 ping 不通", p: "PC1 的默认网关 192.168.1.1 没有配置，ARP 请求无人应答；就算配了 IP，R1 也没有去 192.168.2.0/24 的路由。" }
    ]
  },
  {
    id: 2, name: "R1 · 配两个接口地址",
    done: function(S){
      return PLAN.R1.ports.every(function(w){
        const p = S.R1.ports[w.name];
        return p.ip === w.ip && p.mask === w.mask && p.up;
      });
    },
    run: async function(api){
      api.setDev("R1");
      await api.run([
        "system-view",
        "interface GigabitEthernet 0/0/0",
        "ip address 192.168.1.1 24",
        "undo shutdown",
        "quit",
        "interface GigabitEthernet 0/0/1",
        "ip address 10.0.0.1 30",
        "undo shutdown",
        "quit",
        "display ip routing-table"
      ]);
    },
    summary: "R1 的 GE0/0/0 = 192.168.1.1/24，GE0/0/1 = 10.0.0.1/30，两条直连路由自动出现",
    detail: [
      { h: "表项变化", p: "每配一个接口，路由表多两条：<b>Direct</b>（网段，如 192.168.1.0/24）与 <b>Local</b>（本机 /32，如 192.168.1.1/32）。" },
      { h: "为什么是 /30", p: "点对点链路只需要两个地址。10.0.0.0/30 可用地址是 .1 与 .2，正好一边一个，不浪费地址。" }
    ]
  },
  {
    id: 3, name: "R2 · 配两个接口地址",
    done: function(S){
      return PLAN.R2.ports.every(function(w){
        const p = S.R2.ports[w.name];
        return p.ip === w.ip && p.mask === w.mask && p.up;
      });
    },
    run: async function(api){
      api.setDev("R2");
      await api.run([
        "system-view",
        "interface GigabitEthernet 0/0/1",
        "ip address 10.0.0.2 30",
        "undo shutdown",
        "quit",
        "interface GigabitEthernet 0/0/0",
        "ip address 192.168.2.1 24",
        "undo shutdown",
        "quit",
        "display ip routing-table"
      ]);
    },
    summary: "R2 的 GE0/0/1 = 10.0.0.2/30，GE0/0/0 = 192.168.2.1/24",
    detail: [
      { h: "两端的 /30 必须同网段", p: "R1 是 10.0.0.1/30、R2 是 10.0.0.2/30，网络号都是 10.0.0.0。掩码写成 /24 也能配通，但两端对「直连网段有多大」的理解不一致，路由表会出现不对称的表项，排障时很难发现。" },
      { h: "现在仍然不通", p: "两台路由器都只认识自己的直连网段。PC1 的包到 R1，目的 192.168.2.10 无表项可查。" }
    ]
  },
  {
    id: 4, name: "路由表 · 只有直连",
    run: async function(api){
      api.setDev("R1");
      await api.run(["display ip routing-table"]);
      api.setDev("R2");
      await api.run(["display ip routing-table"]);
    },
    summary: "两台都只有 Direct / Local，没有任何 Static，也没有到对端网段的路由",
    detail: [
      { h: "数表项", p: "R1：10.0.0.0/30、10.0.0.1/32、192.168.1.0/24、192.168.1.1/32，共 4 条。R2 对称，共 4 条。" },
      { h: "关键缺口", p: "R1 没有 192.168.2.0/24，R2 没有 192.168.1.0/24。<b>直连路由只覆盖接口自己所在的网段</b>，跨网段必须另外指路。" }
    ]
  },
  {
    id: 5, name: "只配 R1 去程 · 仍然不通", key: true, keepTrace: true,
    done: function(S){
      return hasStatic(S, "R1", "192.168.2.0", 24, "10.0.0.2");
    },
    run: async function(api){
      api.setDev("R1");
      await api.run([
        "system-view",
        "ip route-static 192.168.2.0 24 10.0.0.2",
        "quit",
        "display ip routing-table"
      ]);
      api.play(pingScene(api.S, "PC1", "PC2"));
    },
    summary: "R1 去程有了，PC1 → PC2 还是不通：回程在 R2 断了",
    detail: [
      { h: "反直觉的地方", p: "R1 的路由表已经出现 192.168.2.0/24 Static，PC1 的请求确实能到 PC2；<b>但 PC2 的回应在 R2 查表时被丢弃</b>，因为 R2 没有回 192.168.1.0/24 的路由。" },
      { h: "用 R1 自己 ping 验证", p: "在 R1 上 ping 192.168.2.10 是通的——源地址是 10.0.0.1，R2 有 10.0.0.0/30 的直连，回程不需要额外路由。主机之间的 ping 却要经过两端网关，所以仍然失败。" },
      { h: "结论", p: "静态路由是<b>单向</b>的。去程和回程是两张独立的表，必须分别配。" }
    ]
  },
  {
    id: 6, name: "配 R2 回程 · 通了",
    done: function(S){
      return hasStatic(S, "R2", "192.168.1.0", 24, "10.0.0.1");
    },
    run: async function(api){
      api.setDev("R2");
      await api.run([
        "system-view",
        "ip route-static 192.168.1.0 24 10.0.0.1",
        "quit",
        "display ip routing-table"
      ]);
      api.play(pingScene(api.S, "PC1", "PC2"));
    },
    summary: "R2 补上回程 192.168.1.0/24 → 10.0.0.1，PC1 → PC2 双向成立",
    detail: [
      { h: "补齐了什么", p: "R2 现在知道 192.168.1.0/24 从 10.0.0.1 出去。PC1 的请求与 PC2 的回应各走各的表，两个方向都成立。" },
      { h: "看拓扑", p: "互联链路开始有流量光点——只有两端都能通，链路 flow 才大于 0。" }
    ]
  },
  {
    id: 7, name: "逐跳 · 一次完整的往返", keepTrace: true,
    run: function(api){ api.play(pingScene(api.S, "PC1", "PC2")); },
    summary: "PC1 → 网关 R1 → 查表命中 Static → 10.0.0.2 → R2 查表命中 Direct → PC2，回程对称",
    detail: [
      { h: "去程", p: "PC1 把包交给网关 192.168.1.1；R1 查表命中 192.168.2.0/24，下一跳 10.0.0.2，从 GE0/0/1 发出；R2 收到后查表命中 192.168.2.0/24 直连，从 GE0/0/0 送到 PC2。" },
      { h: "回程", p: "PC2 把回应交给网关 192.168.2.1；R2 查表命中 192.168.1.0/24，下一跳 10.0.0.1；R1 查表命中 192.168.1.0/24 直连，送回 PC1。" },
      { h: "每一跳都独立查表", p: "没有「整条路径」这种东西。每台路由器只看自己的路由表，决定下一跳是谁。" }
    ]
  },
  {
    id: 8, name: "最长前缀匹配 · 加一条明细",
    done: function(S){
      return hasStatic(S, "R1", "192.168.2.128", 25, "10.0.0.2");
    },
    run: async function(api){
      api.setDev("R1");
      await api.run([
        "system-view",
        "ip route-static 192.168.2.128 25 10.0.0.2",
        "quit",
        "display ip routing-table"
      ]);
      api.tab("fwd");
    },
    summary: "192.168.2.128/25 与 192.168.2.0/24 并存，掩码更长的优先",
    detail: [
      { h: "最长前缀优先", p: "查表时先看掩码长度：/25 比 /24 更具体，落在 192.168.2.128～192.168.2.255 的地址一律命中 /25，与配置先后无关。" },
      { h: "PC2 为什么没受影响", p: "PC2 是 <b>192.168.2.10</b>，落在 192.168.2.0/25 里，仍然命中 /24；换成一个 192.168.2.200 的地址，才会命中 /25。切到「转发判读」页看这两行。" },
      { h: "工程含义", p: "明细路由常用来把某个地址段单独引流，而不影响整个网段。" }
    ]
  },
  {
    id: 9, name: "扰动 · 撤掉回程路由", key: true, keepTrace: true,
    done: function(S){
      return S.R2.removedBack === true && hasStatic(S, "R1", "192.168.2.0", 24, "10.0.0.2");
    },
    run: async function(api){
      api.setDev("R2");
      await api.run([
        "system-view",
        "undo ip route-static 192.168.1.0 24 10.0.0.1",
        "quit",
        "display ip routing-table"
      ]);
      api.play(pingScene(api.S, "PC1", "PC2"));
    },
    summary: "回程一撤，PC1 → PC2 立刻断；R1 的路由表一点没变",
    detail: [
      { h: "对照两张表", p: "R1 仍有 192.168.2.0/24 Static，去程完全正常；R2 少了 192.168.1.0/24，回应在 R2 就被丢。这就是「单通」的典型形态。" },
      { h: "排障顺序", p: "先看源端路由表有没有目的网段，再看目的端有没有回源网段。两边不对称，ping 一定失败。" }
    ]
  }
];

/* ---------------- 导出 ---------------- */
export default {
  id: "05",
  title: "静态路由",
  meta: "HUAWEI AR2220 · VRP V200R005C00",
  stageLabel: "L3 ROUTING · 2 × AR2220 · 2 × HOST",
  totalSteps: steps.length,
  devices: ["R1", "R2"],
  tabs: [
    { key: "port", label: "接口与 IP", hint: "接口地址与三层状态" },
    { key: "route", label: "路由表", hint: "IP 路由表" },
    { key: "arp", label: "ARP 表", hint: "邻居 MAC 解析" },
    { key: "fwd", label: "转发判读", hint: "最长前缀匹配示例" }
  ],
  legend: [
    { c: "#35E08A", label: "Direct 直连" },
    { c: "#38E1FF", label: "Static 静态" },
    { c: "#7E93AB", label: "Local 本机" },
    { c: "#FF4D5E", label: "无匹配 / 丢弃" }
  ],
  phases: {
    enter: "进系统视图",
    ip: "配接口 IP",
    shutdown: "启用接口",
    route: "写静态路由",
    verify: "校验",
    peer: "换设备"
  },
  viewName: VIEW_NAME,
  viewHint: VIEW_HINT,
  actions: [
    { id: "pc1pc2", label: "PC1 → PC2", run: function(l){ l.playScene(pingScene(l.S, "PC1", "PC2")); } },
    { id: "pc2pc1", label: "PC2 → PC1", run: function(l){ l.playScene(pingScene(l.S, "PC2", "PC1")); } },
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
      { h: "① 接口层", p: "接口 up + 配了 IP，路由表才会自动生成 Direct（网段）与 Local（本机 /32）两条直连表项。" },
      { h: "② 静态层", p: "ip route-static 写的是「目的网段 + 掩码 + 下一跳」。出接口由下一跳在直连网段里递归解析得到。" },
      { h: "③ 查表层", p: "每台路由器各查各的表，逐跳决定下一跳。同一目的地址有多个前缀时，<b>掩码更长者优先</b>。" },
      { h: "④ 双向", p: "静态路由是<b>单向</b>的：去程在 R1 指过去，回程还要在 R2 指回来。只配一半，ping 一定失败——这就是 S5 反直觉的地方。" }
    ]
  },

  viewRows: function(ctx){
    return [
      { h: "<" + ctx.dev + "> 用户视图", p: "只读：display、ping。改配置的命令在这里一律被拒。", cls: ctx.view === "user" ? "pass" : "" },
      { h: "[" + ctx.dev + "] 系统视图", p: "全局入口：interface、ip route-static、undo ip route-static。", cls: ctx.view === "system" ? "pass" : "" },
      { h: "[" + ctx.dev + "-GE0/0/x] 接口视图", p: "作用域收窄到当前接口：ip address、undo shutdown。", cls: ctx.view === "if" ? "pass" : "" }
    ];
  },

  boot: function(write, printGuide){
    write("Info: 已加载 R1 / R2 的出厂配置，三根线均已连接，接口未配 IP 且处于 shutdown。", "dim");
    write("      静态路由是单向的：去程与回程必须分别配置。S1 先看基线。", "dim");
    write("", "dim");
    printGuide();
  }
};
