import { pad } from "../lib/util.js";

/* =========================================================================
   实验 03 · 链路聚合 Eth-Trunk
   -------------------------------------------------------------------------
   与 lab-01 共用同一套运行时。这里只描述聚合组的行为：
     evaluate  → 成员口稳态判定（简化 LACP：收敛后的结果，不模拟逐 tick）
     rebalance → 按五元组哈希把 6 条流分配到 Selected 成员
   ========================================================================= */

const MEMBERS = ["GE0/0/1", "GE0/0/2", "GE0/0/3"];
const UP = "GE0/0/24";
const LK_Y = [79, 115, 151];
const LK_X1 = 366, LK_X2 = 1046;

const FLOWS = [
  { id: "F1", src: "10.1.1.10", dst: "10.2.2.20", sport: 51234, dport: 443, proto: "TCP", rate: 300 },
  { id: "F2", src: "10.1.1.11", dst: "10.2.2.21", sport: 51235, dport: 443, proto: "TCP", rate: 180 },
  { id: "F3", src: "10.1.1.12", dst: "10.2.2.22", sport: 51236, dport: 8080, proto: "TCP", rate: 240 },
  { id: "F4", src: "10.1.1.13", dst: "10.2.2.23", sport: 51237, dport: 22, proto: "TCP", rate: 90 },
  { id: "F5", src: "10.1.1.14", dst: "10.2.2.24", sport: 51238, dport: 53, proto: "UDP", rate: 60 },
  { id: "F6", src: "10.1.1.15", dst: "10.2.2.25", sport: 51239, dport: 3306, proto: "TCP", rate: 130 }
];

const COLORS = ["#38E1FF", "#35E08A", "#FFB545", "#A78BFA", "#F472B6", "#5EEAD4"];

function makeSwitch(name){
  const ports = {};
  MEMBERS.forEach(function(p){ ports[p] = { up: true, speed: 1000, state: "", reason: "", code: "" }; });
  ports[UP] = { up: true, speed: 1000, state: "", reason: "", code: "" };
  return {
    name: name,
    trunk: { exists: false, mode: "manual", members: [] },
    ports: ports,
    lacp: { rx: 0, tx: 0, bad: 0 }
  };
}

export function createState(){
  const S = { SW1: makeSwitch("SW1"), SW2: makeSwitch("SW2"), flows: {}, pktLoss: 0 };
  FLOWS.forEach(f => { S.flows[f.id] = -1; });
  S.SW1.ports[UP].code = "up";
  S.SW2.ports[UP].code = "up";
  return S;
}

/* ---------------- 判定与重分布 ---------------- */
function evaluate(S){
  ["SW1", "SW2"].forEach(function(dev){
    const sw = S[dev], peer = S[dev === "SW1" ? "SW2" : "SW1"];
    MEMBERS.forEach(function(pn){
      const p = sw.ports[pn], q = peer.ports[pn];
      const inTrunk = sw.trunk.members.indexOf(pn) >= 0;
      if(!p.up){ p.code = "down"; p.state = "Down"; p.reason = "物理链路 down，LACP 立刻把它从 Selected 摘除"; return; }
      if(!inTrunk){
        p.code = "idle";
        p.state = "Not in trunk";
        p.reason = "还没有加入 Eth-Trunk 1，这条链路按独立二层口跑 STP，两条被阻塞";
        return;
      }
      if(sw.trunk.mode !== "lacp-static"){
        p.code = "sel"; p.state = "Selected"; p.reason = "手工模式不协商，只要物理 up 就直接进转发";
        return;
      }
      if(p.speed !== q.speed){
        p.code = "uns"; p.state = "Unselect";
        p.reason = "本端 " + p.speed + "M / 对端 " + q.speed + "M，速率不一致，LACP 拒绝加入";
        return;
      }
      p.code = "sel"; p.state = "Selected";
      p.reason = "两端 up、同组、同模式、速率一致，LACP 协商通过";
    });
  });
  rebalance(S);
}

export function activeMembers(S){
  const t = S.SW1.trunk;
  if(!t.exists || t.members.length === 0) return [0];
  return t.members.map((pn, i) => i).filter(i => S.SW1.ports[t.members[i]].code === "sel");
}

function hashFlow(f, buckets){
  if(buckets <= 0) return -1;
  let h = 0x811c9dc5;
  const s = f.src + "|" + f.dst + "|" + f.sport + "|" + f.dport + "|" + f.proto;
  for(let i = 0; i < s.length; i++){
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  hashFlow.raw = h;
  return h % buckets;
}

function rebalance(S){
  const act = activeMembers(S);
  const t = S.SW1.trunk;
  FLOWS.forEach(function(f){
    if(!t.exists || act.length === 0){ S.flows[f.id] = -1; return; }
    const slot = hashFlow(f, act.length);
    S.flows[f.id] = slot < 0 ? -1 : act[slot];
  });
}

/* ---------------- 视图 ---------------- */
const VIEW_NAME = { user: "用户视图", system: "系统视图", trunk: "Eth-Trunk 视图", if: "接口视图" };
const VIEW_HINT = { system: "system-view", trunk: "interface eth-trunk 1", if: "interface GigabitEthernet 0/0/3" };

function prompt(ctx){
  if(ctx.view === "user") return "<" + ctx.dev + ">";
  if(ctx.view === "system") return "[" + ctx.dev + "]";
  if(ctx.view === "trunk") return "[" + ctx.dev + "-Eth-Trunk1]";
  return "[" + ctx.dev + "-GigabitEthernet" + ctx.ifName + "]";
}

/* ---------------- 命令 ---------------- */
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
      if(c.view === "if" || c.view === "trunk"){ c.view = "system"; c.ifName = ""; }
      else if(c.view === "system") c.view = "user";
      else api.say("Error: Unrecognized command found at '^' position.", "err");
    }
  },
  {
    id: "return", match: /^(return|ctrl\+z)$/, view: null, kind: "view", usage: "return",
    run(api){ api.ctx.view = "user"; api.ctx.ifName = ""; }
  },
  {
    id: "if-trunk", match: /^interface eth-trunk (\d+)$/i, view: "system", kind: "view",
    usage: "interface eth-trunk 1",
    run(api, m){
      if(m[1] !== "1"){ api.say("Error: The Eth-Trunk does not exist.", "err"); return; }
      api.ctx.view = "trunk"; api.ctx.ifName = "";
    }
  },
  {
    id: "mode", match: /^mode (lacp-static|manual load-balance|manual)$/, view: "trunk", kind: "config",
    usage: "mode lacp-static",
    explain: [
      { h: "改协商方式", p: "从手工模式切到 LACP：端口开始周期性发送 <b>LACPDU</b>，只有收到对端 LACPDU 且参数一致才会置 Selected。" },
      { h: "代价", p: "多了一个协商周期（默认 30s 慢周期），换来的是能发现对端错连、单通、速率不一致。" }
    ],
    run(api, m){
      const sw = api.S[api.ctx.dev], peer = api.S[api.ctx.dev === "SW1" ? "SW2" : "SW1"];
      const nm = m[1] === "lacp-static" ? "lacp-static" : "manual";
      const old = sw.trunk.mode;
      sw.trunk.exists = true; sw.trunk.mode = nm;
      peer.trunk.exists = true; peer.trunk.mode = nm;
      if(old !== nm) api.change("Eth-Trunk1.mode", old, nm, { row: "member-" + (sw.trunk.members[0] || "none") });
      api.say("// Eth-Trunk1 工作模式 " + old + " → " + nm, "op");
      evaluate(api.S);
    }
  },
  {
    id: "trunkport", match: /^trunkport (?:GigabitEthernet|GE)\s*([\d/]+)(?: to (?:GigabitEthernet|GE)?\s*([\d/]+))?$/i,
    view: "trunk", kind: "config", usage: "trunkport GigabitEthernet 0/0/1 to 0/0/3",
    explain: [
      { h: "加成员", p: "把物理口挂到 Eth-Trunk 下。此时端口不再是独立的二层口，而是聚合组的一个通道。" },
      { h: "关键", p: "<b>两端都要加</b>。只加一端，另一端仍按普通口处理，LACP 永远协商不起来。" }
    ],
    run(api, m){
      const sw = api.S[api.ctx.dev], peer = api.S[api.ctx.dev === "SW1" ? "SW2" : "SW1"];
      const from = m[1], to = m[2] || m[1];
      const a = parseInt(from.split("/")[2], 10), b = parseInt(to.split("/")[2], 10);
      const added = [];
      for(let i = a; i <= b; i++){
        const pn = "GE0/0/" + i;
        if(!sw.ports[pn]) continue;
        if(sw.trunk.members.indexOf(pn) < 0){ sw.trunk.members.push(pn); added.push(pn); }
        if(peer.trunk.members.indexOf(pn) < 0) peer.trunk.members.push(pn);
      }
      sw.trunk.exists = true; peer.trunk.exists = true;
      sw.trunk.members.sort(); peer.trunk.members.sort();
      api.say("Info: This operation may take a few seconds. Please wait for a moment...done.", "dim");
      if(added.length){
        api.change("Eth-Trunk1.members", (sw.trunk.members.length - added.length) + " 个", sw.trunk.members.length + " 个", { row: "member-" + added[0], kind: "enter" });
        api.say("// 加入成员：" + added.join("、") + "（两端同时加入）", "op");
        added.forEach(function(pn, i){
          const idx = MEMBERS.indexOf(pn);
          api.fx({ kind: "pulse", target: (i % 2 ? "SW2/" : "SW1/") + pn, color: "#38E1FF" });
          void idx;
        });
      }else{
        api.say("// 这些端口已经是成员，未重复加入。", "op");
      }
      evaluate(api.S);
    }
  },
  {
    id: "if-ge", match: /^interface (?:GigabitEthernet|GE)\s*([\d/]+)$/i, view: "system", kind: "view",
    usage: "interface GigabitEthernet 0/0/3",
    run(api, m){
      const key = "GE" + m[1];
      if(!api.S[api.ctx.dev].ports[key]){ api.say("Error: The port does not exist.", "err"); return; }
      api.ctx.view = "if"; api.ctx.ifName = m[1];
    }
  },
  {
    id: "eth-trunk", match: /^eth-trunk 1$/, view: "if", kind: "config", usage: "eth-trunk 1",
    explain: [{ h: "逐口加入", p: "与 trunkport 等价，只是逐个端口加。适合只改一个成员口的场景。" }],
    run(api){
      const sw = api.S[api.ctx.dev], peer = api.S[api.ctx.dev === "SW1" ? "SW2" : "SW1"];
      const pn = "GE" + api.ctx.ifName;
      if(sw.trunk.members.indexOf(pn) >= 0){ api.say("// " + pn + " 已经是成员。", "op"); return; }
      sw.trunk.members.push(pn);
      if(peer.trunk.members.indexOf(pn) < 0) peer.trunk.members.push(pn);
      sw.trunk.exists = true; peer.trunk.exists = true;
      sw.trunk.members.sort(); peer.trunk.members.sort();
      api.change(pn, "未加入", "Eth-Trunk1 成员", { row: "member-" + pn, kind: "enter" });
      api.say("// " + pn + " 已加入 Eth-Trunk1", "op");
      api.fx({ kind: "pulse", target: api.ctx.dev + "/" + pn, color: "#38E1FF" });
      evaluate(api.S);
    }
  },
  {
    id: "speed", match: /^speed (10|100|1000|auto)$/, view: "if", kind: "config", usage: "speed <100|1000>",
    explain: [
      { h: "改速率", p: "端口的物理协商速率变了。LACP 要求同一聚合组内所有成员速率、双工一致。" },
      { h: "现象", p: "该成员被置 Unselect，<b>不再参与转发</b>，但物理链路灯依然是亮的。" }
    ],
    run(api, m){
      const sw = api.S[api.ctx.dev], peer = api.S[api.ctx.dev === "SW1" ? "SW2" : "SW1"];
      const pn = "GE" + api.ctx.ifName;
      const p = sw.ports[pn], q = peer.ports[pn];
      const nv = m[1] === "auto" ? 1000 : parseInt(m[1], 10);
      if(p.speed === nv){ api.say("// " + pn + " 速率本来就是 " + nv + "M，命令未产生状态变化。", "op"); return; }
      const old = p.speed;
      p.speed = nv;
      api.change(pn + ".speed", old + "M", nv + "M", { row: "member-" + pn });
      api.say("// " + pn + " 速率 → " + nv + "M" + (nv !== q.speed ? "；与对端 " + q.speed + "M 不一致，LACP 将判定 Unselect" : ""), "op");
      if(nv !== q.speed) api.say("// 注意：一端改速率，另一端不会跟着变。真实设备上这是最常见的聚合失败原因。", "op");
      api.fx({ kind: "pulse", target: api.ctx.dev + "/" + pn, color: nv !== q.speed ? "#FF4D5E" : "#35E08A" });
      evaluate(api.S);
    }
  },

  /* ---- 只读 ---- */
  {
    id: "disp-trunk", match: /^display eth-trunk 1$/, view: null, kind: "doc", usage: "display eth-trunk 1",
    doc: "这张表回答：聚合组里有几个成员、每个成员是什么状态、有几个真正在转发。<b>Operate status 为 up 只代表至少有一个 Selected 成员</b>。",
    run(api){
      const sw = api.S[api.ctx.dev];
      if(!sw.trunk.exists){ api.say("Error: Eth-Trunk 1 does not exist.", "err"); return; }
      const act = sw.trunk.members.filter(pn => sw.ports[pn].code === "sel").length;
      api.say("Eth-Trunk1's state information is:");
      api.say("WorkingMode: " + pad(sw.trunk.mode === "lacp-static" ? "LACP" : "NORMAL", 24) + "Hash arithmetic: According to SIP-XOR-DIP");
      api.say("Least Active-linknumber: 1  " + pad("", 10) + "Max Bandwidth-affected-linknumber: 8");
      api.say("Operate status: " + pad(act > 0 ? "up" : "down", 14) + "Number Of Up Port In Trunk: " + act);
      api.say("--------------------------------------------------------------------------------", "dim");
      api.say(pad("PortName", 30) + pad("Status", 14) + "Weight", "dim");
      api.say("--------------------------------------------------------------------------------", "dim");
      sw.trunk.members.forEach(function(pn){
        api.say(pad("GigabitEthernet" + pn.slice(2), 30) + pad(sw.ports[pn].state, 14) + "1");
      });
      api.tab("member");
    }
  },
  {
    id: "disp-lacp", match: /^display lacp statistics eth-trunk 1$/, view: null, kind: "doc", usage: "display lacp statistics eth-trunk 1",
    doc: "收发计数在增长说明 LACPDU 在正常交互；<b>只增不收</b>通常意味着对端没配 LACP，或者中间链路是单向的。",
    run(api){
      const sw = api.S[api.ctx.dev];
      if(sw.trunk.mode !== "lacp-static"){ api.say("Error: The Eth-Trunk is not in LACP mode.", "err"); return; }
      api.say("Eth-Trunk1's LACP statistics information is:");
      api.say("--------------------------------------------------------------------------------", "dim");
      api.say(pad("PortName", 26) + pad("LacpPacketReceived", 20) + pad("LacpPacketSent", 16) + "LacpReceivedBad", "dim");
      api.say("--------------------------------------------------------------------------------", "dim");
      MEMBERS.forEach(function(pn){
        const joined = sw.trunk.members.indexOf(pn) >= 0;
        api.say(pad("GigabitEthernet" + pn.slice(2), 26) + pad(joined ? sw.lacp.rx : 0, 20) + pad(joined ? sw.lacp.tx : 0, 16) + (joined ? sw.lacp.bad : 0));
      });
      api.tab("lacp");
    }
  },
  {
    id: "disp-brief", match: /^display interface brief$/, view: null, kind: "doc", usage: "display interface brief",
    doc: "Eth-Trunk1 是逻辑口，成员口是物理口。排查时先看逻辑口 up/down，再逐个看成员口。",
    run(api){
      const sw = api.S[api.ctx.dev];
      api.lines(["PHY: Physical", "*down: administratively down", "(l): loopback", "(s): spoofing", ""], "dim");
      api.say(pad("Interface", 26) + pad("PHY", 8) + pad("Protocol", 10) + pad("InUti", 8) + "OutUti", "dim");
      api.say("--------------------------------------------------------------------------------", "dim");
      if(sw.trunk.exists){
        const act = sw.trunk.members.filter(pn => sw.ports[pn].code === "sel").length;
        api.say(pad("Eth-Trunk1", 26) + pad(act ? "up" : "down", 8) + pad(act ? "up" : "down", 10) + pad(act ? "12%" : "0%", 8) + pad(act ? "12%" : "0%", 8));
      }
      MEMBERS.concat([UP]).forEach(function(pn){
        const p = sw.ports[pn];
        api.say(pad("GigabitEthernet" + pn.slice(2), 26) + pad(p.up ? "up" : "*down", 8) + pad(p.up ? "up" : "down", 10) +
          pad(p.up ? "8%" : "0%", 8) + pad(p.up ? "8%" : "0%", 8));
      });
    }
  },
  {
    id: "disp-if-trunk", match: /^display interface eth-trunk 1$/, view: null, kind: "doc", usage: "display interface eth-trunk 1",
    doc: "逻辑口的详细状态。Operate status 为 UP 不代表每条成员链路都在转发。",
    run(api){
      const sw = api.S[api.ctx.dev];
      if(!sw.trunk.exists){ api.say("Error: Eth-Trunk 1 does not exist.", "err"); return; }
      const act = sw.trunk.members.filter(pn => sw.ports[pn].code === "sel").length;
      api.say("Eth-Trunk1 current state : " + (act ? "UP" : "DOWN"));
      api.say("Line protocol current state : " + (act ? "UP" : "DOWN"));
      api.say("Switch Port, PVID :    1, TPID : 8100(Hex), Hash arithmetic : SIP-XOR-DIP", "dim");
      api.say("Maximum Transmit Unit is 1500", "dim");
    }
  }
];

/* ---------------- 表项 ---------------- */
function tables(S, tab, ctx){
  const sw = S[ctx.dev];
  if(tab === "member"){
    const rows = MEMBERS.map(function(pn){
      const p = sw.ports[pn];
      const inTrunk = sw.trunk.members.indexOf(pn) >= 0;
      return {
        key: "member-" + pn,
        cells: [
          { t: pn, cls: "c" },
          { t: p.up ? "up" : "down", cls: p.up ? "c" : "" },
          { t: inTrunk ? "是" : "否", cls: "c" },
          { t: p.state || "—", cls: p.code === "sel" ? "v10" : p.code === "uns" ? "v20" : "" },
          { t: p.reason || "—", cls: "c" }
        ],
        cls: p.code === "uns" ? "warn-row" : (p.code === "down" ? "bad-row" : "")
      };
    });
    return { head: ["MEMBER", "PHY", "IN TRUNK", "STATE", "判定原因"], rows };
  }
  if(tab === "lacp"){
    const rows = MEMBERS.map(function(pn){
      const joined = sw.trunk.members.indexOf(pn) >= 0;
      return {
        key: "lacp-" + pn,
        cells: [
          { t: pn, cls: "c" },
          { t: joined ? sw.lacp.rx : 0, cls: "c" },
          { t: joined ? sw.lacp.tx : 0, cls: "c" },
          { t: joined ? sw.lacp.bad : 0, cls: "c" }
        ]
      };
    });
    return { head: ["MEMBER", "RX", "TX", "BAD"], rows };
  }
  /* hash */
  const act = activeMembers(S);
  const rows = FLOWS.map(function(f){
    const slot = S.flows[f.id];
    const pn = slot >= 0 ? MEMBERS[slot] : "—";
    return {
      key: "flow-" + f.id,
      cells: [
        { t: f.id, cls: "c" },
        { t: f.src + " → " + f.dst + " : " + f.dport, cls: "c" },
        { t: f.rate + " Mbps", cls: "c" },
        { t: slot >= 0 ? "桶 " + slot + " / " + act.length : "无出口", cls: slot >= 0 ? "v10" : "" },
        { t: pn, cls: "c" }
      ]
    };
  });
  return {
    head: ["FLOW", "五元组", "速率", "哈希落点", "成员口"],
    rows,
    note: "简化模型：真实设备用 SIP-XOR-DIP 芯片哈希，这里用 FNV-1a 折叠五元组。分布不均是真实现象，不是 bug。"
  };
}

/* ---------------- 拓扑 ---------------- */
function topology(S, ui, ctx){
  const devices = ["SW1", "SW2"].map(function(id){
    const mirror = id === "SW2";
    const sw = S[id];
    const ports = [];
    MEMBERS.forEach(function(pn, i){
      const p = sw.ports[pn];
      const col = p.code === "sel" ? "#38E1FF" : p.code === "uns" ? "#FFB545" : p.code === "down" ? "#FF4D5E" : "#7E93AB";
      ports.push({
        name: pn, kind: "sfp",
        x: mirror ? 6 : 254, y: 20 + i * 36,
        color: col, up: p.up, label: pn.slice(-1)
      });
    });
    ports.push({
      name: UP, kind: "rj45",
      x: mirror ? 268 : 34, y: 92,
      color: sw.ports[UP].up ? "#35E08A" : "#7E93AB", up: sw.ports[UP].up, label: "24"
    });
    return {
      id: id, x: id === "SW1" ? 70 : 1040, y: 50, w: 300, h: 120, model: "S5700-28C-EI",
      silk: "M12 24 h60 M12 28 h44",
      leds: [
        { x: 272, y: 12, color: "#35E08A", glow: true, label: "PWR", tx: 278, ty: 14.5 },
        { x: 258, y: 12, color: "#38E1FF", glow: true, label: "SYS", tx: 232, ty: 14.5 }
      ],
      ports: ports,
      tags: [
        { x: 0, y: -8, text: id, cls: "dev-label" },
        { x: 34, y: -8, text: sw.trunk.exists ? "Eth-Trunk 1 · " + (sw.trunk.mode === "lacp-static" ? "LACP" : "Manual") : "未聚合 · STP", cls: "dev-sub" }
      ]
    };
  });

  /* 成员链路：只有 Selected 才真的在转发，Unselect / 断线 = 没有流量 */
  const links = MEMBERS.map(function(pn, i){
    const p = S.SW1.ports[pn];
    return {
      id: "lk" + i,
      d: "M" + LK_X1 + " " + LK_Y[i] + " L" + LK_X2 + " " + LK_Y[i],
      cls: p.code === "sel" ? "trunk on" : (p.up ? "" : "down"),
      flow: p.code === "sel" ? 1 : 0,
      flowColor: "56,225,255"
    };
  });
  links.push({ id: "lk-up1", d: "M104 170 L104 210", cls: "", flow: S.SW1.ports[UP].up ? 0.42 : 0, flowColor: "53,224,138" });
  links.push({ id: "lk-up2", d: "M1308 170 L1308 210", cls: "", flow: S.SW2.ports[UP].up ? 0.42 : 0, flowColor: "53,224,138" });

  const hosts = [
    { id: "PC1", x: 104, y: 214, ip: "10.1.1.10", mac: "5489-98c1-0001", vlan: 1, color: "#35E08A", up: true },
    { id: "PC2", x: 1308, y: 214, ip: "10.2.2.20", mac: "5489-98c1-0002", vlan: 1, color: "#35E08A", up: true }
  ];

  const labels = [];
  MEMBERS.forEach(function(pn, i){
    const p = S.SW1.ports[pn];
    const cls = p.code === "sel" ? "lk-tag on" : p.code === "uns" ? "lk-tag warn" : p.code === "down" ? "lk-tag bad" : "lk-tag";
    const txt = p.code === "sel" ? "SELECTED" : p.code === "uns" ? "UNSELECT" : p.code === "down" ? "LINK DOWN" : (S.SW1.trunk.exists ? "NOT IN TRUNK" : "STP BLOCKING");
    labels.push({ text: pn, x: LK_X1 + 16, y: LK_Y[i] - 7, anchor: "start", cls: cls });
    labels.push({ text: pn, x: LK_X2 - 16, y: LK_Y[i] - 7, anchor: "end", cls: cls });
    labels.push({ text: txt, x: (LK_X1 + LK_X2) / 2, y: LK_Y[i] - 7, anchor: "middle", cls: cls });
  });

  const routes = {
    "pc1-up": "M104 210 L104 170",
    "pc2-up": "M1308 210 L1308 170",
    "lk0-r": "M" + LK_X1 + " " + LK_Y[0] + " L" + LK_X2 + " " + LK_Y[0],
    "lk1-r": "M" + LK_X1 + " " + LK_Y[1] + " L" + LK_X2 + " " + LK_Y[1],
    "lk2-r": "M" + LK_X1 + " " + LK_Y[2] + " L" + LK_X2 + " " + LK_Y[2],
    "lk0-l": "M" + LK_X2 + " " + LK_Y[0] + " L" + LK_X1 + " " + LK_Y[0],
    "lk1-l": "M" + LK_X2 + " " + LK_Y[1] + " L" + LK_X1 + " " + LK_Y[1],
    "lk2-l": "M" + LK_X2 + " " + LK_Y[2] + " L" + LK_X1 + " " + LK_Y[2]
  };

  const anchors = {};
  MEMBERS.forEach(function(pn, i){
    anchors["SW1/" + pn] = [70 + 254 + 20, 50 + 20 + i * 36 + 9];
    anchors["SW2/" + pn] = [1040 + 6 + 20, 50 + 20 + i * 36 + 9];
  });
  anchors["SW1/" + UP] = [70 + 34, 50 + 92];
  anchors["SW2/" + UP] = [1040 + 268, 50 + 92];

  return { viewBox: "0 0 1400 300", devices, hosts, links, routes, anchors, labels };
}

/* ---------------- 场景 ---------------- */
function sceneTraffic(S){
  const frames = [];
  FLOWS.forEach(function(f, fi){
    const slot = S.flows[f.id];
    const color = COLORS[fi % COLORS.length];
    if(slot >= 0){
      for(let k = 0; k < 3; k++){
        const t0 = 0.05 + k * 0.16 + fi * 0.02;
        frames.push({ route: "lk" + slot + "-r", t0: t0, t1: t0 + 0.12, kind: "data", color: color, vlan: f.id.slice(1) });
      }
      frames.push({ route: "pc1-up", t0: 0, t1: 0.05, kind: "data", color: color, vlan: "" });
    }
  });
  return {
    name: "6 条流按五元组哈希分流",
    realSec: 3.4,
    frames,
    traceTitle: "哈希分流",
    trace: [
      { h: "① 为什么需要哈希", p: "聚合后的逻辑口是一个，但报文必须落到某一个物理成员口。<b>同一条流必须始终走同一个口</b>，否则会乱序。", cls: "" },
      { h: "② 散列什么", p: "源 IP、目的 IP、源端口、目的端口、协议号五元组。任一项不同就是另一条流，可以走别的成员。", cls: "" },
      { h: "③ 结果", p: "6 条流落到 " + activeMembers(S).length + " 个成员口上。分得匀不匀取决于哈希函数，<b>真实网络里经常不匀</b>。", cls: "pass" }
    ],
    verdict: { bad: false, text: "单条流的上限仍然是 1 Gbps。聚合放大的是总吞吐，不是单流带宽。" }
  };
}

function sceneNegotiate(S){
  const frames = [];
  MEMBERS.forEach(function(pn, i){
    const sel = S.SW1.ports[pn].code === "sel";
    frames.push({ route: "lk" + i + "-r", t0: 0.02 + i * 0.05, t1: 0.28 + i * 0.05, kind: "data", color: "#FFB545", vlan: "" });
    frames.push({ route: "lk" + i + "-l", t0: 0.34 + i * 0.05, t1: 0.60 + i * 0.05, kind: "data", color: sel ? "#35E08A" : "#FF4D5E", vlan: "" });
  });
  return {
    name: "LACPDU 交互 · 三段握手",
    realSec: 3.2,
    frames,
    traceTitle: "LACPDU 交互",
    trace: [
      { h: "① 本端发 LACPDU", p: "聚合组内每个成员口周期性发送 LACPDU，带上自己的系统优先级、端口优先级与 key。", cls: "" },
      { h: "② 对端回 LACPDU", p: "对端把收到的信息与自己的比对：系统优先级、key、端口速率/双工、VLAN 必须一致。", cls: "" },
      { h: "③ 置 Selected", p: "两边都认为可以聚合，成员进入 Selected，开始承载流量。不一致的那条停在 Unselect。", cls: "pass" }
    ],
    verdict: { bad: S.SW1.trunk.members.some(pn => S.SW1.ports[pn].code !== "sel"), text: "LACPDU 是慢协议：长周期 30s、短周期 1s。动画把周期压缩了，真实环境从插线到 Selected 通常要几秒到半分钟。" }
  };
}

/* ---------------- 引导 ---------------- */
const GOAL = { mode: "lacp-static", members: MEMBERS, speed: 1000 };

function missingMembers(S, dev){
  const t = S[dev].trunk;
  return GOAL.members.filter(pn => t.members.indexOf(pn) < 0);
}
function badSpeed(S, dev){
  const sw = S[dev];
  for(const pn of GOAL.members){
    if(sw.trunk.members.indexOf(pn) >= 0 && sw.ports[pn].speed !== GOAL.speed) return pn;
  }
  return null;
}
function devTodo(S, dev){
  const t = S[dev].trunk;
  let n = 0;
  if(!t.exists || t.mode !== GOAL.mode) n++;
  n += missingMembers(S, dev).length;
  if(badSpeed(S, dev)) n++;
  return n;
}

function guide(S, ctx){
  const dev = ctx.dev, sw = S[dev], t = sw.trunk;
  const G = (phase, why, cmd) => ({ phase, why, cmd: cmd || "" });

  if(ctx.view === "trunk"){
    if(!t.exists || t.mode !== GOAL.mode)
      return G("mode", "手工模式两端不做任何协商，只能靠人为保证参数一致。切到 LACP 后才有 LACPDU 交互。", "mode lacp-static");
    const mm = missingMembers(S, dev);
    if(mm.length) return G("member", "聚合组还是空的，把三条物理链路挂进来。一条命令可以带区间，不用敲三遍。", "trunkport GigabitEthernet 0/0/1 to 0/0/3");
    return G("verify", "三条成员都已加入。quit 出去用 display eth-trunk 1 看每个成员的 Selected 状态。", "quit");
  }

  if(ctx.view === "if"){
    const pn = "GE" + ctx.ifName, p = sw.ports[pn];
    if(!p) return G("enter", "端口不存在，quit 退出去。", "quit");
    if(p.speed !== GOAL.speed)
      return G("speed", pn + " 现在是 " + p.speed + "M，组内其它成员是 " + GOAL.speed + "M。LACP 要求速率一致，否则这个口会被置 Unselect。", "speed " + GOAL.speed);
    if(t.members.indexOf(pn) < 0)
      return G("member", pn + " 还没进聚合组。在接口视图下用 eth-trunk 1 把它挂进去。", "eth-trunk 1");
    return G("member", pn + " 已是成员且参数一致。quit 退出，回到聚合组视图继续。", "quit");
  }

  if(ctx.view === "system"){
    if(!t.exists || t.mode !== GOAL.mode)
      return G("group", "先把逻辑接口建出来 —— Eth-Trunk 1 是聚合组本体，成员口挂在它下面。", "interface eth-trunk 1");
    if(missingMembers(S, dev).length)
      return G("member", "聚合组有了但还没成员。进 Eth-Trunk 视图批量加入物理口。", "interface eth-trunk 1");
    const bs = badSpeed(S, dev);
    if(bs) return G("speed", bs + " 的速率与组内其它成员不一致。LACP 要求一致，否则这个口亮灯但不转发。", "interface GigabitEthernet " + bs.slice(2));
    return G("verify", "本机配置已完整。用 display eth-trunk 1 核对成员状态与 Operate status。", "display eth-trunk 1");
  }

  if(devTodo(S, dev) > 0) return G("enter", "<" + dev + "> 是用户视图，只能看不能改。改配置前先 system-view。", "system-view");
  return G("verify", "配置已完整。先 display eth-trunk 1 看成员状态，再点右侧按钮跑流量看哈希分布。", "display eth-trunk 1");
}

/* ---------------- 板块 ---------------- */
const allSel = S => MEMBERS.every(pn => S.SW1.ports[pn].code === "sel");

const steps = [
  {
    id: 1, name: "基线 · 未聚合", key: false,
    run: api => api.run(["system-view", "display interface brief", "quit"]),
    summary: "三条链路各自为政，只有 1 Gbps 可用",
    detail: [{ h: "为什么只有 1 Gbps", p: "三条物理链路此时是三个独立的二层通道，同时转发会成环，<b>STP 必须阻塞其中两条</b>。被阻塞的链路通电、亮灯、一个包也不转。" }]
  },
  {
    id: 2, name: "建聚合组", key: false,
    done: S => S.SW1.trunk.exists && S.SW1.trunk.mode === "lacp-static",
    run: async api => { api.setDev("SW1"); await api.run(["system-view", "interface eth-trunk 1", "mode lacp-static"]); },
    summary: "Eth-Trunk 1 建立，工作模式 LACP",
    detail: [{ h: "逻辑口", p: "Eth-Trunk 1 是一个新的逻辑接口。成员口的二层属性会被它覆盖，VLAN / IP 都配在它上面。" }]
  },
  {
    id: 3, name: "加成员口", key: false,
    done: S => S.SW1.trunk.members.length === 3,
    run: async api => { api.setDev("SW1"); await api.run(["system-view", "interface eth-trunk 1", "trunkport GigabitEthernet 0/0/1 to 0/0/3"]); },
    summary: "三条成员全部加入，两端同时生效",
    detail: [{ h: "从 1 到 3", p: "带宽从 1 Gbps 变成 3 Gbps，但<b>单条流仍然只能走一个成员口</b>，最多 1 Gbps。" }]
  },
  {
    id: 4, name: "LACP 协商", key: true, keepTrace: true,
    run: api => { api.S.SW1.lacp.rx += 12; api.S.SW1.lacp.tx += 13; api.play(sceneNegotiate(api.S)); },
    summary: "三条成员全部 Selected",
    detail: [{ h: "看帧的往返", p: "黄色是 LACPDU 出去，绿色是协商成功的回程。红色表示参数不一致、被置 Unselect。" }]
  },
  {
    id: 5, name: "看成员表", key: false,
    run: api => api.run(["system-view", "display eth-trunk 1", "display lacp statistics eth-trunk 1"]),
    summary: "成员状态与 LACPDU 收发计数",
    detail: [{ h: "只增不收", p: "如果 RX 一直是 0，说明对端没配 LACP 或链路单向。这是最容易被忽略的故障形态。" }]
  },
  {
    id: 6, name: "哈希分流", key: true, keepTrace: true,
    run: api => api.play(sceneTraffic(api.S)),
    summary: "6 条流按五元组落到三个成员口",
    detail: [{ h: "分布不均", p: "哈希是固定的，6 条流不可能绝对均分。真实网络里这条规律导致「聚合了但带宽没上去」。" }]
  },
  {
    id: 7, name: "扰动 · 拔线", key: true, keepTrace: true,
    run: api => { pull(api); },
    summary: "拔掉 GE0/0/2，桶数从 3 变 2",
    detail: [{ h: "为什么丢包", p: "桶数变了，所有流的落点重算。原先走这条链路的流必须换口，换口瞬间会丢包——<b>聚合不是无损的</b>。" }]
  },
  {
    id: 8, name: "恢复链路", key: false,
    run: api => { plug(api); },
    summary: "插回 GE0/0/2，重新协商",
    detail: [{ h: "再迁移一次", p: "频繁闪断对业务的伤害比单纯带宽下降更大。" }]
  },
  {
    id: 9, name: "扰动 · 速率不一致", key: true,
    done: S => S.SW1.ports["GE0/0/3"].speed !== 1000,
    run: async api => { api.setDev("SW1"); await api.run(["system-view", "interface GigabitEthernet 0/0/3", "speed 100"]); },
    summary: "GE0/0/3 被置 Unselect，但链路灯还亮着",
    detail: [{ h: "现场最常见的聚合故障", p: "换了一根千兆线但光模块是百兆，或者两端自协商出不同速率。<b>物理 up、LACP Unselect</b>，这个成员一个包也不转。" }]
  },
  {
    id: 10, name: "恢复速率", key: false,
    done: S => S.SW1.ports["GE0/0/3"].speed === 1000,
    run: async api => { api.setDev("SW1"); await api.run(["system-view", "interface GigabitEthernet 0/0/3", "speed 1000"]); },
    summary: "速率恢复一致，成员重新 Selected",
    detail: [{ h: "注意方向", p: "只改一端不会同步到对端。真实排障要两端都看。" }]
  },
  {
    id: 11, name: "LACP 统计", key: false,
    run: api => api.run(["system-view", "display lacp statistics eth-trunk 1"]),
    summary: "三个成员都在正常收发 LACPDU",
    detail: [{ h: "判读", p: "RX / TX 都在增长且 BAD 为 0，说明协商健康。" }]
  },
  {
    id: 12, name: "收尾对照", key: false,
    run: api => api.run(["system-view", "display eth-trunk 1", "display interface eth-trunk 1", "display interface brief"]),
    summary: "逻辑口与成员口对照",
    detail: [{ h: "两层视角", p: "Eth-Trunk1 是逻辑口（up/down），成员口是物理口（Selected/Unselect）。排障永远先看逻辑再拆物理。" }]
  }
];

function pull(api){
  const pn = "GE0/0/2";
  api.S.SW1.ports[pn].up = false;
  api.S.SW2.ports[pn].up = false;
  const before = Object.assign({}, api.S.flows);
  evaluate(api.S);
  const moved = FLOWS.filter(f => before[f.id] !== api.S.flows[f.id]);
  const lost = FLOWS.filter(f => before[f.id] === 1).reduce((a, f) => a + f.rate, 0);
  api.S.pktLoss += Math.round(lost * 1000 * 0.2 / 8 / 1000);
  api.fx({ kind: "pulse", target: "SW1/" + pn, color: "#FF4D5E" });
  api.play({
    name: "拔掉 " + pn + " · 流量重分布",
    realSec: 3.2,
    frames: FLOWS.filter(f => api.S.flows[f.id] >= 0).map(function(f, i){
      const t0 = 0.1 + i * 0.09;
      return { route: "lk" + api.S.flows[f.id] + "-r", t0, t1: t0 + 0.12, kind: "data", color: COLORS[i % COLORS.length], vlan: "" };
    }),
    traceTitle: "拔线后发生了什么",
    trace: [
      { h: "① 成员失效", p: pn + " 物理层 down，LACP 立刻把它从 Selected 摘除。", cls: "drop" },
      { h: "② 哈希桶重算", p: "可用成员从 3 个变 2 个，取模的除数变了，<b>原先落在这条链路上的流全部要重算落点</b>。", cls: "" },
      { h: "③ 重分布", p: moved.length ? moved.map(f => f.id + " → 桶 " + api.S.flows[f.id]).join("、") : "本次没有流需要迁移", cls: "" },
      { h: "④ 丢包", p: "收敛窗口内这些流无法转发。累计丢包 <b>" + api.S.pktLoss + "</b> 个。", cls: "drop" }
    ],
    verdict: { bad: true, text: "这就是聚合不是无损的原因：带宽叠加靠多条链路同时工作，一旦成员减少，正在传输的流会被迫换口，TCP 看到丢包并降速。" }
  });
}

function plug(api){
  const pn = "GE0/0/2";
  api.S.SW1.ports[pn].up = true;
  api.S.SW2.ports[pn].up = true;
  evaluate(api.S);
  api.fx({ kind: "pulse", target: "SW1/" + pn, color: "#35E08A" });
  api.play(sceneNegotiate(api.S));
}

export default {
  id: "03",
  title: "链路聚合 Eth-Trunk",
  meta: "HUAWEI S5700 · VRP V200R005C00",
  stageLabel: "LINK AGGREGATION · LACP · 3 × GE",
  totalSteps: steps.length,
  devices: ["SW1", "SW2"],
  tabs: [
    { key: "member", label: "成员口状态", hint: "Eth-Trunk 成员表" },
    { key: "lacp", label: "LACP 统计", hint: "LACP 统计" },
    { key: "hash", label: "哈希分流", hint: "哈希分流表" }
  ],
  legend: [
    { c: "#38E1FF", label: "Selected" },
    { c: "#FFB545", label: "Unselect" },
    { c: "#FF4D5E", label: "Down" },
    { c: "#7E93AB", label: "未加入" }
  ],
  phases: { enter: "进系统视图", group: "建聚合组", mode: "选协商模式", member: "加成员口", speed: "改速率", verify: "校验" },
  viewName: VIEW_NAME,
  viewHint: VIEW_HINT,
  actions: [
    { id: "pull", label: "拔掉 GE0/0/2", run: l => pull(l) },
    { id: "plug", label: "插回 GE0/0/2", run: l => plug(l) },
    { id: "traffic", label: "跑流量", run: l => l.playScene(sceneTraffic(l.S)) }
  ],
  createState, prompt, commands, tables, topology, guide, steps,

  idle: {
    title: "判读顺序",
    items: [
      { h: "① 物理层", p: "端口 up 吗？两端都 up 才有协商的基础。" },
      { h: "② 聚合组", p: "端口加入同一个 Eth-Trunk 了吗？两端的组号与模式要匹配。" },
      { h: "③ 参数一致性", p: "速率、双工、VLAN 必须一致，否则 LACP 置 Unselect。" },
      { h: "④ 哈希分流", p: "只有 Selected 成员进哈希桶。成员一变，桶数变，所有流重新分布。" }
    ]
  },

  viewRows(ctx){
    return [
      { h: "<" + ctx.dev + "> 用户视图", p: "只读：display。改配置一律被拒。", cls: ctx.view === "user" ? "pass" : "" },
      { h: "[" + ctx.dev + "] 系统视图", p: "全局入口：interface eth-trunk 1、interface GE0/0/x。", cls: ctx.view === "system" ? "pass" : "" },
      { h: "[" + ctx.dev + "-Eth-Trunk1] 聚合组视图", p: "只作用于这个逻辑口：mode、trunkport。", cls: ctx.view === "trunk" ? "pass" : "" },
      { h: "[" + ctx.dev + "-GE0/0/x] 接口视图", p: "只作用于当前物理口：speed、eth-trunk。", cls: ctx.view === "if" ? "pass" : "" }
    ];
  },

  boot(write, printGuide){
    write("Info: 已加载出厂配置。三条 GE 物理链路已连接，尚未做任何聚合。", "dim");
    write("      S1 先看基线，S2 开始配置。", "dim");
    write("", "dim");
    printGuide();
  }
};
