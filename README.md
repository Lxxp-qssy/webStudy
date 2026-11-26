# NETLAB

面向零基础网络工程师的「配置 → 机制 → 现象」可视化实验台。
每个实验都在讲同一件事：**敲完一条命令，设备内部改了哪张表，网络上出现了什么结果。**

---

## 交付物

构建产物在 `dist/`，三个文件，各自**完全自包含**（Vue 运行时、样式、逻辑全部内联）：

| 文件 | 说明 |
| --- | --- |
| `dist/index.html` | 首页 · 12 个实验索引 · 学习进度 |
| `dist/lab-01.html` | 实验 01 · VLAN 与 Trunk（11 个板块） |
| `dist/lab-03.html` | 实验 03 · 链路聚合 Eth-Trunk（12 个板块） |

断网、双击即开，不发任何外部请求。根目录下的 `index.html` / `lab-01.html` / `lab-03.html` 是
Vite 的**源入口**，直接用浏览器打开会看到一句提示，不是故障。

## 开发

```bash
npm install
npm run dev        # 本地开发（热更新）
npm run build      # 产出 dist/，并自检「零外部引用」
```

构建脚本 `scripts/build.mjs` 逐页构建。多个入口一起构建时 Rollup 会把公共 chunk 拆出去，
而独立 chunk 在 `file://` 下会被 CORS 拦掉——所以一页一次构建，保证产物真的能双击打开。
构建结束会自动扫描产物里是否还有 `<script src>` / `<link href>` 外链，有则失败。

## 目录

根目录只有四个文件夹 + 配置文档。**入口全部在 `entries/`**（每个实验一对 html + js 薄壳，统一走 `lib/mountApp.js` 装配）；`src/` 是纯应用代码，不掺杂入口。

```
entries/                 页面入口（npm run dev 直接打开 entries/lab-XX.html）
├─ index.html + home.js  首页
└─ lab-XX.html + labXX.js × 12   实验入口薄壳

src/
├─ composables/
│   ├─ useLab.js           实验运行时：命令分发、表项高亮、时间轴、板块判定、引导、撤回
│   └─ useParticles.js     链路流量粒子（canvas，按 link.flow 驱动）
├─ components/
│   ├─ PaneFrame.vue       面板骨架：标签 / 标题 / 右侧操作 / 底部（三个面板共用）
│   ├─ TopologyGraph.vue   SVG 拓扑渲染（设备 / 主机 / 链路 / 数据帧 / 命令动效）
│   ├─ TerminalPane.vue    命令层：终端、引导行、完成卡片、步骤条、Tab 补全
│   ├─ TablePane.vue       机制层：表项与行高亮
│   ├─ WhyPane.vue         现象层：diff / 判读 / 报错 / 完成
│   ├─ TimeBar.vue         时间轴：播放、单步、重放、拖拽、调速
│   ├─ BootVeil.vue        启动遮罩：上电仪式（1.1s 自动退场）
│   ├─ ParticlesBg.vue     动态背景：tsParticles 网络星图（低速节点 + 近距连线，零交互）
│   └─ Toast.vue           板块完成提示条
├─ labs/
│   ├─ lab01.js … lab12.js 实验定义（纯数据 + 规则，不含 DOM），一实验一文件
│   └─ index.js            实验清单元数据（首页与进度共用）
├─ views/{LabView,HomeView}.vue
├─ lib/{util,store,mountApp}.js  工具函数、进度存取、统一装配线（tsParticles 插件 + 全局样式）
└─ styles/{app,motion}.css 基础样式 / 动效层
```

新增实验只需三步：`entries/` 放一对 html+js（照抄现有薄壳）、`src/labs/` 写实验定义、`src/labs/index.js` 登记——契约见 **LAB-SPEC.md**。构建在 `scripts/build.mjs` 的 PAGES 数组加一行。


## 实验清单

| # | 实验 | 层 | 状态 |
| --- | --- | --- | --- |
| 01 | VLAN 与 Trunk | 二层 | 已交付 · 11 板块 |
| 02 | STP 选举与收敛 | 二层 | 已交付 · 10 板块 |
| 03 | 链路聚合 Eth-Trunk | 二层 | 已交付 · 12 板块 |
| 04 | VLAN 间路由 | 三层 | 已交付 · 10 板块 |
| 05 | 静态路由 | 三层 | 已交付 · 9 板块 |
| 06 | OSPF 邻居与选路 | 三层 | 已交付 · 12 板块 |
| 07 | DHCP 四步交互 | 服务 | 已交付 · 10 板块 |
| 08 | NAT / NAPT | 服务 | 已交付 · 11 板块 |
| 09 | ACL 包过滤 | 服务 | 已交付 · 10 板块 |
| 10 | VRRP 主备切换 | 高可用 | 已交付 · 10 板块 |
| 11 | 堆叠 / iStack | 高可用 | 已交付 · 11 板块 |
| 12 | SSH 远程管理 | 高可用 | 已交付 · 9 板块 |

新增实验的完整契约见 **LAB-SPEC.md**：一个实验 = 一个 labs 文件 + 一个入口，运行时、组件、样式全部复用。

## 一个实验由什么组成

`src/labs/lab01.js` 这种文件是**纯描述**，运行时负责把它变成可交互的页面：

| 字段 | 作用 |
| --- | --- |
| `createState()` | 设备初始状态（响应式，命令直接改它） |
| `commands[]` | 命令表：正则 + 所属视图 + 执行体；运行时统一做视图校验与报错归类 |
| `tables(S, tab)` | 表项模型，从状态派生，状态一变表就重算 |
| `topology(S, ui)` | 拓扑渲染模型：端口颜色、链路状态、标签、测长路由、锚点 |
| `guide(S, ctx)` | 引导：从状态反推「下一条该敲什么」，返回 `{phase, why, cmd}` |
| `steps[]` | 板块：`run` 是演示脚本，`done(S)` 是目标判定——达成即自动完成 |

新增一个实验 = 新增一个 `labs/labXX.js` + 一个 HTML 入口 + 一行页面入口，
其余（终端、表项、现象层、时间轴、动效、进度）全部复用。

## 三层模型

```
命令层 execute(line)      命中命令表 → 改 S（响应式状态）
机制层 tables(S, tab)     从 S 派生表项，diff 驱动行高亮与进出场动画
现象层 scene + frames     帧位置 = f(clock.t)，是时间的纯函数，因此时间轴可任意拖回
```

## 动效的做法

- **表项**：行 `class` 在 `enter / chg` 间切换触发 keyframes
- **拓扑**：端口色带 `fill` 过渡，链路 `stroke` 过渡，LED 呼吸
- **命令**：运行时把命令副作用翻译成 fx 基元 —— `pulse`（端口涟漪）、`chip`（VLAN 标签沿干道飞行，`offset-path`）、`beam`（链路上跑一道光）、`scan`（设备面板扫描）
- **板块完成**：终端绿色卡片 + 顶部 toast + 步骤条打勾 + 拓扑层 `success` 闪光
- **面板**：现象层切换走 `<Transition>`，保持阅读位置不跳
- **启动**：`BootVeil` 上电遮罩，网格展开 + 进度线 + 三行状态依次点亮，1.1s 自动退场（`prefers-reduced-motion` 直接跳过）
- **HUD**：舞台右上角 `NODES / LINKS / FLOW` 实时读数，`FLOW` 是当前有流量的链路数，直接由 `topo.links` 派生
- **骨架**：三个工作面板共用 `PaneFrame`（标签 / 标题 / 右侧操作 / 底部插槽），四角有 HUD 角标，标题下有一条展开式高光

> 坑：SVG 元素上的 CSS `transform` 动画会覆盖 `transform` 属性。带位移的组要用外层 `<g transform>` 包一层，动画只作用在内层。

## 撤回（Alt+Z）

顶栏 `撤回` 按钮 / `Alt+Z`，一次退一个**操作**：

- 手敲的命令：每条真正改了设备状态的命令一个撤销点。只读命令、重复执行到目标值的命令、切视图命令（`system-view` / `interface` / `quit`）都不入栈——否则配完一串按撤回，先撤掉的是一条切视图命令，看起来像没反应。
- 板块按钮：脚本里的多条命令**折叠成一步**（`runStep` 跑完把中间快照截断，只留板块前的那一份）。
- 演示按钮：同样一个撤销点（`runGroup`）。

快照存的是「看得见的一切」：`S`、视图与提示符、已完成板块、终端行数、时间轴场景、现象层面板。`undo()` 会截断终端到当初那一行、回滚表项、把提示符和时间轴一起退回去，然后打一张琥珀色的撤回卡片——和绿色的「板块完成」区分开。

> 视图命令用 `S` 的指纹判断是否入栈，所以 `system-view` 这种「只改提示符」的操作不占撤销位；撤回时视图跟着快照一起回退。

> `Ctrl+Z` 没有给撤回用：VRP 里它就是 `return`（`system-view` 的回显原文就写着 "return user view with Ctrl+Z"）。终端里按 `Ctrl+Z` 走设备语义，撤回用 `Alt+Z`，两套语义不打架。

## 粒子层 = 链路流量

`src/composables/useParticles.js`。舞台上**没有装饰粒子** —— 每一颗光点都代表一条链路当前真的在转发，所以它的出现/消失直接等于「命令把两端打通了没有」。

数据来自 `model.links[].flow`（0 或 0.3~1 的强度）与 `flowColor`：

| 情况 | flow |
| --- | --- |
| lab-01 干道：两端都 trunk、都 up、allow 有交集（VLAN 1 不算） | 1 |
| lab-01 干道：只配了一端 / 少放行一个 VLAN | 0 |
| lab-01 接入链路：端口 up | 0.42 |
| lab-03 成员链路：Selected | 1 |
| lab-03 成员链路：Unselect / 拔线 | 0 |

- 光点数量按时长算（`len/170`，1~5 颗），强度高的跑得快；沿 `#links path.link` 用 `getTotalLength`/`getPointAtLength` 实时取点，曲线也贴线跑
- 点沿法线偏 3px 画在描边外侧，否则会被 SVG 的线盖住
- 打通瞬间淡入 600ms，断开后残留 400ms 淡出
- canvas 在 SVG 下面（`.topo-particles` z0 / `#topo` z1），面板与文字永远压住粒子
- DPR 封顶 2；`document.hidden` 暂停；`prefers-reduced-motion` 只画一帧静帧；只在 `flow` 变化时重建，其余帧只推进位置

舞台左下角有图例：`● 光点 = 当前链路流量，配置打通才出现`。

> 坑：不要用 `animation` 给 SVG 组做位移，会和 `transform` 属性打架（见上一条）。粒子走 canvas 就是为了绕开这层。

## Tab 补全

终端里 `Tab` 按当前视图 + 已输入前缀补全，逻辑在 `useLab.complete()`：

- 空输入 → 列出**当前视图**所有可用命令（比翻文档快，也顺手教了视图边界）
- 唯一命中 → 补到占位或参数值之前（`int` → `interface GigabitEthernet`，端口号不替你猜）
- 多个命中 → 先补公共前缀，补不动了在终端列候选
- 当前视图里没有 → 说清楚原因（`「port」在用户视图里没有匹配；配置命令要先 system-view`）

`Ctrl+Z` 是设备语义（`return`），撤销用 `Alt+Z`，两套不打架。

## 一屏

实验页固定一屏，页面本身不滚动：`.page` 是 `flex column + height:100dvh`，舞台按 SVG 比例占高，三栏 `flex:1` + `grid-auto-rows:minmax(0,1fr)`，终端 / 表项 / 现象层各自内部滚动。矮于 760px 的窗口自动退回可滚动布局，不硬挤。

## 进度条是什么

顶栏 `板块 3 / 11` 是**板块完成度**，不是配置进度：一格 = 一个板块（`def.steps`），亮起表示该板块的目标状态判定通过（`steps[].done(S)` 谓词），当前正在做的板块半亮呼吸。hover 有 `title` 列出已完成板块名。判定和数据都在 `useLab.checkSteps()`，命令改了状态就会重判，所以撤回会让格子跟着灭掉。

## 准确性约定

- 成功配置命令在 VRP 上是**静默**的，不自造回显；讲解内容统一用 `//` 前缀的灰色注释行
- 命令、回显、报错文案以华为 VRP V200R005 为主，标注机型
- 简化模型在页面里明确标注：LACP 只实现「收敛后稳态判定」，不模拟逐 tick 状态机；哈希用 FNV-1a 折叠五元组，真实设备是芯片 SIP-XOR-DIP
- 不编造命令、不编造报错、不编造性能数字

## 布局与自适应

布局不锁中轴，宽度随窗口走：

| 区域 | 规则 |
| --- | --- |
| 首页 `.wrap` | `max-width:1880px` + `padding: 0 clamp(16px,3.2vw,64px)` |
| 首页 hero | ≥1180px 两栏（文案 / 三层联动示意），以下堆叠 |
| 实验索引 | 每组一个 block，`auto-fit minmax(660px,1fr)` → 宽屏两组并排，窄屏单列；组内卡片 `auto-fit minmax(218px,1fr)` |
| 学习进度 | `auto auto 1fr` 横带，<860px 转纵排 |
| 实验页 `.shell` | `max-width:2000px` + `padding:12px clamp(12px,1.5vw,28px)`，固定一屏，三栏内部滚动 |
| 工作区 | 三栏 → ≤1280 两栏（现象层满宽）→ ≤860 单栏 |

> 坑：`src` 入口页里的占位提示样式会**原样进入构建产物**。早期版本给 `body` 加了 `display:flex;align-items:center`，导致挂载后整个应用被撑成内容宽度、挤在中轴（`max-width` 完全失效）。占位样式必须只作用于未挂载时的 `#app>.b`，不要碰 `body` 的布局属性。

## 进度

`localStorage` 键 `netlab.progress.v2`，首页与实验页共用。v1 的旧键不做迁移（结构不同）。

## 部署（Cloudflare Pages）

站点是纯静态多页（13 个自包含 HTML，零外部引用），任何静态托管都能跑。Cloudflare Pages 配置：

| 项 | 值 |
| --- | --- |
| 构建命令 | `npm run build` |
| 构建输出目录 | `dist` |
| Node 版本 | 仓库内 `.node-version`（20） |

- **base 路径**：构建已用 `base: "./"` 相对引用，部署在 pages.dev 任意子路径下都不会裂图
- **刷新 404**：多页站点，每个页面都是真实存在的 `*.html`，刷新直达，无需 `_redirects`
- **下划线文件**：产物根带 `.nojekyll`（来自 `entries/public/`），禁用 Jekyll 处理
- **更新流程**：git push 到主分支 → Pages 自动构建 → 线上自动更新

本地开发：`npm run dev`（root 为 `entries/`，直接开 `http://localhost:5173/lab-01.html`）。
