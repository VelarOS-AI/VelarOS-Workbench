import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { IpcMainInvokeEvent } from 'electron'
import { ipcMain } from 'electron'

import { isNonBlankString, isPlainObject } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import {
  WorkbenchMemoryChannels,
  type WorkbenchMemoryProjectRequest,
  type WorkbenchMemoryRemoveRequest,
} from '../../shared/workbenchMemory'
import { callWithEnvelope } from '../workspace/ipcBoundary'

import type { WorkbenchConversationWindows } from './WorkbenchConversationIpc'
import type { WorkbenchMemoryServiceApi } from './WorkbenchMemoryService'

/**
 * 设置页的长期记忆通道：窗口只看、只删自己当前打开的项目那一份（作用域按项目根的真实路径，与运行时接的
 * 同一个），别的项目的记忆不经这里出窗口。
 */
export function registerWorkbenchMemoryIpc(options: {
  memory: WorkbenchMemoryServiceApi
  windows: WorkbenchConversationWindows
}): () => void {
  const ownedWorkspace = async (
    event: IpcMainInvokeEvent,
    request: WorkbenchMemoryProjectRequest
  ): Promise<string> => {
    const project = options.windows.getHubForWebContents(event.sender)?.getState().currentProject
    if (!project || resolve(project.path) !== resolve(request.projectRoot))
      throw new AppError('PERMISSION', '当前窗口不能查看这个项目的记忆。')
    return realpath(project.path)
  }

  ipcMain.handle(WorkbenchMemoryChannels.listEntries, (event, raw: unknown) =>
    callWithEnvelope(async () =>
      options.memory.listEntries(await ownedWorkspace(event, parseProjectRequest(raw)))
    )
  )
  ipcMain.handle(WorkbenchMemoryChannels.removeEntry, (event, raw: unknown) =>
    callWithEnvelope(async () => {
      const request = parseRemoveRequest(raw)
      const { removed } = await options.memory.removeEntry(
        await ownedWorkspace(event, request),
        request.id
      )
      return { removed }
    })
  )
  return () => {
    ipcMain.removeHandler(WorkbenchMemoryChannels.listEntries)
    ipcMain.removeHandler(WorkbenchMemoryChannels.removeEntry)
  }
}

function parseProjectRequest(raw: unknown): WorkbenchMemoryProjectRequest {
  if (!isPlainObject(raw) || !isNonBlankString(raw.projectRoot))
    throw new AppError('VALIDATION', '无效的记忆请求。')
  return { projectRoot: raw.projectRoot }
}

function parseRemoveRequest(raw: unknown): WorkbenchMemoryRemoveRequest {
  const request = parseProjectRequest(raw)
  if (!isPlainObject(raw) || !isNonBlankString(raw.id))
    throw new AppError('VALIDATION', '无效的记忆请求。')
  return { ...request, id: raw.id }
}
