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
import { URI } from 'vscode-uri'

import { isNumber,isPresent, toNullable, toOptional } from '@velaros-ai/core'
import type {
  WorkbenchLanguageServiceCapability,
  WorkbenchLanguageServiceCompletionResult,
  WorkbenchLanguageServiceDefinitionResult,
  WorkbenchLanguageServiceDescriptorSnapshot,
  WorkbenchLanguageServiceDiagnostic,
  WorkbenchLanguageServiceDiagnosticsResult,
  WorkbenchLanguageServiceDocumentHighlightsResult,
  WorkbenchLanguageServiceDocumentSymbolsResult,
  WorkbenchLanguageServiceFileEdit,
  WorkbenchLanguageServiceFormatResult,
  WorkbenchLanguageServiceHoverResult,
  WorkbenchLanguageServiceInlayHintsRequest,
  WorkbenchLanguageServiceInlayHintsResult,
  WorkbenchLanguageServiceLocation,
  WorkbenchLanguageServicePosition,
  WorkbenchLanguageServicePositionRequest,
  WorkbenchLanguageServiceRange,
  WorkbenchLanguageServiceReferencesResult,
  WorkbenchLanguageServiceRenameRequest,
  WorkbenchLanguageServiceRenameResult,
  WorkbenchLanguageServiceRequest,
  WorkbenchLanguageServiceResolveResult,
  WorkbenchLanguageServiceSignatureHelpResult,
} from '@velaros-ai/core/types'
import {
  getWorkbenchPathExtension,
  normalizeWorkbenchLanguage,
  resolveBuiltinWorkbenchLanguageService,
  resolvePluginWorkbenchLanguageService,
  type WorkbenchLanguageServiceDescriptor,
} from '@velaros-ai/workbench/language/workbenchLanguageServices'

import type { PathResolver } from '../PathResolver'

import {
  clearWorkbenchProjectEslintCache,
  getWorkbenchJavaScriptLintDiagnostics,
} from './JavaScriptLinting'
import type {
  WorkbenchLanguageServiceProjectFileRequest,
  WorkbenchLanguageServiceProjectRequest,
} from './LanguageServiceWorkerProtocol'
import { buildTypeScriptCompletionItems } from './TypeScriptCompletions'
import {
  buildTypeScriptDocumentHighlights,
  buildTypeScriptDocumentSymbols,
  buildTypeScriptFormatEdits,
  buildTypeScriptHoverResult,
  buildTypeScriptInlayHints,
  buildTypeScriptReferences,
  buildTypeScriptSignatureHelp,
  isTypeScriptDeprecatedDiagnostic,
} from './TypeScriptLanguageFeatures'
import {
  acquireTypeScriptLanguageService,
  clearTypeScriptProjectCache,
  safeReadFile,
  synchronizeTypeScriptProjectFile,
  TypeScriptExtensions,
} from './TypeScriptProjectHost'
import {
  buildWholeDocumentReplaceEdit,
  clearWorkbenchProjectPrettierCache,
  formatWorkbenchDocumentBuiltin,
  formatWorkbenchDocumentWithProjectPrettier,
} from './WorkbenchDocumentFormatter'

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

interface TypeScriptProjectSnapshot {
  projectRoot: string
  requestPath: string
  requestAbsolutePath: string
  files: Map<string, string>
  service: ts.LanguageService
}

class WorkbenchLanguageServices {
  constructor(private readonly pathResolver: PathResolver) {}

  public async synchronizeProjectFile(
    request: WorkbenchLanguageServiceProjectFileRequest
  ): Promise<void> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const absolutePath = this.resolveAbsoluteProjectPath(projectRoot, request.path)
    synchronizeTypeScriptProjectFile(projectRoot, absolutePath, request.content)
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
  }

  public async resolveLanguageService(
    request: WorkbenchLanguageServiceRequest
  ): Promise<WorkbenchLanguageServiceResolveResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const token = this.resolveToken(request)
    const builtin = resolveBuiltinWorkbenchLanguageService(token)
    const plugin = builtin ? null : resolvePluginWorkbenchLanguageService(token)
    const service = builtin ?? plugin

    return {
      projectRoot,
      path: request.path,
      languageId: token || 'text',
      status: builtin ? 'ready' : plugin ? 'plugin-required' : 'unsupported',
      service: service ? this.toServiceSnapshot(service) : null,
      capabilities: builtin ? this.capabilitiesForBuiltinService(builtin) : [],
    }
  }

  public async getDefinition(
    request: WorkbenchLanguageServicePositionRequest
  ): Promise<WorkbenchLanguageServiceDefinitionResult> {
    const resolved = await this.resolveLanguageService(request)
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
    request: WorkbenchLanguageServicePositionRequest
  ): Promise<WorkbenchLanguageServiceCompletionResult> {
    const resolved = await this.resolveLanguageService(request)
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
    const offset = this.offsetFromPosition(
      snapshot.files.get(snapshot.requestAbsolutePath) ?? '',
      request.position
    )

    return {
      projectRoot: snapshot.projectRoot,
      path: snapshot.requestPath,
      items: buildTypeScriptCompletionItems({
        service: snapshot.service,
        fileName: snapshot.requestAbsolutePath,
        offset,
        files: snapshot.files,
        toRelativePath: (absolutePath) => this.relativePathFor(snapshot.projectRoot, absolutePath),
      }),
    }
  }

  public async getDiagnostics(
    request: WorkbenchLanguageServiceRequest
  ): Promise<WorkbenchLanguageServiceDiagnosticsResult> {
    const resolved = await this.resolveLanguageService(request)
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
    if (resolved.service?.runtime !== 'typescript-language-service')
      return { projectRoot: resolved.projectRoot, path: request.path, changes: [] }

    const snapshot = await this.createTypeScriptProjectSnapshot(request)
    const offset = this.offsetFromPosition(
      snapshot.files.get(snapshot.requestAbsolutePath) ?? '',
      request.position
    )
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

  public async getHover(request: WorkbenchLanguageServicePositionRequest): Promise<{
    projectRoot: string
    path: string
    hover: Nullable<WorkbenchLanguageServiceHoverResult>
  }> {
    const resolved = await this.resolveLanguageService(request)
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
    if (resolved.service?.runtime !== 'typescript-language-service')
      return { projectRoot: resolved.projectRoot, path: request.path, locations: [] }

    const snapshot = await this.createTypeScriptProjectSnapshot(request)
    const content = snapshot.files.get(snapshot.requestAbsolutePath) ?? ''
    const locations = buildTypeScriptReferences({
      service: snapshot.service,
      fileName: snapshot.requestAbsolutePath,
      content,
      position: request.position,
      files: snapshot.files,
      toRelativePath: (absolutePath) => this.relativePathFor(snapshot.projectRoot, absolutePath),
    })

    return {
      projectRoot: snapshot.projectRoot,
      path: snapshot.requestPath,
      locations,
    }
  }

  public async getSignatureHelp(request: WorkbenchLanguageServicePositionRequest): Promise<{
    projectRoot: string
    path: string
    signatureHelp: Nullable<WorkbenchLanguageServiceSignatureHelpResult>
  }> {
    const resolved = await this.resolveLanguageService(request)
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
    })
    return isPresent(builtinFormatted) ? wholeDocumentResult(builtinFormatted) : emptyResult
  }

  public async getDocumentSymbols(
    request: WorkbenchLanguageServiceRequest
  ): Promise<WorkbenchLanguageServiceDocumentSymbolsResult> {
    const resolved = await this.resolveLanguageService(request)
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
    request: WorkbenchLanguageServicePositionRequest
  ): Promise<WorkbenchLanguageServiceDocumentHighlightsResult> {
    const resolved = await this.resolveLanguageService(request)
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
    request: WorkbenchLanguageServiceInlayHintsRequest
  ): Promise<WorkbenchLanguageServiceInlayHintsResult> {
    const resolved = await this.resolveLanguageService(request)
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
      ]

    return ['completion', 'diagnostics']
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
      return completions.items.slice(0, 120).map((item) => ({
        label: item.label,
        kind: mapHtmlCompletionKind(item.kind),
        detail: item.detail,
        insertText: item.textEdit ? item.textEdit.newText : item.insertText,
      }))
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
      return completions.items.slice(0, 120).map((item) => ({
        label: item.label,
        kind: mapCssCompletionKind(item.kind),
        detail: item.detail,
        insertText: item.textEdit ? item.textEdit.newText : item.insertText,
      }))
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

  private cssLanguageIdForPath(path: string): 'css' | 'less' | 'scss' {
    const extension = getWorkbenchPathExtension(path)
    if (extension === 'less') return 'less'
    if (extension === 'scss' || extension === 'sass') return 'scss'
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
    return absolutePath
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

  private rangeFromTextSpan(
    snapshot: TypeScriptProjectSnapshot,
    fileName: string,
    textSpan: ts.TextSpan
  ): Nullable<WorkbenchLanguageServiceRange> {
    const content = snapshot.files.get(fileName) ?? safeReadFile(fileName)
    if (!isPresent(content)) return null

    const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true)
    const start = sourceFile.getLineAndCharacterOfPosition(textSpan.start)
    const end = sourceFile.getLineAndCharacterOfPosition(textSpan.start + textSpan.length)

    return {
      startLine: start.line + 1,
      startColumn: start.character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1,
    }
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
