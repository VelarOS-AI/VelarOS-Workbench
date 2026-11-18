import { randomUUID } from 'node:crypto'

import type { BrowserWindow, WebContents } from 'electron'

import { AppError } from '@velaros-ai/velaros/core/error'

import {
  type WorkbenchHistoryRestoreRequest,
  type WorkbenchHistoryRestoreResult,
  WorkbenchHistoryWindowChannels,
  type WorkbenchHistoryWindowFile,
  type WorkbenchHistoryWindowState,
  type WorkbenchHistoryWindowSync,
} from '../../shared/workbenchHistoryWindow'

import type { WorkbenchWindowManager } from './WorkbenchWindowManager'

interface HistoryWindowRecord {
  owner: BrowserWindow
  window: BrowserWindow
  state: WorkbenchHistoryWindowState
  pending?: {
    id: string
    settle: (result: WorkbenchHistoryRestoreResult) => void
  }
}

interface HistoryWindowsOptions {
  windows: Pick<
    WorkbenchWindowManager,
    'getWindowForWebContents' | 'registerAuxiliaryWindow' | 'assertProjectForWebContents'
  >
  createWindow: (owner: BrowserWindow) => BrowserWindow
  loadWindow: (window: BrowserWindow) => void
}

/** A modeless history viewer belongs to its editor, not a second project workspace. */
export class WorkbenchHistoryWindows {
  private readonly records = new Map<number, HistoryWindowRecord>()

  public constructor(private readonly options: HistoryWindowsOptions) {}

  public open(sender: WebContents, file: WorkbenchHistoryWindowFile): void {
    const ownerId = sender.id
    const owner = this.options.windows.getWindowForWebContents(sender)
    if (!owner || owner.isDestroyed() || owner.webContents.id !== sender.id)
      throw new AppError('PERMISSION', 'History requires a project editor window')
    if (
      !file ||
      typeof file.projectRoot !== 'string' ||
      typeof file.path !== 'string' ||
      !file.path ||
      typeof file.currentContent !== 'string' ||
      typeof file.editable !== 'boolean' ||
      (file.mode !== 'local' && file.mode !== 'git')
    )
      throw new TypeError('Invalid history window file')
    this.options.windows.assertProjectForWebContents(sender, file.projectRoot)
    const state: WorkbenchHistoryWindowState = { ...file, id: randomUUID(), available: true }
    const existing = this.records.get(sender.id)
    if (existing && !existing.window.isDestroyed()) {
      existing.pending?.settle({ ok: false, reason: 'stale' })
      existing.state = state
      existing.window.webContents.send(WorkbenchHistoryWindowChannels.changed, state)
      if (existing.window.isMinimized()) existing.window.restore()
      existing.window.show()
      existing.window.focus()
    } else {
      const window = this.options.createWindow(owner)
      const record: HistoryWindowRecord = { owner, window, state }
      this.records.set(sender.id, record)
      this.options.windows.registerAuxiliaryWindow(sender, window)
      // BrowserWindow.webContents becomes null during destruction. Retain the
      // original emitter so cleanup never dereferences a destroyed owner window.
      const ownerContents = sender
      const closeWithRenderer = (): void => {
        if (!window.isDestroyed()) window.close()
      }
      ownerContents.once('render-process-gone', closeWithRenderer)
      window.once('closed', () => {
        ownerContents.removeListener('render-process-gone', closeWithRenderer)
        record.pending?.settle({ ok: false, reason: 'unavailable' })
        if (this.records.get(ownerId) === record) {
          this.records.delete(ownerId)
          if (!ownerContents.isDestroyed())
            ownerContents.send(WorkbenchHistoryWindowChannels.opened, null)
        }
      })
      window.once('ready-to-show', () => {
        if (!window.isDestroyed()) {
          window.show()
          window.focus()
        }
      })
      this.options.loadWindow(window)
    }
    sender.send(WorkbenchHistoryWindowChannels.opened, state)
  }

  public getState(sender: WebContents): WorkbenchHistoryWindowState {
    return this.childRecord(sender).state
  }

  public synchronize(sender: WebContents, update: WorkbenchHistoryWindowSync | null): void {
    const record = this.records.get(sender.id)
    if (!record) return
    if (!update) {
      record.window.close()
      return
    }
    if (update.id !== record.state.id) return
    if (
      (update.currentContent !== null && typeof update.currentContent !== 'string') ||
      typeof update.editable !== 'boolean'
    )
      throw new TypeError('Invalid history editor state')
    const available = update.currentContent !== null
    const currentContent = update.currentContent ?? record.state.currentContent
    if (
      currentContent === record.state.currentContent &&
      available === record.state.available &&
      update.editable === record.state.editable
    )
      return
    record.state = { ...record.state, currentContent, available, editable: update.editable }
    record.window.webContents.send(WorkbenchHistoryWindowChannels.changed, record.state)
  }

  public close(sender: WebContents): void {
    this.childRecord(sender).window.close()
  }

  public async restore(
    sender: WebContents,
    request: { id: string; expectedContent: string; content: string }
  ): Promise<WorkbenchHistoryRestoreResult> {
    const record = this.childRecord(sender)
    if (
      !request ||
      typeof request.content !== 'string' ||
      typeof request.expectedContent !== 'string'
    )
      throw new TypeError('Invalid history restore request')
    if (request.id !== record.state.id || request.expectedContent !== record.state.currentContent)
      return { ok: false, reason: 'stale' }
    if (!record.state.available) return { ok: false, reason: 'closed' }
    if (!record.state.editable) return { ok: false, reason: 'read-only' }
    if (record.pending) return { ok: false, reason: 'unavailable' }
    try {
      this.options.windows.assertProjectForWebContents(
        record.owner.webContents,
        record.state.projectRoot
      )
    } catch {
      return { ok: false, reason: 'unavailable' }
    }
    return new Promise((resolve) => {
      const id = randomUUID()
      const timeout = setTimeout(() => settle({ ok: false, reason: 'unavailable' }), 10_000)
      const settle = (result: WorkbenchHistoryRestoreResult): void => {
        clearTimeout(timeout)
        if (record.pending?.id === id) record.pending = undefined
        resolve(result)
      }
      record.pending = { id, settle }
      const message: WorkbenchHistoryRestoreRequest = {
        requestId: id,
        projectRoot: record.state.projectRoot,
        path: record.state.path,
        expectedContent: request.expectedContent,
        content: request.content,
      }
      record.owner.webContents.send(WorkbenchHistoryWindowChannels.restoreRequested, message)
    })
  }

  public resolveRestore(
    sender: WebContents,
    response: { requestId: string; result: WorkbenchHistoryRestoreResult }
  ): void {
    const record = this.records.get(sender.id)
    if (!record?.pending || record.pending.id !== response?.requestId) return
    const result = response.result
    if (
      !result ||
      (result.ok !== true &&
        (result.ok !== false ||
          !['stale', 'closed', 'read-only', 'unavailable'].includes(result.reason)))
    )
      throw new TypeError('Invalid history restore result')
    record.pending.settle(result)
    if (result.ok) {
      if (record.owner.isMinimized()) record.owner.restore()
      record.owner.show()
      record.owner.focus()
    }
  }

  public dispose(): void {
    for (const record of this.records.values())
      if (!record.window.isDestroyed()) record.window.close()
    this.records.clear()
  }

  private childRecord(sender: WebContents): HistoryWindowRecord {
    const record = [...this.records.values()].find(
      (entry) => entry.window.webContents.id === sender.id
    )
    if (!record || record.window.isDestroyed() || record.owner.isDestroyed())
      throw new AppError('PERMISSION', 'Not a history window')
    return record
  }
}
