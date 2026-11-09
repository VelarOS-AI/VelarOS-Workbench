import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { URI } from 'vscode-uri'

import { Log, optionalWhen } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'

import type { WorkbenchLanguageServiceDescriptor } from '@shared/workbenchLanguageServices'

import { workbenchMainText } from '../../i18n/workbenchMainMessages'
import { isPathInsideRoot } from '../PathContainmentHelper'

import {
  type ExternalLspExit,
  type ExternalLspLauncher,
  type ExternalLspLauncherGroup,
  type ExternalLspTransport,
  withinLspDeadline,
} from './ExternalLspTransport'

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

interface LspPosition {
  line: number
  character: number
}

interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface ExternalLspLocation {
  uri: string
  range: LspRange
}

interface ExternalLspLocationLink {
  targetUri: string
  targetRange: LspRange
  targetSelectionRange?: LspRange
}

export interface ExternalLspDiagnostic {
  range: LspRange
  severity?: number
  code?: number | string
  source?: string
  message: string
}

export interface ExternalLspCompletionItem {
  label: string
  kind?: number
  detail?: string
  labelDetails?: { detail?: string; description?: string }
  documentation?: unknown
  insertText?: string
  insertTextFormat?: number
  sortText?: string
  filterText?: string
  /** `range` 是普通替换；声明了插入 / 替换支持的服务器会给 `insert` 与 `replace`。 */
  textEdit?: { newText: string; range?: LspRange; insert?: LspRange; replace?: LspRange }
  additionalTextEdits?: Array<{ range: LspRange; newText: string }>
  command?: { command?: string }
}

export interface ExternalLspCompletionList {
  items: ExternalLspCompletionItem[]
  /** 服务器按前缀截过的列表：继续输入要重新请求。 */
  isIncomplete: boolean
}

export interface ExternalLspHover {
  contents: unknown
  range?: LspRange
}

export interface ExternalLspTextEdit {
  range: LspRange
  newText: string
}

export interface ExternalLspWorkspaceEdit {
  changes?: Record<string, ExternalLspTextEdit[]>
  documentChanges?: Array<{
    textDocument?: { uri?: string }
    edits?: ExternalLspTextEdit[]
  }>
}

export interface ExternalLspDocumentSymbol {
  name: string
  kind: number
  range: LspRange
  selectionRange?: LspRange
  children?: ExternalLspDocumentSymbol[]
}

export interface ExternalLspSymbolInformation {
  name: string
  kind: number
  location: ExternalLspLocation
}

export interface ExternalLspSignatureHelp {
  activeSignature?: number
  activeParameter?: number
  signatures: Array<{
    label: string
    documentation?: unknown
    parameters?: Array<{ label: string | [number, number]; documentation?: unknown }>
  }>
}

export interface ExternalLspInlayHint {
  position: LspPosition
  label: string | Array<{ value: string }>
  kind?: number
  paddingLeft?: boolean
  paddingRight?: boolean
}

export interface ExternalLspDocumentHighlight {
  range: LspRange
  kind?: number
}

export interface ExternalLspSemanticTokens {
  data: number[]
  tokenTypes: string[]
  tokenModifiers: string[]
}

export interface ExternalLspCodeAction {
  title: string
  kind?: string
  isPreferred?: boolean
  edit?: ExternalLspWorkspaceEdit
}

interface OpenDocument {
  content: string
  languageId: string
  version: number
}

const GracefulLspExitTimeoutMs = 500

interface DiagnosticSnapshot {
  version: number
  diagnostics: ExternalLspDiagnostic[]
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

interface DiagnosticWaiter {
  version: number
  resolve: (diagnostics: ExternalLspDiagnostic[]) => void
}

interface InitializeResult {
  capabilities?: Record<string, unknown>
  serverInfo?: { name?: string; version?: string }
}

interface ExternalLspLaunch {
  command: string
  args: string[]
  electronRunAsNode: boolean
  unavailableMessage?: string
}

const DiagnosticWaitTimeoutMs = 4_000
const DefaultRequestTimeoutMs = 15_000
const MaxLspHeaderBytes = 8 * 1024
const MaxLspMessageBytes = 16 * 1024 * 1024
const LspHeaderSeparator = '\r\n\r\n'
const LspHeaderSeparatorBytes = 4
const JsonRpcMethodNotFound = -32_601
const SupportedSemanticTokenTypes = [
  'namespace',
  'type',
  'class',
  'enum',
  'interface',
  'struct',
  'typeParameter',
  'parameter',
  'variable',
  'property',
  'enumMember',
  'event',
  'function',
  'method',
  'macro',
  'keyword',
  'modifier',
  'comment',
  'string',
  'number',
  'regexp',
  'operator',
  'decorator',
]
const SupportedSemanticTokenModifiers = [
  'declaration',
  'definition',
  'readonly',
  'static',
  'deprecated',
  'abstract',
  'async',
  'modification',
  'documentation',
  'defaultLibrary',
  'frameworkDefinition',
]
const ExternalLspDependencyFileNames = [
  'velar.json',
  'package.json',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  join('node_modules', '.package-lock.json'),
] as const
const require = createRequire(import.meta.url)

function canonicalPath(path: string): string {
  const absolutePath = resolve(path)
  let existingPath = absolutePath
  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath)
    if (parent === existingPath) return absolutePath
    existingPath = parent
  }
  return resolve(realpathSync(existingPath), relative(existingPath, absolutePath))
}

function isExistingPathInside(root: string, candidate: string): boolean {
  try {
    return isPathInsideRoot(canonicalPath(root), realpathSync(candidate))
  } catch {
    return false
  }
}

function ancestorDirectories(start: string, boundary?: string): string[] {
  const first = canonicalPath(start)
  const limit = boundary ? canonicalPath(boundary) : null
  if (limit && !isPathInsideRoot(limit, first)) return []

  const directories: string[] = []
  let current = first
  while (true) {
    directories.push(current)
    if (current === limit) break
    const parent = dirname(current)
    if (parent === current || (limit && !isPathInsideRoot(limit, parent))) break
    current = parent
  }
  return directories
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    const object = objectValue(current)
    if (!object) return undefined
    current = object[segment]
  }
  return current
}

function protocolVersionFromInitialize(
  result: InitializeResult,
  capabilityPath: readonly string[]
): number | null {
  const version = valueAtPath(result, capabilityPath)
  return typeof version === 'number' ? version : null
}

function nodeBinDirectories(runtimeRoot: string, workspaceRoot?: string): string[] {
  return ancestorDirectories(runtimeRoot, workspaceRoot).map((directory) =>
    join(directory, 'node_modules', '.bin')
  )
}

function executablePath(
  runtimeRoot: string,
  command: string,
  workspaceRoot?: string
): { command: string; rejectedProjectPath?: string } {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) return { command }
  const executable = process.platform === 'win32' ? `${command}.cmd` : command
  for (const directory of nodeBinDirectories(runtimeRoot, workspaceRoot)) {
    const candidate = join(directory, executable)
    if (!existsSync(candidate)) continue
    if (!workspaceRoot || isExistingPathInside(workspaceRoot, candidate))
      return { command: realpathSync(candidate) }
    return { command, rejectedProjectPath: candidate }
  }
  return { command }
}

function projectNodePackageBinPath(
  runtimeRoot: string,
  packageName: string,
  binName: string,
  workspaceRoot?: string
): string | null {
  for (const current of ancestorDirectories(runtimeRoot, workspaceRoot)) {
    const manifestPath = join(current, 'node_modules', packageName, 'package.json')
    if (existsSync(manifestPath)) {
      if (workspaceRoot && !isExistingPathInside(workspaceRoot, manifestPath)) return null
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
          bin?: string | Record<string, string>
        }
        const relativeBin =
          typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName]
        if (!relativeBin) return null

        const entry = join(dirname(manifestPath), relativeBin)
        if (!existsSync(entry)) return null
        const canonicalEntry = realpathSync(entry)
        return !workspaceRoot || isPathInsideRoot(canonicalPath(workspaceRoot), canonicalEntry)
          ? canonicalEntry
          : null
      } catch {
        return null
      }
    }
  }
  return null
}

function extendPath(runtimeRoot: string, workspaceRoot?: string): string {
  const current = process.env['PATH'] ?? ''
  return [
    ...nodeBinDirectories(runtimeRoot, workspaceRoot),
    ...(current ? current.split(delimiter) : []),
  ]
    .filter(
      (directory, index, directories) => directory && directories.indexOf(directory) === index
    )
    .join(delimiter)
}

function executableExists(command: string, pathValue: string): boolean {
  if (!command) return false
  if (isAbsolute(command) || command.includes('/') || command.includes('\\'))
    return existsSync(command)

  const extensions =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';')
      : ['']
  return pathValue
    .split(delimiter)
    .some((directory) =>
      extensions.some((extension) => existsSync(join(directory, `${command}${extension}`)))
    )
}

function resolvedExecutablePath(command: string, pathValue: string): string {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) return command
  const extensions =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';')
      : ['']
  for (const directory of pathValue.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return command
}

function fileIdentity(path: string): string {
  try {
    const canonical = realpathSync(path)
    const value = statSync(canonical)
    return `${path}:${canonical}:${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}`
  } catch {
    return `${path}:missing`
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function hasLocalProjectToolchain(
  directory: string,
  descriptor: WorkbenchLanguageServiceDescriptor,
  workspaceRoot: string
): boolean {
  if (!descriptor.projectNodePackageBin) return false
  const executable =
    process.platform === 'win32'
      ? `${descriptor.projectNodePackageBin}.cmd`
      : descriptor.projectNodePackageBin
  const executableCandidate = join(directory, 'node_modules', '.bin', executable)
  if (existsSync(executableCandidate) && isExistingPathInside(workspaceRoot, executableCandidate))
    return true
  const manifestPath = descriptor.packageName
    ? join(directory, 'node_modules', descriptor.packageName, 'package.json')
    : null
  return (
    !!descriptor.packageName &&
    !!manifestPath &&
    existsSync(manifestPath) &&
    isExistingPathInside(workspaceRoot, manifestPath)
  )
}

function hasProjectRootMarker(
  directory: string,
  workspaceRoot: string,
  descriptor: WorkbenchLanguageServiceDescriptor
): boolean {
  for (const marker of descriptor.projectRootMarkers ?? []) {
    const markerPath = join(directory, marker)
    if (!existsSync(markerPath)) continue
    if (!isExistingPathInside(workspaceRoot, markerPath))
      throw new AppError(
        'PERMISSION',
        workbenchMainText('language.rootMarkerOutsideWorkspace', { server: descriptor.label })
      )
    return true
  }
  return false
}

/**
 * Resolves the runtime root owned by an external language contribution without
 * allowing its marker/toolchain search to leave the Workbench workspace.
 */
export function resolveExternalLspRuntimeRoot(
  workspaceRoot: string,
  documentPath: string,
  descriptor: WorkbenchLanguageServiceDescriptor
): string {
  const boundary = canonicalPath(workspaceRoot)
  const absoluteDocumentPath = canonicalPath(documentPath)
  if (!isPathInsideRoot(boundary, absoluteDocumentPath))
    throw new AppError('INVARIANT', `Language document escapes the workspace: ${documentPath}`)

  const start =
    absoluteDocumentPath === boundary || isDirectory(absoluteDocumentPath)
      ? absoluteDocumentPath
      : dirname(absoluteDocumentPath)
  for (const directory of ancestorDirectories(start, boundary)) {
    if (hasProjectRootMarker(directory, boundary, descriptor)) return directory
    if (hasLocalProjectToolchain(directory, descriptor, boundary)) return directory
  }
  return boundary
}

/**
 * A bounded identity for the executable plus project dependency metadata that
 * can change which compiler/extensions an external language server loads.
 * This intentionally fingerprints metadata, not dependency source trees.
 */
export function externalLspRuntimeFingerprint(
  runtimeRoot: string,
  descriptor: WorkbenchLanguageServiceDescriptor,
  workspaceRoot?: string
): string {
  const launch = launchFor(runtimeRoot, descriptor, workspaceRoot)
  const pathValue = extendPath(runtimeRoot, workspaceRoot)
  const executable = resolvedExecutablePath(launch.command, pathValue)
  const identities = [fileIdentity(executable)]
  for (const argument of launch.args) {
    if (isAbsolute(argument) || argument.includes('/') || argument.includes('\\'))
      identities.push(fileIdentity(isAbsolute(argument) ? argument : join(runtimeRoot, argument)))
  }

  const metadataNames = new Set([
    ...ExternalLspDependencyFileNames,
    ...(descriptor.projectRootMarkers ?? []),
  ])
  for (const current of ancestorDirectories(runtimeRoot, workspaceRoot)) {
    for (const name of metadataNames) identities.push(fileIdentity(join(current, name)))
  }

  return JSON.stringify({
    command: launch.command,
    args: launch.args,
    electronRunAsNode: launch.electronRunAsNode,
    identities,
  })
}

function languageIdFor(descriptor: WorkbenchLanguageServiceDescriptor): string {
  return descriptor.documentLanguageId ?? descriptor.languages[0] ?? descriptor.id
}

function launchFor(
  runtimeRoot: string,
  descriptor: WorkbenchLanguageServiceDescriptor,
  workspaceRoot?: string
): ExternalLspLaunch {
  if (descriptor.id === 'python') {
    try {
      return {
        command: process.execPath,
        args: [require.resolve('pyright/langserver.index.js'), ...(descriptor.args ?? [])],
        electronRunAsNode: !!process.versions['electron'],
      }
    } catch {
      // 开发期依赖尚未安装时，继续尝试项目本地或 PATH 中的 pyright-langserver。
    }
  }

  if (descriptor.projectNodePackageBin) {
    const packageName = descriptor.packageName
    const entry = packageName
      ? projectNodePackageBinPath(
          runtimeRoot,
          packageName,
          descriptor.projectNodePackageBin,
          workspaceRoot
        )
      : null
    if (entry)
      return {
        command: process.execPath,
        args: [entry, ...(descriptor.args ?? [])],
        electronRunAsNode: !!process.versions['electron'],
      }

    return {
      command: process.execPath,
      args: descriptor.args ?? [],
      electronRunAsNode: !!process.versions['electron'],
      unavailableMessage: packageName
        ? workbenchMainText('language.serverMissingBin', {
            server: descriptor.label,
            package: packageName,
            bin: descriptor.projectNodePackageBin ?? '',
          })
        : workbenchMainText('language.serverMissingPackageName', { server: descriptor.label }),
    }
  }

  const executable = executablePath(runtimeRoot, descriptor.command ?? '', workspaceRoot)
  return {
    command: executable.command,
    args: descriptor.args ?? [],
    electronRunAsNode: false,
    unavailableMessage: optionalWhen(
      executable.rejectedProjectPath,
      workbenchMainText('language.serverCommandOutsideWorkspace', { server: descriptor.label })
    ),
  }
}

export class ExternalLspClient {
  private process: Nullable<ExternalLspTransport> = null
  private opening: Promise<ExternalLspTransport> | null = null
  /** 已到达但尚未成帧的分段缓冲；只在跨段读取时才 concat，避免每个 chunk 全量复制。 */
  private readonly inbound: Buffer[] = []
  private inboundLength = 0
  /** 头部已解析、正在等待 body 收满时的 body 字节数；null 表示当前处于头部阶段。 */
  private pendingBodySize: Nullable<number> = null
  private nextRequestId = 1
  /** 同 URI 关闭再打开仍比旧诊断新；不为已关闭文档保留正文或版本历史表。 */
  private nextDocumentVersion = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly documents = new Map<string, OpenDocument>()
  private readonly diagnostics = new Map<string, DiagnosticSnapshot>()
  private readonly diagnosticWaiters = new Map<string, DiagnosticWaiter[]>()
  private serverCapabilities: Record<string, unknown> = {}
  private initializePromise: Nullable<Promise<void>> = null
  private processTermination: Nullable<{
    child: ExternalLspTransport
    completed: Promise<void>
  }> = null
  private stderr = ''
  private disposed = false
  private disposal: Promise<void> | null = null

  public constructor(
    private readonly launcher: ExternalLspLauncher,
    private readonly runtimeRoot: string,
    private readonly descriptor: WorkbenchLanguageServiceDescriptor,
    private readonly requestTimeoutMs = DefaultRequestTimeoutMs,
    private readonly workspaceRoot?: string
  ) {}

  public accepts(path: string): boolean {
    const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
    return this.descriptor.extensions.includes(extension)
  }

  public async synchronize(
    path: string,
    content: string
  ): Promise<{ uri: string; version: number }> {
    await this.initialize()
    const uri = pathToFileURL(path).toString()
    const current = this.documents.get(uri)
    if (!current) {
      const document = {
        content,
        languageId: languageIdFor(this.descriptor),
        version: this.nextDocumentVersion++,
      }
      this.documents.set(uri, document)
      this.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: document.languageId,
          version: document.version,
          text: content,
        },
      })
      return { uri, version: document.version }
    }

    if (current.content === content) return { uri, version: current.version }
    const next = { ...current, content, version: this.nextDocumentVersion++ }
    this.documents.set(uri, next)
    this.notify('textDocument/didChange', {
      textDocument: { uri, version: next.version },
      contentChanges: [{ text: content }],
    })
    return { uri, version: next.version }
  }

  /** 一份完整 dirty 快照撤销已经丢弃的缓冲，让服务器回到磁盘内容。 */
  public retainDocuments(paths: Iterable<string>): void {
    // 与 synchronize 使用同一个 URI producer；未落盘文件不能靠 realpath 重建身份。
    const retained = new Set([...paths].map((path) => pathToFileURL(path).toString()))
    for (const uri of this.documents.keys()) if (!retained.has(uri)) this.close(fileURLToPath(uri))
  }

  public close(path: string): void {
    const directUri = pathToFileURL(path).toString()
    const uri = this.documents.has(directUri)
      ? directUri
      : [...this.documents.keys()].find((candidate) => {
          try {
            return canonicalPath(URI.parse(candidate).fsPath) === canonicalPath(path)
          } catch {
            return false
          }
        })
    if (!uri) return
    if (!this.documents.delete(uri)) return
    this.diagnostics.delete(uri)
    for (const waiter of this.diagnosticWaiters.get(uri) ?? []) waiter.resolve([])
    this.diagnosticWaiters.delete(uri)
    if (!this.process || this.disposed) return
    try {
      this.notify('textDocument/didClose', { textDocument: { uri } })
    } catch {
      // A concurrently exiting server is already losing all document state.
    }
  }

  public async requestExtension(
    path: string,
    content: string,
    requestId: string,
    parameters: Readonly<Record<string, unknown>> = {},
    preserveExistingDocument = false
  ): Promise<unknown> {
    const declaration = this.descriptor.extensionRequests?.find(
      (candidate) => candidate.id === requestId
    )
    if (!declaration) {
      throw new AppError(
        'INVARIANT',
        workbenchMainText('language.extensionRequestUndeclared', {
          server: this.descriptor.label,
          request: requestId,
        })
      )
    }
    await this.initialize()
    const uri = pathToFileURL(path).toString()
    const current = preserveExistingDocument ? this.documents.get(uri) : undefined
    const document = current
      ? { uri, version: current.version }
      : await this.synchronize(path, content)
    const capability = valueAtPath(this.serverCapabilities, declaration.capabilityPath)
    if (capability !== true && !objectValue(capability)) {
      throw new AppError(
        'INVARIANT',
        workbenchMainText('language.extensionRequestUnsupported', {
          server: this.descriptor.label,
          request: requestId,
        })
      )
    }
    return this.request(declaration.method, {
      ...parameters,
      textDocument: { uri: document.uri },
      version: document.version,
    })
  }

  /** Forwards the Workbench project watcher into the already-running LSP session. */
  public async filesChanged(paths: readonly string[]): Promise<void> {
    if (!this.initializePromise || paths.length === 0) return
    await this.initialize()
    this.notify('workspace/didChangeWatchedFiles', {
      changes: paths.map((path) => ({ uri: pathToFileURL(path).toString(), type: 2 })),
    })
  }

  public async completion(
    path: string,
    content: string,
    position: LspPosition,
    signal?: AbortSignal
  ): Promise<ExternalLspCompletionList> {
    const document = await this.synchronize(path, content)
    const result = await this.request(
      'textDocument/completion',
      {
        textDocument: { uri: document.uri },
        position,
      },
      signal
    )
    if (Array.isArray(result))
      return { items: result as ExternalLspCompletionItem[], isIncomplete: false }
    const object = objectValue(result)
    return {
      items: Array.isArray(object?.['items'])
        ? (object['items'] as ExternalLspCompletionItem[])
        : [],
      isIncomplete: object?.['isIncomplete'] === true,
    }
  }

  public async hover(
    path: string,
    content: string,
    position: LspPosition,
    signal?: AbortSignal
  ): Promise<Nullable<ExternalLspHover>> {
    const document = await this.synchronize(path, content)
    const result = await this.request(
      'textDocument/hover',
      {
        textDocument: { uri: document.uri },
        position,
      },
      signal
    )
    return objectValue(result) as Nullable<ExternalLspHover>
  }

  public async definition(
    path: string,
    content: string,
    position: LspPosition,
    signal?: AbortSignal
  ): Promise<ExternalLspLocation[]> {
    const document = await this.synchronize(path, content)
    const result = await this.request(
      'textDocument/definition',
      {
        textDocument: { uri: document.uri },
        position,
      },
      signal
    )
    return normalizeLocations(result)
  }

  public async references(
    path: string,
    content: string,
    position: LspPosition
  ): Promise<ExternalLspLocation[]> {
    const document = await this.synchronize(path, content)
    const result = await this.request('textDocument/references', {
      textDocument: { uri: document.uri },
      position,
      context: { includeDeclaration: true },
    })
    return normalizeLocations(result)
  }

  public async documentHighlights(
    path: string,
    content: string,
    position: LspPosition,
    signal?: AbortSignal
  ): Promise<ExternalLspDocumentHighlight[]> {
    const document = await this.synchronize(path, content)
    const provider = this.serverCapabilities['documentHighlightProvider']
    if (provider !== true && !objectValue(provider)) return []
    const result = await this.request(
      'textDocument/documentHighlight',
      {
        textDocument: { uri: document.uri },
        position,
      },
      signal
    )
    return Array.isArray(result) ? (result as ExternalLspDocumentHighlight[]) : []
  }

  public async rename(
    path: string,
    content: string,
    position: LspPosition,
    newName: string
  ): Promise<ExternalLspWorkspaceEdit> {
    const document = await this.synchronize(path, content)
    const result = await this.request('textDocument/rename', {
      textDocument: { uri: document.uri },
      position,
      newName,
    })
    return (objectValue(result) as ExternalLspWorkspaceEdit) ?? {}
  }

  public async documentSymbols(
    path: string,
    content: string
  ): Promise<Array<ExternalLspDocumentSymbol | ExternalLspSymbolInformation>> {
    const document = await this.synchronize(path, content)
    const result = await this.request('textDocument/documentSymbol', {
      textDocument: { uri: document.uri },
    })
    return Array.isArray(result)
      ? (result as Array<ExternalLspDocumentSymbol | ExternalLspSymbolInformation>)
      : []
  }

  public async signatureHelp(
    path: string,
    content: string,
    position: LspPosition,
    signal?: AbortSignal
  ): Promise<Nullable<ExternalLspSignatureHelp>> {
    const document = await this.synchronize(path, content)
    const result = await this.request(
      'textDocument/signatureHelp',
      {
        textDocument: { uri: document.uri },
        position,
      },
      signal
    )
    return objectValue(result) as Nullable<ExternalLspSignatureHelp>
  }

  public async inlayHints(
    path: string,
    content: string,
    range: LspRange,
    signal?: AbortSignal
  ): Promise<ExternalLspInlayHint[]> {
    const document = await this.synchronize(path, content)
    const provider = this.serverCapabilities['inlayHintProvider']
    if (provider !== true && !objectValue(provider)) return []
    const result = await this.request(
      'textDocument/inlayHint',
      {
        textDocument: { uri: document.uri },
        range,
      },
      signal
    )
    return Array.isArray(result) ? (result as ExternalLspInlayHint[]) : []
  }

  public async semanticTokens(
    path: string,
    content: string,
    signal?: AbortSignal
  ): Promise<ExternalLspSemanticTokens> {
    const document = await this.synchronize(path, content)
    const provider = objectValue(this.serverCapabilities['semanticTokensProvider'])
    const legend = objectValue(provider?.['legend'])
    const tokenTypes = Array.isArray(legend?.['tokenTypes'])
      ? legend['tokenTypes'].filter((item): item is string => typeof item === 'string')
      : []
    const tokenModifiers = Array.isArray(legend?.['tokenModifiers'])
      ? legend['tokenModifiers'].filter((item): item is string => typeof item === 'string')
      : []
    if (!provider || tokenTypes.length === 0) return { data: [], tokenTypes, tokenModifiers }
    const result = objectValue(
      await this.request(
        'textDocument/semanticTokens/full',
        {
          textDocument: { uri: document.uri },
        },
        signal
      )
    )
    const rawData = result?.['data']
    const data =
      Array.isArray(rawData) &&
      rawData.every((item) => Number.isSafeInteger(item) && (item as number) >= 0)
        ? (rawData as number[])
        : []
    return { data, tokenTypes, tokenModifiers }
  }

  public async codeActions(
    path: string,
    content: string,
    range: LspRange,
    diagnostics: readonly ExternalLspDiagnostic[]
  ): Promise<ExternalLspCodeAction[]> {
    const document = await this.synchronize(path, content)
    const provider = this.serverCapabilities['codeActionProvider']
    if (provider !== true && !objectValue(provider)) return []
    const result = await this.request('textDocument/codeAction', {
      textDocument: { uri: document.uri },
      range,
      context: { diagnostics, only: ['quickfix'] },
    })
    return Array.isArray(result) ? (result as ExternalLspCodeAction[]) : []
  }

  public async format(path: string, content: string): Promise<ExternalLspTextEdit[]> {
    const document = await this.synchronize(path, content)
    const result = await this.request('textDocument/formatting', {
      textDocument: { uri: document.uri },
      options: { tabSize: 2, insertSpaces: true, insertFinalNewline: true },
    })
    return Array.isArray(result) ? (result as ExternalLspTextEdit[]) : []
  }

  public async getDiagnostics(path: string, content: string): Promise<ExternalLspDiagnostic[]> {
    const document = await this.synchronize(path, content)
    const current = this.diagnostics.get(document.uri)
    if (current && current.version >= document.version) return current.diagnostics

    return new Promise((resolve) => {
      const waiter = { version: document.version, resolve }
      const waiters = this.diagnosticWaiters.get(document.uri) ?? []
      waiters.push(waiter)
      this.diagnosticWaiters.set(document.uri, waiters)
      setTimeout(() => {
        const pending = this.diagnosticWaiters.get(document.uri)
        if (!pending?.includes(waiter)) return
        this.diagnosticWaiters.set(
          document.uri,
          pending.filter((item) => item !== waiter)
        )
        resolve(this.diagnostics.get(document.uri)?.diagnostics ?? [])
      }, DiagnosticWaitTimeoutMs)
    })
  }

  public dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.disposal = this.disposeProcess()
    return this.disposal
  }

  private async disposeProcess(): Promise<void> {
    const opened = await this.opening?.catch(() => null)
    const retiring = this.processTermination
    if (retiring) await retiring.completed.catch(() => undefined)
    const child = this.process ?? retiring?.child ?? opened
    if (!child) return
    if (!child.isClosed) {
      if (!child.exited && this.process === child) {
        try {
          await this.request('shutdown', null)
          this.notify('exit', null)
        } catch {
          // 握手失败仍须确认退出；保留进程所有权直到真实收束。
        }
      }
      try {
        await withinLspDeadline(child.closed, Date.now() + GracefulLspExitTimeoutMs)
      } catch {
        await child.terminate()
      }
    }
    await child.closed
    if (this.process === child) this.process = null
    if (this.processTermination === retiring) this.processTermination = null
  }

  private async initialize(): Promise<void> {
    if (this.disposed)
      throw new AppError(
        'INVARIANT',
        workbenchMainText('language.clientClosed', { server: this.descriptor.label })
      )
    if (this.initializePromise) return this.initializePromise
    const attempt = this.startAndInitialize()
    this.initializePromise = attempt
    try {
      await attempt
    } catch (error) {
      if (this.initializePromise === attempt) {
        this.initializePromise = null
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
      throw error
    }
  }

  private async startAndInitialize(): Promise<void> {
    await this.processTermination?.completed
    this.processTermination = null
    if (this.disposed)
      throw new AppError(
        'INVARIANT',
        workbenchMainText('language.clientClosed', { server: this.descriptor.label })
      )
    const command = this.descriptor.command
    if (!command)
      throw new AppError(
        'INVARIANT',
        workbenchMainText('language.serverCommandMissing', { server: this.descriptor.label })
      )

    const launch = launchFor(this.runtimeRoot, this.descriptor, this.workspaceRoot)
    const pathValue = extendPath(this.runtimeRoot, this.workspaceRoot)
    if (launch.unavailableMessage) throw new AppError('INVARIANT', launch.unavailableMessage)
    if (!launch.electronRunAsNode && !executableExists(launch.command, pathValue)) {
      const installHint = this.descriptor.packageName
        ? workbenchMainText('language.installPackageHint', { package: this.descriptor.packageName })
        : workbenchMainText('language.installToolchainHint')
      throw new AppError(
        'INVARIANT',
        workbenchMainText('language.serverNotFound', {
          server: this.descriptor.label,
          command: launch.command,
          hint: installHint,
        })
      )
    }
    // 不走 Electron 运行时时一个键也不写：继承来的 ELECTRON_RUN_AS_NODE 要原样留给子进程。
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: pathValue }
    if (launch.electronRunAsNode) env.ELECTRON_RUN_AS_NODE = '1'
    const opening = this.launcher.open({
      projectRoot: this.workspaceRoot ?? this.runtimeRoot,
      command: launch.command,
      args: launch.args,
      cwd: this.runtimeRoot,
      env,
      shell: process.platform === 'win32' && launch.command.endsWith('.cmd'),
    })
    this.opening = opening
    let child: ExternalLspTransport
    try {
      child = await opening
    } finally {
      if (this.opening === opening) this.opening = null
    }
    if (this.disposed) {
      await child.terminate()
      throw new AppError(
        'CLOSED',
        workbenchMainText('language.clientClosed', { server: this.descriptor.label })
      )
    }
    this.process = child
    child.on('failure', (error: Error) => {
      if (this.process === child) this.fail(error)
    })
    child.on('exit', ({ code, signal }: ExternalLspExit) => {
      if (this.disposed || this.process !== child) return
      this.fail(
        new AppError(
          'INTERNAL',
          workbenchMainText('language.serverExited', {
            server: this.descriptor.label,
            reason: signal ?? code ?? 'unknown',
            stderr: this.stderr ? ` ${this.stderr.trim()}` : '',
          })
        )
      )
    })
    child.accept((stream, bytes) => {
      if (stream === 'stdout')
        this.accept(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
      else this.stderr = `${this.stderr}${Buffer.from(bytes).toString('utf8')}`.slice(-4_000)
    })

    const result = (await this.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(this.runtimeRoot).toString(),
      workspaceFolders: [this.workspaceFolder()],
      capabilities: {
        // 声明什么就实现什么：既然 params 里传了 workspaceFolders，能力节就必须对齐，
        // 对应的 workspace/workspaceFolders 请求由 handleServerRequest 回复。
        workspace: { workspaceFolders: true },
        textDocument: {
          completion: {
            completionItem: {
              snippetSupport: true,
              labelDetailsSupport: true,
              documentationFormat: ['markdown', 'plaintext'],
            },
          },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { linkSupport: true },
          documentHighlight: { dynamicRegistration: false },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          inlayHint: { dynamicRegistration: false },
          semanticTokens: {
            requests: { full: true },
            tokenTypes: SupportedSemanticTokenTypes,
            tokenModifiers: SupportedSemanticTokenModifiers,
            formats: ['relative'],
          },
          codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix'] } } },
          signatureHelp: {
            signatureInformation: { documentationFormat: ['markdown', 'plaintext'] },
          },
          publishDiagnostics: { versionSupport: true },
        },
      },
    })) as InitializeResult
    this.serverCapabilities = result.capabilities ?? {}

    if (this.descriptor.protocol) {
      const actual = protocolVersionFromInitialize(result, this.descriptor.protocol.capabilityPath)
      if (actual !== this.descriptor.protocol.version)
        throw new AppError(
          'INVARIANT',
          workbenchMainText('language.protocolMismatch', {
            server: this.descriptor.label,
            expected: this.descriptor.protocol.version,
            actual: actual === null ? 'unknown' : `v${actual}`,
          })
        )
    }
    this.notify('initialized', {})
  }

  private workspaceFolder(): { uri: string; name: string } {
    return {
      uri: pathToFileURL(this.runtimeRoot).toString(),
      name: this.runtimeRoot.split(/[\\/]/u).at(-1) ?? 'project',
    }
  }

  /** `signal` 中止（请求被新请求顶掉）时告诉服务器不必再算，并立刻以取消结束。 */
  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted)
      return Promise.reject(
        new AppError(
          'CANCELLED',
          workbenchMainText('language.requestCancelled', { server: this.descriptor.label, method })
        )
      )
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const abandon = (error: AppError): void => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        clearTimeout(pending.timeout)
        try {
          this.notify('$/cancelRequest', { id })
        } catch {
          /* the request still rejects */
        }
        pending.reject(error)
      }
      const onAbort = (): void =>
        abandon(
          new AppError(
            'CANCELLED',
            workbenchMainText('language.requestCancelled', {
              server: this.descriptor.label,
              method,
            })
          )
        )
      const timeout = setTimeout(
        () =>
          abandon(
            new AppError(
              'INTERNAL',
              workbenchMainText('language.requestTimedOut', {
                server: this.descriptor.label,
                method,
              })
            )
          ),
        Math.max(1, this.requestTimeoutMs)
      )
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
        timeout,
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        const pending = this.pending.get(id)
        if (pending) clearTimeout(pending.timeout)
        this.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  private send(message: JsonRpcMessage): void {
    const child = this.process
    if (!child || child.isClosed)
      throw new AppError(
        'INTERNAL',
        workbenchMainText('language.serverNotRunning', { server: this.descriptor.label })
      )
    const json = JSON.stringify(message)
    const size = Buffer.byteLength(json, 'utf8')
    if (size > MaxLspMessageBytes)
      throw new AppError(
        'INVARIANT',
        workbenchMainText('language.messageTooLarge', { server: this.descriptor.label })
      )
    void child
      .write(new TextEncoder().encode(`Content-Length: ${size}\r\n\r\n${json}`))
      .catch((error: unknown) => {
        if (this.process === child) this.fail(AppError.from(error))
      })
  }

  /**
   * 增量帧解析：分段保存到达的 chunk，只在跨段读取时才 concat，头部扫描也限制在
   * 8 KiB 的头部窗口内。原来"每个 chunk 全量 concat + 从偏移 0 重扫分隔符"的写法，
   * 在一条 16 MiB 的消息上是 O(n²)，会在 Electron 主进程里搬运 GB 级内存。
   */
  private accept(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.inbound.push(chunk)
    this.inboundLength += chunk.length

    while (true) {
      if (this.pendingBodySize === null && !this.readFrameHeader()) return
      const size = this.pendingBodySize
      if (size === null || this.inboundLength < size) return
      const body = this.readInbound(size).toString('utf8')
      this.consumeInbound(size)
      this.pendingBodySize = null

      let message: JsonRpcMessage
      try {
        message = JSON.parse(body) as JsonRpcMessage
      } catch {
        this.fail(
          new AppError(
            'INTERNAL',
            workbenchMainText('language.invalidJson', { server: this.descriptor.label })
          )
        )
        return
      }
      this.handle(message)
    }
  }

  /** 解析一帧头部；返回 false 表示数据不足或已失败。 */
  private readFrameHeader(): boolean {
    if (this.inboundLength === 0) return false
    const headerWindow = this.readInbound(
      Math.min(this.inboundLength, MaxLspHeaderBytes + LspHeaderSeparatorBytes)
    )
    const boundary = headerWindow.indexOf(LspHeaderSeparator)
    if (boundary < 0) {
      if (this.inboundLength > MaxLspHeaderBytes)
        this.fail(
          new AppError(
            'INTERNAL',
            workbenchMainText('language.headerTooLarge', { server: this.descriptor.label })
          )
        )
      return false
    }

    const header = headerWindow.subarray(0, boundary).toString('ascii')
    const match = /(?:^|\r\n)Content-Length:\s*(\d+)/iu.exec(header)
    if (!match) {
      this.fail(
        new AppError(
          'INTERNAL',
          workbenchMainText('language.missingContentLength', { server: this.descriptor.label })
        )
      )
      return false
    }
    const size = Number(match[1])
    if (!Number.isSafeInteger(size) || size > MaxLspMessageBytes) {
      this.fail(
        new AppError(
          'INTERNAL',
          workbenchMainText('language.responseTooLarge', { server: this.descriptor.label })
        )
      )
      return false
    }
    this.consumeInbound(boundary + LspHeaderSeparatorBytes)
    this.pendingBodySize = size
    return true
  }

  /** 读取分段缓冲前 size 个字节；调用方保证 `inboundLength >= size`。 */
  private readInbound(size: number): Buffer {
    const first = this.inbound[0]
    if (first && first.length >= size) return first.subarray(0, size)

    const parts: Buffer[] = []
    let remaining = size
    for (const chunk of this.inbound) {
      if (remaining === 0) break
      const take = Math.min(chunk.length, remaining)
      parts.push(take === chunk.length ? chunk : chunk.subarray(0, take))
      remaining -= take
    }
    return Buffer.concat(parts, size)
  }

  private consumeInbound(size: number): void {
    let remaining = size
    while (remaining > 0) {
      const first = this.inbound[0]
      if (!first) break
      if (first.length > remaining) {
        this.inbound[0] = first.subarray(remaining)
        break
      }
      this.inbound.shift()
      remaining -= first.length
    }
    this.inboundLength -= size
  }

  /**
   * JSON-RPC 的分派判据是**有没有 method 字段**，不是有没有 id：服务端主动发来的请求
   * （workspace/configuration、client/registerCapability 等）同样带 id。按 id 优先分派会把
   * 服务端请求当成对客户端请求的回复——撞上 id 就用错误的值 resolve 掉自己的 Promise，
   * 撞不上就静默丢弃、让对端一直等。
   */
  private handle(message: JsonRpcMessage): void {
    if (typeof message.method !== 'string') {
      this.handleResponse(message)
      return
    }
    if (message.id === undefined || message.id === null) {
      this.handleNotification(message.method, message.params)
      return
    }
    this.handleServerRequest(message.id, message.method, message.params)
  }

  private handleResponse(message: JsonRpcMessage): void {
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timeout)
    if (message.error)
      pending.reject(
        new AppError(
          'INTERNAL',
          `${this.descriptor.label}: ${message.error.message ?? workbenchMainText('language.requestFailed')}`
        )
      )
    else pending.resolve(message.result)
  }

  /**
   * 服务端请求必须回复，哪怕是拒绝：沉默会让对端一直等（阻塞式的 workspace/configuration
   * 会直接挂住初始化），而 MethodNotFound 是规格允许、对端知道怎么处理的答案。
   */
  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    const handled = this.serverRequestResult(method, params)
    try {
      this.send(
        handled
          ? { jsonrpc: '2.0', id, result: handled.result }
          : {
              jsonrpc: '2.0',
              id,
              error: { code: JsonRpcMethodNotFound, message: `Unhandled request: ${method}` },
            }
      )
    } catch {
      // 服务器已经退出时回不了信；退出本身会由 exit 处理器报出来。
    }
  }

  private serverRequestResult(method: string, params: unknown): Nullable<{ result: unknown }> {
    switch (method) {
      case 'workspace/configuration': {
        // 宿主没有按 scope 的配置可给，逐项回 null 表示"用服务器默认值"。
        const items = objectValue(params)?.['items']
        return { result: (Array.isArray(items) ? items : []).map(() => null) }
      }
      case 'workspace/workspaceFolders':
        return { result: [this.workspaceFolder()] }
      case 'client/registerCapability':
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create':
        return { result: null }
      case 'window/showMessageRequest':
        // 宿主没有承接该请求的弹窗，回 null 表示用户没有选择任何一项。
        return { result: null }
      default:
        return null
    }
  }

  private handleNotification(method: string, rawParams: unknown): void {
    if (method !== 'textDocument/publishDiagnostics') return
    const params = objectValue(rawParams)
    const receivedUri = typeof params?.['uri'] === 'string' ? params['uri'] : null
    if (!receivedUri) return
    const uri = this.documents.has(receivedUri)
      ? receivedUri
      : ([...this.documents.keys()].find((candidate) => {
          try {
            return (
              canonicalPath(URI.parse(candidate).fsPath) ===
              canonicalPath(URI.parse(receivedUri).fsPath)
            )
          } catch {
            return false
          }
        }) ?? receivedUri)
    const openVersion = this.documents.get(uri)?.version ?? 0
    const version = typeof params?.['version'] === 'number' ? params['version'] : openVersion
    if (version < openVersion) return
    const diagnostics = Array.isArray(params?.['diagnostics'])
      ? (params['diagnostics'] as ExternalLspDiagnostic[])
      : []
    this.diagnostics.set(uri, { version, diagnostics })
    const waiters = this.diagnosticWaiters.get(uri) ?? []
    const ready = waiters.filter((waiter) => version >= waiter.version)
    this.diagnosticWaiters.set(
      uri,
      waiters.filter((waiter) => version < waiter.version)
    )
    for (const waiter of ready) waiter.resolve(diagnostics)
  }

  private fail(error: Error): void {
    const child = this.process
    this.process = null
    this.initializePromise = null
    this.serverCapabilities = {}
    this.documents.clear()
    this.diagnostics.clear()
    this.inbound.length = 0
    this.inboundLength = 0
    this.pendingBodySize = null
    if (child) {
      const completed = child.terminate()
      this.processTermination = { child, completed }
      void completed.catch((terminationError: unknown) =>
        Log.tag('WorkbenchLanguageService').warn('external_lsp_termination_failed', {
          error: terminationError,
        })
      )
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
    for (const waiters of this.diagnosticWaiters.values())
      for (const waiter of waiters) waiter.resolve([])
    this.diagnosticWaiters.clear()
  }
}

function normalizeLocations(value: unknown): ExternalLspLocation[] {
  const values = Array.isArray(value) ? value : value ? [value] : []
  return values.flatMap((item) => {
    const object = objectValue(item)
    if (!object) return []
    if (typeof object['uri'] === 'string' && objectValue(object['range']))
      return [object as unknown as ExternalLspLocation]
    if (typeof object['targetUri'] === 'string' && objectValue(object['targetRange'])) {
      const link = object as unknown as ExternalLspLocationLink
      return [{ uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange }]
    }
    return []
  })
}

export class ExternalLspManager {
  public constructor(private readonly launcher: ExternalLspLauncherGroup) {}
  private readonly clients = new Map<
    string,
    {
      client: ExternalLspClient
      fingerprint: string
      workspaceRoot: string
      runtimeRoot: string
      descriptor: WorkbenchLanguageServiceDescriptor
    }
  >()
  private readonly refreshes = new Map<
    string,
    {
      promise: Promise<ExternalLspClient>
      workspaceRoot: string
    }
  >()
  private readonly documentOwners = new Map<
    string,
    {
      clientKey: string
      workspaceRoot: string
      documentPath: string
      descriptor: WorkbenchLanguageServiceDescriptor
    }
  >()
  private readonly clientOwners = new Map<string, Set<string>>()
  private readonly workspaceGenerations = new Map<string, number>()
  private readonly workspaceInvalidations = new Map<string, Promise<void>>()
  private disposed = false
  private disposal: Promise<void> | null = null

  public async client(
    workspaceRoot: string,
    descriptor: WorkbenchLanguageServiceDescriptor,
    documentPath = workspaceRoot
  ): Promise<ExternalLspClient> {
    const boundary = canonicalPath(workspaceRoot)
    if (this.disposed) throw new AppError('INVARIANT', workbenchMainText('language.managerClosed'))
    const generation = this.workspaceGeneration(boundary)
    await this.waitForWorkspaceInvalidation(boundary)
    this.assertClientRequestActive(boundary, generation)
    const canonicalDocumentPath = canonicalPath(documentPath)
    const runtimeRoot = resolveExternalLspRuntimeRoot(boundary, canonicalDocumentPath, descriptor)
    const key = JSON.stringify([boundary, runtimeRoot, descriptor.id])
    const ownerKey = JSON.stringify([boundary, descriptor.id, canonicalDocumentPath])
    await this.reconcileOwnership(boundary)
    this.assertClientRequestActive(boundary, generation)
    const fingerprint = externalLspRuntimeFingerprint(runtimeRoot, descriptor, boundary)
    const current = this.clients.get(key)
    if (current?.fingerprint === fingerprint) {
      await this.claimDocument(ownerKey, key, boundary, canonicalDocumentPath, descriptor)
      this.assertClientRequestActive(boundary, generation)
      return current.client
    }

    const activeRefresh = this.refreshes.get(key)
    if (activeRefresh) {
      const client = await activeRefresh.promise
      this.assertClientRequestActive(boundary, generation)
      await this.claimDocument(ownerKey, key, boundary, canonicalDocumentPath, descriptor)
      this.assertClientRequestActive(boundary, generation)
      return client
    }

    const refresh = (async (): Promise<ExternalLspClient> => {
      if (current) {
        this.clients.delete(key)
        await current.client.dispose()
      }
      this.assertClientRequestActive(boundary, generation)
      const client = new ExternalLspClient(
        this.launcher,
        runtimeRoot,
        descriptor,
        DefaultRequestTimeoutMs,
        boundary
      )
      this.clients.set(key, {
        client,
        fingerprint: externalLspRuntimeFingerprint(runtimeRoot, descriptor, boundary),
        workspaceRoot: boundary,
        runtimeRoot,
        descriptor,
      })
      return client
    })()
    this.refreshes.set(key, { promise: refresh, workspaceRoot: boundary })
    try {
      const client = await refresh
      this.assertClientRequestActive(boundary, generation)
      await this.claimDocument(ownerKey, key, boundary, canonicalDocumentPath, descriptor)
      this.assertClientRequestActive(boundary, generation)
      return client
    } finally {
      if (this.refreshes.get(key)?.promise === refresh) this.refreshes.delete(key)
    }
  }

  public async filesChanged(workspaceRoot: string, paths: readonly string[]): Promise<void> {
    await this.reconcileOwnership(canonicalPath(workspaceRoot))
    const changes = new Map<ExternalLspClient, Set<string>>()
    for (const path of paths) {
      for (const { client } of this.closestClientsForPath(workspaceRoot, path)) {
        const clientPaths = changes.get(client) ?? new Set<string>()
        clientPaths.add(path)
        changes.set(client, clientPaths)
      }
    }
    await Promise.all(
      [...changes].map(([client, clientPaths]) => client.filesChanged([...clientPaths]))
    )
  }

  public invalidate(workspaceRoot: string): Promise<void> {
    const boundary = canonicalPath(workspaceRoot)
    if (this.disposed) return this.disposal ?? Promise.resolve()
    const activeInvalidation = this.workspaceInvalidations.get(boundary)
    if (activeInvalidation) return activeInvalidation
    this.workspaceGenerations.set(boundary, this.workspaceGeneration(boundary) + 1)
    const invalidation = this.invalidateWorkspace(boundary).finally(() => {
      if (this.workspaceInvalidations.get(boundary) === invalidation)
        this.workspaceInvalidations.delete(boundary)
    })
    this.workspaceInvalidations.set(boundary, invalidation)
    return invalidation
  }

  private async invalidateWorkspace(boundary: string): Promise<void> {
    const activeRefreshes = [...this.refreshes.entries()]
      .filter(([, refresh]) => refresh.workspaceRoot === boundary)
      .map(([, refresh]) => refresh.promise)
    await Promise.allSettled(activeRefreshes)

    const entries = [...this.clients.entries()].filter(
      ([, managed]) => managed.workspaceRoot === boundary
    )
    for (const [key] of entries) this.clients.delete(key)
    for (const [ownerKey, owner] of this.documentOwners) {
      if (owner.workspaceRoot === boundary) this.documentOwners.delete(ownerKey)
    }
    for (const [key] of entries) this.clientOwners.delete(key)
    await Promise.all(entries.map(([, managed]) => managed.client.dispose()))
  }

  public dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    const disposal = this.disposeAll(Date.now() + DefaultRequestTimeoutMs)
    this.disposal = disposal
    return disposal
  }

  private async disposeAll(deadlineAt: number): Promise<void> {
    await Promise.allSettled(this.workspaceInvalidations.values())
    await Promise.allSettled([...this.refreshes.values()].map(({ promise }) => promise))
    const clients = [...this.clients.values()].map((managed) => managed.client)
    this.clients.clear()
    this.documentOwners.clear()
    this.clientOwners.clear()
    const results = await Promise.allSettled(clients.map((client) => client.dispose()))
    try {
      // client 失败也必须收束显式注入的整组；不为组关闭重新发一张 15 秒预算。
      await this.launcher.close(deadlineAt)
    } catch (reason) {
      results.push({ status: 'rejected', reason })
    }
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (failures.length) throw new AggregateError(failures, 'Language clients did not close')
  }

  private async waitForWorkspaceInvalidation(workspaceRoot: string): Promise<void> {
    while (true) {
      const invalidation = this.workspaceInvalidations.get(workspaceRoot)
      if (!invalidation) return
      await invalidation
    }
  }

  private workspaceGeneration(workspaceRoot: string): number {
    return this.workspaceGenerations.get(workspaceRoot) ?? 0
  }

  private assertClientRequestActive(workspaceRoot: string, generation: number): void {
    if (this.disposed) throw new AppError('INVARIANT', workbenchMainText('language.managerClosed'))
    if (this.workspaceGeneration(workspaceRoot) !== generation)
      throw new AppError('INVARIANT', workbenchMainText('language.workspaceGone'))
  }

  private closestClientsForPath(
    workspaceRoot: string,
    path: string
  ): Array<{ client: ExternalLspClient; runtimeRoot: string }> {
    const boundary = canonicalPath(workspaceRoot)
    const canonicalDocumentPath = canonicalPath(path)
    const closest = new Map<
      string,
      {
        client: ExternalLspClient
        runtimeRoot: string
      }
    >()
    for (const managed of this.clients.values()) {
      if (
        managed.workspaceRoot !== boundary ||
        !isPathInsideRoot(managed.runtimeRoot, canonicalDocumentPath)
      )
        continue
      if (
        resolveExternalLspRuntimeRoot(boundary, canonicalDocumentPath, managed.descriptor) !==
        managed.runtimeRoot
      )
        continue
      const current = closest.get(managed.descriptor.id)
      if (!current || managed.runtimeRoot.length > current.runtimeRoot.length)
        closest.set(managed.descriptor.id, managed)
    }
    return [...closest.values()]
  }

  private async claimDocument(
    ownerKey: string,
    clientKey: string,
    workspaceRoot: string,
    documentPath: string,
    descriptor: WorkbenchLanguageServiceDescriptor
  ): Promise<void> {
    const previous = this.documentOwners.get(ownerKey)?.clientKey
    if (previous === clientKey) return

    this.documentOwners.set(ownerKey, {
      clientKey,
      workspaceRoot,
      documentPath,
      descriptor,
    })
    const owners = this.clientOwners.get(clientKey) ?? new Set<string>()
    owners.add(ownerKey)
    this.clientOwners.set(clientKey, owners)
    if (!previous) return

    const previousOwners = this.clientOwners.get(previous)
    previousOwners?.delete(ownerKey)
    this.clients.get(previous)?.client.close(documentPath)
    if (previousOwners && previousOwners.size > 0) return
    this.clientOwners.delete(previous)
    await this.disposeClient(previous)
  }

  private async reconcileOwnership(workspaceRoot: string): Promise<void> {
    const emptyClients = new Set<string>()
    for (const [ownerKey, owner] of this.documentOwners) {
      if (owner.workspaceRoot !== workspaceRoot) continue
      let expectedClientKey: string | null = null
      try {
        const runtimeRoot = resolveExternalLspRuntimeRoot(
          workspaceRoot,
          owner.documentPath,
          owner.descriptor
        )
        expectedClientKey = JSON.stringify([workspaceRoot, runtimeRoot, owner.descriptor.id])
      } catch {
        // A path that now resolves outside the workspace loses its runtime ownership.
      }
      if (expectedClientKey === owner.clientKey) continue

      this.documentOwners.delete(ownerKey)
      const owners = this.clientOwners.get(owner.clientKey)
      owners?.delete(ownerKey)
      this.clients.get(owner.clientKey)?.client.close(owner.documentPath)
      if (!owners || owners.size === 0) {
        this.clientOwners.delete(owner.clientKey)
        emptyClients.add(owner.clientKey)
      }
    }
    await Promise.all([...emptyClients].map((key) => this.disposeClient(key)))
  }

  private async disposeClient(key: string): Promise<void> {
    // Disposal is an instance-level decision even though ownership is tracked by
    // runtime key. A fingerprint refresh temporarily removes the old instance
    // from `clients`, then installs its replacement under the same key. Never
    // let a cleanup that observed the old/absent instance dispose that replacement.
    const expectedClient = this.clients.get(key)?.client
    const refresh = this.refreshes.get(key)?.promise
    if (refresh) await Promise.allSettled([refresh])
    if ((this.clientOwners.get(key)?.size ?? 0) > 0) return
    const managed = this.clients.get(key)
    if (!managed || managed.client !== expectedClient) return
    this.clients.delete(key)
    await managed.client.dispose()
  }
}
