/* ============================================================
 * 实验 11 · 堆叠 / iStack
 * 两台 S5700 通过堆叠口合成一台逻辑设备，下游 SW3 用跨框
 * Eth-Trunk 双上行。核心叙事：
 *   堆叠前 —— STP 阻塞一条直连 + LACP 系统不一致锁死第二条
 *              上行，SW2 整机闲置；
 *   堆叠后 —— 两台合一，跨框聚合两成员全部 Selected，
 *              STP 阻塞消失，带宽翻倍。
 * 简化声明：堆叠建立过程（版本校验、配置同步、重启时序）为
 * 稳态模型；MAD 只演示直接检测模式。
 * ============================================================ */

var DEV = {
  SW1: { x: 70, y: 30, w: 300, h: 74, slot: 0 },
  SW2: { x: 1030, y: 30, w: 300, h: 74, slot: 1 },
  SW3: { x: 550, y: 140, w: 300, h: 74, slot: -1 }
};

var HOSTS = {
  PC1: { x: 664, y: 258, ip: "192.168.10.10", mac: "5489-98d1-0001", vlan: 10 }
};

/* SW3 上行锚点（绝对坐标），链路 d 与 routes 全部从它推 */
var M1_D = "M201 104 L631 140";   /* SW3 GE0/0/1 ↔ SW1 GE0/0/1 */
var M2_D = "M1199 104 L769 140";  /* SW3 GE0/0/2 ↔ SW2 GE0/0/1 */
var STACK_D = "M370 83 L1030 83"; /* SW1 ↔ SW2 直连 / 堆叠线 */
var PC_D = "M700 214 L700 258";   /* SW3 ↔ PC1 */

var COL = {
  ok: "#35E08A",
  sel: "#38E1FF",
  uns: "#FFB545",
  bad: "#FF4D5E",
  idle: "#7E93AB",
  stack: "255,181,69",
  flow: "56,225,255"
};

var VIEW_NAME = {
  user: "用户视图", system: "系统视图",
  trunk: "Eth-Trunk 视图", stackport: "堆叠端口视图"
};
var VIEW_HINT = {
  system: "system-view",
  trunk: "interface eth-trunk 1",
  stackport: "interface stack-port 0/1"
};

/* ---------------- 状态 ---------------- */

function makeSwitch(name, slot, mac, priority){
  return {
    name: name, slot: slot, mac: mac, priority: priority,
    dead: false,
    stackPort: { sub: slot === 0 ? "0/1" : "0/2", cfg: false, member: slot === 0 ? "XGE0/0/1" : "XGE0/0/2" },
    trunk: { exists: true, mode: "lacp-static", members: ["GE0/0/1"] },
    ports: {
      "GE0/0/1": { up: true, inTrunk: true },
      "XGE0/0/1": { up: true, inTrunk: false }
    }
  };
}

export function createState(){
  var sw1 = makeSwitch("SW1", 0, "4c1f-cc11-0201", 100);
  var sw2 = makeSwitch("SW2", 1, "4c1f-cc11-00f7", 100);
  sw2.stackPort.sub = "0/2";
  sw2.stackPort.member = "XGE0/0/2";
  sw2.ports["XGE0/0/2"] = { up: true, inTrunk: false };
  return {
    SW1: sw1, SW2: sw2,
    SW3: {
      name: "SW3", mac: "4c1f-cc11-03aa", priority: 100,
      trunk: { exists: true, mode: "lacp-static", members: ["GE0/0/1", "GE0/0/2"] },
      ports: {
        "GE0/0/1": { up: true, inTrunk: true },
        "GE0/0/2": { up: true, inTrunk: true },
        "GE0/0/3": { up: true, inTrunk: false }
      }
    },
    PC1: { gw: "192.168.10.1", up: true },
    fabric: {
      stacked: false, master: null, standby: null,
      rebooted: false, cableCut: false, mad: false,
      swapped: false, split: false, recovery: null, fabricMac: ""
    },
    flags: { savedOnce: false }
  };
}

/* ---------------- 派生：堆叠、主备、成员判定 ---------------- */

function stackFormed(S){
  var f = S.fabric;
  return S.SW1.stackPort.cfg && S.SW2.stackPort.cfg && f.rebooted && !f.cableCut;
}

/* 主备判定：堆叠内「倒换标志 > 优先级 > MAC 小者」 */
function elect(S){
  var a = S.SW1, b = S.SW2;
  var live = [];
  if(!a.dead) live.push(a);
  if(!b.dead) live.push(b);
  if(!live.length) return { master: null, standby: null };
  if(live.length === 1) return { master: live[0].name, standby: null };
  var f = S.fabric;
  var pick;
  if(f.swapped){ pick = (a.dead || b.dead) ? null : (f.masterSwap === "SW2" ? b : a); }
  if(!pick){
    if(a.priority !== b.priority) pick = a.priority > b.priority ? a : b;
    else pick = a.mac < b.mac ? a : b;
  }
  var other = pick === a ? b : a;
  return { master: pick.name, standby: other.name };
}

/* 成员口 Selected 判定：物理 up + 两端入同一聚合 + （堆叠后才允许跨框） */
function memberState(S, which){
  var f = S.fabric;
  var local = which === 1 ? S.SW3.ports["GE0/0/1"] : S.SW3.ports["GE0/0/2"];
  var peerSw = which === 1 ? S.SW1 : S.SW2;
  var peer = peerSw.ports["GE0/0/1"];
  if(!local.up || !peer.up || peerSw.dead) return "down";
  var inAgg = S.SW3.trunk.members.indexOf(which === 1 ? "GE0/0/1" : "GE0/0/2") >= 0 &&
              peerSw.trunk.members.indexOf("GE0/0/1") >= 0;
  if(!inAgg) return "uns";
  /* 堆叠前：SW3 一个 Eth-Trunk 的两个成员对端是两台独立设备，
     LACP 系统 ID 不一致，只有先建立的成员 1 能 Selected */
  if(!stackFormed(S)) return which === 1 ? "sel" : "uns";
  if(f.recovery === peerSw.name) return "uns";   /* MAD Recovery 态不转发 */
  if(f.split) return "sel";                       /* 双主：都在转发（危险态） */
  return "sel";
}

/* SW1—SW2 直连 / 堆叠线状态 */
function stackLinkState(S){
  var f = S.fabric;
  if(f.cableCut) return "down";
  if(stackFormed(S)) return "stack";
  return "stp";   /* 堆叠前：普通直连，被 STP 阻塞 */
}

export function recalc(S){
  var f = S.fabric;
  f.stacked = stackFormed(S);
  var e = elect(S);
  if(f.split && !f.mad){
    /* 双主：两台都声称自己是 Master */
    f.master = null; f.standby = null;
  }else{
    f.master = e.master; f.standby = e.standby;
  }
  if(f.stacked){
    f.fabricMac = (f.master ? S[f.master].mac : "").toUpperCase();
    if(f.cableCut){
      if(f.mad){ f.split = false; f.recovery = e.standby; }
      else{ f.split = true; f.recovery = null; }
    }else{
      f.split = false; f.recovery = null;
    }
  }else{
    f.fabricMac = ""; f.split = false; f.recovery = null;
  }
}

export function memberCodes(S){
  return { 1: memberState(S, 1), 2: memberState(S, 2) };
}

/* 带宽：Gbps */
export function aggBandwidth(S){
  var c = memberCodes(S);
  var n = (c[1] === "sel" ? 1 : 0) + (c[2] === "sel" ? 1 : 0);
  return n;
}

/* ---------------- 提示符 ---------------- */

function prompt(ctx){
  if(ctx.view === "user") return "<" + ctx.dev + ">";
  if(ctx.view === "system") return "[" + ctx.dev + "]";
  if(ctx.view === "trunk") return "[" + ctx.dev + "-Eth-Trunk1]";
  if(ctx.view === "stackport") return "[" + ctx.dev + "-stack-port" + (ctx.ifName || "0/1") + "]";
  return "[" + ctx.dev + "-GigabitEthernet" + ctx.ifName + "]";
}

/* ---------------- 命令 ---------------- */

function fmtStack(S, sw){
  var f = S.fabric;
  if(!f.stacked) return "standalone";
  if(f.recovery === sw.name) return "Recovery";
  if(!f.master) return "Master(双主冲突)";
  return f.master === sw.name ? "Master" : "Standby";
}

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
      var c = api.ctx;
      if(c.view === "stackport" || c.view === "trunk" || c.view === "if"){ c.view = "system"; c.ifName = ""; }
      else if(c.view === "system") c.view = "user";
      else api.say("Error: Unrecognized command found at '^' position.", "err");
    }
  },
  {
    id: "return", match: /^(return|ctrl\+z)$/, view: null, kind: "view", usage: "return",
    run(api){ api.ctx.view = "user"; api.ctx.ifName = ""; }
  },
  {
    id: "stack-priority", match: /^stack slot ([01]) priority (\d+)$/, view: "system", kind: "config",
    usage: "stack slot <0> priority <150>",
    explain: [
      { h: "主备怎么选", p: "iStack 先比 <b>堆叠优先级</b>（大者优先），相同再比 MAC（小者胜）。默认都是 100。" },
      { h: "本实验的坑", p: "SW2 的出厂 MAC 比 SW1 小——不动优先级的话，主框会是 SW2 而不是 SW1。" }
    ],
    run(api, m){
      var dev = api.ctx.dev, sw = api.S[dev];
      if(String(sw.slot) !== m[1]){
        api.say("Error: " + dev + " 的堆叠槽位是 " + sw.slot + "，请用 stack slot " + sw.slot + " priority。", "err");
        return;
      }
      var n = parseInt(m[2], 10);
      if(n < 1 || n > 255){
        api.say("Error: 优先级取值范围 1~255。", "err");
        return;
      }
      if(n === sw.priority){
        api.say("// " + dev + " 优先级已经是 " + n + "，命令未产生状态变化。", "op");
        return;
      }
      var old = sw.priority;
      sw.priority = n;
      api.change("slot " + sw.slot + " priority", old, n, { row: "stk-" + dev });
      api.say("// " + dev + "（slot " + sw.slot + "）优先级 " + old + " → " + n +
        "。堆叠未建立时这只是个参数，重新选举发生在成堆叠那一刻。", "op");
      recalc(api.S);
    }
  },
  {
    id: "if-stackport", match: /^interface stack-port (\d\/\d)$/, view: "system", kind: "view",
    usage: "interface stack-port <0/1>",
    explain: [
      { h: "堆叠口", p: "stack-port 是逻辑口，先把物理口（XGE）挂进去，堆叠线才真正承载数据。" },
      { h: "编号", p: "stack-port 0/1 对应 XGE0/0/1，0/2 对应 XGE0/0/2。两台各配一个，线才插得上。" }
    ],
    run(api, m){
      var dev = api.ctx.dev, sw = api.S[dev];
      if(m[1] !== "0/1" && m[1] !== "0/2"){
        api.say("Error: 子编号只能是 0/1 或 0/2。", "err");
        return;
      }
      api.ctx.view = "stackport"; api.ctx.ifName = m[1];
      api.say("// 进入 " + dev + " 的 stack-port " + m[1] + "。下一步把 XGE 物理口挂进来。", "op");
    }
  },
  {
    id: "port-stack", match: /^port interface (?:XGigabitEthernet|XGE)\s*(\d\/\d\/\d) enable$/i,
    view: "stackport", kind: "config",
    usage: "port interface XGE0/0/1 enable",
    explain: [
      { h: "挂物理口", p: "把 XGE 口绑定到 stack-port。绑定时该口不能再配其它业务——它现在专职搬堆叠流量。" },
      { h: "对齐", p: "0/1 配 XGE0/0/1，0/2 配 XGE0/0/2。两边编号对齐，堆叠线才是「一对一」。"}
    ],
    run(api, m){
      var dev = api.ctx.dev, sw = api.S[dev];
      var member = sw.stackPort.member;          /* XGE0/0/1 */
      var digits = member.slice(3);              /* 0/0/1 */
      if(m[1] !== digits){
        api.say("Error: stack-port " + sw.stackPort.sub + " 应绑定 " + member + "，不是 " + m[1] + "。", "err");
        return;
      }
      if(sw.stackPort.cfg){
        api.say("// " + member + " 已经在 stack-port " + sw.stackPort.sub + " 里，命令未产生状态变化。", "op");
        return;
      }
      sw.stackPort.cfg = true;
      sw.ports[member].inTrunk = false;
      api.change("stack-port " + sw.stackPort.sub, "空", member, { row: "stk-" + dev, kind: "enter" });
      api.say("// " + dev + "：" + member + " → stack-port " + sw.stackPort.sub + "。" +
        (api.S.SW1.stackPort.cfg && api.S.SW2.stackPort.cfg ? "两台都配好了，save 保存后堆叠才建立。" : "另一台还没配，先切过去配对端。"), "op");
    }
  },
  {
    id: "save", match: /^save$/, view: null, kind: "doc", usage: "save",
    explain: [
      { h: "为什么 save 是开关", p: "堆叠配置要保存后随重启生效。真实操作是 save + reboot 两步；本实验把两步合并成一次 save。" }
    ],
    run(api){
      var S = api.S, f = S.fabric;
      if(f.rebooted){
        api.say("Warning: The current configuration will be written to the device.", "dim");
        api.say("// 配置已保存。堆叠已在运行，本次保存只更新 flash。", "op");
        return;
      }
      if(!(S.SW1.stackPort.cfg && S.SW2.stackPort.cfg)){
        api.say("Warning: 还有堆叠口没配：SW1 " + (S.SW1.stackPort.cfg ? "√" : "×") +
          " / SW2 " + (S.SW2.stackPort.cfg ? "√" : "×") + "。堆叠口不全，重启后两台还是独立的。", "op");
        return;
      }
      api.lines([
        "Warning: The current configuration will be written to the device. Continue? [Y/N]:",
        "  now saving the current configuration to the slot 0.",
        "Configuration is saved to flash successfully."
      ], "dim");
      api.say("// 真实设备这里还要 reboot。本实验直接生效：两台 S5700 合成一台逻辑设备。", "op");
      f.rebooted = true;
      recalc(S);
      var f2 = S.fabric;
      api.lines([
        "",
        "Info: Stack is established. Slot 0: " + S.SW1.name + " (" + fmtStack(S, S.SW1) +
          ") / Slot 1: " + S.SW2.name + " (" + fmtStack(S, S.SW2) + ")."
      ], "out");
      if(f2.master) api.say("// 主框 = " + f2.master + "（优先级 " + S[f2.master].priority +
        "，MAC " + S[f2.master].mac + "）。堆叠 MAC 沿用主框。", "op");
      api.fx({ kind: "success" });
    }
  },
  {
    id: "if-trunk", match: /^interface eth-trunk (\d+)$/i, view: "system", kind: "view",
    usage: "interface eth-trunk 1",
    run(api, m){
      if(m[1] !== "1"){ api.say("Error: The Eth-Trunk does not exist.", "err"); return; }
      api.ctx.view = "trunk"; api.ctx.ifName = "";
      api.say("// 进入 Eth-Trunk 1" + (api.S.fabric.stacked ? "（堆叠后是跨框逻辑口）" : "（当前只在本框有效）") + "。", "op");
    }
  },
  {
    id: "trunkport", match: /^trunkport (?:GigabitEthernet|GE)\s*([\d/]+)(?: to (?:GigabitEthernet|GE)?\s*([\d/]+))?$/i,
    view: "trunk", kind: "config", usage: "trunkport GigabitEthernet <0/0/1>",
    explain: [
      { h: "加成员", p: "把物理口挂进聚合组。<b>堆叠后</b>另一台机框的口也能挂进来——这就是跨框聚合。" },
      { h: "槽位号", p: "堆叠后接口按「槽位/0/0/口」编号：slot 0 的口是 GE0/0/x，slot 1 的口是 GE1/0/x。" }
    ],
    run(api, m){
      var dev = api.ctx.dev, S = api.S, sw = S[dev];
      var f = S.fabric;
      var raw = m[1];
      /* 允许 0/0/1（本框）与堆叠后的 1/0/1（slot 1 的口） */
      var slotPrefix = raw.split("/")[0];
      var portName;
      if(raw === "0/0/1"){ portName = "GE0/0/1"; }
      else if(raw === "1/0/1"){ portName = "GE1/0/1"; }
      else if(raw === "0/0/2" && dev === "SW3"){ portName = "GE0/0/2"; }
      else{
        api.say("Error: 接口 " + raw + " 不在 " + dev + (f.stacked ? "（堆叠系统）" : "") + " 上，或不在本实验规划里。", "err");
        return;
      }
      if(f.stacked && slotPrefix === "1"){
        /* 跨框成员挂在逻辑设备上 */
        var target = "GE1/0/1";
        if(sw.trunk.members.indexOf(target) >= 0){
          api.say("// " + target + " 已在 Eth-Trunk 1 里，命令未产生状态变化。", "op");
          return;
        }
        sw.trunk.members.push(target);
        api.change("Eth-Trunk1 成员", portName, "加入（slot 1 框）", { row: "mem-2", kind: "enter" });
        api.say("// " + portName + "（slot 1 框的物理口）加入 Eth-Trunk 1。聚合组现在是跨框的。", "op");
        recalc(S);
        return;
      }
      /* 本框成员（SW3 侧或堆叠前） */
      if(!sw.trunk.exists){ sw.trunk.exists = true; }
      if(sw.trunk.members.indexOf(portName) >= 0){
        api.say("// " + portName + " 已在 Eth-Trunk 1 里，命令未产生状态变化。", "op");
        return;
      }
      sw.trunk.members.push(portName);
      api.change("Eth-Trunk1 成员", "未加入", portName, { row: "mem-" + (dev === "SW3" ? (portName === "GE0/0/1" ? "1" : "2") : "1"), kind: "enter" });
      api.say("// " + portName + " 加入 " + dev + " 的 Eth-Trunk 1。" +
        (f.stacked ? "" : "堆叠前另一框的口进不了同一聚合，LACP 系统 ID 对不上。"), "op");
      recalc(S);
    }
  },
  {
    id: "mad", match: /^mad detect mode (direct|relay)$/, view: "system", kind: "config",
    usage: "mad detect mode direct",
    explain: [
      { h: "为什么需要 MAD", p: "堆叠线一断，两台都会认为自己该当主（双主）：管理 IP 冲突、转发表各说各话。" },
      { h: "直接检测", p: "direct 模式通过业务口发检测报文，发现对方还活着就让备机进 Recovery 态——业务口 ShutDown，只保留管理口。" }
    ],
    run(api, m){
      var S = api.S, f = S.fabric;
      if(!(S.SW1.stackPort.cfg && S.SW2.stackPort.cfg && f.rebooted)){
        api.say("Error: 堆叠还没建立，MAD 是堆叠系统的属性。", "err");
        return;
      }
      if(m[1] !== "direct"){
        api.say("// 本实验只演示 direct（直接检测）。relay 需要中间设备做中转，不在范围。", "op");
        return;
      }
      if(f.mad){
        api.say("// MAD direct 已经在运行，命令未产生状态变化。", "op");
        return;
      }
      f.mad = true;
      api.change("MAD", "未配置", "direct", { row: "stk-mad", kind: "enter" });
      api.say("// MAD 直接检测已启用。堆叠线再断，备框会进 Recovery，不再双主。", "op");
      recalc(S);
    }
  },
  {
    id: "reset-slot", match: /^reset slot ([01])$/, view: "user", kind: "doc",
    usage: "reset slot <0>",
    explain: [
      { h: "倒换", p: "重启主框 = 主动倒换。Standby 无缝接管，转发表是同步的，业务只丢极短时间。" },
      { h: "不回切", p: "iStack 的主备<b>不抢占</b>：原主框恢复后仍然做备，除非再次倒换。" }
    ],
    run(api, m){
      var S = api.S, f = S.fabric, slot = parseInt(m[1], 10);
      if(!f.stacked){
        api.say("Error: 堆叠未建立，reset slot 只对堆叠成员有效。", "err");
        return;
      }
      var sw = slot === 0 ? S.SW1 : S.SW2;
      if(f.recovery === sw.name || sw.dead){
        api.say("Error: slot " + slot + " 已离线。", "err");
        return;
      }
      if(f.master !== sw.name){
        api.say("Error: slot " + slot + " 是 Standby，重启它不影响主框。要倒换请 reset slot " +
          (slot === 0 ? 1 : 0) + "。", "err");
        return;
      }
      api.lines([
        "Warning: Rebooting slot " + slot + ". Standby will take over.",
        "Info: Master switchover is in progress..."
      ], "dim");
      f.swapped = true;
      f.masterSwap = sw.name === "SW1" ? "SW2" : "SW1";
      recalc(S);
      api.say("// 倒换完成：新的主框 = " + S.fabric.master + "。原主框回到堆叠后做备，业务继续。", "op");
      api.fx({ kind: "success" });
    }
  },
  {
    id: "display-stack", match: /^display stack$/, view: null, kind: "doc", usage: "display stack",
    run(api){
      var S = api.S, f = S.fabric;
      api.lines([
        "Stack domain: 1",
        "Stack priority of current member: " + api.S[api.ctx.dev].priority,
        ""
      ], "dim");
      if(!f.stacked){
        api.lines([
          "Slot  Port  Priority  Mac Address    Role         State",
          "0     --    " + pad(S.SW1.priority) + "      " + S.SW1.mac + "  standalone   normal",
          "1     --    " + pad(S.SW2.priority) + "      " + S.SW2.mac + "  standalone   normal"
        ], "out");
        api.say("// 两台各自独立，没有堆叠关系。", "op");
        return;
      }
      var rows = [0, 1].map(function(i){
        var sw = i === 0 ? S.SW1 : S.SW2;
        var role = fmtStack(S, sw);
        var st = sw.dead ? "offline" : (f.recovery === sw.name ? "recovery" : "normal");
        return i + "     " + sw.stackPort.sub + "    " + pad(sw.priority) + "      " + sw.mac + "  " + padEnd(role, 13) + " " + st;
      });
      api.lines(["Slot  Port  Priority  Mac Address    Role          State"].concat(rows), "out");
      api.say("// 堆叠 MAC = " + (f.fabricMac || "--") + "（沿用主框）。对外它就是一台设备。", "op");
    }
  },
  {
    id: "display-stack-cfg", match: /^display stack configuration$/, view: null, kind: "doc",
    usage: "display stack configuration",
    run(api){
      var S = api.S;
      api.lines([
        "Member  Stack-port  Member-interface",
        "0       0/1         XGigabitEthernet0/0/1 " + (S.SW1.stackPort.cfg ? "(bound)" : "(unbound)"),
        "1       0/2         XGigabitEthernet0/0/2 " + (S.SW2.stackPort.cfg ? "(bound)" : "(unbound)")
      ], "out");
    }
  },
  {
    id: "display-eth", match: /^display eth-trunk (\d+)$/, view: null, kind: "doc",
    usage: "display eth-trunk 1",
    run(api, m){
      if(m[1] !== "1"){ api.say("Error: The Eth-Trunk does not exist.", "err"); return; }
      var S = api.S, c = memberCodes(S);
      var rows = [1, 2].map(function(i){
        var pname = i === 1 ? "GE0/0/1" : "GE0/0/2";
        var box = i === 1 ? "slot 0（SW1）" : "slot 1（SW2）";
        var st = c[i] === "sel" ? "Selected" : c[i] === "uns" ? "Unselect" : "Down";
        return pname + "  " + padEnd(box, 14) + st;
      });
      api.lines([
        "Eth-Trunk1's state information is listed below:",
        "WorkingMode: STATIC        Hash arithmetic: According to SIP-XOR-DIP",
        "Least Active-linknumber: 1  Max Bandwidth-affected-linknumber: 8",
        "Operate status: " + (aggBandwidth(S) > 0 ? "up" : "down") + "          Number Of Up Port In Trunk: " + aggBandwidth(S),
        "--------------------------------------------------------------------"
      ], "dim");
      api.lines(rows, "out");
      var c1 = memberCodes(S);
      if(!S.fabric.stacked && c1[2] === "uns"){
        api.say("// 成员 2 Unselect：对端 LACP 系统 ID 与成员 1 不一致（两台独立设备）。堆叠后才会恢复。", "op");
      }
      if(S.fabric.stacked && c1[1] === "sel" && c1[2] === "sel"){
        api.say("// 两个成员分属两个机框，但聚合组认为它们在同一台设备上——跨框聚合成立。", "op");
      }
      if(S.fabric.recovery){
        api.say("// " + S.fabric.recovery + " 处于 MAD Recovery 态，业务口被 ShutDown，成员不参与转发。", "op");
      }
    }
  },
  {
    id: "display-stp", match: /^display stp brief$/, view: null, kind: "doc", usage: "display stp brief",
    run(api){
      var S = api.S, f = S.fabric;
      var sw = S[api.ctx.dev];
      api.lines([" MSTID  Port                     Role  STP State     Protection"], "dim");
      if(f.stacked && !f.cableCut){
        var mapped = api.ctx.dev === "SW1" || api.ctx.dev === "SW2"
          ? ["GE0/0/1", api.ctx.dev === "SW1" ? "GE1/0/1" : "GE0/0/1"]
          : ["GE0/0/1", "GE0/0/2"];
        api.lines([
          "   0    Eth-Trunk1(" + mapped.join(" / ") + ")    ROOT  FORWARDING    none"
        ], "out");
        api.say("// 堆叠后聚合是一个逻辑链路，STP 不再有阻塞口。", "op");
      }else{
        var blocked = api.ctx.dev === "SW1"
          ? [["XGigabitEthernet0/0/1", "ALTE", "DISCARDING"]]
          : api.ctx.dev === "SW2"
            ? [["XGigabitEthernet0/0/2", "ROOT", "FORWARDING"]]
            : [["GigabitEthernet0/0/2", "ALTE", "DISCARDING"]];
        var normal = api.ctx.dev === "SW3"
          ? [["GigabitEthernet0/0/1", "ROOT", "FORWARDING"]]
          : [["GigabitEthernet0/0/1", "DESI", "FORWARDING"]];
        api.lines(normal.concat(blocked).map(function(r){
          return "   0    " + padEnd(r[0], 25) + r[1] + "  " + padEnd(r[2], 14) + "none";
        }), "out");
        api.say("// 堆叠前是两台独立设备 + 三角拓扑，STP 必须阻塞一条链路防环。", "op");
      }
    }
  }
];

function pad(n){ n = String(n); while(n.length < 5) n = " " + n; return n; }
function padEnd(s, n){ s = String(s); while(s.length < n) s = s + " "; return s; }

/* ---------------- 表项 ---------------- */

function tables(S, tab, ctx){
  var f = S.fabric;
  if(tab === "stack"){
    var c1 = memberCodes(S);
    var rows = [
      { key: "stk-SW1", cells: [
        { t: "0（" + S.SW1.name + "）", cls: "c" },
        { t: fmtStack(S, S.SW1), cls: f.master === "SW1" ? "ok" : (f.recovery === "SW1" ? "bad" : f.split ? "warn" : "c") },
        { t: S.SW1.priority, cls: "c" },
        { t: S.SW1.mac, cls: "c" },
        { t: S.SW1.stackPort.cfg ? "0/1 · XGE0/0/1" : "未绑定", cls: S.SW1.stackPort.cfg ? "c" : "warn" },
        { t: S.SW1.dead ? "offline" : "normal", cls: S.SW1.dead ? "bad" : "dim" }
      ] },
      { key: "stk-SW2", cells: [
        { t: "1（" + S.SW2.name + "）", cls: "c" },
        { t: fmtStack(S, S.SW2), cls: f.master === "SW2" ? "ok" : (f.recovery === "SW2" ? "bad" : f.split ? "warn" : "c") },
        { t: S.SW2.priority, cls: "c" },
        { t: S.SW2.mac, cls: "c" },
        { t: S.SW2.stackPort.cfg ? "0/2 · XGE0/0/2" : "未绑定", cls: S.SW2.stackPort.cfg ? "c" : "warn" },
        { t: S.SW2.dead ? "offline" : "normal", cls: S.SW2.dead ? "bad" : "dim" }
      ] }
    ];
    return {
      head: ["SLOT", "ROLE", "PRIORITY", "MAC", "STACK-PORT", "状态"],
      rows: rows,
      empty: "还没有堆叠成员",
      note: f.split
        ? "双主冲突：两台都认为自己是 Master。配了 MAD direct 后，备框会进 Recovery。"
        : f.stacked
          ? "主备判定：倒换标志 > 优先级 > MAC 小者。堆叠 MAC 沿用主框 " + (f.fabricMac || "--") + "。"
          : "两台还是独立设备。MAC 小的 SW2 会赢过 SW1——这就是默认参数下的反直觉结果。"
    };
  }
  if(tab === "member"){
    var c2 = memberCodes(S);
    var mk = function(i){
      var code = c2[i];
      var pname = i === 1 ? "GE0/0/1" : "GE0/0/2";
      var box = i === 1 ? "slot 0 · SW1" : "slot 1 · SW2";
      var cls = code === "sel" ? "ok" : code === "uns" ? "warn" : "bad";
      var note = code === "sel"
        ? (f.split ? "双主态仍在转发（危险）" : "转发中")
        : code === "uns"
          ? (!f.stacked ? "对端 LACP 系统 ID 不一致" : (f.recovery === (i === 1 ? "SW1" : "SW2") ? "MAD Recovery" : "未入聚合"))
          : "链路断";
      var bw = code === "sel" ? "1 Gbps" : "0";
      return { key: "mem-" + i, cells: [
        { t: pname, cls: "c" }, { t: box, cls: "c" },
        { t: code === "sel" ? "Selected" : code === "uns" ? "Unselect" : "Down", cls: cls },
        { t: bw, cls: code === "sel" ? "c" : "dim" },
        { t: note, cls: "dim" }
      ] };
    };
    var up = aggBandwidth(S);
    return {
      head: ["MEMBER", "归属框", "状态", "带宽", "判读"],
      rows: [mk(1), mk(2)],
      empty: "没有成员",
      note: "聚合总带宽 " + up + " Gbps。跨框聚合成立时，成员分属两个机框但对聚合组透明。"
    };
  }
  if(tab === "port"){
    var rows2 = [];
    [ "SW1", "SW2", "SW3" ].forEach(function(dn){
      var sw = S[dn];
      Object.keys(sw.ports).forEach(function(pn){
        var p = sw.ports[pn];
        if(pn.indexOf("XGE") === 0 && f.stacked) return; /* 堆叠后并入 stack-port，不再单列 */
        var role = pn === "GE0/0/1" && dn !== "SW3" ? "Eth-Trunk1 成员"
          : (dn === "SW3" && p.inTrunk ? "Eth-Trunk1 成员" : "物理口");
        rows2.push({ key: "p-" + dn + "-" + pn, cells: [
          { t: dn + " · " + pn, cls: "c" },
          { t: p.up && !sw.dead ? "up" : "down", cls: p.up && !sw.dead ? "ok" : "bad" },
          { t: role, cls: p.inTrunk ? "c" : "dim" },
          { t: f.stacked && dn !== "SW3" ? "无（堆叠内）" : (role === "物理口" ? "STP" : "无（聚合）"), cls: "dim" }
        ] });
      });
    });
    return {
      head: ["PORT", "UP", "角色", "STP"],
      rows: rows2,
      empty: "没有端口",
      note: "堆叠前三角拓扑里 STP 必须阻塞一条链路；堆叠后直连变成堆叠线，聚合防环，STP 阻塞消失。"
    };
  }
  if(tab === "fwd"){
    var m = memberCodes(S);
    var outIf = m[1] === "sel" ? (m[2] === "sel" ? "Eth-Trunk1（哈希分流）" : "Eth-Trunk1 · GE0/0/1")
      : (m[2] === "sel" ? "Eth-Trunk1 · GE0/0/2" : "--");
    var cross = m[1] === "sel" && m[2] === "sel";
    return {
      head: ["目的", "出接口", "说明"],
      rows: [
        { key: "fwd-pc", cells: [
          { t: "PC1 · 192.168.10.10", cls: "c" },
          { t: outIf === "--" ? "丢弃" : "GE0/0/3", cls: outIf === "--" ? "bad" : "c" },
          { t: "本地接入", cls: "dim" }
        ] },
        { key: "fwd-up", cells: [
          { t: "上行（出口方向）", cls: "c" },
          { t: outIf, cls: outIf === "--" ? "bad" : "ok" },
          { t: cross ? "跨框聚合：两条成员都能走" : "单成员转发", cls: "dim" }
        ] }
      ],
      empty: "没有转发表",
      note: "堆叠的意义在这一页：成员坏了换一条，出接口不变（还是 Eth-Trunk1），上游毫无感知。"
    };
  }
  return null;
}

/* ---------------- 拓扑 ---------------- */

function topology(S, ui, ctx){
  var f = S.fabric;
  var c = memberCodes(S);
  var linkState = stackLinkState(S);

  var devices = [ "SW1", "SW2", "SW3" ].map(function(id){
    var g = DEV[id], sw = S[id];
    var ports = [];
    if(id === "SW1"){
      ports.push({ name: "GE0/0/1", kind: "sfp", x: 60, y: 44, color: c[1] === "sel" ? COL.sel : c[1] === "uns" ? COL.uns : COL.bad, up: sw.ports["GE0/0/1"].up && !sw.dead, label: "1" });
      ports.push({ name: "XGE0/0/1", kind: "sfp", x: 256, y: 44, color: f.stacked ? COL.ok : (linkState === "stp" ? COL.uns : COL.bad), up: sw.ports["XGE0/0/1"].up && !sw.dead && !f.cableCut, label: "S" });
    }else if(id === "SW2"){
      ports.push({ name: "XGE0/0/2", kind: "sfp", x: 2, y: 44, color: f.stacked ? COL.ok : (linkState === "stp" ? COL.bad : COL.bad), up: sw.ports["XGE0/0/2"] ? sw.ports["XGE0/0/2"].up && !sw.dead && !f.cableCut : false, label: "S" });
      ports.push({ name: "GE0/0/1", kind: "sfp", x: 148, y: 44, color: c[2] === "sel" ? COL.sel : c[2] === "uns" ? COL.uns : COL.bad, up: sw.ports["GE0/0/1"].up && !sw.dead, label: "1" });
    }else{
      ports.push({ name: "GE0/0/1", kind: "sfp", x: 60, y: 44, color: c[1] === "sel" ? COL.sel : c[1] === "uns" ? COL.uns : COL.bad, up: sw.ports["GE0/0/1"].up, label: "1" });
      ports.push({ name: "GE0/0/2", kind: "sfp", x: 110, y: 44, color: c[2] === "sel" ? COL.sel : c[2] === "uns" ? COL.uns : COL.bad, up: sw.ports["GE0/0/2"].up, label: "2" });
      ports.push({ name: "GE0/0/3", kind: "rj45", x: 176, y: 44, color: sw.ports["GE0/0/3"].up ? COL.idle : COL.bad, up: sw.ports["GE0/0/3"].up, label: "3" });
    }
    var sub;
    if(id === "SW3") sub = "接入 · Eth-Trunk1 双上行";
    else if(f.stacked) sub = "slot " + sw.slot + " · " + fmtStack(S, sw) + (f.split ? " · 双主!" : "") + (f.recovery === id ? " · Recovery" : "");
    else sub = "独立 · STP";
    return {
      id: id, x: g.x, y: g.y, w: g.w, h: g.h,
      model: id === "SW3" ? "S5720-接入" : "S5700-28C-EI",
      silk: "M12 24 h60 M12 28 h44",
      leds: [
        { x: 272, y: 10, color: sw.dead ? COL.bad : COL.ok, glow: !sw.dead, label: "PWR", tx: 278, ty: 12.5 }
      ],
      ports: ports,
      tags: [
        { x: 0, y: -8, text: id + (f.stacked && id !== "SW3" ? "（slot " + sw.slot + "）" : ""), cls: "dev-label" },
        { x: 34, y: -8, text: sub, cls: f.split && id !== "SW3" ? "dev-sub warn" : "dev-sub" }
      ]
    };
  });

  var hosts = Object.keys(HOSTS).map(function(id){
    var h = HOSTS[id];
    return {
      id: id, x: h.x, y: h.y, ip: h.ip, mac: h.mac, vlan: h.vlan,
      color: COL.ok, up: S.PC1.up && S.SW3.ports["GE0/0/3"].up
    };
  });

  var links = [];
  /* 堆叠线 / STP 直连 */
  if(linkState === "down"){
    links.push({ id: "lk-stack", d: STACK_D, cls: "down", flow: 0, flowColor: COL.stack });
  }else if(f.stacked){
    links.push({ id: "lk-stack", d: STACK_D, cls: "trunk on", flow: 0.25, flowColor: COL.stack });
  }else{
    links.push({ id: "lk-stack", d: STACK_D, cls: "", flow: 0, flowColor: COL.stack });
  }
  /* 两条上行成员 */
  [1, 2].forEach(function(i){
    var code = c[i];
    links.push({
      id: "lk-m" + i, d: i === 1 ? M1_D : M2_D,
      cls: code === "sel" ? "trunk on" : code === "uns" ? "" : "down",
      flow: code === "sel" ? 0.9 : 0, flowColor: COL.flow
    });
  });
  links.push({ id: "lk-pc", d: PC_D, cls: "", flow: S.PC1.up && S.SW3.ports["GE0/0/3"].up && aggBandwidth(S) > 0 ? 0.42 : 0, flowColor: COL.flow });

  var labels = [];
  if(linkState === "down"){
    labels.push({ text: "STACK DOWN", x: 700, y: 76, anchor: "middle", cls: "lk-tag bad" });
  }else if(f.stacked){
    labels.push({ text: f.split ? "SPLIT · 双主" : "STACK · 堆叠线", x: 700, y: 76, anchor: "middle", cls: f.split ? "lk-tag bad" : "lk-tag on" });
  }else{
    labels.push({ text: "STP BLOCKING", x: 700, y: 76, anchor: "middle", cls: "lk-tag bad" });
  }
  [1, 2].forEach(function(i){
    var code = c[i];
    var txt = code === "sel" ? "SELECTED" : code === "uns" ? (!f.stacked ? "UNSELECT · 系统ID不一致" : "UNSELECT") : "LINK DOWN";
    var cls = code === "sel" ? "lk-tag on" : code === "uns" ? "lk-tag warn" : "lk-tag bad";
    var mid = i === 1 ? { x: (201 + 631) / 2 - 60, y: (104 + 140) / 2 - 10 } : { x: (1199 + 769) / 2 + 70, y: (104 + 140) / 2 - 10 };
    labels.push({ text: txt, x: mid.x, y: mid.y, anchor: "middle", cls: cls });
  });
  if(f.recovery){
    labels.push({ text: "MAD RECOVERY", x: f.recovery === "SW1" ? 220 : 1180, y: 20, anchor: "middle", cls: "lk-tag bad" });
  }

  var routes = {
    "pc-up": "M700 258 L700 214",
    "m1-r": "M631 140 L201 104",
    "m2-r": "M769 140 L1199 104",
    "m1-l": "M201 104 L631 140",
    "m2-l": "M1199 104 L769 140",
    "stack-r": "M370 83 L1030 83"
  };
  var anchors = {
    "SW1/GE0/0/1": [DEV.SW1.x + 60 + 21, DEV.SW1.y + 44 + 9],
    "SW1/XGE0/0/1": [DEV.SW1.x + 256 + 21, DEV.SW1.y + 44 + 9],
    "SW2/XGE0/0/2": [DEV.SW2.x + 2 + 21, DEV.SW2.y + 44 + 9],
    "SW2/GE0/0/1": [DEV.SW2.x + 148 + 21, DEV.SW2.y + 44 + 9],
    "SW3/GE0/0/1": [DEV.SW3.x + 60 + 21, DEV.SW3.y + 44 + 9],
    "SW3/GE0/0/2": [DEV.SW3.x + 110 + 21, DEV.SW3.y + 44 + 9],
    "SW3/GE0/0/3": [DEV.SW3.x + 176 + 21, DEV.SW3.y + 44 + 9]
  };

  return { viewBox: "0 0 1400 340", devices: devices, hosts: hosts, links: links, routes: routes, anchors: anchors, labels: labels };
}

/* ---------------- 场景 ---------------- */

export function stackScene(S, mode){
  var c = memberCodes(S);
  var m1ok = c[1] === "sel", m2ok = c[2] === "sel";
  if(mode === "split"){
    return {
      name: "堆叠分裂 · 双主",
      dur: 1,
      traceTitle: "分裂判读",
      frames: [
        { route: "pc-up", t0: 0, t1: .18, kind: "data" },
        { route: "m1-r", t0: .2, t1: .45, kind: "data" },
        { route: "m2-l", t0: .5, t1: .75, kind: "data" }
      ],
      drop: { route: "stack-r", p: .5, at: .55, label: "SPLIT · 双主" },
      trace: [
        { h: "① 堆叠线断开", p: "两台失去心跳，各自升主。堆叠 MAC、管理 IP 变成两份，网管系统看到两台「同一台设备」。", cls: "bad" },
        { h: "② 双主转发", p: "SW3 的两个成员对两台「主」各自 Selected——聚合组同时往两个系统发，二层环出现。", cls: "" },
        { h: "③ MAD direct", p: "配了 direct 检测后，通过业务口发现对方存活，让备框进 Recovery（业务口 ShutDown），环被拆掉。", cls: "" }
      ],
      verdict: { bad: true, text: "堆叠线是单点。没有 MAD 的堆叠分裂 = 双主 + 环路，比不堆叠更糟。" }
    };
  }
  if(mode === "failover"){
    var alive = m1ok ? "m1-r" : "m2-r";
    return {
      name: "成员故障 · 流量切换",
      dur: 1,
      traceTitle: "切换判读",
      frames: [
        { route: "pc-up", t0: 0, t1: .2, kind: "data" },
        { route: alive, t0: .25, t1: .7, kind: "data" }
      ],
      trace: [
        { h: "① 成员断了", p: "一条成员 Down，聚合组把它踢出 Selected 集合。", cls: "" },
        { h: "② 出接口不变", p: "转发表里还是 Eth-Trunk1，只是成员少了一个。上游设备全程无感知。", cls: "" },
        { h: "③ 带宽减半", p: "2 Gbps → 1 Gbps，但业务不断。这是堆叠 + 跨框聚合的核心收益。", cls: "" }
      ],
      verdict: { bad: false, text: "单框故障：带宽减半、业务不断。" }
    };
  }
  var path = m2ok ? "m2-r" : "m1-r";
  return {
    name: "PC1 上行 · 跨框聚合",
    dur: 1,
    traceTitle: "逐跳判读",
    frames: [
      { route: "pc-up", t0: 0, t1: .2, kind: "data", vlan: 10 },
      { route: path, t0: .25, t1: .7, kind: "data" }
    ],
    trace: [
      { h: "① PC1 → SW3", p: "SW3 是接入层，PC 的默认网关在上游。", cls: "" },
      { h: "② Eth-Trunk1 分流", p: m2ok ? "两条成员都 Selected，哈希把这条流放进其中一条——单条流不会拆开。"
          : "只有一条成员 Selected，另一条被 LACP 系统不一致锁死，带宽浪费一半。", cls: m2ok ? "" : "bad" },
      { h: "③ 上行", p: f_stacked(S) ? "堆叠后 SW1、SW2 是一台设备，两条成员跨框但同属一个聚合组。"
          : "堆叠前 SW1 和 SW2 各自独立，SW3 的两个成员对端系统 ID 不同。", cls: "" }
    ],
    verdict: { bad: !m2ok, text: m2ok ? "聚合带宽 2 Gbps，全部 Selected。" : "上行只有 1 Gbps，第二台上行整个闲置。" }
  };
}
function f_stacked(S){ return S.fabric.stacked; }

/* ---------------- 引导 ---------------- */

function guide(S, ctx){
  var dev = ctx.dev, f = S.fabric;
  var G = function(phase, why, cmd){ return { phase: phase, why: why, cmd: cmd || "" }; };

  if(ctx.view === "stackport"){
    var sw = S[dev];
    return G("sport", "把 " + sw.stackPort.member + " 挂进 stack-port " + sw.stackPort.sub + "。", "port interface " + sw.stackPort.member + " enable");
  }
  if(ctx.view === "trunk"){
    if(f.stacked && S[dev].trunk.members.indexOf("GE1/0/1") < 0 && (dev === "SW1" || dev === "SW2")){
      return G("agg", "堆叠后 slot 1 框的口也能进同一个聚合。把跨框成员加进来。", "trunkport GigabitEthernet 1/0/1");
    }
    return G("agg", "Eth-Trunk1 视图。quit 退回系统视图。", "quit");
  }

  if(ctx.view === "user"){
    return G("enter", "用户视图只能看。改配置先 system-view。", "system-view");
  }

  if(!f.stacked){
    if(S.SW1.priority === 100 && S.SW2.priority === 100){
      return G("prio", "两台优先级都是 100——MAC 小的 SW2 会当主。给 SW1 抬到 150。", "stack slot 0 priority 150");
    }
    if(dev === "SW1" || dev === "SW2"){
      var sw = S[dev];
      if(!sw.stackPort.cfg){
        return G("sport", dev + " 的堆叠口还没配。先进 stack-port 视图。", "interface stack-port " + sw.stackPort.sub);
      }
      var other = dev === "SW1" ? "SW2" : "SW1";
      if(!S[other].stackPort.cfg){
        return G("sport", dev + " 配好了，还差 " + other + " 的堆叠口。切过去配对端。", "");
      }
      return G("form", "两台堆叠口都绑好了。save 保存配置，堆叠随重启生效（本实验直接生效）。", "save");
    }
    return G("sport", "切到 SW1 或 SW2 配堆叠口（SW3 是接入设备，不参与堆叠）。", "");
  }

  /* 已成堆叠 */
  if(!f.mad){
    return G("mad", "堆叠线是单点。先配 MAD direct，分裂时备框才会进 Recovery 而不是双主。", "mad detect mode direct");
  }
  return G("verify", "配置齐了。display stack、display eth-trunk 1 交叉核对主备与成员。", "display stack");
}

/* ---------------- 板块 ---------------- */

function powerOff2(S){
  S.SW2.dead = true;
  S.fabric.swapped = false;
  recalc(S);
}
function powerOn2(S){
  S.SW2.dead = false;
  S.fabric.cableCut = false;
  S.fabric.swapped = false;
  S.fabric.masterSwap = null;
  recalc(S);
}
function cutStackCable(S){
  S.fabric.cableCut = true;
  recalc(S);
}
function plugStackCable(S){
  S.SW2.dead = false;
  S.fabric.cableCut = false;
  S.fabric.swapped = false;
  S.fabric.masterSwap = null;
  recalc(S);
}

function pull(api){ powerOff2(api.S); api.play(stackScene(api.S, "failover")); }
function plug(api){ powerOn2(api.S); }
function cut(api){ cutStackCable(api.S); api.play(stackScene(api.S, "split")); }

const steps = [
  {
    id: 1, name: "基线 · 两台独立 + STP",
    run: function(api){ api.setDev("SW3"); api.run(["display stp brief", "display eth-trunk 1"]); api.play(stackScene(api.S, "traffic")); },
    summary: "SW2 整机闲置：直连被 STP 阻塞、第二上行被 LACP 锁死",
    detail: [
      { h: "两个锁", p: "三角拓扑里 STP 阻塞一条直连；SW3 的第二个上行对端系统 ID 和第一个不一致，LACP 拒绝 Selected。两个锁叠加，SW2 的上联能力全部浪费。" },
      { h: "反直觉", p: "「加了一台交换机」不等于「带宽翻倍」——不堆叠，第二台的上行永远是摆设。" }
    ]
  },
  {
    id: 2, name: "改堆叠优先级",
    done: function(S){ return S.SW1.priority === 150; },
    run: function(api){ api.setDev("SW1"); return api.run(["system-view", "stack slot 0 priority 150", "quit"]); },
    summary: "SW1 优先级 100 → 150，堆叠建立时主框才会是 SW1",
    detail: [
      { h: "为什么现在改", p: "两台都是 100 时比 MAC，SW2 的出厂 MAC 更小、会赢。优先级要在成堆叠<b>之前</b>改好。" },
      { h: "判定顺序", p: "iStack 主备 = 优先级大者 → MAC 小者。和 STP 选根桥几乎同构。" }
    ]
  },
  {
    id: 3, name: "配堆叠端口",
    done: function(S){ return S.SW1.stackPort.cfg && S.SW2.stackPort.cfg; },
    run: async function(api){
      api.setDev("SW1");
      await api.run(["system-view", "interface stack-port 0/1", "port interface XGE0/0/1 enable", "quit"]);
      api.setDev("SW2");
      await api.run(["system-view", "interface stack-port 0/2", "port interface XGE0/0/2 enable", "quit"]);
    },
    summary: "SW1 绑 XGE0/0/1、SW2 绑 XGE0/0/2，堆叠口两侧就绪",
    detail: [
      { h: "两台都要配", p: "stack-port 是逻辑口，各自绑一个 XGE 物理口。少配一台，堆叠线插上也协商不起来。" },
      { h: "编号对齐", p: "0/1 ↔ XGE0/0/1、0/2 ↔ XGE0/0/2。真实设备还要连两根线做防单点，本实验按一根演示。" }
    ]
  },
  {
    id: 4, name: "save · 堆叠建立",
    done: function(S){ return S.fabric.stacked; },
    run: function(api){ api.run(["save", "display stack"]); },
    summary: "两台 S5700 合成一台逻辑设备，主框 SW1",
    detail: [
      { h: "真实操作", p: "save 之后要 reboot，堆叠成员会做版本校验、选举、配置同步——本实验合并成一次 save 直接生效。" },
      { h: "对外形态", p: "堆叠后只看到一台设备：一个管理 IP、一份配置、一套 MAC。slot 0 是主框。" }
    ]
  },
  {
    id: 5, name: "看逻辑设备",
    run: function(api){ api.run(["display stack", "display stack configuration"]); },
    summary: "Slot 0 Master / Slot 1 Standby，堆叠 MAC 沿用主框",
    detail: [
      { h: "跨框视图", p: "display stack 一次看到两台：槽位、优先级、MAC、角色。它们共享一份转发表。" },
      { h: "接口编号", p: "堆叠后物理口按 slot 重新编号：slot 1 的口是 GE1/0/x。后续配置全部在逻辑设备上做。" }
    ]
  },
  {
    id: 6, name: "跨框聚合",
    done: function(S){ return memberCodes(S)[2] === "sel"; },
    run: function(api){ api.setDev("SW1"); return api.run(["system-view", "interface eth-trunk 1", "trunkport GigabitEthernet 1/0/1", "quit"]); },
    summary: "slot 1 框的口加入 Eth-Trunk 1，聚合组变跨框",
    detail: [
      { h: "跨框的本质", p: "聚合组成员分属两个机框，但 Eth-Trunk 认为它们在同一台设备上——因为堆叠把两台合成了一台。" },
      { h: "LACP", p: "SW3 看到的对端系统 ID 变成堆叠 MAC，两个成员的系统 ID 一致了，第二个成员立刻 Selected。" }
    ]
  },
  {
    id: 7, name: "看聚合与 STP",
    run: function(api){ api.run(["display eth-trunk 1", "display stp brief"]); api.play(stackScene(api.S, "traffic")); },
    summary: "两成员 Selected、带宽 2 Gbps、STP 阻塞消失",
    detail: [
      { h: "对照基线", p: "第 1 步里 SW2 整机闲置；现在两条上行都在转发，直连变成堆叠线，STP 不再需要阻塞任何链路。" },
      { h: "单流限制", p: "哈希分流是按流的：一条 PC 流只会走一个成员。聚合提升的是总带宽，不是单流带宽。" }
    ]
  },
  {
    id: 8, name: "主备倒换", key: true, keepTrace: true,
    done: function(S){ return S.fabric.master === "SW2"; },
    run: function(api){ api.run(["quit", "reset slot 0", "display stack"]); },
    summary: "reset slot 0 后 Standby(SW2) 接管，业务不断",
    detail: [
      { h: "倒换窗口", p: "转发表是双向同步的，倒换只丢极短时间（毫秒级），PC 的 ARP 缓存都不用变——网关 MAC 就是堆叠 MAC。" },
      { h: "不回切", p: "iStack 主备<b>不抢占</b>：原主框 SW1 恢复后继续做备。这点和 VRRP 的抢占行为相反。" }
    ]
  },
  {
    id: 9, name: "单框故障", key: true, keepTrace: true,
    done: function(S){ return S.SW2.dead; },
    run: function(api){ pull(api); api.run(["display eth-trunk 1"]); },
    summary: "SW2 整框掉电：成员剩一个 Selected，业务不断、带宽减半",
    detail: [
      { h: "跨框的意义", p: "故障的是整个 slot 1，但 Eth-Trunk1 还有一个成员在 slot 0 上活着。业务面只有带宽变化。" },
      { h: "对照上一轮", p: "第 8 步是「控制面换主」，这一步是「数据面减成员」。两种故障的恢复路径不同，但业务都不断。" }
    ]
  },
  {
    id: 10, name: "堆叠分裂 · 双主与 MAD", key: true, keepTrace: true,
    done: function(S){ return S.fabric.mad === true; },
    run: async function(api){
      /* 恢复 SW2 后断堆叠线，制造分裂 */
      api.S.SW2.dead = false;
      cutStackCable(api.S);
      await api.run(["system-view", "mad detect mode direct", "quit", "display stack"]);
      api.play(stackScene(api.S, "split"));
    },
    summary: "堆叠线断开 = 双主；配 MAD direct 后备框进 Recovery，环被拆掉",
    detail: [
      { h: "为什么是双主", p: "堆叠心跳没了，两台都觉得自己该当主：管理 IP 冲突、两边各说各的转发表。" },
      { h: "MAD direct", p: "通过业务口直发检测报文，发现对方活着就让备框进 Recovery：业务口 ShutDown、只保留管理口。" },
      { h: "工程教训", p: "堆叠线必须冗余（双线双绑），并且 MAD 一定要配。没有 MAD 的分裂比不堆叠更糟。" }
    ]
  },
  {
    id: 11, name: "校验 · 恢复完整堆叠",
    run: function(api){
      plugStackCable(api.S);
      api.run(["display stack", "display eth-trunk 1", "display stp brief"]);
      api.play(stackScene(api.S, "traffic"));
    },
    summary: "堆叠线接回，两成员 Selected、主备就位、STP 无阻塞",
    detail: [
      { h: "收尾清单", p: "display stack 看主备；display eth-trunk 1 看成员与带宽；display stp brief 确认没有阻塞口。" },
      { h: "什么时候用堆叠", p: "接入层两台合成一台做跨框聚合、核心层两台做 2 设备堆叠。3 台以上要升级到 CSS/iStack+ 的其它形态。" }
    ]
  }
];

/* ---------------- 其它导出 ---------------- */

function viewRows(ctx){
  if(ctx.view === "stackport"){
    return [
      { h: "堆叠端口视图", p: "在这里把 XGE 物理口绑进 stack-port。绑定后这个口不能再配 VLAN / 聚合等业务。" },
      { h: "下一步", p: "port interface XGE0/0/1 enable —— 子编号和物理口尾号必须一致。" }
    ];
  }
  if(ctx.view === "trunk"){
    return [
      { h: "Eth-Trunk 视图", p: "trunkport 加成员。堆叠后另一框的口用 slot 前缀：GE1/0/1。" },
      { h: "跨框验证", p: "display eth-trunk 1 里两个成员的「归属框」不同、状态都是 Selected，就是跨框聚合成立。" }
    ];
  }
  if(ctx.view === "system"){
    return [
      { h: "堆叠三步", p: "改优先级 → 配 stack-port → save。三步都在系统视图。" },
      { h: "MAD", p: "堆叠建立后补 mad detect mode direct，防分裂双主。" }
    ];
  }
  return [
    { h: "用户视图", p: "display stack / display eth-trunk 1 / display stp brief 都在这里。" },
    { h: "倒换", p: "reset slot 0 重启主框触发倒换（用户视图命令）。" }
  ];
}

function boot(write, printGuide){
  write("// 实验 11 · 堆叠 / iStack", "op");
  write("// 两台 S5700（SW1 / SW2）+ 接入 SW3。基线里 SW2 整机闲置：", "op");
  write("//   直连被 STP 阻塞 + 第二上行被 LACP 系统 ID 锁死。", "op");
  write("// 目标：堆叠合成一台逻辑设备，跨框聚合让两条上行全部 Selected。", "op");
  write("// 简化：堆叠建立过程为稳态模型，MAD 只演示 direct 模式。", "op");
  write("", "dim");
  printGuide();
}

export default {
  id: "11",
  title: "堆叠 / iStack",
  meta: "HUAWEI S5700 ×2 + S5720 · VRP V200R005C00",
  stageLabel: "ISTACK · 2-MEMBER FABRIC + CROSS-BOX ETH-TRUNK",
  totalSteps: steps.length,

  devices: ["SW1", "SW2", "SW3"],
  tabs: [
    { key: "stack", label: "堆叠成员", hint: "堆叠槽位与主备" },
    { key: "member", label: "聚合成员", hint: "Eth-Trunk1 成员" },
    { key: "port", label: "端口状态", hint: "物理口与 STP" },
    { key: "fwd", label: "转发路径", hint: "跨框转发" }
  ],
  legend: [
    { c: "#38E1FF", label: "Selected" },
    { c: "#FFB545", label: "Unselect / STP 阻塞" },
    { c: "#FF4D5E", label: "Down / Recovery" },
    { c: "#35E08A", label: "堆叠线" }
  ],
  phases: { enter: "进系统视图", prio: "改优先级", sport: "配堆叠口", form: "成堆叠", agg: "跨框聚合", mad: "配 MAD", verify: "校验" },
  viewName: VIEW_NAME,
  viewHint: VIEW_HINT,

  actions: [
    { id: "traffic", label: "跑流量", run: function(l){ l.playScene(stackScene(l.S, "traffic")); } },
    { id: "p2", label: "SW2 掉电", run: function(l){ pull(l); } },
    { id: "p2b", label: "SW2 上电", run: function(l){ plug(l); l.write("// SW2 恢复。", "op"); } },
    { id: "cut", label: "断开堆叠线", run: function(l){ cut(l); } },
    { id: "plug2", label: "接回堆叠线", run: function(l){ plugStackCable(l.S); l.write("// 堆叠线接回，堆叠恢复。", "op"); } }
  ],

  createState: createState,
  prompt: prompt,
  commands: commands,
  tables: tables,
  topology: topology,
  guide: guide,
  steps: steps,
  viewRows: viewRows,
  boot: boot,

  idle: {
    title: "判读顺序",
    items: [
      { h: "① 先看两个锁", p: "基线里 SW2 为什么闲着：STP 阻塞 + LACP 系统 ID 不一致。两个问题堆叠后一起消失。" },
      { h: "② 主备判定", p: "优先级大者 → MAC 小者。默认参数下 SW2 会赢——动手改优先级才轮到 SW1。" },
      { h: "③ 跨框聚合", p: "display eth-trunk 1 里两个成员「归属框」不同却都是 Selected，这就是堆叠的意义。" },
      { h: "④ 故障两种", p: "倒换（控制面换主）和单框掉电（数据面减成员）是两条不同的故障路径，业务都不中断。" },
      { h: "⑤ 分裂最危险", p: "堆叠线断了没配 MAD = 双主 + 环路。堆叠上线前 MAD 必须先配。" }
    ]
  }
};
