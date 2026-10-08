# Workbench model request sources

Conversation models are selected in the chat composer from the configured provider's live catalog, using the same UI control as Desktop. Settings contain provider connections and the independent code-completion model. Claude Code and Codex have separate sidebar entries, each restoring its own conversations and exposing only that engine's model catalog.

The Platform owns the Agent loop, native `exec` tool, Node environment, generated capability
contracts and context history. Workbench composes the code workspace capabilities and
supplies IDE instructions, project rules and user context. The Node integration suite in
`scripts/test/conversationRuntime.test.mjs` uses a scripted native-tools model with real subprocesses.

| Entry | Actual source | Verification |
| --- | --- | --- |
| Native execution and context | `createRuntime` and `createNodeExecutionEnvironment` in `WorkbenchConversationSession.ts` | Native `exec` edits a file, imports project operations, runs execa and returns actual stdout. Cancellation stops a running process. |
| Capability directory | Platform generated contracts; `residentModules: []` and `$VELAROS_HOST_DIR/index.json` | Real Node imports and discovery cover project, code, images, browser/devtools/cdp, web, sub-agents and project chat collaboration. |
| Host instructions | `WorkbenchConversationRules.buildHostInstructions` | IDE identity, reply language, first-line Node/Shell comment and execution modes are checked in actual requests. |
| Project rules | `ProjectCapabilityProvider.projectRules` → quoted project rule section | Rule files remain verbatim, capped at 32,000 characters; the integration suite checks an AGENTS.md rule. |
| Environment | OS, browser, project cwd, execution scope and home from the host | Refreshed with the request; sandbox scope is checked against a real denied write. |
| Long-term memory | Project scope passed to Platform memory operations | Content appears only after recall; disabling memory excludes recall in the next session. |
| Project host bindings | `createRuntime({ workspace: root, project: { code: true, images: true } })` in `WorkbenchConversationSession.ts` | A regular project run can edit files, query language diagnostics and send local images to the next model request; image paths remain bounded by the project root. |
| Code tools | `resolveWorkbenchNodeEnvironment` and `workbenchNodePackages.json` | Host-provided npm packages load on import; discovery reads metadata and project-installed versions take precedence. The release verifier executes the packaged dependencies. |
| Project chat collaboration | Generated `velaros:sessions` surface and project-scoped host | Real Node delegation receives the peer answer; queue order, cancellation, removed targets and waiting cycles are covered. |
| Background commands | Shared execution host and project/chat-scoped controls | Real interactive subprocesses accept input and stop; matching chat ids in different projects stay isolated even with the same cwd. |
| Working notes | Platform note store and list/read controls | Two revisions survive run closure; pagination, stale reads and notifications are tested. |
| User context | `standaloneWorkbenchChatAdapter.tsx` attachment/file/browser-element context | Paths are delivered with user text; images retain multimodal data, with a text-only fallback covered by integration. |
| Guidance and answers | Platform steer/answer and Workbench interaction board | Running sessions receive user guidance and decisions; approval refusal starts no process. |

The Workbench host consumes public Platform/UI package entries. Contract declarations and model
schemas remain generated and owned by Platform.

Unknown model capacities use a provisional 1,000,000-token window, matching Desktop. Declared
limits take precedence. Explicit provider context/input limits calibrate the active driver; an
unquantified context rejection tightens near the rejected input. Calibration is cached per session,
model and connection configuration. Context maintenance and the composer gauge use the driver input
budget, and the gauge labels provisional capacity while retaining the latest usage during execution.
