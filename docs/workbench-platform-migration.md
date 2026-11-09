# Workbench → Platform 0.9.1

Workbench 使用配套的基础与扩展固定候选，不引用兄弟仓源码，也不修改依赖包实现。

## 执行与空闲控制

`WorkbenchConversationSession` 向根 createRuntime 显式提供 storage、binding、Node 执行口、模型与模块。
项目/代码/图像及证据源、快照由 `WorkbenchConversationProject` 从 capabilities/project 装配。
浏览器、web、产品会话协作、console 均显式安装；记忆、widget 和 worker profile 也由产品选择。

产品先从窗口 ProjectHub 核验项目并解析真实根，再由公开 `/node.resolveNodeRuntimeBinding` 解析
不透明执行身份、Node 可执行文件和真实进程约束。`execution-binding.json` 是产品自己的不可变凭据，
仅首次原子发布；归属、沙箱或执行身份变化、损坏和孤立 context 文件均明确拒绝，不覆写或猜测旧绑定。

`WorkbenchConversationRuntime.listNotes/readNote/getGoal/controlGoal` 活跃时借原 session，空闲时
经 `openSessionControl({sessionId, storage, binding})` 读取原事实，finally 关闭独立连接。
不创建模型、Node、Host 或伪领域实现，不读核心私有 runtime:binding 记录。resume 只改变目标事实。
从未运行时保留空页/null/NOT_FOUND 语义；并发控制、删除与关闭排斥仍由产品持有。

应用级 WorkbenchShellHostRegistry 是唯一进程 owner。Runtime.close 的 TIMEOUT 表示原关闭仍在收束，
产品继续等待同一个关闭操作，不重放执行、不提前销毁 Host 或删除存储；不提高原关闭时限。
同根会话的语言池由执行 lease 计数，最后一个 lease 收束后才释放，避免打断并发会话。

新执行数据位于 `conversation-runtime/foundation-v1/<项目根与会话哈希>`；旧 0.7 目录不读、不删，
界面历史与项目 ID 保留。旧 runtime:workspace 不做兼容恢复，不把旧事实混入新执行身份。

## 一次接入所需归档

安装身份为配套的 `@velaros-ai/velaros@0.9.1` 与 `@velaros-ai/capabilities@0.9.1`。
Workbench 使用项目/代码/图像、浏览器、网页和产品会话协作，不能仅接基础包。
来源：Platform commit `e3e157696994a0d667cbd542a809484b93e40e71`。
来源证明原字节保存于 `resources/runtime-sources/platform-0.9.1/`，schema2 快照固定其哈希。

| 安装身份 | 版本 | 归档 | SHA256 |
| --- | --- | --- | --- |
| @velaros-ai/velaros | 0.9.1 | velaros.tgz | 7845f1e6c90fd93f90faf8d5c52203a7110580054365419acb1c38d72d0e93c2 |
| @velaros-ai/capabilities | 0.9.1 | capabilities.tgz | 9e29f4b00ee12aa51a2d086b32eaff8ce7c15672041048590cac0dc6ba911a5a |

receipt 给出 SHA512 integrity、大小及 658 输入与提交树的核对证明；冻结本地候选保留打包前 dirty 证据，
不称为已发布的 registry/GitHub Release。导入核对来源证明和归档，复制到本仓哈希目录，缺档不自动走 GH。
正式 stage 拒绝候选依赖；正式发布来源另核 Release、tag→commit 和资源身份。UI 仍使用原 1.0.0 固定归档。

切换范围：manifest/lock/快照来源；专项 import → capabilities；Node 工厂 → velaros/node；显式项目端口、
context source/snapshot、worker/memory/widget 装配；执行身份与授权 scope；新会话数据代际；发行外置包闭包。
继续使用 WorkbenchShellHostRegistry 唯一应用级 Host，产品项目/浏览器选择、登记和权限策略不进入核心。

## 会话协作和宿主合同

- `capabilities/sessions` 的 `SessionTold.status` 仅 `queued`，tell 只给目标活动 run 追加 guidance，空闲拒绝。
  Workbench 先显示 pending guidance 并回执，再 await 真实 steer；不新建运行或检查点，目标换轮会拒绝。
  接纳后来源取消或 UI 通知失败不误报未投递，不自动重放，也不把先到的 applied 降级。
- 0.9.1 扩展 required peer 为基础精确 `0.9.1`；宿主 optional peer 是 Electron `>=41.0.0`、
  React / @types/react `^19.0.0`，与本仓宿主版本一致，无本地依赖补丁或 peer override。

## 实际公开调用库存

核对当前产品调用与安装的 0.9.1 公开声明：目前没有确认需要 Platform 新增的合同缺口。
空闲 trace/traceBranches 不是 Workbench 当前产品调用；空闲 UI 恢复读取产品 Recovery 日志。
后续验证若发现真实合同缺口再补充，不恢复已删除字段或导入包内私有实现。

| 产品文件 / 公开调用 | 活动或空闲 | 真实语义 |
| --- | --- | --- |
| `WorkbenchConversationSession.open` / `createRuntime`、`resolveNodeRuntimeBinding` | 活动执行 | 产品核验项目与执行凭据，显式注入存储、Node、资源和领域模块。 |
| `WorkbenchConversationRuntime.listNotes/readNote/getGoal` | 两者 | 活动借原 Session；空闲 `openSessionControl`，保留分页、版本与不存在语义。 |
| `WorkbenchConversationRuntime.controlGoal` / `getGoal`、`controlGoal` | 两者 | 携 revision 修改目标；空闲 resume 只改事实，UI 继续操作另外显式 submit。 |
| `WorkbenchConversationRuntime.guidance` / `VelarosSession.steer` | 仅活动 | 缺少活动 handle 明确拒绝；peer tell 同样不启动新一轮。 |
| `WorkbenchConversationRuntime.readTrace` / `VelarosSession.trace` | 活动及本轮收尾 | 刷新当前执行卡、用量和结果；完成最终读取后关闭 runtime。 |
| `ConversationAgents.refresh` / `VelarosRuntime.trace(rootSessionId, query)` | 活动及本轮收尾 | 根会话授权子分支，按 after/limit 分页，不创建子模型运行。 |
| renderer `standaloneWorkbenchConversationActionPort` / 产品 goal、guidance IPC | 两者 | 空闲继续目标显式 submit；活动 guidance 检查错误信封并交 UI 处理。 |

0.9.1 过期消费面已按公开合同清理：执行语言由产品固定的 Node 执行口确定，完成原因使用
presentation.completion，删除 hourly throttled 事件与预算字段。POSIX 进程组目标由公开
`shouldUseDetachedProcessGroup()` 决定，不再调用已删除的 getProcessKillPid。
