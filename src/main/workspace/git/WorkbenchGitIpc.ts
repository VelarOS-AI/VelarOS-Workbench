import { ipcMain } from 'electron'

import { isBoolean, isNumber, isString, isTrue, optionalWhen } from '@velaros-ai/core'

import {
  type WorkbenchChatCheckpointCaptureRequest,
  type WorkbenchChatCheckpointDeleteRequest,
  type WorkbenchChatRunChangeBaseFileRequest,
  type WorkbenchChatRunChangesCaptureRequest,
  type WorkbenchChatRunChangesDeleteRequest,
  type WorkbenchChatRunChangesReadRequest,
  type WorkbenchChatRunChangesRewindRequest,
  WorkbenchGitChannels,
  type WorkbenchGitCommitMessageRequest,
  type WorkbenchGitCommitRequest,
  type WorkbenchGitCreateBranchRequest,
  type WorkbenchGitDiffRequest,
  type WorkbenchGitFileActionRequest,
  type WorkbenchGitFileAtCommitRequest,
  type WorkbenchGitLogRequest,
  type WorkbenchGitRemoteActionRequest,
  type WorkbenchGitRootRequest,
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
      return service.commit(
        request.workspaceRoot,
        request.locale,
        request.message,
        request.paths
      )
    })
  )
  ipcMain.handle(WorkbenchGitChannels.fileAction, (_event, input: unknown) =>
    callWithEnvelope(() => {
      const request = parseFileAction(input)
      return service.performFileAction(request.workspaceRoot, request.path, request.action)
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
  ipcMain.handle(WorkbenchGitChannels.rewindChatRunChanges, (_event, input: unknown) =>
    callWithEnvelope(() => runChanges.rewind(parseRunChangesRewind(input)))
  )
}

function parseRoot(input: unknown): WorkbenchGitRootRequest {
  if (!hasStringFields(input, ['workspaceRoot'])) return invalidRequest()
  return { workspaceRoot: input['workspaceRoot'] as string }
}

function parseDiff(input: unknown): WorkbenchGitDiffRequest {
  const root = parseRoot(input)
  const record = input as Record<string, unknown>
  return {
    ...root,
    commitSha: optionalWhen(isString, record['commitSha']),
    staged: optionalWhen(isBoolean, record['staged']),
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

function parseLog(input: unknown): WorkbenchGitLogRequest {
  const root = parseRoot(input)
  const record = input as Record<string, unknown>
  return {
    ...root,
    branch: optionalWhen(isString, record['branch']),
    limit: optionalWhen(isNumber, record['limit']),
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
  const message = (input as Record<string, unknown>)['message']
  if (message !== undefined && typeof message !== 'string') return invalidRequest()
  return { ...request, message }
}

function parseFileAction(input: unknown): WorkbenchGitFileActionRequest {
  if (!hasStringFields(input, ['workspaceRoot', 'path', 'action']))
    return invalidRequest()
  const action = input['action']
  if (action !== 'discard' && action !== 'stage' && action !== 'unstage')
    return invalidRequest()
  return {
    workspaceRoot: input['workspaceRoot'] as string,
    path: input['path'] as string,
    action,
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
  if (action !== 'fetch' && action !== 'update' && action !== 'upload')
    return invalidRequest()
  const record = input as Record<string, unknown>
  for (const key of ['githubToken', 'privateKeyPath', 'sshKeyPath']) {
    if (record[key] !== undefined && typeof record[key] !== 'string')
      return invalidRequest()
  }
  return {
    workspaceRoot: record['workspaceRoot'] as string,
    action,
    githubToken: optionalWhen(isString, record['githubToken']),
    privateKeyPath: optionalWhen(isString, record['privateKeyPath']),
    sshKeyPath: optionalWhen(isString, record['sshKeyPath']),
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

function parseRunChangesRewind(input: unknown): WorkbenchChatRunChangesRewindRequest {
  if (!hasStringFields(input, ['workspaceRoot', 'sessionId', 'commitId'])) return invalidRequest()
  const recordIds = input['recordIds']
  if (!Array.isArray(recordIds) || !recordIds.every((id) => typeof id === 'string'))
    return invalidRequest()
  return {
    workspaceRoot: input['workspaceRoot'] as string,
    sessionId: input['sessionId'] as string,
    commitId: input['commitId'] as string,
    recordIds,
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
