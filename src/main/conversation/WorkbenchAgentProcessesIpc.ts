import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'

import { AppError } from '@velaros-ai/core/error'

import { WorkbenchAgentProcessesChannels as Channels } from '../../shared/workbenchAgentProcesses'
import { callWithEnvelope } from '../workspace/ipcBoundary'

import type { WorkbenchConversationWindows } from './WorkbenchConversationIpc'
import type { WorkbenchShellHostRegistryApi } from './WorkbenchShellHostRegistry'

const Session = z.object({
  projectRoot: z.string().min(1).max(8192),
  sessionId: z.string().min(1).max(512),
})
const Task = Session.extend({ taskId: z.string().min(1).max(512) })

/** 只向项目所属窗口开放本项目会话启动的进程；进程当前 cwd 不用来推断归属。 */
export function registerWorkbenchAgentProcessesIpc(options: {
  shells: WorkbenchShellHostRegistryApi
  windows: WorkbenchConversationWindows
}): () => void {
  const ownedRoot = async (event: IpcMainInvokeEvent, root: string): Promise<string> => {
    const project = options.windows.getHubForWebContents(event.sender)?.getState().currentProject
    if (!project || resolve(project.path) !== resolve(root))
      throw new AppError('PERMISSION', '这个项目不属于当前窗口。')
    return realpath(project.path)
  }
  ipcMain.handle(Channels.list, (event, raw: unknown) =>
    callWithEnvelope(async () => {
      const request = Session.parse(raw)
      const tasks = await options.shells.listBackgroundTasks(
        { sessionId: request.sessionId, limit: 64 },
        await ownedRoot(event, request.projectRoot)
      )
      return tasks.map((task) => ({
        ...task,
        recentOutput: task.recentOutput
          ? stripVTControlCharacters(task.recentOutput).slice(-16000)
          : null,
      }))
    })
  )
  ipcMain.handle(Channels.stop, (event, raw: unknown) =>
    callWithEnvelope(async () => {
      const request = Task.extend({ force: z.boolean() }).parse(raw)
      return options.shells.terminateBackgroundTask(
        request,
        await ownedRoot(event, request.projectRoot)
      )
    })
  )
  ipcMain.handle(Channels.input, (event, raw: unknown) =>
    callWithEnvelope(async () => {
      const request = Task.extend({ text: z.string().max(16000) }).parse(raw)
      return options.shells.writeConsoleInput(request, await ownedRoot(event, request.projectRoot))
    })
  )
  ipcMain.handle(Channels.interrupt, (event, raw: unknown) =>
    callWithEnvelope(async () => {
      const request = Task.parse(raw)
      return options.shells.interruptConsole(request, await ownedRoot(event, request.projectRoot))
    })
  )
  const off = options.shells.addBackgroundTasksListener((change) => {
    for (const window of BrowserWindow.getAllWindows()) {
      const project = options.windows
        .getHubForWebContents(window.webContents)
        ?.getState().currentProject
      if (!project || !change.sessionId || !change.projectRoot) continue
      void realpath(project.path)
        .then((root) => {
          if (window.isDestroyed() || root !== change.projectRoot) return
          window.webContents.send(Channels.changed, {
            projectRoot: project.path,
            sessionId: change.sessionId,
          })
        })
        .catch(() => undefined)
    }
  })
  return () => {
    off()
    for (const channel of [Channels.list, Channels.stop, Channels.input, Channels.interrupt])
      ipcMain.removeHandler(channel)
  }
}
