import { type ChildProcessWithoutNullStreams,spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

import { URI } from 'vscode-uri'

import { AppError } from '@velaros-ai/core/error'

import type {
  WorkbenchLanguageServiceDescriptor,
} from '@shared/language/workbenchLanguageServices'

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
  documentation?: unknown
  insertText?: string
  insertTextFormat?: number
  sortText?: string
  filterText?: string
  textEdit?: { range: LspRange; newText: string }
  additionalTextEdits?: Array<{ range: LspRange; newText: string }>
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

const DiagnosticWaitTimeoutMs = 4_000
const DefaultRequestTimeoutMs = 15_000
const MaxLspHeaderBytes = 8 * 1024
const MaxLspMessageBytes = 16 * 1024 * 1024
const SupportedSemanticTokenTypes = [
  'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter',
  'variable', 'property', 'enumMember', 'event', 'function', 'method', 'macro', 'keyword',
  'modifier', 'comment', 'string', 'number', 'regexp', 'operator', 'decorator',
]
const SupportedSemanticTokenModifiers = [
  'declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async',
  'modification', 'documentation', 'defaultLibrary',
]
const require = createRequire(import.meta.url)

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
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

function nodeBinDirectories(projectRoot: string): string[] {
  const directories: string[] = []
  let current = projectRoot
  while (true) {
    directories.push(join(current, 'node_modules', '.bin'))
    const parent = dirname(current)
    if (parent === current) return directories
    current = parent
  }
}

function executablePath(projectRoot: string, command: string): string {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) return command
  const executable = process.platform === 'win32' ? `${command}.cmd` : command
  const local = nodeBinDirectories(projectRoot)
    .map((directory) => join(directory, executable))
    .find((candidate) => existsSync(candidate))
  return local ?? command
}

function extendPath(projectRoot: string): string {
  const current = process.env['PATH'] ?? ''
  return [...nodeBinDirectories(projectRoot), ...(current ? current.split(delimiter) : [])]
    .filter((directory, index, directories) => directory && directories.indexOf(directory) === index)
    .join(delimiter)
}

function executableExists(command: string, pathValue: string): boolean {
  if (!command) return false
  if (isAbsolute(command) || command.includes('/') || command.includes('\\'))
    return existsSync(command)

  const extensions = process.platform === 'win32'
    ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : ['']
  return pathValue.split(delimiter).some((directory) =>
    extensions.some((extension) => existsSync(join(directory, `${command}${extension}`)))
  )
}

function languageIdFor(descriptor: WorkbenchLanguageServiceDescriptor): string {
  return descriptor.documentLanguageId ?? descriptor.languages[0] ?? descriptor.id
}

function launchFor(
  projectRoot: string,
  descriptor: WorkbenchLanguageServiceDescriptor
): { command: string; args: string[]; electronRunAsNode: boolean } {
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

  return {
    command: executablePath(projectRoot, descriptor.command ?? ''),
    args: descriptor.args ?? [],
    electronRunAsNode: false,
  }
}

export class ExternalLspClient {
  private process: Nullable<ChildProcessWithoutNullStreams> = null
  private buffer = Buffer.alloc(0)
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly documents = new Map<string, OpenDocument>()
  private readonly diagnostics = new Map<string, DiagnosticSnapshot>()
  private readonly diagnosticWaiters = new Map<string, DiagnosticWaiter[]>()
  private serverCapabilities: Record<string, unknown> = {}
  private initializePromise: Nullable<Promise<void>> = null
  private stderr = ''
  private disposed = false

  public constructor(
    private readonly projectRoot: string,
    private readonly descriptor: WorkbenchLanguageServiceDescriptor,
    private readonly requestTimeoutMs = DefaultRequestTimeoutMs
  ) {}

  public accepts(path: string): boolean {
    const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
    return this.descriptor.extensions.includes(extension)
  }

  public async synchronize(path: string, content: string): Promise<{ uri: string; version: number }> {
    await this.initialize()
    const uri = URI.file(path).toString()
    const current = this.documents.get(uri)
    if (!current) {
      const document = { content, languageId: languageIdFor(this.descriptor), version: 1 }
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
    const next = { ...current, content, version: current.version + 1 }
    this.documents.set(uri, next)
    this.notify('textDocument/didChange', {
      textDocument: { uri, version: next.version },
      contentChanges: [{ text: content }],
    })
    return { uri, version: next.version }
  }

  public async save(path: string, content: string): Promise<void> {
    const document = await this.synchronize(path, content)
    this.notify('textDocument/didSave', { textDocument: { uri: document.uri }, text: content })
  }

  public async completion(path: string, content: string, position: LspPosition): Promise<ExternalLspCompletionItem[]> {
    const document = await this.synchronize(path, content)
    const result = await this.request('textDocument/completion', {
      textDocument: { uri: document.uri },
      position,
    })
    if (Array.isArray(result)) return result as ExternalLspCompletionItem[]
    const object = objectValue(result)
    return Array.isArray(object?.['items']) ? object['items'] as ExternalLspCompletionItem[] : []
  }

  public async hover(path: string, content: string, position: LspPosition): Promise<Nullable<ExternalLspHover>> {
    const document = await this.synchronize(path, content)
    const result = await this.request('textDocument/hover', {
      textDocument: { uri: document.uri },
      position,
    })
    return objectValue(result) as Nullable<ExternalLspHover>
  }

  public async definition(path: string, content: string, position: LspPosition): Promise<ExternalLspLocation[]> {
    const document = await this.synchronize(path, content)
    const result = await this.request('textDocument/definition', {
      textDocument: { uri: document.uri },
      position,
    })
    return normalizeLocations(result)
  }

  public async references(path: string, content: string, position: LspPosition): Promise<ExternalLspLocation[]> {
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
    position: LspPosition
  ): Promise<ExternalLspDocumentHighlight[]> {
    const document = await this.synchronize(path, content)
    const provider = this.serverCapabilities['documentHighlightProvider']
    if (provider !== true && !objectValue(provider)) return []
    const result = await this.request('textDocument/documentHighlight', {
      textDocument: { uri: document.uri },
      position,
    })
    return Array.isArray(result) ? result as ExternalLspDocumentHighlight[] : []
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
    return objectValue(result) as ExternalLspWorkspaceEdit ?? {}
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
      ? result as Array<ExternalLspDocumentSymbol | ExternalLspSymbolInformation>
      : []
  }

  public async signatureHelp(
    path: string,
    content: string,
    position: LspPosition
  ): Promise<Nullable<ExternalLspSignatureHelp>> {
    const document = await this.synchronize(path, content)
    const result = await this.request('textDocument/signatureHelp', {
      textDocument: { uri: document.uri },
      position,
    })
    return objectValue(result) as Nullable<ExternalLspSignatureHelp>
  }

  public async inlayHints(
    path: string,
    content: string,
    range: LspRange
  ): Promise<ExternalLspInlayHint[]> {
    const document = await this.synchronize(path, content)
    const provider = this.serverCapabilities['inlayHintProvider']
    if (provider !== true && !objectValue(provider)) return []
    const result = await this.request('textDocument/inlayHint', {
      textDocument: { uri: document.uri },
      range,
    })
    return Array.isArray(result) ? result as ExternalLspInlayHint[] : []
  }

  public async semanticTokens(path: string, content: string): Promise<ExternalLspSemanticTokens> {
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
    const result = objectValue(await this.request('textDocument/semanticTokens/full', {
      textDocument: { uri: document.uri },
    }))
    const rawData = result?.['data']
    const data = Array.isArray(rawData)
      && rawData.every((item) => Number.isSafeInteger(item) && (item as number) >= 0)
      ? rawData as number[]
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
    return Array.isArray(result) ? result as ExternalLspCodeAction[] : []
  }

  public async format(path: string, content: string): Promise<ExternalLspTextEdit[]> {
    const document = await this.synchronize(path, content)
    const result = await this.request('textDocument/formatting', {
      textDocument: { uri: document.uri },
      options: { tabSize: 2, insertSpaces: true, insertFinalNewline: true },
    })
    return Array.isArray(result) ? result as ExternalLspTextEdit[] : []
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
        this.diagnosticWaiters.set(document.uri, pending.filter((item) => item !== waiter))
        resolve(this.diagnostics.get(document.uri)?.diagnostics ?? [])
      }, DiagnosticWaitTimeoutMs)
    })
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const child = this.process
    if (!child) return

    try {
      await this.request('shutdown', null)
      this.notify('exit', null)
    } catch {
      child.kill()
    }
    this.process = null
  }

  private async initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise
    this.initializePromise = this.startAndInitialize()
    return this.initializePromise
  }

  private async startAndInitialize(): Promise<void> {
    const command = this.descriptor.command
    if (!command)
      throw new AppError('INVARIANT', `${this.descriptor.label} 缺少语言服务器命令。`)

    const launch = launchFor(this.projectRoot, this.descriptor)
    const pathValue = extendPath(this.projectRoot)
    if (!launch.electronRunAsNode && !executableExists(launch.command, pathValue)) {
      const installHint = this.descriptor.packageName
        ? `请在项目中安装 ${this.descriptor.packageName}，或将命令加入 PATH。`
        : '请安装对应项目工具链，或将命令加入 PATH。'
      throw new AppError(
        'INVARIANT',
        `${this.descriptor.label} 语言服务器不可用：未找到 '${launch.command}'。 ${installHint}`
      )
    }
    const child = spawn(launch.command, launch.args, {
      cwd: this.projectRoot,
      env: {
        ...process.env,
        PATH: pathValue,
        ...(launch.electronRunAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      },
      shell: process.platform === 'win32' && launch.command.endsWith('.cmd'),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.process = child
    child.stdout.on('data', (chunk: Buffer) => this.accept(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-4_000)
    })
    child.on('error', (error) => this.fail(error))
    child.on('exit', (code, signal) => {
      if (this.disposed) return
      this.fail(new AppError(
        'INTERNAL',
        `${this.descriptor.label} 语言服务器已退出（${signal ?? code ?? 'unknown'}）。${this.stderr ? ` ${this.stderr.trim()}` : ''}`
      ))
    })

    const result = await this.request('initialize', {
      processId: process.pid,
      rootUri: URI.file(this.projectRoot).toString(),
      workspaceFolders: [{ uri: URI.file(this.projectRoot).toString(), name: this.projectRoot.split(/[\\/]/u).at(-1) ?? 'project' }],
      capabilities: {
        textDocument: {
          completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'] } },
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
          signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'] } },
          publishDiagnostics: { versionSupport: true },
        },
      },
    }) as InitializeResult
    this.serverCapabilities = result.capabilities ?? {}

    if (this.descriptor.protocol) {
      const actual = protocolVersionFromInitialize(
        result,
        this.descriptor.protocol.capabilityPath
      )
      if (actual !== this.descriptor.protocol.version)
        throw new AppError(
          'INVARIANT',
          `${this.descriptor.label} 语言协议不兼容：Workbench 需要 v${this.descriptor.protocol.version}，服务器返回 ${actual === null ? 'unknown' : `v${actual}`}。`
        )
    }
    this.notify('initialized', {})
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return
        try { this.notify('$/cancelRequest', { id }) } catch { /* the request still rejects */ }
        reject(new AppError(
          'INTERNAL',
          `${this.descriptor.label} 语言服务器请求超时：${method}。`
        ))
      }, Math.max(1, this.requestTimeoutMs))
      this.pending.set(id, { resolve, reject, timeout })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        const pending = this.pending.get(id)
        if (pending) clearTimeout(pending.timeout)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  private send(message: JsonRpcMessage): void {
    const child = this.process
    if (!child || child.stdin.destroyed)
      throw new AppError('INTERNAL', `${this.descriptor.label} 语言服务器尚未运行。`)
    const json = JSON.stringify(message)
    const size = Buffer.byteLength(json, 'utf8')
    if (size > MaxLspMessageBytes)
      throw new AppError('INVARIANT', `${this.descriptor.label} LSP 消息超过 16 MiB 上限。`)
    child.stdin.write(`Content-Length: ${size}\r\n\r\n${json}`)
  }

  private accept(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (true) {
      const boundary = this.buffer.indexOf('\r\n\r\n')
      if (boundary < 0) {
        if (this.buffer.length > MaxLspHeaderBytes)
          this.fail(new AppError('INTERNAL', `${this.descriptor.label} LSP 响应头超过 8 KiB 上限。`))
        return
      }
      if (boundary > MaxLspHeaderBytes) {
        this.fail(new AppError('INTERNAL', `${this.descriptor.label} LSP 响应头超过 8 KiB 上限。`))
        return
      }
      const header = this.buffer.subarray(0, boundary).toString('ascii')
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/iu.exec(header)
      if (!match) {
        this.fail(new AppError('INTERNAL', `${this.descriptor.label} LSP 响应缺少有效的 Content-Length。`))
        return
      }
      const size = Number(match[1])
      if (!Number.isSafeInteger(size) || size > MaxLspMessageBytes) {
        this.fail(new AppError('INTERNAL', `${this.descriptor.label} LSP 响应超过 16 MiB 上限。`))
        return
      }
      const end = boundary + 4 + size
      if (this.buffer.length < end) return
      const body = this.buffer.subarray(boundary + 4, end).toString('utf8')
      this.buffer = this.buffer.subarray(end)
      try {
        this.handle(JSON.parse(body) as JsonRpcMessage)
      } catch {
        this.fail(new AppError('INTERNAL', `${this.descriptor.label} LSP 返回了无效 JSON。`))
        return
      }
    }
  }

  private handle(message: JsonRpcMessage): void {
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timeout)
      if (message.error)
        pending.reject(new AppError('INTERNAL', `${this.descriptor.label}: ${message.error.message ?? '语言服务器请求失败。'}`))
      else pending.resolve(message.result)
      return
    }

    if (message.method !== 'textDocument/publishDiagnostics') return
    const params = objectValue(message.params)
    const uri = typeof params?.['uri'] === 'string' ? params['uri'] : null
    if (!uri) return
    const openVersion = this.documents.get(uri)?.version ?? 0
    const version = typeof params?.['version'] === 'number' ? params['version'] : openVersion
    const diagnostics = Array.isArray(params?.['diagnostics'])
      ? params['diagnostics'] as ExternalLspDiagnostic[]
      : []
    this.diagnostics.set(uri, { version, diagnostics })
    const waiters = this.diagnosticWaiters.get(uri) ?? []
    const ready = waiters.filter((waiter) => version >= waiter.version)
    this.diagnosticWaiters.set(uri, waiters.filter((waiter) => version < waiter.version))
    for (const waiter of ready) waiter.resolve(diagnostics)
  }

  private fail(error: Error): void {
    const child = this.process
    this.process = null
    if (child && !child.killed) child.kill()
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
  private readonly clients = new Map<string, ExternalLspClient>()

  public client(projectRoot: string, descriptor: WorkbenchLanguageServiceDescriptor): ExternalLspClient {
    const key = `${projectRoot}\0${descriptor.id}`
    const current = this.clients.get(key)
    if (current) return current
    const client = new ExternalLspClient(projectRoot, descriptor)
    this.clients.set(key, client)
    return client
  }

  public async save(projectRoot: string, path: string, content: string): Promise<void> {
    const clients = [...this.clients.entries()]
      .filter(([key]) => key.startsWith(`${projectRoot}\0`))
      .map(([, client]) => client)
    await Promise.all(clients.filter((client) => client.accepts(path)).map((client) => client.save(path, content)))
  }

  public async invalidate(projectRoot: string): Promise<void> {
    const entries = [...this.clients.entries()].filter(([key]) => key.startsWith(`${projectRoot}\0`))
    for (const [key] of entries) this.clients.delete(key)
    await Promise.all(entries.map(([, client]) => client.dispose()))
  }

  public async dispose(): Promise<void> {
    const clients = [...this.clients.values()]
    this.clients.clear()
    await Promise.all(clients.map((client) => client.dispose()))
  }
}
