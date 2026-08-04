/**
 * 语言智能 IPC 装配：handle 13 个语言服务动词通道，转发给串行执行的语言服务 worker。
 *
 * IPC 入参是边界外来数据，在此解析一次（形状不符按无效请求处理），worker 内部只见类型。
 * 所有请求最终落在 tsserver 项目托管上（projectRoot 键控，无 session 轴）；worker 首个请求
 * 时惰性拉起。异常经 `callWithEnvelope` 降为错误信封，renderer 侧灰跑分支据此静默回落。
 */
import { ipcMain } from 'electron'

import type {
  WorkbenchLanguageServiceCodeActionsRequest,
  WorkbenchLanguageServiceDiagnostic,
  WorkbenchLanguageServiceInlayHintsRequest,
  WorkbenchLanguageServiceOffsetRange,
  WorkbenchLanguageServiceOpenFile,
  WorkbenchLanguageServicePosition,
  WorkbenchLanguageServicePositionRequest,
  WorkbenchLanguageServiceRange,
  WorkbenchLanguageServiceRenameRequest,
  WorkbenchLanguageServiceRequest,
} from '@shared/contracts'

import { WorkbenchLanguageChannels } from '../../../shared/workbenchLanguage'
import {
  callWithEnvelope,
  hasStringFields,
  invalidRequest,
  isRecord,
  optionalNumber,
  optionalString,
} from '../ipcBoundary'

import type { WorkbenchLanguageServiceWorkerClient } from './LanguageServiceWorkerClient'

export function registerWorkbenchLanguageServiceIpc(
  client: WorkbenchLanguageServiceWorkerClient
): void {
  ipcMain.handle(WorkbenchLanguageChannels.definition, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parsePositionRequest(request)
      if (!parsed) return invalidRequest()

      return client.getDefinition(parsed)
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.completions, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parsePositionRequest(request)
      if (!parsed) return invalidRequest()

      return client.getCompletions(parsed)
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.diagnostics, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseRequest(request)
      if (!parsed) return invalidRequest()

      return client.getDiagnostics(parsed)
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.rename, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseRenameRequest(request)
      if (!parsed) return invalidRequest()

      return client.getRename(parsed)
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.hover, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parsePositionRequest(request)
      if (!parsed) return invalidRequest()

      return client.getHover(parsed)
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.references, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parsePositionRequest(request)
      if (!parsed) return invalidRequest()

      return client.getReferences(parsed)
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.signatureHelp, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parsePositionRequest(request)
      if (!parsed) return invalidRequest()

      return client.getSignatureHelp(parsed)
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

  ipcMain.handle(WorkbenchLanguageChannels.documentHighlights, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parsePositionRequest(request)
      if (!parsed) return invalidRequest()

      return client.getDocumentHighlights(parsed)
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.inlayHints, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseInlayHintsRequest(request)
      if (!parsed) return invalidRequest()

      return client.getInlayHints(parsed)
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.semanticTokens, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseRequest(request)
      if (!parsed) return invalidRequest()

      return client.getSemanticTokens(parsed)
    })
  )

  ipcMain.handle(WorkbenchLanguageChannels.codeActions, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseCodeActionsRequest(request)
      if (!parsed) return invalidRequest()

      return client.getCodeActions(parsed)
    })
  )
}

function parseRequest(input: unknown): Nullable<WorkbenchLanguageServiceRequest> {
  if (!hasStringFields(input, ['projectRoot', 'path'])) return null

  return {
    projectRoot: input['projectRoot'] as string,
    path: input['path'] as string,
    ...optionalString(input, 'language'),
    ...optionalString(input, 'content'),
    ...parseOpenFiles(input['openFiles']),
  }
}

function parsePositionRequest(input: unknown): Nullable<WorkbenchLanguageServicePositionRequest> {
  const base = parseRequest(input)
  if (!base || !isRecord(input)) return null

  const position = parsePosition(input['position'])
  if (!position) return null

  return { ...base, position }
}

function parseRenameRequest(input: unknown): Nullable<WorkbenchLanguageServiceRenameRequest> {
  const base = parsePositionRequest(input)
  if (!base || !isRecord(input) || typeof input['newName'] !== 'string') return null

  return { ...base, newName: input['newName'] }
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
      ...(code === undefined ? {} : { code }),
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
