# 实验模块编写约定（LAB-SPEC）

一个实验 = `src/labs/labXX.js` **一个文件**，导出纯数据 + 纯函数，不碰 DOM、不引组件。
运行时（`src/composables/useLab.js`）负责命令解析、视图校验、表项高亮、时间轴、板块判定、引导打印、撤回。

参考实现（必读，照着写）：
- `src/labs/lab01.js` — 命令表 / 表项 / 拓扑 / 引导 / 板块 的标准写法
- `src/labs/lab03.js` — 故障扰动、哈希分流、多成员链路

---

## 1. 导出的对象

```js
export default {
  id: "02",                         // 两位数字符串
  title: "STP 选举与收敛",
  meta: "HUAWEI S5700 · VRP V200R005C00",
  stageLabel: "L2 LOOP PREVENTION · 3 × S5700",
  totalSteps: steps.length,

  devices: ["SW1", "SW2", "SW3"],   // ctx.dev 的取值集合，第一个是默认设备
  tabs:    [{ key: "port", label: "端口状态", hint: "STP 端口状态" }, ...],  // tabs[0] 是默认页
  legend:  [{ c: "#35E08A", label: "Root" }, ...],                          // 表项面板底部图例
  phases:  { enter: "进系统视图", elect: "改优先级", verify: "校验" },       // 引导行里显示的中文阶段名
  viewName:{ user: "用户视图", system: "系统视图", if: "接口视图" },
  viewHint:{ system: "system-view", if: "interface GigabitEthernet 0/0/1" }, // 每个受限视图都要有

  actions: [                        // 现象层面板底部按钮
    { id: "ping", label: "PC1 → PC2", run: l => l.playScene(pingScene(l.S)) }
  ],

  createState, prompt, commands, tables, topology, guide, steps,
  idle: { title: "判读顺序", items: [{ h: "① ...", p: "..." }] },
  viewRows(ctx){ return [{ h, p, cls }]; },
  boot(write, printGuide){ ... }
};
```

## 2. 状态

`createState()` 返回一个**纯对象**，运行时用 `reactive()` 包起来。命令里直接改它：

```js
export function createState(){
  return { SW1: makeSwitch("SW1"), SW2: makeSwitch("SW2") };
}
```

- 状态就是唯一事实来源：表项、拓扑、引导、板块判定全部从它派生
- 不要存 DOM、不要存定时器、不要存函数

## 3. 视图与提示符

`ctx = { dev, view, ifName }`，`view` 取 `"user" | "system" | "if"`（需要更多就自己加，如 `"trunk"`）。

```js
function prompt(ctx){
  if(ctx.view === "user")   return "<" + ctx.dev + ">";
  if(ctx.view === "system") return "[" + ctx.dev + "]";
  return "[" + ctx.dev + "-GE" + String(ctx.ifName).replace("GigabitEthernet", "") + "]";
}
```

## 4. 命令表

```js
const commands = [
  {
    id: "stp-priority",
    match: /^stp priority (\d+)$/,   // 必须带 ^...$，运行时用 stateless() 去 g 标志后 test
    view: "system",                  // null = 任何视图；否则 ctx.view 必须等于它
    kind: "config",                  // "view" | "config" | "doc" | "test"
    usage: "stp priority <4096>",    // Tab 补全用；占位写 <> 里
    explain: [{ h: "改的是哪张表", p: "..." }],   // 可选：命令被接受但没变化时的解读
    run(api, m, line){ ... }
  }
];
```

`api` 可用方法：

| 方法 | 作用 |
| --- | --- |
| `api.S` / `api.ctx` / `api.clock` | 状态 / 视图 / 时间轴 |
| `api.say(text, kind)` | 写终端一行，kind：`out dim info ok err op` |
| `api.lines([...], kind)` | 批量写 |
| `api.change(key, from, to, { row, kind })` | 记一条表项变更（现象层显示 `from → to`，并高亮 row 对应的表行） |
| `api.tab(key)` | 切到某个表项页 |
| `api.fx({ kind, ... })` | 拓扑动效：`pulse`（端口涟漪，需 `target:"SW1/GE0/0/1"`）、`scan`（面板扫描，需 `box:[x,y,w,h]`）、`beam`（链路光带，需 `route:"trunk-r"`）、`chip`（标签沿链路飞，需 `route,text`）、`success` |
| `api.play(scene)` | 播放数据面场景（见 §7） |
| `api.setDev(dev)` | 切设备（会重置到用户视图并写一行提示） |
| `api.run([cmd,...])` | 连敲一串命令（异步，可 await） |
| `api.after(ms, fn)` | 延时 |
| `api.toast({title, text})` | 顶部提示条 |

**准确性红线**：
- 真实 VRP 上成功的配置命令是**静默**的，不要自造 `Info: xxx 成功` 回显
- 讲解内容统一用 `api.say("// ...", "op")`，与设备回显区分
- 不编造命令、不编造报错。模拟器不支持的参数就不实现，并在 `explain` 里说明

## 5. 表项

```js
function tables(S, tab, ctx){
  const sw = S[ctx.dev];
  if(tab === "port"){
    return {
      head: ["PORT", "ROLE", "STATE", "COST"],
      rows: Object.keys(sw.ports).map(pn => ({
        key: "p-" + pn,                       // change() 里的 row 用这个 key 才能高亮
        cells: [
          { t: pn, cls: "c" },
          { t: sw.ports[pn].role, cls: "ok" },
          { t: sw.ports[pn].state, cls: "c" },
          { t: sw.ports[pn].cost, cls: "c" }
        ]
      })),
      empty: "还没收敛",                       // rows 为空时显示
      note: "可选的脚注"
    };
  }
}
```

单元格允许的 `cls`：`c`（等宽）、`v1/v10/v20`（VLAN 配色）、`ok`、`warn`、`bad`、`drop`、`dim`。

## 6. 拓扑

```js
function topology(S, ui, ctx){
  return {
    viewBox: "0 0 1400 300",
    devices: [{
      id: "SW1", x: 70, y: 62, w: 300, h: 74, model: "S5700-28C-EI",
      silk: "M12 24 h60 M12 28 h44 M12 32 h60 M12 36 h44",
      leds: [{ x: 272, y: 10, color: "#35E08A", glow: true, label: "PWR", tx: 278, ty: 12.5 }],
      ports: [{
        name: "GE0/0/1", kind: "rj45",     // "rj45" | "sfp"
        x: 110, y: 44,                     // 相对设备左上角的坐标
        color: "#38E1FF", up: true, label: "1", dimBand: false
      }],
      tags: [{ x: 0, y: -8, text: "SW1", cls: "dev-label" }]
    }],
    hosts: [{ id: "PC1", x: 100, y: 200, ip: "192.168.10.10", mac: "5489-98a1-0001", vlan: 10, color: "#38E1FF", up: true }],
    links: [{
      id: "lk-1", d: "M370 115 L1040 115",
      cls: "trunk on",                    // "" | "active" | "trunk" | "trunk on" | "down"
      flow: 1,                            // 0~1 流量强度，0 = 不显示粒子
      flowColor: "56,225,255"             // "r,g,b"
    }],
    routes: { "trunk-r": "M370 115 L1040 115" },   // 供场景/动效按 key 引用
    anchors: { "SW1/GE0/0/1": [110, 106] },        // pulse 动效的锚点（绝对坐标）
    labels: [{ text: "ROOT", x: 700, y: 100, anchor: "middle", cls: "lk-tag on" }]
  };
}
```

- `routes` 里的 path **必须**与 links/hosts 的位置一致；场景里的 `route` 只能引用 `routes` 里注册过的 key
- 设备面板：`y: 62, h: 74`；RJ45 端口相对 y = 44，SFP 也是 44，宽 42
- 主机：`y: 200`，机箱 66×46，下方依次是 MAC、VLAN 文本
- 链路 `flow` 用来驱动流量粒子：链路真的在转发数据时才 > 0

## 7. 现象层场景（数据面）

```js
export function pingScene(S){
  return {
    name: "PC1 → PC2 · 三层转发",
    dur: 1,
    traceTitle: "逐跳判读",
    frames: [
      { route: "pc1-up", t0: 0, t1: .18, kind: "broadcast", vlan: 10 },
      { route: "trunk-r", t0: .2, t1: .5, kind: "data", tagged: true, vlan: 10 }
    ],
    drop: { route: "trunk-r", p: .96, at: .5, label: "DENY · ACL 3000" },
    trace: [{ h: "① 源主机判路", p: "...", cls: "" }],
    verdict: { bad: false, text: "..." }   // bad:true 时红色显示
  };
}
```

`t0/t1` 是 0~1 的时间比例；`drop.at` 是出现丢弃标记的时间点。

## 8. 引导

从状态反推「下一条该敲什么」，不记录用户输入过什么：

```js
function guide(S, ctx){
  const G = (phase, why, cmd) => ({ phase, why, cmd: cmd || "" });
  if(ctx.view === "user") return G("enter", "用户视图只能看。改配置先 system-view。", "system-view");
  if(ctx.view === "system"){
    if(S.SW1.priority !== 4096) return G("elect", "把 SW1 的桥优先级调低，它才会被选成根桥。", "stp priority 4096");
  }
  return G("verify", "配置齐了，用 display 命令核对。", "display stp brief");
}
```

返回 `null` 表示没有更多建议。`phase` 必须在 `phases` 里有对应中文。

## 9. 板块

```js
const steps = [
  {
    id: 1, name: "基线 · 没有优先级",
    done: S => S.SW1.priority === 32768,     // 可选：状态谓词，开会自动判定
    run: api => api.run(["display stp brief"]),
    summary: "三台桥优先级相同，MAC 最小的当根",
    detail: [{ h: "为什么", p: "..." }]      // 完成面板里的判读条目
  },
  { id: 7, name: "测试 · 应该失败", key: true, keepTrace: true, run: api => api.play(scene(api.S)) }
];
```

- `key: true` 标出关键板块（步骤条上虚线框）
- `keepTrace: true` 用于测试/扰动板块：完成面板不覆盖逐跳判读
- `done` 缺省时，点击即算完成

## 10. 硬性要求

1. **只写你被分配的这一个文件**。不要改 `useLab.js`、组件、样式、`index.js`、`build.mjs`
2. 不要运行 `npm run build` / `npm run dev`（会和其它并行任务抢资源）
3. 全部文案用简体中文；命令、回显、字段名保持 VRP 原文
4. `steps.length` 必须等于分配给你的板块数，且与首页元数据一致
5. 每个实验至少有一个「配了一半反而不通」的反直觉节点和一个扰动场景
6. 简化模型（如 LACP 稳态判定、SPF 计算）要在页面文案里明确标注是简化
7. 文件末尾 `export default { ... }`，不要额外导出运行时不需要的东西（供测试的 scene 函数可以导出）
