# Workbench 排查覆盖与剩余游标

2026-11-09。本轮已验证源码游标为 `98885e9`，包含引用多选的文件/正文/选区 owner 修复。
本文区分源码阅读、具体接缝和运行验证，不用提交数、测试数或文件数推导全仓完成。
逐批行为与验证证据见 [refactoring-progress.md](./refactoring-progress.md)，底座来源及公开调用库存见
[workbench-platform-migration.md](./workbench-platform-migration.md)。

## 阅读覆盖

| 模块 | 当前实际覆盖 | 剩余生产阅读路径 |
| --- | --- | --- |
| main engines / account / model / conversation | 引擎、凭据及账号存储主体；Runtime、Dispatcher、Recovery、普通及 peer IPC、脚本/观察/规则/投影、Console 与 composition 已全文核对。账号和模型 IPC 按真实入口消费核对。 | 新恢复票据改动仍待最终审阅；renderer 聊天此次已全文，不能沿用早期“仅接缝”的旧状态。 |
| main projects / workspace | 项目身份、窗口、关闭与安全主体；workspace 顶层生产文件、terminal 六文件、watch 两文件、Git 八文件与实际 IPC 已全文。 | renderer 项目会话模型异常/恢复主体及部分页面控制链仍只接缝；不能以 main 已读替代。 |
| main language | TS host/features、缓存、lint/formatter、Markdown、worker/client/scheduler/protocol/IPC 已全文；外部 LSP 的协议与生命周期已核。 | 主线程进程 owner 正在实施，新增传输/Host 和接线需最终审阅；已审旧实现不重复扫。 |
| main debug / browser / analytics / updates | DebugSession 全算法及其余 debug 生产模块、main browser、统计与更新服务/Windows helper 已全文。 | renderer 调试面板、浏览器页及 webview 整体仍未全文；原生平台矩阵不是本次基本源码排查的前置。 |
| renderer 编辑器与装配 | runtime/provider、Host、评论/存储、主要 editor hooks 与 87 个 editor models 按细项已读；CodeMirrorEditor、EditorPanel、EditorGroupsPanel、FilePanel 全文；评论 extension/widget 本次补全文。 | `workbenchCodeMirrorLanguageFeatures` 中间 DOM、完整 Diagnostics 映射和 test gutter 提取仍只局部；find/go-to 等剩余小 UI 未全部读完。 |
| renderer 聊天 | Adapter、ChatRuntime、Notices、draft/queue/submission/persistence/registry/session-list/stop/action/slots/block hooks、Panel 与 Provider 本轮已全文。 | 新恢复 owner 实施后复审；不把这一模块的全文扩大为所有 renderer 页面完成。 |
| renderer 其余业务 | 搜索、树、运行/调试 hooks 的主要链及部分模型已读；完整文件和方法范围按模块游标记录。 | `useStandaloneWorkbenchPageModel`、`useWorkbenchController`、项目会话/索引模型仍有未读主体；Git hooks/面板完整链正在补读；调试/浏览器 UI 及其余页面装配仍待补读。 |
| shared / preload / i18n | preload 唯一入口及 17 组桥全文；System、Git、Conversation、Velar contribution 与 language registry 全文；大合同语言类型段本次补读。main i18n 表、locale producer/consumer 与 renderer 翻译入口已读。 | `contracts/workbench.ts` 非语言大段及少数 shared 声明需对照个人游标补齐；renderer 两份大语言表只读入口/合并及消费接缝，未冒称逐条全文。 |
| release / engineering | Release 身份/归档/签名/catalog/平台并集、打包与 runtime 准备脚本已全文；lint/quality/typecheck、边界门、Vite/TS/ESLint 配置、isolated test runner、四探针及 probe runner 已全文。 | `verifyInstalledVelarToolchain.ts` 仍局部；其它测试驱动按实际消费者补齐，不将全部历史 fixture 列为产品实现缺口。外部 Desktop workflow 只核实际调用段，未称外部整仓已审。 |

## 已证实而尚未交付的边界

| 问题 | 当前状态与最小收口 |
| --- | --- |
| worker 硬终止先于 LSP shutdown | 正在实现 main 持真实 ChildProcess/stdio 的 owner；worker 只持有有界字节通道。保持原 8s 绝对关闭期限，真实 close 才成功，不靠 PID 通知或加预算。 |
| renderer 慢恢复覆盖新运行、旧 stream 结算新输入 | 正在实现恢复/准备票据、真实 inputId/streamId 匹配及 await 后准入复核；沿用 main Dispatcher/journal，不增加第二套后端锁。 |
| source map 读完后才核大小、内联解码无上限 | 已实现同一 32 MiB 解码前边界和文件句柄有界读取；内联及真实外置映射断点场景、相关 lint 已绿，等本轮 node 类型统一检查后提交。未造大文件压力场景。 |
| Markdown 取消不能停止本仓递归扫描 | 未实施。需要请求级 workspace 在真实 FS await/循环边界停止，并与 SDK 取消合同配合；仅传 SDK token 不足，同步 parser 的不可抢占边界保留。 |
| 代码型配置的依赖图热重载 | 数据配置已修；JS/TS/CJS 及依赖模块完整重载未解决，不用当前成功缓存用例冒充。 |
| Windows updater helper 目录回收 | 未实施。换渠道须等旧 worker 实际退出；安装后须由后继应用依据真实回执回收，不能在仍执行的目录里 best-effort 删除 node.exe。 |
| 行内评论草稿沿用外部改写前的 offset | 已证实未修。已有评论锚点会映射，未提交 draft 没有同等 owner/映射；待按实际原文档和评论输入生命周期收口。 |
| probe / isolated test 宿主强杀边界 | 未实施。同步宿主 timeout 可跳过 probe finally；PTY 后代可能在独立会话，单杀 Electron/group 不能证明完整收束。Windows isolated runner 的 taskkill 自身也缺期限；需要真实 owner 方案，不扩大原预算。 |

树读取路径代际、observe 预览预算和已销毁 peer 窗口引用仍为待核候选，尚不把静态疑点写成运行故障。
旧 Claude CLI 的 unknown 授权状态没有足够版本证据支持删除，保持现状。

已充分确认合理保留的约束包括：账号 CAS/合并、字节和编码往返、原子写/删除撤销/历史保全、真实进程树关闭、
Git 影子 index/ref、TS 共享池及有界缓存、编辑器同步草稿 owner、跨组 file state、异步结果归属、签名及资产字节核验。
这些不因“精简”继续改写，也不要求补齐所有 OS、账号或第三方工具版本矩阵。
