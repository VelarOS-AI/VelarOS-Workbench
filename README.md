# VelarOS-Workbench

VelarOS Workbench is the independently releasable IDE application in the VelarOS ecosystem. It owns
project navigation, editing, language intelligence, Git, terminals, run surfaces and local project
history, and runs its chat on the VelarOS Platform agent runtime with the shared `@velaros-ai/ui`
conversation surface.

Workbench uses one project per window so multiple projects can stay open with isolated editor, Git,
terminal, language-service, and Agent state. Open folders from the start screen or File menu, pass a
folder to the application from the operating system, or drag one or more folders into a Workbench
window. Opening an already active folder focuses its existing window.

The repository itself is the Workbench application. It is a single package and all product code
lives directly below the root `src/`:

- `src/main`: Electron main process, the conversation runtime host and privileged capability
  implementations.
- `src/preload`: the narrow bridge exposed to the renderer.
- `src/renderer`: UI entry point, components, models, hooks and renderer composition.
- `src/shared`: cross-process contracts, IPC envelopes and language-service descriptors.

The repository intentionally has no dependency on VelarOS Desktop internals. It consumes the
VelarOS Platform and UI through their public package entry points only; the app owns the Electron
implementation behind the semantic Workbench host.

The chat runs the Platform ScriptAct runtime in the main process, the same runtime VelarOS Desktop
uses. Each run opens a Platform session bound to the window's project: the agent works by writing
short scripts against resident modules (`velaros:project`, `velaros:code`, `velaros:shell`,
`velaros:interaction`, `velaros:widget`), and the scripts execute in an isolated utility process.
Sub-agents are available; web search and long-term memory are off. Workbench adds its host
instructions (reply language, plan and goal modes) and the project's AI rule files (`.velar/rules.md`,
`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules/`, `.github/copilot-instructions.md`).
Conversation state lives in the Platform's session store outside the project.

Permissions follow the Settings mode. "Ask every time" confirms each project write and command;
the standard mode lets routine work run, while the Platform confirms mass-destructive commands and
Workbench additionally confirms commands that would discard uncommitted work, switch branches or
write outside the project (`git reset --hard`, `git checkout`, `git pull`, …); "never ask" runs
everything.

Every run captures a Git checkpoint first. When the run's writes settle, the AI changes card lists
the files the agent changed, with diffs and per-file attribution (agent-only or mixed with other
edits). The agent's write windows come from the runtime's effect metrics; project edits also refresh
the language service immediately. Rewind, external engines (Claude Code, Codex), Mods, resource
plugins and CodeGraph were retired with the Platform migration, matching Desktop.

## Development

与 Desktop 一样，Workbench 经 `bun link` 消费本机兄弟仓的 Platform 与 UI（`package.json` 里是
`link:@velaros-ai/*`）：`@velaros-ai/{agent,core,kernel,model,script,velaros}` 来自 `../VelarOS-Platform`，
`@velaros-ai/ui` 来自 `../VelarOS-UI`。首次准备：

```bash
# VelarOS-UI 根目录（仓根就是 @velaros-ai/ui 包）
bun run build && bun link

# VelarOS-Platform 根目录：构建 velaros 及其依赖，再逐个登记
node scripts/build/buildPackageTopology.mjs --for @velaros-ai/velaros
for package in velaros model script core agent kernel; do (cd packages/$package && bun link); done

# Workbench 根目录
bun install
bun run check
bun run dev
```

Workbench 只消费这些包的公开 dist：改了 Platform 或 UI 要先在对应仓重新构建。
`check:platform-packages` 只接受同名的兄弟仓链接（`link:@velaros-ai/<name>`）或 GitHub Packages 的正式解析，
锁文件里的链接必须与清单一致。Platform 恢复发版后，把依赖换回已发布的版本，在受控本机运行
`bun scripts/refreshPrivatePackageLock.mjs` 刷新锁文件，审查 `bun.lock` 后再提交。仓库中的 Actions 文件仅为
静态跳过的本机策略哨兵；检查和私有包锁定都不在 GitHub runner 上执行。

Platform 的本地存储用 `node:sqlite`，bun 里没有：会话运行时的集成测试
（`scripts/test/conversationRuntime.test.mjs`）先用 bun 打包，再在 Node 里跑，`bun run test` 已包含它。

Workbench deliberately ships a focused language surface: VelarScript, JavaScript / TypeScript,
Python, and related Web formats. Its generic editor core has no Velar-specific branches. The app
injects its built-in Velar contribution for syntax and project-local `velar lsp` connectivity,
while Python uses the bundled Pyright server through the same generic LSP transport.
See [docs/language-support.md](docs/language-support.md) for the supported surface and the
Velar compiler/editor joint-delivery contract.

## Packaging

`bun run package:mac`, `bun run package:win`, and `bun run package:linux` create application
artifacts under `artifacts/desktop/`. The main process loads `@velaros-ai/{model,script,velaros}` as
native ESM from `node_modules` at runtime (the script worker entry and ScriptAct templates resolve by
package path); `afterPack` checks that every static import of those packages resolves inside
`app.asar`. Release staging refuses development links: switch the Platform and UI dependencies to
published versions before an official build. Signing and notarization credentials are supplied by the release
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
