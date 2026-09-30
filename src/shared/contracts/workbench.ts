import type { WorkbenchImageMediaType } from '../workbenchImage'
import type {
  WorkbenchTextEncoding,
  WorkbenchTextEol,
  WorkbenchTextIssue,
} from '../workbenchTextFormat'

/**
 * 符号链接的目标在哪：`inside` 在工程里（照常展开、打开）；`outside` 在工程外、`missing` 已不存在——
 * 这两种只显示链接本身，不跟进去列举、读取。
 */
export type WorkbenchSymlinkTargetState = 'inside' | 'outside' | 'missing'

export interface WorkbenchDirectoryEntrySymlink {
  /** 链接里写的目标（readlink 原文，可能是相对路径）。 */
  target: string
  targetState: WorkbenchSymlinkTargetState
}

export interface WorkbenchDirectoryEntry {
  name: string
  path: string
  /** 链接按目标算；目标在工程外或已不存在的链接算 `file`，不能展开。 */
  type: 'directory' | 'file'
  size: Nullable<number>
  modifiedAt: Nullable<number>
  hasChildren: boolean
  gitIgnored?: boolean
  /** 这一项是符号链接时才有。改名、移动、删除都只作用于链接本身，不动它指向的东西。 */
  symlink?: WorkbenchDirectoryEntrySymlink
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

export interface WorkbenchReadImageFileRequest {
  projectRoot: string
  path: string
  maxBytes?: number
}

/** 问一组项目相对路径里哪些是项目里的文件（只看文件系统，不读内容）。终端输出里的路径据此决定能不能点。 */
export interface WorkbenchFindExistingFilesRequest {
  projectRoot: string
  paths: string[]
}

export interface WorkbenchFindExistingFilesResult {
  /** 请求里确实是文件（链接按目标算）、且真实位置仍在项目里的那些路径，原样返回。 */
  paths: string[]
}

export interface WorkbenchImagePreview {
  mediaType: WorkbenchImageMediaType
  data: Uint8Array
}

export interface WorkbenchReadFileResult {
  projectRoot: string
  path: string
  /** 去掉 BOM、换行统一为 LF 的正文。 */
  content: string
  /** 磁盘上的编码（含 BOM）；保存时按它写回。 */
  encoding: WorkbenchTextEncoding
  /** 磁盘上占多数的换行符；编辑器里是 LF，保存时换回它。 */
  eol: WorkbenchTextEol
  /** 磁盘字节不能按 encoding + eol 逐字节写回的原因；有值时只读，用户明确转换后才能改。 */
  textIssue?: WorkbenchTextIssue
  size: number
  modifiedAt: number
  totalLines: number
  truncated: boolean
  /** Git 排除内容只用于查看，避免生成物与依赖目录被编辑器写回。 */
  gitIgnored?: boolean
  /** 二进制图片通过独立只读通道返回，不进入文本编辑、索引或保存链路。 */
  imagePreview?: WorkbenchImagePreview
}

export interface WorkbenchReadImageFileResult extends WorkbenchReadFileResult {
  imagePreview: WorkbenchImagePreview
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
  documentation?: string
  /** Optional compiler-owned business context for language-native structure views. */
  context?: string
  type?: string
  exported?: boolean
  mutable?: boolean
  line?: number
  column?: number
}

export interface WorkbenchCodeGraphEdge {
  id?: string
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

export type WorkbenchLanguageServiceStatus = 'ready' | 'unsupported'

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
  | 'semantic-tokens'
  | 'code-actions'

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

export interface WorkbenchLanguageServiceExtensionRequest
  extends WorkbenchLanguageServiceRequest {
  /** Contribution-owned id declared by the selected language service. */
  requestId: string
  /** JSON-compatible request fields; textDocument/version remain host-owned. */
  parameters?: Record<string, unknown>
}

export interface WorkbenchLanguageServiceExtensionResult {
  projectRoot: string
  path: string
  requestId: string
  result: unknown
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
  installKind: 'builtin'
  runtime:
    | 'typescript-language-service'
    | 'html-language-service'
    | 'css-language-service'
    | 'markdown-language-service'
    | 'python-language-server'
    | 'lsp-server'
  packageName?: string
  command?: string
  args?: string[]
  documentLanguageId?: string
  protocol?: {
    capabilityPath: string[]
    version: number
  }
  extensionRequests?: Array<{
    id: string
    method: string
    capabilityPath: string[]
  }>
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
  /**
   * 接受后被替换掉的范围（按请求时的正文算）：可选链补全要换掉前面的 `.`，`import` 语句补全要换掉整句开头。
   * 省略时替换光标前正在输入的那个词。
   */
  range?: WorkbenchLanguageServiceRange
  sortText?: string
  filterText?: string
  /** `insertText` 是片段语法（`$1`、`${2:默认}`、`$0`）。 */
  isSnippet?: boolean
  /** 同时要做的别处改动（外部语言服务器的自动导入），按请求时的正文算。 */
  additionalTextEdits?: WorkbenchLanguageServiceCompletionTextEdit[]
  /** 接受时还要再问语言服务才知道的改动（TypeScript 的自动导入）：原样交回 resolve。 */
  resolve?: WorkbenchLanguageServiceCompletionResolveData
  /** 接受后接着再弹一次补全（CSS 属性名补完，接着给属性值）。 */
  retrigger?: boolean
}

export interface WorkbenchLanguageServiceCompletionResolveData {
  name: string
  source?: string
  /** 语言服务给这一项的原始数据（TypeScript 的 CompletionEntryData），可 JSON 序列化。 */
  data?: Record<string, unknown>
}

export interface WorkbenchLanguageServiceCompletionResult {
  projectRoot: string
  path: string
  items: WorkbenchLanguageServiceCompletionItem[]
  /** 列表不完整（服务端按已输入的前缀截过）：继续输入要重新请求，不能只在这份里筛。 */
  isIncomplete?: boolean
}

/** 补全项接受前后的细节：位置与正文取发起补全时的那一份。 */
export interface WorkbenchLanguageServiceCompletionResolveRequest
  extends WorkbenchLanguageServicePositionRequest {
  item: WorkbenchLanguageServiceCompletionResolveData
}

export interface WorkbenchLanguageServiceCompletionResolveResult {
  projectRoot: string
  path: string
  /** 按发起补全时的正文算的附加改动（自动导入语句）。 */
  additionalTextEdits: WorkbenchLanguageServiceCompletionTextEdit[]
  documentation?: string
}

export interface WorkbenchLanguageServiceDiagnostic {
  path: string
  severity: 'error' | 'warning' | 'info'
  message: string
  source?: string
  /** 语言原生诊断码，例如 TypeScript 6133 或 Velar VEL5016。 */
  code?: number | string
  /** 标识该诊断范围引用了已弃用的声明。 */
  deprecated?: boolean
  range: WorkbenchLanguageServiceRange
}

export interface WorkbenchLanguageServiceDiagnosticsResult {
  projectRoot: string
  path: string
  diagnostics: WorkbenchLanguageServiceDiagnostic[]
}

/**
 * 整个 TypeScript 项目的问题（像 `tsc --noEmit -p` 那样把项目里每个文件都查一遍），分批查：一批只占 worker
 * 一小段时间，中间让补全、悬浮这些交互请求先走。
 */
export interface WorkbenchLanguageServiceProjectDiagnosticsRequest {
  projectRoot: string
  /** 决定查哪些 tsconfig 项目：打开着的 TypeScript 文件，当前文件在前。 */
  anchorPaths: string[]
  /** 上一批给出的接续位置；省略时从头查。 */
  cursor?: string
  openFiles?: WorkbenchLanguageServiceOpenFile[]
}

export interface WorkbenchLanguageServiceProjectDiagnosticsResult {
  projectRoot: string
  /** 这一批查过的文件，没有问题的也在内。 */
  checkedPaths: string[]
  diagnostics: WorkbenchLanguageServiceDiagnostic[]
  /** 接着查下一批时带上；null 表示整个项目查完了。 */
  cursor: Nullable<string>
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
  documentationBlocks?: readonly WorkbenchLanguageServiceHoverDocumentationBlock[]
  definitionPreview?: WorkbenchLanguageServiceHoverDocumentationBlock
  definition?: WorkbenchLanguageServiceLocation
  tags?: string[]
}

export interface WorkbenchLanguageServiceHoverDocumentationBlock {
  kind: 'paragraph' | 'code'
  text: string
  language?: string
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

export interface WorkbenchLanguageServiceSemanticToken {
  range: WorkbenchLanguageServiceRange
  type: string
  modifiers: string[]
}

export interface WorkbenchLanguageServiceSemanticTokensResult {
  projectRoot: string
  path: string
  tokens: WorkbenchLanguageServiceSemanticToken[]
}

export interface WorkbenchLanguageServiceCodeActionsRequest extends WorkbenchLanguageServiceRequest {
  range: WorkbenchLanguageServiceRange
  diagnostics: WorkbenchLanguageServiceDiagnostic[]
}

export interface WorkbenchLanguageServiceCodeAction {
  title: string
  kind?: string
  preferred?: boolean
  changes: WorkbenchLanguageServiceFileEdit[]
}

export interface WorkbenchLanguageServiceCodeActionsResult {
  projectRoot: string
  path: string
  actions: WorkbenchLanguageServiceCodeAction[]
}

export interface WorkbenchSaveFileRequest {
  projectRoot: string
  path: string
  /** 正文里的 `\r\n` / `\r` / `\n` 都按一次换行处理，写盘时换成 `eol`。 */
  content: string
  /**
   * 写回的编码与换行符。省略时沿用磁盘上现有的格式；现有字节本身不能原样写回
   * （认不出的编码、混用的换行符……）时拒绝保存，不猜。
   */
  encoding?: WorkbenchTextEncoding
  eol?: WorkbenchTextEol
  expectedModifiedAt?: number
  expectedSize?: number
  /** 本地历史快照节流窗口（ms）：距上一份不足该间隔则不新增快照。0/省略=每次都存。 */
  localHistoryMinIntervalMs?: number
}

/** Recreate an externally deleted text file from the editor's preserved buffer. */
export interface WorkbenchRestoreMissingFileRequest {
  projectRoot: string
  path: string
  content: string
  /** 文件被删前的编码与换行符；省略时按新文件处理（UTF-8、LF）。 */
  encoding?: WorkbenchTextEncoding
  eol?: WorkbenchTextEol
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

/** 把一项复制到 `parentPath` 下；`name` 省略时用原名，已被占用时自动取「名字 copy」。 */
export interface WorkbenchCopyEntryRequest {
  projectRoot: string
  path: string
  parentPath: string
  name?: string
}

export interface WorkbenchDeleteEntryRequest {
  projectRoot: string
  path: string
  recursive?: boolean
}

export interface WorkbenchInspectDeleteEntryRequest {
  projectRoot: string
  path: string
}

export interface WorkbenchInspectDeleteEntryResult {
  projectRoot: string
  path: string
  type: WorkbenchDirectoryEntry['type']
  requiresConfirmation: boolean
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
  /**
   * 应用内撤销的记录：删掉的东西都在系统废纸篓里，小的另留了一份私有副本，可以直接撤销；
   * 大的没有副本，为 null，只能去废纸篓里找回。
   */
  restoreId: Nullable<string>
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

/** 快速打开按文件名找文件用的整份文件清单（跳过规则与文件搜索相同）。 */
export interface WorkbenchListProjectFilesRequest {
  projectRoot: string
  /** 最多列多少个文件；不给按默认上限。 */
  limit?: number
}

export interface WorkbenchListProjectFilesResult {
  projectRoot: string
  /** 相对项目根、`/` 分隔；离根近的在前。 */
  files: string[]
  /** 超出上限，只列了离根近的那一部分。 */
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
  /**
   * 拆分出来的终端：从这个会话的 shell 此刻所在的目录开始（没给 `cwd` 时）。问不到、那个目录已经不在项目里，
   * 就从项目根开始。
   */
  inheritCwdFrom?: string
  /** 以一次性 shell 进程执行的命令（运行卡用，例如 `bun run dev`）；命令退出即关闭会话。 */
  initialCommand?: string
  /** 伪终端初始尺寸（字符格）；不给按 80×24，xterm 挂上后会按真实尺寸再调一次。 */
  cols?: number
  rows?: number
}

export interface WorkbenchTerminalStartResult {
  sessionId: string
  projectRoot: string
  cwd: string
  shell: string
  startedAt: number
}

/** xterm 收到的按键原样写进伪终端：回显、行编辑、Ctrl+C 都由 shell 与行规程处理。 */
export interface WorkbenchTerminalInputRequest {
  sessionId: string
  input: string
}

export interface WorkbenchTerminalResizeRequest {
  sessionId: string
  cols: number
  rows: number
}

export interface WorkbenchTerminalStopRequest {
  sessionId: string
  /** 终止信号，默认 SIGTERM。SIGINT = 往伪终端写 Ctrl+C，只打断前台程序，shell 本身活着。 */
  signal?: 'SIGINT' | 'SIGTERM'
  /** 跳过延迟 SIGKILL 兜底强杀。 */
  skipForceKill?: boolean
  /** 等进程真的退出（或强杀后再等一会儿）才返回：重新运行要等旧进程让出端口。 */
  waitForExit?: boolean
}

/** renderer 确认把一个会话的一段输出写进了 xterm（流控用）。 */
export interface WorkbenchTerminalAcknowledgeRequest {
  sessionId: string
  chars: number
}

/** 伪终端的输出：`stdout` 是 PTY 原始字节（含控制序列，直接喂 xterm），`system` 是宿主自己的提示。 */
export interface WorkbenchTerminalOutputEvent {
  sessionId: string
  stream: 'stdout' | 'system'
  chunk: string
  closed?: boolean
  exitCode?: LooseOptional<number>
  signal?: LooseOptional<string>
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
