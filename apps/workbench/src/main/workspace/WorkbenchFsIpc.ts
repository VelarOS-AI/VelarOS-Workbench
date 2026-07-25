/**
 * 项目工作区 IPC 装配：handle 纯读/写族/双搜索/命令/本地历史通道，异常降为错误信封。
 *
 * IPC 入参是边界外来数据，在此解析一次（形状不符按无效请求处理），服务内部只见类型。
 * `saveFileSync` 走 `ipcMain.on` + `event.returnValue`（renderer sendSync 的 beforeunload
 * 兜底路径）；`runCommand` 的流式输出只回发给发起请求的 webContents。
 */
import { ipcMain } from 'electron'

import type {
  WorkbenchCreateEntryRequest,
  WorkbenchDeleteEntryRequest,
  WorkbenchListDirectoryRequest,
  WorkbenchListLocalHistoryRequest,
  WorkbenchMoveEntryRequest,
  WorkbenchReadFileRequest,
  WorkbenchReadLocalHistorySnapshotRequest,
  WorkbenchRenameEntryRequest,
  WorkbenchRestoreDeletedEntryRequest,
  WorkbenchRunCommandRequest,
  WorkbenchSaveFileRequest,
  WorkbenchSearchContentRequest,
  WorkbenchSearchEntriesRequest,
} from '@velaros-ai/core/types'

import { WorkbenchFsChannels } from '../../shared/workbenchFs'

import {
  callWithEnvelope,
  callWithEnvelopeSync,
  hasStringFields,
  invalidRequest,
  optionalBoolean,
  optionalNumber,
  optionalString,
} from './ipcBoundary'
import type { WorkbenchAppParts } from './Parts'
import type { WorkbenchProjectFileSystem } from './WorkbenchProjectFileSystem'

export function registerWorkbenchFsIpc(
  fileSystem: WorkbenchProjectFileSystem,
  parts: WorkbenchAppParts
): void {
  ipcMain.handle(WorkbenchFsChannels.listDirectory, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseListDirectoryRequest(request)
      if (!parsed) return invalidRequest()

      return fileSystem.listDirectory(parsed)
    })
  )

  ipcMain.handle(WorkbenchFsChannels.readFile, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseReadFileRequest(request)
      if (!parsed) return invalidRequest()

      return fileSystem.readTextFile(parsed)
    })
  )

  ipcMain.handle(WorkbenchFsChannels.saveFile, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseSaveFileRequest(request)
      if (!parsed) return invalidRequest()

      return parts.files.saveFile(parsed)
    })
  )

  ipcMain.on(WorkbenchFsChannels.saveFileSync, (event, request: unknown) => {
    event.returnValue = callWithEnvelopeSync(() => {
      const parsed = parseSaveFileRequest(request)
      if (!parsed) return invalidRequest()

      return parts.files.saveFileSync(parsed)
    })
  })

  ipcMain.handle(WorkbenchFsChannels.createEntry, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseCreateEntryRequest(request)
      if (!parsed) return invalidRequest()

      return parts.files.createEntry(parsed)
    })
  )

  ipcMain.handle(WorkbenchFsChannels.renameEntry, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseRenameEntryRequest(request)
      if (!parsed) return invalidRequest()

      return parts.files.renameEntry(parsed)
    })
  )

  ipcMain.handle(WorkbenchFsChannels.moveEntry, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseMoveEntryRequest(request)
      if (!parsed) return invalidRequest()

      return parts.files.moveEntry(parsed)
    })
  )

  ipcMain.handle(WorkbenchFsChannels.deleteEntry, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseDeleteEntryRequest(request)
      if (!parsed) return invalidRequest()

      return parts.files.deleteEntry(parsed)
    })
  )

  ipcMain.handle(WorkbenchFsChannels.restoreDeletedEntry, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseRestoreDeletedEntryRequest(request)
      if (!parsed) return invalidRequest()

      return parts.files.restoreDeletedEntry(parsed)
    })
  )

  ipcMain.handle(WorkbenchFsChannels.listLocalHistory, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseListLocalHistoryRequest(request)
      if (!parsed) return invalidRequest()

      return Promise.resolve(parts.files.listLocalHistory(parsed))
    })
  )

  ipcMain.handle(WorkbenchFsChannels.readLocalHistorySnapshot, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseReadLocalHistorySnapshotRequest(request)
      if (!parsed) return invalidRequest()

      return Promise.resolve(parts.files.readLocalHistorySnapshot(parsed))
    })
  )

  ipcMain.handle(WorkbenchFsChannels.searchEntries, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseSearchEntriesRequest(request)
      if (!parsed) return invalidRequest()

      return parts.search.searchEntries(parsed)
    })
  )

  ipcMain.handle(WorkbenchFsChannels.searchContent, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseSearchContentRequest(request)
      if (!parsed) return invalidRequest()

      return parts.search.searchContent(parsed)
    })
  )

  ipcMain.handle(WorkbenchFsChannels.runCommand, (event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseRunCommandRequest(request)
      if (!parsed) return invalidRequest()

      const sender = event.sender
      return parts.commands.runCommand(parsed, (outputEvent) => {
        if (!sender.isDestroyed()) {
          sender.send(WorkbenchFsChannels.runCommandOutput, outputEvent)
        }
      })
    })
  )
}

function parseListDirectoryRequest(input: unknown): Nullable<WorkbenchListDirectoryRequest> {
  if (!hasStringFields(input, ['projectRoot'])) return null

  return {
    projectRoot: input['projectRoot'] as string,
    ...optionalString(input, 'path'),
    ...optionalBoolean(input, 'includeHidden'),
    ...optionalNumber(input, 'limit'),
  }
}

function parseReadFileRequest(input: unknown): Nullable<WorkbenchReadFileRequest> {
  if (!hasStringFields(input, ['projectRoot', 'path'])) return null

  return {
    projectRoot: input['projectRoot'] as string,
    path: input['path'] as string,
    ...optionalNumber(input, 'maxChars'),
  }
}

function parseSaveFileRequest(input: unknown): Nullable<WorkbenchSaveFileRequest> {
  if (!hasStringFields(input, ['projectRoot', 'path', 'content'])) return null

  return {
    projectRoot: input['projectRoot'] as string,
    path: input['path'] as string,
    content: input['content'] as string,
    ...optionalNumber(input, 'expectedModifiedAt'),
    ...optionalNumber(input, 'expectedSize'),
    ...optionalNumber(input, 'localHistoryMinIntervalMs'),
  }
}

function parseCreateEntryRequest(input: unknown): Nullable<WorkbenchCreateEntryRequest> {
  if (!hasStringFields(input, ['projectRoot', 'name'])) return null

  const type = input['type']
  if (type !== 'directory' && type !== 'file') return null

  return {
    projectRoot: input['projectRoot'] as string,
    name: input['name'] as string,
    type,
    ...optionalString(input, 'parentPath'),
  }
}

function parseRenameEntryRequest(input: unknown): Nullable<WorkbenchRenameEntryRequest> {
  if (!hasStringFields(input, ['projectRoot', 'path', 'newName'])) return null

  return {
    projectRoot: input['projectRoot'] as string,
    path: input['path'] as string,
    newName: input['newName'] as string,
  }
}

function parseMoveEntryRequest(input: unknown): Nullable<WorkbenchMoveEntryRequest> {
  if (!hasStringFields(input, ['projectRoot', 'path', 'parentPath'])) return null

  return {
    projectRoot: input['projectRoot'] as string,
    path: input['path'] as string,
    parentPath: input['parentPath'] as string,
    ...optionalString(input, 'name'),
  }
}

function parseDeleteEntryRequest(input: unknown): Nullable<WorkbenchDeleteEntryRequest> {
  if (!hasStringFields(input, ['projectRoot', 'path'])) return null

  return {
    projectRoot: input['projectRoot'] as string,
    path: input['path'] as string,
  }
}

function parseRestoreDeletedEntryRequest(
  input: unknown
): Nullable<WorkbenchRestoreDeletedEntryRequest> {
  if (!hasStringFields(input, ['projectRoot', 'restoreId'])) return null

  return {
    projectRoot: input['projectRoot'] as string,
    restoreId: input['restoreId'] as string,
  }
}

function parseListLocalHistoryRequest(input: unknown): Nullable<WorkbenchListLocalHistoryRequest> {
  if (!hasStringFields(input, ['projectRoot', 'path'])) return null

  return {
    projectRoot: input['projectRoot'] as string,
    path: input['path'] as string,
  }
}

function parseReadLocalHistorySnapshotRequest(
  input: unknown
): Nullable<WorkbenchReadLocalHistorySnapshotRequest> {
  if (!hasStringFields(input, ['projectRoot', 'path', 'id'])) return null

  return {
    projectRoot: input['projectRoot'] as string,
    path: input['path'] as string,
    id: input['id'] as string,
  }
}

function parseSearchEntriesRequest(input: unknown): Nullable<WorkbenchSearchEntriesRequest> {
  if (!hasStringFields(input, ['projectRoot', 'query'])) return null

  return {
    projectRoot: input['projectRoot'] as string,
    query: input['query'] as string,
    ...optionalString(input, 'path'),
    ...optionalBoolean(input, 'includeHidden'),
    ...optionalNumber(input, 'limit'),
    ...optionalNumber(input, 'maxDepth'),
  }
}

function parseSearchContentRequest(input: unknown): Nullable<WorkbenchSearchContentRequest> {
  if (!hasStringFields(input, ['projectRoot', 'query'])) return null

  return {
    projectRoot: input['projectRoot'] as string,
    query: input['query'] as string,
    ...optionalString(input, 'path'),
    ...optionalBoolean(input, 'includeHidden'),
    ...optionalNumber(input, 'limit'),
    ...optionalNumber(input, 'maxDepth'),
    ...optionalNumber(input, 'maxResultsPerFile'),
  }
}

function parseRunCommandRequest(input: unknown): Nullable<WorkbenchRunCommandRequest> {
  if (!hasStringFields(input, ['projectRoot', 'command'])) return null

  return {
    projectRoot: input['projectRoot'] as string,
    command: input['command'] as string,
    ...optionalString(input, 'runId'),
    ...optionalString(input, 'cwd'),
    ...optionalNumber(input, 'timeoutMs'),
    ...optionalNumber(input, 'maxOutputChars'),
  }
}
