import { ipcMain } from 'electron'

import { isBoolean, isNumber, isString, isTrue, optionalWhen } from '@velaros-ai/core'

import { isWorkbenchTextEncoding, isWorkbenchTextEol } from '@shared/workbenchTextFormat'

import {
  type WorkbenchChatCheckpointCaptureRequest,
  type WorkbenchChatCheckpointDeleteRequest,
  type WorkbenchChatRunChangeBaseFileRequest,
  type WorkbenchChatRunChangesCaptureRequest,
  type WorkbenchChatRunChangesDeleteRequest,
  type WorkbenchChatRunChangesReadRequest,
  type WorkbenchGitBlameRequest,
  type WorkbenchGitCancelRemoteActionRequest,
  WorkbenchGitChannels,
  type WorkbenchGitCommitMessageRequest,
  type WorkbenchGitCommitRequest,
  type WorkbenchGitCreateBranchRequest,
  type WorkbenchGitDiffRequest,
  type WorkbenchGitFileActionRequest,
  type WorkbenchGitFileAtCommitRequest,
  type WorkbenchGitHunkActionRequest,
  type WorkbenchGitLogRequest,
  type WorkbenchGitRemoteActionRequest,
  type WorkbenchGitRootRequest,
  type WorkbenchGitStashActionRequest,
  type WorkbenchGitStashRequest,
  type WorkbenchGitSwitchBranchRequest,
} from '../../../shared/workbenchGit'
import { callWithEnvelope, hasStringFields, invalidRequest } from '../ipcBoundary'

import type { WorkbenchChatCheckpointService } from './WorkbenchChatCheckpoints'
import type { WorkbenchChatRunChangeStore } from './WorkbenchChatRunChanges'
import type { WorkbenchGitService } from './WorkbenchGitService'

export function registerWorkbenchGitIpc(
  service: WorkbenchGitService,
  checkpoints: WorkbenchChatCheckpointService,
  runChanges: WorkbenchChatRunChangeStore
): void {
  ipcMain.handle(WorkbenchGitChannels.summary, (_event, input: unknown) =>
    callWithEnvelope(() => service.getSummary(parseRoot(input).workspaceRoot))
  )
  ipcMain.handle(WorkbenchGitChannels.lineStats, (_event, input: unknown) =>
    callWithEnvelope(() => service.getLineStats(parseRoot(input).workspaceRoot))
  )
  ipcMain.handle(WorkbenchGitChannels.diff, (_event, input: unknown) =>
    callWithEnvelope(() => {
      const request = parseDiff(input)
      const { workspaceRoot, ...options } = request
      return service.getDiff(workspaceRoot, options)
    })
  )
  ipcMain.handle(WorkbenchGitChannels.fileAtCommit, (_event, input: unknown) =>
    callWithEnvelope(() => {
      const request = parseFileAtCommit(input)
      return service.getFileAtCommit(request.workspaceRoot, request.commitSha, request.path)
    })
  )
  ipcMain.handle(WorkbenchGitChannels.blame, (_event, input: unknown) =>
    callWithEnvelope(() => {
      const { workspaceRoot, ...options } = parseBlame(input)
      return service.getBlame(workspaceRoot, options)
    })
  )
  ipcMain.handle(WorkbenchGitChannels.log, (_event, input: unknown) =>
    callWithEnvelope(() => {
      const request = parseLog(input)
      const { workspaceRoot, ...options } = request
      return service.getLog(workspaceRoot, options)
    })
  )
  ipcMain.handle(WorkbenchGitChannels.generateCommitMessage, (_event, input: unknown) =>
    callWithEnvelope(() => {
      const request = parseCommitMessage(input)
      return service.generateCommitMessage(request.workspaceRoot, request.locale, request.paths)
    })
  )
  ipcMain.handle(WorkbenchGitChannels.commit, (_event, input: unknown) =>
    callWithEnvelope(() => {
      const request = parseCommit(input)
      return request.staged
        ? service.commitStaged(request.workspaceRoot, request.locale, request.message)
        : service.commit(request.workspaceRoot, request.locale, request.message, request.paths)
    })
  )
  ipcMain.handle(WorkbenchGitChannels.fileAction, (_event, input: unknown) =>
    callWithEnvelope(() => {
      const request = parseFileAction(input)
      return service.performFileAction(request.workspaceRoot, request.paths, request.action)
    })
  )
  ipcMain.handle(WorkbenchGitChannels.hunkAction, (_event, input: unknown) =>
    callWithEnvelope(() => {
      const { workspaceRoot, ...options } = parseHunkAction(input)
      return service.applyHunks(workspaceRoot, options)
    })
  )
  ipcMain.handle(WorkbenchGitChannels.initialize, (_event, input: unknown) =>
    callWithEnvelope(() => service.initialize(parseRoot(input).workspaceRoot))
  )
  ipcMain.handle(WorkbenchGitChannels.switchBranch, (_event, input: unknown) =>
    callWithEnvelope(() => {
      const request = parseSwitchBranch(input)
      return service.switchBranch(request.workspaceRoot, request.branch, {
        create: request.create,
        startPoint: request.startPoint,
      })
    })
  )
  ipcMain.handle(WorkbenchGitChannels.createBranch, (_event, input: unknown) =>
    callWithEnvelope(() => {
      const request = parseCreateBranch(input)
      return service.createBranch(request.workspaceRoot, request.branch)
    })
  )
  ipcMain.handle(WorkbenchGitChannels.remoteAction, (_event, input: unknown) =>
    callWithEnvelope(() => {
      const request = parseRemoteAction(input)
      return service.performRemoteAction(request.workspaceRoot, request.action, request)
    })
  )
  ipcMain.handle(WorkbenchGitChannels.cancelRemoteAction, (_event, input: unknown) =>
    callWithEnvelope(async () => ({
      cancelled: service.cancelRemoteAction(parseCancelRemoteAction(input).operationId),
    }))
  )
  ipcMain.handle(WorkbenchGitChannels.stashList, (_event, input: unknown) =>
    callWithEnvelope(() => service.listStashes(parseRoot(input).workspaceRoot))
  )
  ipcMain.handle(WorkbenchGitChannels.stash, (_event, input: unknown) =>
    callWithEnvelope(() => {
      const { workspaceRoot, ...options } = parseStash(input)
      return service.stash(workspaceRoot, options)
    })
  )
  ipcMain.handle(WorkbenchGitChannels.stashAction, (_event, input: unknown) =>
    callWithEnvelope(() => {
      const request = parseStashAction(input)
      return service.performStashAction(request.workspaceRoot, request.sha, request.action)
    })
  )
  // 检查点经由改动记录区拍：拍的同时为这一轮开改动归属账本。
  ipcMain.handle(WorkbenchGitChannels.captureChatCheckpoint, (_event, input: unknown) =>
    callWithEnvelope(() => runChanges.captureCheckpoint(parseCheckpointCapture(input)))
  )
  ipcMain.handle(WorkbenchGitChannels.deleteChatCheckpoints, (_event, input: unknown) =>
    callWithEnvelope(() => checkpoints.delete(parseCheckpointDelete(input)))
  )
  ipcMain.handle(WorkbenchGitChannels.captureChatRunChanges, (_event, input: unknown) =>
    callWithEnvelope(() => runChanges.capture(parseRunChangesCapture(input)))
  )
  ipcMain.handle(WorkbenchGitChannels.readChatRunChanges, (_event, input: unknown) =>
    callWithEnvelope(() => runChanges.read(parseRunChangesRead(input)))
  )
  ipcMain.handle(WorkbenchGitChannels.deleteChatRunChanges, (_event, input: unknown) =>
    callWithEnvelope(() => runChanges.delete(parseRunChangesDelete(input)))
  )
  ipcMain.handle(WorkbenchGitChannels.readChatRunChangeBaseFile, (_event, input: unknown) =>
    callWithEnvelope(() => runChanges.readBaseFile(parseRunChangeBaseFile(input)))
  )
}

function parseRoot(input: unknown): WorkbenchGitRootRequest {
  if (!hasStringFields(input, ['workspaceRoot'])) return invalidRequest()
  return { workspaceRoot: input['workspaceRoot'] as string }
}

function parseDiff(input: unknown): WorkbenchGitDiffRequest {
  const root = parseRoot(input)
  const record = input as Record<string, unknown>
  const side = record['side']
  if (side !== undefined && side !== 'staged' && side !== 'unstaged') return invalidRequest()
  // 看的是一个提交，或者一条贮藏：不能两样都给。
  if (isString(record['commitSha']) && isString(record['stashSha'])) return invalidRequest()
  return {
    ...root,
    commitSha: optionalWhen(isString, record['commitSha']),
    stashSha: optionalWhen(isString, record['stashSha']),
    side,
    path: optionalWhen(isString, record['path']),
    originalPath: optionalWhen(isString, record['originalPath']),
    maxChars: optionalWhen(isNumber, record['maxChars']),
  }
}

function parseFileAtCommit(input: unknown): WorkbenchGitFileAtCommitRequest {
  if (!hasStringFields(input, ['workspaceRoot', 'commitSha', 'path']))
    return invalidRequest()
  return {
    workspaceRoot: input['workspaceRoot'] as string,
    commitSha: input['commitSha'] as string,
    path: input['path'] as string,
  }
}

function parseBlame(input: unknown): WorkbenchGitBlameRequest {
  if (!hasStringFields(input, ['workspaceRoot', 'path'])) return invalidRequest()
  const { encoding, eol } = input
  return {
    workspaceRoot: input['workspaceRoot'] as string,
    path: input['path'] as string,
    content: optionalWhen(isString, input['content']),
    encoding: isWorkbenchTextEncoding(encoding) ? encoding : undefined,
    eol: isWorkbenchTextEol(eol) ? eol : undefined,
  }
}

function parseLog(input: unknown): WorkbenchGitLogRequest {
  const root = parseRoot(input)
  const record = input as Record<string, unknown>
  return {
    ...root,
    branch: optionalWhen(isString, record['branch']),
    limit: optionalWhen(isNumber, record['limit']),
    skip: optionalWhen(isNumber, record['skip']),
    path: optionalWhen(isString, record['path']),
  }
}

function parseCommitMessage(input: unknown): WorkbenchGitCommitMessageRequest {
  const root = parseRoot(input)
  const record = input as Record<string, unknown>
  const locale = record['locale']
  const paths = record['paths']
  if (locale !== undefined && locale !== 'en-US' && locale !== 'zh-CN')
    return invalidRequest()
  if (
    paths !== undefined &&
    (!Array.isArray(paths) || !paths.every((path) => typeof path === 'string'))
  ) return invalidRequest()
  return {
    ...root,
    locale,
    paths,
  }
}

function parseCommit(input: unknown): WorkbenchGitCommitRequest {
  const request = parseCommitMessage(input)
  const record = input as Record<string, unknown>
  const message = record['message']
  const staged = record['staged']
  if (message !== undefined && typeof message !== 'string') return invalidRequest()
  if (staged !== undefined && typeof staged !== 'boolean') return invalidRequest()
  // 提交暂存区时提交的就是暂存区，不能再挑路径。
  if (staged && request.paths !== undefined) return invalidRequest()
  return { ...request, message, staged: optionalWhen(isTrue, staged) }
}

function parseFileAction(input: unknown): WorkbenchGitFileActionRequest {
  if (!hasStringFields(input, ['workspaceRoot', 'action'])) return invalidRequest()
  const action = input['action']
  const paths = input['paths']
  if (action !== 'discard' && action !== 'stage' && action !== 'unstage' && action !== 'resolve')
    return invalidRequest()
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((path) => isString(path)))
    return invalidRequest()
  return {
    workspaceRoot: input['workspaceRoot'] as string,
    paths,
    action,
  }
}

function parseHunkAction(input: unknown): WorkbenchGitHunkActionRequest {
  if (!hasStringFields(input, ['workspaceRoot', 'path', 'action'])) return invalidRequest()
  const action = input['action']
  const originalPath = input['originalPath']
  const hunks = input['hunks']
  if (action !== 'stage' && action !== 'unstage' && action !== 'discard') return invalidRequest()
  if (originalPath !== undefined && !isString(originalPath)) return invalidRequest()
  if (
    !Array.isArray(hunks) ||
    hunks.length === 0 ||
    !hunks.every(
      (hunk) =>
        hasStringFields(hunk, ['header']) &&
        Array.isArray(hunk['lines']) &&
        hunk['lines'].every((line) => isString(line))
    )
  )
    return invalidRequest()
  return {
    workspaceRoot: input['workspaceRoot'] as string,
    path: input['path'] as string,
    originalPath,
    action,
    hunks: hunks.map((hunk: Record<string, unknown>) => ({
      header: hunk['header'] as string,
      lines: hunk['lines'] as string[],
    })),
  }
}

function parseSwitchBranch(input: unknown): WorkbenchGitSwitchBranchRequest {
  if (!hasStringFields(input, ['workspaceRoot', 'branch'])) return invalidRequest()
  const record = input as Record<string, unknown>
  if (record['create'] !== undefined && typeof record['create'] !== 'boolean')
    return invalidRequest()
  if (record['startPoint'] !== undefined && typeof record['startPoint'] !== 'string')
    return invalidRequest()
  return {
    workspaceRoot: record['workspaceRoot'] as string,
    branch: record['branch'] as string,
    create: optionalWhen(isBoolean, record['create']),
    startPoint: optionalWhen(isString, record['startPoint']),
  }
}

function parseCreateBranch(input: unknown): WorkbenchGitCreateBranchRequest {
  if (!hasStringFields(input, ['workspaceRoot', 'branch'])) return invalidRequest()
  return {
    workspaceRoot: input['workspaceRoot'] as string,
    branch: input['branch'] as string,
  }
}

function parseRemoteAction(input: unknown): WorkbenchGitRemoteActionRequest {
  if (!hasStringFields(input, ['workspaceRoot', 'action'])) return invalidRequest()
  const action = input['action']
  if (action !== 'fetch' && action !== 'pull' && action !== 'sync' && action !== 'upload')
    return invalidRequest()
  const record = input as Record<string, unknown>
  for (const key of ['branch', 'githubToken', 'privateKeyPath', 'sshKeyPath', 'operationId']) {
    if (record[key] !== undefined && typeof record[key] !== 'string')
      return invalidRequest()
  }
  if (record['operationId'] !== undefined && !isOperationId(record['operationId']))
    return invalidRequest()
  return {
    workspaceRoot: record['workspaceRoot'] as string,
    action,
    // 分支菜单里推送别的分支时带着它；丢了就会推成当前分支。
    branch: optionalWhen(isString, record['branch']),
    githubToken: optionalWhen(isString, record['githubToken']),
    privateKeyPath: optionalWhen(isString, record['privateKeyPath']),
    sshKeyPath: optionalWhen(isString, record['sshKeyPath']),
    // 没带编号的操作照常跑，只是取消不了。
    operationId: optionalWhen(isString, record['operationId']),
  }
}

/** 操作编号是发起方起的，只拿来对号：不空、不太长就行。 */
function isOperationId(value: unknown): value is string {
  return isString(value) && value.length > 0 && value.length <= 128
}

function parseCancelRemoteAction(input: unknown): WorkbenchGitCancelRemoteActionRequest {
  if (!hasStringFields(input, ['operationId']) || !isOperationId(input['operationId']))
    return invalidRequest()
  return { operationId: input['operationId'] }
}

function parseStash(input: unknown): WorkbenchGitStashRequest {
  const root = parseRoot(input)
  const record = input as Record<string, unknown>
  const message = record['message']
  const includeUntracked = record['includeUntracked']
  if (message !== undefined && !isString(message)) return invalidRequest()
  if (includeUntracked !== undefined && !isBoolean(includeUntracked)) return invalidRequest()
  return { ...root, message, includeUntracked: optionalWhen(isTrue, includeUntracked) }
}

function parseStashAction(input: unknown): WorkbenchGitStashActionRequest {
  if (!hasStringFields(input, ['workspaceRoot', 'sha', 'action'])) return invalidRequest()
  const action = input['action']
  if (action !== 'apply' && action !== 'pop' && action !== 'drop') return invalidRequest()
  return {
    workspaceRoot: input['workspaceRoot'] as string,
    sha: input['sha'] as string,
    action,
  }
}

function parseCheckpointCapture(input: unknown): WorkbenchChatCheckpointCaptureRequest {
  if (!hasStringFields(input, ['workspaceRoot', 'sessionId', 'checkpointId']))
    return invalidRequest()
  return {
    workspaceRoot: input['workspaceRoot'] as string,
    sessionId: input['sessionId'] as string,
    checkpointId: input['checkpointId'] as string,
    label: optionalWhen(isString, input['label']),
  }
}

function parseCheckpointDelete(input: unknown): WorkbenchChatCheckpointDeleteRequest {
  if (!hasStringFields(input, ['workspaceRoot', 'sessionId'])) return invalidRequest()
  const checkpointIds = input['checkpointIds']
  if (!Array.isArray(checkpointIds) || !checkpointIds.every((id) => typeof id === 'string'))
    return invalidRequest()
  return {
    workspaceRoot: input['workspaceRoot'] as string,
    sessionId: input['sessionId'] as string,
    checkpointIds,
  }
}

function parseRunChangesCapture(input: unknown): WorkbenchChatRunChangesCaptureRequest {
  if (!hasStringFields(input, ['workspaceRoot', 'sessionId', 'recordId', 'baseCommitId']))
    return invalidRequest()
  const final = input['final']
  if (final !== undefined && typeof final !== 'boolean') return invalidRequest()
  return {
    workspaceRoot: input['workspaceRoot'] as string,
    sessionId: input['sessionId'] as string,
    recordId: input['recordId'] as string,
    baseCommitId: input['baseCommitId'] as string,
    final: optionalWhen(isTrue, final),
  }
}

function parseRunChangesRead(input: unknown): WorkbenchChatRunChangesReadRequest {
  if (!hasStringFields(input, ['workspaceRoot', 'sessionId', 'recordId'])) return invalidRequest()
  return {
    workspaceRoot: input['workspaceRoot'] as string,
    sessionId: input['sessionId'] as string,
    recordId: input['recordId'] as string,
  }
}

function parseRunChangeBaseFile(input: unknown): WorkbenchChatRunChangeBaseFileRequest {
  if (!hasStringFields(input, ['workspaceRoot', 'sessionId', 'recordId', 'path']))
    return invalidRequest()
  return {
    workspaceRoot: input['workspaceRoot'] as string,
    sessionId: input['sessionId'] as string,
    recordId: input['recordId'] as string,
    path: input['path'] as string,
  }
}

function parseRunChangesDelete(input: unknown): WorkbenchChatRunChangesDeleteRequest {
  if (!hasStringFields(input, ['workspaceRoot', 'sessionId'])) return invalidRequest()
  const recordIds = input['recordIds']
  if (
    recordIds !== undefined &&
    (!Array.isArray(recordIds) || !recordIds.every((id) => typeof id === 'string'))
  )
    return invalidRequest()
  return {
    workspaceRoot: input['workspaceRoot'] as string,
    sessionId: input['sessionId'] as string,
    recordIds,
  }
}
