# Workbench model request sources

Audited against the Project 2.1.0 / Agent 0.6.28 candidate. Source changes and request captures are
checked before publishing the corresponding package versions. The mandatory `bun run check` includes
`bun run test`, whose recursive test discovery includes `workbench-prompt-assembly.test.ts`.

| Entry | Actual injected source | Verification |
| --- | --- | --- |
| Built-in chat and run guidance | `standaloneWorkbenchChatAdapter.tsx` → `WorkbenchAgentCapabilityRuntime.ts` → `WorkbenchAgentExecutionStack.run` | User messages, system notices and guidance remain separate from system instructions; provider captures exercise the production stack. |
| Primary role, coding/task policy, tool execution and failure guidance | `createAgentExecutionStack` and `PrimaryAgentProfile` from the installed Agent package; Workbench passes an empty `segmentOverrides` list | Default, plan, goal and combined-mode provider captures audit current system instructions and every emitted tool example. Platform owns the underlying prompt text. |
| Host shell appendix | `WorkbenchCommandEnvironment.ts` → `chatConfig.systemPromptAppend` | Captured in primary, UI-attached and delegated requests. It uses the command runner's actual shell selector. |
| Tool and category discovery | `ProjectCapabilityProvider.ts` + `WorkbenchAgentControlTools.ts` → `WorkbenchAgentToolRegistry.ts` → `tooling:map` / `tooling:replace` | Captured map response includes tool discovery/loading and persisted result/input/file-history descriptions. Discovery regression loads the six-action code schema into the next provider request. |
| Project editing and file management | Installed Project definitions, bound by `ProjectCapabilityProvider.ts` | Runtime schema/examples checked from actual emitted descriptions. File-context tests exercise read → edit → historical recall → edit, and a failed large edit → correction-only retry. |
| Optional code analysis | `ProjectCapabilityProvider.bindProjectTools` | CLI description/schema both expose cycles/routing; compiler-backed projects use the four-action contract. Query-availability regression checks changes in installed capability. |
| Workbench UI tools and examples | `WorkbenchAgentUiTools.ts` through `WorkbenchAgentControlTools.ts` | UI-attached mode captures validate each visible example against its executable schema. Headless and delegated captures check their available surface separately. |
| Explore/edit/verify/general type definitions | `WorkbenchSubAgentPolicy.ts` → `SubAgentDispatcher` → QueryLoop | Explore and verify requests are captured after dispatch; read-only scopes contain no write tools. Verify uses the verifier role. QueryLoop injects the role ID and type appendix, not the display label/description. |
| Built-in skills | `EmptySkillRepository` in `WorkbenchAgentExecutionStack.ts` | This host supplies no skill catalog or skill body. Tool and Mod definitions are discovered through the registry. |
| Enabled Mods | `src/main/index.ts` → `WorkbenchBrowserToolHost.getModSurfaceSnapshot` → frozen `captureSnapshot` in the execution stack | Existing Mod-surface tests cover current descriptors, availability, registration identity and provider schema projection. Browser-owned prose comes from the enabled contribution. |
| File chips / current editor path | `workbenchChatFileReferences.ts` and `standaloneWorkbenchChatAdapter.tsx` | Path-only context, with explicit instructions to read as needed; file-reference tests exercise composer and guidance wiring. |
| Attachments / selected browser elements | `buildAttachmentContext` and imported `formatBrowserElementSelectionsForPrompt` in `standaloneWorkbenchChatAdapter.tsx` | Attachments are paths or bounded source evidence in user messages. They are not treated as executable Project tool instructions or current editable file references. |
| Codex engine start and resume | `WorkbenchAgentModeInstructions.ts` → developer instructions and turn input in `WorkbenchCodexAgentRuntime.ts` | Actual adapter request capture verifies that resume refreshes developer instructions when modes change. The local app-server JSON Schema confirms that `thread/resume` accepts this field. |
| Claude engine start and resume | `WorkbenchAgentModeInstructions.ts` → SDK query prompt in `WorkbenchClaudeAgentRuntime.ts` | SDK-boundary capture verifies the current complete mode snapshot on both runs. Native engine tools/settings remain owned by that engine. |
| External engine semantic extension | `WorkbenchAgentExtensionTools.ts` → Codex dynamic tool / Claude SDK MCP server | Codex discovery and the actual Claude SDK registration share symbol-search guidance. Regression compares both exposed input contracts, validates the advertised input and invokes both executors. Historical wire alias is accepted by the executor. |
| Inline completion | `WorkbenchInlineCompletion.ts` → Model text generation | Existing request-port capture verifies the separate bounded insertion-completion prompt and runs the same current-guidance guard; no Project tool contract or retry instructions. |
| Historical action templates | `workbenchActionPrompts.ts`, `workbenchCommentHandoff.ts` | Reference audit found no runtime caller for their prompt-building exports. They are not current request injection sources; `workbenchActionRuns.ts` imports only the action ID type. |

`tests/helpers/workbenchPromptAudit.ts` checks current system instructions and emitted tool
descriptions, including nested input schema guidance. Examples are parsed by their actual executable tool schemas. Historical/user/tool
evidence is kept separate. Counterexamples deliberately add a retired tool instruction, stale edit
fields and full-input retry guidance, a stale nested schema description, an unavailable discovery instruction, an invalid edit example, or a write tool to a read-only worker;
each must fail the gate. Assertions run after provider capture because the Agent can turn errors
inside a model callback into recoverable tool receipts.

Set `VELAROS_PROMPT_AUDIT_OUTPUT` to an existing exclusive directory when running the prompt assembly
test to retain the mocked provider requests. These captures contain synthetic tasks and tool
contracts; external-engine environment variables and credentials are not serialized.
