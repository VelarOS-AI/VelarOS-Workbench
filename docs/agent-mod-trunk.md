# Workbench 宿主主干：进程内 Kernel、Agent 执行栈、mod 两级注册机

> 权威边界裁决在 VelarOS-Desktop 的 `docs/kernel-contract.md`（尤其 §15）。本文只记
> **Workbench 这个宿主**怎么落地那份裁决，以及当前有意留空的部分。

## 1. 形态：完整宿主，进程内装栈

Workbench 是独立完整宿主：

```
src/main/index.ts                （组合根）
  ├ @velaros-ai/kernel/runtime Kernel           唯一进程内 Kernel
  │   └ WorkbenchKernelPermissionPolicy         产品显式授权：仅 agent.execute
  │   └ createAgentKernelModule({ runtime })    唯一注册的能力：velaros.agent
  │        └ WorkbenchAgentCapabilityRuntime    v1 信封解析 + Kernel 事件桥
  │             └ WorkbenchAgentExecutionStack  进程内 Agent 装配
  │                  ├ ModelRuntime             @velaros-ai/model（纯 BYOK）
  │                  ├ TurnRunner / AgentHistoryHelper / RunContext
  │                  ├ SoloStreamLoop           主 Agent 面
  │                  └ WorkbenchAgentToolRegistry
  │                       └ @velaros-ai/project/agent 工具族
  ├ WorkbenchModService                         mod 单 owner 门面
  │   ├ WorkbenchAgentModPackStore              本地目录扫描 + 注册表（停用位/外部登记）
  │   └ WorkbenchAgentModRuntime                Agent 领域 Loader（两级注册机第二级）
  └ registerWorkbenchKernelIpc                  renderer 面（语义路由表 + 状态投影 + 事件广播）
```

Workbench 直接进程内装配 `@velaros-ai/kernel/runtime` 的公共 `Kernel`，不再复制一份产品
runtime 门面，也不启动独立 daemon。模块生命周期、活跃版本解析、事件订阅和能力调用权限门均由
Platform Kernel 唯一拥有；Workbench 只声明模块清单与产品授权策略。

## 2. 能力面：只有 Agent

| capability | Workbench 有本体吗 | 结果 |
| --- | --- | --- |
| `velaros.agent` | 有（本进程执行栈） | 注册，`hasCapability` 为真 |
| `velaros.model` | 没有（模型是执行栈内部的库依赖，不是能力模块） | 不注册 |
| `velaros.browser` | 没有 | 不注册；`browser.*` 路由回 `KERNEL_CAPABILITY_UNAVAILABLE` |

渲染层的浏览器面本来就按 `status.capabilities` 里有没有 `velaros.browser` 决定是否激活，
因此能力缺席等于既有降级路径，不需要额外分支。

模型运行时位于本进程，BYOK 选择（provider / model / baseURL / apiKey）直接进入执行配置，
provider 不认识时由执行本身报错。

## 3. Agent 执行栈：裁到「聊天全链跑通」

**装了**：SoloStreamLoop 主循环、单轮流式 + 工具执行（TurnRunner）、历史准备与压缩
（AgentHistoryHelper）、系统提示词与轮次上下文（RunContext + 内置提示词段注册表）、角色解析
（PrimaryAgentProfile）、会话工具租约与提醒（CodingSessionTracker）、模型接入
（`@velaros-ai/model` 的 `AgentModelRuntime`）。

**没装**（相对 Desktop `createExecutionRuntime` 的显式裁剪，不是遗漏）：

- `ExecutionService` / `SoloExecutionService`：执行记录持久化、会话互斥、pending input、
  审批往返。一次 `execute` 就是一轮前台 solo 运行，abort 走 Kernel 能力信号。
- `SubAgentDispatcher` + `QueryLoop`：子 Agent 派发（`allowSubAgents: false`）。
- 技能库（`AgentSkillRepository` / `FileSkillProvider`）：`PrimaryAgentProfile` 走空技能分支。
- 记忆 / 知识 / 系统域服务、执行观测 span 账本、上下文注意力回学、后台任务管理器。

### 工具面

来源单一：`@velaros-ai/project/agent` 导出的 `project:read`、`project:list`、`project:search`、
`project:edit`、`project:rollback` 与 `project:run`。每个项目根一份 Project capability，
注册表也按项目根隔离。

工具面的欠账：没有类别启停租约、没有分页换入换出（`tool_map`）、没有 MCP 注入、没有
provider 生命周期。所有工具全程可见、全程可调。

## 4. mod 两级注册机

第一级（pack 发现 / 启停 / 安装）从跨进程 Kernel ModStore 收归 `WorkbenchAgentModPackStore`：

- 安装根 `<dataRoot>/mods/<packId>/` 逐目录扫描；
- 注册表 `<dataRoot>/mods/mod-registry.json` 记停用位与外部原地安装目录；
- 身份现读 `velaros.mod.json` 的 **module 节**（分节信封，Platform loader 只认信封），
  `agent` 节归第二级的领域 Loader。

第二级（领域轴装载）仍是 `WorkbenchAgentModRuntime` + `assembleAgentMods`。

### 轴接线现状

| 轴 | 接了吗 |
| --- | --- |
| `hooks`（拦截 seam） | **接了**：`loader.seams` 注入 ContextBuilder 与 SoloStreamLoop，`tool-call:before` / `tool-result:after` 在主链真派发 |
| `tools` / `toolCategories` / `promptSegments` / `skills` / `spaces` / `subAgentTypes` / `turnContextSources` / `executionModes` | 没接：装载成功但无本地落点，逐轴记 `workbench.mod.axis-unrouted` 诊断 |

设置页「模组」视图的数据源是 `WorkbenchModService.getSettingsOverview()`：已装载 mod 走领域
报告，本地清单里登记但没进激活表的 pack 补成 `inactive` 行——「装了什么」与「生效了什么」
在同一张表里对照。

`setEnabled` / `installFromDirectory` 在 service 层已就位（进程内单 owner 后启停免重启），
但还没开 IPC 通道与设置页控件，视图仍是只读。

## 5. 门与探针

```bash
bun run check                          # boundaries → typecheck → lint → test → probes → build
bun run probe:kernel-host              # 进程内 Kernel + 执行栈构造级冒烟
bun run probe:agent-mods               # 两级注册机装载报告
```

`probe:kernel-host` 覆盖四段：Kernel 起来且 `velaros.agent` 可直取（model/browser 为假）；v1
信封解析的通过与拒收；聊天链从 Kernel 能力入口一路走到**模型接口边界**才停（provider 用桩
id，零网络出口）；Kernel 事件桥的三通道信封形状。契约测试另锁住 renderer 请求的严格字段集，
以及只有主进程绑定的 `agent.execute` 路由能获得 `agent:execute` 权限。

零真机：真机验收押后批。

## 6. 已知欠账

1. 执行栈裁剪项（见 §3）——尤其没有执行记录持久化，聊天历史只在 renderer 的
   `localStorage` 里。
2. 工具面窄（见 §3）。
3. mod 启停 / 安装的 IPC 与 UI 控件。
4. 八根未接线的贡献轴（见 §4）。
5. `bun.lock` 的 `packages` 解析区对 `@velaros-ai/*` 仍指向旧发布版：Platform 尚未发包，
   本地开发全靠 `bun run link:local` 软链。发包后需重新生成锁文件。
