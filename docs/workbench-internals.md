# Workbench 内部模块

Workbench 是单体仓库：根 `package.json` 是唯一清单，全部产品源码直接归属
根 `src/`。仓内没有 `apps/`、`packages/` 或额外的 `workbench/` 套层，
也不建立第二套版本和发布边界。

## 目录职责

- `src/main`：Electron 主进程、Kernel 能力实现、文件/Git/终端/语言服务宿主。
- `src/preload`：主进程能力到 renderer 的受控桥接。
- `src/renderer`：UI 入口、产品模型、React 控制器、组件、页面组合与样式。
- `src/shared`：跨进程 contracts、IPC 信封、通用语言服务描述和无进程状态代码。

源码通过 `@main/*`、`@renderer/*`、`@shared/*` 显式表达所属层。这些别名既避免
脆弱相对路径，也让边界检查能阻止 renderer 与 main 互相穿透。

## 结构边界

- 产品核心模块不依赖 Electron 主进程、Desktop store、Desktop IPC 或 Desktop 窗口实现。
- 产品端口只依赖共享 Kernel contracts；具体能力由应用组合根安装。
- 跨产品共享的无状态组件继续归属 `@velaros-ai/ui`，不复制进 Workbench。
- 通用语言宿主不包含 VelarScript 特判；editor 贡献归 renderer，服务描述归 shared。
- Workbench 不依赖 VelarOS Desktop 内部源码，仍作为独立应用构建和发布。
- 可重复下载的外部 runtime 使用 VelarOS 组织级共享资源磁盘 ABI；Workbench 只消费共享
  CodeGraph 安装，不在自身 `userData` 建第二份。配置、启停、项目索引和缓存仍由 Workbench
  独立持有；未安装时相关 CodeGraph UI 整体隐藏。

## Agent 执行装配

`src/main/agent/WorkbenchAgentExecutionStack.ts` 使用 Platform 公共导出的
`createAgentExecutionStack`。工厂在包内配对 ModelRuntime、TurnRunner、RunContext 和
SoloLoop；Workbench 注入模型端口、冻结的工具 Registry、提示词策略与共享治理登记处，
通过 `executeSolo` 执行当前前台项目回合。

Workbench 持有项目根、Kernel 能力取消信号、历史和工具可用性策略。执行装配按会话与
等价 Mod 工具面复用；工具面改变时重建 Registry 与执行栈，单纯 UI revision 变化继续
复用该会话的 CodingSessionTracker。清理会话通过栈的 `clearSession` 释放执行状态与
治理登记。

Workbench 通过 GitHub Packages 消费 `@velaros-ai/agent@0.6.16`，依赖要求与包完整性由
`package.json` 和 `bun.lock` 共同记录。请求、工具 schema、预算与传输名称映射来自同一份
已过滤工具快照；首轮 baseline 仅包含宿主常驻名单，工具执行与历史保留 canonical 名称。
版本升级需检查真实多回合工具调用、取消与收尾、类型、生产构建及产品边界。

## Agent 工具预算

每份冻结工具面的 Registry 使用 `@velaros-ai/agent/tool-contract` 物化并规范化 Zod
输入 schema，模型请求和上下文预算共用这份结果。预算计入工具名、描述、实际 schema
字符数，以及与 Desktop 一致的 50 字符工具信封开销；非 Zod schema 按实际发送的任意
对象发现结构计量，执行仍由原 schema 校验。

schema 包装器与字符数只在当前 Registry 内缓存。工具面保持等价时可跨 UI revision
复用；工具替换、移除或恢复由执行栈重建 Registry，开始独立缓存。每轮预算和模型工具集
仍应用当前 allowlist、分类访问和可用性过滤。

## 语言服务与磁盘的同步

编辑器的诊断由主进程的语言服务 worker 计算（内置 TypeScript 项目、ESLint、外部 LSP）。
worker 里的 TypeScript 项目在首次请求时整体读盘建库，之后只有请求文件本身和有未保存
改动的标签走请求里的覆盖层；别的文件必须由下面三路通知刷新，否则它们一直是首次扫描时
的文本，Agent 在依赖文件里修好的错误在导入它的文件里不会消失：

1. **Agent 的写文件工具**：执行栈拿到的改动归属上报口经
   `WorkbenchLanguageWriteSync` 包装，工具报出改过的路径时同步调用
   `projectFilesChanged`。这一步发生在工具结果回到模型和 renderer 之前。
2. **用户在编辑器、文件树里的写入**：fs IPC 的用户写入回报同样包装，保存、新建、改名、
   删除、恢复当场通知。
3. **文件监听**：`WorkbenchFileWatcher` 合并后的每批事件都发 `projectFilesChanged`。
   这是命令产物、外部引擎自己写盘、第三方工具改动的唯一来源，但 macOS 在机器忙时
   （Agent 跑构建、装依赖时正是如此）会把事件攒上好几秒才成批送到，所以前两路不能省。

`projectFilesChanged` 在 worker 里按此刻的磁盘内容更新已建项目里认得的文件（项目根文件
与被 import 拉进程序的文件），有未保存改动的文件只更新磁盘版本、编辑缓冲仍是权威；
`package.json` / tsconfig 变化整个项目重建并作废 ESLint、Prettier 缓存；外部 LSP 收到标准的
`didChangeWatchedFiles`。标签由脏变干净时也直接重读磁盘，不信首次扫描的缓存。worker
客户端在这些通知到达时作废「相同请求搭在飞诊断便车」的去重，后来的同样请求会重新计算。

renderer 侧对应两件事：编辑器控制器订阅 Agent 写入通知（`workbenchAgentProjectWrites`），
工具结果一到就重读打开的文件（不等文件监听，正在刷新时来的事件排队重跑而不是丢掉）；
并维护 `externalRevision`——Agent 写入、监听事件、窗口回到前台都让它加一——CodeMirror
的 linter 以它为 `needsRefresh` 信号、问题面板把它并入调度键，当前文档没变时也重算诊断。

### worker 里的热点与缓存

每一次悬浮、补全、诊断都经 `acquireTypeScriptLanguageService`。它做过的三件昂贵的事现在都有缓存：

- **项目配置**按 (项目根, 请求文件) 记住（`projectConfigMemo`）。解析一次要找 tsconfig、按 include
  扫目录、stat 每个 package.json，大项目一百多毫秒。配置与 package.json 变化整体清掉；源文件新建、
  删除只作废这份记忆，下一次请求重新解析，已建的服务按新清单**增删根文件**而不是丢掉重建
  （以前 Agent 每新建一个文件就整体重建、重新类型检查，停顿好几秒）。
- **span → 行列**只查一次行首表（`rangeFromTextSpanInContent`，按文件名缓存 `SourceFileLike`）。
  以前每个 span 都 `createSourceFile` 重新解析整个文件，一个 1400 个符号的文件算一次大纲要七秒，
  而大纲在每次编辑后 240ms 就会算一次。
- **ESLint 结果**按文件缓存最近一次的文本与结论（`lintResultCache`）：编辑器 linter 与问题面板、
  外部改动后的复核会拿同一份文本再问一遍。磁盘上任何文件变了整体作废；别的标签里没保存的改动
  不作废，与 VS Code 的 ESLint 只在文档自己变了时重新 lint 一致。

改这条链路时用 `bun --conditions=source` 跑一个直接调用 `WorkbenchLanguageServices` 的探针脚本
（拿本仓库当被测项目，请求 `CodeMirrorEditor.tsx` 这种两三千行的文件）看每一步的耗时，别凭感觉。

### worker 的内存边界

2026-09-16 的闪退：跑了 39 小时后语言服务 worker 的 V8 堆（默认 = 物理内存 / 4，16GB 机器 4GB）耗尽，
Node 的 OOM 处理直接 `abort()` 主进程。实测 VelarOS-Platform：每个包的 tsconfig 一个 TypeScript 服务、
每个 200–250MB（连同它 import 的兄弟包源码、lib 与依赖类型），8 个包 1.95GB；类型感知 ESLint 的整仓
程序另占 600MB，且缓存在项目那份 typescript-estree 模块里。现在：

- `LanguageServiceWorkerClient` 建 worker 时给 `resourceLimits.maxOldGenerationSizeMb`（与 V8 默认同值），
  堆耗尽只终止 worker（`ERR_WORKER_OUT_OF_MEMORY`），主进程活着，下一次请求重建；日志
  `language_worker_out_of_memory`。
- `TypeScriptProjectHost` 最多同时活 4 个服务（LRU，重建一个约一秒），所有服务共用一份
  `DocumentRegistry`，编译选项相同的文件只解析一份。
- worker 里 `LanguageServiceMemoryGuard` 每 15 秒看一次堆：≥60% 上限丢掉最近没用的服务与 ESLint 程序
  （`clearCaches()`），≥80% 全丢；空闲 10 分钟丢类型检查缓存，30 分钟全丢。每次动作与每 10 分钟心跳
  记日志 `language_worker_memory*`（堆、RSS、服务数、文件数、ESLint 实例数）。
- 量内存用 scratch 探针在 Electron 运行时（`ELECTRON_RUN_AS_NODE=1`）里跑：bun 的堆是 JSC，数字没有意义。

## 终端与运行卡

底部「终端」与「运行」共用一套会话基础设施：主进程 `TerminalSessions` 每个会话起一个真正的伪终端
（`@lydell/node-pty`，node-pty 的预编译发行版，六个平台包全部列为依赖以便跨平台打包；原生模块在
`WorkbenchPty.ts` 里惰性加载，没有二进制的平台第一次开终端才报 `PLATFORM` 错），renderer 每个会话
一个 xterm.js 实例（`workbenchTerminalInstances.ts`，活到会话被关掉；切标签只摘挂 DOM）。

- 输出：PTY 数据在主进程按 8ms / 64KB 合并后经 IPC 到 renderer，由 `workbenchTerminalOutputBus`
  直送 `terminal.write`，不经 React 状态；视图没挂上时先攒（上限 512KB），挂上整段回放。只有运行卡
  另记一份文本日志（`workbenchTerminalRunLog` 每 100ms 合并落进状态），给 `workbench:read_run` 与
  `start_run` 的 waitFor 用。
- 输入：xterm 收齐的按键（含输入法组合完成后的中文）原样写进伪终端；回显、行编辑、Tab 补全、历史都是
  shell 自己的。Ctrl+C 就是往终端写 ETX；`stopTerminalSession` 的 `SIGINT` 也只是这个。
- 尺寸：容器 ResizeObserver → fit → `resize` IPC，前台程序收到 SIGWINCH。
- 环境：`TERM=xterm-256color`、`COLORTERM=truecolor`、`TERM_PROGRAM=VelarOS-Workbench`，Finder 启动
  没有 locale 时补 `LANG=en_US.UTF-8`（否则 zsh 按 C locale 吞中文）。
- 配色：`workbenchTerminalTheme.ts` 按宿主元素此刻的 CSS 变量（经 canvas 折成 hex，Tailwind 的 oklch
  也能用）算 xterm 主题，换主题重算。
- 打包：`asarUnpack` 解包 `node_modules/@lydell/**`，`verifyPackagedWorkbench.mjs` 检查目标平台的
  `pty.node` 与可执行的 `spawn-helper`。探针 `probe:terminal` 经 `scripts/probe/runTerminalProbe.mjs`
  先用 bun 打包再在 Electron 运行时里跑（node-pty 在 bun 下收不到数据）。

## 生产启动与体积预算

生产 main 入口开启压缩，完整 IDE 工作区在项目打开后按需加载；无项目的起手页不再静态
加载编辑器、终端和代码图控制器。`bun run build` 会在输出完成后执行
`scripts/checkBuildBudgets.mjs`，统计 `index.html` 实际引用的启动 JS/CSS，并同时限制
main、renderer 总体积与最大功能块。

| 指标 | 当前基线 | 上限 |
| --- | ---: | ---: |
| main 入口 | 3.35 MB | 3.75 MB |
| main JavaScript | 5.93 MB | 6.50 MB |
| renderer 启动依赖 | 4.14 MB | 4.75 MB |
| renderer JavaScript | 23.06 MB | 25.00 MB |
| renderer CSS | 0.87 MB | 1.00 MB |
| renderer 最大功能块 | 3.33 MB | 3.75 MB |

单独复核已有生产产物时运行 `bun run check:bundle-budget`。预算留有小幅构建波动空间；
业务增长需要突破上限时，应先给出加载链数据并调整分包，再更新基线。
