# Workbench → Platform 0.9.4

Workbench 使用配套的基础与扩展正式固定归档，不引用兄弟仓源码，也不修改依赖包实现。

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

安装身份为配套的 `@velaros-ai/velaros@0.9.4` 与 `@velaros-ai/capabilities@0.9.4`。
Workbench 使用项目/代码/图像、浏览器、网页和产品会话协作，不能仅接基础包。
正式来源：[Platform v0.7.5](https://github.com/VelarOS-AI/VelarOS-Platform/releases/tag/v0.7.5)，
commit `1b0004d773ac54c9f20f3748f9f4baed021a6481`。schema2 快照仅声明正式发布来源，
核对 Release 公开状态、tag→commit、资源大小/digest、实际下载 SHA256/SHA512 与 tar 内包身份。

| 安装身份 | 版本 | 归档 | SHA256 |
| --- | --- | --- | --- |
| @velaros-ai/velaros | 0.9.4 | [velaros-ai-velaros-0.9.4.tgz](https://github.com/VelarOS-AI/VelarOS-Platform/releases/download/v0.7.5/velaros-ai-velaros-0.9.4.tgz) | ad28c5dc3b6499140a2e176481df7decc0eb80e8c73658fa7982ba6eccfa0250 |
| @velaros-ai/capabilities | 0.9.4 | [velaros-ai-capabilities-0.9.4.tgz](https://github.com/VelarOS-AI/VelarOS-Platform/releases/download/v0.7.5/velaros-ai-capabilities-0.9.4.tgz) | 8665b5f0ba32aa5e95daef81726bb8b0fc5ddfb8e19c30a28c9149b3994bd110 |

两包的大小与 SHA512 integrity 由 `resources/runtime-snapshot.json` 固定，归档位于本仓按哈希分格的缓存。
UI 仍使用原 1.0.0 正式固定归档。正式来源门继续拒绝本机候选，不把预发布身份伪造成 Release。

0.9.1 的源 commit `e3e157696994a0d667cbd542a809484b93e40e71`、原始候选证明和消费验证已保留：
接入提交 `f0cd235`，原字节位于 `resources/runtime-sources/platform-0.9.1/`。其 658 输入、dirty 来源事实
及四个真实 Node 场景仍是历史证据。0.9.2/0.9.3 的归档、tag 与回执同样保留；当前安装以 0.9.4 发布来源为准。

2026-11-09 对 0.9.3 核验正式 Release、tag/commit、GitHub asset digest、实际 SHA256/SHA512/长度及 tar 身份后，
仅执行一次 `bun install --ignore-scripts`。三包锁身份通过；新归档上的真实 Node 24.22 取消/进程关闭及写窗口收口用例通过。
该证据没有重标旧四场景，也不覆盖供应商、Chrome、签名安装或完整跨平台矩阵。

2026-11-09 对 0.9.4 再独立核验正式 Release、tag/commit、asset digest 和实际归档字节，
安装前核对 tar 内包名、版本、平台代际 `0.7` 及能力包对基础包精确 `0.9.4` peer。
仅执行一次 Bun 1.4.3 `install --ignore-scripts`，完整三包锁身份通过。node/web 类型、宿主单文件定向 lint 通过；
在新归档上运行一个原生 Node/项目编辑用例，约 2397ms 内完成真实执行、IDE 通知、输出和收尾，原 30 秒不变。
同一用例从真实 Workbench 宿主查询到 Windows `available: false`，再证明普通 exec 仍正常运行。
发布方 Linux 的 release:check、归档 JS/声明及 trace 证明保持发布方身份；未重标为 Workbench Windows 观察执行。

## 小型观察与动态上下文

0.9.4 的 [正式合同](https://github.com/VelarOS-AI/VelarOS-Platform/blob/v0.7.5/docs/architecture/observe-dynamic-context.md)
保留 observe 的小状态、摘要、差量与引用。当前观察默认 2048 个 UTF-16 字符，带历史选择的动态材料总限 4096；
历史目录默认 10、最多 20 条，局部读取默认 1024、最多 2048 字符。选择回执仅确认下一模型轮交付，不包含历史正文。
历史归属、去重、接纳后消费、授权失效、采集额度与持久化均由 Core 持有，产品不另建索引或混入普通 exec 增量材料。

`WorkbenchShellHostRegistry.host()` 直接转发同一真实宿主的 `observationSupport()`，不缓存、不按 OS 生成结果。
当前 Windows 未注入额外只读后端，不能用普通 exec 冒充 observe；历史控制与 clear 的可用性按 Core 合同分别处理。
macOS/Linux 支持报告仅证明可构造规格，本次没有在这些 OS 实测采集。

模型请求的稳定 frame、动态观察和本轮控制分别为 `compiledPrompt`、`dynamic`、`protocol`。
产品配置使用公开 `createAiSdkModelDriver`，`ConversationModelDriver` 将完整请求原样交给 estimate/stream，
没有自行摘取提示词或重拼消息；唯一含 `compiledPrompt` 的容量测试夹具是合法静态请求，没有读取帧标记。
完整编码、动态语义身份及稳定前缀保留由发布 SDK 负责；本地证明不代表供应商缓存命中或模型自然选择率。

切换范围：manifest/lock/快照来源；专项 import → capabilities；Node 工厂 → velaros/node；显式项目端口、
context source/snapshot、worker/memory/widget 装配；执行身份与授权 scope；新会话数据代际；发行外置包闭包。
继续使用 WorkbenchShellHostRegistry 唯一应用级 Host，产品项目/浏览器选择、登记和权限策略不进入核心。

## 会话协作和宿主合同

- `capabilities/sessions` 的 `SessionTold.status` 仅 `queued`，tell 只给目标活动 run 追加 guidance，空闲拒绝。
  Workbench 先显示 pending guidance 并回执，再 await 真实 steer；不新建运行或检查点，目标换轮会拒绝。
  接纳后来源取消或 UI 通知失败不误报未投递，不自动重放，也不把先到的 applied 降级。
- 0.9.4 扩展 required peer 为基础精确 `0.9.4`；宿主 optional peer 是 Electron `>=41.0.0`、
  React / @types/react `^19.0.0`，与本仓宿主版本一致，无本地依赖补丁或 peer override。

## 实际公开调用库存

当前产品调用库存从已验证的 0.9.1 接入延续到 0.9.4；本轮新增真实宿主支持查询转发，既有执行与控制分流保留。
空闲 trace/traceBranches 不是 Workbench 当前产品调用；空闲 UI 恢复读取产品 Recovery 日志。
后续验证若发现真实合同缺口再补充，不恢复已删除字段或导入包内私有实现。

0.9.2 增加独立控制 lease 的两只读 trace 方法，Workbench 当前没有新增消费；执行/空闲控制分流不变。
当时内部收尾与错误修复沿用发布方针对同归档的证据；产品补固定身份与受影响静态/类型检查，旧四个真实 Node 场景保持原归档身份。

| 产品文件 / 公开调用 | 活动或空闲 | 真实语义 |
| --- | --- | --- |
| `WorkbenchConversationSession.open` / `createRuntime`、`resolveNodeRuntimeBinding` | 活动执行 | 产品核验项目与执行凭据，显式注入存储、Node、资源和领域模块。 |
| `WorkbenchConversationRuntime.listNotes/readNote/getGoal` | 两者 | 活动借原 Session；空闲 `openSessionControl`，保留分页、版本与不存在语义。 |
| `WorkbenchConversationRuntime.controlGoal` / `getGoal`、`controlGoal` | 两者 | 携 revision 修改目标；空闲 resume 只改事实，UI 继续操作另外显式 submit。 |
| `WorkbenchConversationRuntime.guidance` / `VelarosSession.steer` | 仅活动 | 缺少活动 handle 明确拒绝；peer tell 同样不启动新一轮。 |
| `WorkbenchConversationRuntime.readTrace` / `VelarosSession.trace` | 活动及本轮收尾 | 刷新当前执行卡、用量和结果；完成最终读取后关闭 runtime。 |
| `ConversationAgents.refresh` / `VelarosRuntime.trace(rootSessionId, query)` | 活动及本轮收尾 | 根会话授权子分支，按 after/limit 分页，不创建子模型运行。 |
| `WorkbenchShellHostRegistry.host` / `ShellHostPort.observationSupport` | 宿主能力查询 | 调用原真实宿主，无进程启动地报告只读规格是否可构造；不能代替实际执行约束。 |
| renderer `standaloneWorkbenchConversationActionPort` / 产品 goal、guidance IPC | 两者 | 空闲继续目标显式 submit；活动 guidance 检查错误信封并交 UI 处理。 |

0.9.1 过期消费面已按公开合同清理：执行语言由产品固定的 Node 执行口确定，完成原因使用
presentation.completion，删除 hourly throttled 事件与预算字段。POSIX 进程组目标由公开
`shouldUseDetachedProcessGroup()` 决定，不再调用已删除的 getProcessKillPid。
