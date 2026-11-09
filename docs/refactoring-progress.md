# Workbench 清理与统一底座接入游标

起点：`5f00388153c513b5cf7e32397383c6c36b365d92`，工作区干净；本仓及上级未发现 AGENTS.md。
遵循 `workbench-internals.md`、`model-requests.md`、`local-platform-release.md` 与产品边界检查。

## 模块与归属

| 负责人 | 独占模块 | 本批工作 |
| --- | --- | --- |
| 主 agent | main/conversation、main/index、ProjectRegistry、shared/preload 登记合同、依赖/发行配置、规范文档 | Platform 显式装配、产品身份迁移、事件持久化、审查/验证/提交 |
| engine_cleanup 子 agent | main/engines 及引擎现有测试 | 协议旧兼容、会话身份与生命周期 |
| project_cleanup 子 agent | 已交付项目/终端/历史批次；Git 源码与相关测试 | Windows 进程取消、stash 对象身份 |
| renderer_cleanup 子 agent | renderer 宿主/组合、项目页面/恢复 hooks 与相关模型 | 删除旧嵌入/伪绑定，接主进程登记、恢复后才保存 |

子 agent 不跨仓、不提交；主 agent 按批审查，只 stage 本批。重型验证通过共享
`D:/Projects/VelarOS-Desktop/scratchpad/heavy-validation.lock` 的独占 token 串行执行。

## 实际依赖边界

当前快照 `v0.6.111` / `d0dadb56ab56dc5b832831617073ee754dd663f0`，Velaros `0.7.0`；
UI `1.0.0` / `c6be9c5a143a96913422f6a577885a870c6fc274`。全部为带哈希的本仓归档，不是兄弟仓链接。

- Runtime 根入口：createRuntime、createNodeExecutionEnvironment、createCapabilityModule、会话/笔记/trace。
- 执行与上下文：execution、execution/local、script、act/agents、kernel、contracts、renderer。
- 显式接入能力：browser（含 electron/contracts/renderer）、sessions、web；当前隐式能力为 project/code/images、memory、widgets、agents。
- 产品宿主：project 内核供 IDE 读文件/规则；memory 存储按真实项目根分格；model 连接与目录；core 通用错误、计时、原子写和共享账号资源。
- UI：公开 conversation、contracts、composer、markdown 与组件/样式入口。

Workbench 独占项目/浏览器 workspace、项目成员/资源/权限策略、IDE 与产品窗口、产品会话目录及投递。
Platform 只持有通用 Agent/Session、执行、上下文、交互与授权。Cloud 是独立服务。

## 待 Platform owner 交付

1. ADR 0028 已明确新 createRuntime、/node 与基础/扩展归属；仍待无执行控制会话的公开合同。
2. project/code/images、memory、widget、worker profile 显式装配以实际构建后的公开声明为准。
3. executionIdentity、authorizationScope 与模块绑定是通用恢复约束；Workbench 的项目与浏览器选择留在产品。
4. 可核验源码提交、版本、包闭包与固定归档哈希。收到后一次切换，不加旧接口适配或 node_modules 补丁。

ADR 0028 已读，产品装配方案：

- 消费固定 `@velaros-ai/velaros` 基础及匹配版本 `@velaros-ai/capabilities` 扩展；专项 import 整批迁移，根 Node 工厂改从 `/node` 消费。
- 保持现有应用级 ShellHostRegistry 为唯一进程 owner；借给每轮 Node，不能让新入口再创建第二份本机 Host。
- 每项目/会话目录显式建立存储；执行身份派生自产品确认的真实项目根、会话，授权范围包含沙箱策略；产品恢复入口重新核验窗口项目。
- 显式建立 project kernel/ports、project/code/images 三模块和稳定 instance/generation；console、browser/devtools/cdp、web、sessions 继续由 Workbench 注入；memory、widgets、worker profile 显式选择。
- 旧 runtime:workspace 不兼容读取；切换到新存储代际，界面历史可保留，新执行从经核验的新会话开始。
- 缺口：`WorkbenchConversationSession.openControl` 无模型读取笔记/目标时当前不挂业务模块；新 `SessionExecutionBinding` 要求模块绑定完全相同。需要公开无执行控制入口，或明确可恢复绑定合同；不创建伪实现绕过检查。

## 阶段记录

- 独立清理已收口：项目窗口、外部引擎、账号/模型凭据、renderer 宿主/评论/持久化装配、终端、本地历史、会话恢复。
- 核查后不改：AtomicFileWrite、TextCodec、DeleteUndoStore 的真实字节/权限/撤销约束；账号 routePolicy.models 是真实 Cloud producer，不属于旧兼容。
- 用户要求减少测试：主 agent 合并一次必要受影响验证，不跑全量回归、长 E2E、大型矩阵与重复 build；子 agent 不独立跑重型检查。
- 已通过：项目/引擎/恢复/终端/产品边界 6 文件 62 项；账号/凭据 4 文件 34 项；产品边界静态门。后续仅定向验证新增故障场景及 JSON 工厂变更。
- node/web 类型已通过。38 个变更 node、20 个变更 web 文件 lint 的四处格式问题已定向修正并复查；其余原通过结果复用。12 个变更测试文件 lint 通过。
- 追加定向验证已通过：历史 2 项、引擎写盘重试 1 项、跨窗口登记 1 项、stash 3 项、远端/控制 3 项；Node 实际常驻进程 3 项。Windows 上另外 5 项非 Windows 远端场景如实跳过。
- 项目身份现由主进程 ProjectRegistry 单队列持有；只在首次新存储建立时导入原 v1 完整快照，原 ID/编辑器会话键保留；renderer 不再整表回写项目列表。此为产品数据迁移，不是旧运行行为 fallback。
- 更新过的项目/JSON 9 项通过，产品边界检查通过；脚本按仓库 lint 配置被忽略，其三个真实 Node 进程行为已验证。没有运行全量回归、性能/长 E2E 或生产 build。
- 独立清理代码均已提交。接入的具体控制合同与 0.9.0 双归档身份见 `workbench-platform-migration.md`，等待 owner 明确空闲控制合同后一次切换。

已提交批次（各批保留上述通过证据，不重复回归）：

| commit | 模块 |
| --- | --- |
| e6efbc5 | 账号/凭据 |
| f87bbb0 | 会话恢复与无消费注入 |
| 96d38f7 | 终端资源端口与退出等待 |
| 5d7bae3 | 外部引擎协议、接纳、持久身份 |
| 6bb82d5 | 本地历史失败保全 |
| 02aa856 | 控制台启动取消与常驻进程展示 |
| 4f7cba8 | stash 并发与 Windows Git 进程取消 |
| 7cda76a | 主进程项目身份、恢复保存闸门、renderer 旧状态清理 |

下一游标：检查点最终采集与下一轮 capture 的队列到达顺序；本批不继续扩大实现范围。
