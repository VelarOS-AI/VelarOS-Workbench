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

The chat uses the same Platform Agent runtime and standard Node execution environment as Desktop
project workspaces. Programs run on the bundled Node with ESM, top-level await and the standard npm
packages. Project editing, code queries, images, sub-agents, project chat collaboration, web search
and the session browser are available through the Platform's generated capability contracts. Process output,
errors and tool calls appear in the conversation and remain available in saved history.

Project sessions expose code editing, language queries and browser debugging through Platform's
capability discovery. Agents read contracts and import npm tools when needed. Workbench supplies
ts-morph, Prettier, jsonc-parser, ast-grep and Playwright alongside the base Node tools; dependencies
installed in the project take precedence. Package discovery reads metadata, and implementations load
on import. Settings → AI manages memory and the project sandbox. Long-term memory is scoped to each
project and recalled on demand. The chat header's notebook button shows the current session's versioned working
notes and refreshes as the run progresses. The console button opens a separate window for the chat's
development servers and background commands, with live output, interactive input and stop controls. Process ownership
uses the launch project and chat, even if a command changes its working directory.

Agents can use `velaros:sessions` to delegate work or queue messages to other chats in the current
project. New chats appear in the project list and retain their own transcript and change checkpoints.
Delegation carries the selected model, permissions and sandbox; waiting cycles
are rejected. Switching chats during login or attachment preparation preserves the original message
destination and the new chat's draft.

Each chat retains its draft text, attachments, file references, picked page elements and reasoning,
plan and goal settings. Queued messages capture this context when enqueued and leave the queue only
after the main process accepts them. A rejected submission stays available for retry, and automatic
queue delivery preserves the next draft being edited. Reopening an unfinished run shows it as
interrupted so the next message can continue the original task.

Workbench supplies reply language, plan and goal mode instructions, and the project's AI rules
(`.velar/rules.md`, `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.cursor/rules/`,
`.github/copilot-instructions.md`). Conversation state lives outside the project in the Platform store.
“Ask every time” confirms each complete Node program and project write. Standard mode runs programs
directly; full access automatically approves capability requests. The separate project sandbox
restricts native process writes to the project and allowed temporary directories; its default is off,
matching Desktop. External engines use their own approval protocols with the selected permission mode.

Every run captures a Git checkpoint first. When the run's writes settle, the AI changes card lists
the files the agent changed, with diffs and per-file attribution (agent-only or mixed with other
edits). The agent's write windows cover native processes and the runtime's project effects; project edits also refresh
the language service immediately.

A chat session can also be handed to an external agent engine: the Claude Code and Codex command-line
tools installed on the machine. The composer's model menu lists each engine the user has installed,
with the models it reports (an installed engine that is signed out shows as disabled, with the
reason); the choice belongs to the session and is fixed once it has messages, and new sessions start
with the last choice. Workbench bundles neither engine. It starts the user's `claude` with its
stream-json protocol (the one the Agent SDK uses), one process per turn resumed with `--resume`, and
keeps one `codex app-server` (JSON-RPC over stdio) for all Codex sessions, stopped after five idle
minutes. Sign-in, models, tools, rule files and conversation history stay with the engine; Workbench
remembers which engine session belongs to which chat session (`agent-engines/sessions.json` in the
data directory), draws the engine's answer, thinking, tool calls and plan in the conversation, and
answers its permission requests with the same Settings mode: Claude Code asks through the control
channel and Workbench decides (standard mode asks only for dangerous commands and writes outside the
project); Codex runs sandboxed to the project with `on-request` (standard), `untrusted` (ask every
time) or full access (never ask). Questions an engine asks become question cards. Engine turns get the
same checkpoint, AI changes card and language-service refresh; messages sent while an engine runs are
queued rather than injected, and Velar's memory, web search, browser and goal auto-continue do not
apply to engine sessions.

## Documentation

- [Architecture and implementation](docs/workbench-internals.md): process ownership, editor, Git, terminal, debugger and runtime behavior.
- [Language support](docs/language-support.md): supported languages and compiler/editor integration.
- [Model requests](docs/model-requests.md): instruction sources, project context and executable verification.
- [Local release](docs/local-platform-release.md): native packaging, verification and candidate publication.
- [Release notes](resources/release-notes/workbench.json): the versioned notes consumed by the release pipeline.

## Development

Workbench 使用固定的 Platform 本机依赖快照与 UI 发布版本，锁文件记录完整依赖。先登录具备 Platform 仓库读取权限的 `gh`，并配置 `NODE_AUTH_TOKEN` 后运行：

```bash
node scripts/release/platformSnapshot.mjs
bun install --frozen-lockfile
bun run check
bun run dev
```

需要联调 `../VelarOS-Platform` 或 `../VelarOS-UI` 时，在对应仓构建并登记链接，再从 Workbench 连接：

```bash
# VelarOS-UI 根目录（仓根就是 @velaros-ai/ui 包）
bun run build && bun link

# VelarOS-Platform 根目录：构建 velaros 及其依赖，再逐个登记
node scripts/build/buildPackageTopology.mjs --for @velaros-ai/velaros
for package in velaros model script core agent kernel; do (cd packages/$package && bun link); done

# Workbench 根目录
bun link @velaros-ai/velaros @velaros-ai/model @velaros-ai/script @velaros-ai/core @velaros-ai/agent @velaros-ai/kernel @velaros-ai/ui
```

Workbench 只消费这些包的公开 dist：改了 Platform 或 UI 要先在对应仓重新构建。
`check:platform-packages` 只接受同名的兄弟仓链接（`link:@velaros-ai/<name>`）或 GitHub Packages 的正式解析，
本机快照由 `resources/runtime-snapshot.json` 固定源码提交、版本和哈希；准备命令恢复私有 Platform Release 中的归档，发布检查逐包验证字节与锁文件。升级依赖时，更新清单和快照记录并在受控本机运行
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
`app.asar`. Release staging verifies pinned dependency snapshots and registry packages before an official build. Signing and notarization credentials are supplied by the release
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

See [docs/local-platform-release.md](docs/local-platform-release.md) for the clean
tag, native packaging, immutable staging, signed candidate finalization, and platform isolation gates.
