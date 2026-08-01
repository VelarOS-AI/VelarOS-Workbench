# Workbench 内部模块

Workbench 已拆除仓内 npm 包边界，全部产品源码归属唯一应用
`apps/workbench`。`src/workbench` 是应用内部的产品核心目录，不发布、
不建立独立版本，也不承诺仓外导入兼容性。

## 目录职责

- `src/workbench`：产品 contracts、领域模型、React 控制器、组合端口和产品 UI。
- `src/contributions/velar`：应用内置的 VelarScript 语言贡献。
- `src/main`：Electron 主进程、Kernel 能力实现、文件/Git/终端/语言服务宿主。
- `src/preload`：主进程能力到 renderer 的受控桥接。
- `src/renderer`：独立应用入口、宿主适配、页面组合与样式。

应用内通过 `@workbench` 和 `@workbench/*` 别名引用 `src/workbench`。
这些别名只是避免脆弱相对路径的内部构建约定，不是 npm 包导出。

## 结构边界

- `src/workbench` 不依赖 Electron 主进程、Desktop store、Desktop IPC 或 Desktop 窗口实现。
- 产品端口只依赖共享 Kernel contracts；具体能力由应用组合根安装。
- 跨产品共享的无状态组件继续归属 `@velaros-ai/ui`，不复制进 Workbench。
- 通用语言宿主不包含 VelarScript 特判；`src/contributions/velar` 在应用组合根注入。
- Workbench 不依赖 VelarOS Desktop 内部源码，仍作为独立应用构建和发布。
