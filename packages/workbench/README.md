# @velaros-ai/workbench

VelarOS Workbench 的独立产品边界。领域模型、产品控制器、组合端口与可复用产品 UI 归本包；
Desktop 和独立 Workbench App 只负责各自的宿主适配与入口组合。

完整的公共入口、能力端口、宿主生命周期和第三方接入方式见
[中文 API 文档](./docs/api.zh-CN.md)。

## Responsibility

- 定义 Workbench 需要的 Kernel 能力端口、宿主 Shell 端口和本地化组合端口。
- 为 Desktop 内嵌入口与独立 Workbench App 提供同一安装协议。
- 已承接项目、文件、Git、命令、布局、偏好、评论、代码图谱、Action、AI 修改归档和完整编辑器领域模型。
- main 与 renderer 共用的语言服务目录也归属本包；宿主只负责安装能力与传输适配。
- 偏好、快捷键、布局、表面状态、历史读取等首批 React 产品控制器已迁入本包。
- 响应式宿主配置通过 `WorkbenchProductRuntimeProvider` 注入，不混入 Kernel 全局端口。
- Desktop Chat runtime 通过 `WorkbenchChatProvider` 投影为 Workbench 私有会话和 Session Surface。
- Chat Panel、AI 修改归档和 Chat change preview 已归属本包，不依赖 Desktop chat store。
- 作为 Workbench 领域模型、产品控制器和产品 UI 的唯一归属。

## Public Imports

- `@velaros-ai/workbench` — 公开产品 contracts 与领域模型。
- `@velaros-ai/workbench/runtime` — 推荐的实例化 composition root 与 React Provider。
- `@velaros-ai/workbench/host` — Kernel 与宿主端口。
- `@velaros-ai/workbench/composition` — chat scope 与响应式产品运行时组合 contracts。
- `@velaros-ai/workbench/comments` — 评论仓库、Provider 与编辑器扩展。
- `@velaros-ai/workbench/language` — 语言插件运行时与语言服务。
- `@velaros-ai/workbench/persistence` — 可注入存储对象。
- `@velaros-ai/workbench/i18n` — 产品本地化 Provider 与 hook；
  具体文案实现由宿主注入。

```tsx
import { WorkbenchRuntime, WorkbenchRuntimeProvider } from '@velaros-ai/workbench/runtime'
import { useWorkbenchI18n } from '@velaros-ai/workbench/i18n'

const runtime = new WorkbenchRuntime({ host })
root.render(
  <WorkbenchRuntimeProvider runtime={runtime}>
    <WorkbenchApp />
  </WorkbenchRuntimeProvider>
)
```

历史通配入口（如 `host/*`、`components/*`、`hooks/*`、`models/*`）仅为兼容保留并已弃用；新应用
不要继续扩散这些源码形态的深层导入。

## Boundary

- 包内不得依赖 `src/renderer`、Desktop store、Desktop IPC 实例或 Desktop 窗口实现。
- 包内不得依赖 Desktop i18n；Desktop 与独立入口分别安装自己的本地化适配器。
- 公开端口只依赖 `@velaros-ai/core` 的 Kernel contracts，不依赖 Desktop IPC 类型或实例。
- 独立产品入口可以通过 Local RPC、进程内 Kernel SDK 或测试实现安装同一组端口。
- 跨 Desktop/Workbench 复用的无状态产品组件属于 `@velaros-ai/ui`，不放入本包。
- 受控浏览器只通过 `@velaros-ai/browser-composition` 消费；本包不得接触 Desktop Browser stage。
