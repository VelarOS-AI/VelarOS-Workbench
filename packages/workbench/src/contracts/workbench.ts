export interface WorkbenchDirectoryEntry {
  name: string
  path: string
  type: 'directory' | 'file'
  size: Nullable<number>
  modifiedAt: Nullable<number>
  hasChildren: boolean
  gitIgnored?: boolean
}

export interface WorkbenchListDirectoryRequest {
  projectRoot: string
  path?: string
  includeHidden?: boolean
  limit?: number
}

export interface WorkbenchListDirectoryResult {
  projectRoot: string
  path: string
  entries: WorkbenchDirectoryEntry[]
  truncated: boolean
}

export interface WorkbenchReadFileRequest {
  projectRoot: string
  path: string
  maxChars?: number
}

export interface WorkbenchReadFileResult {
  projectRoot: string
  path: string
  content: string
  size: number
  modifiedAt: number
  totalLines: number
  truncated: boolean
}

export interface WorkbenchIndexProjectRequest {
  projectRoot: string
  path?: string
  includeHidden?: boolean
  maxDepth?: number
  maxFiles?: number
  maxFileBytes?: number
  maxCharsPerFile?: number
}

export interface WorkbenchIndexedTextFile {
  path: string
  content: string
  size: number
  modifiedAt: number
  totalLines: number
  truncated: boolean
}

export interface WorkbenchIndexProjectResult {
  projectRoot: string
  path: string
  files: WorkbenchIndexedTextFile[]
  scannedFiles: number
  skippedFiles: number
  truncated: boolean
}

export interface WorkbenchStartProjectAiIndexRequest extends WorkbenchIndexProjectRequest {
  force?: boolean
  /** 只在已有健康 CodeGraph 索引时排增量同步；没有索引时不触发首次构建。 */
  syncOnlyIfIndexed?: boolean
  /**
   * 用户手动触发 CodeGraph 构建。
   * 未置 true 时不会首次构建 CodeGraph，只会在已有健康索引时做后续同步。
   */
  forceCodeGraph?: boolean
}

export interface WorkbenchStartProjectAiIndexResult {
  projectIndex: WorkbenchIndexProjectResult
  status: WorkbenchProjectAiIndexStatus
  /** true 表示主进程已接收构建请求，项目扫描和 CodeGraph 构建会在后台继续。 */
  scheduled?: boolean
}

export type WorkbenchProjectAiIndexState = 'indexing' | 'ready' | 'not-indexed' | 'failed'

export type WorkbenchProjectAiIndexPhase =
  | 'not-indexed'
  | 'scanning-project'
  | 'building-codegraph'
  | 'syncing-knowledge'
  | 'writing-memory'
  | 'ready'
  | 'failed'

export interface WorkbenchProjectAiIndexStatusRequest {
  projectRoot: string
}

export interface WorkbenchProjectAiCodeIndexDiagnostics {
  providerId: string
  providerLabel: string
  version: Nullable<string>
  initialized: boolean
  indexing: boolean
  watching: boolean
  fileCount: number
  nodeCount: number
  edgeCount: number
  frameworks: string[]
  backend: Nullable<string>
  journalMode: Nullable<string>
  pendingFileCount: number
  lastError: Nullable<string>
  /** 因尚未手动触发 CodeGraph 建图而跳过（additive，旧 renderer 可忽略）。 */
  skipped?: boolean
}

export interface WorkbenchProjectAiIndexStatus {
  projectRoot: string
  projectId: string
  projectName: string
  status: WorkbenchProjectAiIndexState
  phase: WorkbenchProjectAiIndexPhase
  memoryId: Nullable<string>
  indexedAt: Nullable<number>
  startedAt: Nullable<number>
  updatedAt: Nullable<number>
  scannedFiles: number
  indexedFiles: number
  skippedFiles: number
  error: Nullable<string>
  packageName: Nullable<string>
  packageManager: Nullable<string>
  keyFileCount: number
  likelyCommandCount: number
  sourceRootCount: number
  languages: string[]
  /** 可选：CodeGraph / 代码智能后端诊断（additive，旧 renderer 可忽略）。 */
  codeIndex?: LooseOptional<WorkbenchProjectAiCodeIndexDiagnostics>
}

export interface WorkbenchProjectAiIndexStatusChangedEvent {
  kind: 'velaros.workbenchProjectAiIndexStatusChanged'
  status: WorkbenchProjectAiIndexStatus
}

export type WorkbenchCodeGraphMode = 'full' | 'local'

export interface WorkbenchCodeGraphNode {
  id: string
  label: string
  path: string
  language: string
  kind: string
}

export interface WorkbenchCodeGraphEdge {
  from: string
  to: string
  kind: string
}

export interface WorkbenchGetCodeGraphRequest {
  projectRoot: string
  /** full：全项目文件依赖图（限量）；local：以中心文件为起点按 depth 跳 BFS。 */
  mode: WorkbenchCodeGraphMode
  /** local 模式的中心文件（项目相对路径）。 */
  centerPath?: string
  /** local 模式的 BFS 跳数。 */
  depth?: number
  /** 节点上限。 */
  maxNodes?: number
}

export interface WorkbenchGetCodeGraphResult {
  projectRoot: string
  mode: WorkbenchCodeGraphMode
  nodes: WorkbenchCodeGraphNode[]
  edges: WorkbenchCodeGraphEdge[]
  truncated: boolean
}

export type WorkbenchProjectAiRuleSource =
  | 'velar'
  | 'reasonix'
  | 'codex'
  | 'claude'
  | 'cursor'
  | 'copilot'
  | 'windsurf'
  | 'cline'
  | 'roo'

export interface WorkbenchProjectAiRulesRequest {
  projectRoot: string
}

export interface WorkbenchProjectAiRuleFile {
  source: WorkbenchProjectAiRuleSource
  sourceLabel: string
  relativePath: string
  content: string
  truncated: boolean
}

export interface WorkbenchProjectAiRulesResult {
  projectRoot: string
  files: WorkbenchProjectAiRuleFile[]
  totalChars: number
  truncatedFiles: number
  omittedFiles: number
}

export type WorkbenchLanguageServiceStatus = 'ready' | 'plugin-required' | 'unsupported'

export type WorkbenchLanguageServiceCapability =
  | 'completion'
  | 'definition'
  | 'diagnostics'
  | 'rename'
  | 'hover'
  | 'references'
  | 'signature-help'
  | 'format'
  | 'document-symbols'
  | 'document-highlights'
  | 'inlay-hints'

export interface WorkbenchLanguageServicePosition {
  line: number
  column: number
  offset?: number
}

export interface WorkbenchLanguageServiceRange {
  startLine: number
  startColumn: number
  endLine: number
  endColumn: number
}

export interface WorkbenchLanguageServiceOpenFile {
  path: string
  content: string
  version?: number
}

export interface WorkbenchLanguageServiceRequest {
  projectRoot: string
  path: string
  language?: string
  content?: string
  openFiles?: WorkbenchLanguageServiceOpenFile[]
}

export interface WorkbenchLanguageServiceOffsetRange {
  from: number
  to: number
}

export interface WorkbenchLanguageServiceInlayHintsRequest extends WorkbenchLanguageServiceRequest {
  ranges: WorkbenchLanguageServiceOffsetRange[]
  /** 首次/标签集合变化时同步全部打开文件；滚动更新可复用主进程已有 overlay。 */
  syncOpenFiles: boolean
}

export interface WorkbenchLanguageServicePositionRequest extends WorkbenchLanguageServiceRequest {
  position: WorkbenchLanguageServicePosition
}

export interface WorkbenchLanguageServiceRenameRequest extends WorkbenchLanguageServicePositionRequest {
  newName: string
}

export interface WorkbenchLanguageServiceDescriptorSnapshot {
  id: string
  label: string
  installKind: 'builtin' | 'plugin'
  runtime:
    | 'typescript-language-service'
    | 'html-language-service'
    | 'css-language-service'
    | 'python-language-server'
    | 'lsp-server'
  packageName?: string
  command?: string
  args?: string[]
}

export interface WorkbenchLanguageServiceResolveResult {
  projectRoot: string
  path: string
  languageId: string
  status: WorkbenchLanguageServiceStatus
  service: Nullable<WorkbenchLanguageServiceDescriptorSnapshot>
  capabilities: WorkbenchLanguageServiceCapability[]
}

export interface WorkbenchLanguageServiceLocation {
  path: string
  line: number
  column: number
  range?: WorkbenchLanguageServiceRange
}

export interface WorkbenchLanguageServiceDefinitionResult {
  projectRoot: string
  path: string
  locations: WorkbenchLanguageServiceLocation[]
}

export interface WorkbenchLanguageServiceCompletionTextEdit {
  path: string
  range: WorkbenchLanguageServiceRange
  newText: string
}

export interface WorkbenchLanguageServiceCompletionItem {
  label: string
  kind?: string
  /** 签名、来源模块或中间列展示的其他元数据。 */
  detail?: string
  /** 右侧展示的返回类型或尾随类型说明。 */
  returnType?: string
  documentation?: string
  insertText?: string
  sortText?: string
  filterText?: string
  isSnippet?: boolean
  additionalTextEdits?: WorkbenchLanguageServiceCompletionTextEdit[]
}

export interface WorkbenchLanguageServiceCompletionResult {
  projectRoot: string
  path: string
  items: WorkbenchLanguageServiceCompletionItem[]
}

export interface WorkbenchLanguageServiceDiagnostic {
  path: string
  severity: 'error' | 'warning' | 'info'
  message: string
  source?: string
  /** 可用时返回 TypeScript 诊断码，例如 6133 未使用的局部变量。 */
  code?: number
  /** 标识该诊断范围引用了已弃用的声明。 */
  deprecated?: boolean
  range: WorkbenchLanguageServiceRange
}

export interface WorkbenchLanguageServiceDiagnosticsResult {
  projectRoot: string
  path: string
  diagnostics: WorkbenchLanguageServiceDiagnostic[]
}

export interface WorkbenchLanguageServiceTextEdit {
  range: WorkbenchLanguageServiceRange
  newText: string
}

export interface WorkbenchLanguageServiceFileEdit {
  path: string
  edits: WorkbenchLanguageServiceTextEdit[]
}

export interface WorkbenchLanguageServiceRenameResult {
  projectRoot: string
  path: string
  changes: WorkbenchLanguageServiceFileEdit[]
}

export type WorkbenchLanguageServiceDisplayPartKind =
  | 'aliasName'
  | 'className'
  | 'enumName'
  | 'fieldName'
  | 'interfaceName'
  | 'keyword'
  | 'lineBreak'
  | 'numericLiteral'
  | 'stringLiteral'
  | 'localName'
  | 'methodName'
  | 'moduleName'
  | 'operator'
  | 'parameterName'
  | 'propertyName'
  | 'punctuation'
  | 'space'
  | 'text'
  | 'typeParameterName'
  | 'enumMemberName'
  | 'functionName'
  | 'regularExpressionLiteral'
  | 'link'
  | 'linkName'
  | 'linkText'

export interface WorkbenchLanguageServiceDisplayPart {
  text: string
  kind: WorkbenchLanguageServiceDisplayPartKind
}

export interface WorkbenchLanguageServiceHoverResult {
  displayText: string
  displayParts?: readonly WorkbenchLanguageServiceDisplayPart[]
  documentation?: string
  documentationParts?: readonly WorkbenchLanguageServiceDisplayPart[]
  tags?: string[]
}

export interface WorkbenchLanguageServiceHoverQueryResult {
  projectRoot: string
  path: string
  hover: Nullable<WorkbenchLanguageServiceHoverResult>
}

export interface WorkbenchLanguageServiceSignatureHelpQueryResult {
  projectRoot: string
  path: string
  signatureHelp: Nullable<WorkbenchLanguageServiceSignatureHelpResult>
}

export interface WorkbenchLanguageServiceReferencesResult {
  projectRoot: string
  path: string
  locations: WorkbenchLanguageServiceLocation[]
}

export interface WorkbenchLanguageServiceSignatureParameter {
  label: string
  documentation?: string
}

export interface WorkbenchLanguageServiceSignatureItem {
  label: string
  documentation?: string
  parameters: WorkbenchLanguageServiceSignatureParameter[]
}

export interface WorkbenchLanguageServiceSignatureHelpResult {
  activeSignature: number
  activeParameter: number
  signatures: WorkbenchLanguageServiceSignatureItem[]
}

export interface WorkbenchLanguageServiceFormatResult {
  projectRoot: string
  path: string
  changes: WorkbenchLanguageServiceFileEdit[]
}

export type WorkbenchLanguageServiceDocumentSymbolKind =
  | 'class'
  | 'constant'
  | 'enum'
  | 'function'
  | 'interface'
  | 'method'
  | 'symbol'
  | 'type'
  | 'variable'

export interface WorkbenchLanguageServiceDocumentSymbol {
  name: string
  kind: WorkbenchLanguageServiceDocumentSymbolKind
  depth: number
  line: number
  column: number
  range: WorkbenchLanguageServiceRange
}

export interface WorkbenchLanguageServiceDocumentSymbolsResult {
  projectRoot: string
  path: string
  symbols: WorkbenchLanguageServiceDocumentSymbol[]
}

export interface WorkbenchLanguageServiceDocumentHighlight {
  range: WorkbenchLanguageServiceRange
  kind: 'read' | 'write'
}

export interface WorkbenchLanguageServiceDocumentHighlightsResult {
  projectRoot: string
  path: string
  highlights: WorkbenchLanguageServiceDocumentHighlight[]
}

export interface WorkbenchLanguageServiceInlayHint {
  position: WorkbenchLanguageServicePosition
  text: string
  kind: 'type'
  whitespaceBefore?: boolean
  whitespaceAfter?: boolean
}

export interface WorkbenchLanguageServiceInlayHintsResult {
  projectRoot: string
  path: string
  hints: WorkbenchLanguageServiceInlayHint[]
}

export interface WorkbenchSaveFileRequest {
  projectRoot: string
  path: string
  content: string
  expectedModifiedAt?: number
  expectedSize?: number
  /** 本地历史快照节流窗口（ms）：距上一份不足该间隔则不新增快照。0/省略=每次都存。 */
  localHistoryMinIntervalMs?: number
}

export type WorkbenchSaveFileResult = WorkbenchReadFileResult

/** 工作台本地历史里一条文件快照的元数据。 */
export interface WorkbenchLocalHistoryEntry {
  id: string
  savedAt: number
  size: number
}

export interface WorkbenchListLocalHistoryRequest {
  projectRoot: string
  path: string
}

export interface WorkbenchListLocalHistoryResult {
  path: string
  entries: WorkbenchLocalHistoryEntry[]
}

export interface WorkbenchReadLocalHistorySnapshotRequest {
  projectRoot: string
  path: string
  id: string
}

export interface WorkbenchReadLocalHistorySnapshotResult {
  path: string
  id: string
  content: string
}

export interface WorkbenchCreateEntryRequest {
  projectRoot: string
  parentPath?: string
  name: string
  type: 'directory' | 'file'
}

export interface WorkbenchRenameEntryRequest {
  projectRoot: string
  path: string
  newName: string
}

export interface WorkbenchMoveEntryRequest {
  projectRoot: string
  path: string
  parentPath: string
  name?: string
}

export interface WorkbenchDeleteEntryRequest {
  projectRoot: string
  path: string
}

export interface WorkbenchRestoreDeletedEntryRequest {
  projectRoot: string
  restoreId: string
}

export interface WorkbenchEntryMutationResult {
  projectRoot: string
  parentPath: string
  entry: WorkbenchDirectoryEntry
}

export interface WorkbenchDeleteEntryResult {
  projectRoot: string
  parentPath: string
  deletedPath: string
  restoreId: string
}

export interface WorkbenchRestoreDeletedEntryResult extends WorkbenchEntryMutationResult {
  restoredPath: string
}

export interface WorkbenchMoveEntryResult extends WorkbenchEntryMutationResult {
  previousPath: string
  previousParentPath: string
}

export interface WorkbenchSearchEntriesRequest {
  projectRoot: string
  query: string
  path?: string
  includeHidden?: boolean
  limit?: number
  maxDepth?: number
}

export interface WorkbenchSearchEntriesResult {
  projectRoot: string
  query: string
  entries: WorkbenchDirectoryEntry[]
  truncated: boolean
}

export interface WorkbenchContentSearchMatchResult {
  path: string
  line: number
  column: number
  excerpt: string
}

export interface WorkbenchSearchContentRequest {
  projectRoot: string
  query: string
  path?: string
  includeHidden?: boolean
  limit?: number
  maxDepth?: number
  maxResultsPerFile?: number
}

export interface WorkbenchSearchContentResult {
  projectRoot: string
  query: string
  matches: WorkbenchContentSearchMatchResult[]
  truncated: boolean
}

export interface WorkbenchRunCommandRequest {
  projectRoot: string
  command: string
  runId?: string
  cwd?: string
  timeoutMs?: number
  maxOutputChars?: number
}

export interface WorkbenchRunCommandResult {
  projectRoot: string
  command: string
  cwd: string
  exitCode: Nullable<number>
  signal: Nullable<string>
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  truncated: boolean
  success: boolean
  startedAt: number
  finishedAt: number
}

export interface WorkbenchRunCommandOutputEvent {
  runId: string
  stream: 'stderr' | 'stdout' | 'system'
  chunk: string
  closed?: boolean
  exitCode?: LooseOptional<number>
  signal?: LooseOptional<string>
}

export interface WorkbenchTerminalStartRequest {
  projectRoot: string
  cwd?: string
  /** 起会话后立即在 shell 内执行的命令（运行卡用，例如 `bun run dev`）。 */
  initialCommand?: string
}

export interface WorkbenchTerminalStartResult {
  sessionId: string
  projectRoot: string
  cwd: string
  shell: string
  startedAt: number
}

export interface WorkbenchTerminalInputRequest {
  sessionId: string
  input: string
  /** 原样写入，不追加 cwd 探针（运行卡把输入直接送进前台进程 stdin 时用）。 */
  raw?: boolean
}

export interface WorkbenchTerminalStopRequest {
  sessionId: string
  /** 终止信号，默认 SIGTERM。运行卡的 Ctrl+C 用 SIGINT（作用于前台进程组）。 */
  signal?: 'SIGINT' | 'SIGTERM'
  /** 跳过延迟 SIGKILL 兜底强杀。SIGINT 中断（可能只是打断而非杀死）时用。 */
  skipForceKill?: boolean
}

export interface WorkbenchTerminalOutputEvent {
  sessionId: string
  stream: 'stderr' | 'stdout' | 'system'
  chunk: string
  closed?: boolean
  exitCode?: LooseOptional<number>
  signal?: LooseOptional<string>
  /** shell 真实 `$PWD`（由 cwd 探针标记解析而来），用于让终端提示符跟随实际目录。 */
  cwd?: LooseOptional<string>
}

/** Renderer → main：同步 Workbench 当前焦点文件与选区，供 Agent prompt 轻量提示。 */
export interface WorkbenchReportAgentWorkspaceSignalsRequest {
  projectRoot: string
  /** 当前侧栏选中的 chat session；非 chat（如 dev console）可为 null，避免串会话。 */
  chatSessionId?: LooseOptional<string>
  focusedRelativePath?: LooseOptional<string>
  selection?: {
    startLine: number
    endLine: number
    startColumn?: number
    endColumn?: number
  }
}

/** Renderer → main：请求编辑器 Tab 内联补全（Cursor 式 ghost text）。 */
export interface WorkbenchInlineCompletionRequest {
  projectRoot: string
  /** 当前文件相对/绝对路径；未落盘的临时文件可为 null，仅用于给模型语言/文件名提示。 */
  path?: LooseOptional<string>
  /** CodeMirror 语言 id（如 typescript、python），用于提示模型语言。 */
  language: string
  /** 光标之前的文本（已按预算截断）。 */
  prefix: string
  /** 光标之后的文本（已按预算截断）。 */
  suffix: string
}

export interface WorkbenchInlineCompletionResult {
  /** 应插入到光标处的补全文本；无建议时为空串。 */
  completion: string
}

/** Main → renderer：由 Workbench AI 请求、必须在编辑器真实状态上执行的命令。 */
export type WorkbenchEditorCommand =
  | { action: 'search'; query: string }
  | { action: 'open'; path: string; line?: number; column?: number }
  | { action: 'reveal'; path: string }
  | { action: 'close'; path: string }
  | { action: 'refresh' }
  | { action: 'move'; fromPath: string; toPath: string }
  | { action: 'delete'; path: string }
  | { action: 'write'; path: string; content: string }
  | {
      action: 'replace'
      path: string
      oldText: string
      newText: string
      replaceAll?: boolean
    }

export interface WorkbenchEditorCommandEvent {
  kind: 'velaros.workbenchEditorCommand'
  commandId: string
  sessionId: string
  projectRoot: string
  command: WorkbenchEditorCommand
}

/** Renderer → main：编辑器命令完成回执；AI 工具会等待这份回执再返回。 */
export interface WorkbenchEditorCommandResult {
  commandId: string
  success: boolean
  message: string
  data?: Record<string, unknown>
}

/** Workbench 可选语言语法能力的安装阶段。 */
export type WorkbenchLanguageGrammarInstallPhase = 'downloading' | 'verifying' | 'failed'

export interface WorkbenchLanguageGrammarInstallState {
  phase: WorkbenchLanguageGrammarInstallPhase
  percent?: number
  error?: string
}

export interface WorkbenchLanguageGrammarRecord {
  id: string
  installed: boolean
  version?: string
  install?: WorkbenchLanguageGrammarInstallState
}

export interface WorkbenchLanguageGrammarCatalog {
  generatedAt: number
  runtimeGlobal: string
  grammars: WorkbenchLanguageGrammarRecord[]
}

export interface WorkbenchInstallLanguageGrammarRequest {
  id: string
}
