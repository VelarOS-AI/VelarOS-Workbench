# Workbench 内部模块

Workbench 是单体仓库：根 `package.json` 是唯一清单，全部产品源码直接归属
根 `src/`。仓内没有 `apps/`、`packages/` 或额外的 `workbench/` 套层，
也不建立第二套版本和发布边界。

## 目录职责

- `src/main`：Electron 主进程、会话运行时宿主（Platform ScriptAct）、文件/Git/终端/语言服务宿主。
- `src/preload`：主进程能力到 renderer 的受控桥接。
- `src/renderer`：UI 入口、产品模型、React 控制器、组件、页面组合与样式。
- `src/shared`：跨进程 contracts、IPC 信封、通用语言服务描述和无进程状态代码。

源码通过 `@main/*`、`@renderer/*`、`@shared/*` 显式表达所属层。这些别名既避免
脆弱相对路径，也让边界检查能阻止 renderer 与 main 互相穿透。

## 结构边界

- 产品核心模块不依赖 Electron 主进程、Desktop store、Desktop IPC 或 Desktop 窗口实现。
- Platform 与 UI 只经包的公开入口消费（开发期是兄弟仓的 `link:`，见 README）；具体能力由应用组合根安装。
- 跨产品共享的无状态组件继续归属 `@velaros-ai/ui`，不复制进 Workbench。
- 通用语言宿主不包含 VelarScript 特判；editor 贡献归 renderer，服务描述归 shared。
- Workbench 不依赖 VelarOS Desktop 内部源码，仍作为独立应用构建和发布。
- 账号会话与 Desktop 共用 VelarOS 组织级共享目录，目录布局归 `@velaros-ai/core/platform/shared-resources`，
  Workbench 不留自己的一份。

## 会话运行时

聊天跑在 Platform 的 ScriptAct 运行时上，与 Desktop 同一套（`src/main/conversation/` 是 Desktop 会话运行时
的移植）：

- **一轮一个运行时**：`WorkbenchConversationSession` 每轮 `createRuntime`，工作区是窗口的项目根（按真实路径），
  同一个项目内核上挂项目模块、问代码（`velaros:code`）与看图；`velaros:shell` 借应用共用的 shell 宿主
  （`WorkbenchShellHostRegistry`，后台任务活过一轮，会话删除时停掉）。常驻模块是 project、code、shell、
  interaction、widget；子任务开。网上查资料（`velaros:web`，与 Desktop 同一套）每个会话都挂、不常驻：搜索与
  读网页跑在不显示的窗口里（`WorkbenchWebSearchPages`，独立分区 `persist:velaros-workbench-web`，不带内置浏览器的
  登录），搜索引擎跟设置走。长期记忆（`WorkbenchMemoryService`，记忆库在 `userData/memory`）按项目根的真实路径
  各一份作用域，这一轮开始时的索引附在宿主说明末尾；设置里能关、能看、能删。Agent 浏览器（velaros:browser /
  devtools / cdp，与 Desktop 同一个 Electron 浏览器运行时）每个聊天会话一个受控页面：模型进站点时编辑区开出
  「Agent · 站点」标签，webview 交给运行时接管（`WorkbenchBrowserService`，运行时会话 id 由项目根与会话 id 算出），
  导航也经运行时走；标签切走时把页面交还，这一轮要用网页时由后台页面顶上；只认 http 与 https；标签关掉、会话删掉、
  窗口放下项目时离站。办公文档、全机文件、电脑操作这类 IDE 用不上的能力不挂。模型写的脚本在 `utilityProcess` 起的隔离进程里跑
  （`workbench-script-worker.ts`）。
- **状态**：会话数据在 `userData/conversation-runtime/<sha256(项目根 \0 会话 id)>`，任何项目之外；
  空闲时读、改目标用无模型的控制会话。旧的 Kernel 会话历史不迁移，老会话下一轮从 Platform 的新上下文开始。
- **宿主说明**（`WorkbenchConversationRules.buildHostInstructions`）：身份、回复语言、脚本首行 `//` 注释
  （界面拿它当脚本卡标题）、计划 / 目标模式，以及项目里的 AI 规则文件原文（`.velar/rules.md`、`AGENTS.md`、
  `CLAUDE.md`、`.cursorrules`、`.cursor/rules/**`、`.github/copilot-instructions.md`，合计 32,000 字符，放不下的
  整份略去并点名）。设置页「AI 规则」列的就是这一份。
- **权限**：「每次询问」档确认每次项目写入与命令；标准档平台只问成片毁掉的命令，Workbench 另在派发前补问会丢
  未提交改动、切分支或写到项目外的命令（`CommandExecutionPolicy.resolveWorkspaceIntegrityConfirmation`，
  确认卡与平台的危险命令同一套选项）；「从不询问」档全部放行。
- **IPC**：`workbench-app:conversation:*`（send / cancel / guidance / input / answer / get-goal / update-goal /
  delete-session / backup-history / engines / event），只认发起窗口当前打开的项目；窗口销毁时取消它的运行。
- **外部引擎**（`src/main/engines/`）：会话可以交给本机装好的 Claude Code 或 Codex 命令行。请求带 `engine`
  时 `WorkbenchConversationDispatcher` 交给 `WorkbenchEngineConversationRuntime`，其余走 Platform；运行中的
  回答、停止跟着正在跑的那一边，删会话、停项目、关闭两边都做。不打包任何 SDK：Claude Code 直接起用户的
  `claude`，走 stream-json（与 Agent SDK 同一套：`-p --input-format/--output-format stream-json
  --permission-prompt-tool stdio`），一轮一个进程，下一轮 `--resume`；工具权限一律 `--permission-mode default`
  经控制通道问 Workbench，按设置的权限档答（`WorkbenchEnginePermissions`：标准只问危险命令与项目外写入，危险
  判定与 Platform 会话同一个 `analyzeWorkbenchCommandExecution`）；`AskUserQuestion`、计划审批画成提问卡。
  Codex 常驻一个 `codex app-server`（JSON-RPC，所有会话共用，每个会话一条 thread，闲置 5 分钟停下），沙箱限在
  项目里：标准 `on-request`、每次都问 `untrusted`、从不询问全权限；审批请求按同一套权限档答，
  `request_user_input` 画成提问卡。引擎的正文、思考、工具调用经 `EngineRunSurface` 变成与 Platform 运行同一套
  通知，工具调用是新通知 `conversation-tool-call`（renderer 画成 `tool-call` 块，工具名用界面认得的
  `project:run` / `project:edit` …，计划更新成计划卡）；写文件、跑命令的时间窗同样报给改动归属账本。Workbench
  会话 → 引擎会话的对照在 `userData/agent-engines/sessions.json`，接不上时另开一段。引擎在本机的情况（装没装、
  登没登录、模型目录）经 `engines` 通道探，主进程缓存一分钟；登录与模型都归引擎自己。

renderer 侧 `standaloneWorkbenchChatAdapter.tsx` 把主进程推来的通知（正文、思考、脚本卡、工具卡、子任务、小部件、
交互卡、命令输出、改项目）归并进消息（`workbenchConversationNotices.ts`，一次运行的块都在 `conversation:run:<runId>`
这条消息里），状态经 `applyStandaloneConversationState` 落到运行态。停止等主进程收尾最多 15 秒。执行体是会话的
属性（`StandaloneChatState.engine`，随会话落盘）：输入框的模型菜单里列 VelarOS 的模型与本机能用的引擎
（`workbenchAgentEngines.ts`），会话有了消息就只留这一侧；新会话沿用上一次的选择。引擎会话不收运行中的引导
（跑着时发的消息进排队），也不做目标自动续跑、不显示上下文用量与约价；运行状态行换成引擎的品牌图标。

### AI 改动审阅

每轮开跑前拍一个 Git 检查点（影子提交，不动用户的 HEAD / 索引），同时开这一轮的改动归属账本。Platform 的
写操作都过同一道效果闸，闸放行（`effect-wait`）与这次操作跑完（`effect-run`）各报一次计量；项目与 shell
模块的这两点之间就是一段 Agent 动手的时间窗，交给账本（`beginCommand`）。窗关闭时主进程推
`conversation-project-activity`，renderer 据此实时采集改动、重读打开的文件；一轮结束做最终采集，改动卡列出
Agent 改过的文件、差异与逐文件归属。回溯（把改动推回去）已下线。

## 文本文件的编码与换行

不变量：Workbench 不改用户没编辑过的字节。`src/main/workspace/TextCodec.ts` 读盘时认编码（UTF-8 BOM、
UTF-16 LE/BE BOM、严格 UTF-8、严格 GB18030）与占多数的换行符，交给编辑器的正文一律去掉 BOM、换行统一为
LF；读盘结果带着 `encoding`、`eol`，字节不能按它们逐字节写回时再带 `textIssue`（认不出的字节、写不回的
GB18030、混用的换行符），编辑器据此只读打开，用户明确选「转换为 UTF-8」或统一换行符后才重写整份文件。

- 新增保存路径必须把标签的格式（`resolveWorkbenchTabTextFormat`）带进保存请求；没带时主进程沿用磁盘上的
  格式，磁盘上的字节本身写不回时拒绝保存。GB18030 只写单双字节，表外的字符拒绝保存（`UNENCODABLE_TEXT`）。
- 保存走 `AtomicFileWrite`：同目录临时文件、刷盘、rename，权限位不变；硬链接、别人的文件、建不了临时文件的
  目录、rename 被占用挡住时退回原地写。
- 大文件只读截断视图要的开头（每字符最多 4 字节）；重读打开的文件用 `resolveWorkbenchEditorRereadMaxChars`，
  存过的大于打开上限的文件不会被读成截断的。
- 与编辑器正文比较的文本（Git 的 HEAD 版本、内容搜索）用同一个解码（`decodeWorkbenchTextContent`）。
  Agent 经 Platform 内核的读写不走这里。
- 项目搜索的替换写没开着的文件时也走保存管线（`ContentReplace` → `FileOperations.saveFile`，不带格式），
  开着的文件只改编辑缓冲、不写盘。

## 项目搜索与替换

侧栏的搜索（⇧⌘F）。匹配规则只有一份：`src/shared/workbenchTextSearch.ts`（查找词、区分大小写 / 全字 /
正则、替换时的 `$1`，与编辑器里的查找一致，`tests/workbench-text-search.test.ts` 拿两者对照）与
`src/shared/workbenchSearchGlob.ts`（包含 / 排除的文件）。main 与 renderer 都用它们，行列号与编辑器一致。

- 文件清单（`ProjectFileListing`）：Git 仓库用两次 `git ls-files`（被跟踪的 + 没被忽略的新文件），子模块与
  嵌套仓库在里面再列；其它工程逐目录遍历，跳过点号开头的目录与根目录下的构建产物。内部目录与依赖目录
  （`WorkbenchSkippedDirectories`）两种方式都不进；符号链接不跟。二进制文件与超过 1 MB 的不搜。
- `searchContent` 带 `searchId` 时边搜边把结果推回发起的窗口（第一批一有结果就推，之后每 80 ms 一批），
  可以取消，窗口关了一并取消；最多列 5000 处（每个文件的匹配数照样数全），列到上限就标 `truncated`。
- 用户的正则不在主进程里跑：文件清单在 main 列好，读盘、解码、匹配以及替换时算新正文都在搜索 worker 里
  （`ContentSearchTask`，构建产物 `workbench-search-worker.js`，一次搜索或一次替换一个 worker）。
  `(\w+)+;` 这类回溯停不下来的正则会让线程一直占着，收不到取消，所以 `ContentSearchWorkerHost` 取消时
  直接结束 worker；worker 接下请求以后 10 秒没有动静（每个文件开搜前报一声、等读盘时每秒一次心跳）就
  判定卡住，结束它并报出卡在哪个文件上，替换则停在那个文件、后面的不再换。V8（Electron）能在正则执行
  中途结束线程；bun 的正则停不下来，测试里的回溯正则因此只跑两三秒。搜索中途失败时，面板留着已经到的
  结果、在结果上方写明原因，结果不全所以不让替换。
- main 这边给用户看的搜索、替换提示都从 main 的文案表出（`workbenchMainMessages` 的 `search.*`），跟着界面
  语言走；worker 与主进程不共用模块状态，界面语言随每个请求带过去。
- 编辑器里开着的文件以编辑缓冲为准：renderer 把它们的路径交给 main，main 不出它们的结果、只报在不在范围
  里，由 renderer 在正文上搜（与编辑器里的查找一样跑在窗口自己的线程上）；替换也在编辑缓冲上做（一次
  外部改动，⌘Z 能撤回）。用正则搜时，worker 报一个开着的文件在范围里之前，先拿它磁盘上的版本试跑一遍：
  正则在它上面跑不完，卡住的是 worker，renderer 收不到这个路径，不会再跑一遍把窗口卡死（编辑缓冲里
  没保存的内容 worker 看不到，那部分防不住）。每份结果记着搜它的条件，替换按它算，条件改了、新结果出来
  之前不让替换。
- 没开着的文件交给 `ContentReplace`：重读、按同样的条件重新找匹配（点名的那几处对不上就不换），带着搜索
  时的修改时间与大小保存，替换前的内容先记进本地历史。
- 页面只留面板的开关与表单（`useWorkbenchProjectSearchPanel`）；搜索、结果与替换（`ProjectSearchView` 与
  `useWorkbenchProjectSearchEngine`）是单独的一块，不进工作区外壳（外壳 chunk 有体积预算），与 Git、AI
  改动面板一样在窗口空闲时预先加载（`lazyWithPreload`）。编辑区、页面只用得到的行列换算与正则转义在
  `src/shared/workbenchSearchText.ts`，免得把整套匹配规则带进外壳。
- 快速打开按文件名找文件用的是另一份清单（`SearchIndex.listProjectFiles`）：不看 .gitignore，文件树里看得到
  的都列；内容搜索的清单听 .gitignore 的。

## 语言服务与磁盘的同步

编辑器的诊断由主进程的语言服务 worker 计算（内置 TypeScript 项目、ESLint、外部 LSP）。
worker 里的 TypeScript 项目在首次请求时整体读盘建库，之后只有请求文件本身和有未保存
改动的标签走请求里的覆盖层；别的文件必须由下面三路通知刷新，否则它们一直是首次扫描时
的文本，Agent 在依赖文件里修好的错误在导入它的文件里不会消失：

1. **Agent 的项目编辑**：Platform 的计量不带路径，会话宿主在派发 `velaros:project.edit` 前从入参读下它要写的
   路径（写、换原文、删除的 path，移动的两头，转码的 paths），那次编辑成功跑完、改项目的时间窗关闭之前调
   `projectFilesChanged`（`WorkbenchLanguageWriteSync.languageSyncOnAgentEdits`），先于界面收到通知。
2. **用户在编辑器、文件树里的写入**：fs IPC 的用户写入回报经 `withLanguageSyncOnUserWrites` 包装，保存、新建、
   改名、删除、恢复当场通知。
3. **文件监听**：`WorkbenchFileWatcher` 合并后的每批事件都发 `projectFilesChanged`。
   这是命令产物、第三方工具改动的唯一来源，但 macOS 在机器忙时（Agent 跑构建、装依赖时正是如此）
   会把事件攒上好几秒才成批送到，所以前两路不能省。

`projectFilesChanged` 在 worker 里按此刻的磁盘内容更新已建项目里认得的文件（项目根文件
与被 import 拉进程序的文件），有未保存改动的文件只更新磁盘版本、编辑缓冲仍是权威；
`package.json` / tsconfig 变化整个项目重建并作废 ESLint、Prettier 缓存；外部 LSP 收到标准的
`didChangeWatchedFiles`。标签由脏变干净时也直接重读磁盘，不信首次扫描的缓存。worker
客户端在这些通知到达时作废「相同请求搭在飞诊断便车」的去重，后来的同样请求会重新计算。

renderer 侧对应两件事：编辑器控制器订阅 Agent 写入通知（`workbenchAgentProjectWrites`，由主进程的
`conversation-project-activity` 触发），一段改项目的时间窗关闭就重读打开的文件（不等文件监听，正在刷新时来的
事件排队重跑而不是丢掉）；
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

### 超时、取消与重启

- 一个请求超时只让它自己失败（`TIMEOUT`），并通知 worker 丢掉 / 放弃它；TypeScript 的项目状态与外部 LSP
  会话都留着。超时后给 worker 发 `ping`（控制消息不进请求队列），20 秒内不回 `pong` 才判定卡死、换 worker；
  worker 崩溃同样换。接连失败时重建间隔从 1 秒翻倍到 30 秒（平稳跑满一分钟清零），期间的请求排队等新 worker。
- 补全、悬浮、签名、高亮、内联提示、语义着色按「窗口 + 文件」互相顶替：新请求一到，旧的立即以 `CANCELLED`
  结束；排队中的直接丢掉，正在算的 TypeScript 从与 worker 共享的取消缓冲读到取消、在检查点停下，外部 LSP 收到
  `$/cancelRequest`。诊断从不中途取消（TypeScript 会因此丢掉整个类型检查器）。
- 问题面板：打开的文件用各自的实时诊断；另有整项目检查（`getProjectDiagnostics`，像 `tsc --noEmit`），按打开的
  TypeScript 文件找 tsconfig 项目（最多两个），后台优先级、每批约 150ms 分批查，结果逐批并入面板。打开的 TS
  文件、项目或磁盘内容变了 1.5 秒后查一轮，打字不触发；一轮没查完又有改动就查完再来一轮。

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
  直送 `terminal.write`，不经 React 状态；视图没挂上时先攒（上限 512KB），挂上整段回放。React 只记
  会话收口（是否还在跑）。
- 输入：xterm 收齐的按键（含输入法组合完成后的中文）原样写进伪终端；回显、行编辑、Tab 补全、历史都是
  shell 自己的。Ctrl+C 就是往终端写 ETX；`stopTerminalSession` 的 `SIGINT` 也只是这个。
- 尺寸：容器 ResizeObserver → fit → `resize` IPC，前台程序收到 SIGWINCH。
- 环境：`TERM=xterm-256color`、`COLORTERM=truecolor`、`TERM_PROGRAM=VelarOS-Workbench`，Finder 启动
  没有 locale 时补 `LANG=en_US.UTF-8`（否则 zsh 按 C locale 吞中文）。
- 配色：`workbenchTerminalTheme.ts` 按宿主元素此刻的 CSS 变量（经 canvas 折成 hex，Tailwind 的 oklch
  也能用）算 xterm 主题，换主题重算。
- 打包：`asarUnpack` 解包 `node_modules/@lydell/**`，`verifyPackagedWorkbench.mjs` 检查目标平台的
  `pty.node` 与可执行的 `spawn-helper`。Agent 的交互式命令也经 `@lydell/node-pty` 跑在真终端里
  （`WorkbenchShellTerminal.ts` 惰性加载）。探针 `probe:terminal` 经 `scripts/probe/runTerminalProbe.mjs`
  先用 bun 打包再在 Electron 运行时里跑（node-pty 在 bun 下收不到数据）。

### 终端里的链接、查找与拆分

- 文件链接：鼠标所在那一行（连同折行）里的路径经 `workbenchTerminalFileLinks.ts` 认出来，问主进程确实是
  项目里的文件才画成链接，点一下在编辑器里打开（带行列的跳过去）。相对路径按 shell 此刻所在的目录解析：
  主进程直接问操作系统（`WorkbenchProcessCwd.ts`，macOS 用 `lsof`，Linux 读 `/proc/<pid>/cwd`，每个会话
  至多两秒问一次），不靠 shell 报；Windows 上问不到，退回 shell 用 OSC 7 报的目录或会话的起始目录。
- 查找：⌘F（其它平台 Ctrl+F）在终端里开查找栏（`workbenchTerminalSearch.ts`），在整个滚回历史里找，
  只给视口附近的匹配画高亮，输出变了隔一会儿重找。
- 拆分：一个标签可以并排放几个终端（`workbenchTerminalSplits.ts`）。会话仍是一张平表，并排的几个挨在
  一起、共用 `groupId`；标签栏一组一个标签。⌘D（其它平台 Ctrl+Shift+5）在当前终端右边再开一个，起始目录
  跟着当前 shell 所在的目录（start 请求的 `inheritCwdFrom`，主进程去问；已经到项目外面、问不到就从项目
  根开始）；⌥⌘← / ⌥⌘→（Alt+← / Alt+→）在并排的终端之间换焦点。宽度份额记在会话上，拖分隔条时直接改
  样式，松手才进 React 状态。
- 退出：shell 正常退出（退出码 0）且焦点就在这个终端里——也就是用户在里面敲了 `exit`——这个终端跟着
  关掉；在后台自己结束的、异常退出的留着，能看到最后的输出和「进程已结束」那一行。

## 生产启动与体积预算

生产 main 入口开启压缩，完整 IDE 工作区在项目打开后按需加载；无项目的起手页不再静态
加载编辑器、终端和聊天（聊天的 Provider 装在按需加载的工作区外壳里）。Platform 的
`@velaros-ai/{model,script,velaros}` 不进 main bundle，运行时从 `node_modules` 以原生 ESM 加载
（清单 `scripts/release/mainExternalEsmPlatformPackages.json`，打包后逐个核对 asar 里的 import 闭包）。`bun run build` 会在输出完成后执行
`scripts/checkBuildBudgets.mjs`，统计 `index.html` 实际引用的启动 JS/CSS，并同时限制
main、renderer 总体积与最大功能块。

| 指标 | 当前基线 | 上限 |
| --- | ---: | ---: |
| main 入口 | 0.52 MB | 3.75 MB |
| main JavaScript | 1.01 MB | 6.50 MB |
| renderer 启动依赖 | 2.65 MB | 4.75 MB |
| renderer JavaScript | 25.18 MB | 26.00 MB |
| renderer CSS | 0.90 MB | 1.00 MB |
| renderer 最大功能块 | 3.62 MB | 3.75 MB |

单独复核已有生产产物时运行 `bun run check:bundle-budget`。预算留有小幅构建波动空间；
业务增长需要突破上限时，应先给出加载链数据并调整分包，再更新基线。

迁到 Platform 之后（2026-09-27）：main 小了一个量级，因为 Platform 的运行时不再打进 bundle；renderer
启动依赖减半，因为聊天随工作区外壳按需加载。最大功能块就是工作区外壳（其中图标库约 0.55 MB：每个
Phosphor 图标带六种字重；消息 Markdown 的代码高亮由 UI 包静态引入约 0.3 MB）。renderer 总量贴近上限，
增量主要是 UI 0.2.54 的 Markdown 图表（mermaid 各类图）按需分块；它们不进启动包，但计入总量。

2026-09-30：renderer 总量的上限从 25 MB 调到 26 MB——其中约 19 MB 是 UI 包带来的按需分块（代码高亮的
各语言语法与 mermaid），本仓改不了；启动依赖与最大功能块的上限没有动。快速打开、设置对话框、Git 工具窗、
提交面板、AI 改动、浏览器面板和项目搜索都从工作区外壳里拆成了按需加载的块（`lazyWithPreload.ts`，空闲
时预取），外壳因此还有约 0.13 MB 的余量；新的面板照这个办法加，不要直接进外壳。
