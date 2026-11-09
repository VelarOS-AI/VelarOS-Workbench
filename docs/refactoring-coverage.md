# Workbench 排查覆盖与剩余游标

2026-11-09。本轮已验证源码游标为 `724ab61`，包括语言进程 owner、Markdown 取消、codeGraph、设置与安装助手。
本文区分源码阅读、具体接缝和运行验证，不用提交数、测试数或文件数推导全仓完成。
逐批行为与验证证据见 [refactoring-progress.md](./refactoring-progress.md)，底座来源及公开调用库存见
[workbench-platform-migration.md](./workbench-platform-migration.md)。
精确全文未证实路径、已读未修及运行矩阵分别列在 [refactoring-remaining.md](./refactoring-remaining.md)。

## 阅读覆盖

| 模块 | 当前实际覆盖 | 剩余生产阅读路径 |
| --- | --- | --- |
| main engines / account / model / conversation | 引擎、凭据及账号存储主体；Runtime、Dispatcher、Recovery、普通及 peer IPC、脚本/观察/规则/投影、Console 与 composition 已全文核对。账号和模型 IPC 本体已补全文；恢复票据实施差异已审。 | 不把 renderer 聊天或 IPC 的完成扩大为所有 renderer 页面完成。 |
| main projects / workspace | 项目身份、窗口、关闭与安全主体；workspace 顶层生产文件、terminal 六文件、watch 两文件、Git 八文件与实际 IPC 已全文；本轮死链/watch 批已交付。 | 不要求补 OS 磁盘/终端矩阵。 |
| main language | TS host/features、缓存、lint/formatter、Markdown、worker/client/scheduler/protocol/IPC 已全文；新增 main Host/传输及接线已复审，必要行为/类型/lint 已绿。 | 代码配置依赖图热重载仍待实施；已审旧实现不重复扫。 |
| main debug / browser / analytics / updates | DebugSession 全算法及其余 debug 生产模块、main browser、统计与更新服务/Windows helper 已全文；本轮补完 renderer DebugPanel、AgentBrowserPanel、WebviewDebugPanel 与实际装配。 | 未运行真实 Electron 页面/调试交互；原生平台矩阵不是本次基本源码排查的前置。 |
| renderer 编辑器与装配 | runtime/provider、Host、评论/存储、主要 editor hooks 与 87 个 editor models 按细项已读；CodeMirrorEditor、EditorPanel、EditorGroupsPanel、FilePanel、评论 extension/widget 全文。外部补齐三个编辑器插件；Find/GoToLine、chrome 全部组件本次补全文，type-hover 死链已删。 | 其余叶组件/辅助的全文未证实路径按精确清单，不再以大目录模糊表示；真实 DOM 交互未测。 |
| renderer 聊天 | Adapter、ChatRuntime、Notices、draft/queue/submission/persistence/registry/session-list/stop/action/slots/block hooks、Panel、Provider 与十个卡片/工具窗口本轮已全文；恢复 owner 实施后已复审交付。 | 真实 React / HMR / native 连续交互未测；不把本模块完成扩大为所有 renderer 页面完成。 |
| renderer 其余业务 | PageModel/Presentation、Controller、项目会话/索引、EmbeddedKernel/Adapter、Git 全链、terminal 八文件/output bus、三个 codeGraph UI、settings 五文件全文；QuickOpen、运行配置模型/表单、四个模型配置/目录/价格模块及 Preferences 全文已补齐。 | codeGraph/设置改动已审验；95 个其余行为源码只欠全文证据，逐文件列入剩余清单，不把“未证实”断言为无人读过。 |
| shared / preload / i18n | preload 与 shared 当前生产文件已有全文记录；main i18n、renderer 两个翻译小入口及真实装配已全文。main/index 与 CapabilityProviders 本次补全文。 | renderer 两份大语言表未逐条核对；声明/样式/历史 fixture 与运行矩阵单列。 |
| release / engineering | Release/打包/runtime 准备、质量门及 probe/isolated runner 已全文；安装验收 1245 行与新增资源 helper 已复审，最小故障与脚本定向严格类型通过。 | 仅 `scripts/test/conversationRuntime.test.mjs` 全文未证实；外置包清单 JSON 待数据本身核对。仓外 Desktop workflow 仅核真实调用段。 |

## 已证实而尚未交付的边界

| 问题 | 当前状态与最小收口 |
| --- | --- |
| 代码型配置的依赖图热重载 | 数据配置已修；JS/TS/CJS 及依赖模块完整重载未解决，不用当前成功缓存用例冒充。 |
| Windows updater helper 目录回收 | 已交下一独占写批，尚未验收。旧 worker 必须真实退出；后继应用按回执回收，不能删除仍执行的 node.exe 或扫描临时目录前缀。 |
| probe / isolated test 宿主强杀边界 | 已交下一独占写批，尚未验收。宿主 timeout 可跳过 finally；独立 PTY 后代须有真实接纳/回执，Windows taskkill 自身也须有期限；原预算不扩大。 |

树读取路径代际、observe 预览预算和已销毁 peer 窗口引用仍为待核候选，尚不把静态疑点写成运行故障。
旧 Claude CLI 的 unknown 授权状态没有足够版本证据支持删除，保持现状。

已充分确认合理保留的约束包括：账号 CAS/合并、字节和编码往返、原子写/删除撤销/历史保全、真实进程树关闭、
Git 影子 index/ref、TS 共享池及有界缓存、编辑器同步草稿 owner、跨组 file state、异步结果归属、签名及资产字节核验。
这些不因“精简”继续改写，也不要求补齐所有 OS、账号或第三方工具版本矩阵。
