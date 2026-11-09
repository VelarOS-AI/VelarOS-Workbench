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
  'velar' | 'reasonix' | 'codex' | 'claude' | 'cursor' | 'copilot' | 'windsurf' | 'cline' | 'roo'

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
  | 'refactor'
  | 'organize-imports'
  | 'call-hierarchy'

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

/**
 * 编辑器里这个文件实际用的缩进（用户在状态栏选的、`.editorconfig`，或按正文识别的）。要语言服务替用户写代码的
 * 请求（格式化、补全里插入的代码、快速修复）带上它，写出来的代码才按这个文件的缩进排；不带时语言服务用两格空格。
 */
export interface WorkbenchLanguageServiceEditFormat {
  /** 制表符显示多宽。 */
  tabSize: number
  /** 一级缩进几格。 */
  indentSize: number
  /** 用空格缩进；false 是制表符。 */
  insertSpaces: boolean
}

export interface WorkbenchLanguageServiceRequest {
  projectRoot: string
  path: string
  language?: string
  content?: string
  openFiles?: WorkbenchLanguageServiceOpenFile[]
  format?: WorkbenchLanguageServiceEditFormat
}

export interface WorkbenchLanguageServiceExtensionRequest extends WorkbenchLanguageServiceRequest {
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
  /** 所在那一行的文字（去掉首尾空白，太长截断）。列成列表给人看的结果（查找引用）才带。 */
  preview?: string
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
export interface WorkbenchLanguageServiceCompletionResolveRequest extends WorkbenchLanguageServicePositionRequest {
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
  | 'constructor'
  | 'enum'
  | 'enum-member'
  | 'function'
  | 'interface'
  | 'method'
  | 'module'
  | 'property'
  | 'symbol'
  | 'type'
  | 'variable'

/**
 * 文件里的一个符号。整份结果按文件里的先后排，嵌套靠 `depth` 表达：一个符号的外层是它前面最近的、`depth`
 * 少一的那个。
 */
export interface WorkbenchLanguageServiceDocumentSymbol {
  name: string
  kind: WorkbenchLanguageServiceDocumentSymbolKind
  depth: number
  /** 名字所在的位置：跳过去时光标落在这里。 */
  line: number
  column: number
  /** 整个声明（连同它的体）的范围：光标在不在这个符号里看它。 */
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
  /**
   * 编辑器里落在这段范围上的诊断，外部语言服务器按它们给修复。内置 TypeScript 不看这份：它自己按当前正文
   * 重新算范围内的诊断，编辑器里的诊断刚改完字还没刷新时也对得上。
   */
  diagnostics: WorkbenchLanguageServiceDiagnostic[]
  /** 要哪几类动作；省略时只要快速修复。 */
  categories?: WorkbenchLanguageServiceCodeActionCategory[]
}

/** 快速修复是冲着诊断去的；重构是对选中的代码（或光标处）能做的改写，没有诊断也有。 */
export type WorkbenchLanguageServiceCodeActionCategory = 'quickfix' | 'refactor'

/** 选中动作时才算改动要交回语言服务的数据。 */
export type WorkbenchLanguageServiceCodeActionResolveData =
  /** 同一类问题在整个文件里一起修；`fixId` 是 TypeScript 给这类修复的标识。 */
  | { kind: 'fix-all'; fixId: string }
  /** 一个重构：TypeScript 的重构名与其下的动作名。 */
  | { kind: 'refactor'; refactor: string; action: string }

/** 要新建的文件（整份内容），项目内相对路径。 */
export interface WorkbenchLanguageServiceNewFile {
  path: string
  content: string
}

export interface WorkbenchLanguageServiceCodeAction {
  title: string
  /** 细分的种类：`quickfix`，或重构的 `refactor.extract.function`、`refactor.move.newFile`…… */
  kind?: string
  /** 省略按快速修复算。 */
  category?: WorkbenchLanguageServiceCodeActionCategory
  preferred?: boolean
  /** 直接可用的改动；选中时才算的（带 `resolve`）为空。 */
  changes: WorkbenchLanguageServiceFileEdit[]
  /** 连带要新建的文件。 */
  createFiles?: WorkbenchLanguageServiceNewFile[]
  resolve?: WorkbenchLanguageServiceCodeActionResolveData
}

export interface WorkbenchLanguageServiceCodeActionsResult {
  projectRoot: string
  path: string
  actions: WorkbenchLanguageServiceCodeAction[]
}

/** 选中了一个带 `resolve` 的动作：按发起时的正文与范围算出它的改动。 */
export interface WorkbenchLanguageServiceCodeActionResolveRequest extends WorkbenchLanguageServiceRequest {
  range: WorkbenchLanguageServiceRange
  resolve: WorkbenchLanguageServiceCodeActionResolveData
}

export interface WorkbenchLanguageServiceCodeActionResolveResult {
  projectRoot: string
  path: string
  changes: WorkbenchLanguageServiceFileEdit[]
  createFiles: WorkbenchLanguageServiceNewFile[]
  /**
   * 改动套完以后可以接着改名的地方（重构抽出来的函数、常量、类型的名字），在请求文件里、按套完改动之后的
   * 正文算。
   */
  renameLocation?: WorkbenchLanguageServicePosition
}

/** 整理 import：排序、合并同一个模块的导入、去掉没用到的。只改请求的这个文件。 */
export interface WorkbenchLanguageServiceOrganizeImportsResult {
  projectRoot: string
  path: string
  changes: WorkbenchLanguageServiceFileEdit[]
}

/** 调用层次看哪个方向：谁调用它，还是它调用谁。 */
export type WorkbenchLanguageServiceCallHierarchyDirection = 'incoming' | 'outgoing'

/**
 * 某个位置上的函数的一层调用关系。界面先拿光标的位置问，再拿某个调用方（被调用方）名字的位置问它的下一层，
 * 一层一层展开。
 */
export interface WorkbenchLanguageServiceCallHierarchyRequest extends WorkbenchLanguageServicePositionRequest {
  direction: WorkbenchLanguageServiceCallHierarchyDirection
}

/** 调用层次里的一个函数（方法、构造函数、类……）。 */
export interface WorkbenchLanguageServiceCallHierarchyItem {
  name: string
  kind: WorkbenchLanguageServiceDocumentSymbolKind
  /** 它外层的名字（类、命名空间）；顶层的省略。 */
  containerName?: string
  path: string
  /** 名字的位置：跳过去落在这里，问它的下一层也拿这个位置。 */
  line: number
  column: number
}

export interface WorkbenchLanguageServiceCallHierarchyCall {
  /** 调用方（`incoming`）或被调用方（`outgoing`）。 */
  item: WorkbenchLanguageServiceCallHierarchyItem
  /**
   * 调用发生的地方，各带那一行的文字。`incoming` 时在调用方的文件里，`outgoing` 时在被问的那个函数的文件里。
   */
  sites: WorkbenchLanguageServiceLocation[]
}

export interface WorkbenchLanguageServiceCallHierarchyResult {
  projectRoot: string
  path: string
  /** 那个位置上的函数（停在调用处时是被调用的那个声明）；不在可以看调用层次的东西上为 null。 */
  item: Nullable<WorkbenchLanguageServiceCallHierarchyItem>
  calls: WorkbenchLanguageServiceCallHierarchyCall[]
}

/** 文件树里改了名、挪了位置的一项（文件或目录），项目内相对路径。 */
export interface WorkbenchLanguageServiceFileRename {
  previousPath: string
  path: string
}

/**
 * 文件或目录改名、移动之后，引用它们的 import 该怎么改。请求发出时磁盘上已经是新位置；`openFiles` 是开着的
 * JavaScript / TypeScript 标签与编辑缓冲里的正文，改动按它算（最后也是套在缓冲上）。只有 JavaScript / TypeScript
 * 文件（与含有它们的目录）会有改动。
 */
export interface WorkbenchLanguageServiceFileRenameEditsRequest {
  projectRoot: string
  renames: WorkbenchLanguageServiceFileRename[]
  openFiles?: WorkbenchLanguageServiceOpenFile[]
}

export interface WorkbenchLanguageServiceFileRenameEditsResult {
  projectRoot: string
  changes: WorkbenchLanguageServiceFileEdit[]
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

/**
 * 内容搜索里的一处匹配。行列从 1 起，列按 UTF-16 码元算（与编辑器一致）；end 是匹配末尾之后那个位置。
 */
export interface WorkbenchContentSearchMatchResult {
  line: number
  column: number
  endLine: number
  endColumn: number
  /** 匹配所在的那一行：去掉缩进，太长时只留匹配附近一段，截掉的地方是 `...`。 */
  excerpt: string
  /** 匹配在 excerpt 里的位置 [start, end)；跨行的匹配截到这一行末尾。 */
  excerptMatchStart: number
  excerptMatchEnd: number
}

/** 一个文件里的匹配。 */
export interface WorkbenchContentSearchFileResult {
  path: string
  /** 搜索时磁盘上的版本：替换前核对文件在这之后没被改过。 */
  modifiedAt: number
  size: number
  /** 文件里的匹配总数；到了列出的上限时 `matches` 比它少。 */
  matchCount: number
  matches: WorkbenchContentSearchMatchResult[]
}

/**
 * 搜项目里文件的内容。Git 仓库按 .gitignore 列文件，其它工程逐目录遍历（跳过内部目录、依赖目录、
 * 根目录下的构建产物与点号开头的目录）；二进制文件与太大的文件不搜。开关与匹配规则见
 * `@shared/workbenchTextSearch`，包含 / 排除的写法见 `@shared/workbenchSearchGlob`。
 */
export interface WorkbenchSearchContentRequest {
  projectRoot: string
  query: string
  matchCase?: boolean
  wholeWord?: boolean
  regex?: boolean
  /** 只搜这些文件：逗号分隔的模式。 */
  include?: string
  /** 不搜这些文件：逗号分隔的模式。 */
  exclude?: string
  /** 只搜这几个文件（工程相对路径），不列整个工程：替换之后刷新这几个文件的结果。 */
  paths?: string[]
  /**
   * 调用方编辑器里开着的文件：以编辑器里的正文为准（可能有没保存的改动），由调用方自己搜；这里不出它们的
   * 结果，只报其中哪些落在搜索范围里（`openPathsInScope`）。用正则搜时，报之前先在磁盘上的版本上试跑过：
   * 正则在某个文件上跑不完，搜索以超时结束，调用方不会收到那个路径。
   */
  openPaths?: string[]
  /** 最多列出多少处匹配，默认 5000。 */
  limit?: number
  /** 每个文件最多列出几处，不给就不限。 */
  maxResultsPerFile?: number
  /** 给了就边搜边推送结果（`searchContentProgress`），也能按它取消（`cancelSearchContent`）。 */
  searchId?: string
}

/** 一批搜索结果。 */
export interface WorkbenchSearchContentBatch {
  /** 这一批搜到的文件，按路径排好。 */
  files: WorkbenchContentSearchFileResult[]
  /** 这一批确认落在搜索范围里的开着的文件（见 `openPaths`）。 */
  openPathsInScope: string[]
}

export interface WorkbenchSearchContentProgressEvent extends WorkbenchSearchContentBatch {
  searchId: string
}

/** 搜索结束。推送过的批次不再重复：`files` 与 `openPathsInScope` 只有最后还没推送的那一批。 */
export interface WorkbenchSearchContentResult extends WorkbenchSearchContentBatch {
  projectRoot: string
  query: string
  /** 列到上限就停了：还有文件没搜，或者最后一个文件没列全。 */
  truncated: boolean
  /** 太大、没有搜的文件数。 */
  skippedLargeFileCount: number
  /** 搜到一半被取消了。 */
  cancelled: boolean
}

export interface WorkbenchCancelSearchContentRequest {
  searchId: string
}

/** 要替换的一个文件（没在编辑器里开着的：开着的由编辑器在自己的正文里换，能撤销）。 */
export interface WorkbenchReplaceContentFileRequest {
  path: string
  /** 搜索时磁盘上的版本（见 WorkbenchContentSearchFileResult）：之后被改过就不换，结果已经过期了。 */
  expectedModifiedAt: number
  expectedSize: number
  /** 只换这几处（按匹配的起止行列认）；不给就换这个文件里的全部匹配。 */
  matches?: Array<{ line: number; column: number; endLine: number; endColumn: number }>
}

/**
 * 按内容搜索的查找词与开关，把文件里的匹配换掉。每个文件重新读盘、重新找匹配，经保存管线写回：编码、
 * BOM 与换行符照磁盘上的来，替换前后的内容都记进本地历史。
 */
export interface WorkbenchReplaceContentRequest {
  projectRoot: string
  query: string
  matchCase?: boolean
  wholeWord?: boolean
  regex?: boolean
  replacement: string
  files: WorkbenchReplaceContentFileRequest[]
}

export interface WorkbenchReplaceContentFileResult {
  path: string
  replacedCount: number
  /** 没换成的原因（文件在搜索之后被改过、编码写不出替换进去的字符……）；这个文件没有动。 */
  error?: { message: string; code?: string }
}

export interface WorkbenchReplaceContentResult {
  projectRoot: string
  files: WorkbenchReplaceContentFileResult[]
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

/** 生成参数逐项传递；用户填写的 Node 参数仍是完整 shell 原文，两种含义必须明确区分。 */
export type WorkbenchNodeArguments =
  | { argv: string[]; args?: never }
  | { args: string; argv?: never }

export type WorkbenchNodeScriptTarget = {
  kind: 'node-script'
  /** 相对项目根的脚本路径；工作目录另由请求声明。 */
  script: string
} & WorkbenchNodeArguments

export type WorkbenchNodePackageBinTarget = {
  kind: 'node-package-bin'
  packageName: string
  binName?: string
} & WorkbenchNodeArguments

export interface WorkbenchPackageManagerTarget {
  kind: 'package-manager'
  /** 保留实际选择的入口，包括 bunx/npx；argv 显式包含 run/exec 及安装策略参数。 */
  program: 'bun' | 'bunx' | 'npm' | 'npx' | 'pnpm' | 'yarn'
  argv: string[]
}

export type WorkbenchProcessTarget =
  | WorkbenchNodeScriptTarget
  | WorkbenchNodePackageBinTarget
  | WorkbenchPackageManagerTarget
  | { kind: 'python-script'; script: string; argv: string[] }

export interface WorkbenchTerminalStartRequest {
  projectRoot: string
  cwd?: string
  /** 以一次性 shell 进程执行的命令（运行卡用，例如 `bun run dev`）；命令退出即关闭会话。 */
  initialCommand?: string
  /** 明确的程序目标；与 initialCommand 互斥。生成参数不经过 shell 字符串重建。 */
  initialProcess?: WorkbenchProcessTarget
  /**
   * 额外的环境变量（运行配置里写的）：盖在终端环境之上，同名的以这里为准。名字与值的规则见
   * `workbenchRunEnvironment.ts`；不合规的整份请求按无效处理。
   */
  env?: Record<string, string>
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
  /** 等进程真的退出（或强杀后再等一会儿）才返回：重新运行要等旧进程让出端口。 */
  waitForExit?: boolean
}

/** 问一个终端会话的 shell 此刻在哪个目录（终端里的相对路径按它解析）。 */
export interface WorkbenchTerminalCwdRequest {
  sessionId: string
}

export interface WorkbenchTerminalCwdResult {
  /** 绝对路径；问不到（Windows、会话已结束）为 null。 */
  cwd: Nullable<string>
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
