import { pad, padL } from "../lib/util.js";

/* =========================================================================
   实验 01 · VLAN 与 Trunk
   -------------------------------------------------------------------------
   这一层只描述「实验是什么」，不含任何 DOM 操作：
     createState  → 设备初始状态（响应式，命令直接改它）
     commands     → 命令表：正则 + 视图 + 执行体
     tables       → 表项渲染：从状态派生，状态一变表就重算
     topology     → 拓扑渲染模型：端口颜色、标签、链路全部由状态推导
     steps        → 板块：目标判定 done(S) 达成时自动完成
     guide        → 引导：从状态反推下一条该敲什么
   ========================================================================= */

const VLAN_COLOR = { 1: "#7E93AB", 10: "#38E1FF", 20: "#FFB545" };
const vlanColor = v => VLAN_COLOR[v] || "#7C8B9E";
/* 粒子用 "r,g,b" 形式的颜色，和 SVG 里的十六进制保持同源 */
function hexRgb(h){
  const n = parseInt(h.slice(1), 16);
  return ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255);
}

const PORTS = ["GE0/0/1", "GE0/0/2", "GE0/0/3", "GE0/0/4"];
const TRUNK = "GE0/0/24";

const HOSTS = {
  PC1: { id: "PC1", sw: "SW1", port: "GE0/0/1", ip: "192.168.10.10", mask: "255.255.255.0", mac: "5489-98a1-0001", x: 100, y: 200 },
  PC2: { id: "PC2", sw: "SW1", port: "GE0/0/2", ip: "192.168.20.10", mask: "255.255.255.0", mac: "5489-98a1-0002", x: 270, y: 200 },
  PC3: { id: "PC3", sw: "SW2", port: "GE0/0/1", ip: "192.168.10.20", mask: "255.255.255.0", mac: "5489-98b3-0011", x: 1100, y: 200 },
  PC4: { id: "PC4", sw: "SW2", port: "GE0/0/2", ip: "192.168.20.20", mask: "255.255.255.0", mac: "5489-98b3-0012", x: 1210, y: 200 }
};

/* ---------------- 拓扑几何 ---------------- */
const DEV = {
  SW1: { x: 70,  y: 62, w: 300, h: 74, sfpRel: 246, rjRel: [40, 76, 112, 148], sfpSide: "right" },
  SW2: { x: 1040, y: 62, w: 300, h: 74, sfpRel: 12,  rjRel: [60, 96, 132, 168], sfpSide: "left" }
};

function rjX(dev, i){ return DEV[dev].x + DEV[dev].rjRel[i]; }
function sfpX(dev){ return DEV[dev].x + DEV[dev].sfpRel; }

const ROUTES = {
  "pc1-up":   "M110 136 C110 165 100 172 100 196",
  "pc1-down": "M100 196 C100 172 110 165 110 136",
  "pc2-up":   "M146 136 C146 165 270 172 270 196",
  "pc2-down": "M270 196 C270 172 146 165 146 136",
  "pc3-up":   "M1100 136 C1100 168 1100 172 1100 196",
  "pc3-down": "M1100 196 C1100 172 1100 168 1100 136",
  "pc4-up":   "M1136 136 C1136 165 1210 172 1210 196",
  "pc4-down": "M1210 196 C1210 172 1136 165 1136 136",
  "trunk-r":  "M358 115 L1052 115",
  "trunk-l":  "M1052 115 L358 115",
  "in1":      "M110 106 C190 150 270 132 314 115",
  "in2":      "M146 106 C210 158 280 138 314 115",
  "in3":      "M182 106 C230 158 290 140 314 115",
  "in4":      "M218 106 C260 158 300 142 314 115",
  "out1":     "M1052 115 C1080 138 1088 122 1100 106",
  "out2":     "M1052 115 C1090 150 1120 130 1136 106",
  "out3":     "M1052 115 C1100 160 1150 136 1172 106",
  "out4":     "M1052 115 C1110 168 1180 142 1208 106"
};

function portRoute(dev, idx, dir){
  if(dev === "SW1") return dir === "in" ? "in" + (idx + 1) : "in" + (idx + 1);
  return "out" + (idx + 1);
}
function pcRoute(id, dir){
  return id.toLowerCase() + "-" + dir;
}
function hostRoute(host, dir){ return host.id.toLowerCase() + (dir === "up" ? "-up" : "-down"); }

/* ---------------- 初始状态 ---------------- */
function makeSwitch(name){
  const ports = {};
  PORTS.forEach(function(p){ ports[p] = { type: "access", pvid: 1, allow: [1], up: true }; });
  ports[TRUNK] = { type: "access", pvid: 1, allow: [1], up: true };
  return { name: name, vlans: { 1: { name: "VLAN 0001" } }, ports: ports, mac: [] };
}

export function createState(){
  return { SW1: makeSwitch("SW1"), SW2: makeSwitch("SW2") };
}

/* ---------------- 视图 ---------------- */
const VIEW_NAME = { user: "用户视图", system: "系统视图", if: "接口视图" };
const VIEW_HINT = { system: "system-view", if: "interface GigabitEthernet 0/0/1" };

function prompt(ctx){
  if(ctx.view === "user") return "<" + ctx.dev + ">";
  if(ctx.view === "system") return "[" + ctx.dev + "]";
  return "[" + ctx.dev + "-" + shortIf(ctx.ifName) + "]";
}
function shortIf(n){ return String(n).replace("GigabitEthernet", "GE"); }
function ifPort(ctx){ return "GE" + String(ctx.ifName).replace("GigabitEthernet", ""); }

/* ---------------- 命令表 ---------------- */
const P = "GigabitEthernet|GE|gigabitethernet";

const commands = [
  {
    id: "system-view", match: /^(system-view|sys)$/, view: null, kind: "view",
    usage: "system-view",
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
    id: "sysname", match: /^sysname (\S+)$/, view: "system", kind: "config", usage: "sysname <name>",
    explain: [{ h: "改的是提示符", p: "只影响设备的展示名，不改变任何转发表项。" }],
    run(api, m){
      api.S[api.ctx.dev].name = m[1];
      api.change("sysname", "—", m[1]);
      api.say("// 设备名改为 " + m[1] + "（本实验仅影响提示符，拓扑标签不变）。", "op");
    }
  },
  {
    id: "vlan-batch", match: /^vlan batch (.+)$/, view: "system", kind: "config",
    usage: "vlan batch <10 20>",
    explain: [
      { h: "建表", p: "在 VLAN 表里插入表项。此时<b>没有任何端口属于它</b>，不产生任何转发行为。" },
      { h: "下一步", p: "把端口划进去（改 PVID），或者让 trunk 放行它，VLAN 才真正开始工作。" }
    ],
    run(api, m){
      const sw = api.S[api.ctx.dev];
      const added = [];
      m[1].split(" ").filter(x => /^\d+$/.test(x)).forEach(function(n){
        const vid = parseInt(n, 10);
        if(vid < 1 || vid > 4094) return;
        if(!sw.vlans[vid]){
          sw.vlans[vid] = { name: "VLAN " + String(vid).padStart(4, "0") };
          added.push(vid);
          api.change("vlan " + vid, "不存在", "common / enable", { row: "vlan-" + vid, kind: "enter" });
        }
      });
      api.say("Info: This operation may take a few seconds. Please wait for a moment...done.", "dim");
      if(added.length){
        api.tab("vlan");
        api.say("// 新建 " + added.length + " 个 VLAN：" + added.join("、") + "（此时没有端口属于它们）", "op");
        api.fx({ kind: "scan", box: [DEV[api.ctx.dev].x, DEV[api.ctx.dev].y, DEV[api.ctx.dev].w, DEV[api.ctx.dev].h], color: "#38E1FF" });
      }else{
        api.say("// 上述 VLAN 均已存在，本次无变更。", "op");
      }
    }
  },
  {
    id: "interface", match: new RegExp("^interface (?:" + P + ")?\\s*([\\d/]+)$", "i"),
    view: "system", kind: "view", usage: "interface GigabitEthernet 0/0/1",
    run(api, m){
      const key = "GE" + m[1];
      const sw = api.S[api.ctx.dev];
      if(!sw.ports[key]){
        api.say("Error: The port does not exist.", "err");
        api.change("__err", "", "");
        return { noChange: true };
      }
      api.ctx.view = "if"; api.ctx.ifName = "GigabitEthernet" + m[1];
    }
  },
  {
    id: "link-type", match: /^port link-type (access|trunk|hybrid)$/, view: "if", kind: "config",
    usage: "port link-type <access|trunk>",
    explain: [
      { h: "改端口类型", p: "access 与 trunk 的差别只有一条：<b>允不允许带标签的帧通过</b>。" },
      { h: "连带影响", p: "切换类型会把允许列表重置为 VLAN 1，原先放行的 VLAN 要重新配。" }
    ],
    run(api, m){
      const p = api.S[api.ctx.dev].ports[ifPort(api.ctx)];
      const nt = m[1];
      if(nt === "hybrid"){ api.say("// hybrid 端口不在本实验范围内，已忽略。", "op"); return; }
      if(p.type === nt){ api.say("// 该端口本来就是 " + nt + " 类型，命令未产生状态变化。", "op"); return; }
      const old = p.type;
      p.type = nt;
      if(nt === "access"){ if(!api.S[api.ctx.dev].vlans[p.pvid]) p.pvid = 1; p.allow = [1]; }
      else { p.allow = [1]; }
      api.change(ifPort(api.ctx) + ".link-type", old, nt, { row: "port-" + ifPort(api.ctx) });
      api.say("// " + ifPort(api.ctx) + " 链路类型 " + old + " → " + nt +
        (nt === "trunk" ? "；trunk 默认只放行 VLAN 1" : ""), "op");
      const d = DEV[api.ctx.dev];
      api.fx({ kind: "pulse", target: api.ctx.dev + "/" + ifPort(api.ctx), color: "#FFB545" });
      if(ifPort(api.ctx) === TRUNK) api.fx({ kind: "beam", route: "trunk-r", color: "#FFB545" });
      void d;
    }
  },
  {
    id: "default-vlan", match: /^port default vlan (\d+)$/, view: "if", kind: "config",
    usage: "port default vlan <10>",
    explain: [
      { h: "改 PVID", p: "端口 PVID 改变。此后从这个端口进来的<b>无标签帧</b>会被归入新 VLAN；出去的帧若属于该 VLAN，会去掉标签。" },
      { h: "注意", p: "PVID 只影响无标签帧的归属。带标签的帧走 trunk 的允许列表逻辑，与 PVID 无关。" }
    ],
    run(api, m){
      const sw = api.S[api.ctx.dev], p = sw.ports[ifPort(api.ctx)];
      const vid = parseInt(m[1], 10);
      if(p.type !== "access"){ api.say("Error: The port is not an access port.", "err"); return; }
      if(!sw.vlans[vid]){
        api.say("Error: The VLAN does not exist.", "err");
        api.say("      先执行 vlan batch " + vid + " 创建该 VLAN。", "dim");
        return;
      }
      if(p.pvid === vid){ api.say("// " + ifPort(api.ctx) + " 的 PVID 已经是 " + vid + "，命令未产生状态变化。", "op"); return; }
      const from = p.pvid;
      p.pvid = vid; p.allow = [vid];
      api.change(ifPort(api.ctx) + ".PVID", from, vid, { row: "port-" + ifPort(api.ctx) });
      api.say("// " + ifPort(api.ctx) + " PVID " + from + " → " + vid +
        "（该口新收到的无标签帧归入 VLAN " + vid + "）", "op");
      api.fx({ kind: "pulse", target: api.ctx.dev + "/" + ifPort(api.ctx), color: vlanColor(vid) });
    }
  },
  {
    id: "allow-pass", match: /^port trunk allow-pass vlan (.+)$/, view: "if", kind: "config",
    usage: "port trunk allow-pass vlan <10 20>",
    explain: [
      { h: "改允许列表", p: "trunk 口增加放行的 VLAN。列表内的 VLAN 可以带 tag 通过，列表外的在<b>入方向直接丢弃</b>。" },
      { h: "关键", p: "两台交换机<i>两端</i>都要放行。只配一端，帧会在另一端入方向被丢。" }
    ],
    run(api, m){
      const sw = api.S[api.ctx.dev], p = sw.ports[ifPort(api.ctx)];
      if(p.type !== "trunk"){ api.say("Error: The port is not a trunk port.", "err"); return; }
      let list = [];
      const spec = m[1];
      if(spec === "all"){ list = Object.keys(sw.vlans).map(Number); }
      else{
        spec.split(" ").forEach(function(tk){
          const r = tk.match(/^(\d+) to (\d+)$/);
          if(r){ for(let v = +r[1]; v <= +r[2]; v++) list.push(v); }
          else if(/^\d+$/.test(tk)) list.push(+tk);
        });
      }
      const miss = list.filter(v => !sw.vlans[v]);
      if(miss.length){
        api.say("Error: The VLAN does not exist.", "err");
        api.say("      缺失 VLAN：" + miss.join(", "), "dim");
        return;
      }
      const before = p.allow.slice().sort((a, b) => a - b);
      const merged = {};
      p.allow.forEach(v => { merged[v] = true; });
      list.forEach(v => { merged[v] = true; });
      p.allow = Object.keys(merged).map(Number).sort((a, b) => a - b);
      if(p.allow.indexOf(1) < 0) p.allow.unshift(1);
      if(p.allow.join(",") === before.join(",")){
        api.say("// 允许列表本来就是 " + before.join(",") + "，命令未产生状态变化。", "op");
        return;
      }
      api.change(ifPort(api.ctx) + ".allow-pass", before.join(","), p.allow.join(","), { row: "trunk-" + ifPort(api.ctx) });
      api.tab("trunk");
      api.say("// trunk " + ifPort(api.ctx) + " 允许列表 → " + p.allow.join(", "), "op");
      p.allow.forEach(function(v, i){
        if(v === 1) return;
        api.fx({ kind: "chip", route: api.ctx.dev === "SW1" ? "trunk-r" : "trunk-l", text: v, color: vlanColor(v), dur: 1000, life: 1100 + i * 120 });
      });
    }
  },
  {
    id: "undo-allow", match: /^undo port trunk allow-pass vlan (.+)$/, view: "if", kind: "config",
    usage: "undo port trunk allow-pass vlan <20>",
    explain: [
      { h: "收窄允许列表", p: "被移除的 VLAN 上，帧在 trunk 口<b>入方向</b>即被丢弃，根本走不到查 MAC 表这一步。" },
      { h: "现象", p: "对应 VLAN 的主机立刻断连，但 access 口仍是 up，链路指示灯不会变化——只看灯查不出来。" }
    ],
    run(api, m){
      const p = api.S[api.ctx.dev].ports[ifPort(api.ctx)];
      if(p.type !== "trunk"){ api.say("Error: The port is not a trunk port.", "err"); return; }
      const del = [];
      m[1].split(" ").forEach(function(tk){
        const r = tk.match(/^(\d+) to (\d+)$/);
        if(r){ for(let v = +r[1]; v <= +r[2]; v++) del.push(v); }
        else if(/^\d+$/.test(tk)) del.push(+tk);
      });
      const before = p.allow.join(",");
      p.allow = p.allow.filter(v => del.indexOf(v) < 0);
      if(p.allow.indexOf(1) < 0) p.allow.unshift(1);
      if(p.allow.join(",") === before){
        api.say("// 允许列表里本来就没有 " + del.join(" ") + "，命令未产生状态变化。", "op");
        return;
      }
      api.change(ifPort(api.ctx) + ".allow-pass", before, p.allow.join(","), { row: "trunk-" + ifPort(api.ctx) });
      api.tab("trunk");
      api.say("// trunk " + ifPort(api.ctx) + " 允许列表 → " + p.allow.join(", ") + "（VLAN 1 不可删除）", "op");
    }
  },

  /* ---- 只读命令 ---- */
  {
    id: "display-vlan", match: /^display vlan$/, view: null, kind: "doc", usage: "display vlan",
    doc: "这张表回答：<b>VLAN 有几个、每个 VLAN 里有哪些端口</b>。UT 表示该端口发出的帧不带标签，TG 表示带标签。",
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
        const arr = [];
        Object.keys(sw.ports).forEach(function(pn){
          const pp = sw.ports[pn];
          if(pp.type === "access" && pp.pvid === vid) arr.push("UT:" + pn + "(" + (pp.up ? "U" : "D") + ")");
          else if(pp.type === "trunk" && pp.allow.indexOf(vid) >= 0) arr.push((vid === pp.pvid ? "UT:" : "TG:") + pn + "(" + (pp.up ? "U" : "D") + ")");
        });
        let line = "";
        arr.forEach(s => { line += pad(s, 22); });
        api.say(pad(vid, 5) + pad("common", 8) + (line.trim() || "-"));
      });
      api.tab("vlan");
    }
  },
  {
    id: "display-port-vlan", match: /^display port vlan$/, view: null, kind: "doc", usage: "display port vlan",
    doc: "按端口维度看：链路类型、PVID、trunk 允许列表。排查「某个 VLAN 不通」时，先看这一张。",
    run(api){
      const sw = api.S[api.ctx.dev];
      api.say(pad("Port", 24) + pad("Link Type", 13) + pad("PVID", 6) + "Trunk VLAN List", "dim");
      api.say("-------------------------------------------------------------------------------", "dim");
      Object.keys(sw.ports).forEach(function(pn){
        const pp = sw.ports[pn];
        api.say(pad("GigabitEthernet" + pn.slice(2), 24) + pad(pp.type, 13) + pad(pp.pvid, 6) +
          (pp.type === "trunk" ? pp.allow.join(", ") : "-"));
      });
      api.tab("port");
    }
  },
  {
    id: "display-mac", match: /^display mac-address$/, view: null, kind: "doc", usage: "display mac-address",
    doc: "MAC 表按 VLAN 分组。同一个 MAC 在不同 VLAN 下是两条独立表项——这正是 VLAN 隔离在转发表上的体现。",
    run(api){
      const sw = api.S[api.ctx.dev];
      if(!sw.mac.length){
        api.say("Total items: 0", "dim");
        api.say("MAC 地址表为空。执行一次数据面测试后会产生表项。", "dim");
      }else{
        api.say("Flags: * - Backup   # - System   $ - TRUNK   % - Server", "dim");
        api.say("--------------------------------------------------------------------------------", "dim");
        api.say(pad("MAC Address", 16) + pad("VLAN/VSI/BD", 32) + pad("Learned-From", 20) + "Type", "dim");
        sw.mac.slice().sort((a, b) => a.vlan - b.vlan).forEach(function(e){
          api.say(pad(e.mac.toUpperCase(), 16) + pad(e.vlan + "/-/-", 32) + pad(e.port, 20) + e.type);
        });
        api.say("", "dim");
        api.say("Total items: " + sw.mac.length, "dim");
      }
      api.tab("mac");
    }
  },
  {
    id: "display-brief", match: /^display interface brief$/, view: null, kind: "doc", usage: "display interface brief",
    doc: "只看物理层与协议层状态。注意：<b>链路 up 不代表 VLAN 通了</b>，这是新手最常见的误判。",
    run(api){
      const sw = api.S[api.ctx.dev];
      api.lines(["PHY: Physical", "*down: administratively down", "(l): loopback", "(s): spoofing", ""], "dim");
      api.say(pad("Interface", 28) + pad("PHY", 8) + pad("Protocol", 10) + pad("InUti", 7) + "inErrors", "dim");
      api.say("--------------------------------------------------------------------------------", "dim");
      Object.keys(sw.ports).forEach(function(pn){
        const pp = sw.ports[pn];
        api.say(pad("GigabitEthernet" + pn.slice(2), 28) + pad(pp.up ? "up" : "*down", 8) +
          pad(pp.up ? "up" : "down", 10) + pad(pp.up ? "0.01%" : "0%", 7) + "0");
      });
    }
  },
  {
    id: "display-conf", match: /^display current-configuration$/, view: null, kind: "doc", usage: "display current-configuration",
    doc: "设备上真正生效的配置。与表项对照，可以看出哪些是默认值、哪些是显式配置的。",
    run(api){
      const sw = api.S[api.ctx.dev];
      api.say("#", "dim");
      api.say("sysname " + sw.name);
      api.say("#", "dim");
      Object.keys(sw.vlans).filter(v => +v !== 1).forEach(function(v){
        api.say("vlan " + v); api.say("#", "dim");
      });
      Object.keys(sw.ports).forEach(function(pn){
        const pp = sw.ports[pn];
        api.say("interface GigabitEthernet" + pn.slice(2));
        api.say(" port link-type " + pp.type);
        if(pp.type === "access") api.say(" port default vlan " + pp.pvid);
        else api.say(" port trunk allow-pass vlan " + pp.allow.join(" "));
        api.say("#", "dim");
      });
      api.say("return");
    }
  },
  {
    id: "ping", match: /^ping ([\d.]+)$/, view: null, kind: "test", usage: "ping <ip>",
    run(api, m){
      api.lines(["  PING " + m[1] + ": 56  data bytes, press CTRL_C to break",
        "    Request time out", "    Request time out", "",
        "  --- " + m[1] + " ping statistics ---",
        "    2 packet(s) transmitted", "    0 packet(s) received", "    100.00% packet loss"], "err");
      api.say("// 两台交换机没有配置管理 IP，也没有三层接口。", "op");
      api.say("// 请用右下角的 PC 数据面测试验证二层可达性。", "op");
      api.whyPing && api.whyPing();
    }
  }
];

/* ---------------- 表项 ---------------- */
function vlanRowKey(v){ return "vlan-" + v; }

function tables(S, tab, ctx){
  const sw = S[ctx.dev];
  if(tab === "vlan"){
    const rows = Object.keys(sw.vlans).map(Number).sort((a, b) => a - b).map(function(vid){
      const ps = Object.keys(sw.ports).filter(function(pn){
        const p = sw.ports[pn];
        return (p.type === "access" && p.pvid === vid) || (p.type === "trunk" && p.allow.indexOf(vid) >= 0);
      });
      return {
        key: vlanRowKey(vid),
        cells: [
          { t: vid, cls: vid === 10 ? "v10" : vid === 20 ? "v20" : vid === 1 ? "v1" : "" },
          { t: "common", cls: "c" },
          { t: sw.vlans[vid].name, cls: "c" },
          { t: ps.length ? ps.map(function(pn){
              const p = sw.ports[pn];
              return ((p.type === "trunk" && p.pvid !== vid) ? "TG:" : "UT:") + pn + "(U)";
            }).join("  ") : "—" }
        ]
      };
    });
    return { head: ["VID", "TYPE", "NAME", "PORTS"], rows };
  }
  if(tab === "port"){
    return {
      head: ["PORT", "LINK TYPE", "PVID", "TRUNK VLAN LIST"],
      rows: Object.keys(sw.ports).map(function(pn){
        const p = sw.ports[pn];
        return {
          key: "port-" + pn,
          cells: [
            { t: pn, cls: "c" },
            { t: p.type, cls: p.type === "trunk" ? "v20" : "c" },
            { t: p.pvid, cls: p.pvid === 10 ? "v10" : p.pvid === 20 ? "v20" : "c" },
            { t: p.type === "trunk" ? p.allow.join(", ") : "—", cls: "c" }
          ]
        };
      })
    };
  }
  if(tab === "mac"){
    if(!sw.mac.length) return { head: ["MAC", "VLAN", "PORT", "TYPE"], rows: [], empty: "MAC 地址表为空 · 跑一次数据面测试后产生表项" };
    return {
      head: ["MAC", "VLAN", "PORT", "TYPE"],
      rows: sw.mac.map(function(e, i){
        return {
          key: "mac-" + e.mac + "-" + e.vlan,
          cells: [
            { t: e.mac.toUpperCase(), cls: "c" },
            { t: e.vlan, cls: e.vlan === 10 ? "v10" : e.vlan === 20 ? "v20" : "c" },
            { t: e.port, cls: "c" },
            { t: e.type, cls: "c" }
          ]
        };
      })
    };
  }
  /* trunk */
  return {
    head: ["PORT", "ALLOW-PASS", "说明"],
    rows: Object.keys(sw.ports).filter(pn => sw.ports[pn].type === "trunk").map(function(pn){
      const p = sw.ports[pn];
      return {
        key: "trunk-" + pn,
        cells: [
          { t: pn, cls: "c" },
          { t: p.allow.join(", "), cls: "v20" },
          { t: p.allow.length <= 1 ? "只剩 VLAN 1，等于什么都没放行" : "放行 " + (p.allow.length - 1) + " 个业务 VLAN", cls: "c" }
        ]
      };
    }),
    empty: "还没有 trunk 端口 · 执行 port link-type trunk 后出现在这里"
  };
}

/* ---------------- 拓扑 ---------------- */
function topology(S, ui, ctx){
  const devices = Object.keys(DEV).map(function(id){
    const d = DEV[id], sw = S[id];
    const ports = [];
    PORTS.forEach(function(pn, i){
      const p = sw.ports[pn];
      ports.push({
        name: pn, kind: "rj45", x: d.rjRel[i], y: 44,
        color: vlanColor(p.pvid), up: p.up, label: pn.slice(-1),
        dimBand: p.type === "trunk"
      });
    });
    const t = sw.ports[TRUNK];
    ports.push({
      name: TRUNK, kind: "sfp", x: d.sfpRel, y: 44,
      color: t.type === "trunk" ? "#FFB545" : vlanColor(t.pvid),
      up: t.up, label: "0/0/24"
    });
    return {
      id: id, x: d.x, y: d.y, w: d.w, h: d.h, model: "S5700-28C-EI",
      silk: "M12 24 h60 M12 28 h44 M12 32 h60 M12 36 h44",
      leds: [
        { x: 272, y: 10, color: "#35E08A", glow: true, label: "PWR", tx: 278, ty: 12.5 },
        { x: 258, y: 10, color: "#38E1FF", glow: true, label: "SYS", tx: 232, ty: 12.5 }
      ],
      ports: ports,
      tags: [{ x: 0, y: -8, text: id, cls: "dev-label" }, { x: 34, y: -8, text: "192.168.1." + (id === "SW1" ? 1 : 2) + " / L2", cls: "dev-sub" }]
    };
  });

  const hosts = Object.keys(HOSTS).map(function(k){
    const h = HOSTS[k], p = S[h.sw].ports[h.port];
    return {
      id: h.id, x: h.x, y: h.y, ip: h.ip, mac: h.mac,
      vlan: p.pvid, color: vlanColor(p.pvid), up: p.up
    };
  });

  const trunkPort = S.SW1.ports[TRUNK];
  const trunkPeer = S.SW2.ports[TRUNK];

  /* 干道到底通不通：两端都 trunk、都 up、允许列表有交集（VLAN 1 不算数） */
  const trunkAllow = (trunkPort.type === "trunk" && trunkPeer.type === "trunk" && trunkPort.up && trunkPeer.up)
    ? trunkPort.allow.filter(v => v !== 1 && trunkPeer.allow.indexOf(v) >= 0)
    : [];
  const trunkFlow = trunkAllow.length ? 1 : 0;

  /* 接入链路：端口 up 就有主机心跳流量 */
  function hostFlow(hid){
    const h = HOSTS[hid];
    const p = S[h.sw].ports[h.port];
    return p && p.up ? 0.42 : 0;
  }
  function hostColor(hid){
    const h = HOSTS[hid];
    return hexRgb(vlanColor(S[h.sw].ports[h.port].pvid));
  }

  const links = [
    { id: "lk-pc1", d: ROUTES["pc1-down"], cls: "", flow: hostFlow("PC1"), flowColor: hostColor("PC1") },
    { id: "lk-pc2", d: ROUTES["pc2-down"], cls: "", flow: hostFlow("PC2"), flowColor: hostColor("PC2") },
    { id: "lk-pc3", d: ROUTES["pc3-down"], cls: "", flow: hostFlow("PC3"), flowColor: hostColor("PC3") },
    { id: "lk-pc4", d: ROUTES["pc4-down"], cls: "", flow: hostFlow("PC4"), flowColor: hostColor("PC4") },
    {
      id: "lk-trunk", d: "M358 115 L1052 115",
      cls: trunkPort.type === "trunk" ? "trunk on" : "trunk",
      flow: trunkFlow,
      flowColor: trunkFlow && trunkAllow.indexOf(20) >= 0 ? "255,181,69" : "56,225,255"
    }
  ];

  const anchors = {};
  PORTS.forEach(function(pn, i){
    anchors["SW1/" + pn] = [DEV.SW1.x + DEV.SW1.rjRel[i], DEV.SW1.y + 44];
    anchors["SW2/" + pn] = [DEV.SW2.x + DEV.SW2.rjRel[i], DEV.SW2.y + 44];
  });
  anchors["SW1/" + TRUNK] = [DEV.SW1.x + DEV.SW1.sfpRel + 21, DEV.SW1.y + 44];
  anchors["SW2/" + TRUNK] = [DEV.SW2.x + DEV.SW2.sfpRel + 21, DEV.SW2.y + 44];

  const labels = [
    {
      text: trunkPort.type === "trunk" ? "TRUNK · 802.1Q · " + trunkPort.allow.join(",") : "ACCESS · VLAN " + trunkPort.pvid,
      x: 705, y: 103, anchor: "middle",
      cls: "lk-tag" + (trunkPort.type === "trunk" ? " on" : "")
    }
  ];

  return {
    viewBox: "0 0 1400 300",
    devices, hosts, links, routes: ROUTES, anchors, labels
  };
}

/* ---------------- 数据面场景 ---------------- */
function ipToInt(ip){ return ip.split(".").reduce((a, b) => (a << 8) + (+b), 0) >>> 0; }
function sameSubnet(a, b, mask){
  const m = ipToInt(mask);
  return (ipToInt(a) & m) === (ipToInt(b) & m);
}

function learn(S, dev, port, mac, vlan){
  const sw = S[dev];
  if(!sw.mac.some(e => e.mac === mac && e.vlan === vlan)){
    sw.mac.push({ mac, vlan, port, type: "dynamic" });
  }
}

function pingScene(S, fromId, toId){
  const A = HOSTS[fromId], B = HOSTS[toId];
  const trace = [];
  const frames = [];
  const scene = { name: "PC " + A.ip + " → " + B.ip, realSec: 3.2, frames, trace, traceTitle: "逐跳判读", verdict: null, drop: null };

  if(!sameSubnet(A.ip, B.ip, A.mask)){
    trace.push({ h: "① 源主机判路", p: "<b>" + A.ip + "/24</b> 与 <b>" + B.ip + "/24</b> 不在同一网段。", cls: "" });
    trace.push({ h: "② 查默认网关", p: "源主机默认网关为 <code>-</code>。没有网关就没有下一跳，ARP 不会发出，ICMP 在本机就被丢弃。", cls: "drop" });
    scene.verdict = { bad: true, text: "两台主机跨网段且都没有网关，报文在源主机就被丢弃。这不是交换机的问题。" };
    return scene;
  }

  const pA = S[A.sw].ports[A.port], pB = S[B.sw].ports[B.port];
  const vid = pA.pvid;

  /* ---- ① 源主机 → 本端交换机 ---- */
  frames.push({ route: hostRoute(A, "up"), t0: 0, t1: .12, kind: "broadcast" });
  trace.push({ h: "起点 · 源主机", p: "<b>" + A.ip + "</b> 与 <b>" + B.ip + "</b> 同网段，先发 ARP 请求（广播，目的 MAC ffff-ffff-ffff）。", cls: "" });

  trace.push({
    h: "① 入方向 · " + A.sw + " " + A.port,
    p: "端口类型 access，PVID <b>" + pA.pvid + "</b>；入帧无 tag → 打上 VLAN <b>" + vid + "</b> 标签。",
    cls: ""
  });
  learn(S, A.sw, A.port, A.mac, vid);

  /* ---- ② 本端交换机内转发 ---- */
  const sameSw = A.sw === B.sw;
  const trunkAllow = S[A.sw].ports[TRUNK].allow.indexOf(vid) >= 0;

  if(sameSw){
    frames.push({ route: "in" + (PORTS.indexOf(B.port) + 1), t0: .16, t1: .34, vlan: vid, kind: "broadcast" });
    frames.push({ route: hostRoute(B, "down"), t0: .38, t1: .56, kind: "broadcast" });
    trace.push({ h: "② 同交换机转发", p: "目的主机在本机，按 MAC 表 / 泛洪直接送到 " + B.port + "。", cls: "" });
  }else if(!trunkAllow){
    const inR = "in" + (PORTS.indexOf(A.port) + 1);
    frames.push({ route: inR, t0: .14, t1: .46, vlan: vid, kind: "broadcast" });
    scene.drop = { x: rjX(A.sw, PORTS.indexOf(A.port)), y: 166, at: .48, label: "NO EGRESS" };
    trace.push({
      h: "② 出方向 · 无出口",
      p: "VLAN <b>" + vid + "</b> 在 " + A.sw + " 上只有 " + A.port + " 一个成员：干道没放行，也没有别的 access 口。泛洪范围为空。",
      cls: "drop"
    });
    scene.verdict = { bad: true, text: "帧没有出口，在本端交换机就被丢弃。注意链路指示灯全绿——port link-type 还没做。" };
    return scene;
  }else{
    frames.push({ route: "in" + (PORTS.indexOf(A.port) + 1), t0: .14, t1: .26, vlan: vid, kind: "broadcast" });
    frames.push({ route: "trunk-r", t0: .28, t1: .52, tagged: true, vlan: vid, kind: "broadcast" });
    trace.push({
      h: "② 出方向 · 干道",
      p: "trunk " + TRUNK + " 的允许列表含 <b>" + vid + "</b>，帧带 802.1Q 标签上干道。",
      cls: ""
    });

    const backAllow = S[B.sw].ports[TRUNK].allow.indexOf(vid) >= 0;
    if(!backAllow){
      scene.drop = { route: "trunk-r", p: .985, at: .55, label: "DROP · " + B.sw + " 入方向" };
      trace.push({
        h: "③ 入方向 · " + B.sw + " " + TRUNK,
        p: "对端 trunk 允许列表为 <b>" + S[B.sw].ports[TRUNK].allow.join(", ") + "</b>，不含 " + vid + "。帧在入方向被丢弃。",
        cls: "drop"
      });
      scene.verdict = { bad: true, text: "帧跑完整条干道才被丢。现象是「一端通、另一端不通」，但链路指示灯全绿——只能靠 display port vlan 查允许列表。" };
      return scene;
    }

    frames.push({ route: "out" + (PORTS.indexOf(B.port) + 1), t0: .56, t1: .70, vlan: vid, kind: "broadcast" });
    trace.push({ h: "③ 入方向 · " + B.sw, p: "允许列表含 " + vid + "，去标签后在 VLAN " + vid + " 内泛洪。", cls: "" });
    frames.push({ route: hostRoute(B, "down"), t0: .72, t1: .86, kind: "broadcast" });
    learn(S, B.sw, B.port, B.mac, vid);
  }

  /* ---- ③ ARP 应答回程 ---- */
  if(!scene.drop){
    frames.push({ route: hostRoute(B, "up"), t0: .88, t1: .94, kind: "unicast" });
    frames.push({ route: hostRoute(A, "down"), t0: .94, t1: 1, kind: "unicast" });
    trace.push({ h: "④ 回程", p: "目的主机回复 ARP 应答，路径与去程对称。两端 MAC 表各学一条表项。", cls: "pass" });
    trace[trace.length - 1].cls = "pass";
    scene.verdict = { bad: false, text: "同 VLAN 且两端干道都放行，二层可达。ICMP 随后可以正常往返。" };
  }
  return scene;
}

/* ---------------- 引导 ---------------- */
const GOAL = {
  vlans: [10, 20],
  access: [{ port: "GE0/0/1", vid: 10 }, { port: "GE0/0/2", vid: 20 }],
  trunk: { port: TRUNK, allow: [10, 20] }
};

function devMissingVlans(S, dev){
  return GOAL.vlans.filter(v => !S[dev].vlans[v]);
}
function trunkMissing(S, dev){
  const t = S[dev].ports[GOAL.trunk.port];
  return GOAL.trunk.allow.filter(v => t.allow.indexOf(v) < 0);
}
function devTodo(S, dev){
  let n = devMissingVlans(S, dev).length;
  GOAL.access.forEach(function(a){
    const p = S[dev].ports[a.port];
    if(!p || p.type !== "access" || p.pvid !== a.vid) n++;
  });
  const t = S[dev].ports[GOAL.trunk.port];
  if(!t || t.type !== "trunk" || trunkMissing(S, dev).length) n++;
  return n;
}

function guide(S, ctx){
  const dev = ctx.dev, sw = S[dev], peer = dev === "SW1" ? "SW2" : "SW1";
  const G = (phase, why, cmd) => ({ phase, why, cmd: cmd || "" });

  if(ctx.view === "if"){
    const pn = ifPort(ctx), p = sw.ports[pn];
    if(!p) return G("enter", "端口不存在，quit 退回系统视图。", "quit");
    const acc = GOAL.access.find(a => a.port === pn);
    if(acc){
      if(p.type !== "access")
        return G("access", pn + " 现在是 " + p.type + " 口。port default vlan 只对 access 生效，先改类型。", "port link-type access");
      if(p.pvid !== acc.vid)
        return G("access", "类型对了。这一步把 PVID 从 " + p.pvid + " 改成 " + acc.vid + "，从该口进来的无标签帧才会归进 VLAN " + acc.vid + "。", "port default vlan " + acc.vid);
      return G("access", pn + " 已完成（access / VLAN " + acc.vid + "）。quit 退出，换下一个端口。", "quit");
    }
    if(pn === GOAL.trunk.port){
      if(p.type !== "trunk")
        return G("trunk", "干道口要先改成 trunk。access 口会把带标签的帧当非法帧处理，两个 VLAN 都过不去。", "port link-type trunk");
      const miss = trunkMissing(S, dev);
      if(miss.length)
        return G("trunk", "允许列表现在是 " + p.allow.join(",") + "，少了 VLAN " + miss.join("、") + "。列表外的 VLAN 在入方向就被丢，而链路指示灯不会变。", "port trunk allow-pass vlan " + GOAL.trunk.allow.join(" "));
      return G("trunk", "干道已放行 10、20。别忘了对端交换机也要配同样的允许列表。", "quit");
    }
    return G("access", "这个口不在本实验的规划里，quit 退出去做正事。", "quit");
  }

  if(ctx.view === "system"){
    const mv = devMissingVlans(S, dev);
    if(mv.length) return G("vlan", "VLAN 表里还没有 " + mv.join("、") + "。先把表建出来，端口才有地方可划。", "vlan batch " + mv.join(" "));
    const a2 = GOAL.access.find(function(a){
      const p = sw.ports[a.port];
      return p.type !== "access" || p.pvid !== a.vid;
    });
    if(a2) return G("access", "VLAN 有了。接下来把 " + a2.port + " 划进 VLAN " + a2.vid + " —— 端口属性要在接口视图里改。", "interface GigabitEthernet " + a2.port.slice(2));
    const tp = sw.ports[GOAL.trunk.port];
    if(tp.type !== "trunk")
      return G("trunk", "接入侧配完了。最后配 " + GOAL.trunk.port + " 这条两台交换机之间的干道。", "interface GigabitEthernet " + GOAL.trunk.port.slice(2));
    const missT = trunkMissing(S, dev);
    if(missT.length)
      return G("trunk", "干道已经是 trunk，但允许列表少了 VLAN " + missT.join("、") + "（当前放行 " + tp.allow.join(",") + "）。", "interface GigabitEthernet " + GOAL.trunk.port.slice(2));
    return G("verify", "本机配置已完整。用 display port vlan 按端口核对 PVID 与允许列表。", "display port vlan");
  }

  if(devTodo(S, dev) > 0) return G("enter", "<" + dev + "> 是用户视图，只能看不能改。改配置前先 system-view。", "system-view");
  if(devTodo(S, peer) > 0) return G("peer", dev + " 已配完。" + peer + " 还是出厂配置——点命令层右上角的 " + peer + " 标签切过去继续。", "");
  return G("verify", "两台都配完了。先 display port vlan 自查，再点右下角 PC1 → PC3 看数据面。", "display port vlan");
}

/* ---------------- 板块 ---------------- */
function ok(cond, s){ return !!cond; }

const steps = [
  {
    id: 1, name: "基线观察", key: false,
    run: api => api.run(["display vlan", "display mac-address"]),
    summary: "所有端口都在 VLAN 1，MAC 表为空",
    detail: [{ h: "看到什么", p: "四个 access 口 PVID 全是 1，VLAN 表只有 default。<b>此时任何两台 PC 都能通</b>——因为都在同一个广播域里。" }]
  },
  {
    id: 2, name: "建 VLAN", key: false,
    done: S => S.SW1.vlans[10] && S.SW1.vlans[20],
    run: api => { api.setDev("SW1"); return api.run(["system-view", "vlan batch 10 20"]); },
    summary: "SW1 的 VLAN 表新增 10、20",
    detail: [
      { h: "表项变化", p: "VLAN 表从 1 行变成 3 行。此时<b>没有任何端口属于 10 / 20</b>，转发行为一点没变。" },
      { h: "为什么先建表", p: "端口划 VLAN 时会校验 VLAN 是否存在；不建表直接 port default vlan 10 会报 The VLAN does not exist。" }
    ]
  },
  {
    id: 3, name: "SW1 GE0/0/1", key: false,
    done: S => S.SW1.ports["GE0/0/1"].pvid === 10 && S.SW1.ports["GE0/0/1"].type === "access",
    run: api => { api.setDev("SW1"); return api.run(["system-view", "interface GigabitEthernet 0/0/1", "port link-type access", "port default vlan 10"]); },
    summary: "PC1 所在端口划入 VLAN 10",
    detail: [{ h: "PVID 表", p: "GE0/0/1 的 PVID 从 1 变成 <b>10</b>。此后从该口进来的无标签帧一律归 VLAN 10，出去的帧去掉标签。" }]
  },
  {
    id: 4, name: "SW1 GE0/0/2", key: false,
    done: S => S.SW1.ports["GE0/0/2"].pvid === 20 && S.SW1.ports["GE0/0/2"].type === "access",
    run: api => { api.setDev("SW1"); return api.run(["system-view", "interface GigabitEthernet 0/0/2", "port link-type access", "port default vlan 20"]); },
    summary: "PC2 所在端口划入 VLAN 20",
    detail: [{ h: "广播域被切开", p: "GE0/0/1 与 GE0/0/2 现在属于不同 VLAN，即使同一台交换机，二层也互不相通。" }]
  },
  {
    id: 5, name: "SW2 GE0/0/1", key: false,
    done: S => S.SW2.vlans[10] && S.SW2.ports["GE0/0/1"].pvid === 10,
    run: api => { api.setDev("SW2"); return api.run(["system-view", "vlan batch 10 20", "interface GigabitEthernet 0/0/1", "port link-type access", "port default vlan 10"]); },
    summary: "SW2 建表并把 PC3 端口划入 VLAN 10",
    detail: [{ h: "VLAN 是本地概念", p: "VLAN 10 在 SW1 上存在不代表 SW2 上存在——每台设备各有一张 VLAN 表，必须分别建。" }]
  },
  {
    id: 6, name: "SW2 GE0/0/2", key: false,
    done: S => S.SW2.ports["GE0/0/2"].pvid === 20 && S.SW2.ports["GE0/0/2"].type === "access",
    run: api => { api.setDev("SW2"); return api.run(["system-view", "interface GigabitEthernet 0/0/2", "port link-type access", "port default vlan 20"]); },
    summary: "PC4 所在端口划入 VLAN 20",
    detail: [{ h: "现在两边都划好了", p: "同 VLAN 的 PC 在同一台交换机内可以通，跨交换机还不通——中间那条链路还是 access VLAN 1。" }]
  },
  {
    id: 7, name: "测试 · 应该是失败", key: true, keepTrace: true,
    run: api => { api.play(pingScene(api.S, "PC1", "PC3")); },
    summary: "PC1 → PC3 不通，帧在 SW1 就没有出口",
    detail: [{ h: "反直觉的点", p: "VLAN 建好了、端口划好了，<b>反而更不通</b>：原来都在 VLAN 1 时可以通，切开之后中间链路只能承载 VLAN 1。" }]
  },
  {
    id: 8, name: "配 Trunk", key: false,
    done: S => {
      const a = S.SW1.ports[TRUNK], b = S.SW2.ports[TRUNK];
      return a.type === "trunk" && b.type === "trunk" && [10, 20].every(v => a.allow.includes(v) && b.allow.includes(v));
    },
    run: async api => {
      api.setDev("SW1");
      await api.run(["system-view", "interface GigabitEthernet 0/0/24", "port link-type trunk", "port trunk allow-pass vlan 10 20"]);
      api.setDev("SW2");
      await api.run(["system-view", "interface GigabitEthernet 0/0/24", "port link-type trunk", "port trunk allow-pass vlan 10 20"]);
    },
    summary: "两端干道都放行 VLAN 10、20",
    detail: [
      { h: "干道的作用", p: "一条物理链路承载多个 VLAN，靠 802.1Q 标签区分。允许列表决定<b>哪些 VLAN 的帧能进出</b>。" },
      { h: "必须两端都配", p: "只配一端，帧会在另一端入方向被丢，而且链路灯还是绿的。" }
    ]
  },
  {
    id: 9, name: "测试 · 应该成功", key: true, keepTrace: true,
    run: api => { api.play(pingScene(api.S, "PC1", "PC3")); },
    summary: "PC1 → PC3 通，帧带 VLAN 10 标签穿过干道",
    detail: [{ h: "看帧的形状", p: "干道上的帧多了一小块 <b>VLAN 10</b> 标记——这就是 802.1Q 标签。access 口的帧没有它。" }]
  },
  {
    id: 10, name: "扰动 · 收窄允许列表", key: true, keepTrace: true,
    run: async api => {
      api.setDev("SW2");
      await api.run(["system-view", "interface GigabitEthernet 0/0/24", "undo port trunk allow-pass vlan 20"]);
      api.play(pingScene(api.S, "PC2", "PC4"));
    },
    summary: "VLAN 20 断连，但链路指示灯全绿",
    detail: [{ h: "只能查表", p: "access 口 still up，干道 still up，灯全绿。<b>唯一能看出问题的地方是 trunk 允许列表</b>——display port vlan。" }]
  },
  {
    id: 11, name: "查看对照回显", key: false,
    run: api => { api.setDev("SW2"); return api.run(["display port vlan", "display vlan", "display mac-address"]); },
    summary: "核对 PVID 与允许列表",
    detail: [{ h: "排查顺序", p: "先 display port vlan 看允许列表 → 再 display vlan 看 VLAN 成员 → 最后 display mac-address 看有没有学到。" }]
  }
];

/* ---------------- 导出 ---------------- */
export default {
  id: "01",
  title: "VLAN 与 Trunk",
  meta: "HUAWEI S5700 · VRP V200R005C00",
  stageLabel: "L2 SWITCHING · 2 × S5700 · 4 × HOST",
  totalSteps: steps.length,
  devices: ["SW1", "SW2"],
  tabs: [
    { key: "vlan", label: "VLAN 表", hint: "VLAN 表" },
    { key: "port", label: "端口 PVID", hint: "端口 PVID 表" },
    { key: "mac", label: "MAC 地址表", hint: "MAC 地址表" },
    { key: "trunk", label: "Trunk 允许列表", hint: "Trunk 允许列表" }
  ],
  legend: [
    { c: "#38E1FF", label: "VLAN 10" },
    { c: "#FFB545", label: "VLAN 20" },
    { c: "#4A5A6E", label: "VLAN 1" },
    { c: "#35E08A", label: "▲ 新增" }
  ],
  phases: { enter: "进系统视图", vlan: "建 VLAN", access: "划端口", trunk: "配干道", verify: "校验", peer: "换设备" },
  viewName: VIEW_NAME,
  viewHint: VIEW_HINT,
  actions: [
    { id: "pc1pc3", label: "PC1 → PC3", run: l => l.playScene(pingScene(l.S, "PC1", "PC3")) },
    { id: "pc2pc4", label: "PC2 → PC4", run: l => l.playScene(pingScene(l.S, "PC2", "PC4")) },
    { id: "pc1pc4", label: "PC1 → PC4", run: l => l.playScene(pingScene(l.S, "PC1", "PC4")) }
  ],
  createState, prompt, commands, tables, topology, guide, steps,

  idle: {
    title: "判读顺序",
    items: [
      { h: "① 命令层", p: "命令解析后落到哪个对象：端口属性、VLAN 表项，还是 trunk 允许列表。" },
      { h: "② 机制层", p: "被改动的表项当场高亮，新旧值并列显示。" },
      { h: "③ 现象层", p: "再跑一次数据面，帧会按新表项重新计算路径；若被丢弃，给出具体丢弃点。" }
    ]
  },

  viewRows(ctx){
    return [
      { h: "<" + ctx.dev + "> 用户视图", p: "只读：display、ping。改配置的命令在这里一律被拒。", cls: ctx.view === "user" ? "pass" : "" },
      { h: "[" + ctx.dev + "] 系统视图", p: "全局入口：vlan batch、sysname、interface。", cls: ctx.view === "system" ? "pass" : "" },
      { h: "[" + ctx.dev + "-GE0/0/x] 接口视图", p: "作用域收窄到当前端口：link-type、PVID、allow-pass。", cls: ctx.view === "if" ? "pass" : "" }
    ];
  },

  boot(write, printGuide){
    write("Info: 已加载 SW1 / SW2 出厂配置，所有端口位于 VLAN 1。", "dim");
    write("      输入命令，或点击上方 S1…S11 按顺序执行实验步骤。", "dim");
    write("", "dim");
    printGuide();
  }
};

export { pingScene, HOSTS };
