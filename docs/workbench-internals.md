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
  按不了、树怎么排，都在 `workbenchGitBranchMenuModel.ts`。
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

生产构建的 main 与 renderer 都开启压缩（electron-vite 给 renderer 的默认值是不压，要在配置里自己打开；
开发构建不压），完整 IDE 工作区在项目打开后按需加载；无项目的起手页不再静态
加载编辑器、终端和聊天（聊天的 Provider 装在按需加载的工作区外壳里）。Platform 的
`@velaros-ai/{model,script,velaros}` 不进 main bundle，运行时从 `node_modules` 以原生 ESM 加载
（清单 `scripts/release/mainExternalEsmPlatformPackages.json`，打包后逐个核对 asar 里的 import 闭包）。`bun run build` 会在输出完成后执行
`scripts/checkBuildBudgets.mjs`，统计 `index.html` 实际引用的启动 JS/CSS，并同时限制
main、renderer 总体积与最大功能块。

| 指标 | 当前基线 | 上限 |
| --- | ---: | ---: |
| main 入口 | 0.52 MB | 3.75 MB |
| main JavaScript | 1.02 MB | 6.50 MB |
| renderer 启动依赖 | 1.52 MB | 2.00 MB |
| renderer JavaScript | 17.65 MB | 19.00 MB |
| renderer CSS | 0.72 MB | 0.85 MB |
| renderer 最大功能块 | 1.98 MB | 2.30 MB |

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
