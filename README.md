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

Agents can use `velaros:sessions` to delegate work or append guidance to an active chat in the current
project. `tell` returns `queued` after actual guidance acceptance, refuses idle chats and never starts
another turn. Delegated tasks can create chats with their own transcript and change checkpoints.
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

当前使用 Platform `v0.7.3` 正式发布的配套 Velaros / capabilities `0.9.2`，UI 版本为 `1.0.0`。开发使用 Node 24.22.0 LTS 与 Bun 1.4.3；安装包携带同版本 Node。

`resources/runtime-snapshot.json` 分别记录 Platform 和 UI 正式发布的来源、版本与哈希，锁文件固定完整依赖。
首次使用从声明的 GitHub Release 恢复归档；已有缓存时可用 `--verify-only` 离线核验：

```bash
bun scripts/release/platformSnapshot.mjs
bun install --frozen-lockfile
bun run dev
```

准备命令只从声明的 GitHub Release 恢复正式包，不猜 release tag。
缺少缓存时需要具备对应仓库读取权限的 `gh`。Platform 与 UI 改动由对应 owner 构建为固定归档，Workbench
只消费公开入口，不引用兄弟仓源码或共享 node_modules。基础和扩展必须同版切换。

开发验证按影响范围选择类型/lint 分区和必要行为测试，复用已通过结果；完整 `bun run check` 留给需要全量检查的交付。
`check:platform-packages` 核对快照、归档、锁元组及 overrides。更新受控清单和快照后用 Bun 刷新锁文件，审查再提交。
正式发布门只接受已发布来源；此前 0.9.1 的本机候选来源与消费证明保留为历史证据，不再是当前发行状态。
源码仓库中的旧 CI 与锁文件刷新
Actions 仍是静态停用哨兵；正式发布由 Desktop 仓库的 `release-workbench.yml` 承载，使用固定 Workbench 提交在各平台原生 runner 上检查与打包。

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
artifacts under `artifacts/desktop/`. The main process loads `@velaros-ai/velaros` as
native ESM from `node_modules` at runtime (the script worker entry and ScriptAct templates resolve by
package path); `afterPack` checks that every static import of those packages resolves inside
`app.asar`. Release staging verifies pinned dependency snapshots and registry packages before an official build. Signing and notarization credentials are supplied by the release
environment; they are never stored in this repository. Official packages and candidates are produced
on matching native hosts, either locally or through the
[Workbench release workflow](https://github.com/VelarOS-AI/VelarOS-Desktop/actions/workflows/release-workbench.yml)
hosted in Desktop's existing signing environment. Native builds may run in parallel; platform
finalization is serialized to preserve every verified platform in the signed catalog. Electron Builder
publishing remains disabled, and this repository's old CI sentinels remain inactive.

The public candidate release uses separate manifests: `candidate-*.json` marks a complete build,
while the Ed25519-signed schema-2 `catalog-*.json` is the only manifest Cloud imports. The catalog
includes the exact bilingual entry for the current version from
`resources/release-notes/workbench.json`; staging and finalization fail closed when that entry is
missing or invalid. After upload, an agent publishes an exact Workbench version with Cloud's
`release:software:production` command; no administrator page or interactive password is part of the
release path.

See [docs/local-platform-release.md](docs/local-platform-release.md) for the clean
tag, native packaging, immutable staging, signed candidate finalization, and platform isolation gates.
