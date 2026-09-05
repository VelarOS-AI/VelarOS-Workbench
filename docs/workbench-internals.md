# Workbench 内部模块

Workbench 是单体仓库：根 `package.json` 是唯一清单，全部产品源码直接归属
根 `src/`。仓内没有 `apps/`、`packages/` 或额外的 `workbench/` 套层，
也不建立第二套版本和发布边界。

## 目录职责

- `src/main`：Electron 主进程、Kernel 能力实现、文件/Git/终端/语言服务宿主。
- `src/preload`：主进程能力到 renderer 的受控桥接。
- `src/renderer`：UI 入口、产品模型、React 控制器、组件、页面组合与样式。
- `src/shared`：跨进程 contracts、IPC 信封、通用语言服务描述和无进程状态代码。

源码通过 `@main/*`、`@renderer/*`、`@shared/*` 显式表达所属层。这些别名既避免
脆弱相对路径，也让边界检查能阻止 renderer 与 main 互相穿透。

## 结构边界

- 产品核心模块不依赖 Electron 主进程、Desktop store、Desktop IPC 或 Desktop 窗口实现。
- 产品端口只依赖共享 Kernel contracts；具体能力由应用组合根安装。
- 跨产品共享的无状态组件继续归属 `@velaros-ai/ui`，不复制进 Workbench。
- 通用语言宿主不包含 VelarScript 特判；editor 贡献归 renderer，服务描述归 shared。
- Workbench 不依赖 VelarOS Desktop 内部源码，仍作为独立应用构建和发布。
- 可重复下载的外部 runtime 使用 VelarOS 组织级共享资源磁盘 ABI；Workbench 只消费共享
  CodeGraph 安装，不在自身 `userData` 建第二份。配置、启停、项目索引和缓存仍由 Workbench
  独立持有；未安装时相关 CodeGraph UI 整体隐藏。

## Agent 执行装配

`src/main/agent/WorkbenchAgentExecutionStack.ts` 使用 Platform 公共导出的
`createAgentExecutionStack`。工厂在包内配对 ModelRuntime、TurnRunner、RunContext 和
SoloLoop；Workbench 注入模型端口、冻结的工具 Registry、提示词策略与共享治理登记处，
通过 `executeSolo` 执行当前前台项目回合。

Workbench 持有项目根、Kernel 能力取消信号、历史和工具可用性策略。执行装配按会话与
等价 Mod 工具面复用；工具面改变时重建 Registry 与执行栈，单纯 UI revision 变化继续
复用该会话的 CodingSessionTracker。清理会话通过栈的 `clearSession` 释放执行状态与
治理登记。

Workbench 通过 GitHub Packages 消费 `@velaros-ai/agent@0.6.9`，依赖要求与包完整性由
`package.json` 和 `bun.lock` 共同记录。请求、工具 schema、预算与传输名称映射来自同一份
已过滤工具快照；首轮 baseline 仅包含宿主常驻名单，工具执行与历史保留 canonical 名称。
版本升级需检查真实多回合工具调用、取消与收尾、类型、生产构建及产品边界。

## Agent 工具预算

每份冻结工具面的 Registry 使用 `@velaros-ai/agent/tool-contract` 物化并规范化 Zod
输入 schema，模型请求和上下文预算共用这份结果。预算计入工具名、描述、实际 schema
字符数，以及与 Desktop 一致的 50 字符工具信封开销；非 Zod schema 按实际发送的任意
对象发现结构计量，执行仍由原 schema 校验。

schema 包装器与字符数只在当前 Registry 内缓存。工具面保持等价时可跨 UI revision
复用；工具替换、移除或恢复由执行栈重建 Registry，开始独立缓存。每轮预算和模型工具集
仍应用当前 allowlist、分类访问和可用性过滤。
