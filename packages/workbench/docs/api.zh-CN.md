# `@velaros-ai/workbench` 中文 API

## 定位与非目标

本包是可嵌入的 AI 开发工作台产品层，提供项目、编辑器、终端、Git、代码智能、聊天组合、布局和偏好
模型。它通过端口消费执行、文件、Workspace、模型与浏览器能力，可装配在 Electron、WebView、测试
宿主或其他桌面 Shell 中。

本包不拥有 Electron IPC、窗口实现、Desktop Store、Kernel 进程或具体能力实现。独立
Workbench App 与 Desktop 只是两个不同的组合根。

## 安装

```bash
npm install @velaros-ai/workbench react
```

宿主还需要按采用的适配器安装已发布的 Kernel/Capabilities 包。Workbench 不要求宿主使用 Desktop
IPC；进程内 SDK、Local RPC 或自定义传输都可以实现同一组端口。
发布声明通过 `@velaros-ai/ui/utility-types` 显式导入辅助类型，不会向消费应用安装 ambient global。

## 公共入口

| 入口 | 用途 |
| --- | --- |
| `.` | 稳定 contracts、主要领域模型、Hook 与组合 API |
| `./runtime` | `WorkbenchRuntime`、Host Runtime 与 React composition root |
| `./host` | `WorkbenchHostRuntime`、Kernel 能力端口与 Shell 端口 |
| `./composition` | Chat、Browser 与响应式产品配置组合 |
| `./contracts` | 项目、系统、会话、编辑器和代码智能契约 |
| `./comments` | 实例化评论仓库、Provider 与 CodeMirror 评论扩展 |
| `./language` | 实例化语言插件运行时与语言服务适配器 |
| `./persistence` | 可注入存储的 JSON 持久化对象 |
| `./components/*` | 可嵌入的 Workbench 产品 UI |
| `./hooks/*` | 产品控制器 |
| `./models/*` | 无 UI 的领域模型与纯算法 |
| `./i18n` | 本地化 Provider 与 Hook |

只有 `package.json#exports` 中列出的路径属于公共 API。
`./host/*`、`./composition/*`、`./components/*`、`./hooks/*`、`./language/*`、
`./models/*`、`./persistence/*` 和 `./types/*` 是迁移期兼容入口，已弃用；新接入应优先使用上表的
语义入口。它们会在未来主版本中按迁移公告收敛，不应作为新的依赖基础。

## 核心类与接口

### `WorkbenchHostRuntime`

该类拥有一个组合根的宿主适配器，集中维护安装、不变量检查与卸载：

```ts
const runtime = new WorkbenchHostRuntime()
runtime.install({
  kernel: {
    project: projectCapabilities,
    sessions: sessionCapabilities,
    settings: modelCapabilities,
    workspace: workspaceCapabilities,
  },
  shell: shellCapabilities,
})

await runtime.kernel.project.readWorkbenchFile(request)
runtime.uninstall()
```

包内 React 控制器通过 `WorkbenchHostProvider` 读取当前 root 的实例。`workbenchHost`、
`installWorkbenchHost()` 和 `uninstallWorkbenchHost()` 只为旧应用兼容。

### `WorkbenchRuntime`

`WorkbenchRuntime` 是推荐的组合根对象，同时拥有 Host、评论仓库和语言插件运行时：

```ts
const runtime = new WorkbenchRuntime({ host })
// runtime.host / runtime.comments / runtime.languagePlugins
runtime.dispose()
```

### `WorkbenchCommentStore`

评论状态不再是模块变量。每个实例拥有自己的快照、订阅者、ID/时钟策略与销毁生命周期。测试可注入
确定性的 `createId` 和 `now`；React 组件通过 `WorkbenchCommentStoreProvider` 读取当前实例。

### `WorkbenchLanguagePluginInstallRuntime`

每个实例维护独立 catalog 和安装状态，首次读取时启动宿主订阅，`dispose()` 会取消订阅并阻止迟到
异步结果写回。新 UI 使用 `subscribe()`；DOM 自定义事件仅为旧入口兼容。

### `JsonStorageStore<T>`

该类拥有一个 JSON 存储键的序列化、规范化、Fallback 和日志策略。浏览器以外的宿主可以注入只实现
`getItem`、`setItem`、`removeItem` 的 `StorageLike`。内部现有模型继续通过
`createLocalStorageJsonStore()` 兼容工厂创建实例；旧名称 `LocalStorageJsonStore` 保留为别名。

### 能力端口

- `WorkbenchProjectKernelPort`：文件、项目索引、代码智能、命令和终端。
- `WorkbenchSessionKernelPort`：聊天历史和附件。
- `WorkbenchSettingsKernelPort`：模型目录与配置查询。
- `WorkbenchWorkspaceKernelPort`：Workspace、文件变更与 Git。
- `WorkbenchShellPort`：窗口等宿主 UI 能力，不属于 Kernel。

这些接口描述 Workbench 需要的最小能力集合。适配器可调用 VelarOS Capabilities，也可连接其他后端。

## 生命周期/并发

应用为每个窗口或 React root 创建一个 `WorkbenchRuntime`，在 Provider 外销毁。卸载时先停止模型
流和终端，再调用 `runtime.dispose()`；它会按语言订阅、评论状态、Host 的顺序释放。
`WorkbenchHostRuntime.uninstall(expectedHost)` 仍支持兼容单例交错销毁的安全检查。

终端、项目索引、语言服务和 Chat 的并发生命周期分别由对应控制器拥有；Host 只提供能力入口，不复制
这些状态。持久化 Store 每次 `update()` 执行一次读取、变更和写入，不维护第二份镜像状态。

## 依赖注入

```tsx
const workbench = new WorkbenchRuntime({ host: hostAdapter })

<WorkbenchRuntimeProvider runtime={workbench}>
  <WorkbenchProductRuntimeProvider value={runtimeProjection}>
    <WorkbenchLocalizationProvider value={localization}>
      <WorkbenchChatProvider value={chatComposition}>
        <WorkbenchPage />
      </WorkbenchChatProvider>
    </WorkbenchLocalizationProvider>
  </WorkbenchProductRuntimeProvider>
</WorkbenchRuntimeProvider>
```

- `WorkbenchHost` 注入异步能力和 Shell。
- `WorkbenchProductRuntimeProvider` 注入响应式设置与 UI 类名。
- `WorkbenchChatProvider` 注入会话与 Agent Surface。
- 本地化、Browser composition 和存储都在各自边界注入。

宿主对象只在组合根投影一次，包内不进行多层 DTO 来回转换。

## 错误模型

Kernel 端口统一返回 `Result<T>`，传输失败、权限拒绝和领域错误不会与成功值混在一起。
Host 未安装或安装结构非法时抛出 `AppError`。React 控制器在用户操作边界决定提示、重试或保留当前
状态；本包不会静默伪造成功。

## 最小第三方示例

```tsx
import { WorkbenchRuntime, WorkbenchRuntimeProvider } from '@velaros-ai/workbench/runtime'
import type { WorkbenchHost } from '@velaros-ai/workbench/host'

const host: WorkbenchHost = {
  kernel: {
    project: createHttpProjectAdapter(api),
    sessions: createHttpSessionAdapter(api),
    settings: createModelCatalogAdapter(api),
    workspace: createWorkspaceAdapter(api),
  },
  shell: {
    openChatWindow: () => router.open('/chat'),
    openSettingsWindow: (request) => router.open('/settings', request),
  },
}

const runtime = new WorkbenchRuntime({ host })
root.render(
  <WorkbenchRuntimeProvider runtime={runtime}>
    <YourWorkbenchSurface />
  </WorkbenchRuntimeProvider>
)

// 应用窗口销毁时
runtime.dispose()
```

第三方适配器只需满足结构接口，不需要继承 VelarOS class，也不需要引入 Desktop。

## 扩展点

- 实现新的 Host Port 适配器连接任意进程、RPC 或云服务。
- 通过 Composition Provider 注入不同 Chat、Browser 和产品配置。
- 在 `models` 中组合纯编辑器、Git、文件树和布局算法。
- 通过 `language` 目录扩展语法与语言服务。
- 用 `StorageLike` 接入 IndexedDB 包装、内存存储或测试存储。

拥有生命周期、注册或持久化策略的对象使用 class；纯文本、布局、编辑器变换和 React Hook 保持纯
函数，避免为了形式而制造对象与重复状态。

## 兼容策略

稳定根入口与 `./runtime`、`./host`、`./composition`、`./contracts`、`./comments`、
`./language`、`./persistence`、`./i18n` 语义入口遵循语义化版本。旧默认 Host、安装函数、状态
Facade、Store 工厂和通配子路径暂时保留并标记弃用。新增能力优先通过实例端口或新接口演进；宿主
私有 IPC 类型不得进入公共契约。未导出的源码路径不承诺兼容。
