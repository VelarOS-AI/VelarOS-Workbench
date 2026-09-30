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

## 编辑区的标签与分栏

开着的文件分两处记，两边的路径始终是同一批：

- **正文与磁盘快照**在 `useWorkbenchEditorController` 的 `openTabsByPath`（按路径）：保存、自动保存、外部改动、
  关闭前的确认都只认它，与标签在哪一组无关。
- **标签布局**（`models/editor/workbenchEditorGroups.ts`，纯函数）记每一组的标签栏顺序、固定标签、预览标签、
  正在显示的标签，以及当前组和分隔条位置。状态在 `useWorkbenchEditorTabLayout`；最新的布局另记在 ref 里，同一轮
  事件里接连两次改动（文件读完紧接着又关掉别的标签）接在前一次的结果上。

「当前文件」（`selectedFilePath` / `selectedFile` / `editorContent`）不是单独的状态：它就是当前组正在显示的那个
标签，磁盘快照与正文取自标签本身。打开、关闭、改名、恢复会话这些要同时动两处的操作在控制器里同一轮提交；只动
布局的（拖动标签、固定、挪到另一组、换当前组、拖分隔条）在布局 hook 里。

布局原样随项目会话存盘（`workbenchProjectSessionModel` 的 `editorLayout`，两组合计最多 32 个标签）。读回来先
校验：形状不对的（包括以前只存一列路径的会话）按没有标签处理，不做换算；恢复时读不出来的文件，它的标签丢掉。

### 预览标签

每一组最多一个预览标签（`previewPath`，名字是斜体）。打开文件时带的意图（`WorkbenchEditorOpenTabIntent`）决定标签
怎么开，规则跟 VS Code 的默认行为走：

| 入口 | 标签 |
| --- | --- |
| 文件树单击（或键盘激活）、搜索结果单击（匹配与文件名条目）、问题面板点一条、跳到定义 / 引用 / Markdown 预览里的链接、后退 / 前进回到已经关掉的文件 | 预览 |
| 文件树双击、新建文件、搜索结果双击或回车、问题面板双击一条、快速打开（文件、内容匹配、`:行`）、终端里的路径、聊天里的路径与改动卡、提交面板的「打开文件」、从系统打开、重新打开关闭的标签 | 普通 |

- 以预览方式打开一个没开着的文件：顶替这一组原来的预览标签（占它的位置；被顶替的文件随之关掉，不记进
  「重新打开关闭的标签」），没有预览标签就在末尾加一个。
- 文件已经开着：预览方式只是切过去，普通标签不会变回预览（点标签也是这样切的）；普通方式再打开一次，
  预览标签就此留下。文件还在读的时候又被普通方式打开（双击的第二下），读完开成普通标签。
- 预览标签留下（变成普通标签）：正文被改（输入、格式化、跨文件改名、项目替换，不论来源）、明确保存（⌘S，
  没有改动也算）、选了格式转换、双击标签、拖动它；从预览标签跳到定义时，出发的那个先留下（`keepSource`）。
  所以预览标签从不带未保存的改动，被顶替时不用问。
- 设置「预览标签」（`editorPreviewTabs`，默认开）关掉后一律开普通标签，已有的预览标签就此留下。

### 固定标签

每一组标签栏最前面的 `pinnedCount` 个是固定标签，按固定的先后排。标签右键「固定」/「取消固定」；固定标签上
关闭按钮的位置是图钉，点它取消固定（回到普通标签的最前面）。

- 「关闭其他 / 关闭右侧标签 / 关闭全部 / 关闭未修改的文件」都跳过固定标签（要关哪些由
  `listWorkbenchEditorTabsToCloseOthers` 等给出）。切分支之后的那次「关闭全部」也一样：固定标签留着，按磁盘上的
  新内容刷新。
- ⌘W 与中键对固定标签什么也不做。要关它先取消固定；文件在磁盘上被删掉时，提示条里的「关闭标签页」照样能关，
  文件树里删掉文件也照样关。
- 拖动只能在固定标签之间、普通标签之间换位置。固定预览标签就把它留下；新开的标签排在固定标签后面。
- 固定个数随布局存盘；读回来按存下时的位置核对——丢掉了坏条目，后面的普通标签不会顶上来变成固定的。

### 左右并排的两组

编辑区最多左右两组，每组一条标签栏、一个正在显示的标签、自己的预览标签与固定标签；中间的分隔条可以拖（双击
恢复成一样宽）。组按位置认（`groups[0]` 左，`groups[1]` 右），没有标签的组不留着：关掉右边的最后一个标签就
只剩左边；关掉左边的最后一个标签而右边还有，右边那组就成为唯一的一组。

- **同一个文件只在一组里开着**（第一版的规则，没有做同一个文件两个视图的同步）。打开已经在另一组里开着的
  文件就是切到那一组去。所以「拆分并右移」（标签右键；⌘\ / Ctrl+\）是把当前标签**挪**到右边那组（没有就
  新开），左边改显示它旁边的标签；有两组时右键是「移到另一侧」。标签也能拖到另一组上：落在它的标签栏上
  （某个标签前面，或空白处加到末尾），或者落在它的编辑器上（整组亮起来，加到末尾）。后一种由
  `EditorGroupsPanel` 在捕获阶段接下，编辑器收不到这次拖放——标签的拖放数据里带着路径的纯文本，落进
  编辑器会被当成文字插进正文。自己这一组的标签拖到自己的编辑器上不接，行为与以前一样。挪过去的固定标签
  还是固定的，预览标签就此留下；跨组也进不了对方的固定区。
- **当前组**（`focusedGroup`）：点进哪一组、键盘焦点落进哪一组，或 ⌘1 / ⌘2（Ctrl+1 / Ctrl+2），它就是当前组。
  「当前文件」是当前组正在显示的标签，所以 ⌘S、格式化、命令面板、快速打开的 `:行`、状态栏、问题面板的当前
  文件、聊天的「当前文件」、文件树的定位都跟着当前组走。在某一组的编辑器里按的 ⌘S、改的字带着那个文件的
  路径，落在那个文件上，不看当前组。⌘1 / ⌘2 与挪标签之后键盘焦点放进那一组的编辑器；那一组眼前没有编辑器
  （图片、Markdown 预览、Git 对比）时只把键盘焦点从原处拿走，下一次按键不会落回另一组的编辑器或终端里。
- **渲染**：`EditorGroupsPanel` 每组一个 `EditorPanel`（各自的查找栏、跳行栏、Markdown 预览开关、外部改动
  提示条、文件历史）。各组报上来的光标、缩进只转发当前组的，换当前组时补发一次；定位请求
  （`EditorNavigationRequest.path`）只由正在显示那个文件的一组执行；⌘W 只由当前组执行；外部改动的确认框
  只在当前组弹；状态栏缩进菜单的操作只交给当时的当前组、只交一次。
- **两个编辑器共用一份按文件记的编辑器状态**（`WorkbenchEditorFileStates`）：标签挪到另一组，撤销历史、光标、
  滚动位置、折叠跟着走。React 按组件顺序跑副作用，接手的编辑器可能先于原来那个换文件，所以取状态时登记
  「谁在显示它」，接手的直接向还在显示它的编辑器要此刻的状态，原来那个随后存进来的旧状态不收。
- **盖在编辑器上的标签归谁**：Git 对比、只读预览、网页调试与 Agent 浏览器只在左边那组的标签栏里，只盖住
  左边那组的编辑器（用户打开或切到它们时当前组换到左边；往右边那组开文件不会把它们收掉；往左边那组开
  文件、把标签挪进左边那组，Git 对比与只读预览收掉、网页调试标签放到后面）。结构图、AI 改动
  这两个独占标签组占整个编辑区，右边那组先收起来，离开之后回来；这期间在它们里面点、敲不换当前组，离开
  之后当前组还是原来那一组。文件历史属于打开它的那一组。
- **后退 / 前进**记着位置所在的组：文件还开着就去它所在的组，标签已经关掉就在当时那一组里以预览标签重新
  打开。换当前组之前也记一个位置。
- **存盘**：哪些标签在哪一组、每组正在显示的标签、当前组、分隔条位置（`splitRatio`）都在 `editorLayout` 里。
  恢复会话时只把当前组的当前文件带回上次的光标位置。

## 焦点与按键的几条约定

- **底部工具窗盖着编辑区**：终端、运行、Git、问题、调试那一块（`.bottomToolWindowSlot`）是绝对定位盖在
  左侧面板、编辑区、右侧面板上面的，不把它们挤矮。编辑器并不知道下面那一截看不见，所以文件编辑器把被
  盖住的高度报给 CodeMirror 的 `scrollMargins`（`workbenchEditorCoveredScrollMargins.ts`，工具窗带
  `data-workbench-editor-overlay`）：跳转、点问题、调试停下、跟着光标滚，目标都落在工具窗上面。文件最后
  几行仍然滚不出工具窗（滚动到底了），左侧面板的底部（提交框）和聊天输入框照样被盖住——要改就得把工具
  窗改成挤占式的布局。
- **自己画的菜单里的 Esc**：右键菜单、标签栏的菜单靠 `useDismissOnWindowInteract` 在 window 上听 Esc。
  全局快捷键（Esc 关右侧面板）也挂在 window 上，而且挂得更早，所以关菜单的监听在捕获阶段接，并
  `preventDefault`：全局快捷键见到已经用掉的按键就让路，同一下 Esc 只关菜单。
- **项目树里的改名框**：失去焦点就取消改名。react-arborist 取消之后会把焦点还给那一行；焦点是被树外面
  拿走的（点进编辑器、打开快速打开）时，`keepFocusOutsideTreeAfterRename` 在树拿回焦点的那一刻把它交
  回去，不然之后敲的字都进了树。
- **顶栏 ▶ 菜单**：打开时焦点给命令输入框，由浮层的 `onOpenAutoFocus` 给——浮层先挂出来、摆好位置才
  可见，输入框上的 `autoFocus` 赶在那之前，落不上。菜单开着时 ▶ 的悬停说明不出。

## 键位方案

设置 → 编辑器 → 快捷键里选一种：Workbench（默认，就是以前的键）、VS Code、JetBrains、Vim。全局快捷键和
编辑器里的按键一起跟着换，命令面板、编辑器右键菜单、设置里提示的键也跟着换。

### 表在哪

- `models/layout/workbenchKeymapPresets.ts`：方案的名字，平台分三类（mac / windows / linux；表里一格写
  `{ mac, other, linux? }`，三类都一样就直接写），两张表共用。
- `models/layout/workbenchKeyboardShortcuts.ts` 的 `WorkbenchKeyboardShortcutPresets`：设置里能改的那 22 个
  全局动作在各方案里的默认键。空串是这个方案里它没有键（现在只有 JetBrains 方案的「切换 AI 聊天」：它的
  ⇧⌘A / Ctrl+Shift+A 在那个方案里给了命令面板）。
- `models/editor/workbenchEditorKeymap.ts`：53 个编辑器命令在各方案里的键。一个命令可以有几组键，第一组是
  界面上提示的那一组；空数组是没有键。
- 两张 IDE 表照它们自己的默认键位抄（VS Code 的 Default Keyboard Shortcuts 三个平台各一份；IntelliJ 的
  macOS 键位表，Windows / Linux 是 `$default`）。对不上的留 Workbench 的键，并在那一行写明是哪一种：那个
  IDE 没有对应的动作或没有默认键；它的键被应用菜单占着（菜单的键一律不去盖，见下）；要连按两下或分两步
  按，这里按不出来；它的键在这个方案里已经给了别的命令（写明给了谁）。
- 一个方案、一个平台上，同一组键只有一个意思：编辑器命令之间不重，编辑器命令与全局快捷键之间也不重。
  有意同键的几处列在 `WorkbenchEditorKeymapSharedChords`（保存、后退 / 前进是同一件事；⌘↩ 在编辑器里是
  插入空行；F8 调试停着时归调试）。这些都有测试钉着（`tests/workbench-editor-keymap.test.ts`、
  `tests/workbench-keymap-presets.test.ts`）；Workbench 方案与改成键位方案之前逐键一致
  （`tests/workbench-editor-keymap-pin.test.ts` 里留着当时那张表）。
- 应用菜单的键（`src/main/projects/ProjectHubMenu.ts` 和它用的角色：重新加载、开发者工具、编辑器缩放、
  关闭编辑器、撤销重做……）不随方案变，也不让任何方案的命令占。所以有些 IDE 的键在这里用不了：JetBrains
  的替换（⌘R）、折叠（⌘- / ⌘+）、Windows / Linux 上的「转到文件」（Ctrl+Shift+N）和扩展选区（Ctrl+W），
  VS Code 在 Windows / Linux 上的重构（Ctrl+Shift+R）、Linux 上的格式化（Ctrl+Shift+I）。

### 一次按键怎么落到命令上

焦点在文件编辑器里时，按先后：

1. 调试停着时，调试的控制键先拿（window 的捕获阶段，`useWorkbenchDebugShortcuts`）。
2. Vim 方案：Vim 那一层（见下）。
3. 补全列表、行内建议开着时它们自己的键（↑ ↓、回车、Tab、Esc）。
4. 编辑器命令：`workbenchEditorKeymap({ getPreset, host })` 是 CodeMirror 键位里的一条 `any` 处理，排在
   编辑器别的键位之前。它用 `resolveWorkbenchEditorKeymapCommand(event, platform, preset)`
   （`workbenchEditorKeymapResolver.ts`）查表，查到就做那个命令（`workbenchCodeMirrorEditorCommands.ts`；
   要用到编辑器组件的十几个——跳到定义、保存、查找、代码动作——由组件给）。查到了就算用掉，哪怕命令此刻没
   事可做，不会再漏给后面去做别的事；只有 Tab、⇧Tab、Esc 没事可做时放过去。方案每次按键现查，换方案不用
   重建编辑器。
5. CodeMirror 的 `standardKeymap`（方向键、Home / End、回车、退格、全选……各家都一样的键）和括号补全。
6. 都没用掉：冒泡到 window，全局快捷键（`useWorkbenchKeyboardShortcuts`，见到已经用掉的按键就让路）。
7. 还没人用，才轮到应用菜单的加速键。

字符键怎么认（第 4 步）：修饰键要一个不多、一个不少；字符照打出来的字认（Dvorak、AZERTY 上按的是标着那
个字母的键）。打出来的字靠不住时改看这个键本身是哪个：macOS 上按着 ⌥（⌥Z 打出来是 Ω），Windows / Linux
上同时按着 Ctrl 与 Alt，非拉丁布局。Windows 上 AltGr 打出别的字符时算打字，不算快捷键。

### 存的是什么

`localStorage` 的 `velaros.workbench.keymap.v2`：`{ preset, overrides }`。`overrides` 只有用户自己改过、与
所选方案默认键不一样的全局快捷键。读的时候逐项校验：方案名不认识用默认方案；动作不认识、键解析不了的
那一项丢掉（那个动作用方案的默认键）。以前的 `velaros.workbench.keymap.v1` 存的是整张「动作 → 键」表，
不读、不换算——升级之后以前改过的键回到默认。

用户改的键叠在所选方案上，换方案时留着；设置里「重置」回到所选方案的默认键；冲突检查按此刻生效的键做
（所以跟着方案走）。编辑器命令的键不能单独改，设置里只读地列出来，与 Workbench 方案不一样的标着
Workbench 方案的键（`components/settings/WorkbenchKeymapSettings.tsx`）。

提示的键：全局动作取此刻生效的键；编辑器命令用 `formatWorkbenchEditorCommandHint(command, preset)`——命令
面板的登记里写 `{ editor: 命令 }`，编辑器右键菜单、设置里的说明也用它；应用菜单的键（关闭编辑器、缩放）
仍是写死的。

### Vim 方案

键位与 Workbench 方案相同，另在文件编辑器里加模式编辑，用的是 `@replit/codemirror-vim`。

- **范围**：只在文件编辑器（`CodeMirrorEditor`：编辑区里的文件，和轻量预览标签）。差异、文件历史、提交
  信息框、各种输入框不是这个组件，没有 Vim。只读的文件里能移动、选择、搜索，改不了、进不了插入模式
  （包自己看只读标记）。
- **加载**：选了 Vim 方案才加载。`useWorkbenchEditorVim` 动态 import `workbenchEditorVimLayer.ts`，它再
  动态 import 那个包——全仓只有这一处，别处不许静态引它（测试钉着）。扩展挂在文件扩展列表最前面的
  compartment 里，因为 Vim 的按键处理要排在编辑器所有按键处理之前。
- **按键归谁**是有意定的，规则在 `workbenchEditorVimKeys.ts`（包认按键的入口 `Vim.vimKeyFromEvent` 被包了
  一层，不归 Vim 的键它当没按过）：
  1. 不带 Ctrl / Alt / ⌘ 的键都先给 Vim。
  2. 设置里那张全局快捷键表上的键，任何模式下都归工作台（用户录了什么就是什么）。
  3. 其余的，Vim 在当前模式下有命令的 Ctrl 键归 Vim。
  4. 再其余的，是编辑器命令的键就归编辑器命令（macOS 上普通模式会吞掉没用到的 ⌥+字符，不放行的话 ⌥Z
     自动换行、⇧⌥A 块注释就按不到了）。
  5. Ctrl+W：这个包的普通模式拿它当窗口命令的前缀，可这里没有窗口命令。Windows / Linux 上普通模式、可视
     模式里放给应用菜单（关闭编辑器），插入模式里是 Vim 的「删除前一个词」；macOS 上 ⌃W 不是菜单的键，
     留给 Vim。
- **Windows / Linux 上工作台的 Ctrl 快捷键**（上面几条的结果）：
  - 普通模式、可视模式里，这些键做的是 Vim 的事，工作台原来的功能按不到：Ctrl+A（全选 → 数字加一）、
    Ctrl+F（查找 → 下翻一页；查找用 `/`）、Ctrl+D（选中下一处相同的文字 → 下翻半页）、Ctrl+I 与
    Ctrl+Space（触发补全 → 跳转表前进 / 下一个词）、Ctrl+U（撤销选区变化 → 上翻半页）、Ctrl+Y（重做 →
    向上滚一行；重做是 Ctrl+R）、Ctrl+[（减少缩进 → Esc；缩进用 `<<` `>>`）、Ctrl+C / Ctrl+X / Ctrl+V（复制
    / 剪切 / 粘贴 → 回普通模式 / 数字减一 / 按块选择；选中了文字时 Ctrl+C 仍然复制），以及应用菜单的
    Ctrl+O（打开项目 → 跳转表后退）、Ctrl+R（重新加载 → 重做）。
  - 照常的：Ctrl+P（快速打开，Vim 的「上移」让给它）、Ctrl+Shift+P、Ctrl+S、Ctrl+Shift+F 这些全局快捷键；
    Ctrl+G、Ctrl+H、Ctrl+L、Ctrl+Z、Ctrl+/、Ctrl+]、Alt+Z 这些 Vim 不用的编辑器命令；Ctrl+W 关标签。
  - 插入模式里只有 Vim 的插入键归它：Ctrl+C、Ctrl+[（回普通模式）、Ctrl+W、Ctrl+U（删词、删到行首）、
    Ctrl+T、Ctrl+D（缩进）、Ctrl+R（插入寄存器）、Ctrl+O（执行一条普通模式命令）。别的照常：Ctrl+F 查找、
    Ctrl+A 全选、Ctrl+Space 补全、Ctrl+V 粘贴。
  - 两种模式都被 Vim 占着的有两个键，所以这两个编辑器命令在 Windows / Linux 的 Vim 方案下没有键可按：
    Ctrl+D「选中下一处相同的文字」、Ctrl+U「撤销选区变化」。
  - macOS 上工作台的键用 ⌘，与 Vim 的 Ctrl 键不撞；受影响的只有插入模式里的 ⌃T（重构 → Vim 的缩进）。
- **Esc**：Vim 方案下编辑器里的 Esc 不再漏到全局去关右侧面板（它按得太勤）。先后是：Vim（回普通模式）、
  补全列表、查找栏、收起多个选区；都没事做也用掉。
- **ex 命令**（全局登记一次，靠编辑器状态里的宿主落到敲命令的那个编辑器）：`:w` 就是编辑器平常的保存
  （保存时格式化、收拾行尾空白照常）；`:q` 走 ⌘W 那条关闭（固定的标签不关，没保存的改动先问；`:q!` 与
  `:q` 一样，不会不问就丢改动）；`:wq` 先保存，等保存落定、确实存下了才关（外部改过、写盘失败就留着）；
  `:wa` 是「保存全部」。`:x`、`ZZ`、`:qa` 没有接。
- **模式**显示在状态栏行列号前面（NORMAL / INSERT / REPLACE / VISUAL / VISUAL LINE / VISUAL BLOCK）。
  `workbenchEditorVim.ts` 记着各编辑器的模式，两组并排时显示最近得到焦点的那个；状态栏只认这个文件，不
  引 Vim 那一层。换文件时模式回到普通模式（Vim 的状态跟着视图里的插件走，换文件会重建）。
- **配合的几处**（都在 `workbenchEditorVimLayer.ts`）：离开插入模式时收起补全列表；刚打开的文件按下第一个
  键就亮出光标（那个处理排在 Vim 后面，改用「旁观」方式听）；换文件时把开着的提示条和它的定时器收掉，
  换回来时把状态里记着的「命令行开着」对回去，不然会留一条空壳、下一次 `:` 出不来；命令行和块状光标用
  工作台的颜色变量。
- 这一层对包的几处假设（按键入口、默认键位表里 Vim 用的 Ctrl 键、提示条的开合方式）在
  `tests/workbench-editor-vim.test.ts` 里对着包的源码钉着，升级包之后对不上会先在那里报。

### 体积

命令面板在工作区外壳里，要提示编辑器命令的键，所以两张表进外壳那一块（外壳约多 11 KB）；认按键的代码
（`workbenchEditorKeymapResolver.ts`）跟着编辑器那一块；设置里的方案选择和按键列表在设置对话框那一块
（约多 5 KB）；命令的名字在界面文案里，随启动入口加载（约多 8 KB）。Vim 是单独的两块，没选 Vim 方案不
加载：接入层约 4 KB，包约 123 KB。

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

## Git

提交面板、底部的 Git 工具窗、编辑区里的差异与改动标记都走主进程的 `WorkbenchGitService`
（`src/main/workspace/git/`）：每个操作起 `git` 子进程、解析它的输出。数据形状在
`src/shared/contracts/workspaceGit.ts`，IPC 通道与请求在 `src/shared/workbenchGit.ts`
（`workbench-app:git:*`，入参在 `WorkbenchGitIpc.ts` 里逐项校验）。

- **环境**：登录 shell 的环境全应用只解析一次（`src/main/index.ts` 的 `createShellEnvironment()`，第一次
  用到才起登录 shell，不拖慢启动；读不出来退回应用自己的环境），Agent 的命令、外部引擎和 Git 共用这一个
  实例。`WorkbenchGitService` 与拍检查点的 `WorkbenchChatCheckpointService` 都从构造参数拿它
  （`environment`），所以从程序坞启动时提交钩子（husky）、git-lfs 这类过滤器、nvm 装的 node 也找得到；
  测试与探针（`gitProbe.ts`）给的是一份固定的环境，不看这台机器的 shell 配置。
- **输出**：每条命令带 `GitOutputConfig`（`core.quotePath=false`、固定的 diff 前缀、不着色……）并钉死
  C locale，解析不跟着用户的 git 配置和界面语言变；列路径的命令一律 `-z`，中文文件名不会被转义。
- **范围**：项目可以是仓库里的一个子目录。命令在项目根下跑，状态、差异、提交只看项目里的文件。
- **分离的 HEAD**：状态（`WorkspaceGitStatusResult`）与顶栏的轻量快照里，`branch` 为 null 时
  `detachedHead` 给出 HEAD 停在的提交（`sha`、`shortSha`）。顶栏的 Git 控件看的是「HEAD 有得显示」
  （`hasWorkbenchGitHead`），不只认分支：分离的 HEAD 上按钮写「分离的 HEAD · 1a2b3c4」
  （`describeWorkbenchGitHead`），菜单里没有哪个分支算当前的，照常切回分支、新建分支；菜单里的拉取、
  同步、推送和提交面板的推送按不了并写明原因，获取远端和点名某个分支的推送照常能用。
- **顶栏的 Git 控件只有一个**（`WorkbenchGitBranchControl`，面板是 `WorkbenchGitBranchMenu`）：按钮上
  是当前分支和落后（↓）、领先（↑）上游的提交数；点开的面板从上到下是当前分支的拉取、推送、同步、获取
  远端（跑着的时候换成进度和取消），搜索，分支列表（按名字里的 `/` 排成树；点一下签出，悬停出「签出」
  「推送」；远端分支签出成同名的本地分支，本地没有就新建），新建分支。外框和面板的尺寸用 UI 包的顶栏
  控件（`TopBarControlFrame`、`--topbar-panel-*`），和项目菜单同一套；面板里的内容是 Workbench 自己
  的，不再用 UI 包的 `WorkspaceGitCommitControl`（它没有放远端操作的位置）。哪些操作按得了、为什么
  按不了、树怎么排，都在 `workbenchGitBranchMenuModel.ts`。合并、变基、拣选、撤销进行到一半时
  （`summary.operation`）：变基会把 HEAD 从分支上摘下来，按钮上写「feature（变基中）」而不是「分离的
  HEAD」；拉取、推送、同步、切换和新建分支都按不了，原因写的是「先在提交面板里继续或放弃」，只留获取远端。
- **模块**：`WorkbenchGitService` 是对外的唯一入口（IPC、测试、探针都找它）。成块的新功能另放文件，
  经 `WorkbenchGitAccess` 借服务的内部能力（跑 git、项目在仓库里的位置、状态、报错口径），不各起各的
  git：贮藏在 `WorkbenchGitStashes.ts`，合并、变基、拣选、撤销在 `WorkbenchGitOperations.ts`。
- **贮藏**（`stash` / `listStashes` / `performStashAction`）：只贮藏项目里的改动（`git stash push -- .`），
  未跟踪的文件要勾了才带上。一条贮藏凭贮藏提交的对象名认，不凭 `stash@{n}`——每来一条新贮藏旧的序号
  都往后挪，动手之前按对象名重新找序号，找不到就说它不在了，不去碰别的贮藏。取回（apply / pop）之前先查
  有没有挡着的：贮藏要改的文件在工作区里还有没暂存的改动、贮藏里的未跟踪文件在工作区里已有同名的。
  git 自己遇到这两种情况会取回一半就停（另一半照做、贮藏不删），所以这里动手之前就拦下、一点都不动。
  取回时与已提交的内容冲突不算失败：冲突文件（状态 `UU` 等）走合并冲突那一套（提交面板的「合并冲突」、
  编辑器里解决、标记为已解决），贮藏留着。还有没解决的冲突、合并或变基进行到一半时不贮藏也不取回
  （贮藏完工作区是 `reset --hard` 过的样子，那次合并就丢了）。贮藏里的改动用 `getDiff({ stashSha })`
  读：相对它基于的提交的差异，加上第三个父提交里的未跟踪文件。界面上，提交面板的贮藏按钮开对话框；
  列表在 Git 工具窗左侧分支下面，选中一条在右侧看改动、应用、弹出、删除（删除先确认）。
- **提交图**（Git 工具窗中间一栏）：`getLog` 每个提交带父提交（`parents`，主线在前）和指着它的引用
  （`refs`：分支、远端分支、标签、分离的 HEAD，从 `--decorate=full` 的 `%D` 解析）。不给 `branch` 时是
  全部本地分支和远端分支加 HEAD（`--branches --remotes HEAD`，不用 `--all`：贮藏、AI 改动的影子检查点
  这些内部引用不进图），给了就只看那个分支；`--date-order` 保证子提交排在父提交前面。按页读
  （`limit` / `skip`，多要一个提交来判断 `hasMore`）。泳道由纯函数
  `layoutWorkbenchGitGraph`（`models/git/workbenchGitGraph.ts`）排：每条线占固定的一列，沿第一个父提交
  往下，到父提交那一行会合，空出来的列给后来的分支用；能接着上一页的状态往下排。列表
  （`WorkbenchGitLogList`）行高固定，只画视口附近的行，快滚到已读到的末尾就读下一页，最多读进一万个
  提交。`useWorkbenchGitLog` 在 Git 摘要每次刷新时只重读第一页，与已读到的开头一样就什么都不换；
  开头变了（有新提交、引用挪了）才把已读到的那一段整个重读。搜索只在已读到的提交里找，这时不画图
  （线接不上），末尾放「读取更早的提交」由用户点，不自动把整段历史读进来。
- **合并、变基、拣选、撤销**（`performOperation`，通道 `workbench-app:git:operation`）：`merge` 把一个
  分支并进当前分支，`rebase` 把当前分支变基到一个分支上，`cherry-pick` / `revert` 拣选、撤销一个提交
  （合并提交按第一个父提交算它带来的改动，`-m 1`）；`continue` / `abort` / `skip` 是对停在半路的那个
  操作说的。都不开编辑器（合并说明、步骤单用 git 备好的），不做交互式变基。同一时刻只有一个操作：
  已经有一个停在半路、或者还有没解决的冲突时不再开始新的；合并、变基要有当前分支（分离的 HEAD 上拒绝）。
  出了冲突不算失败：结果里列出冲突文件，操作停在那里。会覆盖没提交的改动或未跟踪的文件时 git 自己
  不动手，它的说明（哪些文件）原样转给用户；`abort` 只还原这次操作动过的已跟踪文件。摘要
  （`SystemWorkspaceGitSummary.operation`）每次刷新都带着进行到一半的操作（种类、对象、变基到了第几个
  提交），是从 git 目录里的标记读的（`MERGE_HEAD`、`rebase-merge/`、`rebase-apply/`、`CHERRY_PICK_HEAD`、
  `REVERT_HEAD`），不起进程，所以在终端里起了头的操作也看得到。界面上：Git 工具窗里在分支上（左侧的
  分支、提交行上的分支标签）点右键合并、变基，在提交上点右键拣选、撤销，动手前都先确认；提示条
  `WorkbenchGitOperationBanner` 在提交面板和 Git 工具窗上方各一个，给出继续（冲突解决完才能点）、
  跳过（合并没有）、放弃（先确认）。冲突文件走原有的那一套（提交面板的「合并冲突」、编辑器里解决、
  标记为已解决）。`useWorkbenchGitOperation` 是这些入口共用的：编辑器里有没保存的内容、拉取或同步
  正在跑时不动手，每个项目同一时刻只跑一步。合并、拣选、撤销停着时提交按钮照旧能把它做完（提交的是
  整个暂存区）；变基停着时提交按钮禁用，用提示条上的「继续」。日志里的分支标签交给 git 的是完整的
  引用名（`refs/heads/…`），主进程再换成 git 认得出的最短写法，同名的标签不会被当成分支。
- **文件历史**：`getLog({ path })` 用 `--follow` 跟着改名往回找，每个提交带着文件当时的路径（`path`），
  读那时的内容用它；与现在的路径不同时历史列表在作者后面写出来（`workbenchGitFileHistory.ts`）。
- **差异查看器**（`WorkbenchUnifiedDiffRows`，Git 改动、本地历史、AI 改动共用）：吃的是一列差异行
  （`WorkbenchUnifiedDiffRow[]`），两种排法都从这一列行摆出来，不另读数据。
  - **排法**：上下合在一栏（`unified`，默认）或左右并排（`split`），存在偏好 `diffLayout` 里，三处查看器
    工具栏上的 `WorkbenchDiffLayoutToggle` 切换，切一处三处都变，下次打开还是它。并排时是两个 CodeMirror
    视图：左栏改动前（只有旧行号）、右栏改动后（只有新行号）。`buildWorkbenchDiffPaneLayout`
    （`models/git/workbenchDiffSideBySide.ts`，纯函数）把一块改动里的第 n 个删除行对着第 n 个新增行，
    多出来的那一侧对着空的占位行（斜纹），所以两栏行数相同、逐行对齐；块上方的按钮（暂存、回滚这一块）
    在右栏，左栏同一行上放一份看不见的，占同样的高度。两栏一起滚（上下、左右）：跟过去的那一下产生的
    滚动事件凭「位置正是刚写进去的」认出来、不再传回，两栏能滚的范围不一样时也不会来回弹。重读差异、
    换排法之后按「视图顶上对着哪一行差异行」回到原处，不按像素。
  - **行内变化**：改过的行里变了的词底色再深一层，两种排法都有。`computeWorkbenchDiffInlineChanges`
    （`models/git/workbenchDiffInlineChanges.ts`，纯函数）按块比：一块是连着的删除行加上紧跟着的新增行，
    两边各拆成词（一串字母数字下划线是一个词，汉字、假名一个字一个，一串空白一个，其余符号一个一个），
    跨行一起求最长公共子序列——行数对不上（一行拆成两行、中间插了一行）也对得齐。只有删除或只有新增的块
    不比；一行里没变的实字不到两成算整行都换了，不标。**工作量有上限**：去掉两头相同的词之后，一块最多比
    40 万格（旧词数 × 新词数），整份差异最多 400 万格，一块两侧加起来超过 40 万字连词都不拆；超过的块
    只有整行的底色。所以再大的差异这一步也只花几十毫秒，一行很长只改了一个词的照样标得出。
  - **加载**：查看器本体（`ReadOnlyDiffCodeMirror`：视图、装饰、并排、行内变化）是按需加载的块，不在
    工作区外壳里；`WorkbenchUnifiedDiffRows` 只从它拿类型。本体就位之前要的「跳到第一处改动」先记着，
    就位后补上。Git 差异面板打开时在空闲里先把它拉下来。
- **远端操作**（获取、拉取、同步、推送）：连远端的命令带 `--progress`，只看有没有动静，不限总时长——
  5 分钟没有任何输出才算卡住、结束它；结束的是整个进程组（先 SIGTERM 让 git 收拾锁文件，再强杀），
  git 起的 ssh 一并带走。renderer 给每次操作起一个 `operationId`，凭它经
  `workbench-app:git:cancel-remote-action` 取消，那次操作以 `CANCELLED` 收场。renderer 这边一个项目同一
  时刻只跑一个远端操作（`workbenchGitRemoteOperation.ts` 登记，`useWorkbenchGitRemoteAction` 是顶栏
  分支菜单、提交面板推送按钮的统一入口），所以不管谁发起的，顶栏的分支按钮都转圈，点开就能取消；跑着
  的时候不切分支、不新建分支。
  给用户看的失败说明里去掉了 git 的进度行。Windows 上没有进程组，取消只结束 git 进程本身。

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

### 语言服务替用户写代码时的缩进

一个文件用什么缩进由 renderer 定（`resolveWorkbenchIndentation`：状态栏里选的 > `.editorconfig` > 按正文识别 >
语言默认），状态栏显示的就是它。凡是要语言服务写出代码的请求都把它带上（请求的 `format`：制表符宽度、一级几格、
空格还是制表符）：格式化文档（编辑器里的 ⌥⌘L、保存时格式化、命令面板）、补全（补全类成员、对象方法时整段插入的
代码）与接受补全时的自动导入。worker 里 `buildWorkbenchTypeScriptFormatCodeSettings` 按它出 TypeScript 的
`FormatCodeSettings`，其余排版规则仍是 TypeScript 的默认值；没有 Prettier 时内置的 JSON 格式化每级缩进也用它。
请求没带时两格空格。IPC 边界只收 1–16 的整数宽度，别的当没给（宽度为 0 会让 TypeScript 排缩进时除以零）。
项目装了 Prettier 时照旧以 Prettier 为准。

TypeScript 一次只收一套排版，而一份修复可能动到别的文件。`mapTypeScriptFileChanges` 对落在请求文件之外的那部分，
在那个文件自己的缩进（`detectWorkbenchIndentation`，在 `src/shared`，识别不出来用请求文件的）或分号习惯不一样时
按它的再算一遍后换上。写不写分号不交给 TypeScript 自己猜：它把类型字面量里的分隔符（`{ x: number; y: number }`）
也算成「写了分号」，不写分号的文件里只要有一处这样的类型，抽出来的代码就带上分号；新建的文件更是一律带分号。
这里只数语句，看准了不写分号才明说去掉（`omitsSemicolons`）。

### 代码动作（快速修复与重构）

光标处的动作菜单（⌥↩ / Alt+Enter、⌘. / Ctrl+.、右键「快速修复…」、命令面板）与诊断浮层上的修复按钮走同一条路：
`useEditorCodeActions` 问 `getCodeActions`，把改动套上。同一个菜单里修复在前、重构在后；「重构…」（⌃T，别的平台
Ctrl+Alt+Shift+T，右键、命令面板）只列重构，按「提取、内联、移动、改写、其它」分组（取自 TypeScript 给的种类）。

- **重构**：`getApplicableRefactors`（请求的 `categories` 里有 `refactor` 才问；诊断浮层不问）只列名字，此刻做不了的、
  要再问用户一步的（「移到文件」要挑目标）不列；选中时 `getEditsForRefactor` 才算改动。TypeScript 给了改名位置
  （抽出来的 `newFunction`、`newLocal`）时，worker 按套完改动之后的正文把它换成行列与偏移交回来，编辑器套完改动
  就在那里开行内改名。「移到新文件」的新文件在结果的 `createFiles` 里。

- **整理 import**（⇧⌥O / Shift+Alt+O、右键、命令面板）：`getOrganizeImports` → TypeScript 的 `organizeImports`（排序、
  合并同一个模块的导入、去掉没用到的），只改当前文件、一步撤销。已经整理好的文件 TypeScript 照样把 import 段原样
  重写一遍，worker 发现套上去正文不变就不给改动，免得平白多出一步撤销。
- **worker**：TypeScript 的修复在 `TypeScriptCodeActions.ts`。诊断按请求里的正文现算（不靠编辑器里那份，它可能
  还没刷新），只对 TypeScript 登记了修复的诊断码去问 `getCodeFixesAtPosition`，一次最多 12 条诊断。TypeScript 给了
  「同类问题一起修」（`fixId`）且文件里确实还有同类诊断时多列一项，它的改动在选中时才算（`resolveCodeAction` →
  `getCombinedCodeFix`）。外部语言服务器仍按请求里带的诊断给修复（编辑器里的诊断上挂着语言服务当初给的那一条，
  诊断码、来源才交得回去）。
- **改动怎么落**：当前文件的由编辑器自己 `dispatch`（一步撤销）。动到别的文件、要新建文件的交给页面
  （`applyLanguageServiceWorkspaceEdit`）：先建新文件（`createWorkbenchEntry` 再经保存管线写正文，与文件树里新建
  走同一条路），建成了才让编辑器套当前文件的那部分，再改别的文件（开着的改编辑缓冲，没开着的写盘，与跨文件改名
  同一套），最后只在碰了编辑器之外的文件时报告改了几个。
- **过期的结果**：每次请求记下当时的文档对象，结果回来、动作被选中、页面回头让编辑器套改动时，编辑器不在那份
  文档上（又打了字、换了文件）就作废。只读的编辑器不给任何会改代码的动作。
- **菜单里的键**：动作菜单的每一项是按钮，方向键、Home / End 与工作台别的菜单同一套
  （`handleWorkbenchMenuKeyDown`），一打开焦点落在第一项上，回车套用；收起之后焦点还给编辑器。Esc 在菜单里
  收住，不往窗口上传——全局快捷键里 Esc 还管着收起右侧面板。查找引用的列表也用同一套方向键。
- **按键**：这些组合不走 CodeMirror 的键位表，而是排在它前面直接接 keydown（`workbenchEditorCommandKeys`）：键位表
  在 macOS 上认不出带 ⌥ 的字符键（打出来的是别的字符）。命令面板里的代码动作经 `editorCommandRequest` 交给眼前的
  编辑器，因为光标在哪只有它知道。

### 文件改名之后更新 import

在文件树里给 JavaScript / TypeScript 文件（或含有它们的目录）改名、挪位置，做成之后引用它们的 import 跟着改，
被挪走的文件自己的相对 import 也改；完了报一次改了几个文件，没有要改的不出声。改名本身不等这件事：
`useWorkbenchMutationController` 做成之后把「哪些项从哪到哪」交给 `onEntriesMoved`，后面的事都在
`createWorkbenchImportUpdater`（`models/editor/workbenchImportUpdates.ts`）里慢慢做，语言服务慢了、出错了只是
出一条「没能更新 import」的提示。

- **renderer**：一轮一轮地做。请求带上所有开着的 JS/TS 标签的正文（改动最后套在编辑缓冲上，行列得照缓冲算；
  标签还没跟着挪到新路径的按新路径带）。答复回来时哪个引用方的正文已经变了，就按新正文重算，连着三轮都赶不上的
  那个文件不改、报出来。上一轮还没答复又有新的改名，旧的作废，两批改名合成一份重新问：先 a → b 再 b → c，引用方
  手里写的还是 a，要问的是 a → c（`composeWorkbenchImportUpdateRenames`）。改动经 `applyLanguageServiceEdits`
  落下去，与跨文件改名同一套：开着的改编辑缓冲，没开着的写盘。
- **worker**（`getFileRenameEdits`）：请求到的时候磁盘上已经是新位置。先让旧位置的文件退出项目
  （`forgetMovedTypeScriptProjectPath`——目录改名的磁盘通知里只有目录自己的路径，它下面的文件没人清），再对每个
  该问的项目调 TypeScript 的 `getEditsForFileRename`。挪到新位置的文件以覆盖层的身份带进每个项目：TypeScript 要在
  程序里找得到新位置的文件，才肯把经别名指向旧位置的 import 改过去。
- **问哪些项目**（`planTypeScriptFileRenameProjects`）：被挪文件现在归的项目；文件清单里有它的别的配置
  （`tsconfig.json` 只管 `src`、另一份配置连 `tests` 一起管是常见布局，只问前者测试里的 import 就没人改——这类
  项目池子里有空位才新建，不为它挤掉正在用的）；以及其余已经建着的项目。一个文件的改动只认最先给出的那个项目。
  没建着、清单里又没有被挪文件的项目（monorepo 里经别名引用它的别的包）问不到，那里的 import 不会改。
- **别让 TypeScript 反复核对程序**：`getEditsForFileRename` 对程序里每个文件、每条 import 都经它的 source mapper
  问一次「这个声明文件在不在程序里」，每问一次取一次程序；宿主不给项目版本时，每次取程序都把全部源文件核对一遍。
  带着依赖有八千多个源文件的项目（本仓库就是）里，一次改名因此要算十几分钟。计算期间给一个不变的项目版本
  （`freezeTypeScriptProgramWhile`），出来就撤掉——平时照旧让 TypeScript 每次核对，缺过的文件出现了它自己能发现。
  宿主还挡掉了声明映射（`getDocumentPositionMapper` 返回空）：不然程序里每个依赖包的 `.d.ts.map` 都要读一遍、解码
  一遍。两样都做了之后，本仓库改一个被几十处引用的文件名约两秒（两个项目各八千多个源文件），挪一个一百七十个
  文件引用着的目录约四秒。
- TypeScript 只换引号里的模块路径，别的字不动，所以这里不涉及缩进、分号、引号，请求也不带 `format`。tsconfig 里
  写死的路径（`files`、`paths`）不改。不是 JS/TS 的文件（JSON、样式、图片）改名不更新引用。

### 查找引用

⇧F12（另有 ⌥F7 / Alt+F7）、右键「查找引用」、命令面板：光标处符号的全部引用列在编辑器里的定义 / 引用面板上
（`EditorSymbolLocationsPanel`，跳到定义时顺带出来的也是它）。按文件分组，发起时所在的文件排最前；每行是行列与
那一行的文字，定义那一行另有标记。键盘焦点直接进列表：↑↓ 挑、回车跳过去、Esc 关掉并把焦点还给编辑器。跳过去
之后面板跟到目标位置上（上面多一行「返回」），焦点留在编辑器里。只读的文件照样能查。

- **编辑器这边**：`useEditorSymbolNavigation` 问语言服务要引用（顺带问一次定义，只为给那一行打标记），每次请求记下
  当时的文档，答复回来时编辑器不在那份文档上、或者又发起了新的一次就作废。这类命令（`find-references`）与改代码
  的动作走同一条按键 / 命令面板通道（`workbenchEditorCommands`），但不看只读。
- **面板的状态两组共用**（`useEditorSymbolLocations`，在 `EditorGroupsPanel`）：点列表里的一行，目标文件开在另一组
  里时，面板跟到那一组的编辑器上——哪一组正显示着「眼下那一处」所在的文件，面板就画在哪一组。跳转带着
  `preview: true`，目标以预览标签打开。
- **worker**：`getReferences` 给每个位置配上所在行的文字（`preview`，去掉首尾空白，最长 200 字符；内置 TypeScript、
  外部语言服务器、Markdown 都配）。行列照引用所在那个文件此刻的正文算：请求里带着的（编辑器里没保存的）优先，
  别的读盘。以前不在项目根文件里的文件（被 import 拉进程序的）照着请求文件的正文算，位置是错的或者被丢掉。
- 原来 ⇧F12 上的「选中这个文件里的全部出现」挪到了 ⇧⌘L / Ctrl+Shift+L：选中了字时照旧是 CodeMirror 的「选中
  全部一样的文字」，只是光标停在一个符号上时选它在这个文件里的全部出现。

### 调用层次

⌃⌥H / Ctrl+Alt+H、右键「调用层次」、命令面板：光标处的函数是根，下面列出调用它的函数，一层一层展开；面板头上
能换成「它调用谁」。点一行跳过去——看调用方时落在它发起调用的那一处，看被调用方时落在那个函数上；目标以预览
标签打开。面板停在编辑器右上角（样子沿用定义 / 引用面板），跳到别的文件、接着打字它都留着，Esc 或关闭按钮
收起。键盘：↑↓ 挪一行，→ 展开或进到下一层，← 收起或回上一层，回车跳过去。只有内置 TypeScript 服务的文件有。

- **worker**（`getCallHierarchy`，`TypeScriptCallHierarchy.ts`）：一次只答一层——那个位置上的函数
  （`prepareCallHierarchy`；停在调用处时是被调用的那个声明）和它的调用方（`provideCallHierarchyIncomingCalls`）或
  被调用方（`provideCallHierarchyOutgoingCalls`），每个带着调用发生的那几处与那一行的文字。下一层由界面拿某个
  调用方名字的位置再问一次。调用方、被调用方在项目之外的（标准库里的函数）不列。写在文件最外层的调用，调用方
  是那个文件，名字用文件名。
- **树**（`models/editor/workbenchCallHierarchy.ts`，纯函数）：节点第一次展开时才去问；这一支往上已经出现过的
  函数（递归、互相调用）到此为止，不再往下展开；问不到的记下原因，再展开会重问。
- **编辑器这边**：在 `useEditorSymbolNavigation` 里，与查找引用同一个 hook。面板每开一次、每换一次方向算新的一棵，
  之前那棵的答复回来不用。面板组件（`EditorCallHierarchyPanel`）用到时才加载，画进编辑器的容器里；它属于发起的
  那一组编辑器，那一组换文件它跟着留着。展开别的文件里的节点时，正文取编辑器里此刻的（开着的标签），没开着的
  由语言服务读盘。

### 转到文件中的符号（大纲）

⇧⌘O / Ctrl+Shift+O（设置里可改）、命令面板「转到文件中的符号…」，或在快速打开里输入 `@`：列出当前文件的符号。
没输入名字时是整个文件的大纲——按文件里的先后，嵌套的缩进，旁边带着外层的名字——并且先选中光标所在的那个
符号（摆在列表中间）；输入名字就按名字模糊筛，结果不再缩进，第二段输入可以落在外层名字上（`circle area`）。
每行前面是种类图标（与补全列表同一套图形，`workbenchSymbolKindGlyphs`），回车跳到名字上。它作用在当前组的
当前文件上，不新开标签。

- 纯逻辑在 `models/layout/workbenchQuickOpenSymbols.ts`；符号由 `useWorkbenchQuickOpenSymbols` 在进到 `@` 模式时按
  当前文件此刻的正文问一次语言服务（`getDocumentSymbols`），答复回来时已经换了文件、正文就不用。快速打开整个在
  按需加载的块里，这些都不进工作区外壳。
- worker 给的符号是按先后排的一列，嵌套靠 `depth`（一个符号的外层是它前面最近的、`depth` 少一的那个）；`line` /
  `column` 是名字的位置，`range` 是整个声明。内置 TypeScript 用的是导航树（`getNavigationTree`）：以前用的导航栏
  条目把每个类、函数在顶层又列一遍。import 进来的名字不列，没有名字的函数、类只在里面有东西要列时留着当外层，
  同一层按位置排（TypeScript 给的是按名字排的）。外部语言服务器、Markdown（标题按级别嵌套）照旧。

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

### 运行配置

▶ 菜单里的条目有两种来源：推出来的（`package.json` 脚本、最近跑过的命令，`workbenchRunConfigurations.ts`）和用户
自己建的（`workbenchNamedRunConfigurations.ts`）。用户建的排在最前面，每份有名称、命令、工作目录（项目里的相对
路径，空是项目根）和环境变量。配置有两种（`type`）：一条 shell 命令；或者一个 Node 程序——脚本（项目里的相对
路径）加参数，跑起来是 `node <脚本> <参数>`，脚本按工作目录写成相对路径。Node 程序还能调试（见下面的
「Node.js 调试器」）。存着的配置里种类认不出来的当命令型。

- **存在哪**：renderer 的 localStorage，键 `velaros.workbench.run-configurations.v1`，按项目 id 分（与命令历史同一种
  存法），不往用户的仓库里写文件。读出来的每一项重新校验：认不出的丢掉，工作目录不在项目里的退回项目根，环境
  变量不合规的清空。▶ 指着哪一份记在项目运行设置的 `configurationId` 里（`workbenchPreferences.ts`）。
- **怎么跑**：就是一张运行卡。`launchRunSession(command, label, launch)` 的 `launch` 带着 `cwd`、`env` 和
  `configurationId`，记在会话上，重启时照旧；▶ 判断「这份配置正在跑」按 `configurationId` 认，不按命令文本。
- **环境变量**：终端 start 请求的 `env`。主进程在 IPC 边界再校验一遍（`shared/workbenchRunEnvironment.ts`，名字
  只认字母、数字、下划线；有一项不对整份请求拒绝），然后盖在终端环境之上（`buildTerminalEnvironment` 的第三个
  参数）。node-pty 用 `name` 选项去设进程的 `TERM`，所以用户写了 `TERM` 时 `name` 也跟着它。值是明文存、明文
  显示的，不是密钥管理；日志里不写值。
- **界面**：▶ 菜单里点一行让 ▶ 指着它，行尾的小 ▶ 直接跑；「编辑运行配置…」（命令面板里也有）打开
  `WorkbenchRunConfigurationsDialog`，改动留在对话框的草稿里，点保存才整份写回。对话框按需加载，不进外壳包。

### 从编辑器运行测试（Vitest / Jest）

JS / TS 的测试文件（`*.test.*`、`*.spec.*`、`__tests__/` 里的）在行号旁多一栏 ▶：第一行的跑整个文件，每个
`describe` / `it` / `test` 旁边的只跑它自己；跑完标记换成上一次的结果（✓ / ✕）。命令面板里有「运行光标处的测试」
「运行当前文件的测试」。

- **认运行器**（`workbenchTestRunner.ts`）：从测试文件所在的目录往上到项目根，一层问一次文件系统（`package.json`、
  `vitest.config.*` / `vitest.workspace.*` / `jest.config.*`、各包管理器的锁文件）。第一个有依据的目录定下运行器
  和工作目录：配置文件或 `package.json` 的 `jest` 段 > 依赖（`vitest`；`jest`、`jest-cli`、`@jest/core`、`ts-jest`、
  `babel-jest`）> 脚本里提到。两个都有依据时，看测试文件自己引的是 `vitest` 还是 `@jest/globals`，再看谁的依据
  硬，一样硬选 Vitest。包管理器取一路上最先说清楚的（`packageManager` 字段，其次锁文件），没人说就是 npm。
  只读文件，不执行项目里的代码；结果按「项目根 + 目录」缓存，工作区在编辑器之外变了（`externalRevision`）重认。
- **找测试块**（`workbenchTestBlocks.ts`）：遍历编辑器已有的语法树里可见区那一段的 `CallExpression`，认
  `describe` / `suite` / `it` / `test`（及 `fdescribe`、`xit` 这些别名）和 `.only` / `.skip` / `.each(表)` /
  `.skipIf(条件)` 等写法；`test.extend({…})` 这类不是声明测试的不认。语法树还没到（刚打开文件先用基础着色）时
  没有标记，解析到了自动补上。
- **全名正则**：`-t` 的参数是「外层 describe + 自己」的全名。Jest 和老版本 Vitest 用空格连接各级名字，新版本
  Vitest 用 ` > `，所以各级之间写成 ` (?:> )?`，一条正则两边都能用。测试以 `$` 收尾；`describe` 只匹配开头并跟
  一个空格。模板字符串里的 `${…}`、`each` / `for` 标题里的 `%s`、`$name` 换成 `.*`；标题不是字面量的整段是 `.*`。
- **命令**：Vitest `<exec> vitest run <文件> -t '<正则>'`，Jest `<exec> jest --runTestsByPath <文件> -t '<正则>'`；
  `<exec>` 是 `npx --no-install` / `pnpm exec` / `yarn run` / `bunx --no-install`。在认出运行器的那个目录里跑
  （运行卡的 `cwd`），文件路径相对它。参数在 POSIX shell 下用单引号，Windows 的 cmd 下用双引号并把 `"`、`%` 换成
  `.`（对正则而言就是任意字符）。
- **结果**（`workbenchTestRunResults.ts`）：只看运行卡的退出码，0 是通过。终端事件那一层把每个会话的收口报到
  `workbenchRunSessionBridge`，被信号结束的（停止、关卡）没有结论，标记回到 ▶；卡被重启时改跟新会话。结果只在
  这次打开应用期间留着。
- **跟编辑器的接线**：编辑器组件只多一个 compartment，挂 `useWorkbenchEditorRunDebugExtension` 给的扩展。起运行卡
  经 `workbenchRunSessionBridge`（页面装上「先存盘再起卡」），命令面板经 `workbenchEditorActions`（编辑器挂着时
  登记它做得了的动作；编辑区拆成左右两组时，算最近得到焦点的那个编辑器）。这两个小模块在外壳包里，其余都跟着
  编辑器按需加载。▶ 右边的调试按钮见下面的「调试器的界面」。

## Node.js 调试器

调试的是 Node.js 上跑的 JavaScript / TypeScript；别的语言、别的运行时以后由插件来。主进程这一半在
`src/main/workspace/debug/`，main ↔ renderer 的契约在 `src/shared/workbenchDebugger.ts`（行号、列号从 1 起，
与编辑器一致）。没有引入第三方依赖：协议走运行时自带的 `WebSocket`，source map 自己读。

- **怎么起**（`WorkbenchDebugLaunch.ts`）：向操作系统要一个空闲的本机端口，拼出带
  `--inspect-brk=127.0.0.1:端口` 的命令行，在一个终端会话里跑——界面上就是一张运行卡，输出、按键、尺寸、
  结束整棵进程树都沿用终端那一套，start 的结果里带着 `terminalSessionId`。三种目标：
  - `node-script`：项目里的脚本，`node --inspect-brk=… <脚本> <参数>`；
  - `node-package-bin`：依赖包的可执行入口（从工作目录往上找 `node_modules/<包>/package.json` 的 `bin`），同样由
    node 直接带着检查器起——Jest 这类自己不认检查器开关的工具；
  - `inspect-command`：自己认 `--inspect-brk=主机:端口` 的命令，开关追加在命令末尾——Vitest。这类工具连上之后
    自己先停的那一下不给用户看。

  检查器只听 127.0.0.1。轮询 `/json/list` 等它就绪（默认最多 30 秒，等不到就结束程序、报 `failed`），WebSocket
  地址按端口自己拼，不用对方回的那个。需要 PATH 上有 `node`。
- **会话**（`WorkbenchDebugSession.ts`）：一条 Chrome DevTools 协议连接（`WorkbenchInspectorConnection.ts`）。检查器
  的事件和界面来的命令排成一条队，一件做完再做下一件——处理「脚本已解析」时要读 source map，排在它后面的
  「已暂停」得等它。程序的主上下文销毁时主动断开（否则 Node 一直等着调试器断开，进程不退出）。
- **断点怎么落到代码上**：
  - 没有 source map 的脚本（普通 JS、Node 自己去掉类型的 TS）：按文件地址下（`setBreakpointByUrl`，正则同时认
    `file://` 地址和原样路径）。脚本还没加载时先挂着，V8 编译时自己落好。
  - 带 source map 的脚本（`WorkbenchSourceMap.ts`，只读 v3 的 `mappings`；依赖包里的脚本不读）：脚本一加载就把
    源码行换成生成代码里的位置，按脚本下（`setBreakpoint`）。这得抢在脚本开始执行之前，靠三个停顿点：
    `--inspect-brk` 的「启动即停」、V8 的「带 source map 的脚本执行前」停顿、以及给每个有断点的文件在第一行
    预先挂的入口断点。这些停顿不给用户看，放行之后照常跑；停的那一处正好是用户断点所在（同一个脚本、同一行
    同一列）时才算作一次断点命中。
  - 就地转换的脚本（tsx、Jest、Vitest：脚本地址就是源文件自己）里按地址下的断点行号是生成代码的，认出来之后
    摘掉，只留按映射下的。tsx 交给 Node 的代码压成了一行，映射全靠列号；转换器自己加的代码（辅助函数、外面
    包的一层函数）映射不回源码，不放进调用栈。
  - 已知的空档：编译到别处的**非主**模块（`dist/lib.js` ← `src/lib.ts`）没有可靠的停顿点，它顶层代码里的断点
    可能在绑上之前就跑过去了；函数里的断点不受影响。
  - 每个断点回报 `verified` 与 `resolvedLine`：这一行没有可执行的代码时顺延到后面最近的一行；文件没被加载、
    这一行之后再没有代码，就对不上。
- **暂停的原因**：`breakpoint`、`exception`（只停未捕获的，开关可以随时改）、`pause`（用户按的；落在 Node 内部
  代码或转换器加的代码里时，一步步走到下一句程序自己的代码再停）、`step`、其余 `other`（`debugger` 语句）。
  调用栈里照样列出 Node 内部的帧（`node:` 开头的脚本），`path` 为 null。
- **单步不停在哪**：Node 内部代码、转换器加的代码，以及从项目代码出发的单步走进去的依赖包（`node_modules`；
  停在依赖包里的断点上之后，在里面单步照常一行行走）。V8 的黑盒（`setBlackboxPatterns`、单步命令的 `skipList`）
  对 `node:` 脚本不起作用（Node 24 实测），单步照样停进去，所以由会话自己把这一步走完（`continueStep`）：
  - 调用栈里还有用户的代码：在最近那一帧所在的函数里，每个可停的位置下一个临时断点，放程序跑，回到那个函数时
    停下，算这次单步。不靠连着「步出」往回走——从 `require` 那几层返回时 V8 会跟丢，程序一路跑下去。
  - 「单步进入」先往里走几十步（`emitter.emit` 到监听函数是十来步），走到用户的回调就停在那里；走不到的
    （`console.log`、`path.join`）等于跳过。正在加载模块时再给任何项目模块的第一行挂一个临时断点：在
    `require('./x')` 上单步进入，停在 x 的第一句（中间是 Node 的上万步，走不过去）。
  - 单步途中撞上调试器自己的停顿（入口断点、脚本执行前；V8 报的原因是「单步 + 别的」）不算这一步走完：
    「单步进入」停在那个脚本的第一句，「单步跳过」回到出发的那个函数，「步出」回到它外面最近的用户代码。
  - 调用栈里没有用户的代码了（主模块最后一句之后、定时器回调的末尾、测试函数的末尾）：程序继续跑。

  已知的局限：回去的路上抛了异常、越过了下着临时断点的那个函数，这一步就成了「继续」；那个函数递归时可能停在
  更深的一层；就地转换的模块，转换器加的语句如果映射到了源码的某一行（tsx 把导出表映射到第 1 行，Vitest 把
  导出的取值函数映射到被导入文件的第 1 行），单步会在那一行多停几下。只在 Node 24 上验过。
- **值**（`WorkbenchDebugValues.ts`）：写法照浏览器的开发者工具——字符串带引号，对象、数组是一行预览并带着
  `objectId`，展开时才去取属性（一次最多 500 个）；只有 getter 的属性不替用户去调（`accessor`），还没初始化的
  `let` / `const` 是 `unavailable`。在选中的帧里求值走 `evaluateOnCallFrame`；`sideEffectFree` 让有副作用的表达式
  直接失败（悬停看值用）。
- **归属与收尾**（`WorkbenchDebugSessions.ts`、`WorkbenchDebugIpc.ts`）：会话归发起它的窗口（`sender.id`），别的
  窗口的命令以 `PERMISSION` 拒绝；状态变化只推给那个窗口，程序输出走那个窗口的终端输出通道。结束调试
  （`stop`）= 断开检查器 + 结束终端会话的整棵进程树。窗口关闭、切走项目、应用退出时先断开调试会话，再由终端
  那边把进程收掉。
- **验证**：`tests/workbench-debugger*.test.ts` 调试真的 Node 程序（断点、单步、变量、求值、异常、三种起法、
  编译产物带 `.map`、加载器就地转换、压成一行的 ES 模块；单步走出用户代码之后停在哪在
  `workbench-debugger-stepping.test.ts`）；测试里用普通子进程起程序，伪终端那条路由
  `probe:debug`（`src/main/workspace/debug/debugProbe.ts`）在 Electron 运行时里验。Windows 上没有验过。

### 调试器的界面

- **断点**：JavaScript / TypeScript 文件里点行号下一个，再点摘掉；命令面板有「切换断点」。存在 renderer 的
  localStorage（键 `velaros.workbench.breakpoints.v1`，按项目根路径分，连同「未捕获的异常时暂停」这个开关；
  `models/debug/workbenchBreakpoints.ts`），读出来的每一项重新校验，只留最近动过的 64 个项目。编辑器里断点是
  一组跟着文档挪动的位置（`models/editor/workbenchBreakpointGutter.ts`）：上面插了行，断点跟着走，新的行号写回
  存储；行号上的点击经 `workbenchLineNumberClickFacet` 让给它（别的文件类型还是原来那个只在本地的标记）。调试中
  对不上代码的断点画成空心。
- **会话（界面这一侧）**（`models/debug/workbenchDebugSession.ts`）：一个窗口一次只调试一个程序，新的一次开始
  之前先结束上一次。它收主进程推来的事件，变成一份快照（正在调试的会话、停下时的调用栈与选中的帧、各断点对
  没对上、上一次怎么结束的），面板和编辑器都订阅；断点或异常开关变了就同步给正在跑的程序。「起好了」的回复
  到之前先到的事件攒着，回复到了再处理。
- **运行卡**：调试也是一张运行卡——`launch.debug` 带着要调试的目标，`useWorkbenchCommandController` 起卡与重启时
  据此改走调试器（`startWorkbenchDebugRunSession`），拿回来的 `terminalSessionId` 就是这张卡的会话；输出、停止、
  重启都照旧。调试之前先把没存的改动存盘（断点的行号要与磁盘上的文件对得上）。
- **从哪起**：▶ 指着一个 Node 程序配置时旁边多一个调试按钮（▶ 菜单里那一行也有）；测试的 ▶ 右边是调试按钮，
  命令面板有「调试光标处的测试」「调试当前运行配置」。调试测试时的起法：Vitest
  `<exec> vitest run <文件> -t '<正则>' --no-file-parallelism --testTimeout=0`（它自己认 `--inspect-brk`，关掉
  文件并行后测试就在那一个带检查器的进程里跑）；Jest 由 node 带着检查器起 `jest` 包的可执行入口，参数
  `--runInBand --runTestsByPath <文件> -t '<正则>' --testTimeout=100000000`。测试里抛出的异常（断言失败也是）
  由运行器接住，不算「未捕获」，不会停在上面——要看就在那一行下断点。
- **停下时**：页面把选中的那一帧的位置带到眼前（`navigate`，没开着的文件开成预览标签，已经开着的在它所在的
  那组里切过去），那一行铺底色（`workbenchDebugPausedLine.ts`，用视图插件直接给装饰）；除了单步走出来的停顿，
  底部换到调试面板。最里层是 Node 内部代码时选中最靠里的、项目里有文件的那一帧。没连上检查器（`failed`）时
  也把面板带出来，上面写着原因。
- **调试面板**（`components/debug/WorkbenchDebugPanel.tsx`，按需加载）：控制按钮、调用栈、按作用域分的变量
  （点开才取属性，换了一次停下或换了一帧就整块重来）、表达式输入框（在选中的帧里求值；程序继续跑过之后求过的
  对象不能再展开）。左下角的调试按钮在调试中出现。
- **按键**：继续 F8、单步跳过 F10、单步进入 F11、单步跳出 ⇧F11、结束 ⇧F5，登记在键位表里（设置里能改）。它们
  由 `useWorkbenchDebugShortcuts` 在捕获阶段处理，而且只在调试中、这个动作此刻做得了时才拿走按键——没在调试时
  F8 仍是编辑器里的「下一个问题」。F11 在 Windows / Linux 上是「视图 › 全屏」的菜单快捷键（菜单先拿到），在
  macOS 上默认是系统的「显示桌面」；F10 在 Windows 上会先激活菜单栏。这几处改不了键位的话，面板上的按钮和
  命令面板里的命令照样能用。
- **悬停看值**（`workbenchDebugHover.ts`）：停着时鼠标停在变量或 `a.b.c` 这样的属性上，在上方显示它的值（类型
  提示在下方）。只在选中那一帧所在的文件里求，求值带 `sideEffectFree`；有调用、有下标的不求。
- **外壳包里只有**：`workbenchDebugBridge.ts`（状态、动作、页面钩子、起调试时动态加载会话那一包）、
  `useWorkbenchDebugShortcuts.ts`、按钮与命令登记。会话、断点存储、面板和编辑器里的扩展都按需加载。

## 生产启动与体积预算

生产构建的 main 与 renderer 都开启压缩（electron-vite 给 renderer 的默认值是不压，要在配置里自己打开；
开发构建不压），完整 IDE 工作区在项目打开后按需加载；无项目的起手页不再静态
加载编辑器、终端和聊天（聊天的 Provider 装在按需加载的工作区外壳里）。Platform 的
`@velaros-ai/{model,script,velaros}` 不进 main bundle，运行时从 `node_modules` 以原生 ESM 加载
（清单 `scripts/release/mainExternalEsmPlatformPackages.json`，打包后逐个核对 asar 里的 import 闭包）。`bun run build` 会在输出完成后执行
`scripts/checkBuildBudgets.mjs`，统计 `index.html` 实际引用的启动 JS/CSS，并同时限制
main、renderer 总体积与最大功能块。

| 指标 | 当前基线 | 上限 |
| --- | ---: | ---: |
| main 入口 | 0.56 MB | 3.75 MB |
| main JavaScript | 1.10 MB | 6.50 MB |
| renderer 启动依赖 | 1.60 MB | 2.00 MB |
| renderer JavaScript | 17.99 MB | 19.00 MB |
| renderer CSS | 0.75 MB | 0.85 MB |
| renderer 最大功能块 | 2.03 MB | 2.30 MB |

单独复核已有生产产物时运行 `bun run check:bundle-budget`。预算留有小幅构建波动空间；
业务增长需要突破上限时，应先给出加载链数据并调整分包，再更新基线。

迁到 Platform 之后（2026-09-27）：main 小了一个量级，因为 Platform 的运行时不再打进 bundle；renderer
启动依赖减半，因为聊天随工作区外壳按需加载。最大功能块就是工作区外壳（其中图标库约 0.55 MB：每个
Phosphor 图标带六种字重；消息 Markdown 的代码高亮由 UI 包静态引入约 0.3 MB）。renderer 总量贴近上限，
增量主要是 UI 0.2.54 的 Markdown 图表（mermaid 各类图）按需分块；它们不进启动包，但计入总量。

2026-09-30：renderer 的生产构建此前一直没有压缩（旧的基线 25 MB、外壳 3.67 MB 都是原样代码）。打开压缩
后总量 17.65 MB、工作区外壳 1.98 MB、启动依赖 1.52 MB，各项上限按压缩后的体积重新定了。快速打开、设置
对话框、Git 工具窗、提交面板、AI 改动、浏览器面板和项目搜索都是从工作区外壳里拆出来按需加载的块
（`lazyWithPreload.ts`，空闲时预取）；新的面板照这个办法加，不要直接进外壳。总量里约 13 MB 是 UI 包带来
的按需分块（代码高亮的各语言语法与 mermaid），本仓改不了。

2026-10-01：编辑器的 P1 功能（Git 的 stash、提交图、merge / rebase / cherry-pick 与并排 diff，TS 代码操作，
运行配置、测试行内运行与调试器，键位方案）都并入之后重量了一次，就是上表：main 入口多 0.04 MB、总量多
0.08 MB；renderer 启动依赖多 0.08 MB（约一半是新功能的界面文案，两种语言的文案都随启动入口加载），总量多
0.34 MB，工作区外壳多 0.05 MB。上限没动，外壳离上限还有约 0.27 MB。
