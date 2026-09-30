/**
 * 语言智能 IPC 装配：handle 各个语言服务动词通道，转发给串行执行的语言服务 worker。
 *
 * IPC 入参是边界外来数据，在此解析一次（形状不符按无效请求处理），worker 内部只见类型。
 * 所有请求最终落在 tsserver 项目托管上（projectRoot 键控，无 session 轴）；worker 首个请求
 * 时惰性拉起。异常经 `callWithEnvelope` 降为错误信封，renderer 据此展示启动错误并回落。
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'

import type { ModelSelection } from '@velaros-ai/model/contracts'

import type {
  WorkbenchLanguageServiceCodeActionsRequest,
  WorkbenchLanguageServiceCompletionResolveRequest,
  WorkbenchLanguageServiceDiagnostic,
  WorkbenchLanguageServiceEditFormat,
  WorkbenchLanguageServiceExtensionRequest,
  WorkbenchLanguageServiceInlayHintsRequest,
  WorkbenchLanguageServiceOffsetRange,
  WorkbenchLanguageServiceOpenFile,
  WorkbenchLanguageServicePosition,
  WorkbenchLanguageServicePositionRequest,
  WorkbenchLanguageServiceProjectDiagnosticsRequest,
  WorkbenchLanguageServiceRange,
  WorkbenchLanguageServiceRenameRequest,
  WorkbenchLanguageServiceRequest,
} from '@shared/contracts'

import {
  type WorkbenchInlineCompletionBridgeRequest,
  WorkbenchLanguageChannels,
} from '../../../shared/workbenchLanguage'
import {
  callWithEnvelope,
  hasStringFields,
  invalidRequest,
  isRecord,
  optionalNumber,
  optionalString,
} from '../ipcBoundary'

import type { WorkbenchLanguageServiceWorkerClient } from './LanguageServiceWorkerClient'
import type { WorkbenchInlineCompletionGenerator } from './WorkbenchInlineCompletion'

export function registerWorkbenchLanguageServiceIpc(
  client: WorkbenchLanguageServiceWorkerClient,
  inlineCompletion: WorkbenchInlineCompletionGenerator
): void {
  ipcMain.handle(WorkbenchLanguageChannels.definition, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parsePositionRequest(request)
      if (!parsed) return invalidRequest()

      return client.getDefinition(parsed)
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.completions, (event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parsePositionRequest(request)
      if (!parsed) return invalidRequest()

      return client.getCompletions(parsed, supersedeScope(event))
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.completionResolve, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseCompletionResolveRequest(request)
      if (!parsed) return invalidRequest()

      return client.resolveCompletion(parsed)
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.diagnostics, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseRequest(request)
      if (!parsed) return invalidRequest()

      return client.getDiagnostics(parsed)
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.projectDiagnostics, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseProjectDiagnosticsRequest(request)
      if (!parsed) return invalidRequest()

      return client.getProjectDiagnostics(parsed)
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.rename, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseRenameRequest(request)
      if (!parsed) return invalidRequest()

      return client.getRename(parsed)
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.hover, (event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parsePositionRequest(request)
      if (!parsed) return invalidRequest()

      return client.getHover(parsed, supersedeScope(event))
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.references, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parsePositionRequest(request)
      if (!parsed) return invalidRequest()

      return client.getReferences(parsed)
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.signatureHelp, (event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parsePositionRequest(request)
      if (!parsed) return invalidRequest()

      return client.getSignatureHelp(parsed, supersedeScope(event))
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.format, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseRequest(request)
      if (!parsed) return invalidRequest()

      return client.getFormat(parsed)
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.documentSymbols, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseRequest(request)
      if (!parsed) return invalidRequest()

      return client.getDocumentSymbols(parsed)
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.documentHighlights, (event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parsePositionRequest(request)
      if (!parsed) return invalidRequest()

      return client.getDocumentHighlights(parsed, supersedeScope(event))
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.inlayHints, (event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseInlayHintsRequest(request)
      if (!parsed) return invalidRequest()

      return client.getInlayHints(parsed, supersedeScope(event))
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.semanticTokens, (event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseRequest(request)
      if (!parsed) return invalidRequest()

      return client.getSemanticTokens(parsed, supersedeScope(event))
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.codeActions, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseCodeActionsRequest(request)
      if (!parsed) return invalidRequest()

      return client.getCodeActions(parsed)
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.extension, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseExtensionRequest(request)
      if (!parsed) return invalidRequest()

      return client.requestExtension(parsed)
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.inlineCompletion, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseInlineCompletionRequest(request)
      if (!parsed) return invalidRequest()

      return inlineCompletion.generate(parsed)
    })
  )
}

/** 同一窗口里同一文件的新请求顶掉旧的（见 isWorkbenchLanguageServiceOperationSuperseded）。 */
function supersedeScope(event: IpcMainInvokeEvent): { scope: string } {
  return { scope: String(event.sender.id) }
}

function parseInlineCompletionRequest(
  input: unknown
): Nullable<WorkbenchInlineCompletionBridgeRequest> {
  if (!hasStringFields(input, ['projectRoot', 'language', 'prefix', 'suffix'])) return null
  const modelSelection = input['modelSelection']
  if (!hasStringFields(modelSelection, ['provider', 'model', 'apiKey', 'baseURL'])) return null

  return {
    projectRoot: input['projectRoot'] as string,
    language: input['language'] as string,
    prefix: input['prefix'] as string,
    suffix: input['suffix'] as string,
    ...optionalString(input, 'path'),
    modelSelection: {
      provider: modelSelection['provider'] as ModelSelection['provider'],
      model: modelSelection['model'] as string,
      apiKey: modelSelection['apiKey'] as string,
      baseURL: modelSelection['baseURL'] as string,
    },
  }
}

function parseRequest(input: unknown): Nullable<WorkbenchLanguageServiceRequest> {
  if (!hasStringFields(input, ['projectRoot', 'path'])) return null

  return {
    projectRoot: input['projectRoot'] as string,
    path: input['path'] as string,
    ...optionalString(input, 'language'),
    ...optionalString(input, 'content'),
    ...parseOpenFiles(input['openFiles']),
    format: parseEditFormat(input['format']),
  }
}

/** 缩进设置不对（不是整数、离谱的宽度）就当没给，语言服务用自己的默认值。 */
function parseEditFormat(input: unknown): WorkbenchLanguageServiceEditFormat | undefined {
  if (!isRecord(input)) return undefined
  const { tabSize, indentSize, insertSpaces } = input
  if (!isIndentWidth(tabSize) || !isIndentWidth(indentSize) || typeof insertSpaces !== 'boolean')
    return undefined

  return { tabSize, indentSize, insertSpaces }
}

function isIndentWidth(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 16
}

function parsePositionRequest(input: unknown): Nullable<WorkbenchLanguageServicePositionRequest> {
  const base = parseRequest(input)
  if (!base || !isRecord(input)) return null

  const position = parsePosition(input['position'])
  if (!position) return null

  return { ...base, position }
}

function parseProjectDiagnosticsRequest(
  input: unknown
): Nullable<WorkbenchLanguageServiceProjectDiagnosticsRequest> {
  if (!hasStringFields(input, ['projectRoot'])) return null
  const anchorPaths = input['anchorPaths']
  if (!Array.isArray(anchorPaths) || anchorPaths.length > 256) return null
  if (!anchorPaths.every((path) => typeof path === 'string')) return null
  const cursor = input['cursor']
  if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 4096)) return null

  return {
    projectRoot: input['projectRoot'] as string,
    anchorPaths: anchorPaths as string[],
    cursor: cursor as string | undefined,
    ...parseOpenFiles(input['openFiles']),
  }
}

function parseCompletionResolveRequest(
  input: unknown
): Nullable<WorkbenchLanguageServiceCompletionResolveRequest> {
  const base = parsePositionRequest(input)
  if (!base || !isRecord(input)) return null
  const item = input['item']
  if (!hasStringFields(item, ['name'])) return null
  const data = item['data']
  if (data !== undefined && (!isRecord(data) || Array.isArray(data))) return null
  if (data !== undefined) {
    try {
      if (JSON.stringify(data).length > 64 * 1024) return null
    } catch {
      return null
    }
  }

  return {
    ...base,
    item: {
      name: item['name'] as string,
      ...optionalString(item, 'source'),
      data: data as Record<string, unknown> | undefined,
    },
  }
}

function parseRenameRequest(input: unknown): Nullable<WorkbenchLanguageServiceRenameRequest> {
  const base = parsePositionRequest(input)
  if (!base || !isRecord(input) || typeof input['newName'] !== 'string') return null

  return { ...base, newName: input['newName'] }
}

function parseExtensionRequest(
  input: unknown
): Nullable<WorkbenchLanguageServiceExtensionRequest> {
  const base = parseRequest(input)
  if (!base || !isRecord(input) || typeof input['requestId'] !== 'string') return null
  const requestId = input['requestId'].trim()
  if (!requestId || requestId.length > 128) return null
  const rawParameters = input['parameters']
  if (rawParameters !== undefined && !isRecord(rawParameters)) return null
  if (rawParameters !== undefined) {
    try {
      if (JSON.stringify(rawParameters).length > 256 * 1024) return null
    } catch {
      return null
    }
  }
  return {
    ...base,
    requestId,
    parameters: rawParameters,
  }
}

function parseInlayHintsRequest(input: unknown): Nullable<WorkbenchLanguageServiceInlayHintsRequest> {
  const base = parseRequest(input)
  if (!base || !isRecord(input) || typeof input['syncOpenFiles'] !== 'boolean') return null

  const rawRanges = input['ranges']
  if (!Array.isArray(rawRanges)) return null

  const ranges: WorkbenchLanguageServiceOffsetRange[] = []
  for (const rawRange of rawRanges) {
    if (!isRecord(rawRange)) return null
    if (typeof rawRange['from'] !== 'number' || typeof rawRange['to'] !== 'number') return null
    ranges.push({ from: rawRange['from'], to: rawRange['to'] })
  }

  return { ...base, ranges, syncOpenFiles: input['syncOpenFiles'] }
}

function parseCodeActionsRequest(input: unknown): Nullable<WorkbenchLanguageServiceCodeActionsRequest> {
  const base = parseRequest(input)
  if (!base || !isRecord(input)) return null
  const range = parseRange(input['range'])
  if (!range || !Array.isArray(input['diagnostics']) || input['diagnostics'].length > 10_000)
    return null
  const diagnostics: WorkbenchLanguageServiceDiagnostic[] = []
  for (const value of input['diagnostics']) {
    if (!isRecord(value) || typeof value['path'] !== 'string'
      || typeof value['message'] !== 'string' || !['error', 'warning', 'info'].includes(String(value['severity'])))
      return null
    const diagnosticRange = parseRange(value['range'])
    if (!diagnosticRange) return null
    const code = value['code']
    if (code !== undefined && typeof code !== 'string' && typeof code !== 'number') return null
    diagnostics.push({
      path: value['path'],
      severity: value['severity'] as WorkbenchLanguageServiceDiagnostic['severity'],
      message: value['message'],
      ...optionalString(value, 'source'),
      code,
      range: diagnosticRange,
    })
  }
  return { ...base, range, diagnostics }
}

function parseRange(input: unknown): Nullable<WorkbenchLanguageServiceRange> {
  if (!isRecord(input)) return null
  const keys = ['startLine', 'startColumn', 'endLine', 'endColumn'] as const
  if (keys.some((key) => typeof input[key] !== 'number')) return null
  return {
    startLine: input['startLine'] as number,
    startColumn: input['startColumn'] as number,
    endLine: input['endLine'] as number,
    endColumn: input['endColumn'] as number,
  }
}

function parsePosition(input: unknown): Nullable<WorkbenchLanguageServicePosition> {
  if (!isRecord(input)) return null
  if (typeof input['line'] !== 'number' || typeof input['column'] !== 'number') return null

  return {
    line: input['line'],
    column: input['column'],
    ...optionalNumber(input, 'offset'),
  }
}

function parseOpenFiles(input: unknown): { openFiles?: WorkbenchLanguageServiceOpenFile[] } {
  if (!Array.isArray(input)) return {}

  const openFiles: WorkbenchLanguageServiceOpenFile[] = []
  for (const rawFile of input) {
    if (!isRecord(rawFile)) continue
    if (typeof rawFile['path'] !== 'string' || typeof rawFile['content'] !== 'string') continue
    openFiles.push({
      path: rawFile['path'],
      content: rawFile['content'],
      ...optionalNumber(rawFile, 'version'),
    })
  }

  return { openFiles }
}
