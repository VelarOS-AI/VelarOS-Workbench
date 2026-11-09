import { ipcMain, type WebContents } from 'electron'

import { AppError } from '@velaros-ai/velaros/core/error'

import {
  type WorkbenchWatchChangedPayload,
  WorkbenchWatchChannels,
  type WorkbenchWatchStartRequest,
  type WorkbenchWatchStatusPayload,
  type WorkbenchWatchStopRequest,
} from '../../../shared/workbenchWatch'
import { workbenchMainText } from '../../i18n/workbenchMainMessages'
import { callWithEnvelope, hasStringFields, invalidRequest } from '../ipcBoundary'

import type { WorkbenchFileWatcher } from './WorkbenchFileWatcher'

interface OwnedSubscription {
  senderId: number
  unsubscribe: () => void
}

export interface WorkbenchWatchIpcRegistration {
  closeSubscriptionsForSender: (senderId: number) => void
  dispose: () => void
}

export function registerWorkbenchWatchIpc(
  service: WorkbenchFileWatcher
): WorkbenchWatchIpcRegistration {
  const owned = new Map<string, OwnedSubscription>()
  const owners = new Map<number, symbol>()
  const closeSubscriptionsForSender = (senderId: number): void => {
    // 先撤销等待中的所有权：subscribe 的异步根解析还可能尚未返回。
    owners.delete(senderId)
    for (const [subscriptionId, subscription] of owned) {
      if (subscription.senderId !== senderId) continue
      subscription.unsubscribe()
      owned.delete(subscriptionId)
    }
  }

  ipcMain.handle(WorkbenchWatchChannels.start, (event, request: unknown) =>
    callWithEnvelope(async () => {
      const parsed = parseStartRequest(request)
      if (!parsed) return invalidRequest()

      const sender = event.sender
      const senderId = sender.id
      const owner = owners.get(senderId) ?? Symbol('watch-owner')
      owners.set(senderId, owner)
      installSenderCleanup(sender, closeSubscriptionsForSender)
      const result = await service.subscribe(
        parsed.workspaceRoot,
        (changedEvent) => {
          if (sender.isDestroyed()) return
          const payload: WorkbenchWatchChangedPayload = {
            subscriptionId: result.subscriptionId,
            event: changedEvent,
          }
          sender.send(WorkbenchWatchChannels.changed, payload)
        },
        // 监听停了 / 恢复了：只告诉发起订阅的窗口，由它把「改动收不到了」挂出来或收起。
        (status) => {
          if (sender.isDestroyed()) return
          const payload: WorkbenchWatchStatusPayload = {
            subscriptionId: result.subscriptionId,
            status,
          }
          sender.send(WorkbenchWatchChannels.status, payload)
        }
      )
      if (sender.isDestroyed() || owners.get(senderId) !== owner) {
        service.unsubscribe(result.subscriptionId)
        throw new AppError('CLOSED', 'File watch owner is no longer active.')
      }
      owned.set(result.subscriptionId, {
        senderId,
        unsubscribe: () => service.unsubscribe(result.subscriptionId),
      })
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
        throw new AppError('PERMISSION', workbenchMainText('watch.subscriptionNotInWindow'))
      }
      subscription.unsubscribe()
      owned.delete(parsed.subscriptionId)
    })
  )

  return {
    closeSubscriptionsForSender,
    dispose: () => {
      owners.clear()
      ipcMain.removeHandler(WorkbenchWatchChannels.start)
      ipcMain.removeHandler(WorkbenchWatchChannels.stop)
      for (const subscription of owned.values()) subscription.unsubscribe()
      owned.clear()
      service.dispose()
    },
  }
}

const cleanupInstalled = new WeakSet<WebContents>()

function installSenderCleanup(
  sender: WebContents,
  closeSubscriptionsForSender: (senderId: number) => void
): void {
  if (cleanupInstalled.has(sender)) return
  cleanupInstalled.add(sender)
  const senderId = sender.id
  sender.once('destroyed', () => {
    closeSubscriptionsForSender(senderId)
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
