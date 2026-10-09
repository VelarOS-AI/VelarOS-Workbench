import { basename, resolve } from 'node:path'

import * as ts from 'typescript'
import {
  getCSSLanguageService,
  getLESSLanguageService,
  getSCSSLanguageService,
  type LanguageService as CssLanguageService,
} from 'vscode-css-languageservice'
import { getLanguageService as getHtmlLanguageService } from 'vscode-html-languageservice'
import { TextDocument } from 'vscode-languageserver-textdocument'
import {
  DiagnosticLevel,
  IncludeWorkspaceHeaderCompletions,
} from 'vscode-markdown-languageservice'
import { URI } from 'vscode-uri'

import { isNumber,isPresent, optionalWhen, toNullable, toOptional } from '@velaros-ai/core'

import { type WorkbenchLanguageServiceCallHierarchyRequest, type WorkbenchLanguageServiceCallHierarchyResult, type WorkbenchLanguageServiceCapability, type WorkbenchLanguageServiceCodeActionResolveRequest, type WorkbenchLanguageServiceCodeActionResolveResult, type WorkbenchLanguageServiceCodeActionsRequest, type WorkbenchLanguageServiceCodeActionsResult, type WorkbenchLanguageServiceCompletionItem, type WorkbenchLanguageServiceCompletionResolveRequest, type WorkbenchLanguageServiceCompletionResolveResult, type WorkbenchLanguageServiceCompletionResult, type WorkbenchLanguageServiceDefinitionResult, type WorkbenchLanguageServiceDescriptorSnapshot, type WorkbenchLanguageServiceDiagnostic, type WorkbenchLanguageServiceDiagnosticsResult, type WorkbenchLanguageServiceDocumentHighlightsResult, type WorkbenchLanguageServiceDocumentSymbol, type WorkbenchLanguageServiceDocumentSymbolsResult, type WorkbenchLanguageServiceExtensionRequest, type WorkbenchLanguageServiceExtensionResult, type WorkbenchLanguageServiceFileEdit, type WorkbenchLanguageServiceFileRenameEditsRequest, type WorkbenchLanguageServiceFileRenameEditsResult, type WorkbenchLanguageServiceFormatResult, type WorkbenchLanguageServiceHoverResult, type WorkbenchLanguageServiceInlayHintsRequest, type WorkbenchLanguageServiceInlayHintsResult, type WorkbenchLanguageServiceLocation, type WorkbenchLanguageServiceOrganizeImportsResult, type WorkbenchLanguageServicePosition, type WorkbenchLanguageServicePositionRequest, type WorkbenchLanguageServiceProjectDiagnosticsRequest, type WorkbenchLanguageServiceProjectDiagnosticsResult, type WorkbenchLanguageServiceRange, type WorkbenchLanguageServiceReferencesResult, type WorkbenchLanguageServiceRenameRequest, type WorkbenchLanguageServiceRenameResult, type WorkbenchLanguageServiceRequest, type WorkbenchLanguageServiceResolveResult, type WorkbenchLanguageServiceSemanticTokensResult, type WorkbenchLanguageServiceSignatureHelpResult } from '@shared/contracts/workbench'
import {
  getWorkbenchPathExtension,
  normalizeWorkbenchLanguage,
  resolveBuiltinWorkbenchLanguageService,
  type WorkbenchLanguageServiceDescriptor,
} from '@shared/workbenchLanguageServices'

import {
  type ExternalLspCodeAction,
  type ExternalLspDiagnostic,
  type ExternalLspDocumentHighlight,
  type ExternalLspDocumentSymbol,
  type ExternalLspInlayHint,
  type ExternalLspLocation,
  ExternalLspManager,
  type ExternalLspSemanticTokens,
  type ExternalLspSignatureHelp,
  type ExternalLspSymbolInformation,
  type ExternalLspWorkspaceEdit,
  resolveExternalLspRuntimeRoot,
} from './ExternalLspClient'
import {
  clearWorkbenchProjectEslintCache,
  clearWorkbenchProjectEslintResults,
  describeWorkbenchProjectEslint,
  getWorkbenchJavaScriptLintDiagnostics,
  releaseWorkbenchProjectEslint,
} from './JavaScriptLinting'
import {
  hoverBlockPlainText,
  parseLanguageServiceHoverMarkdown,
} from './LanguageServiceHoverMarkdown'
import type {
  WorkbenchLanguageServiceProjectFileRequest,
  WorkbenchLanguageServiceProjectRequest,
} from './LanguageServiceWorkerProtocol'
import {
  withWorkbenchMarkdownLanguageService,
  type WorkbenchMarkdownLanguageServiceContext,
} from './MarkdownLanguageService'
import { buildTypeScriptCallHierarchy } from './TypeScriptCallHierarchy'
import {
  buildTypeScriptOrganizeImportsEdits,
  buildTypeScriptQuickFixes,
  buildTypeScriptRefactors,
  resolveTypeScriptCodeAction,
  type TypeScriptEditContext,
} from './TypeScriptCodeActions'
import {
  buildTypeScriptCompletionItems,
  resolveTypeScriptCompletionItem,
} from './TypeScriptCompletions'
import {
  buildTypeScriptFileRenameEdits,
  mergeTypeScriptFileRenameEdits,
} from './TypeScriptFileRenameEdits'
import {
  buildTypeScriptDocumentHighlights,
  buildTypeScriptDocumentSymbols,
  buildTypeScriptFormatEdits,
  buildTypeScriptHoverResult,
  buildTypeScriptInlayHints,
  buildTypeScriptReferences,
  buildTypeScriptSemanticTokens,
  buildTypeScriptSignatureHelp,
  isTypeScriptDeprecatedDiagnostic,
  rangeFromTextSpanInContent,
} from './TypeScriptLanguageFeatures'
import {
  acquireTypeScriptLanguageService,
  clearTypeScriptProjectCache,
  describeTypeScriptProjects,
  forgetMovedTypeScriptProjectPath,
  freezeTypeScriptProgramWhile,
  isPathInside,
  normalizeTypeScriptFileName,
  planTypeScriptFileRenameProjects,
  readMovedTypeScriptFiles,
  refreshTypeScriptProjectFilesFromDisk,
  resolveTypeScriptProjectKey,
  safeReadFile,
  synchronizeTypeScriptProjectFile,
  trimTypeScriptProjects,
  TypeScriptExtensions,
  type WorkbenchTypeScriptTrimLevel,
} from './TypeScriptProjectHost'
import {
  buildWholeDocumentReplaceEdit,
  clearWorkbenchProjectPrettierCache,
  formatWorkbenchDocumentBuiltin,
  formatWorkbenchDocumentWithProjectPrettier,
} from './WorkbenchDocumentFormatter'

export interface WorkbenchLanguagePathResolver {
  resolveProjectRoot(input: string): Promise<string>
  assertAllowedProjectPath(projectRoot: string, absolutePath: string, inputPath: string): void
  isAllowedProjectPath(projectRoot: string, absolutePath: string): boolean
  toProjectRelativePath(projectRoot: string, absolutePath: string): string
}

/** 引用列表里一行预览最多这么长：再长的行（压缩过的代码）只看开头。 */
const MaxLocationPreviewLength = 200

// A complete Look property roster currently contains 225 entries. Keep the
// external-language boundary bounded without dropping valid contextual
// completions before CodeMirror can filter and rank them.
const MaximumExternalLspCompletionItems = 512

function textFromLspContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textFromLspContent).filter(Boolean).join('\n\n')
  if (typeof value !== 'object' || value === null) return ''
  const content = value as Record<string, unknown>
  if (typeof content['language'] === 'string' && typeof content['value'] === 'string')
    return `\`\`\`${content['language']}\n${content['value']}\n\`\`\``
  if (typeof content['value'] === 'string') return content['value']
  return ''
}

/** `{ kind: 'plaintext' }` 的内容按原文显示，不当 Markdown 解析。 */
function isPlainTextLspContent(value: unknown): value is { value: string } {
  const content = typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
  return content?.['kind'] === 'plaintext' && typeof content['value'] === 'string'
}

/** 补全、签名说明只能显示一段文字：Markdown 标记去掉，代码块与段落之间空一行。 */
function plainTextFromLspContent(value: unknown): string | undefined {
  if (isPlainTextLspContent(value)) return value.value.trim() || undefined
  const text = parseLanguageServiceHoverMarkdown(textFromLspContent(value))
    .map(hoverBlockPlainText)
    .join('\n\n')
  return text || undefined
}

function sourceIndentWidth(line: string): number {
  return line.match(/^[ \t]*/u)?.[0].replace(/\t/gu, '    ').length ?? 0
}

function sourceDeclarationBlock(lines: readonly string[], lineIndex: number): string {
  const declaration = lines[lineIndex]?.trimEnd() ?? ''
  if (!declaration.trim()) return ''

  const block = [declaration]
  const declarationIndent = sourceIndentWidth(declaration)
  for (let index = lineIndex + 1; index < lines.length && block.length < 10; index += 1) {
    const line = lines[index]?.trimEnd() ?? ''
    if (!line.trim() || sourceIndentWidth(line) <= declarationIndent) break
    block.push(line)
  }
  return block.join('\n').trim()
}

/** Builds a bounded source excerpt and expands a nearby simple type alias once. */
export function buildExternalDefinitionPreview(content: string, line: number): string {
  const lines = content.split(/\r?\n/u)
  const lineIndex = Math.min(Math.max(0, line - 1), Math.max(0, lines.length - 1))
  const declaration = sourceDeclarationBlock(lines, lineIndex)
  if (!declaration) return ''

  const aliasTarget = declaration
    .split('\n', 1)[0]
    ?.match(/\btype\s+[\p{L}\p{Nl}_$][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$]*\s*=\s*([\p{L}\p{Nl}_$][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$]*)\s*$/u)?.[1]
  if (!aliasTarget) return declaration

  const targetIndex = lines.findIndex((candidate, index) =>
    index !== lineIndex
    && candidate.match(/\btype\s+([\p{L}\p{Nl}_$][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$]*)\b/u)?.[1]
      === aliasTarget
  )
  if (targetIndex < 0) return declaration

  const target = sourceDeclarationBlock(lines, targetIndex)
  return target ? `${declaration}\n\n${target}` : declaration
}

/**
 * 语言服务器的悬浮说明：开头的代码（围栏代码块，或整段只是一个行内代码）是签名标题，其余按段落与代码块
 * 排成说明。Pyright 的「```python 签名```、`---`、说明」这类写法也按块拆开，不再把反引号、分隔线、
 * `&nbsp;`、转义符原样显示出来。
 */
export function buildExternalHoverResult(contents: unknown): Nullable<WorkbenchLanguageServiceHoverResult> {
  if (isPlainTextLspContent(contents)) {
    const text = contents.value.trim()
    return text ? { displayText: text } : null
  }

  const blocks = parseLanguageServiceHoverMarkdown(textFromLspContent(contents))
  const [first, ...rest] = blocks
  if (!first) return null

  const headingCode = first.kind === 'code' ? first.text : /^`([^`]+)`$/u.exec(first.text)?.[1]
  // 没有签名、只有文字：整段文字就是标题。
  if (headingCode === undefined) return { displayText: blocks.map(hoverBlockPlainText).join('\n\n') }

  const displayText = headingCode.trim()
  const documentation = rest.map(hoverBlockPlainText).join('\n\n')
  if (!displayText && !documentation) return null
  return {
    displayText: displayText || documentation,
    documentation: optionalWhen(!!displayText && !!documentation, documentation),
    documentationBlocks: optionalWhen(!!displayText && rest.length > 0, rest),
  }
}

function mapExternalCompletionKind(kind: number | undefined): string | undefined {
  switch (kind) {
    case 2: return 'method'
    case 3: return 'function'
    case 6: return 'variable'
    case 7: return 'class'
    case 8: return 'interface'
    case 9: return 'namespace'
    case 10: return 'property'
    case 12: return 'constant'
    case 13: return 'enum'
    case 14: return 'keyword'
    case 17: return 'file'
    case 21: return 'constant'
    default: return undefined
  }
}

function mapExternalDocumentSymbolKind(kind: number): WorkbenchLanguageServiceDocumentSymbol['kind'] {
  switch (kind) {
    case 2:
    case 3:
    case 4: return 'module'
    case 5:
    case 23: return 'class'
    case 6: return 'method'
    case 7:
    case 8: return 'property'
    case 9: return 'constructor'
    case 10: return 'enum'
    case 11: return 'interface'
    case 12: return 'function'
    case 13: return 'variable'
    case 14: return 'constant'
    case 22: return 'enum-member'
    case 26: return 'type'
    default: return 'symbol'
  }
}

function mapHtmlCompletionKind(kind: number | undefined): string {
  switch (kind) {
    case 10:
      return 'property'
    case 12:
      return 'constant'
    case 14:
      return 'keyword'
    default:
      return 'tag'
  }
}

function mapCssCompletionKind(kind: number | undefined): string {
  switch (kind) {
    case 10:
      return 'property'
    case 12:
      return 'constant'
    case 14:
      return 'keyword'
    case 16:
      return 'constant'
    default:
      return 'property'
  }
}

/** 一次整项目检查最多照顾这么多个 tsconfig 项目（当前文件的项目在前）；多了会把语言服务的项目缓存挤来挤去。 */
const MaxProjectDiagnosticsProjects = 2
/** 整项目检查一批占用 worker 的时间上限（至少查完一个文件）。 */
const ProjectDiagnosticsBatchBudgetMs = 150

/** 接续位置：第几个项目、上一批查到的最后一个文件（项目内相对路径）。认不出的从头查。 */
function parseProjectDiagnosticsCursor(cursor: string | undefined): { project: number; after: string } {
  if (!cursor) return { project: 0, after: '' }
  try {
    const value = JSON.parse(cursor) as unknown
    if (
      Array.isArray(value)
      && Number.isSafeInteger(value[0])
      && (value[0] as number) >= 0
      && typeof value[1] === 'string'
    ) return { project: value[0] as number, after: value[1] }
  } catch {
    // 认不出的接续位置按从头查处理。
  }
  return { project: 0, after: '' }
}

interface LspCompletionPosition {
  line: number
  character: number
}

interface LspCompletionRange {
  start: LspCompletionPosition
  end: LspCompletionPosition
}

/** 内置的 HTML / CSS / Markdown 服务与外部语言服务器共用的 LSP 补全项形状。 */
interface LspCompletionItemLike {
  label: string
  detail?: string
  documentation?: unknown
  insertText?: string
  insertTextFormat?: number
  sortText?: string
  filterText?: string
  textEdit?: { newText: string; range?: LspCompletionRange; insert?: LspCompletionRange }
  additionalTextEdits?: ReadonlyArray<{ range: LspCompletionRange; newText: string }>
  command?: { command?: string }
  labelDetails?: { detail?: string; description?: string }
}

function rangeFromLspCompletionRange(range: LspCompletionRange): WorkbenchLanguageServiceRange {
  return {
    startLine: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1,
  }
}

/**
 * LSP 补全项换成编辑器的补全项：`textEdit` 的范围照原样交出去（编辑器按它替换，而不是只换光标前的词），
 * 片段格式、附加改动（自动导入）一并保留。插入 / 替换两种范围都给了时取插入范围。
 */
function mapLspCompletionItem(
  path: string,
  item: LspCompletionItemLike,
  kind: string | undefined
): WorkbenchLanguageServiceCompletionItem {
  const editRange = item.textEdit?.range ?? item.textEdit?.insert
  return {
    label: item.label,
    kind,
    detail: item.detail ?? item.labelDetails?.detail,
    returnType: item.labelDetails?.description,
    documentation: plainTextFromLspContent(item.documentation),
    insertText: item.textEdit?.newText ?? item.insertText,
    range: editRange ? rangeFromLspCompletionRange(editRange) : undefined,
    sortText: item.sortText,
    filterText: item.filterText,
    isSnippet: item.insertTextFormat === 2,
    additionalTextEdits: item.additionalTextEdits?.length
      ? item.additionalTextEdits.map((edit) => ({
          path,
          range: rangeFromLspCompletionRange(edit.range),
          newText: edit.newText,
        }))
      : undefined,
    retrigger: item.command?.command === 'editor.action.triggerSuggest' || undefined,
  }
}

interface TypeScriptProjectSnapshot {
  projectRoot: string
  requestPath: string
  requestAbsolutePath: string
  files: Map<string, string>
  service: ts.LanguageService
}

class WorkbenchLanguageServices {
  private readonly externalLsp = new ExternalLspManager()

  constructor(private readonly pathResolver: WorkbenchLanguagePathResolver) {}

  public async synchronizeProjectFile(
    request: WorkbenchLanguageServiceProjectFileRequest
  ): Promise<void> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const absolutePath = this.resolveAbsoluteProjectPath(projectRoot, request.path)
    synchronizeTypeScriptProjectFile(projectRoot, absolutePath, request.content)
    clearWorkbenchProjectEslintResults(projectRoot)
    if (isPresent(request.content))
      await this.externalLsp.save(projectRoot, absolutePath, request.content)
    if (basename(absolutePath) === 'package.json') {
      clearWorkbenchProjectEslintCache(projectRoot)
      clearWorkbenchProjectPrettierCache(projectRoot)
    }
  }

  public async invalidateProject(request: WorkbenchLanguageServiceProjectRequest): Promise<void> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    clearTypeScriptProjectCache(projectRoot)
    clearWorkbenchProjectEslintCache(projectRoot)
    clearWorkbenchProjectPrettierCache(projectRoot)
    await this.externalLsp.invalidate(projectRoot)
  }

  /**
   * 磁盘上这些文件变了（文件监听、Agent 的写文件工具、用户在编辑器与文件树里的写入）：内置 TypeScript 项目按
   * 磁盘内容更新，项目级 ESLint / Prettier 缓存随 package.json 作废，外部语言服务器收到标准的文件变更通知。
   * 路径相对项目根或绝对都收；项目之外的一律忽略，不让一个越界路径把整批通知打掉。
   */
  public async projectFilesChanged(request: {
    projectRoot: string
    paths: readonly string[]
  }): Promise<void> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const paths = request.paths
      .map((path) => resolve(projectRoot, path))
      .filter((absolutePath) => this.pathResolver.isAllowedProjectPath(projectRoot, absolutePath))
    if (paths.length === 0) return

    refreshTypeScriptProjectFilesFromDisk(projectRoot, paths)
    clearWorkbenchProjectEslintResults(projectRoot)
    if (paths.some((absolutePath) => basename(absolutePath) === 'package.json')) {
      clearWorkbenchProjectEslintCache(projectRoot)
      clearWorkbenchProjectPrettierCache(projectRoot)
    }
    await this.externalLsp.filesChanged(projectRoot, paths)
  }

  /**
   * 主动释放内存（见 LanguageServiceMemoryGuard）。`semantic` 只丢类型检查缓存；`inactive` / `all` 连服务带
   * ESLint 的类型程序一起放掉，下一次请求重建。外部语言服务器是独立进程，不在这里管。
   */
  public trimMemory(level: WorkbenchTypeScriptTrimLevel): { projects: number; eslint: number } {
    const projects = trimTypeScriptProjects(level)
    if (level === 'semantic') {
      clearWorkbenchProjectEslintResults()
      return { projects, eslint: 0 }
    }
    return { projects, eslint: releaseWorkbenchProjectEslint() }
  }

  public describeMemory(): { projects: number; files: number; eslintInstances: number } {
    const typescript = describeTypeScriptProjects()
    return {
      projects: typescript.projects,
      files: typescript.files,
      eslintInstances: describeWorkbenchProjectEslint().instances,
    }
  }

  public async dispose(): Promise<void> {
    await this.externalLsp.dispose()
  }

  public async resolveLanguageService(
    request: WorkbenchLanguageServiceRequest
  ): Promise<WorkbenchLanguageServiceResolveResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const token = this.resolveToken(request)
    const builtin = resolveBuiltinWorkbenchLanguageService(token)

    return {
      projectRoot,
      path: request.path,
      languageId: token || 'text',
      status: builtin ? 'ready' : 'unsupported',
      service: builtin ? this.toServiceSnapshot(builtin) : null,
      capabilities: builtin ? this.capabilitiesForBuiltinService(builtin) : [],
    }
  }

  public async requestExtension(
    request: WorkbenchLanguageServiceExtensionRequest
  ): Promise<WorkbenchLanguageServiceExtensionResult> {
    const resolved = await this.resolveLanguageService(request)
    if (!this.isExternalRuntime(resolved.service?.runtime)) {
      throw new Error(`Unsupported external language service for ${request.path}`)
    }
    const external = await this.prepareExternal(request, resolved.projectRoot)
    return {
      projectRoot: resolved.projectRoot,
      path: request.path,
      requestId: request.requestId,
      result: await external.client.requestExtension(
        external.absolutePath,
        external.content,
        request.requestId,
        request.parameters,
        request.content === undefined
      ),
    }
  }

  public async getDefinition(
    request: WorkbenchLanguageServicePositionRequest
  ): Promise<WorkbenchLanguageServiceDefinitionResult> {
    const resolved = await this.resolveLanguageService(request)
    if (this.isExternalRuntime(resolved.service?.runtime)) {
      const external = await this.prepareExternal(request, resolved.projectRoot)
      const definitions = await external.client.definition(
        external.absolutePath,
        external.content,
        this.languageServicePosition(request.position)
      )
      return {
        projectRoot: resolved.projectRoot,
        path: request.path,
        locations: definitions
          .map((location) => this.mapExternalLocation(resolved.projectRoot, location))
          .filter((location): location is WorkbenchLanguageServiceLocation => isPresent(location)),
      }
    }
    if (resolved.service?.runtime === 'markdown-language-service') return this.withMarkdownLanguageService(request, resolved.projectRoot, async (markdown) => {
        const definition = await markdown.service.getDefinition(
          markdown.document,
          this.languageServicePosition(request.position),
          markdown.token
        )
        const locations = (Array.isArray(definition) ? definition : definition ? [definition] : [])
          .flatMap((location) => ('uri' in location ? [location] : []))
          .map((location) => this.mapMarkdownLocation(markdown, location))
          .filter((location): location is WorkbenchLanguageServiceLocation => isPresent(location))
        return { projectRoot: resolved.projectRoot, path: request.path, locations }
      })
    // Standalone Workbench has no CodeGraph AI index (kernel territory); definitions come
    // straight from the TypeScript language service, and non-TS runtimes return nothing.
    if (resolved.service?.runtime !== 'typescript-language-service')
      return { projectRoot: resolved.projectRoot, path: request.path, locations: [] }

    const snapshot = await this.createTypeScriptProjectSnapshot(request)
    const offset = this.offsetFromPosition(
      snapshot.files.get(snapshot.requestAbsolutePath) ?? '',
      request.position
    )
    const definitions =
      snapshot.service.getDefinitionAtPosition(snapshot.requestAbsolutePath, offset) ?? []

    const locations = definitions
      .map((definition) =>
        this.locationFromTextSpan(snapshot, definition.fileName, definition.textSpan)
      )
      .filter((location): location is WorkbenchLanguageServiceLocation => isPresent(location))

    return {
      projectRoot: snapshot.projectRoot,
      path: snapshot.requestPath,
      locations,
    }
  }

  public async getCompletions(
    request: WorkbenchLanguageServicePositionRequest,
    signal?: AbortSignal
  ): Promise<WorkbenchLanguageServiceCompletionResult> {
    const resolved = await this.resolveLanguageService(request)
    if (this.isExternalRuntime(resolved.service?.runtime)) {
      const external = await this.prepareExternal(request, resolved.projectRoot)
      const list = await external.client.completion(
        external.absolutePath,
        external.content,
        this.languageServicePosition(request.position),
        signal
      )
      return {
        projectRoot: resolved.projectRoot,
        path: request.path,
        items: list.items
          .slice(0, MaximumExternalLspCompletionItems)
          .map((item) => mapLspCompletionItem(request.path, item, mapExternalCompletionKind(item.kind))),
        // 截掉了一部分：继续输入时重新请求，服务端按更长的前缀再筛。
        isIncomplete: list.isIncomplete || list.items.length > MaximumExternalLspCompletionItems,
      }
    }
    if (resolved.service?.runtime === 'markdown-language-service') return this.withMarkdownLanguageService(request, resolved.projectRoot, async (markdown) => {
        const items = await markdown.service.getCompletionItems(
          markdown.document,
          this.languageServicePosition(request.position),
          { includeWorkspaceHeaderCompletions: IncludeWorkspaceHeaderCompletions.onSingleOrDoubleHash },
          markdown.token
        )
        return {
          projectRoot: resolved.projectRoot,
          path: request.path,
          items: items.map((item) =>
            mapLspCompletionItem(request.path, item, isNumber(item.kind) ? String(item.kind) : undefined)
          ),
        }
      })
    if (resolved.service?.runtime !== 'typescript-language-service')
      return {
        projectRoot: resolved.projectRoot,
        path: request.path,
        items: this.getBuiltinLanguageServiceCompletions(
          request,
          resolved.projectRoot,
          toNullable(resolved.service?.runtime)
        ),
      }

    const snapshot = await this.createTypeScriptProjectSnapshot(request)
    const content = snapshot.files.get(snapshot.requestAbsolutePath) ?? ''
    const { items, isIncomplete } = buildTypeScriptCompletionItems({
      service: snapshot.service,
      fileName: snapshot.requestAbsolutePath,
      offset: this.offsetFromPosition(content, request.position),
      content,
      format: request.format,
    })

    return {
      projectRoot: snapshot.projectRoot,
      path: snapshot.requestPath,
      items,
      isIncomplete,
    }
  }

  /** 补全项接受（或在列表里选中）时才算的细节：TypeScript 自动导入要加的 import 语句与说明。 */
  public async resolveCompletion(
    request: WorkbenchLanguageServiceCompletionResolveRequest
  ): Promise<WorkbenchLanguageServiceCompletionResolveResult> {
    const resolved = await this.resolveLanguageService(request)
    if (resolved.service?.runtime !== 'typescript-language-service')
      return { projectRoot: resolved.projectRoot, path: request.path, additionalTextEdits: [] }

    const snapshot = await this.createTypeScriptProjectSnapshot(request)
    const content = snapshot.files.get(snapshot.requestAbsolutePath) ?? ''
    return {
      projectRoot: snapshot.projectRoot,
      path: snapshot.requestPath,
      ...resolveTypeScriptCompletionItem({
        service: snapshot.service,
        fileName: snapshot.requestAbsolutePath,
        offset: this.offsetFromPosition(content, request.position),
        content,
        relativePath: snapshot.requestPath,
        item: request.item,
        format: request.format,
      }),
    }
  }

  /**
   * 整个 TypeScript 项目的问题，像 `tsc --noEmit -p` 那样：项目里每个源文件的语法与类型错误（不含建议、ESLint）。
   * 按打开的文件找到它们所在的 tsconfig 项目（最多两个），一批只查一小段时间，返回接续位置；诊断之类的后台请求
   * 在 worker 里排在交互请求后面，一批查完就轮到补全、悬浮先走。
   */
  public async getProjectDiagnostics(
    request: WorkbenchLanguageServiceProjectDiagnosticsRequest
  ): Promise<WorkbenchLanguageServiceProjectDiagnosticsResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const projects: Array<{ anchorPath: string; key: string }> = []
    for (const anchorPath of request.anchorPaths) {
      if (projects.length >= MaxProjectDiagnosticsProjects) break
      const absolutePath = resolve(projectRoot, anchorPath)
      if (
        !this.pathResolver.isAllowedProjectPath(projectRoot, absolutePath)
        || resolveBuiltinWorkbenchLanguageService(getWorkbenchPathExtension(anchorPath))?.runtime
          !== 'typescript-language-service'
      ) continue
      const key = resolveTypeScriptProjectKey(projectRoot, absolutePath)
      if (!projects.some((project) => project.key === key)) projects.push({ anchorPath, key })
    }

    const cursor = parseProjectDiagnosticsCursor(request.cursor)
    const deadline = performance.now() + ProjectDiagnosticsBatchBudgetMs
    const checkedPaths: string[] = []
    const diagnostics: WorkbenchLanguageServiceDiagnostic[] = []
    for (let index = cursor.project; index < projects.length; index += 1) {
      const anchorPath = projects[index]!.anchorPath
      const snapshot = await this.createTypeScriptProjectSnapshot({
        projectRoot,
        path: anchorPath,
        content: request.openFiles?.find((file) => file.path === anchorPath)?.content,
        openFiles: request.openFiles,
      })
      const program = snapshot.service.getProgram()
      if (!program) continue

      const files = this.projectDiagnosticsFiles(program, snapshot.projectRoot)
      const start = index === cursor.project
        ? files.findIndex((file) => file.path > cursor.after)
        : 0
      if (start < 0) continue
      for (let fileIndex = start; fileIndex < files.length; fileIndex += 1) {
        if (checkedPaths.length > 0 && performance.now() > deadline)
          return {
            projectRoot,
            checkedPaths,
            diagnostics,
            cursor: JSON.stringify([index, files[fileIndex - 1]!.path]),
          }
        const file = files[fileIndex]!
        checkedPaths.push(file.path)
        for (const diagnostic of [
          ...snapshot.service.getSyntacticDiagnostics(file.fileName),
          ...snapshot.service.getSemanticDiagnostics(file.fileName),
        ]) {
          const mapped = this.diagnosticFromTypeScript(snapshot, diagnostic)
          if (mapped?.path === file.path) diagnostics.push(mapped)
        }
      }
    }
    return { projectRoot, checkedPaths, diagnostics, cursor: null }
  }

  /** 项目自己的源文件（按项目内相对路径排序）：不含默认库、依赖包，跳过库检查时也不含声明文件。 */
  private projectDiagnosticsFiles(
    program: ts.Program,
    projectRoot: string
  ): Array<{ fileName: string; path: string }> {
    const skipDeclarations = program.getCompilerOptions().skipLibCheck !== false
    return program
      .getSourceFiles()
      .filter((sourceFile) =>
        !program.isSourceFileDefaultLibrary(sourceFile)
        && !program.isSourceFileFromExternalLibrary(sourceFile)
        && !(skipDeclarations && sourceFile.isDeclarationFile)
        && TypeScriptExtensions.has(this.extensionWithDot(sourceFile.fileName))
        && !/[\\/]node_modules[\\/]/u.test(sourceFile.fileName)
      )
      .flatMap((sourceFile) => {
        const path = this.relativePathFor(projectRoot, sourceFile.fileName)
        return path ? [{ fileName: sourceFile.fileName, path }] : []
      })
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  }

  public async getDiagnostics(
    request: WorkbenchLanguageServiceRequest
  ): Promise<WorkbenchLanguageServiceDiagnosticsResult> {
    const resolved = await this.resolveLanguageService(request)
    if (this.isExternalRuntime(resolved.service?.runtime)) {
      const external = await this.prepareExternal(request, resolved.projectRoot)
      const diagnostics = await external.client.getDiagnostics(external.absolutePath, external.content)
      return {
        projectRoot: resolved.projectRoot,
        path: request.path,
        diagnostics: diagnostics.map((diagnostic) => this.mapExternalDiagnostic(request.path, diagnostic)),
      }
    }
    if (resolved.service?.runtime === 'markdown-language-service') return this.withMarkdownLanguageService(request, resolved.projectRoot, async (markdown) => {
        const diagnostics = await markdown.service.computeDiagnostics(
          markdown.document,
          {
            validateReferences: DiagnosticLevel.warning,
            validateFragmentLinks: DiagnosticLevel.warning,
            validateFileLinks: DiagnosticLevel.warning,
            validateMarkdownFileLinkFragments: DiagnosticLevel.warning,
            validateUnusedLinkDefinitions: DiagnosticLevel.ignore,
            validateDuplicateLinkDefinitions: DiagnosticLevel.warning,
            ignoreLinks: [],
          },
          markdown.token
        )
        return {
          projectRoot: resolved.projectRoot,
          path: request.path,
          diagnostics: diagnostics.map((diagnostic) => ({
            path: request.path,
            severity:
              diagnostic.severity === 1
                ? 'error' as const
                : diagnostic.severity === 2
                  ? 'warning' as const
                  : 'info' as const,
            message: textFromLspContent(diagnostic.message),
            source: diagnostic.source ?? 'markdown',
            code: typeof diagnostic.code === 'string' || typeof diagnostic.code === 'number'
              ? diagnostic.code
              : undefined,
            range: this.rangeFromLanguageServiceRange(diagnostic.range),
          })),
        }
      })
    if (resolved.service?.runtime !== 'typescript-language-service')
      return {
        projectRoot: resolved.projectRoot,
        path: request.path,
        diagnostics: this.getBuiltinLanguageServiceDiagnostics(
          request,
          resolved.projectRoot,
          toNullable(resolved.service?.runtime)
        ),
      }

    const snapshot = await this.createTypeScriptProjectSnapshot(request)
    const diagnostics = [
      ...snapshot.service.getSyntacticDiagnostics(snapshot.requestAbsolutePath),
      ...snapshot.service.getSemanticDiagnostics(snapshot.requestAbsolutePath),
      ...snapshot.service.getSuggestionDiagnostics(snapshot.requestAbsolutePath),
    ]
    const eslintDiagnostics = await getWorkbenchJavaScriptLintDiagnostics({
      projectRoot: snapshot.projectRoot,
      absolutePath: snapshot.requestAbsolutePath,
      relativePath: snapshot.requestPath,
      content: snapshot.files.get(snapshot.requestAbsolutePath) ?? '',
    })

    return {
      projectRoot: snapshot.projectRoot,
      path: snapshot.requestPath,
      diagnostics: [
        ...diagnostics
          .map((diagnostic) => this.diagnosticFromTypeScript(snapshot, diagnostic))
          .filter((diagnostic): diagnostic is WorkbenchLanguageServiceDiagnostic =>
            isPresent(diagnostic)
          ),
        ...eslintDiagnostics,
      ],
    }
  }

  public async getRename(
    request: WorkbenchLanguageServiceRenameRequest
  ): Promise<WorkbenchLanguageServiceRenameResult> {
    const resolved = await this.resolveLanguageService(request)
    if (this.isExternalRuntime(resolved.service?.runtime)) {
      const external = await this.prepareExternal(request, resolved.projectRoot)
      const edit = await external.client.rename(
        external.absolutePath,
        external.content,
        this.languageServicePosition(request.position),
        request.newName
      )
      return {
        projectRoot: resolved.projectRoot,
        path: request.path,
        changes: this.mapExternalWorkspaceEdit(resolved.projectRoot, edit),
      }
    }
    if (resolved.service?.runtime === 'markdown-language-service') return this.withMarkdownLanguageService(request, resolved.projectRoot, async (markdown) => {
        const edit = await markdown.service.getRenameEdit(
          markdown.document,
          this.languageServicePosition(request.position),
          request.newName,
          markdown.token
        )
        return {
          projectRoot: resolved.projectRoot,
          path: request.path,
          changes: edit
            ? this.mapExternalWorkspaceEdit(resolved.projectRoot, {
                changes: edit.changes,
                documentChanges: edit.documentChanges?.flatMap((change) =>
                  'textDocument' in change
                    ? [{
                        textDocument: change.textDocument,
                        edits: change.edits.flatMap((item) =>
                          'newText' in item ? [item] : []
                        ),
                      }]
                    : []
                ),
              })
            : [],
        }
      })
    if (resolved.service?.runtime !== 'typescript-language-service')
      return { projectRoot: resolved.projectRoot, path: request.path, changes: [] }

    const snapshot = await this.createTypeScriptProjectSnapshot(request)
    const offset = this.offsetFromPosition(
      snapshot.files.get(snapshot.requestAbsolutePath) ?? '',
      request.position
    )
    // 标准库、node_modules 里声明的符号不能改名：改了只会把依赖的声明文件与本项目的引用一起改坏。
    const renameInfo = snapshot.service.getRenameInfo(snapshot.requestAbsolutePath, offset, {
      allowRenameOfImportPath: false,
    })
    if (!renameInfo.canRename)
      return { projectRoot: snapshot.projectRoot, path: snapshot.requestPath, changes: [] }
    const renameLocations =
      snapshot.service.findRenameLocations(snapshot.requestAbsolutePath, offset, false, false, {
        providePrefixAndSuffixTextForRename: false,
      }) ?? []
    const editsByPath = new Map<string, WorkbenchLanguageServiceFileEdit>()

    for (const location of renameLocations) {
      const range = this.rangeFromTextSpan(snapshot, location.fileName, location.textSpan)
      const relativePath = this.relativePathFor(snapshot.projectRoot, location.fileName)
      if (!range || !relativePath) {
        continue
      }

      const fileEdit =
        editsByPath.get(relativePath) ??
        ({
          path: relativePath,
          edits: [],
        } satisfies WorkbenchLanguageServiceFileEdit)
      fileEdit.edits.push({ range, newText: request.newName })
      editsByPath.set(relativePath, fileEdit)
    }

    return {
      projectRoot: snapshot.projectRoot,
      path: snapshot.requestPath,
      changes: [...editsByPath.values()],
    }
  }

  public async getHover(request: WorkbenchLanguageServicePositionRequest, signal?: AbortSignal): Promise<{
    projectRoot: string
    path: string
    hover: Nullable<WorkbenchLanguageServiceHoverResult>
  }> {
    const resolved = await this.resolveLanguageService(request)
    const descriptor = resolveBuiltinWorkbenchLanguageService(this.resolveToken(request))
    if (this.isExternalRuntime(resolved.service?.runtime)) {
      const external = await this.prepareExternal(request, resolved.projectRoot)
      if (this.isSuppressedHoverWord(
        external.content,
        request.position,
        descriptor?.hover?.suppressWords
      ))
        return { projectRoot: resolved.projectRoot, path: request.path, hover: null }
      const hover = await external.client.hover(
        external.absolutePath,
        external.content,
        this.languageServicePosition(request.position),
        signal
      )
      const result = hover ? buildExternalHoverResult(hover.contents) : null
      if (result) {
        const definitions = await external.client.definition(
          external.absolutePath,
          external.content,
          this.languageServicePosition(request.position),
          signal
        )
        const definition = definitions
          .map((location) => this.mapExternalLocation(resolved.projectRoot, location))
          .find(isPresent)
        if (definition) {
          result.definition = definition
          if (
            /^(?:export\s+)?(?:type|interface|class|enum|record|struct|protocol)\b/u.test(
              result.displayText.trim()
            )
          ) {
            const definitionContent = safeReadFile(
              this.resolveAbsoluteProjectPath(resolved.projectRoot, definition.path)
            ) ?? ''
            const text = buildExternalDefinitionPreview(definitionContent, definition.line)
            if (text) {
              result.definitionPreview = {
                kind: 'code',
                text,
                language: optionalWhen(!!descriptor?.documentLanguageId, descriptor?.documentLanguageId),
              }
            }
          }
        }
      }
      return {
        projectRoot: resolved.projectRoot,
        path: request.path,
        hover: result,
      }
    }
    if (resolved.service?.runtime === 'markdown-language-service') return this.withMarkdownLanguageService(request, resolved.projectRoot, async (markdown) => {
        const hover = await markdown.service.getHover(
          markdown.document,
          this.languageServicePosition(request.position),
          markdown.token
        )
        return {
          projectRoot: resolved.projectRoot,
          path: request.path,
          hover: hover ? buildExternalHoverResult(hover.contents) : null,
        }
      })
    if (resolved.service?.runtime !== 'typescript-language-service')
      return { projectRoot: resolved.projectRoot, path: request.path, hover: null }

    const snapshot = await this.createTypeScriptProjectSnapshot(request)
    const content = snapshot.files.get(snapshot.requestAbsolutePath) ?? ''
    return {
      projectRoot: snapshot.projectRoot,
      path: snapshot.requestPath,
      hover: buildTypeScriptHoverResult({
        service: snapshot.service,
        fileName: snapshot.requestAbsolutePath,
        content,
        position: request.position,
      }),
    }
  }

  public async getReferences(
    request: WorkbenchLanguageServicePositionRequest
  ): Promise<WorkbenchLanguageServiceReferencesResult> {
    const resolved = await this.resolveLanguageService(request)
    if (this.isExternalRuntime(resolved.service?.runtime)) {
      const external = await this.prepareExternal(request, resolved.projectRoot)
      const references = await external.client.references(
        external.absolutePath,
        external.content,
        this.languageServicePosition(request.position)
      )
      return {
        projectRoot: resolved.projectRoot,
        path: request.path,
        locations: this.withLocationPreviews(
          resolved.projectRoot,
          references
            .map((location) => this.mapExternalLocation(resolved.projectRoot, location))
            .filter((location): location is WorkbenchLanguageServiceLocation => isPresent(location)),
          this.editorContentReader(request, resolved.projectRoot)
        ),
      }
    }
    if (resolved.service?.runtime === 'markdown-language-service') return this.withMarkdownLanguageService(request, resolved.projectRoot, async (markdown) => {
        const references = await markdown.service.getReferences(
          markdown.document,
          this.languageServicePosition(request.position),
          { includeDeclaration: true },
          markdown.token
        )
        return {
          projectRoot: resolved.projectRoot,
          path: request.path,
          locations: this.withLocationPreviews(
            resolved.projectRoot,
            references
              .map((location) => this.mapMarkdownLocation(markdown, location))
              .filter((location): location is WorkbenchLanguageServiceLocation => isPresent(location)),
            this.editorContentReader(request, resolved.projectRoot)
          ),
        }
      })
    if (resolved.service?.runtime !== 'typescript-language-service')
      return { projectRoot: resolved.projectRoot, path: request.path, locations: [] }

    const snapshot = await this.createTypeScriptProjectSnapshot(request)
    const content = snapshot.files.get(snapshot.requestAbsolutePath) ?? ''
    const readFile = (fileName: string): Nullable<string> =>
      snapshot.files.get(normalizeTypeScriptFileName(fileName)) ?? safeReadFile(fileName)
    const locations = buildTypeScriptReferences({
      service: snapshot.service,
      fileName: snapshot.requestAbsolutePath,
      content,
      position: request.position,
      readFile,
      toRelativePath: (absolutePath) => this.relativePathFor(snapshot.projectRoot, absolutePath),
    })

    return {
      projectRoot: snapshot.projectRoot,
      path: snapshot.requestPath,
      locations: this.withLocationPreviews(snapshot.projectRoot, locations, readFile),
    }
  }

  /**
   * 给每个位置配上它那一行的文字（引用列表里挨着行号显示）。一个文件只读一次、只切一次行；读不到的、
   * 行号对不上的原样交回。
   */
  private withLocationPreviews(
    projectRoot: string,
    locations: WorkbenchLanguageServiceLocation[],
    readFile: (absolutePath: string) => Nullable<string>
  ): WorkbenchLanguageServiceLocation[] {
    const linesByPath = new Map<string, Nullable<string[]>>()
    return locations.map((location) => {
      let lines = linesByPath.get(location.path)
      if (lines === undefined) {
        const absolutePath = resolve(projectRoot, location.path)
        const content = this.pathResolver.isAllowedProjectPath(projectRoot, absolutePath)
          ? readFile(absolutePath)
          : null
        lines = isPresent(content) ? content.split('\n') : null
        linesByPath.set(location.path, lines)
      }
      const line = lines?.[location.line - 1]
      return line === undefined
        ? location
        : { ...location, preview: line.trim().slice(0, MaxLocationPreviewLength) }
    })
  }

  /** 一个文件此刻的正文：请求里带着的（请求文件、有未保存改动的标签）优先，别的读盘。 */
  private editorContentReader(
    request: WorkbenchLanguageServiceRequest,
    projectRoot: string
  ): (absolutePath: string) => Nullable<string> {
    const editorContents = new Map<string, string>()
    for (const openFile of request.openFiles ?? [])
      editorContents.set(resolve(projectRoot, openFile.path), openFile.content)
    if (request.content !== undefined)
      editorContents.set(resolve(projectRoot, request.path), request.content)
    return (absolutePath) => editorContents.get(absolutePath) ?? safeReadFile(absolutePath)
  }

  public async getSignatureHelp(
    request: WorkbenchLanguageServicePositionRequest,
    signal?: AbortSignal
  ): Promise<{
    projectRoot: string
    path: string
    signatureHelp: Nullable<WorkbenchLanguageServiceSignatureHelpResult>
  }> {
    const resolved = await this.resolveLanguageService(request)
    if (this.isExternalRuntime(resolved.service?.runtime)) {
      const external = await this.prepareExternal(request, resolved.projectRoot)
      const signatureHelp = await external.client.signatureHelp(
        external.absolutePath,
        external.content,
        this.languageServicePosition(request.position),
        signal
      )
      return {
        projectRoot: resolved.projectRoot,
        path: request.path,
        signatureHelp: signatureHelp ? this.mapExternalSignatureHelp(signatureHelp) : null,
      }
    }
    if (resolved.service?.runtime !== 'typescript-language-service')
      return { projectRoot: resolved.projectRoot, path: request.path, signatureHelp: null }

    const snapshot = await this.createTypeScriptProjectSnapshot(request)
    const content = snapshot.files.get(snapshot.requestAbsolutePath) ?? ''
    return {
      projectRoot: snapshot.projectRoot,
      path: snapshot.requestPath,
      signatureHelp: buildTypeScriptSignatureHelp({
        service: snapshot.service,
        fileName: snapshot.requestAbsolutePath,
        content,
        position: request.position,
      }),
    }
  }

  public async getFormat(
    request: WorkbenchLanguageServiceRequest
  ): Promise<WorkbenchLanguageServiceFormatResult> {
    const resolved = await this.resolveLanguageService(request)
    const projectRoot = resolved.projectRoot
    const absolutePath = this.resolveAbsoluteProjectPath(projectRoot, request.path)
    const content = request.content ?? safeReadFile(absolutePath) ?? ''

    const emptyResult: WorkbenchLanguageServiceFormatResult = {
      projectRoot,
      path: request.path,
      changes: [],
    }
    const wholeDocumentResult = (formatted: string): WorkbenchLanguageServiceFormatResult =>
      formatted === content
        ? emptyResult
        : {
            projectRoot,
            path: request.path,
            changes: [
              { path: request.path, edits: [buildWholeDocumentReplaceEdit(content, formatted)] },
            ],
          }

    if (resolved.service?.runtime === 'lsp-server') {
      const external = await this.prepareExternal(request, projectRoot)
      const edits = await external.client.format(external.absolutePath, external.content)
      return {
        projectRoot,
        path: request.path,
        changes: edits.length ? [{
          path: request.path,
          edits: edits.map((edit) => ({
            range: this.rangeFromLanguageServiceRange(edit.range),
            newText: edit.newText,
          })),
        }] : [],
      }
    }

    // 1) 项目 Prettier 优先：命中即为权威结果，不再回退内置。
    const prettierFormatted = await formatWorkbenchDocumentWithProjectPrettier({
      projectRoot,
      absolutePath,
      content,
    })
    if (isPresent(prettierFormatted)) return wholeDocumentResult(prettierFormatted)

    // 2) 内置 TS 家族：走 TS 语言服务格式化编辑。
    if (resolved.service?.runtime === 'typescript-language-service') {
      const snapshot = await this.createTypeScriptProjectSnapshot(request)
      const snapshotContent = snapshot.files.get(snapshot.requestAbsolutePath) ?? ''
      const edits = buildTypeScriptFormatEdits({
        service: snapshot.service,
        fileName: snapshot.requestAbsolutePath,
        content: snapshotContent,
        format: request.format,
      })
      return {
        projectRoot: snapshot.projectRoot,
        path: snapshot.requestPath,
        changes: edits.length ? [{ path: snapshot.requestPath, edits }] : [],
      }
    }

    // 3) 内置通用：JSON 美化 / 去行尾空白 + 补结尾换行。
    const builtinFormatted = formatWorkbenchDocumentBuiltin({
      extension: getWorkbenchPathExtension(request.path),
      content,
      format: request.format,
    })
    return isPresent(builtinFormatted) ? wholeDocumentResult(builtinFormatted) : emptyResult
  }

  public async getDocumentSymbols(
    request: WorkbenchLanguageServiceRequest
  ): Promise<WorkbenchLanguageServiceDocumentSymbolsResult> {
    const resolved = await this.resolveLanguageService(request)
    if (this.isExternalRuntime(resolved.service?.runtime)) {
      const external = await this.prepareExternal(request, resolved.projectRoot)
      const symbols = await external.client.documentSymbols(external.absolutePath, external.content)
      return {
        projectRoot: resolved.projectRoot,
        path: request.path,
        symbols: this.mapExternalDocumentSymbols(
          resolved.projectRoot,
          external.absolutePath,
          symbols
        ),
      }
    }
    if (resolved.service?.runtime === 'markdown-language-service') return this.withMarkdownLanguageService(request, resolved.projectRoot, async (markdown) => {
        const symbols = await markdown.service.getDocumentSymbols(
          markdown.document,
          { includeLinkDefinitions: true },
          markdown.token
        )
        const output: WorkbenchLanguageServiceDocumentSymbol[] = []
        const append = (symbol: (typeof symbols)[number], depth: number): void => {
          const range = this.rangeFromLanguageServiceRange(symbol.range)
          const selection = this.rangeFromLanguageServiceRange(symbol.selectionRange)
          output.push({
            name: symbol.name.replace(/^#{1,6}\s+/u, ''),
            kind: 'symbol',
            depth,
            line: selection.startLine,
            column: selection.startColumn,
            range,
          })
          for (const child of symbol.children ?? []) append(child, depth + 1)
        }
        for (const symbol of symbols) append(symbol, 0)
        return { projectRoot: resolved.projectRoot, path: request.path, symbols: output }
      })
    if (resolved.service?.runtime !== 'typescript-language-service')
      return { projectRoot: resolved.projectRoot, path: request.path, symbols: [] }

    const snapshot = await this.createTypeScriptProjectSnapshot(request)
    const content = snapshot.files.get(snapshot.requestAbsolutePath) ?? ''
    return {
      projectRoot: snapshot.projectRoot,
      path: snapshot.requestPath,
      symbols: buildTypeScriptDocumentSymbols({
        service: snapshot.service,
        fileName: snapshot.requestAbsolutePath,
        content,
      }),
    }
  }

  public async getDocumentHighlights(
    request: WorkbenchLanguageServicePositionRequest,
    signal?: AbortSignal
  ): Promise<WorkbenchLanguageServiceDocumentHighlightsResult> {
    const resolved = await this.resolveLanguageService(request)
    if (this.isExternalRuntime(resolved.service?.runtime)) {
      const external = await this.prepareExternal(request, resolved.projectRoot)
      const highlights = await external.client.documentHighlights(
        external.absolutePath,
        external.content,
        this.languageServicePosition(request.position),
        signal
      )
      return {
        projectRoot: resolved.projectRoot,
        path: request.path,
        highlights: this.mapExternalDocumentHighlights(highlights),
      }
    }
    if (resolved.service?.runtime === 'markdown-language-service') return this.withMarkdownLanguageService(request, resolved.projectRoot, async (markdown) => {
        const highlights = await markdown.service.getDocumentHighlights(
          markdown.document,
          this.languageServicePosition(request.position),
          markdown.token
        )
        return {
          projectRoot: resolved.projectRoot,
          path: request.path,
          highlights: highlights.map((highlight) => ({
            range: this.rangeFromLanguageServiceRange(highlight.range),
            kind: highlight.kind === 3 ? 'write' as const : 'read' as const,
          })),
        }
      })
    if (resolved.service?.runtime !== 'typescript-language-service')
      return { projectRoot: resolved.projectRoot, path: request.path, highlights: [] }

    const snapshot = await this.createTypeScriptProjectSnapshot(request)
    const content = snapshot.files.get(snapshot.requestAbsolutePath) ?? ''
    return {
      projectRoot: snapshot.projectRoot,
      path: snapshot.requestPath,
      highlights: buildTypeScriptDocumentHighlights({
        service: snapshot.service,
        fileName: snapshot.requestAbsolutePath,
        content,
        position: request.position,
      }),
    }
  }

  public async getInlayHints(
    request: WorkbenchLanguageServiceInlayHintsRequest,
    signal?: AbortSignal
  ): Promise<WorkbenchLanguageServiceInlayHintsResult> {
    const resolved = await this.resolveLanguageService(request)
    if (this.isExternalRuntime(resolved.service?.runtime)) {
      if (request.ranges.length > 10_000 || request.ranges.some((range) =>
        !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)
      ))
        return { projectRoot: resolved.projectRoot, path: request.path, hints: [] }
      const external = await this.prepareExternal(request, resolved.projectRoot)
      let start = request.ranges.length > 0 ? external.content.length : 0
      let end = request.ranges.length > 0 ? 0 : external.content.length
      for (const range of request.ranges) {
        const from = Math.min(Math.max(0, range.from), external.content.length)
        const to = Math.min(Math.max(0, range.to), external.content.length)
        start = Math.min(start, from, to)
        end = Math.max(end, from, to)
      }
      const hints = await external.client.inlayHints(external.absolutePath, external.content, {
        start: this.lspPositionFromOffset(external.content, start),
        end: this.lspPositionFromOffset(external.content, end),
      }, signal)
      return {
        projectRoot: resolved.projectRoot,
        path: request.path,
        hints: this.mapExternalInlayHints(external.content, hints),
      }
    }
    if (resolved.service?.runtime !== 'typescript-language-service')
      return { projectRoot: resolved.projectRoot, path: request.path, hints: [] }

    const snapshot = await this.createTypeScriptProjectSnapshot(request, !request.syncOpenFiles)
    const content = snapshot.files.get(snapshot.requestAbsolutePath) ?? ''
    return {
      projectRoot: snapshot.projectRoot,
      path: snapshot.requestPath,
      hints: buildTypeScriptInlayHints({
        service: snapshot.service,
        fileName: snapshot.requestAbsolutePath,
        content,
        ranges: request.ranges,
      }),
    }
  }

  public async getSemanticTokens(
    request: WorkbenchLanguageServiceRequest,
    signal?: AbortSignal
  ): Promise<WorkbenchLanguageServiceSemanticTokensResult> {
    const resolved = await this.resolveLanguageService(request)
    if (resolved.service?.runtime === 'typescript-language-service') {
      const snapshot = await this.createTypeScriptProjectSnapshot(request)
      const content = snapshot.files.get(snapshot.requestAbsolutePath) ?? ''
      return {
        projectRoot: snapshot.projectRoot,
        path: snapshot.requestPath,
        tokens: buildTypeScriptSemanticTokens({
          service: snapshot.service,
          fileName: snapshot.requestAbsolutePath,
          content,
        }),
      }
    }
    if (!this.isExternalRuntime(resolved.service?.runtime))
      return { projectRoot: resolved.projectRoot, path: request.path, tokens: [] }
    const external = await this.prepareExternal(request, resolved.projectRoot)
    const tokens = await external.client.semanticTokens(external.absolutePath, external.content, signal)
    return {
      projectRoot: resolved.projectRoot,
      path: request.path,
      tokens: this.mapExternalSemanticTokens(external.content, tokens),
    }
  }

  public async getCodeActions(
    request: WorkbenchLanguageServiceCodeActionsRequest
  ): Promise<WorkbenchLanguageServiceCodeActionsResult> {
    const resolved = await this.resolveLanguageService(request)
    if (resolved.service?.runtime === 'typescript-language-service') {
      const snapshot = await this.createTypeScriptProjectSnapshot(request)
      const context = this.typeScriptEditContext(snapshot, request)
      const range = this.offsetsFromRange(context.content, request.range)
      const categories = request.categories ?? ['quickfix']
      return {
        projectRoot: snapshot.projectRoot,
        path: snapshot.requestPath,
        actions: [
          ...(categories.includes('quickfix') ? buildTypeScriptQuickFixes(context, range) : []),
          ...(categories.includes('refactor') ? buildTypeScriptRefactors(context, range) : []),
        ],
      }
    }
    // 外部语言服务器只给修复：重构是内置 TypeScript 服务的。
    if (request.categories && !request.categories.includes('quickfix'))
      return { projectRoot: resolved.projectRoot, path: request.path, actions: [] }
    if (!this.isExternalRuntime(resolved.service?.runtime))
      return { projectRoot: resolved.projectRoot, path: request.path, actions: [] }
    const external = await this.prepareExternal(request, resolved.projectRoot)
    const actions = await external.client.codeActions(
      external.absolutePath,
      external.content,
      this.rangeToLanguageServiceRange(request.range),
      request.diagnostics.slice(0, 10_000).map((diagnostic) => ({
        range: this.rangeToLanguageServiceRange(diagnostic.range),
        severity: diagnostic.severity === 'error' ? 1 : diagnostic.severity === 'warning' ? 2 : 3,
        code: diagnostic.code,
        source: diagnostic.source,
        message: diagnostic.message,
      }))
    )
    return {
      projectRoot: resolved.projectRoot,
      path: request.path,
      actions: this.mapExternalCodeActions(resolved.projectRoot, actions),
    }
  }

  /** 选中了一个要现算的动作（TypeScript 的重构、「同类问题一起修」）：按请求里的正文算出它的改动。 */
  public async resolveCodeAction(
    request: WorkbenchLanguageServiceCodeActionResolveRequest
  ): Promise<WorkbenchLanguageServiceCodeActionResolveResult> {
    const resolved = await this.resolveLanguageService(request)
    if (resolved.service?.runtime !== 'typescript-language-service')
      return { projectRoot: resolved.projectRoot, path: request.path, changes: [], createFiles: [] }

    const snapshot = await this.createTypeScriptProjectSnapshot(request)
    const context = this.typeScriptEditContext(snapshot, request)
    const edit = resolveTypeScriptCodeAction(
      context,
      request.resolve,
      this.offsetsFromRange(context.content, request.range)
    )
    return {
      projectRoot: snapshot.projectRoot,
      path: snapshot.requestPath,
      changes: edit?.changes ?? [],
      createFiles: edit?.createFiles ?? [],
      renameLocation: edit?.renameLocation,
    }
  }

  /** 整理请求文件的 import；只有内置 TypeScript 服务照看的文件有。 */
  public async getOrganizeImports(
    request: WorkbenchLanguageServiceRequest
  ): Promise<WorkbenchLanguageServiceOrganizeImportsResult> {
    const resolved = await this.resolveLanguageService(request)
    if (resolved.service?.runtime !== 'typescript-language-service')
      return { projectRoot: resolved.projectRoot, path: request.path, changes: [] }

    const snapshot = await this.createTypeScriptProjectSnapshot(request)
    return {
      projectRoot: snapshot.projectRoot,
      path: snapshot.requestPath,
      changes: buildTypeScriptOrganizeImportsEdits(this.typeScriptEditContext(snapshot, request)),
    }
  }

  /**
   * 文件或目录在文件树里改了名 / 挪了位置（磁盘上已经改完）：引用它们的 import 该怎么改。只有挪的是
   * JavaScript / TypeScript 文件或含有它们的目录才有改动，别的直接答「没有」，连项目都不建。
   *
   * 问的不止被挪文件所在的那个项目（见 planTypeScriptFileRenameProjects）；每个项目都把挪到新位置的文件
   * 当作在场的文件带上——TypeScript 要在程序里找得到新位置的文件，才肯把指向旧位置的 import 改过去。
   */
  public async getFileRenameEdits(
    request: WorkbenchLanguageServiceFileRenameEditsRequest
  ): Promise<WorkbenchLanguageServiceFileRenameEditsResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const renames = request.renames.map((rename) => ({
      previousFileName: this.resolveAbsoluteProjectPath(projectRoot, rename.previousPath),
      fileName: this.resolveAbsoluteProjectPath(projectRoot, rename.path),
    }))
    // 旧位置的文件先退出项目，不然程序里新旧两份并存。
    for (const rename of renames) forgetMovedTypeScriptProjectPath(projectRoot, rename.previousFileName)

    const movedFileGroups = renames.map((rename) => readMovedTypeScriptFiles(projectRoot, rename.fileName))
    const overlayFiles = new Map<string, string>()
    for (const group of movedFileGroups) for (const [path, content] of group) overlayFiles.set(path, content)
    if (overlayFiles.size === 0) return { projectRoot, changes: [] }

    // 开着的标签按编辑缓冲里此刻的正文算。还挂在旧位置上的（标签没来得及跟着挪）不算数：那里已经没有文件了。
    for (const openFile of request.openFiles ?? []) {
      const absolutePath = this.resolveAbsoluteProjectPath(projectRoot, openFile.path)
      if (!TypeScriptExtensions.has(this.extensionWithDot(absolutePath))) continue
      if (renames.some((rename) => isPathInside(rename.previousFileName, absolutePath))) continue
      overlayFiles.set(absolutePath, openFile.content)
    }

    const merged = new Map<string, WorkbenchLanguageServiceFileEdit>()
    const requestFileNames = planTypeScriptFileRenameProjects(
      projectRoot,
      movedFileGroups.map((group) => [...group.keys()])
    )
    for (const requestFileName of requestFileNames) {
      const { service, files } = acquireTypeScriptLanguageService(
        projectRoot,
        requestFileName,
        [requestFileName],
        overlayFiles
      )
      mergeTypeScriptFileRenameEdits(
        merged,
        freezeTypeScriptProgramWhile(service, () =>
          buildTypeScriptFileRenameEdits(
            {
              service,
              fileName: requestFileName,
              content: files.get(requestFileName) ?? safeReadFile(requestFileName) ?? '',
              readFile: (fileName) => files.get(normalizeTypeScriptFileName(fileName)) ?? safeReadFile(fileName),
              toRelativePath: (fileName) => this.relativePathFor(projectRoot, fileName),
            },
            renames
          )
        )
      )
    }
    return { projectRoot, changes: [...merged.values()] }
  }

  /**
   * 请求位置上的函数的一层调用关系（谁调用它，或它调用谁）；只有内置 TypeScript 服务照看的文件有。
   * 往下一层由界面拿某个调用方 / 被调用方的位置再问一次。
   */
  public async getCallHierarchy(
    request: WorkbenchLanguageServiceCallHierarchyRequest
  ): Promise<WorkbenchLanguageServiceCallHierarchyResult> {
    const resolved = await this.resolveLanguageService(request)
    if (resolved.service?.runtime !== 'typescript-language-service')
      return { projectRoot: resolved.projectRoot, path: request.path, item: null, calls: [] }

    const snapshot = await this.createTypeScriptProjectSnapshot(request)
    const content = snapshot.files.get(snapshot.requestAbsolutePath) ?? ''
    return {
      projectRoot: snapshot.projectRoot,
      path: snapshot.requestPath,
      ...buildTypeScriptCallHierarchy(
        {
          service: snapshot.service,
          fileName: snapshot.requestAbsolutePath,
          offset: this.offsetFromPosition(content, request.position),
          readFile: (fileName) => snapshot.files.get(normalizeTypeScriptFileName(fileName)) ?? safeReadFile(fileName),
          toRelativePath: (fileName) => this.relativePathFor(snapshot.projectRoot, fileName),
        },
        request.direction
      ),
    }
  }

  private typeScriptEditContext(
    snapshot: TypeScriptProjectSnapshot,
    request: WorkbenchLanguageServiceRequest
  ): TypeScriptEditContext {
    return {
      service: snapshot.service,
      fileName: snapshot.requestAbsolutePath,
      content: snapshot.files.get(snapshot.requestAbsolutePath) ?? '',
      readFile: (fileName) => snapshot.files.get(normalizeTypeScriptFileName(fileName)) ?? safeReadFile(fileName),
      toRelativePath: (fileName) => this.relativePathFor(snapshot.projectRoot, fileName),
      format: request.format,
    }
  }

  private offsetsFromRange(
    content: string,
    range: WorkbenchLanguageServiceRange
  ): { start: number; end: number } {
    const start = this.offsetFromPosition(content, { line: range.startLine, column: range.startColumn })
    const end = this.offsetFromPosition(content, { line: range.endLine, column: range.endColumn })
    return { start: Math.min(start, end), end: Math.max(start, end) }
  }

  private resolveToken(request: WorkbenchLanguageServiceRequest): string {
    return (
      getWorkbenchPathExtension(request.path) || normalizeWorkbenchLanguage(request.language ?? '')
    )
  }

  private toServiceSnapshot(
    service: WorkbenchLanguageServiceDescriptor
  ): WorkbenchLanguageServiceDescriptorSnapshot {
    return {
      id: service.id,
      label: service.label,
      installKind: service.installKind,
      runtime: service.runtime,
      packageName: toOptional(service.packageName),
      command: toOptional(service.command),
      args: toOptional(service.args),
      documentLanguageId: toOptional(service.documentLanguageId),
      protocol: toOptional(service.protocol),
      extensionRequests: toOptional(service.extensionRequests?.map((request) => ({
        id: request.id,
        method: request.method,
        capabilityPath: [...request.capabilityPath],
      }))),
    }
  }

  private capabilitiesForBuiltinService(
    service: WorkbenchLanguageServiceDescriptor
  ): WorkbenchLanguageServiceCapability[] {
    if (service.runtime === 'typescript-language-service')
      return [
        'completion',
        'definition',
        'diagnostics',
        'rename',
        'hover',
        'references',
        'signature-help',
        'format',
        'document-symbols',
        'document-highlights',
        'inlay-hints',
        'semantic-tokens',
        'code-actions',
        'refactor',
        'organize-imports',
        'call-hierarchy',
      ]

    if (service.runtime === 'markdown-language-service')
      return [
        'completion',
        'definition',
        'diagnostics',
        'rename',
        'hover',
        'references',
        'format',
        'document-symbols',
        'document-highlights',
      ]

    if (service.runtime === 'lsp-server')
      return [
        'completion',
        'definition',
        'diagnostics',
        'rename',
        'hover',
        'references',
        'signature-help',
        'format',
        'document-symbols',
        'document-highlights',
        'inlay-hints',
        'semantic-tokens',
        'code-actions',
      ]
    if (service.runtime === 'python-language-server')
      return [
        'completion',
        'definition',
        'diagnostics',
        'rename',
        'hover',
        'references',
        'signature-help',
        'format',
        'document-symbols',
        'document-highlights',
        'inlay-hints',
        'semantic-tokens',
        'code-actions',
      ]
    return ['completion', 'diagnostics']
  }

  private async withMarkdownLanguageService<T>(
    request: WorkbenchLanguageServiceRequest,
    projectRoot: string,
    run: (context: WorkbenchMarkdownLanguageServiceContext) => Promise<T>
  ): Promise<T> {
    const absolutePath = this.resolveAbsoluteProjectPath(projectRoot, request.path)
    const openFiles = (request.openFiles ?? []).map((file) => ({
      absolutePath: this.resolveAbsoluteProjectPath(projectRoot, file.path),
      content: file.content,
    }))
    return withWorkbenchMarkdownLanguageService(
      {
        projectRoot,
        absolutePath,
        content: request.content ?? safeReadFile(absolutePath) ?? '',
        openFiles,
      },
      run
    )
  }

  private mapMarkdownLocation(
    markdown: WorkbenchMarkdownLanguageServiceContext,
    location: {
      uri: string
      range: {
        start: { line: number; character: number }
        end: { line: number; character: number }
      }
    }
  ): Nullable<WorkbenchLanguageServiceLocation> {
    let resource: URI
    try {
      resource = URI.parse(location.uri)
    } catch {
      return null
    }
    const path = markdown.toProjectRelativePath(resource)
    if (!path) return null
    const range = this.rangeFromLanguageServiceRange(location.range)
    return { path, line: range.startLine, column: range.startColumn, range }
  }

  private isExternalRuntime(
    runtime: WorkbenchLanguageServiceDescriptor['runtime'] | undefined
  ): boolean {
    return runtime === 'lsp-server' || runtime === 'python-language-server'
  }

  private async prepareExternal(
    request: WorkbenchLanguageServiceRequest,
    projectRoot: string
  ): Promise<{
    client: Awaited<ReturnType<ExternalLspManager['client']>>
    absolutePath: string
    content: string
  }> {
    const descriptor = resolveBuiltinWorkbenchLanguageService(this.resolveToken(request))
    if (!descriptor || !this.isExternalRuntime(descriptor.runtime))
      throw new Error(`Unsupported external language service for ${request.path}`)
    const absolutePath = this.resolveAbsoluteProjectPath(projectRoot, request.path)
    const runtimeRoot = resolveExternalLspRuntimeRoot(projectRoot, absolutePath, descriptor)
    const client = await this.externalLsp.client(projectRoot, descriptor, absolutePath)
    for (const openFile of request.openFiles ?? []) {
      const absoluteOpenPath = this.resolveAbsoluteProjectPath(projectRoot, openFile.path)
      if (!client.accepts(absoluteOpenPath)) continue
      if (resolveExternalLspRuntimeRoot(projectRoot, absoluteOpenPath, descriptor) !== runtimeRoot)
        continue
      await client.synchronize(absoluteOpenPath, openFile.content)
    }
    return {
      client,
      absolutePath,
      content: request.content ?? safeReadFile(absolutePath) ?? '',
    }
  }

  private mapExternalDiagnostic(
    path: string,
    diagnostic: ExternalLspDiagnostic
  ): WorkbenchLanguageServiceDiagnostic {
    return {
      path,
      severity: diagnostic.severity === 1 ? 'error' : diagnostic.severity === 2 ? 'warning' : 'info',
      message: diagnostic.message,
      source: diagnostic.source,
      code: diagnostic.code,
      range: this.rangeFromLanguageServiceRange(diagnostic.range),
    }
  }

  private mapExternalLocation(
    projectRoot: string,
    location: ExternalLspLocation
  ): Nullable<WorkbenchLanguageServiceLocation> {
    let absolutePath: string
    try {
      absolutePath = URI.parse(location.uri).fsPath
    } catch {
      return null
    }
    const path = this.relativePathFor(projectRoot, absolutePath)
    if (!path) return null
    const range = this.rangeFromLanguageServiceRange(location.range)
    return { path, line: range.startLine, column: range.startColumn, range }
  }

  private mapExternalWorkspaceEdit(
    projectRoot: string,
    workspaceEdit: ExternalLspWorkspaceEdit
  ): WorkbenchLanguageServiceFileEdit[] {
    const editsByPath = new Map<string, WorkbenchLanguageServiceFileEdit>()
    const append = (
      uri: string,
      edits: ReadonlyArray<{
        range: {
          start: { line: number; character: number }
          end: { line: number; character: number }
        }
        newText: string
      }>
    ): void => {
      let absolutePath: string
      try {
        absolutePath = URI.parse(uri).fsPath
      } catch {
        return
      }
      const path = this.relativePathFor(projectRoot, absolutePath)
      if (!path) return
      const file = editsByPath.get(path) ?? { path, edits: [] }
      file.edits.push(...edits.map((edit) => ({
        range: this.rangeFromLanguageServiceRange(edit.range),
        newText: edit.newText,
      })))
      editsByPath.set(path, file)
    }
    for (const [uri, edits] of Object.entries(workspaceEdit.changes ?? {})) append(uri, edits)
    for (const change of workspaceEdit.documentChanges ?? []) {
      const uri = change.textDocument?.uri
      if (uri && change.edits) append(uri, change.edits)
    }
    return [...editsByPath.values()]
  }

  private mapExternalSignatureHelp(
    value: ExternalLspSignatureHelp
  ): WorkbenchLanguageServiceSignatureHelpResult {
    return {
      activeSignature: value.activeSignature ?? 0,
      activeParameter: value.activeParameter ?? 0,
      signatures: value.signatures.map((signature) => ({
        label: signature.label,
        documentation: plainTextFromLspContent(signature.documentation),
        parameters: (signature.parameters ?? []).map((parameter) => ({
          label: Array.isArray(parameter.label)
            ? signature.label.slice(parameter.label[0], parameter.label[1])
            : parameter.label,
          documentation: plainTextFromLspContent(parameter.documentation),
        })),
      })),
    }
  }

  private mapExternalDocumentSymbols(
    projectRoot: string,
    requestAbsolutePath: string,
    values: ReadonlyArray<ExternalLspDocumentSymbol | ExternalLspSymbolInformation>
  ): WorkbenchLanguageServiceDocumentSymbol[] {
    const output: WorkbenchLanguageServiceDocumentSymbol[] = []
    const append = (
      value: ExternalLspDocumentSymbol | ExternalLspSymbolInformation,
      depth: number
    ): void => {
      const hierarchical = 'range' in value
      const location: ExternalLspLocation = hierarchical
        ? { uri: URI.file(requestAbsolutePath).toString(), range: value.selectionRange ?? value.range }
        : value.location
      const mapped = this.mapExternalLocation(projectRoot, location)
      const range = hierarchical
        ? this.rangeFromLanguageServiceRange(value.range)
        : mapped?.range
      if (mapped && range) {
        output.push({
          name: value.name,
          kind: mapExternalDocumentSymbolKind(value.kind),
          depth,
          line: mapped.line,
          column: mapped.column,
          range,
        })
      }
      if (hierarchical)
        for (const child of value.children ?? []) append(child, depth + 1)
    }
    for (const value of values) append(value, 0)
    return output
  }

  private mapExternalInlayHints(
    content: string,
    values: readonly ExternalLspInlayHint[]
  ): WorkbenchLanguageServiceInlayHintsResult['hints'] {
    // 编辑器按文档偏移放提示；只给行列的提示会被整个丢掉（此前外部语言服务器的提示一个都显示不出来）。
    const lineStarts = [0]
    for (let index = content.indexOf('\n'); index !== -1; index = content.indexOf('\n', index + 1))
      lineStarts.push(index + 1)
    return values.slice(0, 10_000).flatMap((value) => {
      if (value.kind !== undefined && value.kind !== 1) return []
      const text = typeof value.label === 'string'
        ? value.label
        : Array.isArray(value.label)
          ? value.label.map((part) => part?.value ?? '').join('')
          : ''
      if (!text || text.length > 1024 || !Number.isSafeInteger(value.position?.line)
        || !Number.isSafeInteger(value.position?.character) || value.position.line < 0
        || value.position.character < 0 || value.position.line >= lineStarts.length)
        return []
      const lineStart = lineStarts[value.position.line]!
      const lineEnd = (lineStarts[value.position.line + 1] ?? content.length + 1) - 1
      return [{
        position: {
          line: value.position.line + 1,
          column: value.position.character + 1,
          offset: Math.min(lineStart + value.position.character, lineEnd),
        },
        text,
        kind: 'type' as const,
        whitespaceBefore: value.paddingLeft,
        whitespaceAfter: value.paddingRight,
      }]
    })
  }

  private mapExternalDocumentHighlights(
    values: readonly ExternalLspDocumentHighlight[]
  ): WorkbenchLanguageServiceDocumentHighlightsResult['highlights'] {
    return values.slice(0, 10_000).flatMap((value) => {
      const range = value?.range
      if (!range || !Number.isSafeInteger(range.start?.line)
        || !Number.isSafeInteger(range.start?.character)
        || !Number.isSafeInteger(range.end?.line)
        || !Number.isSafeInteger(range.end?.character)
        || range.start.line < 0 || range.start.character < 0
        || range.end.line < 0 || range.end.character < 0)
        return []
      return [{
        range: this.rangeFromLanguageServiceRange(range),
        kind: value.kind === 3 ? 'write' as const : 'read' as const,
      }]
    })
  }

  private mapExternalSemanticTokens(
    content: string,
    value: ExternalLspSemanticTokens
  ): WorkbenchLanguageServiceSemanticTokensResult['tokens'] {
    if (value.data.length % 5 !== 0) return []
    const lines = content.split('\n')
    const output: WorkbenchLanguageServiceSemanticTokensResult['tokens'] = []
    let line = 0
    let character = 0
    for (let index = 0; index < value.data.length && output.length < 10_000; index += 5) {
      const deltaLine = value.data[index]!
      const deltaCharacter = value.data[index + 1]!
      const length = value.data[index + 2]!
      const typeIndex = value.data[index + 3]!
      const modifierBits = value.data[index + 4]!
      line += deltaLine
      character = deltaLine === 0 ? character + deltaCharacter : deltaCharacter
      const type = value.tokenTypes[typeIndex]
      const text = lines[line]
      if (!type || !text || length <= 0 || character < 0 || character + length > text.length) continue
      const tokenText = text.slice(character, character + length)
      const afterToken = text.slice(character + length)
      const correctedType = type === 'variable' && /^\s*\(/u.test(afterToken)
        ? 'function'
        : type === 'property' && /^\s*\(/u.test(afterToken)
          ? 'method'
          : type === 'variable' && /^[A-Z]/u.test(tokenText)
            ? 'type'
            : type
      output.push({
        range: {
          startLine: line + 1,
          startColumn: character + 1,
          endLine: line + 1,
          endColumn: character + length + 1,
        },
        type: correctedType,
        modifiers: value.tokenModifiers.filter((_modifier, modifierIndex) => (modifierBits & (1 << modifierIndex)) !== 0),
      })
    }
    return output
  }

  private mapExternalCodeActions(
    projectRoot: string,
    values: readonly ExternalLspCodeAction[]
  ): WorkbenchLanguageServiceCodeActionsResult['actions'] {
    return values.slice(0, 1_000).flatMap((value) => {
      if (!value || typeof value.title !== 'string' || !value.title || !value.edit) return []
      const changes = this.mapExternalWorkspaceEdit(projectRoot, value.edit)
      if (changes.length === 0) return []
      return [{ title: value.title, kind: value.kind, preferred: value.isPreferred, changes }]
    })
  }

  private getBuiltinLanguageServiceCompletions(
    request: WorkbenchLanguageServicePositionRequest,
    projectRoot: string,
    runtime: Nullable<WorkbenchLanguageServiceDescriptor['runtime']>
  ): WorkbenchLanguageServiceCompletionResult['items'] {
    if (runtime === 'html-language-service') {
      const document = this.createLanguageServiceDocument(request, projectRoot, 'html')
      const service = getHtmlLanguageService()
      const completions = service.doComplete(
        document,
        this.languageServicePosition(request.position),
        service.parseHTMLDocument(document)
      )
      return completions.items.map((item) =>
        mapLspCompletionItem(request.path, item, mapHtmlCompletionKind(item.kind))
      )
    }

    if (runtime === 'css-language-service') {
      const languageId = this.cssLanguageIdForPath(request.path)
      const document = this.createLanguageServiceDocument(request, projectRoot, languageId)
      const service = this.cssLanguageServiceForLanguageId(languageId)
      const completions = service.doComplete(
        document,
        this.languageServicePosition(request.position),
        service.parseStylesheet(document)
      )
      return completions.items.map((item) =>
        mapLspCompletionItem(request.path, item, mapCssCompletionKind(item.kind))
      )
    }

    return []
  }

  private getBuiltinLanguageServiceDiagnostics(
    request: WorkbenchLanguageServiceRequest,
    projectRoot: string,
    runtime: Nullable<WorkbenchLanguageServiceDescriptor['runtime']>
  ): WorkbenchLanguageServiceDiagnostic[] {
    if (runtime === 'html-language-service') return []

    if (runtime === 'css-language-service') {
      const languageId = this.cssLanguageIdForPath(request.path)
      const document = this.createLanguageServiceDocument(request, projectRoot, languageId)
      const service = this.cssLanguageServiceForLanguageId(languageId)
      return service
        .doValidation(document, service.parseStylesheet(document))
        .map((diagnostic) => ({
          path: request.path,
          severity: diagnostic.severity === 1 ? 'error' : 'warning',
          message: diagnostic.message,
          source: languageId,
          range: this.rangeFromLanguageServiceRange(diagnostic.range),
        }))
    }

    return []
  }

  private createLanguageServiceDocument(
    request: WorkbenchLanguageServiceRequest,
    projectRoot: string,
    languageId: string
  ): TextDocument {
    const absolutePath = this.resolveAbsoluteProjectPath(projectRoot, request.path)
    return TextDocument.create(
      URI.file(absolutePath).toString(),
      languageId,
      0,
      request.content ?? safeReadFile(absolutePath) ?? ''
    )
  }

  private languageServicePosition(position: WorkbenchLanguageServicePosition): {
    line: number
    character: number
  } {
    return {
      line: Math.max(0, position.line - 1),
      character: Math.max(0, position.column - 1),
    }
  }

  private lspPositionFromOffset(content: string, requestedOffset: number): {
    line: number
    character: number
  } {
    const offset = Math.min(Math.max(0, requestedOffset), content.length)
    const before = content.slice(0, offset)
    const line = before.split('\n').length - 1
    const newline = before.lastIndexOf('\n')
    return { line, character: newline === -1 ? offset : offset - newline - 1 }
  }

  private rangeFromLanguageServiceRange(range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }): WorkbenchLanguageServiceRange {
    return {
      startLine: range.start.line + 1,
      startColumn: range.start.character + 1,
      endLine: range.end.line + 1,
      endColumn: range.end.character + 1,
    }
  }

  private rangeToLanguageServiceRange(range: WorkbenchLanguageServiceRange): {
    start: { line: number; character: number }
    end: { line: number; character: number }
  } {
    return {
      start: { line: Math.max(0, range.startLine - 1), character: Math.max(0, range.startColumn - 1) },
      end: { line: Math.max(0, range.endLine - 1), character: Math.max(0, range.endColumn - 1) },
    }
  }

  private cssLanguageIdForPath(path: string): 'css' | 'less' | 'scss' {
    const extension = getWorkbenchPathExtension(path)
    if (extension === 'less') return 'less'
    if (extension === 'scss') return 'scss'
    return 'css'
  }

  private cssLanguageServiceForLanguageId(languageId: 'css' | 'less' | 'scss'): CssLanguageService {
    switch (languageId) {
      case 'less': {
        return getLESSLanguageService()
      }
      case 'scss': {
        return getSCSSLanguageService()
      }
      default: {
        return getCSSLanguageService()
      }
    }
  }

  private async createTypeScriptProjectSnapshot(
    request: WorkbenchLanguageServiceRequest,
    preserveExistingOverlays = false
  ): Promise<TypeScriptProjectSnapshot> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const requestAbsolutePath = this.resolveAbsoluteProjectPath(projectRoot, request.path)
    const requestContent = request.content ?? safeReadFile(requestAbsolutePath) ?? ''
    const overlayFiles = new Map<string, string>()
    const priorityPaths: string[] = [requestAbsolutePath]

    for (const openFile of request.openFiles ?? []) {
      const absolutePath = this.resolveAbsoluteProjectPath(projectRoot, openFile.path)
      if (TypeScriptExtensions.has(this.extensionWithDot(absolutePath))) {
        overlayFiles.set(absolutePath, openFile.content)
        priorityPaths.push(absolutePath)
      }
    }

    // 当前请求正文是实时缓冲区的权威值，最后写入可避免同路径的旧标签快照覆盖它。
    overlayFiles.set(requestAbsolutePath, requestContent)

    const { service, files } = acquireTypeScriptLanguageService(
      projectRoot,
      requestAbsolutePath,
      priorityPaths,
      overlayFiles,
      preserveExistingOverlays
    )

    return {
      projectRoot,
      requestPath: this.pathResolver.toProjectRelativePath(projectRoot, requestAbsolutePath),
      requestAbsolutePath,
      files,
      service,
    }
  }

  private resolveAbsoluteProjectPath(projectRoot: string, path: string): string {
    const absolutePath = resolve(projectRoot, path)
    this.pathResolver.assertAllowedProjectPath(projectRoot, absolutePath, path)
    return normalizeTypeScriptFileName(absolutePath)
  }

  private extensionWithDot(path: string): string {
    const index = path.lastIndexOf('.')
    return index === -1 ? '' : path.slice(index).toLowerCase()
  }

  private offsetFromPosition(content: string, position: WorkbenchLanguageServicePosition): number {
    if (isNumber(position.offset)) return Math.min(Math.max(0, position.offset), content.length)

    const lines = content.split('\n')
    const lineIndex = Math.min(Math.max(0, position.line - 1), Math.max(0, lines.length - 1))
    const lineOffset = lines.slice(0, lineIndex).reduce((sum, line) => sum + line.length + 1, 0)
    return Math.min(lineOffset + Math.max(0, position.column - 1), content.length)
  }

  private isSuppressedHoverWord(
    content: string,
    position: WorkbenchLanguageServicePosition,
    suppressedWords: readonly string[] | undefined
  ): boolean {
    if (!suppressedWords?.length) return false
    const offset = this.offsetFromPosition(content, position)
    let start = offset
    let end = offset
    while (start > 0 && /[\w$]/u.test(content[start - 1]!)) start -= 1
    while (end < content.length && /[\w$]/u.test(content[end]!)) end += 1
    if (start > 0 && content[start - 1] === '@') return false
    return start < end && suppressedWords.includes(content.slice(start, end))
  }

  private rangeFromTextSpan(
    snapshot: TypeScriptProjectSnapshot,
    fileName: string,
    textSpan: ts.TextSpan
  ): Nullable<WorkbenchLanguageServiceRange> {
    const content = snapshot.files.get(normalizeTypeScriptFileName(fileName)) ?? safeReadFile(fileName)
    if (!isPresent(content)) return null

    return rangeFromTextSpanInContent(content, fileName, textSpan)
  }

  private locationFromTextSpan(
    snapshot: TypeScriptProjectSnapshot,
    fileName: string,
    textSpan: ts.TextSpan
  ): Nullable<WorkbenchLanguageServiceLocation> {
    const relativePath = this.relativePathFor(snapshot.projectRoot, fileName)
    const range = this.rangeFromTextSpan(snapshot, fileName, textSpan)
    if (!relativePath || !range) return null

    return {
      path: relativePath,
      line: range.startLine,
      column: range.startColumn,
      range,
    }
  }

  private diagnosticFromTypeScript(
    snapshot: TypeScriptProjectSnapshot,
    diagnostic: ts.Diagnostic
  ): Nullable<WorkbenchLanguageServiceDiagnostic> {
    if (!diagnostic.file || !isNumber(diagnostic.start)) return null

    // Read line/column straight off the diagnostic's already-parsed SourceFile instead of
    // re-parsing the whole file once per diagnostic.
    const start = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
    const end = diagnostic.file.getLineAndCharacterOfPosition(
      diagnostic.start + (diagnostic.length ?? 1)
    )
    const range: WorkbenchLanguageServiceRange = {
      startLine: start.line + 1,
      startColumn: start.character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1,
    }
    const relativePath = this.relativePathFor(snapshot.projectRoot, diagnostic.file.fileName)
    if (!range || !relativePath) return null

    const severity =
      diagnostic.category === ts.DiagnosticCategory.Error
        ? 'error'
        : diagnostic.category === ts.DiagnosticCategory.Warning
          ? 'warning'
          : 'info'

    return {
      path: relativePath,
      severity,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      source: 'typescript',
      code: typeof diagnostic.code === 'number' ? diagnostic.code : undefined,
      deprecated: isTypeScriptDeprecatedDiagnostic(diagnostic),
      range,
    }
  }

  private relativePathFor(projectRoot: string, absolutePath: string): Nullable<string> {
    if (!this.pathResolver.isAllowedProjectPath(projectRoot, absolutePath)) return null

    return this.pathResolver.toProjectRelativePath(projectRoot, absolutePath)
  }
}

export { WorkbenchLanguageServices }
