/**
 * 项目工作区 IPC 装配：handle 纯读/写族/双搜索（含快速打开的文件清单）/命令/本地历史通道，异常降为
 * 错误信封。
 *
 * IPC 入参是边界外来数据，在此解析一次（形状不符按无效请求处理），服务内部只见类型。
 * `saveFileSync` 走 `ipcMain.on` + `event.returnValue`（renderer sendSync 的 beforeunload
 * 兜底路径）；`runCommand` 的流式输出只回发给发起请求的 webContents。
 *
 * 带 searchId 的内容搜索边搜边把结果推回发起它的窗口（`searchContentProgress`），可以按 id 取消；窗口关了，
 * 它还没搜完的都取消。
 *
 * 写族通道只由用户在界面上的动作触发（编辑器保存、文件树里新建 / 改名 / 移动 / 删除 / 恢复）；Agent 的
 * 写入走项目内核，不经这里。写成功后把路径报给改动归属账本：这些改动是用户亲手做的，正在跑的那一轮
 * 不能把它们算成 Agent 的，回溯时也不能替用户撤掉。
 */
import { resolve } from 'node:path'

import { ipcMain, type WebContents } from 'electron'

import { AppError } from '@velaros-ai/core/error'

import { type WorkbenchCopyEntryRequest, type WorkbenchCreateEntryRequest, type WorkbenchDeleteEntryRequest, type WorkbenchFindExistingFilesRequest, type WorkbenchInspectDeleteEntryRequest, type WorkbenchListDirectoryRequest, type WorkbenchListLocalHistoryRequest, type WorkbenchListProjectFilesRequest, type WorkbenchMoveEntryRequest, type WorkbenchReadFileRequest, type WorkbenchReadImageFileRequest, type WorkbenchReadLocalHistorySnapshotRequest, type WorkbenchRenameEntryRequest, type WorkbenchReplaceContentFileRequest, type WorkbenchReplaceContentRequest, type WorkbenchRestoreDeletedEntryRequest, type WorkbenchRestoreMissingFileRequest, type WorkbenchRunCommandRequest, type WorkbenchSaveFileRequest, type WorkbenchSearchContentRequest, type WorkbenchSearchEntriesRequest } from '@shared/contracts/workbench'
import {
  isWorkbenchTextEncoding,
  isWorkbenchTextEol,
  type WorkbenchTextFormat,
} from '@shared/workbenchTextFormat'

import { WorkbenchFsChannels } from '../../shared/workbenchFs'
import { workbenchMainText } from '../i18n/workbenchMainMessages'
import type { WorkbenchWindowManager } from '../projects/WorkbenchWindowManager'

import type { WorkbenchUserWriteSink } from './git/WorkbenchChatRunAttribution'
import {
  callWithEnvelope,
  callWithEnvelopeSync,
  hasStringFields,
  invalidRequest,
  isRecord,
  optionalBoolean,
  optionalNumber,
  optionalString,
  optionalStringArray,
} from './ipcBoundary'
import type { WorkbenchAppParts } from './Parts'
import type { WorkbenchProjectFileSystem } from './WorkbenchProjectFileSystem'

export function registerWorkbenchFsIpc(
  fileSystem: WorkbenchProjectFileSystem,
  parts: WorkbenchAppParts,
  windowManager: WorkbenchWindowManager,
  userWrites?: WorkbenchUserWriteSink
): void {
  /** 写成功之后才报：没写成的不算动过。路径相对项目根。 */
  const recordUserWrites = <T>(
    result: T,
    workspaceRoot: string,
    paths: (result: T) => string[]
  ): T => {
    userWrites?.recordUserWrites({ workspaceRoot, paths: paths(result) })
    return result
  }

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

  ipcMain.handle(WorkbenchFsChannels.findExistingFiles, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseFindExistingFilesRequest(request)
      if (!parsed) return invalidRequest()

      return fileSystem.findExistingFiles(parsed)
    })
  )

  ipcMain.handle(WorkbenchFsChannels.readImageFile, (event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseReadImageFileRequest(request)
      if (!parsed) return invalidRequest()

      const currentProject = windowManager.getHubForWebContents(event.sender)
        ?.getState().currentProject
      if (!currentProject || resolve(parsed.projectRoot) !== resolve(currentProject.path)) {
        throw new AppError('PERMISSION', workbenchMainText('files.imageNotInWindow'))
      }

      return fileSystem.readImageFile({ ...parsed, projectRoot: currentProject.path })
    })
  )

  ipcMain.handle(WorkbenchFsChannels.saveFile, (_event, request: unknown) =>
    callWithEnvelope(async () => {
      const parsed = parseSaveFileRequest(request)
      if (!parsed) return invalidRequest()

      return recordUserWrites(await parts.files.saveFile(parsed), parsed.projectRoot, () => [
        parsed.path,
      ])
    })
  )

  ipcMain.on(WorkbenchFsChannels.saveFileSync, (event, request: unknown) => {
    event.returnValue = callWithEnvelopeSync(() => {
      const parsed = parseSaveFileRequest(request)
      if (!parsed) return invalidRequest()

      return recordUserWrites(parts.files.saveFileSync(parsed), parsed.projectRoot, () => [
        parsed.path,
      ])
    })
  })

  ipcMain.handle(WorkbenchFsChannels.createEntry, (_event, request: unknown) =>
    callWithEnvelope(async () => {
      const parsed = parseCreateEntryRequest(request)
      if (!parsed) return invalidRequest()

      return recordUserWrites(
        await parts.files.createEntry(parsed),
        parsed.projectRoot,
        (result) => [result.entry.path]
      )
    })
  )

  ipcMain.handle(WorkbenchFsChannels.renameEntry, (_event, request: unknown) =>
    callWithEnvelope(async () => {
      const parsed = parseRenameEntryRequest(request)
      if (!parsed) return invalidRequest()

      return recordUserWrites(
        await parts.files.renameEntry(parsed),
        parsed.projectRoot,
        (result) => [parsed.path, result.entry.path]
      )
    })
  )

  ipcMain.handle(WorkbenchFsChannels.copyEntry, (_event, request: unknown) =>
    callWithEnvelope(async () => {
      const parsed = parseCopyEntryRequest(request)
      if (!parsed) return invalidRequest()

      return recordUserWrites(
        await parts.files.copyEntry(parsed),
        parsed.projectRoot,
        (result) => [result.entry.path]
      )
    })
  )

  ipcMain.handle(WorkbenchFsChannels.moveEntry, (_event, request: unknown) =>
    callWithEnvelope(async () => {
      const parsed = parseMoveEntryRequest(request)
      if (!parsed) return invalidRequest()

      return recordUserWrites(
        await parts.files.moveEntry(parsed),
        parsed.projectRoot,
        (result) => [result.previousPath, result.entry.path]
      )
    })
  )

  ipcMain.handle(WorkbenchFsChannels.inspectDeleteEntry, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseInspectDeleteEntryRequest(request)
      if (!parsed) return invalidRequest()

      return parts.files.inspectDeleteEntry(parsed)
    })
  )

  ipcMain.handle(WorkbenchFsChannels.deleteEntry, (_event, request: unknown) =>
    callWithEnvelope(async () => {
      const parsed = parseDeleteEntryRequest(request)
      if (!parsed) return invalidRequest()

      return recordUserWrites(
        await parts.files.deleteEntry(parsed),
        parsed.projectRoot,
        (result) => [result.deletedPath]
      )
    })
  )

  ipcMain.handle(WorkbenchFsChannels.restoreDeletedEntry, (_event, request: unknown) =>
    callWithEnvelope(async () => {
      const parsed = parseRestoreDeletedEntryRequest(request)
      if (!parsed) return invalidRequest()

      return recordUserWrites(
        await parts.files.restoreDeletedEntry(parsed),
        parsed.projectRoot,
        (result) => [result.restoredPath]
      )
    })
  )

  ipcMain.handle(WorkbenchFsChannels.restoreMissingFile, (_event, request: unknown) =>
    callWithEnvelope(async () => {
      const parsed = parseRestoreMissingFileRequest(request)
      if (!parsed) return invalidRequest()

      return recordUserWrites(
        await parts.files.restoreMissingFile(parsed),
        parsed.projectRoot,
        () => [parsed.path]
      )
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

  const contentSearches = createContentSearchRegistry()

  ipcMain.handle(WorkbenchFsChannels.searchContent, (event, request: unknown) =>
    callWithEnvelope(async () => {
      const parsed = parseSearchContentRequest(request)
      if (!parsed) return invalidRequest()

      const searchId = parsed.searchId
      if (!searchId) return parts.search.searchContent(parsed)

      const sender = event.sender
      const { senderId, search } = contentSearches.begin(sender, searchId)
      try {
        return await parts.search.searchContent(parsed, {
          signal: search.signal,
          onBatch: (batch) => {
            if (!sender.isDestroyed())
              sender.send(WorkbenchFsChannels.searchContentProgress, { searchId, ...batch })
          },
        })
      } finally {
        contentSearches.end(senderId, searchId, search)
      }
    })
  )

  ipcMain.handle(WorkbenchFsChannels.replaceContent, (_event, request: unknown) =>
    callWithEnvelope(async () => {
      const parsed = parseReplaceContentRequest(request)
      if (!parsed) return invalidRequest()

      return recordUserWrites(
        await parts.replace.replaceContent(parsed),
        parsed.projectRoot,
        (result) => result.files.filter((file) => file.replacedCount > 0).map((file) => file.path)
      )
    })
  )

  ipcMain.handle(WorkbenchFsChannels.cancelSearchContent, (event, request: unknown) =>
    callWithEnvelope(() => {
      if (!hasStringFields(request, ['searchId'])) return invalidRequest()

      contentSearches.cancel(event.sender.id, request['searchId'] as string)
      return Promise.resolve()
    })
  )

  ipcMain.handle(WorkbenchFsChannels.listProjectFiles, (_event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseListProjectFilesRequest(request)
      if (!parsed) return invalidRequest()

      return parts.search.listProjectFiles(parsed)
    })
  )

  ipcMain.handle(WorkbenchFsChannels.runCommand, (event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseRunCommandRequest(request)
      if (!parsed) return invalidRequest()

      const sender = event.sender
      // 命令面板里的命令是用户自己输入、自己点运行（或按快捷键重跑自己的上一条）的：用户就是确认者，
      // 这里没有也不需要再弹确认卡。Velar Agent 程序由会话的 Node 执行宿主按权限设置确认（执行范围由项目沙箱
      // 补问，见 WorkbenchConversationSession），不经这条通道。
      return parts.commands.runCommand(parsed, (outputEvent) => {
        if (!sender.isDestroyed()) {
          sender.send(WorkbenchFsChannels.runCommandOutput, outputEvent)
        }
      }, undefined, true)
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

function parseFindExistingFilesRequest(
  input: unknown
): Nullable<WorkbenchFindExistingFilesRequest> {
  if (!hasStringFields(input, ['projectRoot'])) return null
  const paths = input['paths']
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === 'string')) return null

  return { projectRoot: input['projectRoot'] as string, paths: paths as string[] }
}

function parseReadImageFileRequest(input: unknown): Nullable<WorkbenchReadImageFileRequest> {
  if (!hasStringFields(input, ['projectRoot', 'path'])) return null

  return {
    projectRoot: input['projectRoot'] as string,
    path: input['path'] as string,
    ...optionalNumber(input, 'maxBytes'),
  }
}

function parseSaveFileRequest(input: unknown): Nullable<WorkbenchSaveFileRequest> {
  if (!hasStringFields(input, ['projectRoot', 'path', 'content'])) return null

  const textFormat = parseTextFormat(input)
  if (!textFormat) return null

  return {
    projectRoot: input['projectRoot'] as string,
    path: input['path'] as string,
    content: input['content'] as string,
    ...textFormat,
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

function parseCopyEntryRequest(input: unknown): Nullable<WorkbenchCopyEntryRequest> {
  if (!hasStringFields(input, ['projectRoot', 'path', 'parentPath'])) return null

  return {
    projectRoot: input['projectRoot'] as string,
    path: input['path'] as string,
    parentPath: input['parentPath'] as string,
    ...optionalString(input, 'name'),
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
    ...optionalBoolean(input, 'recursive'),
  }
}

function parseInspectDeleteEntryRequest(
  input: unknown
): Nullable<WorkbenchInspectDeleteEntryRequest> {
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

function parseRestoreMissingFileRequest(
  input: unknown
): Nullable<WorkbenchRestoreMissingFileRequest> {
  if (!hasStringFields(input, ['projectRoot', 'path', 'content'])) return null

  const textFormat = parseTextFormat(input)
  if (!textFormat) return null

  return {
    projectRoot: input['projectRoot'] as string,
    path: input['path'] as string,
    content: input['content'] as string,
    ...textFormat,
  }
}

/** 保存格式可以省略（沿用磁盘上的），但给了就必须是认识的取值。 */
function parseTextFormat(input: Record<string, unknown>): Nullable<Partial<WorkbenchTextFormat>> {
  const encoding = input['encoding']
  const eol = input['eol']
  if (encoding !== undefined && !isWorkbenchTextEncoding(encoding)) return null
  if (eol !== undefined && !isWorkbenchTextEol(eol)) return null

  return { encoding, eol }
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

  const paths = optionalStringArray(input, 'paths')
  const openPaths = optionalStringArray(input, 'openPaths')
  if (!paths || !openPaths) return null

  return {
    projectRoot: input['projectRoot'] as string,
    query: input['query'] as string,
    ...optionalBoolean(input, 'matchCase'),
    ...optionalBoolean(input, 'wholeWord'),
    ...optionalBoolean(input, 'regex'),
    ...optionalString(input, 'include'),
    ...optionalString(input, 'exclude'),
    ...paths,
    ...openPaths,
    ...optionalNumber(input, 'limit'),
    ...optionalNumber(input, 'maxResultsPerFile'),
    ...optionalString(input, 'searchId'),
  }
}

function parseReplaceContentRequest(input: unknown): Nullable<WorkbenchReplaceContentRequest> {
  if (!hasStringFields(input, ['projectRoot', 'query', 'replacement'])) return null
  const files = input['files']
  if (!Array.isArray(files)) return null

  const parsedFiles: WorkbenchReplaceContentFileRequest[] = []
  for (const file of files) {
    const parsed = parseReplaceContentFileRequest(file)
    if (!parsed) return null
    parsedFiles.push(parsed)
  }

  return {
    projectRoot: input['projectRoot'] as string,
    query: input['query'] as string,
    replacement: input['replacement'] as string,
    ...optionalBoolean(input, 'matchCase'),
    ...optionalBoolean(input, 'wholeWord'),
    ...optionalBoolean(input, 'regex'),
    files: parsedFiles,
  }
}

function parseReplaceContentFileRequest(input: unknown): Nullable<WorkbenchReplaceContentFileRequest> {
  if (
    !hasStringFields(input, ['path'])
    || !isFiniteNumber(input['expectedModifiedAt'])
    || !isFiniteNumber(input['expectedSize'])
  )
    return null

  const file: WorkbenchReplaceContentFileRequest = {
    path: input['path'] as string,
    expectedModifiedAt: input['expectedModifiedAt'],
    expectedSize: input['expectedSize'],
  }
  const matches = input['matches']
  if (matches === undefined) return file
  if (!Array.isArray(matches)) return null

  const ranges: NonNullable<WorkbenchReplaceContentFileRequest['matches']> = []
  for (const match of matches) {
    if (!isRecord(match)) return null
    const { line, column, endLine, endColumn } = match
    if (![line, column, endLine, endColumn].every(isFiniteNumber)) return null
    ranges.push({
      line: line as number,
      column: column as number,
      endLine: endLine as number,
      endColumn: endColumn as number,
    })
  }
  return { ...file, matches: ranges }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

interface ContentSearchRegistry {
  /** 开始一次搜索；同一窗口同一 id 还在搜的那次先取消。返回窗口的 id（窗口关了以后就读不到了）。 */
  begin: (sender: WebContents, searchId: string) => { senderId: number; search: AbortController }
  end: (senderId: number, searchId: string, search: AbortController) => void
  cancel: (senderId: number, searchId: string) => void
}

/**
 * 进行中的内容搜索，按窗口与 searchId 记下；窗口关了，它的搜索一并取消。窗口的 id 在开始时记下：
 * `destroyed` 触发时 WebContents 已经销毁，再读 `sender.id` 会抛错。
 */
function createContentSearchRegistry(): ContentSearchRegistry {
  const searches = new Map<number, Map<string, AbortController>>()

  return {
    begin: (sender, searchId) => {
      const senderId = sender.id
      let bySearchId = searches.get(senderId)
      if (!bySearchId) {
        const created = new Map<string, AbortController>()
        bySearchId = created
        searches.set(senderId, created)
        sender.once('destroyed', () => {
          for (const search of created.values()) search.abort()
          searches.delete(senderId)
        })
      }
      bySearchId.get(searchId)?.abort()
      const search = new AbortController()
      bySearchId.set(searchId, search)
      return { senderId, search }
    },
    end: (senderId, searchId, search) => {
      const bySearchId = searches.get(senderId)
      if (bySearchId?.get(searchId) === search) bySearchId.delete(searchId)
    },
    cancel: (senderId, searchId) => {
      searches.get(senderId)?.get(searchId)?.abort()
    },
  }
}

function parseListProjectFilesRequest(
  input: unknown
): Nullable<WorkbenchListProjectFilesRequest> {
  if (!hasStringFields(input, ['projectRoot'])) return null

  return {
    projectRoot: input['projectRoot'] as string,
    ...optionalNumber(input, 'limit'),
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
