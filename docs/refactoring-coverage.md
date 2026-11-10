# Workbench 排查覆盖与剩余游标

2026-11-10 更新。既有生产行为源码全文阅读回执已在 `f694f64` 合并收口；新增实施另按差量审阅与验证。
本文区分源码阅读、具体接缝和运行验证，不用提交数、测试数或文件数推导全仓完成。
逐批行为与验证证据见 [refactoring-progress.md](./refactoring-progress.md)，底座来源及公开调用库存见
[workbench-platform-migration.md](./workbench-platform-migration.md)。
当前实施、待验收项及运行矩阵分别列在 [refactoring-remaining.md](./refactoring-remaining.md)。
0.9.5 基线上的下一轮语义与职责复审另见 [本轮记录](./refactoring-round-20261110.md)，不重置旧全文阅读账本。

## 阅读覆盖

| 模块 | 当前实际覆盖 | 证据边界 |
| --- | --- | --- |
| main engines / account / model / conversation | 引擎、凭据及账号存储主体；Runtime、Dispatcher、Recovery、普通及 peer IPC、脚本/观察/规则/投影、Console 与 composition 已全文核对。账号和模型 IPC 本体已补全文；恢复票据实施差异已审。 | 既有源码剩余 0；Core 0.9.4 接入、真实支持查询和普通 exec 必要场景已验收。 |
| main projects / workspace | 项目身份、窗口、关闭与安全主体；workspace 顶层生产文件、terminal 六文件、watch 两文件、Git 八文件与实际 IPC 已全文；本轮死链/watch 及结构化启动差量已审。 | 既有源码剩余 0；OS 磁盘/终端矩阵未穷尽。 |
| main language | TS host/features、缓存、lint/formatter、Markdown、worker/client/scheduler/protocol/IPC 已全文；已交付 LSP owner/传输及取消接线已复审。 | 既有源码剩余 0；Tools Worker 差量和实际打包/RPC/退出已验收。 |
| main debug / browser / analytics / updates | DebugSession 全算法及其余 debug 生产模块、main browser、统计与更新服务/Windows helper 已全文；本轮补完 renderer DebugPanel、AgentBrowserPanel、WebviewDebugPanel 与实际装配。 | 既有源码剩余 0；真实 Node/CDP 及 updater 必要场景已测，Electron 调试页面交互未测。 |
| renderer 编辑器与装配 | runtime/provider、Host、评论/存储、editor hooks/models、主要面板、评论 extension/widget、插件、Find/GoToLine 与 chrome 已全文；最后叶组件与辅助路径回执已补齐。 | 既有源码 0；真实 DOM 交互未测。 |
| renderer 聊天 | Adapter、ChatRuntime、Notices、draft/queue/submission/persistence/registry/session-list/stop/action/slots/block hooks、Panel、Provider 与十个卡片/工具窗口本轮已全文；恢复 owner 实施后已复审交付。 | 真实 React / HMR / native 连续交互未测；不把本模块完成扩大为所有 renderer 页面完成。 |
| renderer 其余业务 | PageModel/Presentation、Controller、项目会话/索引、EmbeddedKernel/Adapter、Git、terminal、codeGraph、settings、QuickOpen、运行配置及模型/Preferences 已全文；旧 95 清单由 31 回执和最后 64 路径全文补齐。 | 既有源码剩余 0；新发现的行为修复及结构化命令差量已审，必要模型用例通过。 |
| shared / preload / i18n | preload 与 shared 当前生产文件已有全文记录；main i18n、renderer 两个翻译小入口及真实装配已全文。main/index 与 CapabilityProviders 本次补全文。 | renderer 两份大语言表未逐条核对；声明/样式/历史 fixture 与运行矩阵单列。 |
| release / engineering | Release/打包/runtime 准备、质量门、probe/isolated、安装验收及 conversationRuntime 测试入口已全文；外置包清单数据和真实消费者已核对。 | 既有源码剩余 0；新 probe/worker 产物接缝已验收。仓外 workflow 仅核真实调用段。 |

## 本轮发现的交付与剩余边界

| 问题 | 当前状态 |
| --- | --- |
| 代码型配置的依赖图热重载 | `ff0ea87`：根外传递依赖、真实新入口打包及 NativeNode Worker RPC/退出通过，TS 热服务身份保留。 |
| Windows updater helper 目录回收 | `d5e6ec7`：真实持有 worker 句柄，匹配终态回执与停止 ACK；原生安装收尾、恢复、错回执及目录保留、替换、取消已验收。 |
| probe / isolated test 宿主强杀边界 | `9c2b932`：缺清理回执真实故障、entrypoint 以及实际 Electron/PTY 原 17 项断言通过；延迟 force 和实际 close 均由 owner 等待。 |
| renderer 新发现与生成命令 | `49e4399` 等叶修复及 `aa15f43` 结构化启动已交付；实际 PTY 字面 argv、raw shell、npm 及真实查询取消/关闭通过，配置/菜单/重启模型和真实 Node/CDP 接线通过。 |
| Core observe 动态上下文 | 当前固定 v0.7.6 / 0.9.5，本产品不经 packageEnvironment 包装；新包身份/锁/node 类型已验收。模型完整编码、真实宿主查询及 Windows 普通 exec 的 0.9.4 证明保留，未重标为 0.9.5 实测。历史、动态区和预算留在 Core。 |

树读取路径代际与 EditorConfig 非缺失错误缓存已在 `b9bb6c6` 修复，web 类型及两文件 lint 通过；未冒称真实 DOM 故障重现。
observe 预览副本与销毁 peer watcher 已在 `a5d3ffd` 交付，实际 Board 八项断言通过；展示裁剪不改模型上下文或缓存。
旧 Claude CLI 的 unknown 授权状态没有足够版本证据支持删除，保持现状。

已充分确认合理保留的约束包括：账号 CAS/合并、字节和编码往返、原子写/删除撤销/历史保全、真实进程树关闭、
Git 影子 index/ref、TS 共享池及有界缓存、编辑器同步草稿 owner、跨组 file state、异步结果归属、签名及资产字节核验。
这些不因“精简”继续改写，也不要求补齐所有 OS、账号或第三方工具版本矩阵。

新语义复审的偏好可用性、账号操作归属与关闭批准/回执已在 `5f5f593`、`4a395da`、`5ed9046` 交付；
19 个必要定向场景、node/web 类型及 18 路径 lint 通过。更新仅支持当前 v2，旧格式保全后明确不可用，不新增迁移。
consent 关闭 owner 与下一只读游标仍按[本轮记录](./refactoring-round-20261110.md)推进。
