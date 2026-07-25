import { ipcMain, type WebContents } from 'electron'

import { AppError } from '@velaros/core/error'

import {
  type WorkbenchWatchChangedPayload,
  WorkbenchWatchChannels,
  type WorkbenchWatchStartRequest,
  type WorkbenchWatchStopRequest,
} from '../../../shared/workbenchWatch'
import { callWithEnvelope, hasStringFields, invalidRequest } from '../ipcBoundary'

import type { WorkbenchFileWatcher } from './WorkbenchFileWatcher'

interface OwnedSubscription {
  senderId: number
  unsubscribe: () => void
}

export function registerWorkbenchWatchIpc(service: WorkbenchFileWatcher): () => void {
  const owned = new Map<string, OwnedSubscription>()

  ipcMain.handle(WorkbenchWatchChannels.start, (event, request: unknown) =>
    callWithEnvelope(async () => {
      const parsed = parseStartRequest(request)
      if (!parsed) return invalidRequest()

      const sender = event.sender
      const result = await service.subscribe(parsed.workspaceRoot, (changedEvent) => {
        if (sender.isDestroyed()) return
        const payload: WorkbenchWatchChangedPayload = {
          subscriptionId: result.subscriptionId,
          event: changedEvent,
        }
        sender.send(WorkbenchWatchChannels.changed, payload)
      })
      owned.set(result.subscriptionId, {
        senderId: sender.id,
        unsubscribe: () => service.unsubscribe(result.subscriptionId),
      })
      installSenderCleanup(sender, owned)
      return result
    })
  )

  ipcMain.handle(WorkbenchWatchChannels.stop, (event, request: unknown) =>
    callWithEnvelope(async () => {
      const parsed = parseStopRequest(request)
      if (!parsed) return invalidRequest()

      const subscription = owned.get(parsed.subscriptionId)
      if (!subscription) return
      if (subscription.senderId !== event.sender.id) {
        throw new AppError('PERMISSION', '文件监听订阅不属于当前窗口。')
      }
      subscription.unsubscribe()
      owned.delete(parsed.subscriptionId)
    })
  )

  return () => {
    ipcMain.removeHandler(WorkbenchWatchChannels.start)
    ipcMain.removeHandler(WorkbenchWatchChannels.stop)
    for (const subscription of owned.values()) subscription.unsubscribe()
    owned.clear()
    service.dispose()
  }
}

const cleanupInstalled = new WeakSet<WebContents>()

function installSenderCleanup(
  sender: WebContents,
  owned: Map<string, OwnedSubscription>
): void {
  if (cleanupInstalled.has(sender)) return
  cleanupInstalled.add(sender)
  sender.once('destroyed', () => {
    for (const [subscriptionId, subscription] of owned) {
      if (subscription.senderId !== sender.id) continue
      subscription.unsubscribe()
      owned.delete(subscriptionId)
    }
  })
}

function parseStartRequest(input: unknown): Nullable<WorkbenchWatchStartRequest> {
  if (!hasStringFields(input, ['workspaceRoot'])) return null
  return { workspaceRoot: input['workspaceRoot'] as string }
}

function parseStopRequest(input: unknown): Nullable<WorkbenchWatchStopRequest> {
  if (!hasStringFields(input, ['subscriptionId'])) return null
  return { subscriptionId: input['subscriptionId'] as string }
}
