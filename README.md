# VelarOS-Workbench

VelarOS Workbench is the independently releasable IDE application in the VelarOS ecosystem. It owns
project navigation, editing, language intelligence, Git, terminals, run surfaces and local project
history while consuming the shared VelarOS Kernel contracts and `@velaros-ai/ui`.

Workbench uses one project per window so multiple projects can stay open with isolated editor, Git,
terminal, language-service, and Agent state. Open folders from the start screen or File menu, pass a
folder to the application from the operating system, or drag one or more folders into a Workbench
window. Opening an already active folder focuses its existing window.

The repository itself is the Workbench application. It is a single package and all product code
lives directly below the root `src/`:

- `src/main`: Electron main process, Kernel host and privileged capability implementations.
- `src/preload`: the narrow bridge exposed to the renderer.
- `src/renderer`: UI entry point, components, models, hooks and renderer composition.
- `src/shared`: cross-process contracts, IPC envelopes and language-service descriptors.

The repository intentionally has no dependency on VelarOS Desktop internals. Shared VelarOS packages
are installed from the `VelarOS-Platform` releases on GitHub Packages; the app owns the Electron
implementation behind the semantic Workbench host.

Workbench is a **complete host**: it composes the Kernel module host *in its own process*
(kernel-contract §15) instead of connecting to a daemon. It registers exactly one capability,
`velaros.agent`, backed by an in-process `@velaros-ai/agent` execution stack. `velaros.model`
and `velaros.browser` have no implementation here, so those capabilities are simply absent and the
consumers degrade. The Workbench Agent prompts, tools, and execution modes are product-owned
built-ins. Claude Agent and ChatGPT/Codex are external engine plugins resolved from the shared
VelarOS plugin store and appear only after their individual plugin is installed and enabled.

Plugins carry resource-heavy capabilities or integrations that need external software. Workbench
installs CodeGraph, Claude Agent, and ChatGPT into the VelarOS user-level shared resource store, so
Desktop and Workbench discover the same physical installation while retaining product-local
enablement preferences. Mods remain a separate system for lightweight product extensions.

## Development

Workbench 的 VelarOS 包统一从 GitHub Packages 安装，本地多仓环境也不切换 sibling 软链。
配置具有 Packages 读取权限的 `NODE_AUTH_TOKEN` 后，严格按已提交锁文件安装：

```bash
bun install --frozen-lockfile
bun run check
bun run dev
```

Platform 发布成功后会自动为 Workbench 创建依赖升级 PR；`check:platform-packages` 会拒绝
任何 `file:`、`link:`、`workspace:` 或非 GitHub Packages 的锁文件解析。

Workbench deliberately ships a focused language surface: VelarScript, JavaScript / TypeScript,
Python, and related Web formats. Its generic editor core has no Velar-specific branches. The app
injects its built-in Velar contribution for syntax and project-local `velar lsp` connectivity,
while Python uses the bundled Pyright server through the same generic LSP transport.
See [docs/language-support.md](docs/language-support.md) for the supported surface and the
Velar compiler/editor joint-delivery contract.

## Packaging

`bun run package:mac`, `bun run package:win`, and `bun run package:linux` create application
artifacts under `artifacts/desktop/`. Signing and notarization credentials are supplied by the release
environment; they are never stored in this repository.
