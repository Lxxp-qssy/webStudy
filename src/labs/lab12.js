/* ============================================================
 * 实验 12 · SSH 远程管理
 * 管理 PC 通过管理网段访问 SW1。核心叙事：
 *   Telnet 能用但明文过网 —— 先建立「能通 ≠ 安全」；
 *   RSA 密钥 → STelnet → AAA 用户 → VTY 四步配齐后才算闭环；
 *   反直觉：TOFU 指纹、漏配 VTY 协议、level 不足被拒。
 * 简化声明：密钥交换与加密算法为示意，不实现真实 DH/RSA
 * 计算；抓包对比用「明文 / 密文」文字表示。
 * ============================================================ */

var DEV = { SW1: { x: 550, y: 40, w: 300, h: 74 } };
var HOSTS = {
  Admin: { x: 664, y: 200, ip: "192.168.100.10", mac: "5489-98e1-0001" }
};
var LINK_D = "M697 200 L703 114";

var COL = {
  ok: "#35E08A",
  cyan: "#38E1FF",
  warn: "#FFB545",
  bad: "#FF4D5E",
  idle: "#7E93AB"
};

var VIEW_NAME = {
  user: "用户视图", system: "系统视图",
  aaa: "AAA 视图", vty: "VTY 用户界面视图"
};
var VIEW_HINT = {
  system: "system-view",
  aaa: "aaa",
  vty: "user-interface vty 0 4"
};

/* ---------------- 状态 ---------------- */

export function createState(){
  return {
    SW1: {
      name: "SW1",
      vlanif: { "100": { ip: "192.168.100.1", mask: "24", up: true } },
      telnet: true,
      stelnet: false,
      rsa: null,
      aaa: { users: {} },
      vty: { authMode: "password", pwd: "Huawei@123", protocol: "all" },
      sessions: [ { user: "admin", proto: "telnet", ip: "192.168.100.10", level: 0, since: "00:00" } ]
    },
    Admin: { ip: "192.168.100.10", up: true },
    flags: { sshEverConnected: false, sawDeny: false }
  };
}

/* ---------------- 登录判定 ---------------- */

/* 返回 { ok, level, reason }。reason 用 VRP 风格文案 */
export function tryLogin(S, proto, user, pwd){
  var sw = S.SW1;
  if(proto === "ssh"){
    if(!sw.stelnet) return { ok: false, reason: "refused", why: "STelnet 服务未开启（TCP 22 没有监听）" };
    if(!sw.rsa) return { ok: false, reason: "refused", why: "设备没有 RSA 密钥，无法完成密钥交换" };
  }
  if(proto === "telnet" && !sw.telnet){
    return { ok: false, reason: "refused", why: "Telnet 服务已关闭（TCP 23 没有监听）" };
  }
  var protoOk = sw.vty.protocol === "all" || sw.vty.protocol === proto;
  if(!protoOk){
    return { ok: false, reason: "refused", why: "VTY 只允许 " + sw.vty.protocol + " 协议接入，" + proto + " 被用户界面挡在门外" };
  }
  if(sw.vty.authMode === "aaa"){
    var u = sw.aaa.users[user];
    if(!u) return { ok: false, reason: "auth", why: "AAA 里没有用户 " + user };
    if(u.service.indexOf(proto) < 0) return { ok: false, reason: "auth", why: "用户 " + user + " 的 service-type 不含 " + proto };
    if(u.pwd !== pwd) return { ok: false, reason: "auth", why: "密码错误" };
    return { ok: true, level: u.level };
  }
  /* password 模式：只认 VTY 密码，无用户名 */
  if(!sw.vty.pwd || pwd !== sw.vty.pwd) return { ok: false, reason: "auth", why: "VTY 密码错误" };
  return { ok: true, level: 0 };
}

export function recalc(S){
  /* 会话有效性：服务被关 / 协议被改后，存量会话断开 */
  var sw = S.SW1;
  sw.sessions = sw.sessions.filter(function(s){
    if(s.proto === "telnet" && !sw.telnet) return false;
    if(s.proto === "ssh" && !sw.stelnet) return false;
    if(sw.vty.protocol !== "all" && sw.vty.protocol !== s.proto) return false;
    if(sw.vty.authMode === "aaa"){
      var u = sw.aaa.users[s.user];
      return !!(u && u.service.indexOf(s.proto) >= 0);
    }
    return true;
  });
}

/* ---------------- 提示符 ---------------- */

function prompt(ctx){
  if(ctx.view === "user") return "<" + ctx.dev + ">";
  if(ctx.view === "system") return "[" + ctx.dev + "]";
  if(ctx.view === "aaa") return "[" + ctx.dev + "-aaa]";
  if(ctx.view === "vty") return "[" + ctx.dev + "-ui-vty0-4]";
  return "[" + ctx.dev + "]";
}

/* ---------------- 场景 ---------------- */

export function sshScene(S, mode){
  var pcR = "pc-r";
  if(mode === "plain"){
    return {
      name: "Telnet · 明文过网",
      dur: 1,
      traceTitle: "抓包判读",
      frames: [
        { route: pcR, t0: 0, t1: .22, kind: "broadcast" },
        { route: pcR, t0: .3, t1: .55, kind: "data" },
        { route: pcR, t0: .62, t1: .85, kind: "data" }
      ],
      trace: [
        { h: "① TCP 23", p: "Telnet 走 23 端口，连接建立后就是裸字节流。", cls: "" },
        { h: "② 用户名 admin", p: "抓包直接可读 —— 用户名明文过网。", cls: "bad" },
        { h: "③ 密码 Huawei@123", p: "同一条流里，密码也是明文。同一办公网段任何一台机器抓包都能拿到。", cls: "bad" }
      ],
      verdict: { bad: true, text: "Telnet 的每个字节都能被旁路抓到。管理协议必须换 SSH。" }
    };
  }
  if(mode === "handshake"){
    return {
      name: "SSH · 握手与认证",
      dur: 1,
      traceTitle: "阶段判读",
      frames: [
        { route: pcR, t0: 0, t1: .14, kind: "broadcast" },
        { route: pcR, t0: .18, t1: .32, kind: "data" },
        { route: pcR, t0: .36, t1: .5, kind: "data" },
        { route: pcR, t0: .55, t1: .7, kind: "data" },
        { route: pcR, t0: .74, t1: .9, kind: "data" }
      ],
      trace: [
        { h: "① TCP 22 · 版本协商", p: "客户端与服务端交换 SSH-2.0 版本串，协商出两边都支持的算法套件。", cls: "" },
        { h: "② 密钥交换（DH）", p: "双方各自生成临时密钥，算出对称会话密钥 —— 这一步之后链路已经是密文。", cls: "" },
        { h: "③ 服务端身份", p: "服务端用 RSA 私钥对交换数据签名，客户端拿公钥验证：网线那头真的是 SW1。", cls: "" },
        { h: "④ 用户认证", p: "用户名密码在<b>加密通道内</b>传输，抓包只能看到密文长度，看不到内容。", cls: "ok" }
      ],
      verdict: { bad: false, text: "SSH 的加密从认证之前就开始，密码永远不明文过网。" }
    };
  }
  /* tofu：首次连接的指纹确认 */
  return {
    name: "SSH · 首次连接（TOFU）",
    dur: 1,
    traceTitle: "指纹判读",
    frames: [
      { route: pcR, t0: 0, t1: .3, kind: "data" },
      { route: pcR, t0: .4, t1: .7, kind: "data" }
    ],
    drop: null,
    trace: [
      { h: "① 第一次没有可信基准", p: "客户端问：「服务器指纹 8f:2a:…:c1，是否信任？」—— 此时你无法验证真伪。", cls: "" },
      { h: "② TOFU", p: "Trust On First Use：第一次大胆信，之后每次连接比对指纹。指纹一旦变了，要么换设备、要么有人在中间。" },
      { h: "③ 工程做法", p: "生产环境把指纹登记进资产台账，带外核对。第一次连生产设备就盲选 yes 是大忌。", cls: "bad" }
    ],
    verdict: { bad: false, text: "指纹确认是 SSH 信任链的第一环，也是唯一靠人的一环。" }
  };
}

/* ---------------- 命令 ---------------- */

function showSession(S){
  var sw = S.SW1;
  if(!sw.sessions.length){
    return "  (no active sessions)";
  }
  var rows = sw.sessions.map(function(s){
    return "  " + padEnd(s.user, 8) + padEnd(s.proto.toUpperCase(), 8) + padEnd(s.ip, 18) + "level " + s.level + "  " + s.since;
  });
  return [ "  USER    PROTO   SOURCE IP          LEVEL  SINCE" ].concat(rows).join("\n");
}

function padEnd(s, n){ s = String(s); while(s.length < n) s = s + " "; return s; }

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
      if(c.view === "aaa" || c.view === "vty"){ c.view = "system"; c.ifName = ""; }
      else if(c.view === "system") c.view = "user";
      else api.say("Error: Unrecognized command found at '^' position.", "err");
    }
  },
  {
    id: "return", match: /^(return|ctrl\+z)$/, view: null, kind: "view", usage: "return",
    run(api){ api.ctx.view = "user"; api.ctx.ifName = ""; }
  },
  {
    id: "telnet-srv", match: /^(undo\s+)?telnet server enable$/, view: "system", kind: "config",
    usage: "telnet server enable",
    explain: [
      { h: "服务层开关", p: "控制 TCP 23 是否监听。关掉它，任何 VTY 配置都救不了——连接在 TCP 层就被拒绝。" }
    ],
    run(api, m){
      var sw = api.S.SW1;
      var on = !m[1];
      if(on === sw.telnet){
        api.say("// Telnet 服务已经" + (on ? "开启" : "关闭") + "，命令未产生状态变化。", "op");
        return;
      }
      sw.telnet = on;
      api.change("Telnet 服务", on ? "关闭" : "开启", on ? "开启" : "关闭", { row: "svc-telnet" });
      api.say("// Telnet 服务 " + (on ? "开启（TCP 23 监听）" : "关闭（TCP 23 停止监听）") + "。存量会话被断开。", "op");
      recalc(api.S);
    }
  },
  {
    id: "rsa", match: /^rsa local-key-pair create$/, view: "system", kind: "config",
    usage: "rsa local-key-pair create",
    explain: [
      { h: "信任根", p: "服务端身份 = RSA 私钥。没有密钥，STelnet 起不来，客户端也没法验证「对面真的是这台设备」。" },
      { h: "指纹", p: "客户端显示的服务器指纹就是这把公钥的哈希。首次连接核对它，之后每次连接比对它。" }
    ],
    run(api){
      var sw = api.S.SW1;
      if(sw.rsa){
        api.say("// RSA 密钥对已存在（" + sw.rsa.bits + " 位）。重新生成会使已登记的指纹失效。", "op");
        return;
      }
      api.lines([
        "Info: The key name will be: SW1_Host.",
        "Info: The key modulus can be any one of 2048, 3072, 4096.",
        "Info: Generating keys..., please wait"
      ], "dim");
      sw.rsa = { bits: 2048, fp: "8f:2a:6b:1e:44:c9:d0:7a:31:55:9e:b2:c8:0d:1f:c1" };
      api.change("RSA 密钥", "无", "2048 位", { row: "svc-rsa", kind: "enter" });
      api.say("// 密钥指纹 " + sw.rsa.fp + " —— 记进资产台账，客户端首次连接时核对的就是它。", "op");
    }
  },
  {
    id: "stelnet", match: /^(undo\s+)?stelnet server enable$/, view: "system", kind: "config",
    usage: "stelnet server enable",
    explain: [
      { h: "顺序", p: "VRP 要求先有 RSA 密钥才能开启 STelnet。没生成密钥就 enable，命令直接被拒。" }
    ],
    run(api, m){
      var sw = api.S.SW1;
      var on = !m[1];
      if(on && !sw.rsa){
        api.say("Error: 请先创建 RSA 本地密钥对（rsa local-key-pair create），否则 STelnet 无法完成密钥交换。", "err");
        return;
      }
      if(on === sw.stelnet){
        api.say("// STelnet 服务已经" + (on ? "开启" : "关闭") + "，命令未产生状态变化。", "op");
        return;
      }
      sw.stelnet = on;
      api.change("STelnet 服务", on ? "关闭" : "开启", on ? "开启（TCP 22 监听）" : "关闭", { row: "svc-ssh" });
      api.say("// STelnet 服务 " + (on ? "开启（TCP 22 监听）" : "关闭") + "。", "op");
      recalc(api.S);
    }
  },
  {
    id: "aaa", match: /^aaa$/, view: "system", kind: "view", usage: "aaa",
    run(api){
      api.ctx.view = "aaa"; api.ctx.ifName = "";
      api.say("// 进入 AAA 视图。本地用户在这里建：账号、密码、权限级别、允许的服务。", "op");
    }
  },
  {
    id: "lu-pwd", match: /^local-user (\S+) password (?:irreversible-cipher|cipher) (\S+)$/, view: "aaa", kind: "config",
    usage: "local-user <admin> password irreversible-cipher <密码>",
    explain: [
      { h: "irreversible-cipher", p: "不可逆加密存储：配置文件里看不到原文，只有哈希。比 cipher（可逆）更安全。" }
    ],
    run(api, m){
      var sw = api.S.SW1;
      var name = m[1], pwd = m[2];
      if(!sw.aaa.users[name]){
        sw.aaa.users[name] = { level: 1, service: [], pwd: pwd };
        api.change("本地用户 " + name, "不存在", "已创建", { row: "aaa-" + name, kind: "enter" });
        api.say("// 用户 " + name + " 已创建（默认 level 1、无 service-type——此时它连 SSH 都进不来，继续补权限）。", "op");
        return;
      }
      var u = sw.aaa.users[name];
      var same = u.pwd === pwd;
      u.pwd = pwd;
      api.change("本地用户 " + name, "密码", same ? "未变化" : "已更新", { row: "aaa-" + name });
      api.say("// " + name + " 的密码已" + (same ? "重设（与原值相同）" : "更新") + "，以不可逆哈希存储。", "op");
    }
  },
  {
    id: "lu-lvl", match: /^local-user (\S+) privilege level (\d+)$/, view: "aaa", kind: "config",
    usage: "local-user <admin> privilege level <15>",
    explain: [
      { h: "级别分级", p: "0（诊断）～ 15（超级管理员）。system-view 需要 level ≥ 2；display 大多 level 0 就能看。" },
      { h: "认证 ≠ 授权", p: "密码对了只是「进得来」，能执行什么命令由 level 决定。两件事别混为一谈。" }
    ],
    run(api, m){
      var sw = api.S.SW1;
      var u = sw.aaa.users[m[1]];
      if(!u){ api.say("Error: 用户 " + m[1] + " 不存在，先建密码。", "err"); return; }
      var n = parseInt(m[2], 10);
      if(n > 15){ api.say("Error: 级别取值 0~15。", "err"); return; }
      var old = u.level;
      u.level = n;
      api.change("用户 " + m[1] + " level", old, n, { row: "aaa-" + m[1] });
      api.say("// " + m[1] + " 权限级别 " + old + " → " + n +
        (n >= 2 ? "（可进 system-view）" : "（display 之外大概率被拒）") + "。存量会话权限即时生效。", "op");
    }
  },
  {
    id: "lu-svc", match: /^local-user (\S+) service-type (\S+)$/, view: "aaa", kind: "config",
    usage: "local-user <admin> service-type <ssh>",
    explain: [
      { h: "服务白名单", p: "这个账号允许从哪些接入方式进来。只写 ssh，Telnet 即使服务开着也进不来。" }
    ],
    run(api, m){
      var sw = api.S.SW1;
      var u = sw.aaa.users[m[1]];
      if(!u){ api.say("Error: 用户 " + m[1] + " 不存在，先建密码。", "err"); return; }
      var svc = m[2].toLowerCase();
      var known = { ssh: 1, telnet: 1, terminal: 1, http: 1, ftp: 1 };
      if(!known[svc]){ api.say("Error: service-type 只支持 ssh / telnet / terminal / http / ftp。", "err"); return; }
      if(u.service.indexOf(svc) >= 0){
        api.say("// " + m[1] + " 的 service-type 已含 " + svc + "，命令未产生状态变化。", "op");
        return;
      }
      u.service.push(svc);
      api.change("用户 " + m[1] + " service", "加入", svc, { row: "aaa-" + m[1] });
      api.say("// " + m[1] + " 允许通过 " + svc + " 接入。", "op");
    }
  },
  {
    id: "lu-del", match: /^undo local-user (\S+)$/, view: "aaa", kind: "config",
    usage: "undo local-user <admin>",
    run(api, m){
      var sw = api.S.SW1;
      if(!sw.aaa.users[m[1]]){ api.say("Error: 用户 " + m[1] + " 不存在。", "err"); return; }
      delete sw.aaa.users[m[1]];
      api.change("本地用户 " + m[1], "存在", "已删除", { row: "aaa-" + m[1] });
      api.say("// 用户 " + m[1] + " 已删除。它的会话会被强制断开。", "op");
      recalc(api.S);
    }
  },
  {
    id: "ui-vty", match: /^user-interface vty (\d+) (\d+)$/, view: "system", kind: "view",
    usage: "user-interface vty 0 4",
    run(api, m){
      api.ctx.view = "vty"; api.ctx.ifName = m[1] + "-" + m[2];
      api.say("// 进入 VTY 0~" + m[2] + "。远程接入的三件事都配在这：认证方式、允许协议、ACL。", "op");
    }
  },
  {
    id: "auth-mode", match: /^authentication-mode (aaa|password|none)$/, view: "vty", kind: "config",
    usage: "authentication-mode aaa",
    explain: [
      { h: "两种模式", p: "password = 一条共享密码进所有 VTY；aaa = 每人一个账号，可审计到人。" },
      { h: "生产建议", p: "多管理员环境一律 aaa。password 模式无法区分是谁做的变更。" }
    ],
    run(api, m){
      var sw = api.S.SW1;
      var mode = m[1];
      if(mode === "none"){
        api.say("Error: 生产设备禁止 authentication-mode none（VRP 会拒绝保存该配置）。", "err");
        return;
      }
      var old = sw.vty.authMode;
      sw.vty.authMode = mode;
      api.change("VTY 认证", old, mode, { row: "vty-auth" });
      api.say("// VTY 认证 " + old + " → " + mode +
        (mode === "aaa" ? "。登录时按 AAA 账号校验，认证通过 ≠ 有权限，level 说了算。" : "。登录时只认 VTY 共享密码。"), "op");
      recalc(api.S);
    }
  },
  {
    id: "vty-pwd", match: /^set authentication password (?:cipher|simple) (\S+)$/, view: "vty", kind: "config",
    usage: "set authentication password cipher <密码>",
    run(api, m){
      var sw = api.S.SW1;
      sw.vty.pwd = m[1];
      api.change("VTY 密码", "已更新", "cipher 存储", { row: "vty-auth" });
      api.say("// VTY 密码已更新（cipher 存储，仅 password 认证模式下生效）。", "op");
    }
  },
  {
    id: "proto-in", match: /^protocol inbound (ssh|telnet|all)$/, view: "vty", kind: "config",
    usage: "protocol inbound ssh",
    explain: [
      { h: "入口闸门", p: "VTY 的协议白名单。服务开着、账号也对，协议不在白名单照样进不来。" },
      { h: "三层门槛", p: "SSH 接入要连过三关：stelnet server enable（服务）→ protocol inbound ssh（VTY）→ AAA 账号（认证）。漏任何一关现象都不同。" }
    ],
    run(api, m){
      var sw = api.S.SW1;
      var old = sw.vty.protocol;
      sw.vty.protocol = m[1];
      api.change("VTY 协议", old, m[1], { row: "vty-proto" });
      api.say("// VTY 允许协议 " + old + " → " + m[1] + "。存量不合规会话立即断开。", "op");
      recalc(api.S);
    }
  },
  {
    id: "ssh2", match: /^ssh2 (\d{1,3}(?:\.\d{1,3}){3})$/, view: null, kind: "test",
    usage: "ssh2 192.168.100.1",
    run(api, m){
      var S = api.S;
      var ip = m[1];
      if(ip !== "192.168.100.1"){ api.say("Error: 本实验只演示登录 SW1（192.168.100.1）。", "err"); return; }
      var sw = S.SW1;
      var u = sw.aaa.users["admin"];
      var pwd = u ? u.pwd : "Admin@123";
      api.lines([
        "Info: The first-time fingerprint check.",
        "Server fingerprint: " + (sw.rsa ? sw.rsa.fp : "none"),
        ""
      ], "dim");
      if(!S.flags.sshEverConnected){
        api.say("// 首次连接：没有可信基准，只能带外核对指纹。这就是 TOFU。", "op");
        S.flags.sshEverConnected = true;
      }
      var r = tryLogin(S, "ssh", "admin", pwd);
      if(!r.ok){
        api.lines([
          "Error: Failed to connect to host " + ip + ".",
          "  原因：" + r.why
        ], "err");
        api.play(sshScene(S, "handshake"));
        return;
      }
      api.lines([
        "Warning: trust the fingerprint above? [Y/N]: y",
        "Enter username: admin   Enter password: ***",
        "Info: Session established (AES-256-GCM · curve25519).",
        "",
        "<SW1>",
        ""
      ], "out");
      sw.sessions.push({ user: "admin", proto: "ssh", ip: "192.168.100.10", level: r.level, since: "00:0" + (sw.sessions.length + 1) });
      api.change("会话", "无", "admin · ssh · level " + r.level, { row: "sess-ssh", kind: "enter" });
      api.say("// SSH 会话建立。从密钥交换那一刻起链路就是密文，密码不再明文过网。", "op");
      api.play(sshScene(S, "handshake"));
      api.fx({ kind: "success" });
    }
  },
  {
    id: "telnet-cli", match: /^telnet (\d{1,3}(?:\.\d{1,3}){3})$/, view: null, kind: "test",
    usage: "telnet 192.168.100.1",
    run(api, m){
      var S = api.S;
      var ip = m[1];
      if(ip !== "192.168.100.1"){ api.say("Error: 本实验只演示登录 SW1（192.168.100.1）。", "err"); return; }
      var sw = S.SW1;
      var r = tryLogin(S, "telnet", "admin", sw.vty.authMode === "aaa" ? ((sw.aaa.users["admin"] || {}).pwd || "") : sw.vty.pwd);
      if(!r.ok){
        api.lines([
          "Error: Failed to connect to host " + ip + ".",
          "  原因：" + r.why
        ], "err");
        return;
      }
      api.lines([
        "Trying " + ip + " ... Connected to " + ip + ".",
        "Login password: ***",
        "<SW1>",
        ""
      ], "out");
      sw.sessions.push({ user: "admin", proto: "telnet", ip: "192.168.100.10", level: r.level, since: "00:0" + (sw.sessions.length + 1) });
      api.change("会话", "无", "admin · telnet（明文）", { row: "sess-telnet", kind: "enter" });
      api.say("// Telnet 会话建立。用户名密码都是明文——同一网段抓包即可复现。", "op");
      api.play(sshScene(S, "plain"));
    }
  },
  {
    id: "disp-ssh", match: /^display ssh server status$/, view: null, kind: "doc", usage: "display ssh server status",
    run(api){
      var sw = api.S.SW1;
      api.lines([
        " SSH Server Information",
        "--------------------------------------------------------------",
        " Stelnet Server             : " + (sw.stelnet ? "Enable" : "Disable"),
        " Sftp Server                : Disable",
        " Stelnet Server Port        : " + (sw.stelnet ? "22" : "-"),
        " RSA Server Key             : " + (sw.rsa ? sw.rsa.bits + " bits" : "Absent"),
        " Server Key Fingerprint     : " + (sw.rsa ? sw.rsa.fp : "-")
      ], "out");
      if(!sw.stelnet) api.say("// STelnet 没开，客户端会直接 Connection refused——连认证阶段都到不了。", "op");
    }
  },
  {
    id: "disp-users", match: /^display users$/, view: null, kind: "doc", usage: "display users",
    run(api){
      api.say(showSession(api.S), "out");
    }
  },
  {
    id: "disp-aaa", match: /^display (?:local-user|aaa local-user)$/, view: null, kind: "doc",
    usage: "display local-user",
    run(api){
      var sw = api.S.SW1;
      var names = Object.keys(sw.aaa.users);
      if(!names.length){ api.say("  (no local users)", "dim"); return; }
      var rows = names.map(function(n){
        var u = sw.aaa.users[n];
        return "  " + padEnd(n, 8) + padEnd("level " + u.level, 9) + padEnd(u.service.join("/") || "none", 12) + "pwd: ********(不可逆哈希)";
      });
      api.lines([ "  USER    LEVEL     SERVICE      PASSWORD" ].concat(rows), "out");
    }
  }
];

/* ---------------- 表项 ---------------- */

function tables(S, tab, ctx){
  var sw = S.SW1;
  if(tab === "aaa"){
    var names = Object.keys(sw.aaa.users);
    var rows = names.map(function(n){
      var u = sw.aaa.users[n];
      return { key: "aaa-" + n, cells: [
        { t: n, cls: "c" },
        { t: "level " + u.level, cls: u.level >= 2 ? "ok" : "warn" },
        { t: u.service.join(" / ") || "未配置", cls: u.service.length ? "c" : "bad" },
        { t: "不可逆哈希", cls: "dim" }
      ] };
    });
    return {
      head: ["USER", "LEVEL", "SERVICE-TYPE", "PASSWORD"],
      rows: rows,
      empty: "AAA 里还没有本地用户——Telnet 基线用的是 VTY 共享密码",
      note: "认证（密码对）与授权（level）是两件事：进得来不代表改得动。"
    };
  }
  if(tab === "vty"){
    return {
      head: ["VTY", "认证模式", "允许协议", "说明"],
      rows: [
        { key: "vty-auth", cells: [
          { t: "0 - 4", cls: "c" },
          { t: sw.vty.authMode, cls: sw.vty.authMode === "aaa" ? "ok" : "warn" },
          { t: sw.vty.protocol, cls: sw.vty.protocol === "ssh" ? "ok" : "warn" },
          { t: sw.vty.authMode === "aaa" ? "按 AAA 账号认证" : "共享密码 " + (sw.vty.pwd ? "（已设）" : "（未设，无法登录）"), cls: "dim" }
        ] }
      ],
      empty: "",
      note: "三层门槛的第 2 关：服务开着、账号也对，协议不在 VTY 白名单照样进不来。"
    };
  }
  if(tab === "svc"){
    return {
      head: ["SERVICE", "PORT", "STATE", "说明"],
      rows: [
        { key: "svc-telnet", cells: [
          { t: "Telnet", cls: "c" }, { t: "23", cls: "c" },
          { t: sw.telnet ? "Enable" : "Disable", cls: sw.telnet ? "warn" : "ok" },
          { t: sw.telnet ? "明文协议，尽快关闭" : "已关闭", cls: sw.telnet ? "bad" : "dim" }
        ] },
        { key: "svc-ssh", cells: [
          { t: "STelnet", cls: "c" }, { t: "22", cls: "c" },
          { t: sw.stelnet ? "Enable" : "Disable", cls: sw.stelnet ? "ok" : "warn" },
          { t: sw.rsa ? "加密 + 服务端身份验证" : "需要先创建 RSA 密钥", cls: "dim" }
        ] },
        { key: "svc-rsa", cells: [
          { t: "RSA 密钥", cls: "c" }, { t: "-", cls: "dim" },
          { t: sw.rsa ? sw.rsa.bits + " 位" : "Absent", cls: sw.rsa ? "ok" : "bad" },
          { t: sw.rsa ? "指纹 " + sw.rsa.fp : "SSH 的信任根", cls: "dim" }
        ] }
      ],
      empty: "",
      note: "连接被拒时先看这页：服务层拒绝（Connection refused）和认证层拒绝（Authentication failed）现象完全不同。"
    };
  }
  if(tab === "sess"){
    var rows2 = sw.sessions.map(function(s, i){
      return { key: s.proto === "ssh" ? "sess-ssh" : "sess-telnet", cells: [
        { t: s.user, cls: "c" },
        { t: s.proto, cls: s.proto === "ssh" ? "ok" : "warn" },
        { t: s.ip, cls: "c" },
        { t: "level " + s.level, cls: "c" },
        { t: s.since, cls: "dim" }
      ] };
    });
    return {
      head: ["USER", "PROTO", "SOURCE", "LEVEL", "SINCE"],
      rows: rows2,
      empty: "没有活动会话",
      note: "存量会话会随「服务关闭 / 协议白名单收紧 / 用户删除」被强制断开。"
    };
  }
  return null;
}

/* ---------------- 拓扑 ---------------- */

function topology(S, ui, ctx){
  var sw = S.SW1;
  var lastProto = sw.sessions.length ? sw.sessions[sw.sessions.length - 1].proto : null;
  var sshOn = sw.stelnet && !!sw.rsa;
  var flow = lastProto ? 0.42 : 0;
  var flowColor = lastProto === "telnet" ? "255,181,69" : lastProto === "ssh" ? "56,225,255" : "56,225,255";

  var devices = [
    {
      id: "SW1", x: DEV.SW1.x, y: DEV.SW1.y, w: DEV.SW1.w, h: DEV.SW1.h, model: "S5700-28C-EI",
      silk: "M12 24 h60 M12 28 h44",
      leds: [ { x: 272, y: 10, color: COL.ok, glow: true, label: "PWR", tx: 278, ty: 12.5 } ],
      ports: [
        { name: "GE0/0/1", kind: "rj45", x: 132, y: 44, color: COL.idle, up: true, label: "1" }
      ],
      tags: [
        { x: 0, y: -8, text: "SW1", cls: "dev-label" },
        { x: 34, y: -8, text: "Vlanif100 192.168.100.1/24 · 管理", cls: "dev-sub" }
      ]
    }
  ];
  var hosts = Object.keys(HOSTS).map(function(id){
    var h = HOSTS[id];
    return { id: id, x: h.x, y: h.y, ip: h.ip, mac: h.mac, vlan: null, color: COL.ok, up: true };
  });
  var links = [
    { id: "lk-mgmt", d: LINK_D, cls: "", flow: flow, flowColor: flowColor }
  ];
  var labels = [];
  if(sw.telnet && !sw.stelnet){
    labels.push({ text: "Telnet · 明文", x: 745, y: 160, anchor: "middle", cls: "lk-tag warn" });
  }else if(sshOn && lastProto === "ssh"){
    labels.push({ text: "SSH · 密文", x: 745, y: 160, anchor: "middle", cls: "lk-tag on" });
  }else if(sw.stelnet){
    labels.push({ text: "SSH 22 · 待接入", x: 745, y: 160, anchor: "middle", cls: "lk-tag" });
  }else{
    labels.push({ text: "TCP 23 · Telnet", x: 745, y: 160, anchor: "middle", cls: "lk-tag" });
  }
  return {
    viewBox: "0 0 1400 300",
    devices: devices, hosts: hosts, links: links,
    routes: { "pc-r": LINK_D, "pc-l": "M703 114 L697 200" },
    anchors: { "SW1/GE0/0/1": [703, 93] },
    labels: labels
  };
}

/* ---------------- 引导 ---------------- */

function guide(S, ctx){
  var sw = S.SW1;
  var G = function(phase, why, cmd){ return { phase: phase, why: why, cmd: cmd || "" }; };

  if(ctx.view === "user"){
    if(sw.telnet && !sw.rsa) return G("verify", "先体验一次 Telnet 明文登录，再开始改造。", "telnet 192.168.100.1");
    return G("enter", "用户视图只能看。改配置先 system-view。", "system-view");
  }
  if(ctx.view === "aaa"){
    var u = sw.aaa.users["admin"];
    if(!u) return G("auth", "先建账号密码（不可逆加密存储）。", "local-user admin password irreversible-cipher Admin@123");
    if(u.service.indexOf("ssh") < 0) return G("auth", "账号还没允许 SSH 接入。", "local-user admin service-type ssh");
    if(u.level < 15) return G("auth", "把 admin 提到 level 15，否则 system-view 进不去。", "local-user admin privilege level 15");
    return G("auth", "账号齐了。quit 退回系统视图。", "quit");
  }
  if(ctx.view === "vty"){
    if(sw.vty.authMode !== "aaa") return G("auth", "VTY 还在用共享密码，改成 AAA 才能审计到人。", "authentication-mode aaa");
    if(sw.vty.protocol !== "ssh") return G("auth", "VTY 协议白名单收紧到 ssh——这是三层门槛的第二关。", "protocol inbound ssh");
    return G("auth", "VTY 配齐。quit 退回系统视图。", "quit");
  }
  /* system 视图 */
  if(!sw.rsa) return G("keys", "SSH 的信任根：先生成 RSA 密钥对。", "rsa local-key-pair create");
  if(!sw.stelnet) return G("keys", "密钥有了，开 STelnet 服务（TCP 22）。", "stelnet server enable");
  if(!Object.keys(sw.aaa.users).length) return G("auth", "进 AAA 视图建账号。", "aaa");
  if(sw.vty.authMode !== "aaa" || sw.vty.protocol !== "ssh") return G("auth", "进 VTY 把认证模式与协议配齐。", "user-interface vty 0 4");
  if(sw.telnet) return G("harden", "SSH 已闭环。把明文的 Telnet 关掉，完成加固。", "undo telnet server enable");
  return G("verify", "全部就绪。用 ssh2 实际登录验证，再看 display ssh server status。", "ssh2 192.168.100.1");
}

/* ---------------- 板块 ---------------- */

const steps = [
  {
    id: 1, name: "基线 · Telnet 明文", key: true, keepTrace: true,
    run: function(api){ api.run(["telnet 192.168.100.1", "display users"]); },
    summary: "Telnet 能登录，但用户名密码全部明文过网",
    detail: [
      { h: "能通 ≠ 安全", p: "Telnet 的可用性没有问题，问题在旁路：同一网段任何一台机器抓包都能拿到管理员凭据。" },
      { h: "为什么先体验", p: "先看到明文长什么样，后面每一道 SSH 配置才有对照意义。" }
    ]
  },
  {
    id: 2, name: "生成 RSA 密钥",
    done: function(S){ return !!S.SW1.rsa; },
    run: function(api){ api.setDev("SW1"); return api.run(["system-view", "rsa local-key-pair create"]); },
    summary: "2048 位密钥对生成，指纹 8f:2a:…:c1",
    detail: [
      { h: "信任根", p: "服务端用私钥签名证明身份，客户端拿公钥验证。指纹就是这把公钥的哈希。" },
      { h: "记台账", p: "把指纹登记进资产台账。以后客户端报警「指纹变了」，才有判断依据。" }
    ]
  },
  {
    id: 3, name: "开启 STelnet",
    done: function(S){ return S.SW1.stelnet; },
    run: function(api){ return api.run(["stelnet server enable"]); },
    summary: "TCP 22 开始监听",
    detail: [
      { h: "顺序约束", p: "VRP 要求先有 RSA 密钥才能 enable——没有密钥，握手第一步就进行不下去。" },
      { h: "和 Telnet 并存", p: "此时 22 和 23 同时开着：旧方式还能用，新方式已就绪，平滑切换。" }
    ]
  },
  {
    id: 4, name: "AAA 本地账号",
    done: function(S){
      var u = S.SW1.aaa.users["admin"];
      return !!(u && u.level >= 15 && u.service.indexOf("ssh") >= 0);
    },
    run: function(api){
      return api.run(["aaa",
        "local-user admin password irreversible-cipher Admin@123",
        "local-user admin privilege level 15",
        "local-user admin service-type ssh",
        "quit"]);
    },
    summary: "admin 账号：不可逆密码、level 15、只允许 ssh",
    detail: [
      { h: "三件套", p: "密码（认证凭据）+ level（授权边界）+ service-type（接入方式白名单）。缺一件，登录表现都不同。" },
      { h: "审计到人", p: "AAA 模式下每个会话都有账号。共享密码的 VTY 出了事查不到人。" }
    ]
  },
  {
    id: 5, name: "VTY：认证与协议",
    done: function(S){ return S.SW1.vty.authMode === "aaa" && S.SW1.vty.protocol === "ssh"; },
    run: function(api){
      return api.run(["user-interface vty 0 4", "authentication-mode aaa", "protocol inbound ssh", "quit"]);
    },
    summary: "VTY 切 AAA 认证，协议白名单收紧到 ssh",
    detail: [
      { h: "三层门槛", p: "第 2 关在这里：服务开着、账号也对，VTY 协议白名单不放过照样进不来。" },
      { h: "存量会话", p: "protocol inbound ssh 生效的瞬间，还在跑的 Telnet 会话被强制断开。" }
    ]
  },
  {
    id: 6, name: "首次连接 · TOFU 指纹", key: true, keepTrace: true,
    run: function(api){ api.run(["ssh2 192.168.100.1"]); },
    summary: "客户端核对服务器指纹后信任，会话建立",
    detail: [
      { h: "TOFU", p: "第一次连接没有可信基准，指纹核对靠人。生产设备第一次就盲选 yes 是大忌。" },
      { h: "之后每次", p: "指纹存进 known_hosts，之后每次连接自动比对。变了就报警，不问原因不点继续。" }
    ]
  },
  {
    id: 7, name: "握手与认证阶段",
    run: function(api){ api.run(["display ssh server status", "display users"]); },
    summary: "版本协商 → 密钥交换 → 服务端签名 → 加密通道内认证",
    detail: [
      { h: "加密起点", p: "对称会话密钥在密钥交换阶段就生成了，用户认证发生在加密通道内——密码永远不明文过网。" },
      { h: "对照抓包", p: "同样的抓包点，Telnet 能看到 admin / Huawei@123，SSH 只能看到密文长度。" }
    ]
  },
  {
    id: 8, name: "对照诊断 · 关掉 Telnet", key: true, keepTrace: true,
    done: function(S){ return S.SW1.telnet === false; },
    run: function(api){
      return api.run(["undo telnet server enable", "telnet 192.168.100.1", "ssh2 192.168.100.1", "display ssh server status"]);
    },
    summary: "Telnet 被拒在服务层（refused），SSH 正常——两种拒绝现象不同",
    detail: [
      { h: "拒绝的层次", p: "Connection refused = 服务没监听（第 1 关）；被 VTY 挡 = 协议白名单（第 2 关）；Authentication failed = 账号问题（第 3 关）。排障先分层。" },
      { h: "加固完成", p: "Telnet 关闭后，管理面只剩加密通道。这一步之后才敢说设备是安全的。" }
    ]
  },
  {
    id: 9, name: "权限级别 · 认证 ≠ 授权", key: true, keepTrace: true,
    done: function(S){ return S.flags.sawDeny && S.SW1.aaa.users["admin"] && S.SW1.aaa.users["admin"].level === 15; },
    run: async function(api){
      await api.run(["aaa", "local-user admin privilege level 1", "quit"]);
      await api.run(["ssh2 192.168.100.1"]);
      api.say("// admin 重新登录成功——但试试进系统视图：", "op");
      api.lines(["<SW1>system-view", "Error: You do not have permission to run the command."], "err");
      api.S.flags.sawDeny = true;
      await api.run(["aaa", "local-user admin privilege level 15", "quit"]);
    },
    summary: "level 1 登录成功但 system-view 被拒；改回 15 恢复",
    detail: [
      { h: "两件事", p: "认证（密码对，进得来）和授权（level 够，改得动）是独立的关卡。把 level 调低不会阻止登录，只会限制命令。" },
      { h: "分级", p: "0（诊断）～ 15（超管）。system-view 至少 level 2。值班账号给低 level，管理账号才给 15。" }
    ]
  }
];

/* ---------------- 其它导出 ---------------- */

function viewRows(ctx){
  if(ctx.view === "aaa"){
    return [
      { h: "AAA 视图", p: "local-user 建账号：密码、level、service-type 三件套。" },
      { h: "删账号", p: "undo local-user admin 会同时断开该用户的存量会话。" }
    ];
  }
  if(ctx.view === "vty"){
    return [
      { h: "VTY 视图", p: "authentication-mode、protocol inbound、ACL 都在这配。" },
      { h: "三层门槛", p: "服务（stelnet enable）→ 协议（protocol inbound ssh）→ 认证（AAA 账号）。" }
    ];
  }
  if(ctx.view === "system"){
    return [
      { h: "SSH 三步", p: "RSA 密钥 → stelnet server enable → AAA 账号 + VTY。" },
      { h: "加固", p: "SSH 闭环后，undo telnet server enable 关掉明文通道。" }
    ];
  }
  return [
    { h: "用户视图", p: "ssh2 / telnet 实测登录，display ssh server status / display users 查看状态。" },
    { h: "测试命令", p: "登录测试用的是 Admin 主机视角的 ssh2 / telnet，不是设备配置命令。" }
  ];
}

function boot(write, printGuide){
  write("// 实验 12 · SSH 远程管理", "op");
  write("// 管理 PC 192.168.100.10 → SW1 Vlanif100 192.168.100.1。", "op");
  write("// 基线：Telnet 开着，能登录，但用户名密码明文过网。", "op");
  write("// 目标：RSA 密钥 → STelnet → AAA 账号 → VTY 四步闭环，关掉明文通道。", "op");
  write("// 简化：密钥交换为示意，抓包对比用「明文 / 密文」文字表示。", "op");
  write("", "dim");
  printGuide();
}

export default {
  id: "12",
  title: "SSH 远程管理",
  meta: "HUAWEI S5700 · VRP V200R005C00",
  stageLabel: "SECURE SHELL · STELNET + AAA + VTY",
  totalSteps: steps.length,

  devices: ["SW1"],
  tabs: [
    { key: "svc", label: "服务状态", hint: "Telnet / STelnet / RSA" },
    { key: "aaa", label: "AAA 用户", hint: "本地账号" },
    { key: "vty", label: "VTY 配置", hint: "认证与协议" },
    { key: "sess", label: "会话", hint: "当前登录" }
  ],
  legend: [
    { c: "#38E1FF", label: "SSH · 加密会话" },
    { c: "#FFB545", label: "Telnet · 明文会话" },
    { c: "#35E08A", label: "服务开启" },
    { c: "#FF4D5E", label: "服务关闭 / 缺密钥" }
  ],
  phases: { enter: "进系统视图", keys: "密钥与服务", auth: "AAA 与 VTY", harden: "关闭明文", verify: "校验" },
  viewName: VIEW_NAME,
  viewHint: VIEW_HINT,

  actions: [
    { id: "ssh", label: "ssh2 登录", run: function(l){ l.execute("ssh2 192.168.100.1"); } },
    { id: "telnet", label: "telnet 登录", run: function(l){ l.execute("telnet 192.168.100.1"); } },
    { id: "status", label: "服务状态", run: function(l){ l.execute("display ssh server status"); } }
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
      { h: "① 三层门槛", p: "SSH 接入被拒时先分层：服务没监听 / VTY 协议挡住 / 认证失败，现象完全不同。" },
      { h: "② 信任链", p: "RSA 密钥 = 信任根，指纹 = 人能核对的那一环。TOFU 只该发生一次，且要带外确认。" },
      { h: "③ 认证 ≠ 授权", p: "密码对了只代表进得来，能执行什么由 level 决定。值班账号别给 15。" },
      { h: "④ 审计", p: "AAA 模式下会话有账号，出了变更查得到人。共享密码模式做不到。" },
      { h: "⑤ 明文即风险", p: "Telnet 的每个字节都能被旁路抓到。SSH 闭环的第一件事就是关掉它。" }
    ]
  }
};
