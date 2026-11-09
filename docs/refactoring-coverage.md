# Workbench 排查覆盖与剩余游标

2026-11-09。本轮已验证源码游标为 `bfdbfaf`，包括评论草稿映射、SourceMap 预分配边界、工作区死链及聊天恢复归属。
本文区分源码阅读、具体接缝和运行验证，不用提交数、测试数或文件数推导全仓完成。
逐批行为与验证证据见 [refactoring-progress.md](./refactoring-progress.md)，底座来源及公开调用库存见
[workbench-platform-migration.md](./workbench-platform-migration.md)。

## 阅读覆盖

| 模块 | 当前实际覆盖 | 剩余生产阅读路径 |
| --- | --- | --- |
| main engines / account / model / conversation | 引擎、凭据及账号存储主体；Runtime、Dispatcher、Recovery、普通及 peer IPC、脚本/观察/规则/投影、Console 与 composition 已全文核对。账号和模型 IPC 本体已补全文；恢复票据实施差异已审。 | 不把 renderer 聊天或 IPC 的完成扩大为所有 renderer 页面完成。 |
| main projects / workspace | 项目身份、窗口、关闭与安全主体；workspace 顶层生产文件、terminal 六文件、watch 两文件、Git 八文件与实际 IPC 已全文；本轮死链/watch 批已交付。 | 不要求补 OS 磁盘/终端矩阵。 |
| main language | TS host/features、缓存、lint/formatter、Markdown、worker/client/scheduler/protocol/IPC 已全文；外部 LSP 的协议与生命周期已核。 | 主线程进程 owner 正在实施，新增传输/Host 和接线需最终审阅；已审旧实现不重复扫。 |
| main debug / browser / analytics / updates | DebugSession 全算法及其余 debug 生产模块、main browser、统计与更新服务/Windows helper 已全文；本轮补完 renderer DebugPanel、AgentBrowserPanel、WebviewDebugPanel 与实际装配。 | 未运行真实 Electron 页面/调试交互；原生平台矩阵不是本次基本源码排查的前置。 |
| renderer 编辑器与装配 | runtime/provider、Host、评论/存储、主要 editor hooks 与 87 个 editor models 按细项已读；CodeMirrorEditor、EditorPanel、EditorGroupsPanel、FilePanel、评论 extension/widget 全文。外部只读补齐 LanguageFeatures、Diagnostics、test gutter 三文件共 1404 行，无高置信行为缺陷。 | 无生产消费者的 type-hover helper 已核实、正在随本批删除；find/go-to 等剩余小 UI 未全部读完。真实 DOM 交互未测。 |
| renderer 聊天 | Adapter、ChatRuntime、Notices、draft/queue/submission/persistence/registry/session-list/stop/action/slots/block hooks、Panel、Provider 与十个卡片/工具窗口本轮已全文；恢复 owner 实施后已复审交付。 | 真实 React / HMR / native 连续交互未测；不把本模块完成扩大为所有 renderer 页面完成。 |
| renderer 其余业务 | 搜索、树、运行/调试主要链已读；PageModel、PagePresentation、Controller、项目会话/索引、EmbeddedKernel/Adapter 全文；Git 的 10 hooks、13 组件、16 模型及直接消费全文。terminal 全部八个组件、实例/搜索/theme/output bus 已全文。外部只读补齐三个 codeGraph UI 共 1934 行。 | codeGraph Dialog 三项回执/内容归属正在实施。settings 五文件已交外部只读；其余未具名 UI 与配置辅助主体按准确库存补读。 |
| shared / preload / i18n | preload 唯一入口及 17 组桥全文；System、Git、Conversation、Velar contribution、language registry 及整个 `contracts/workbench.ts` 已读。main i18n 表、locale producer/consumer 与 renderer 翻译入口已读。 | renderer 两份大语言表只读入口/合并及消费接缝，未冒称逐条全文；个别 shared 声明按真实消费者补齐。 |
| release / engineering | Release 身份/归档/签名/catalog/平台并集、打包与 runtime 准备脚本已全文；lint/quality/typecheck、边界门、Vite/TS/ESLint 配置、isolated test runner、四探针及 probe runner 已全文。 | `verifyInstalledVelarToolchain.ts` 仍局部；其它测试驱动按实际消费者补齐，不将全部历史 fixture 列为产品实现缺口。外部 Desktop workflow 只核实际调用段，未称外部整仓已审。 |

## 已证实而尚未交付的边界

| 问题 | 当前状态与最小收口 |
| --- | --- |
| worker 硬终止先于 LSP shutdown | 正在实现 main 持真实 ChildProcess/stdio 的 owner；worker 只持有有界字节通道。保持原 8s 绝对关闭期限，真实 close 才成功，不靠 PID 通知或加预算。 |
| Markdown 取消不能停止本仓递归扫描 | 请求级 workspace 已接 FS await/循环及 SDK token，并等待真实 run 收束后释放；三处交互 signal 已接通，node 类型绿。新增 SDK 读取故障在原 5s 未进入预期收束，正在定位 gate，尚未算验证通过。同步 parser 的不可抢占边界保留。 |
| codeGraph 迟到快照/源码回执、草稿与源码版本不一致 | 三文件只读复核完成；三项均定位 Dialog，正在复用当前请求 owner 实施最小修复。未执行 DOM 时序复现。 |
| 代码型配置的依赖图热重载 | 数据配置已修；JS/TS/CJS 及依赖模块完整重载未解决，不用当前成功缓存用例冒充。 |
| Windows updater helper 目录回收 | 未实施。换渠道须等旧 worker 实际退出；安装后须由后继应用依据真实回执回收，不能在仍执行的目录里 best-effort 删除 node.exe。 |
| probe / isolated test 宿主强杀边界 | 未实施。同步宿主 timeout 可跳过 probe finally；PTY 后代可能在独立会话，单杀 Electron/group 不能证明完整收束。Windows isolated runner 的 taskkill 自身也缺期限；需要真实 owner 方案，不扩大原预算。 |

树读取路径代际、observe 预览预算和已销毁 peer 窗口引用仍为待核候选，尚不把静态疑点写成运行故障。
旧 Claude CLI 的 unknown 授权状态没有足够版本证据支持删除，保持现状。

已充分确认合理保留的约束包括：账号 CAS/合并、字节和编码往返、原子写/删除撤销/历史保全、真实进程树关闭、
Git 影子 index/ref、TS 共享池及有界缓存、编辑器同步草稿 owner、跨组 file state、异步结果归属、签名及资产字节核验。
这些不因“精简”继续改写，也不要求补齐所有 OS、账号或第三方工具版本矩阵。
