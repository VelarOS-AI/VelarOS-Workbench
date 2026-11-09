# 剩余阅读与实施清单

2026-11-09，源码游标 `724ab61`。此表区分全文阅读证据、尚未修复的已读边界、源码验证及运行矩阵，
不从文件数或提交数推导完成率。后续若有原始全文回执，可直接扣除对应项，无须重读已审模块找新题。

## 已具名范围与阅读缺口

main / preload / shared 当前生产源码已有具名或明确目录全文记录，剩余未证实全文路径为 **0**。
renderer 当前有 **95** 个行为源码路径尚未合并到完整正文阅读回执：42 个已有具体接缝，53 个尚无精确全文回执。
“未证实全文”不等于断言无人读过，也不等于存在缺陷；已修已验的文件仍可只欠其余正文的阅读证据。
两份 i18n provider/locale 小模块和 CommentHandoff 已按父线全文记录扣除。

工程范围仅有 `scripts/test/conversationRuntime.test.mjs` 的完整阅读证据待补；它是默认测试活跃入口，
不归为产品 runtime 未读。`scripts/release/mainExternalEsmPlatformPackages.json` 仅欠配置数据本身的明确核对，两个真实消费者已全文。

## renderer 精确路径

### A1. 已有实际接缝，未证实其余正文全文（42）

| 当前精确路径 | 已知阅读边界 |
| --- | --- |
| `src/renderer/src/components/aiChanges/WorkbenchAiChangeDiffPanel.tsx` | 记录读取/回顾与真实cache hook消费接缝；组件其余主体未证实全文。 |
| `src/renderer/src/components/aiChanges/WorkbenchAiChangesPanel.tsx` | 记录读取/回顾与真实cache hook消费接缝；组件其余主体未证实全文。 |
| `src/renderer/src/components/embedded/workbenchEmbeddedKernelModel.ts` | 真实adapter/context形状接缝；不能由Kernel/Adapter全文外推model全文。 |
| `src/renderer/src/hooks/useProjectHubState.ts` | 项目身份/窗口事件消费接缝；未见此hook全文回执。 |
| `src/renderer/src/hooks/useWorkbenchCommandController.ts` | 启动/stop/restart、layout资源owner、pending接纳及bootstrap全链已读/修；旧库存明确只计这些段落，未证实大hook其余正文全文。 |
| `src/renderer/src/hooks/useWorkbenchLanguageServiceInsights.ts` | 请求批次及语言worker真实consumer接缝；语言owner明确不重审renderer整模块。 |
| `src/renderer/src/hooks/useWorkbenchProductAnalytics.ts` | 外部Settings故障实现diff与父线审阅/验证已完成；没有收到整个hook全文的明确回执。 |
| `src/renderer/src/hooks/useWorkbenchProjectRunSettings.ts` | 配置/Preferences实际消费接缝；不可由runconfig三个model全文外推本hook全文。 |
| `src/renderer/src/hooks/useWorkbenchProviderModelCatalog.ts` | Provider/model公开catalog消费/准入接缝；root-late全文四文件不包含此hook。 |
| `src/renderer/src/hooks/useWorkbenchTopRunControl.ts` | 运行前保存准入修复及真实消费段已读/验证；未证实其它正文全文。 |
| `src/renderer/src/main.tsx` | 入口/装配已核，当前完整末尾阅读记录未具名。 |
| `src/renderer/src/models/chat/workbenchChatComposerPlaceholder.ts` | Adapter真实placeholder调用已核；helper主体全文未证实。 |
| `src/renderer/src/models/chat/workbenchChatFileReferences.ts` | Adapter文件引用/草稿上下文消费已核；helper主体全文未证实。 |
| `src/renderer/src/models/chat/workbenchChatWorkspacePath.ts` | block hooks真实路径解析消费已核；helper主体全文未证实。 |
| `src/renderer/src/models/chat/workbenchGoalAutoContinue.ts` | 实际goal续跑决策入口/参数及既有测试接缝已核；model主体全文未明确登记。 |
| `src/renderer/src/models/commands/workbenchTerminalFileLinks.ts` | TerminalFileLinks hook、终端组件真实消费已核；不由消费者全文推定model全文。 |
| `src/renderer/src/models/commands/workbenchTerminalFind.ts` | 终端search实际调用已核；model全文未证实。 |
| `src/renderer/src/models/commands/workbenchTestRunner.ts` | editor运行gutter/debug启动消费接缝；未证实整个model正文全文。 |
| `src/renderer/src/models/debug/workbenchBreakpoints.ts` | 断点store更新/通知producer已核；旧记录仍仅该接缝。 |
| `src/renderer/src/models/files/workbenchProjectFileList.ts` | ProjectFileList hook已全文；listing模型的全文证据未明确，不能只因同名推定。 |
| `src/renderer/src/models/layout/workbenchKeyboardShortcuts.ts` | 外部Space/P2修复diff、真实记录/派发case及父线审验已完成；整文件全文回执未明确。 |
| `src/renderer/src/models/project/workbenchProjectPresentation.ts` | 项目UI消费/迁移接缝；明确全文的ProjectSession/ContextIndex/Projects集合不含此文件。 |
| `src/renderer/src/models/workbenchVelarProjectGraph.ts` | 项目snapshot index/合并/筛根真实消费已核；3个codeGraph UI及shared图全文不自动覆盖本renderer model。 |
| `src/renderer/src/runtime/conversation/WorkbenchAgentEngineBrandIcon.tsx` | 实际running marker/engine显示导入接缝；未具名全文。 |
| `src/renderer/src/runtime/conversation/WorkbenchRunningRuntimeMark.tsx` | render slot的真实调用入口；未具名全文。 |
| `src/renderer/src/runtime/conversation/workbenchConversationEngineContext.ts` | 实际engine provider/context消费接缝；未具名全文。 |
| `src/renderer/src/runtime/standaloneChatScrollPositions.ts` | Adapter read/write接口与restore key消费已核；存储模块主体全文未明确。 |
| `src/renderer/src/runtime/standaloneUsageTelemetry.ts` | restore/序列化/身份消费及summarizeStandaloneUsage方法已读；仍未记整个文件全文。 |
| `src/renderer/src/runtime/standaloneWorkbenchCheckpoints.ts` | Adapter检查点/系统说明/append实际producer与类型接缝；不由Adapter全文推定helper全文。 |
| `src/renderer/src/runtime/workbenchAgentBrowserSite.ts` | 浏览器选中快照/地址归属修复消费接缝；其余正文未证实全文。 |
| `src/renderer/src/runtime/workbenchAgentEngines.ts` | 引擎状态/模型选择与启动准入消费接缝；未具名全文。 |
| `src/renderer/src/runtime/workbenchAgentProjectWrites.ts` | publisher/subscriber与Git/editor刷新消费链已核；未明确记该helper全文。 |
| `src/renderer/src/runtime/workbenchBrowserElementContext.ts` | 专项导入及prompt格式化/选择数据消费接缝；初始记录明确不算整模块。 |
| `src/renderer/src/runtime/workbenchClipboardFile.ts` | 附件/剪贴板本机路径消费接缝；未明确记模块全文。 |
| `src/renderer/src/runtime/workbenchMessageDedupe.ts` | 消息宿主/通知实际消费接缝；helper全文未证实。 |
| `src/renderer/src/runtime/workbenchMessageHost.tsx` | 消息host实际接线与useStableWorkbenchMessaging消费已核；host主体全文未明确。 |
| `src/renderer/src/support/genericHooks.ts` | latest/memoized/monotonic/TimerScope相关调用段；Git owner明确没有全文件阅读。 |
| `src/renderer/src/support/lazyWithPreload.ts` | lazy实际装配/预热消费；helper主体全文未明确。 |
| `src/renderer/src/support/useBlockWheelScroll.ts` | CM菜单wheel控制消费；hook主体全文未明确。 |
| `src/renderer/src/support/useDismissOnWindowInteract.ts` | CM/菜单dismiss实际调用；hook主体全文未明确。 |
| `src/renderer/src/welcome/NewProjectDialog.tsx` | 项目打开/新建/切换真实消费已核；ProjectPicker主体全文不外推本UI全文。 |
| `src/renderer/src/welcome/WorkbenchWelcomePage.tsx` | 真实欢迎页项目入口接缝已读；未明确登记本UI全部正文。 |

### A2. 尚无可合并的精确全文回执（53）

以下仅标“全文未证实”；不能因这里未逐项记消费段，推断其无人读过或存在故障。按当前文件树展开旧模糊目录，无隐藏通配符。

- `src/renderer/src/app/StandaloneWorkbenchApp.tsx`
- `src/renderer/src/app/WorkbenchPageModelContext.tsx`
- `src/renderer/src/components/WorkbenchAgentRail.tsx`
- `src/renderer/src/components/WorkbenchUpdateProgress.tsx`
- `src/renderer/src/components/editor/EditorBreadcrumbBar.tsx`
- `src/renderer/src/components/editor/EditorFileDiagnosticSummary.tsx`
- `src/renderer/src/components/editor/WorkbenchProblemSeverityIcon.tsx`
- `src/renderer/src/components/files/ProjectSearchForm.tsx`
- `src/renderer/src/components/files/WorkbenchFileTypeIcon.tsx`
- `src/renderer/src/hooks/useWorkbenchAiChanges.ts`
- `src/renderer/src/hooks/useWorkbenchCommandPalette.ts`
- `src/renderer/src/hooks/useWorkbenchEditorTabOverflow.ts`
- `src/renderer/src/hooks/useWorkbenchKeyboardShortcuts.ts`
- `src/renderer/src/hooks/useWorkbenchKeymapController.ts`
- `src/renderer/src/hooks/useWorkbenchLayoutController.ts`
- `src/renderer/src/hooks/useWorkbenchPreferences.ts`
- `src/renderer/src/hooks/useWorkbenchProjectSearchPanel.ts`
- `src/renderer/src/hooks/useWorkbenchRecentFiles.ts`
- `src/renderer/src/hooks/useWorkbenchSearchController.ts`
- `src/renderer/src/hooks/useWorkbenchSurfaceState.ts`
- `src/renderer/src/hooks/useWorkbenchWindowFullScreen.ts`
- `src/renderer/src/hooks/workbenchCommand/useWorkbenchCommandPackageSuggestions.ts`
- `src/renderer/src/models/chat/workbenchAiChangeRounds.ts`
- `src/renderer/src/models/chat/workbenchChatSessionGroups.ts`
- `src/renderer/src/models/chat/workbenchCrossProjectRoots.ts`
- `src/renderer/src/models/commands/workbenchCommandHistory.ts`
- `src/renderer/src/models/commands/workbenchCommandLines.ts`
- `src/renderer/src/models/commands/workbenchCommandStatusModel.ts`
- `src/renderer/src/models/commands/workbenchCommandSuggestions.ts`
- `src/renderer/src/models/commands/workbenchConsoleOutputHighlight.ts`
- `src/renderer/src/models/commands/workbenchPackageScriptCommand.ts`
- `src/renderer/src/models/commands/workbenchShellQuote.ts`
- `src/renderer/src/models/commands/workbenchTerminalPresentation.ts`
- `src/renderer/src/models/commands/workbenchVelarFileCommand.ts`
- `src/renderer/src/models/files/fileTree.model.ts`
- `src/renderer/src/models/files/workbenchFilePresentation.ts`
- `src/renderer/src/models/files/workbenchFileSearchNavigationModel.ts`
- `src/renderer/src/models/files/workbenchPathModel.ts`
- `src/renderer/src/models/files/workbenchRecentFiles.ts`
- `src/renderer/src/models/files/workbenchTestFile.ts`
- `src/renderer/src/models/files/workbenchTreeMutation.ts`
- `src/renderer/src/models/files/workbenchTreeNavigationModel.ts`
- `src/renderer/src/models/files/workbenchTreeRenameFocus.ts`
- `src/renderer/src/models/layout/workbenchCommandPalette.ts`
- `src/renderer/src/models/layout/workbenchKeymapPresets.ts`
- `src/renderer/src/models/layout/workbenchLayoutModel.ts`
- `src/renderer/src/models/layout/workbenchQuickOpenModel.ts`
- `src/renderer/src/models/layout/workbenchQuickOpenSymbols.ts`
- `src/renderer/src/models/layout/workbenchSurfaceModel.ts`
- `src/renderer/src/models/layout/workbenchViewport.ts`
- `src/renderer/src/models/shared/workbenchFuzzyScore.ts`
- `src/renderer/src/models/shared/workbenchUtils.ts`
- `src/renderer/src/welcome/lastOpenedLabel.ts`


## 已读未修或待核边界

| 状态 | 精确路径 | 边界 |
| --- | --- | --- |
| 已读、待实施 | `src/main/workspace/language/JavaScriptLinting.ts`、`WorkbenchDocumentFormatter.ts`、`LanguageServices.ts` | JS/TS/CJS 配置及其依赖图完整热重载；数据配置已修，不能用清配置缓存代表整个模块图已清。 |
| 已读、下一写批 | `src/main/updates/WindowsArchiveUpdater.ts`、`WorkbenchUpdateService.ts`、`WorkbenchUpdateRuntime.ts`、`resources/updates/windows-update.cjs` | 等旧 worker 真实退出后取消；后继应用按回执回收安装 helper。 |
| 已读、下一写批 | `scripts/probe/runElectronRuntimeProbe.mjs`、`electronProbeEntrypoint.mjs`、`scripts/test/runIsolatedTests.mjs`、`src/main/workspace/terminal/terminalProbe.ts` | 宿主强杀与独立 PTY 后代 owner；isolated Windows taskkill 自身期限。保持原预算。 |
| 候选，未证实运行故障 | `src/renderer/src/hooks/useWorkbenchTreeController.ts`、`src/renderer/src/hooks/useWorkbenchEditorConfig.ts` | 路径读取代际与 EditorConfig 错误/缺失缓存合同，未凭静态疑点升级为必修。 |
| 候选，未证实运行故障 | `src/main/conversation/ConversationAgents.ts`、`ConversationScripts.ts`、`WorkbenchSessionPeersIpc.ts` | observe 预览预算及最终 destroyed 窗口引用回收；不重复修已交付 sequence/receipt。 |

本轮已修源码必要验证无待项：LSP/Markdown、恢复、SourceMap、评论草稿、codeGraph、设置、安装助手和纯死链均已有相应最小检查；
这句话不覆盖下方运行矩阵，也不把尚未实施的已读边界算作解决。逐批证据见 [refactoring-progress.md](./refactoring-progress.md)。

## 数据、fixture 与运行矩阵

- `src/renderer/src/i18n/messages/en-US.ts` 与 `src/renderer/src/i18n/messages/zh-CN.ts`：入口/合并/消费已审，未逐条核对翻译字面量。31 CSS、样式入口、声明与 HTML 仅按具体消费接缝核读，未做逐字样式或视觉审计。
- 历史 `tests/fixtures/**` 只按实际故障消费核读，不声称每份历史 fixture 全文。
- 真实 DOM、滚动/测量帧、HMR/native 连续时序、Windows/macOS/Linux PTY/磁盘/权限、第三方 CLI/LSP 版本、Cloud 续期、签名安装与负载矩阵未穷尽。
- 已脱离父链/进程组且关闭继承 stdio 的任意 daemon 后代，不在 Node 公开 ChildProcess close 合同的完整保证内；不能用 PID 消失冒充真实 owner close。
