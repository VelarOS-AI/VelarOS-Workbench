import { BrowserWindow, ipcMain, shell } from 'electron'

import { Log } from '@velaros-ai/velaros/core'
import { Result } from '@velaros-ai/velaros/core/result'

import {
  WorkbenchProductAnalyticsChannels,
  type WorkbenchProductAnalyticsState,
} from '../../shared/workbenchProductAnalytics'

import { WorkbenchProductAnalyticsPreferencesStore } from './WorkbenchProductAnalyticsPreferencesStore'
import type { WorkbenchProductAnalyticsReporter } from './WorkbenchProductAnalyticsReporter'

export function installWorkbenchProductAnalyticsRuntime(input: {
  readonly dataRootDir: string
  readonly privacyDetailsUrl: string
  readonly reporter?: WorkbenchProductAnalyticsReporter
}): () => Promise<void> {
  const startup = Result.wrapSync(() =>
    new WorkbenchProductAnalyticsPreferencesStore(input.dataRootDir)
  )
  const removeHandlers = (): void => {
    for (const channel of Object.values(WorkbenchProductAnalyticsChannels))
      if (channel !== WorkbenchProductAnalyticsChannels.changed) ipcMain.removeHandler(channel)
  }
  ipcMain.handle(WorkbenchProductAnalyticsChannels.openDetails, () =>
    shell.openExternal(input.privacyDetailsUrl)
  )
  if (!startup.ok) {
    input.reporter?.setEnabled(false)
    Log.tag('WorkbenchProductAnalytics').error('Product analytics preferences are unavailable', {
      error: startup.error,
    })
    for (const channel of [
      WorkbenchProductAnalyticsChannels.getState,
      WorkbenchProductAnalyticsChannels.setEnabled,
      WorkbenchProductAnalyticsChannels.resolveNotice,
    ])
      ipcMain.handle(channel, () => Result.unwrap(startup))
    return () => Promise.resolve(removeHandlers())
  }
  const preferences = startup.data
  const lifetime = new AbortController()
  let revision = 0
  let consentReceiptInFlight: Promise<void> | undefined
  let closing: Promise<void> | undefined

  const getState = (): WorkbenchProductAnalyticsState => ({
    revision,
    ...preferences.value,
  })
  const broadcast = (): void => {
    const state = getState()
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(WorkbenchProductAnalyticsChannels.changed, state)
      }
    }
  }
  const requireNotice = (): void => {
    if (lifetime.signal.aborted) return
    const previous = preferences.value
    preferences.requireNotice()
    if (previous === preferences.value) return
    revision += 1
    broadcast()
  }
  const applyReporterState = (): void => {
    const value = preferences.value
    input.reporter?.setEnabled(value.enabled)
    input.reporter?.setConsentState({
      noticeResolved: value.noticeResolved,
      reportingAllowed:
        value.enabled &&
        value.noticeResolved &&
        value.consentDecision === 'allowed' &&
        value.consentReceiptRecorded,
      onNoticeRequired: requireNotice,
    })
  }
  const synchronizeConsentReceipt = (): Promise<void> => {
    if (lifetime.signal.aborted) return Promise.resolve()
    const value = preferences.value
    if (!input.reporter || value.consentDecision === 'unresolved' || value.consentReceiptRecorded)
      return Promise.resolve()
    if (consentReceiptInFlight) return consentReceiptInFlight
    const decision = value.consentDecision
    const operation = input.reporter
      .recordConsentDecision(decision, lifetime.signal)
      .then(async () => {
        if (lifetime.signal.aborted || preferences.value.consentDecision !== decision) return
        preferences.markConsentReceiptRecorded()
        revision += 1
        applyReporterState()
        broadcast()
        if (preferences.value.enabled) await input.reporter?.flush(true)
      })
      .catch(() => undefined)
      .finally(() => {
        if (consentReceiptInFlight !== operation) return
        consentReceiptInFlight = undefined
        if (lifetime.signal.aborted) return
        const current = preferences.value
        if (
          current.consentDecision !== 'unresolved' &&
          current.consentDecision !== decision &&
          !current.consentReceiptRecorded
        )
          void synchronizeConsentReceipt()
      })
    consentReceiptInFlight = operation
    return operation
  }

  applyReporterState()
  void synchronizeConsentReceipt()
  const consentReceiptRetryTimer = setInterval(
    () => void synchronizeConsentReceipt(),
    10 * 60_000
  )
  consentReceiptRetryTimer.unref?.()

  ipcMain.handle(WorkbenchProductAnalyticsChannels.getState, getState)
  ipcMain.handle(WorkbenchProductAnalyticsChannels.setEnabled, (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Product analytics setting must be boolean.')
    preferences.setEnabled(enabled)
    applyReporterState()
    revision += 1
    broadcast()
    void synchronizeConsentReceipt()
    return getState()
  })
  ipcMain.handle(WorkbenchProductAnalyticsChannels.resolveNotice, (_event, decision: unknown) => {
    if (decision !== 'allowed' && decision !== 'declined') {
      throw new Error('Product analytics choice is invalid.')
    }
    preferences.resolveNotice(decision)
    applyReporterState()
    revision += 1
    broadcast()
    void synchronizeConsentReceipt()
    return getState()
  })
  return () => {
    if (!closing) {
      lifetime.abort()
      clearInterval(consentReceiptRetryTimer)
      removeHandlers()
      // Abort is a stop request. Even an uncooperative transport must actually
      // settle before the runtime's close receipt allows its reporter to close.
      closing = consentReceiptInFlight ?? Promise.resolve()
    }
    return closing
  }
}
