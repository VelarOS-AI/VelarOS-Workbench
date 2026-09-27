# Workbench model request sources

Audited against the linked Platform ScriptAct runtime (`@velaros-ai/velaros` 0.6) and UI 0.2.54. The
chat no longer assembles tool schemas or system prompts itself: the Platform runtime owns the
ScriptAct protocol, the working-memory frame and the resident module contracts, and Workbench adds
host instructions and user-message context. `bun run test` runs the integration test
`scripts/test/conversationRuntime.test.mjs` against the real runtime with a scripted model.

| Entry | Actual injected source | Verification |
| --- | --- | --- |
| ScriptAct protocol, frame marker and working memory | `createRuntime` in `WorkbenchConversationSession.ts` (Platform-owned) | The integration test drives the real protocol: the fake model reads the frame marker from `compiledPrompt` and answers with `execute` / `done` blocks. |
| Resident module contracts | `ResidentModules` (`velaros:project`, `velaros:code`, `velaros:shell`, `velaros:interaction`, `velaros:widget`) in `WorkbenchConversationSession.ts` | Declarations and examples come from the installed Platform packages; Workbench only picks the list. |
| Host instructions | `WorkbenchConversationRules.buildHostInstructions` → runtime `instructions` | Identity, reply language, the leading `//` comment rule for script titles, plan and goal mode lines. The integration test finds them in the model request. |
| Project AI rules | `ProjectCapabilityProvider.projectRules` → `projectRulesSection` in `WorkbenchConversationRules.ts` | Rule files are quoted verbatim inside `<project-rules path="…">`, 32,000 characters in total; omitted files are named. The integration test injects an `AGENTS.md` rule and checks the request. |
| Host environment | `WorkbenchHostEnvironment` (`{ os }`) → runtime `environment` | Placed at the end of each frame with the local time, outside the prefix cache. |
| Long-term memory index | `WorkbenchMemoryService.forRun` → `renderIndex()` → last section of the host instructions | Rendered once when the run starts, for the project's scope (`project:<realpath>`); skipped when memory is off in Settings. The integration test saves an entry and finds it in the request. |
| Web search module | `velaros:web` mounted per run (not resident) with `WorkbenchWebSearchPages` and the Settings search engine | Declarations come from the Platform package; the integration test imports it from a script. |
| User message, attachments and file chips | `standaloneWorkbenchChatAdapter.tsx` (`buildAttachmentContext`, `formatWorkbenchChatFileReferencesForPrompt`, `formatBrowserElementSelectionsForPrompt`, current editor path) | Path-only context in the user message; the agent reads files itself. Images go as image input; models known to be text-only get a note instead (`withoutImages`, covered by the integration test). |
| Run guidance | `sendRunGuidance` → `conversation.guidance` → `session.steer` | Text only; file chips and picked elements are folded into the text. |
| Goal auto-continue | `workbench.goalAutoContinueInstruction` (i18n) sent as guidance or a system notice | Tells the agent to finish with `done("…")` or record blockers with `goal.update`. |
| Permission confirmations | `WorkbenchConversationSession` `authorize` hook and the shell module's approval port | Not model input; shown as interaction cards. The integration test answers a `git reset --hard` confirmation. |
| Inline completion | `WorkbenchInlineCompletion.ts` → model text generation | Separate bounded insertion prompt; `workbench-inline-completion.test.ts` checks it carries no agent module or tool contract. |
| External engine instructions | `engineInstructions` in `src/main/engines/WorkbenchEngineInstructions.ts` → Claude Code `--append-system-prompt`, Codex `developerInstructions` | Only where the engine runs (Workbench), the reply language and the plan / goal mode lines. The engine keeps its own system prompt, tools and rule files; Workbench's project rules and memory are not injected. `workbench-agent-engines.test.ts` drives both engines against fake CLIs. |
| External engine user message | the same composed input text and images as a Platform run (`standaloneWorkbenchChatAdapter.tsx`) | Sent as the engine's user message: Claude Code content blocks, Codex `UserInput` items. |

Retired with the Platform migration: the in-process Agent execution stack, `tooling:map` discovery,
`workbench:*` UI tools, sub-agent type definitions and Mod tool surfaces. Their prompt-audit helper and
captures were removed with them.
