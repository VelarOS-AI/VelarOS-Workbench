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
  WorkbenchLanguageServiceCodeActionsRequest,
  WorkbenchLanguageServiceCodeActionsResult,
  WorkbenchLanguageServiceCompletionResult,
  WorkbenchLanguageServiceDefinitionResult,
  WorkbenchLanguageServiceDescriptorSnapshot,
  WorkbenchLanguageServiceDiagnostic,
  WorkbenchLanguageServiceDiagnosticsResult,
  WorkbenchLanguageServiceDocumentHighlightsResult,
  WorkbenchLanguageServiceDocumentSymbol,
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
  WorkbenchLanguageServiceSemanticTokensResult,
  WorkbenchLanguageServiceSignatureHelpResult,
} from '@shared/contracts'
import {
  getWorkbenchPathExtension,
  normalizeWorkbenchLanguage,
  resolveBuiltinWorkbenchLanguageService,
  type WorkbenchLanguageServiceDescriptor,
} from '@shared/language/workbenchLanguageServices'

import {
  type ExternalLspCodeAction,
  type ExternalLspCompletionItem,
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
} from './ExternalLspClient'
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
  buildTypeScriptSemanticTokens,
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

export interface WorkbenchLanguagePathResolver {
  resolveProjectRoot(input: string): Promise<string>
  assertAllowedProjectPath(projectRoot: string, absolutePath: string, inputPath: string): void
  isAllowedProjectPath(projectRoot: string, absolutePath: string): boolean
  toProjectRelativePath(projectRoot: string, absolutePath: string): string
}

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

function cleanHoverMarkdown(value: string): string {
  return value
    .replace(/\x5b([^\x5d]+)\x5d\([^\s)]+\)/gu, '$1')
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .trim()
}

export function buildExternalHoverResult(contents: unknown): Nullable<WorkbenchLanguageServiceHoverResult> {
  const text = textFromLspContent(contents).trim()
  if (!text) return null

  const codeAndDocumentation = text.match(
    /^(?:```[^\n]*\n([\s\S]*?)\n```|``([\s\S]*?)``|`([^`\n]+)`)(?:\s*\n\s*\n([\s\S]*))?$/u
  )
  if (!codeAndDocumentation) return { displayText: cleanHoverMarkdown(text) }

  const displayText = (codeAndDocumentation[1]
    ?? codeAndDocumentation[2]
    ?? codeAndDocumentation[3]
    ?? '').trim()
  const documentation = cleanHoverMarkdown(codeAndDocumentation[4] ?? '')
  if (!displayText && !documentation) return null
  return {
    displayText: displayText || documentation,
    documentation: displayText && documentation ? documentation : undefined,
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
    case 5: return 'class'
    case 6: return 'method'
    case 10: return 'enum'
    case 11: return 'interface'
    case 12: return 'function'
    case 13: return 'variable'
    case 14: return 'constant'
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
    if (this.isExternalRuntime(resolved.service?.runtime)) {
      const external = await this.prepareExternal(request, resolved.projectRoot)
      const items = await external.client.completion(
        external.absolutePath,
        external.content,
        this.languageServicePosition(request.position)
      )
      return {
        projectRoot: resolved.projectRoot,
        path: request.path,
        items: items.slice(0, 160).map((item) => this.mapExternalCompletion(request.path, item)),
      }
    }
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
    if (this.isExternalRuntime(resolved.service?.runtime)) {
      const external = await this.prepareExternal(request, resolved.projectRoot)
      const diagnostics = await external.client.getDiagnostics(external.absolutePath, external.content)
      return {
        projectRoot: resolved.projectRoot,
        path: request.path,
        diagnostics: diagnostics.map((diagnostic) => this.mapExternalDiagnostic(request.path, diagnostic)),
      }
    }
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
        this.languageServicePosition(request.position)
      )
      return {
        projectRoot: resolved.projectRoot,
        path: request.path,
        hover: hover ? buildExternalHoverResult(hover.contents) : null,
      }
    }
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
        locations: references
          .map((location) => this.mapExternalLocation(resolved.projectRoot, location))
          .filter((location): location is WorkbenchLanguageServiceLocation => isPresent(location)),
      }
    }
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
    if (this.isExternalRuntime(resolved.service?.runtime)) {
      const external = await this.prepareExternal(request, resolved.projectRoot)
      const signatureHelp = await external.client.signatureHelp(
        external.absolutePath,
        external.content,
        this.languageServicePosition(request.position)
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
    if (this.isExternalRuntime(resolved.service?.runtime)) {
      const external = await this.prepareExternal(request, resolved.projectRoot)
      const highlights = await external.client.documentHighlights(
        external.absolutePath,
        external.content,
        this.languageServicePosition(request.position)
      )
      return {
        projectRoot: resolved.projectRoot,
        path: request.path,
        highlights: this.mapExternalDocumentHighlights(highlights),
      }
    }
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
      })
      return {
        projectRoot: resolved.projectRoot,
        path: request.path,
        hints: this.mapExternalInlayHints(hints),
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
    request: WorkbenchLanguageServiceRequest
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
    const tokens = await external.client.semanticTokens(external.absolutePath, external.content)
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
    const client = await this.externalLsp.client(projectRoot, descriptor)
    for (const openFile of request.openFiles ?? []) {
      const absoluteOpenPath = this.resolveAbsoluteProjectPath(projectRoot, openFile.path)
      if (!client.accepts(absoluteOpenPath)) continue
      await client.synchronize(absoluteOpenPath, openFile.content)
    }
    const absolutePath = this.resolveAbsoluteProjectPath(projectRoot, request.path)
    return {
      client,
      absolutePath,
      content: request.content ?? safeReadFile(absolutePath) ?? '',
    }
  }

  private mapExternalCompletion(
    path: string,
    item: ExternalLspCompletionItem
  ): WorkbenchLanguageServiceCompletionResult['items'][number] {
    return {
      label: item.label,
      kind: mapExternalCompletionKind(item.kind),
      detail: item.detail,
      documentation: textFromLspContent(item.documentation) || undefined,
      insertText: item.textEdit?.newText ?? item.insertText,
      sortText: item.sortText,
      filterText: item.filterText,
      isSnippet: item.insertTextFormat === 2,
      additionalTextEdits: item.additionalTextEdits?.map((edit) => ({
        path,
        range: this.rangeFromLanguageServiceRange(edit.range),
        newText: edit.newText,
      })),
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
        documentation: textFromLspContent(signature.documentation) || undefined,
        parameters: (signature.parameters ?? []).map((parameter) => ({
          label: Array.isArray(parameter.label)
            ? signature.label.slice(parameter.label[0], parameter.label[1])
            : parameter.label,
          documentation: textFromLspContent(parameter.documentation) || undefined,
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
    values: readonly ExternalLspInlayHint[]
  ): WorkbenchLanguageServiceInlayHintsResult['hints'] {
    return values.slice(0, 10_000).flatMap((value) => {
      if (value.kind !== undefined && value.kind !== 1) return []
      const text = typeof value.label === 'string'
        ? value.label
        : Array.isArray(value.label)
          ? value.label.map((part) => part?.value ?? '').join('')
          : ''
      if (!text || text.length > 1024 || !Number.isSafeInteger(value.position?.line)
        || !Number.isSafeInteger(value.position?.character) || value.position.line < 0
        || value.position.character < 0)
        return []
      return [{
        position: { line: value.position.line + 1, column: value.position.character + 1 },
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
    return start < end && suppressedWords.includes(content.slice(start, end))
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
