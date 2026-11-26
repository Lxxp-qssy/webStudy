import { pad } from "../lib/util.js";

/* =========================================================================
   实验 09 · ACL 包过滤
   -------------------------------------------------------------------------
   一台三层交换机，三个网段在实验开始时就已互通，本实验只动 ACL：
     createState → 已经配好的 VLAN / VLANIF（不带 ACL）
     matchAcl    → 按 rule id 升序首次匹配的纯函数
     evalFilter  → 在某个接口的某个方向真正执行一次过滤，并累加命中计数
     aclScene    → 把一个报文沿「入方向判定 → 查路由 → 出方向」走一遍
   ========================================================================= */

const ACL_ID = 3000;

const HOSTS = {
  PC1: { id: "PC1", ip: "192.168.10.10", vlan: 10, mac: "5489-98e1-0001", x: 250, port: "GE0/0/1", gw: "192.168.10.1", color: "#38E1FF" },
  PC2: { id: "PC2", ip: "192.168.20.10", vlan: 20, mac: "5489-98e1-0002", x: 700, port: "GE0/0/2", gw: "192.168.20.1", color: "#FFB545" },
  SRV: { id: "SRV", ip: "192.168.100.100", vlan: 100, mac: "5489-98e1-0100", x: 1150, port: "GE0/0/3", gw: "192.168.100.1", color: "#35E08A" }
};

const VIF = {
  10: { ip: "192.168.10.1", net: "192.168.10.0" },
  20: { ip: "192.168.20.1", net: "192.168.20.0" },
  100: { ip: "192.168.100.1", net: "192.168.100.0" }
};

const PORT_OF = { 10: "GE0/0/1", 20: "GE0/0/2", 100: "GE0/0/3" };

/* ---------------- 拓扑几何 ---------------- */
const DEV = { x: 550, y: 62, w: 300, h: 74, rj: [40, 130, 220] };

const ROUTES = {
  "pc1-up": "M250 196 C330 170 500 168 590 106",
  "pc1-down": "M590 106 C500 168 330 170 250 196",
  "pc2-up": "M700 196 C698 172 690 150 680 106",
  "pc2-down": "M680 106 C690 150 698 172 700 196",
  "srv-up": "M1150 196 C1040 170 860 168 770 106",
  "srv-down": "M770 106 C860 168 1040 170 1150 196",
  "vif10": "M590 106 C630 98 668 94 700 92",
  "vif20": "M680 106 C690 100 696 96 700 92",
  "vif100": "M770 106 C740 98 716 94 700 92",
  "out-pc1": "M700 92 C620 96 420 148 250 196",
  "out-pc2": "M700 92 C704 110 702 160 700 196",
  "out-srv": "M700 92 C780 98 1020 156 1150 196"
};

/* ---------------- 初始状态 ---------------- */
export function createState(){
  return {
    name: "SW1",
    vlans: {
      10: { name: "VLAN 0010" },
      20: { name: "VLAN 0020" },
      100: { name: "VLAN 0100" }
    },
    ports: {
      "GE0/0/1": { pvid: 10, up: true },
      "GE0/0/2": { pvid: 20, up: true },
      "GE0/0/3": { pvid: 100, up: true }
    },
    vlanif: {
      10: { ip: "192.168.10.1", mask: 24 },
      20: { ip: "192.168.20.1", mask: 24 },
      100: { ip: "192.168.100.1", mask: 24 }
    },
    acl: {},
    applied: {},
    hits: {}
  };
}

/* ---------------- ACL 判定 ---------------- */
function ipInt(ip){
  const a = String(ip).split(".");
  if(a.length !== 4) return 0;
  let n = 0;
  for(let i = 0; i < 4; i++){
    const v = parseInt(a[i], 10);
    if(isNaN(v)) return 0;
    n = (n * 256) + v;
  }
  return n >>> 0;
}

function inWild(ip, net, wild){
  const m = (~ipInt(wild)) >>> 0;
  return ((ipInt(ip) & m) >>> 0) === ((ipInt(net) & m) >>> 0);
}

function ruleHit(r, pkt){
  if(r.src && !inWild(pkt.src, r.src, r.srcWild)) return false;
  if(r.dst && !inWild(pkt.dst, r.dst, r.dstWild)) return false;
  return true;
}

/* 纯判定：按 id 升序首次匹配，命中即停；全表不命中 → permit */
function matchAcl(S, aclId, pkt){
  const acl = S.acl[aclId];
  if(!acl) return { action: "permit", rule: null };
  const rules = acl.rules.slice().sort(function(a, b){ return a.id - b.id; });
  for(let i = 0; i < rules.length; i++){
    if(ruleHit(rules[i], pkt)) return { action: rules[i].action, rule: rules[i] };
  }
  return { action: "permit", rule: null };
}

/* 带副作用：真的执行一次过滤，并累加命中计数 */
function evalFilter(S, ifName, dir, pkt){
  const ap = S.applied[ifName];
  if(!ap || ap.dir !== dir) return null;
  const r = matchAcl(S, ap.acl, pkt);
  if(r.rule) S.hits[r.rule.id] = (S.hits[r.rule.id] || 0) + 1;
  else S.hits.default = (S.hits.default || 0) + 1;
  return { acl: ap.acl, action: r.action, rule: r.rule };
}

function ruleList(S, aclId){
  const acl = S.acl[aclId || ACL_ID];
  if(!acl) return [];
  return acl.rules.slice().sort(function(a, b){ return a.id - b.id; });
}

function shadowedPermitId(S){
  const rs = ruleList(S, ACL_ID);
  let deny = null;
  for(let i = 0; i < rs.length; i++){
    if(rs[i].action === "deny"){ deny = rs[i]; break; }
  }
  if(!deny) return null;
  for(let i = 0; i < rs.length; i++){
    if(rs[i].id < deny.id && rs[i].action === "permit") return rs[i].id;
  }
  return null;
}

function denyFirst(S){
  const rs = ruleList(S, ACL_ID);
  return rs.length > 0 && rs[0].action === "deny";
}

function ruleText(r){
  return r.action + " ip" +
    (r.src ? " source " + r.src + " " + r.srcWild : "") +
    (r.dst ? " destination " + r.dst + " " + r.dstWild : "");
}

function ruleSrcText(S, aclId){
  const rs = ruleList(S, aclId);
  for(let i = 0; i < rs.length; i++){
    if(rs[i].action === "deny" && rs[i].src) return rs[i].src + " " + rs[i].srcWild;
  }
  return "any";
}

/* 访客到服务器当前是否被拒 —— 只用于链路光点与标签 */
function visitorBlocked(S){
  const ap = S.applied["Vlanif20"];
  if(!ap || ap.dir !== "inbound") return false;
  return matchAcl(S, ap.acl, { src: HOSTS.PC2.ip, dst: HOSTS.SRV.ip }).action === "deny";
}

/* ---------------- 视图 ---------------- */
const VIEW_NAME = { user: "用户视图", system: "系统视图", if: "VLANIF 视图", acl: "ACL 视图" };
const VIEW_HINT = { system: "system-view", if: "interface Vlanif 20", acl: "acl 3000" };

function prompt(ctx){
  if(ctx.view === "user") return "<" + ctx.dev + ">";
  if(ctx.view === "system") return "[" + ctx.dev + "]";
  if(ctx.view === "acl") return "[" + ctx.dev + "-acl-adv-" + (ctx.aclId || ACL_ID) + "]";
  return "[" + ctx.dev + "-" + ctx.ifName + "]";
}

/* ---------------- 命令表 ---------------- */
/* 反掩码：点分形式，或单个 0 表示「精确匹配这一个地址」 */
const WILD = "(\\d+\\.\\d+\\.\\d+\\.\\d+|0)";
const RULE_RE = new RegExp(
  "^rule (\\d+) (permit|deny) ip" +
  "(?: source (\\d+\\.\\d+\\.\\d+\\.\\d+) " + WILD + ")?" +
  "(?: destination (\\d+\\.\\d+\\.\\d+\\.\\d+) " + WILD + ")?$"
);

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
      if(c.view === "if" || c.view === "acl"){ c.view = "system"; c.ifName = ""; c.aclId = ""; }
      else if(c.view === "system"){ c.view = "user"; }
      else { api.say("Error: Unrecognized command found at '^' position.", "err"); }
    }
  },
  {
    id: "return", match: /^(return|ctrl\+z)$/, view: null, kind: "view", usage: "return",
    run(api){ api.ctx.view = "user"; api.ctx.ifName = ""; api.ctx.aclId = ""; }
  },
  {
    id: "acl", match: /^acl (\d+)$/, view: "system", kind: "view", usage: "acl 3000",
    run(api, m){
      const id = parseInt(m[1], 10);
      if(id < 3000 || id > 3999){
        api.say("Error: The ACL number is invalid.", "err");
        api.say("      2000–2999 是基本 ACL，3000–3999 是高级 ACL（能同时匹配源和目的 IP）。", "dim");
        return;
      }
      if(!api.S.acl[id]){
        api.S.acl[id] = { rules: [] };
        api.change("acl " + id, "不存在", "已创建 · 0 条规则", { row: "rule-default", kind: "enter" });
        api.say("// 新建高级 ACL " + id + "：一张空的规则表，空表默认放通所有报文。", "op");
      }else{
        api.say("// ACL " + id + " 已存在，直接进入编辑视图。", "op");
      }
      api.ctx.view = "acl"; api.ctx.aclId = id; api.ctx.ifName = "";
    }
  },
  {
    id: "rule", match: RULE_RE,
    view: "acl", kind: "config",
    usage: "rule 5 deny ip source 192.168.20.0 0.0.0.255 destination 192.168.100.100 0",
    explain: [
      { h: "只改规则表", p: "ACL 是独立的规则表。写规则不改任何接口行为，除非有 traffic-filter 引用它。" },
      { h: "id 决定顺序", p: "id 不是行号，是<b>匹配顺序</b>。设备按 id 升序逐条比对，命中第一条就停。" }
    ],
    run(api, m){
      const id = parseInt(m[1], 10);
      const aclId = api.ctx.aclId || ACL_ID;
      const acl = api.S.acl[aclId];
      if(!acl){ api.say("Error: The ACL does not exist.", "err"); return; }
      const rule = {
        id: id, action: m[2],
        src: m[3] || "", srcWild: m[4] || "",
        dst: m[5] || "", dstWild: m[6] || ""
      };
      const ex = acl.rules.filter(function(r){ return r.id === id; })[0];
      if(ex){
        const before = ruleText(ex);
        ex.action = rule.action; ex.src = rule.src; ex.srcWild = rule.srcWild;
        ex.dst = rule.dst; ex.dstWild = rule.dstWild;
        api.change("ACL " + aclId + " · rule " + id, before, ruleText(rule), { row: "rule-" + id });
        api.say("// rule " + id + " 已存在，按真实设备的行为被新内容覆盖。", "op");
      }else{
        acl.rules.push(rule);
        api.change("ACL " + aclId + " · rule " + id, "不存在", ruleText(rule), { row: "rule-" + id, kind: "enter" });
      }
      acl.rules.sort(function(a, b){ return a.id - b.id; });
      api.tab("acl");
      api.say("// 当前顺序：" + ruleList(api.S, aclId).map(function(r){ return r.id + " " + r.action; }).join(" → ") +
        "（数字小的先匹配，命中即停止）", "op");
    }
  },
  {
    id: "undo-rule", match: /^undo rule (\d+)$/, view: "acl", kind: "config", usage: "undo rule 5",
    explain: [
      { h: "删掉一条规则", p: "剩下的规则依旧按 id 升序匹配。删掉排在前面的 permit，后面原本被遮蔽的 deny 就重新生效。" }
    ],
    run(api, m){
      const id = parseInt(m[1], 10);
      const aclId = api.ctx.aclId || ACL_ID;
      const acl = api.S.acl[aclId];
      if(!acl){ api.say("Error: The ACL does not exist.", "err"); return; }
      const i = acl.rules.findIndex(function(r){ return r.id === id; });
      if(i < 0){ api.say("// ACL " + aclId + " 里没有 rule " + id + "，命令未产生状态变化。", "op"); return; }
      const before = ruleText(acl.rules[i]);
      acl.rules.splice(i, 1);
      api.change("ACL " + aclId + " · rule " + id, before, "已删除", { kind: "exit" });
      api.tab("acl");
      api.say("// rule " + id + " 已删除。" + (acl.rules.length ? "当前剩余 " + acl.rules.length + " 条规则。" : "ACL 现在是空表，等于放通一切。"), "op");
    }
  },
  {
    id: "interface-vlanif", match: /^interface (?:Vlanif|vlanif)\s*(\d+)$/, view: "system", kind: "view",
    usage: "interface Vlanif 20",
    run(api, m){
      const v = parseInt(m[1], 10);
      if(!api.S.vlanif[v]){ api.say("Error: The interface does not exist.", "err"); return; }
      api.ctx.view = "if"; api.ctx.ifName = "Vlanif" + v; api.ctx.aclId = "";
    }
  },
  {
    id: "traffic-filter", match: /^traffic-filter (inbound|outbound) acl (\d+)$/, view: "if", kind: "config",
    usage: "traffic-filter inbound acl 3000",
    explain: [
      { h: "把策略贴上去", p: "这一步之前 ACL 只是躺在表里的规则，不对任何报文起作用。traffic-filter 建立接口与 ACL 的引用关系。" },
      { h: "方向决定看谁", p: "<b>inbound</b> 检查「从该接口进入设备」的报文，<b>outbound</b> 检查「从该接口发出去」的报文。同一份规则换个方向，命中的流量完全不同。" }
    ],
    run(api, m){
      const dir = m[1], id = parseInt(m[2], 10);
      const ifn = api.ctx.ifName;
      if(!api.S.acl[id]){
        api.say("Error: The ACL does not exist.", "err");
        api.say("      先 system-view → acl " + id + " 建规则表。", "dim");
        return;
      }
      if(!api.S.vlanif[parseInt(String(ifn).replace("Vlanif", ""), 10)]){
        api.say("Error: The interface does not exist.", "err");
        return;
      }
      const cur = api.S.applied[ifn];
      if(cur && cur.dir === dir && cur.acl === id){
        api.say("// " + ifn + " 的 " + dir + " 方向已经挂着 ACL " + id + "，命令未产生状态变化。", "op");
        return;
      }
      api.S.applied[ifn] = { dir: dir, acl: id };
      api.change(ifn + ".filter", cur ? cur.dir + " acl " + cur.acl : "未应用", dir + " acl " + id, { row: "apply-" + ifn, kind: cur ? "chg" : "enter" });
      api.tab("apply");
      if(cur && cur.dir !== dir){
        api.say("// 本实验每个接口只演示一个方向：" + cur.dir + " → " + dir + "。", "op");
      }
      api.say("// ACL " + id + " 已挂到 " + ifn + " 的 " + dir + " 方向。" +
        (api.S.acl[id].rules.length ? "" : "注意 ACL 里还没有规则，空表不拦任何报文。"), "op");
      const v = parseInt(String(ifn).replace("Vlanif", ""), 10);
      api.fx({ kind: "pulse", target: "SW1/" + PORT_OF[v], color: dir === "inbound" ? "#38E1FF" : "#FFB545" });
    }
  },
  {
    id: "undo-filter", match: /^undo traffic-filter(?: (inbound|outbound))?(?: acl (\d+))?$/, view: "if", kind: "config",
    usage: "undo traffic-filter inbound acl 3000",
    explain: [
      { h: "只删引用", p: "undo traffic-filter 摘掉的是「接口引用」，ACL 规则表一条都不会少。<b>策略还在，只是没人调用它。</b>" }
    ],
    run(api, m){
      const ifn = api.ctx.ifName;
      const cur = api.S.applied[ifn];
      if(!cur){
        api.say("// " + ifn + " 上没有 traffic-filter，命令未产生状态变化。", "op");
        return;
      }
      if(m[1] && cur.dir !== m[1]){
        api.say("// 当前挂的是 " + cur.dir + "，命令里的方向是 " + m[1] + "，未做改动。", "op");
        return;
      }
      if(m[2] && String(cur.acl) !== m[2]){
        api.say("// 当前挂的是 ACL " + cur.acl + "，命令里的编号是 " + m[2] + "，未做改动。", "op");
        return;
      }
      delete api.S.applied[ifn];
      api.change(ifn + ".filter", cur.dir + " acl " + cur.acl, "未应用", { row: "apply-" + ifn, kind: "exit" });
      api.tab("apply");
      api.say("// " + ifn + " 的过滤已摘除。ACL " + cur.acl + " 的规则仍然留在设备上，随时可以再挂回去。", "op");
    }
  },

  /* ---- 只读命令 ---- */
  {
    id: "display-acl", match: /^display acl (\d+)$/, view: null, kind: "doc", usage: "display acl 3000",
    doc: "这张表回答：<b>有哪些规则、按什么顺序匹配、每条被命中多少次</b>。规则顺序就是匹配顺序，改 id 等于改行为。",
    run(api, m){
      const id = parseInt(m[1], 10);
      const acl = api.S.acl[id];
      if(!acl){
        api.say("Error: The ACL does not exist.", "err");
        api.say("      还没有建 ACL " + id + "。", "dim");
        return;
      }
      const rs = ruleList(api.S, id);
      api.say("Advanced ACL " + id + ", " + rs.length + " rule" + (rs.length === 1 ? "" : "s"));
      api.say("Acl's step is 5", "dim");
      rs.forEach(function(r){
        api.say(" rule " + r.id + " " + ruleText(r) + " (match-counter " + (api.S.hits[r.id] || 0) + ")");
      });
      if(!rs.length) api.say(" (没有规则 · 所有报文都会落到默认 permit)", "dim");
      api.tab("acl");
    }
  },
  {
    id: "display-filter", match: /^display traffic-filter applied-record$/, view: null, kind: "doc",
    usage: "display traffic-filter applied-record",
    doc: "这张表回答：<b>ACL 被贴到了哪个接口、哪个方向</b>。规则写得再对，这里没有记录就等于没有生效。",
    run(api){
      const keys = Object.keys(api.S.applied);
      api.say("Total quantity of filter rules applied: " + keys.length);
      api.say("----------------------------------------------------------------------", "dim");
      api.say(pad("ACL", 6) + pad("Type", 13) + pad("Direction", 12) + pad("Interface", 18) + "Status", "dim");
      api.say("----------------------------------------------------------------------", "dim");
      keys.forEach(function(k){
        api.say(pad(api.S.applied[k].acl, 6) + pad("Interface", 13) + pad(api.S.applied[k].dir, 12) + pad(k, 18) + "Active");
      });
      if(!keys.length) api.say("（没有任何接口引用 ACL）", "dim");
      api.tab("apply");
    }
  },
  {
    id: "display-route", match: /^display ip routing-table$/, view: null, kind: "doc",
    usage: "display ip routing-table",
    doc: "三层转发的查表依据。ACL 在<b>查表之前</b>就把报文拦掉了，所以被拒的流量不会出现在这张表相关的任何计数里。",
    run(api){
      api.say("Route Flags: R - relay, D - download to fib", "dim");
      api.say("------------------------------------------------------------------------------", "dim");
      api.say("Routing Tables: Public", "dim");
      api.say("         Destinations : 3        Routes : 3", "dim");
      api.say("", "dim");
      api.say(pad("Destination/Mask", 20) + pad("Proto", 8) + pad("Pre", 5) + pad("Cost", 6) + pad("Flags", 7) + pad("NextHop", 17) + "Interface", "dim");
      [10, 20, 100].forEach(function(v){
        api.say(pad(VIF[v].net + "/24", 20) + pad("Direct", 8) + pad("0", 5) + pad("0", 6) + pad("D", 7) + pad(VIF[v].ip, 17) + "Vlanif" + v);
      });
      api.tab("rt");
    }
  }
];

/* ---------------- 表项 ---------------- */
function tables(S, tab, ctx){
  if(tab === "acl"){
    const acl = S.acl[ACL_ID];
    const rs = ruleList(S, ACL_ID);
    const maskId = shadowedPermitId(S);
    const rows = rs.map(function(r, i){
      let note = "第 " + (i + 1) + " 条被查，命中即停";
      if(r.action === "deny" && maskId) note = "被 rule " + maskId + " 遮蔽，永远查不到";
      else if(r.action === "deny") note = "命中即丢弃";
      else if(i === 0) note = "最先被查：命中即放行";
      else note = "排在 deny 之后，只兜底没被拦的流量";
      return {
        key: "rule-" + r.id,
        cells: [
          { t: r.id, cls: "c" },
          { t: r.action, cls: r.action === "deny" ? "v20" : "v10" },
          { t: r.src ? r.src + " " + r.srcWild : "any", cls: "c" },
          { t: r.dst ? r.dst + " " + r.dstWild : "any", cls: "c" },
          { t: note, cls: "c" }
        ]
      };
    });
    if(rows.length){
      rows.push({
        key: "rule-default",
        cells: [
          { t: "default", cls: "c" },
          { t: "permit", cls: "v10" },
          { t: "any", cls: "c" },
          { t: "any", cls: "c" },
          { t: "全表不命中时的隐式兜底", cls: "c" }
        ]
      });
    }
    return {
      head: ["RULE", "ACTION", "SOURCE", "DESTINATION", "判读"],
      rows: rows,
      empty: acl ? "ACL 3000 里还没有规则 · 空表默认放通" : "还没有 ACL · 执行 acl 3000 创建规则表",
      note: "按 rule id 升序首次匹配，命中即停止。顺序错了，规则写得再对也不生效。"
    };
  }
  if(tab === "apply"){
    const rows = [10, 20, 100].map(function(v){
      const ifn = "Vlanif" + v;
      const ap = S.applied[ifn];
      return {
        key: "apply-" + ifn,
        cells: [
          { t: ifn, cls: "c" },
          { t: VIF[v].ip + "/24", cls: "c" },
          { t: ap ? ap.dir : "—", cls: ap ? (ap.dir === "inbound" ? "v10" : "v20") : "c" },
          { t: ap ? ap.acl : "—", cls: "c" },
          { t: ap ? "生效中" : "未应用", cls: ap ? "v10" : "c" }
        ]
      };
    });
    return {
      head: ["INTERFACE", "IP", "DIRECTION", "ACL", "STATUS"],
      rows: rows,
      note: "策略贴在 VLANIF（三层接口）上，不是物理口：报文先进三层接口的入方向，才轮到查路由。"
    };
  }
  if(tab === "hit"){
    const rs = ruleList(S, ACL_ID);
    const rows = rs.map(function(r){
      return {
        key: "hit-" + r.id,
        cells: [
          { t: "rule " + r.id, cls: "c" },
          { t: r.action, cls: r.action === "deny" ? "v20" : "v10" },
          { t: S.hits[r.id] || 0, cls: "c" },
          { t: r.action === "deny" ? "命中即丢弃" : "命中即放行", cls: "c" }
        ]
      };
    });
    if(rows.length){
      rows.push({
        key: "hit-default",
        cells: [
          { t: "default", cls: "c" },
          { t: "permit", cls: "v10" },
          { t: S.hits.default || 0, cls: "c" },
          { t: "没有任何规则命中", cls: "c" }
        ]
      });
    }
    return {
      head: ["RULE", "ACTION", "命中次数", "判读"],
      rows: rows,
      empty: "还没有规则 · 跑一次数据面测试后产生计数",
      note: "简化：每次数据面测试把沿途每个判定点 +1，与 display acl 里的 match-counter 对应。"
    };
  }
  /* rt */
  return {
    head: ["DESTINATION/MASK", "PROTO", "PRE", "INTERFACE"],
    rows: [10, 20, 100].map(function(v){
      return {
        key: "rt-" + v,
        cells: [
          { t: VIF[v].net + "/24", cls: "c" },
          { t: "Direct", cls: "c" },
          { t: "0", cls: "c" },
          { t: "Vlanif" + v, cls: "v10" }
        ]
      };
    }),
    note: "三个网段都是直连路由。ACL 在查这张表之前就完成了判定。"
  };
}

/* ---------------- 拓扑 ---------------- */
function topology(S, ui, ctx){
  const acl = S.acl[ACL_ID];
  const ap20 = S.applied["Vlanif20"];
  const blocked = visitorBlocked(S);

  const ports = [10, 20, 100].map(function(v, i){
    return {
      name: PORT_OF[v], kind: "rj45", x: DEV.rj[i], y: 44,
      color: HOSTS[v === 10 ? "PC1" : v === 20 ? "PC2" : "SRV"].color,
      up: S.ports[PORT_OF[v]].up, label: PORT_OF[v].slice(-1)
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
      { x: 34, y: -8, text: "L3 · 3 × Vlanif" + (acl ? " · ACL " + ACL_ID + " / " + ruleList(S, ACL_ID).length + " rules" : ""), cls: "dev-sub" }
    ]
  }];

  const hosts = ["PC1", "PC2", "SRV"].map(function(k){
    const h = HOSTS[k];
    return {
      id: h.id, x: h.x, y: 200, ip: h.ip, mac: h.mac,
      vlan: h.vlan, color: h.color, up: S.ports[h.port].up
    };
  });

  const links = [
    { id: "lk-pc1", d: ROUTES["pc1-down"], cls: "", flow: 0.42, flowColor: "56,225,255" },
    { id: "lk-pc2", d: ROUTES["pc2-down"], cls: "", flow: blocked ? 0.1 : 0.42, flowColor: blocked ? "255,77,94" : "56,225,255" },
    { id: "lk-srv", d: ROUTES["srv-down"], cls: "", flow: 0.42, flowColor: "56,225,255" }
  ];

  const anchors = {
    "SW1/GE0/0/1": [DEV.x + DEV.rj[0], DEV.y + 44],
    "SW1/GE0/0/2": [DEV.x + DEV.rj[1], DEV.y + 44],
    "SW1/GE0/0/3": [DEV.x + DEV.rj[2], DEV.y + 44]
  };

  const labels = [
    { text: "Vlanif10 · 192.168.10.1/24", x: 480, y: 130, anchor: "end", cls: "lk-tag" },
    {
      text: ap20 ? "Vlanif20 · " + ap20.dir + " acl " + ap20.acl : "Vlanif20 · 192.168.20.1/24",
      x: 712, y: 142, anchor: "start",
      cls: "lk-tag" + (ap20 ? (ap20.dir === "inbound" ? " on" : " warn") : "")
    },
    { text: "Vlanif100 · 192.168.100.1/24", x: 980, y: 130, anchor: "start", cls: "lk-tag" }
  ];

  return { viewBox: "0 0 1400 300", devices: devices, hosts: hosts, links: links, routes: ROUTES, anchors: anchors, labels: labels };
}

/* ---------------- 数据面场景 ---------------- */
export function aclScene(S, from){
  const A = from === "PC1" ? HOSTS.PC1 : HOSTS.PC2;
  const B = HOSTS.SRV;
  const fwd = { src: A.ip, dst: B.ip };
  const rev = { src: B.ip, dst: A.ip };
  const kUp = A.id === "PC1" ? "pc1-up" : "pc2-up";
  const kOut = A.id === "PC1" ? "out-pc1" : "out-pc2";
  const kVifIn = "vif" + A.vlan;
  const IN = "Vlanif" + A.vlan;

  const sc = {
    name: A.id + " " + A.ip + " → 服务器 " + B.ip,
    realSec: 3.4,
    dur: 1,
    traceTitle: "逐跳判读",
    frames: [],
    trace: [],
    verdict: null,
    drop: null
  };

  const apIn = S.applied[IN];
  const inEv = evalFilter(S, IN, "inbound", fwd);

  sc.frames.push({ route: kUp, t0: 0, t1: .3, kind: "data", color: A.color });
  sc.trace.push({
    h: "① 源主机判路",
    p: "<b>" + A.ip + "/24</b> 访问 <b>" + B.ip + "</b>，目的不在本网段，交给默认网关 <b>" + A.gw + "</b>（也就是 " + IN + " 的地址）。",
    cls: ""
  });

  sc.frames.push({ route: kVifIn, t0: .32, t1: .54, kind: "data", color: A.color });

  if(inEv && inEv.action === "deny"){
    sc.drop = { route: kVifIn, p: .94, at: .54, label: "DENY · ACL " + inEv.acl + " · rule " + inEv.rule.id };
    sc.trace.push({
      h: "② 入方向判定 · " + IN,
      p: "报文进入 " + IN + "，先过 ACL " + inEv.acl + " 的 <b>inbound</b> 检查。按 id 升序查到 <b>rule " + inEv.rule.id + " deny</b>，命中即停 —— 丢弃。",
      cls: "drop"
    });
    sc.trace.push({
      h: "③ 到此为止",
      p: "查路由、ARP、出接口统统不会发生。报文在进入三层处理之前就没了，服务器一个字节都收不到。",
      cls: "drop"
    });
    sc.verdict = {
      bad: true,
      text: "被拒绝：ACL " + inEv.acl + " 的 rule " + inEv.rule.id + " 命中。端口状态和链路指示灯完全不变，只有命中计数在涨。"
    };
    return sc;
  }

  sc.trace.push({
    h: "② 入方向判定 · " + IN,
    p: (apIn && apIn.dir === "inbound")
      ? "ACL " + apIn.acl + " 挂在 inbound。按 id 升序逐条比对，没有命中 deny，落到 " +
        (inEv && inEv.rule ? "rule " + inEv.rule.id + " permit" : "默认 permit") + " —— 放行。"
      : (apIn
          ? "这个接口当前只挂了 <b>outbound</b> 的 ACL " + apIn.acl + "，入方向不检查，报文直接进入三层处理。"
          : IN + " 上没有 traffic-filter，报文直接进入三层处理。"),
    cls: ""
  });

  sc.frames.push({ route: "out-srv", t0: .56, t1: .8, kind: "data", color: A.color });
  sc.trace.push({
    h: "③ 查路由 · 出接口 Vlanif100",
    p: "目的 " + B.ip + " 命中直连路由 <b>192.168.100.0/24 → Vlanif100</b>，从 GE0/0/3 发出去（同网段先 ARP 要 MAC）。",
    cls: ""
  });

  const outEv = evalFilter(S, "Vlanif100", "outbound", fwd);
  if(outEv && outEv.action === "deny"){
    sc.drop = { route: "out-srv", p: .96, at: .8, label: "DENY · ACL " + outEv.acl + " · rule " + outEv.rule.id };
    sc.trace.push({
      h: "④ 出方向 · Vlanif100",
      p: "Vlanif100 的 <b>outbound</b> 过滤器把去程报文拦下，服务器收不到。",
      cls: "drop"
    });
    sc.verdict = { bad: true, text: "去程在出方向被拦：入方向放行了，出方向才丢，说明判定点可以有好几个。" };
    return sc;
  }

  sc.frames.push({ route: "srv-up", t0: .82, t1: .9, kind: "data", color: B.color });
  sc.frames.push({ route: "vif100", t0: .9, t1: .94, kind: "data", color: B.color });
  sc.trace.push({
    h: "④ 服务器收到并回程",
    p: "服务器回 ICMP 应答：源 <b>" + B.ip + "</b>、目的 <b>" + A.ip + "</b>。进入 Vlanif100，再查路由回到 192.168." + A.vlan + ".0/24。",
    cls: ""
  });

  const apOut = S.applied[IN];
  const outRev = evalFilter(S, IN, "outbound", rev);

  if(outRev && outRev.action === "deny"){
    sc.drop = { route: kOut, p: .2, at: .96, label: "DENY · ACL " + outRev.acl + " · rule " + outRev.rule.id };
    sc.trace.push({
      h: "⑤ 出方向 · " + IN,
      p: "回程报文从 " + IN + " 的出方向出去时命中 <b>rule " + outRev.rule.id + " deny</b>，被丢弃。",
      cls: "drop"
    });
    sc.verdict = { bad: true, text: "去程通了、回程被拦，现象依旧是 ping 不通。方向不同，拦下的是两段完全不同的流量。" };
    return sc;
  }

  sc.frames.push({ route: kOut, t0: .96, t1: 1, kind: "data", color: A.color });

  if(apOut && apOut.dir === "outbound"){
    sc.trace.push({
      h: "⑤ 出方向 · " + IN,
      p: "ACL " + apOut.acl + " 挂在这里的 <b>outbound</b>。回程报文源 <b>" + B.ip + "</b>、目的 <b>" + A.ip + "</b>；规则的源是 " +
        ruleSrcText(S, apOut.acl) + "，源和目的正好反过来，匹配不到 deny，落到 " +
        (outRev && outRev.rule ? "rule " + outRev.rule.id + " permit" : "默认 permit") + "。",
      cls: ""
    });
    sc.verdict = {
      bad: false,
      text: "通了 —— 但这不是 ACL 写对了，而是方向贴错了：去程报文根本没经过这条规则，回程报文又和规则的源/目的相反。"
    };
    return sc;
  }

  sc.trace.push({
    h: "⑤ 回程 · " + IN,
    p: apOut
      ? "ACL " + apOut.acl + " 只作用于 " + IN + " 的 <b>inbound</b>，回程走的是出方向，不检查，直接送回主机。"
      : "没有任何过滤器，回程直接送回主机。",
    cls: "pass"
  });

  sc.verdict = {
    bad: false,
    text: "往返都通。" + (apIn ? "ACL " + apIn.acl + " 挂在 " + IN + " 的 " + apIn.dir + "，但它的规则没有覆盖这条流量。" : "ACL 还没贴到任何接口上，所以一点过滤都没发生。")
  };
  return sc;
}

/* ---------------- 引导 ---------------- */
function guide(S, ctx){
  const G = function(phase, why, cmd){ return { phase: phase, why: why, cmd: cmd || "" }; };
  const acl = S.acl[ACL_ID];
  const ap = S.applied["Vlanif20"];
  const ruleCmd = "rule 5 deny ip source 192.168.20.0 0.0.0.255 destination 192.168.100.100 0";

  if(ctx.view === "acl"){
    if(!acl) return G("acl", "ACL 已经不存在了，quit 回系统视图重建。", "quit");
    if(!acl.rules.length)
      return G("rule", "规则表是空的。一条规则 = 匹配什么（源/目的 IP + 反掩码）+ 怎么办（permit / deny）。先拦住访客到服务器。", ruleCmd);
    const maskId = shadowedPermitId(S);
    if(maskId)
      return G("rule", "rule " + maskId + " 是 permit 且 id 更小，报文先命中它就被放行了，deny 永远轮不到。把这条 permit 删掉。", "undo rule " + maskId);
    return G("apply", "规则齐了。quit 出去，把这张表贴到接口上才会生效。", "quit");
  }

  if(ctx.view === "if"){
    const v = parseInt(String(ctx.ifName).replace("Vlanif", ""), 10);
    if(!S.vlanif[v]) return G("apply", "这个接口不存在，quit 退出去。", "quit");
    if(!acl || !acl.rules.length)
      return G("apply", "ACL 还没有规则，空表什么都不拦。先 quit 回系统视图把规则补上。", "quit");
    if(!S.applied[ctx.ifName])
      return G("apply", "接口有了、规则也有了，差最后一步：把 ACL 贴到这个三层接口的入方向。", "traffic-filter inbound acl " + ACL_ID);
    if(S.applied[ctx.ifName].dir !== "inbound")
      return G("apply", "现在贴在 " + S.applied[ctx.ifName].dir + "，方向不对 —— 访客进来时根本不经过这条链。改成 inbound。",
        "undo traffic-filter " + S.applied[ctx.ifName].dir + " acl " + S.applied[ctx.ifName].acl);
    return G("verify", ctx.ifName + " 的入方向已经用 ACL " + ACL_ID + " 过滤。quit 出去跑一次数据面测试。", "quit");
  }

  if(ctx.view === "system"){
    if(!acl) return G("acl", "三个网段本来就通。想拦谁，得先有一张规则表 —— 建 ACL 3000。", "acl " + ACL_ID);
    if(!acl.rules.length) return G("rule", "ACL 3000 建好了但是空的。进入 ACL 视图写规则。", "acl " + ACL_ID);
    if(shadowedPermitId(S))
      return G("rule", "有一条 permit 的 id 比 deny 小，deny 被它遮蔽了。进 ACL 视图把这条 permit 删掉。", "acl " + ACL_ID);
    if(!ap) return G("apply", "规则写好了但还没生效：ACL 不贴到接口上，不会拦任何一个报文。", "interface Vlanif 20");
    if(ap.dir !== "inbound") return G("apply", "方向还是不对，回接口里改。", "interface Vlanif 20");
    return G("verify", "配置完整。用 display acl 3000 和 display traffic-filter applied-record 交叉核对。", "display acl " + ACL_ID);
  }

  return G("enter", "<" + ctx.dev + "> 是用户视图，只能看。改配置先 system-view。", "system-view");
}

/* ---------------- 板块 ---------------- */
const steps = [
  {
    id: 1, name: "基线 · 三个网段互通", key: false, keepTrace: true,
    run: async function(api){
      api.setDev("SW1");
      await api.run(["display ip routing-table"]);
      api.play(aclScene(api.S, "PC2"));
    },
    summary: "访客到服务器本来就是通的 —— 先记住这个对照",
    detail: [
      { h: "已就绪的部分", p: "Vlanif10 / 20 / 100 三个三层接口已经配好，三个直连网段天然互通。本实验<b>不做</b> VLANIF 配置，开场就是通的。" },
      { h: "为什么先看基线", p: "后面只要出现『不通』，就一定是 ACL 造成的 —— 有了这个对照，排障范围立刻收窄到一张规则表和一个接口方向。" }
    ]
  },
  {
    id: 2, name: "建 ACL 3000 与第一条规则", key: false,
    done: function(S){
      const acl = S.acl[ACL_ID];
      return !!(acl && acl.rules.some(function(r){ return r.id === 5 && r.action === "deny"; }));
    },
    run: async function(api){
      api.setDev("SW1");
      await api.run([
        "system-view",
        "acl 3000",
        "rule 5 deny ip source 192.168.20.0 0.0.0.255 destination 192.168.100.100 0",
        "quit"
      ]);
    },
    summary: "规则表里多了一条 deny，但转发行为一点没变",
    detail: [
      { h: "5 是 id 不是行号", p: "id 决定<b>匹配顺序</b>。VRP 默认步长 5，后面可以插 rule 10、rule 15。数字小的先匹配。" },
      { h: "写规则 ≠ 生效", p: "这一步只改了规则表。没有任何接口引用 ACL 3000，报文照常通过 —— 表里有 deny 也可以完全不影响业务。" },
      { h: "反掩码别写成掩码", p: "<code>0.0.0.255</code> 是反掩码（wildcard），表示前 24 位必须一致。写成 <code>255.255.255.0</code> 语义完全不同。" }
    ]
  },
  {
    id: 3, name: "应用到 Vlanif20 入方向", key: false,
    done: function(S){
      const ap = S.applied["Vlanif20"];
      return !!(ap && ap.dir === "inbound" && ap.acl === ACL_ID);
    },
    run: async function(api){
      api.setDev("SW1");
      await api.run([
        "system-view",
        "interface Vlanif 20",
        "traffic-filter inbound acl 3000",
        "quit"
      ]);
    },
    summary: "策略贴在 Vlanif20 的 inbound 方向",
    detail: [
      { h: "为什么是 VLANIF", p: "物理口是二层，只看 MAC 和 VLAN；要按 IP 过滤就必须挂到<b>三层接口</b> Vlanif20 上。这也是三层交换机做包过滤的标准位置。" },
      { h: "inbound 的含义", p: "报文<b>从 Vlanif20 进入设备</b>时检查，也就是访客主机发往交换机的那一瞬间。此时还没查路由。" }
    ]
  },
  {
    id: 4, name: "测试 · 访客被拒", key: false, keepTrace: true,
    run: function(api){ api.play(aclScene(api.S, "PC2")); },
    summary: "DENY · ACL 3000 · rule 5 —— 报文在入方向就没了",
    detail: [
      { h: "首次匹配", p: "ACL 按 id 升序逐条比对，rule 5 一命中就停，后面的规则、默认 permit 都不会再看。" },
      { h: "对照组", p: "PC1 是 192.168.10.10，不在 192.168.20.0/24 里，这条规则匹配不上 → 默认 permit，照常访问。点右下角「PC1 → 服务器」亲自验证。" },
      { h: "只能靠计数看出来", p: "端口 up、链路灯全绿，跳线一切正常。唯一的痕迹是 display acl 3000 里这条规则的 match-counter 在涨。" }
    ]
  },
  {
    id: 5, name: "反直觉 · permit 插到最前面", key: true, keepTrace: true,
    done: function(S){
      return ruleList(S, ACL_ID).some(function(r){ return r.id === 1 && r.action === "permit"; });
    },
    run: async function(api){
      api.setDev("SW1");
      await api.run(["system-view", "acl 3000", "rule 1 permit ip", "quit"]);
      api.play(aclScene(api.S, "PC2"));
    },
    summary: "deny 还在表里，访客却又能通了",
    detail: [
      { h: "顺序决定一切", p: "<code>rule 1 permit ip</code> 匹配一切，id 又比 5 小，所以每条报文都先命中它并放行。<b>rule 5 永远查不到。</b>" },
      { h: "看表看不出来", p: "display acl 3000 里两条规则都在，deny 那条一个字都没少。只在规则内容上下判断，会得出完全错误的结论。" },
      { h: "这就是 ACL 的第一大坑", p: "规则不是集合，是<b>有序的判定链</b>。谁在前面谁说了算。" }
    ]
  },
  {
    id: 6, name: "修正 · 把 deny 放回最前", key: false, keepTrace: true,
    done: function(S){
      return ruleList(S, ACL_ID).some(function(r){ return r.id === 10 && r.action === "permit"; }) &&
        denyFirst(S) && !shadowedPermitId(S);
    },
    run: async function(api){
      api.setDev("SW1");
      await api.run(["system-view", "acl 3000", "undo rule 1", "rule 10 permit ip", "quit"]);
      api.play(aclScene(api.S, "PC2"));
    },
    summary: "deny 回到第一位，permit 退到最后兜底",
    detail: [
      { h: "改的是顺序", p: "删掉 rule 1，rule 5 重新成为第一条被查的规则；再补 <code>rule 10 permit ip</code> 放在后面，只兜底没被拦的流量。" },
      { h: "为什么还要显式 permit", p: "全表不命中本来就隐式 permit，写出来纯粹是为了可读：一眼能看出『先拦访客，其余全放』。" },
      { h: "正确的形态", p: "具体规则在前（id 小），宽泛规则在后（id 大）。反过来就是自废武功。" }
    ]
  },
  {
    id: 7, name: "反直觉 · 方向搞错", key: true, keepTrace: true,
    done: function(S){
      const ap = S.applied["Vlanif20"];
      return !!(ap && ap.dir === "outbound");
    },
    run: async function(api){
      api.setDev("SW1");
      await api.run([
        "system-view",
        "interface Vlanif 20",
        "undo traffic-filter inbound acl 3000",
        "traffic-filter outbound acl 3000",
        "quit"
      ]);
      api.play(aclScene(api.S, "PC2"));
    },
    summary: "改成 outbound，访客又能通了 —— 规则一条没动",
    detail: [
      { h: "outbound 查的是谁", p: "报文<b>从这个接口发出去</b>时才检查。访客进来走的是入方向，根本不过这条链。" },
      { h: "回程也对不上", p: "唯一的检查点在回程：报文源是服务器 192.168.100.100、目的是访客，而规则写的是源 192.168.20.0/24、目的 192.168.100.100 —— 正好反过来，匹配不到。" },
      { h: "判定点决定一切", p: "同一份规则，贴在哪个接口、哪个方向，决定了它到底能看见哪一段流量。写规则前先想清楚：报文在哪一刻会经过这里。" }
    ]
  },
  {
    id: 8, name: "改回 inbound", key: false, keepTrace: true,
    run: async function(api){
      api.setDev("SW1");
      await api.run([
        "system-view",
        "interface Vlanif 20",
        "undo traffic-filter outbound acl 3000",
        "traffic-filter inbound acl 3000",
        "quit"
      ]);
      api.play(aclScene(api.S, "PC2"));
    },
    summary: "恢复 inbound，访客再次被 rule 5 拦下",
    detail: [
      { h: "方向对上才生效", p: "访客的报文从 Vlanif20 进入设备，正好是 inbound 检查的位置；源地址又落在 192.168.20.0/24，命中 deny。" },
      { h: "立即生效", p: "ACL 对无状态报文（ICMP）没有会话概念，改完立刻生效。TCP 业务则要等旧会话老化，这是另一个话题。" }
    ]
  },
  {
    id: 9, name: "扰动 · 撤掉应用", key: false, keepTrace: true,
    run: async function(api){
      api.setDev("SW1");
      await api.run([
        "system-view",
        "interface Vlanif 20",
        "undo traffic-filter inbound acl 3000",
        "quit",
        "display acl 3000"
      ]);
      api.play(aclScene(api.S, "PC2"));
    },
    summary: "一条规则没少，但过滤立刻消失了",
    detail: [
      { h: "只删了引用", p: "<code>undo traffic-filter</code> 摘掉的是接口上的引用关系。ACL 3000 仍然是完整的两条规则，display acl 3000 一条不缺。" },
      { h: "ACL 是策略库", p: "规则表和接口是解耦的：同一个 ACL 可以挂到多个接口的多个方向。删应用 ≠ 删规则，反过来也一样。" },
      { h: "因此排查要分两步", p: "先看规则对不对（display acl），再看贴没贴、贴在哪（display traffic-filter applied-record）。漏掉任何一步都可能误判。" }
    ]
  },
  {
    id: 10, name: "校验 · 规则与应用交叉核对", key: false,
    run: async function(api){
      api.setDev("SW1");
      await api.run([
        "system-view",
        "interface Vlanif 20",
        "traffic-filter inbound acl 3000",
        "quit",
        "display acl 3000",
        "display traffic-filter applied-record"
      ]);
    },
    summary: "两条命令分别确认「规则在不在」和「贴没贴」",
    detail: [
      { h: "display acl 3000", p: "看规则顺序和 match-counter。数字小的规则在最上面；被遮蔽的规则计数永远是 0 —— 这是判断顺序是否写错的直接证据。" },
      { h: "display traffic-filter applied-record", p: "看 ACL 挂在哪个接口、哪个方向。这条命令为空，说明规则写得再对也没生效。" },
      { h: "两条都对才算生效", p: "规则正确 + 应用正确 = 策略生效。只对一半，就是本实验里那两个反直觉板块演示的局面。" }
    ]
  }
];

/* ---------------- 导出 ---------------- */
export default {
  id: "09",
  title: "ACL 包过滤",
  meta: "HUAWEI S5700 · VRP V200R005C00",
  stageLabel: "L3 PACKET FILTERING · 1 × S5700 · 3 × VLANIF",
  totalSteps: steps.length,
  devices: ["SW1"],
  tabs: [
    { key: "acl", label: "ACL 规则", hint: "ACL 3000 规则表（按 id 升序）" },
    { key: "apply", label: "接口应用", hint: "ACL 贴在哪个接口、哪个方向" },
    { key: "hit", label: "命中计数", hint: "每条规则的命中次数" },
    { key: "rt", label: "路由表", hint: "三层转发的直连路由" }
  ],
  legend: [
    { c: "#38E1FF", label: "放通 · 流量通过" },
    { c: "#FFB545", label: "VLAN 20 访客" },
    { c: "#35E08A", label: "服务器 VLAN 100" },
    { c: "#FF4D5E", label: "被 ACL 拒绝 · 仅零星尝试(0.1)" }
  ],
  phases: { enter: "进系统视图", acl: "建 ACL", rule: "加规则", apply: "应用到接口", verify: "校验" },
  viewName: VIEW_NAME,
  viewHint: VIEW_HINT,
  actions: [
    { id: "pc1srv", label: "PC1 → 服务器", run: l => l.playScene(aclScene(l.S, "PC1")) },
    { id: "pc2srv", label: "PC2 → 服务器", run: l => l.playScene(aclScene(l.S, "PC2")) }
  ],
  createState, prompt, commands, tables, topology, guide, steps,

  idle: {
    title: "判读顺序",
    items: [
      { h: "① 规则表", p: "ACL 是一张<b>有序</b>的规则链：按 id 升序首次匹配，命中即停，全表不命中才落到默认 permit。" },
      { h: "② 应用点", p: "规则表本身不生效。traffic-filter 把它贴到某个三层接口的 inbound 或 outbound 上，才有了判定点。" },
      { h: "③ 方向", p: "inbound 看进入接口的报文，outbound 看发出的报文。同一份规则换个方向，命中的流量完全不同。" },
      { h: "④ 判读", p: "不通时先 display acl 3000 看顺序，再 display traffic-filter applied-record 看方向 —— 两步都过，才轮到怀疑规则内容。" }
    ]
  },

  viewRows(ctx){
    return [
      { h: "<" + ctx.dev + "> 用户视图", p: "只读：display。改配置在这里一律被拒。", cls: ctx.view === "user" ? "pass" : "" },
      { h: "[" + ctx.dev + "] 系统视图", p: "全局入口：acl、interface Vlanif。", cls: ctx.view === "system" ? "pass" : "" },
      { h: "[" + ctx.dev + "-acl-adv-3000] ACL 视图", p: "只作用于这张规则表：rule、undo rule。规则只是候选，不碰转发。", cls: ctx.view === "acl" ? "pass" : "" },
      { h: "[" + ctx.dev + "-Vlanif20] VLANIF 视图", p: "只作用于这个三层接口：traffic-filter 把 ACL 贴上去，才真正开始过滤。", cls: ctx.view === "if" ? "pass" : "" }
    ];
  },

  boot(write, printGuide){
    write("Info: 已加载 SW1 配置 —— Vlanif10 / 20 / 100 三个三层接口就绪，三个网段互通。", "dim");
    write("      本实验只做 ACL：先建规则表，再把它贴到接口的某个方向。", "dim");
    write("", "dim");
    printGuide();
  }
};
