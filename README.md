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

Workbench is a **complete host**: it composes the Kernel module host _in its own process_
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

The built-in Agent consumes the shared Project tool contracts: `read`, `list`, `search`, `file`,
`edit`, and `run` are resident; `code` and `change` are discovered through `tooling:map` when needed.
Reads keep source lines separate from their positions. Edits use visible file references and can
combine line ranges with exact text, while changes group operations for inspection and undo.
The shared Agent context refreshes source references after edits and retains historical versions
and failed-call inputs for scoped recall and retry. Workbench binds those contracts to the current
project, session, shell and available UI capabilities.

## Development

Workbench 的 VelarOS 包统一从 GitHub Packages 安装，本地多仓环境也不切换 sibling 软链。
配置具有 Packages 读取权限的 `NODE_AUTH_TOKEN` 后，严格按已提交锁文件安装：

```bash
bun install --frozen-lockfile
bun run check
bun run dev
```

Platform 发布后，在受控本机运行 `bun scripts/refreshPrivatePackageLock.mjs` 刷新已发布依赖，
审查 `bun.lock` 后再提交。`check:platform-packages` 会拒绝任何 `file:`、`link:`、`workspace:`
或非 GitHub Packages 的锁文件解析。仓库中的 Actions 文件仅为静态跳过的本机策略哨兵；
检查和私有包锁定都不在 GitHub runner 上执行。

Workbench deliberately ships a focused language surface: VelarScript, JavaScript / TypeScript,
Python, and related Web formats. Its generic editor core has no Velar-specific branches. The app
injects its built-in Velar contribution for syntax and project-local `velar lsp` connectivity,
while Python uses the bundled Pyright server through the same generic LSP transport.
See [docs/language-support.md](docs/language-support.md) for the supported surface and the
Velar compiler/editor joint-delivery contract.

## Packaging

`bun run package:mac`, `bun run package:win`, and `bun run package:linux` create application
artifacts under `artifacts/desktop/`. Signing and notarization credentials are supplied by the release
environment; they are never stored in this repository. Official packages and candidates are produced
locally on the matching native host, one platform at a time. Electron Builder publishing is disabled,
and the repository's inert Actions sentinels cannot build, upload, or read release credentials.

The public candidate release uses separate manifests: `candidate-*.json` marks a complete build,
while the Ed25519-signed schema-2 `catalog-*.json` is the only manifest Cloud imports. The catalog
includes the exact bilingual entry for the current version from
`resources/release-notes/workbench.json`; staging and finalization fail closed when that entry is
missing or invalid. After upload, an agent publishes an exact Workbench version with Cloud's
`release:software:production` command; no administrator page or interactive password is part of the
release path.

See [docs/releases/local-platform-release.md](docs/releases/local-platform-release.md) for the clean
tag, native packaging, immutable staging, signed candidate finalization, and platform isolation gates.
