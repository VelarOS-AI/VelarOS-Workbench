import { resolve } from 'node:path'

import { ipcMain, type WebContents } from 'electron'
import { z } from 'zod'

import { Log } from '@velaros-ai/velaros/core'
import { AppError, createAbortError, createTimeoutError } from '@velaros-ai/velaros/core/error'

import {
  type WorkbenchPeerEvent,
  type WorkbenchPeerMember,
  type WorkbenchPeerTask,
  WorkbenchSessionPeersChannels as Channels,
} from '../../shared/workbenchSessionPeers'
import { callWithEnvelope } from '../workspace/ipcBoundary'

import type { WorkbenchConversationDispatcherApi } from './WorkbenchConversationDispatcher'
import {
  prepareWindowConversation,
  type WorkbenchConversationWindows,
} from './WorkbenchConversationIpc'
import type { WorkbenchConversationRecovery } from './WorkbenchConversationRecovery'
import { WorkbenchSessionPeers } from './WorkbenchSessionPeers'

const Ref = z.object({
  projectRoot: z.string().min(1).max(8192),
  sessionId: z.string().min(1).max(512),
})

/** 目录和投递回执归项目窗口持有；窗口关闭、重载、切项目时撤销未交接的工作。 */
export function registerWorkbenchSessionPeersIpc(options: {
  runtime: WorkbenchConversationDispatcherApi
  recovery: WorkbenchConversationRecovery
  windows: WorkbenchConversationWindows
}): { peers: WorkbenchSessionPeers; releaseProject(root: string): void; dispose(): void } {
  const catalogs = new Map<string, { sender: WebContents; members: WorkbenchPeerMember[] }>()
  const watched = new Map<WebContents, () => void>()
  const pending = new Map<
    string,
    { sender: WebContents; task: WorkbenchPeerTask; finish(error?: unknown): void }
  >()
  const owns = (sender: WebContents, root: string): boolean => {
    const project = options.windows.getHubForWebContents(sender)?.getState().currentProject
    return !sender.isDestroyed() && !!project && resolve(project.path) === resolve(root)
  }
  const send = (sender: WebContents, event: WorkbenchPeerEvent): void => {
    if (sender.isDestroyed()) throw new AppError('CLOSED', '项目窗口已关闭。')
    sender.send(Channels.event, event)
  }
  const preparePeer = async (
    task: WorkbenchPeerTask,
    signal: AbortSignal,
    type: 'prepare' | 'prepare-guidance'
  ): Promise<WebContents> => {
    signal.throwIfAborted()
    const catalog = catalogs.get(resolve(task.projectRoot))
    if (!catalog || !owns(catalog.sender, task.projectRoot))
      throw new AppError('CLOSED', '项目窗口已关闭。')
    await new Promise<void>((yes, no) => {
      const abort = (): void => finish(AppError.from(signal.reason))
      const timer = setTimeout(
        () => finish(createTimeoutError('项目窗口未能接收会话任务。')),
        30_000
      )
      const finish = (error?: unknown): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        pending.delete(task.inputId)
        if (error) no(error)
        else yes()
      }
      pending.set(task.inputId, { sender: catalog.sender, task, finish })
      signal.addEventListener('abort', abort, { once: true })
      try {
        send(catalog.sender, { type, task })
      } catch (error) {
        finish(error)
      }
    })
    if (!owns(catalog.sender, task.projectRoot)) throw new AppError('CLOSED', '项目窗口已切换。')
    return catalog.sender
  }
  const peers = new WorkbenchSessionPeers({
    runtime: options.runtime,
    catalog: (ref) => {
      const catalog = catalogs.get(resolve(ref.projectRoot))
      return catalog && owns(catalog.sender, ref.projectRoot) ? catalog.members : []
    },
    prepare: async (task, signal) =>
      prepareWindowConversation({
        sender: await preparePeer(task, signal, 'prepare'),
        ref: task,
        inputId: task.inputId,
        goalMode: false,
        signal,
        recovery: options.recovery,
        runtime: options.runtime,
      }),
    prepareGuidance: async (task, signal) => {
      await preparePeer(task, signal, 'prepare-guidance')
    },
    acceptGuidance: (task) => {
      const sender = catalogs.get(resolve(task.projectRoot))?.sender
      if (sender && owns(sender, task.projectRoot))
        send(sender, { type: 'guidance-accepted', task })
    },
    cancelPreparation: (task, message) => {
      const sender = catalogs.get(resolve(task.projectRoot))?.sender
      if (!sender || !owns(sender, task.projectRoot)) return
      try {
        send(sender, { type: 'cancel', task, message })
      } catch (error) {
        Log.tag('WorkbenchSessionPeersIpc').warn('投递准备已撤销，窗口未收到通知', { inputId: task.inputId, error })
      }
    },
  })
  const releaseProject = (root: string): void => {
    peers.releaseProject(root)
    for (const delivery of pending.values())
      if (resolve(delivery.task.projectRoot) === resolve(root))
        delivery.finish(createAbortError('项目已关闭。'))
    catalogs.delete(resolve(root))
  }
  ipcMain.handle(Channels.catalog, (event, raw: unknown) =>
    callWithEnvelope(async () => {
      const request = z
        .object({
          projectRoot: z.string().min(1).max(8192),
          members: z
            .array(
              z.object({
                sessionId: z.string().min(1).max(512),
                title: z.string().max(500).nullable(),
              })
            )
            .max(10000),
        })
        .parse(raw)
      if (!owns(event.sender, request.projectRoot))
        throw new AppError('PERMISSION', '这个项目不属于当前窗口。')
      if (
        new Set(request.members.map((member) => member.sessionId)).size !== request.members.length
      )
        throw new AppError('VALIDATION', '会话目录含重复身份。')
      catalogs.set(resolve(request.projectRoot), { sender: event.sender, members: request.members })
      if (!watched.has(event.sender)) {
        const release = (): void => {
          for (const [root, catalog] of catalogs)
            if (catalog.sender === event.sender) releaseProject(root)
        }
        watched.set(event.sender, release)
        event.sender.on('destroyed', release)
        event.sender.on('render-process-gone', release)
      }
    })
  )
  ipcMain.handle(Channels.acknowledge, (event, raw: unknown) =>
    callWithEnvelope(async () => {
      const request = Ref.extend({
        inputId: z.string().min(1).max(512),
        error: z.string().max(8000).optional(),
      }).parse(raw)
      const delivery = pending.get(request.inputId)
      if (!delivery) throw new AppError('CANCELLED', '会话投递已结束。')
      if (
        delivery.sender !== event.sender ||
        !owns(event.sender, request.projectRoot) ||
        delivery.task.sessionId !== request.sessionId ||
        resolve(delivery.task.projectRoot) !== resolve(request.projectRoot)
      )
        throw new AppError('PERMISSION', '投递回执不属于这个窗口和会话。')
      delivery.finish(request.error ? new AppError('UNAVAILABLE', request.error) : undefined)
    })
  )
  return {
    peers,
    releaseProject,
    dispose: () => {
      peers.close()
      for (const root of catalogs.keys()) releaseProject(root)
      for (const [sender, release] of watched) {
        sender.removeListener('destroyed', release)
        sender.removeListener('render-process-gone', release)
      }
      watched.clear()
      ipcMain.removeHandler(Channels.catalog)
      ipcMain.removeHandler(Channels.acknowledge)
    },
  }
}
