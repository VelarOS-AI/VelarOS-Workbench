import { ipcMain } from 'electron'

import {
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

import type { WorkbenchGitService } from './WorkbenchGitService'

export function registerWorkbenchGitIpc(service: WorkbenchGitService): void {
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
    ...(typeof record['commitSha'] === 'string' ? { commitSha: record['commitSha'] } : {}),
    ...(typeof record['staged'] === 'boolean' ? { staged: record['staged'] } : {}),
    ...(typeof record['path'] === 'string' ? { path: record['path'] } : {}),
    ...(typeof record['originalPath'] === 'string'
      ? { originalPath: record['originalPath'] }
      : {}),
    ...(typeof record['maxChars'] === 'number' ? { maxChars: record['maxChars'] } : {}),
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
    ...(typeof record['branch'] === 'string' ? { branch: record['branch'] } : {}),
    ...(typeof record['limit'] === 'number' ? { limit: record['limit'] } : {}),
    ...(typeof record['path'] === 'string' ? { path: record['path'] } : {}),
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
    ...(locale ? { locale } : {}),
    ...(paths ? { paths } : {}),
  }
}

function parseCommit(input: unknown): WorkbenchGitCommitRequest {
  const request = parseCommitMessage(input)
  const message = (input as Record<string, unknown>)['message']
  if (message !== undefined && typeof message !== 'string') return invalidRequest()
  return { ...request, ...(typeof message === 'string' ? { message } : {}) }
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
    ...(typeof record['create'] === 'boolean' ? { create: record['create'] } : {}),
    ...(typeof record['startPoint'] === 'string'
      ? { startPoint: record['startPoint'] }
      : {}),
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
    ...(typeof record['githubToken'] === 'string'
      ? { githubToken: record['githubToken'] }
      : {}),
    ...(typeof record['privateKeyPath'] === 'string'
      ? { privateKeyPath: record['privateKeyPath'] }
      : {}),
    ...(typeof record['sshKeyPath'] === 'string'
      ? { sshKeyPath: record['sshKeyPath'] }
      : {}),
  }
}
