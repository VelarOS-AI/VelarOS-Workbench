import { resolve } from 'node:path'

import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { ipcMain } from 'electron'

import { isFiniteNumber, isNonBlankString, isPlainObject, isString } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'

import {
  WorkbenchBrowserChannels,
  type WorkbenchBrowserNavigateRequest,
  type WorkbenchBrowserNavigationAction,
  type WorkbenchBrowserSessionRequest,
} from '../../shared/workbenchBrowser'
import { workbenchMainText } from '../i18n/workbenchMainMessages'
import type { WorkbenchProjectHub } from '../projects/ProjectHub'
import { callWithEnvelope } from '../workspace/ipcBoundary'

import type { WorkbenchBrowserRef, WorkbenchBrowserService } from './WorkbenchBrowserService'

interface WorkbenchBrowserWindows {
  getHubForWebContents(sender: WebContents): Nullable<WorkbenchProjectHub>
  getWebContentsForProject(projectRoot: string): Nullable<WebContents>
  assertProjectForWebContents(sender: WebContents, requestedRoot: string): void
}

const NavigationActions = new Set<WorkbenchBrowserNavigationAction>([
  'goto',
  'back',
  'forward',
  'reload',
])

/**
 * Agent 浏览器的界面通道：窗口只能动自己当前打开的项目里的会话；站点变化只推给这个项目的窗口。
 */
export function registerWorkbenchBrowserIpc(options: {
  browser: WorkbenchBrowserService
  windows: WorkbenchBrowserWindows
}): () => void {
  const { browser, windows } = options
  const ownedRef = (event: IpcMainInvokeEvent, raw: unknown): WorkbenchBrowserRef => {
    const request = parseSessionRequest(raw)
    const project = windows.getHubForWebContents(event.sender)?.getState().currentProject
    if (!project || resolve(project.path) !== resolve(request.projectRoot))
      throw new AppError('PERMISSION', workbenchMainText('browser.notInWindow'))
    return { projectRoot: project.path, sessionId: request.sessionId }
  }

  ipcMain.handle(WorkbenchBrowserChannels.getState, (event, raw: unknown) =>
    callWithEnvelope(async () => browser.state(ownedRef(event, raw)))
  )
  ipcMain.handle(WorkbenchBrowserChannels.attachPage, (event, raw: unknown) =>
    callWithEnvelope(async () => {
      const ref = ownedRef(event, raw)
      const webContentsId = isPlainObject(raw) ? raw.webContentsId : undefined
      if (!isFiniteNumber(webContentsId))
        throw new AppError('VALIDATION', workbenchMainText('browser.invalidRequest'))
      windows.assertProjectForWebContents(event.sender, ref.projectRoot)
      await browser.attachPage(ref, webContentsId, event.sender)
    })
  )
  ipcMain.handle(WorkbenchBrowserChannels.detachPage, (event, raw: unknown) =>
    callWithEnvelope(() => browser.detachPage(ownedRef(event, raw)))
  )
  ipcMain.handle(WorkbenchBrowserChannels.navigate, (event, raw: unknown) =>
    callWithEnvelope(async () => {
      const ref = ownedRef(event, raw)
      const { action, url } = parseNavigateRequest(raw)
      windows.assertProjectForWebContents(event.sender, ref.projectRoot)
      await browser.navigate(ref, action, url)
    })
  )
  ipcMain.handle(WorkbenchBrowserChannels.leaveSite, (event, raw: unknown) =>
    callWithEnvelope(() => browser.leaveSite(ownedRef(event, raw)))
  )
  const unsubscribe = browser.onChanged((state) => {
    const target = windows.getWebContentsForProject(state.projectRoot)
    if (target && !target.isDestroyed()) target.send(WorkbenchBrowserChannels.changed, state)
  })
  return () => {
    unsubscribe()
    for (const channel of [
      WorkbenchBrowserChannels.getState,
      WorkbenchBrowserChannels.attachPage,
      WorkbenchBrowserChannels.detachPage,
      WorkbenchBrowserChannels.navigate,
      WorkbenchBrowserChannels.leaveSite,
    ])
      ipcMain.removeHandler(channel)
  }
}

function parseSessionRequest(raw: unknown): WorkbenchBrowserSessionRequest {
  if (!isPlainObject(raw) || !isNonBlankString(raw.projectRoot) || !isNonBlankString(raw.sessionId))
    throw new AppError('VALIDATION', workbenchMainText('browser.invalidRequest'))
  return { projectRoot: raw.projectRoot, sessionId: raw.sessionId }
}

function parseNavigateRequest(
  raw: unknown
): Pick<WorkbenchBrowserNavigateRequest, 'action' | 'url'> {
  if (
    !isPlainObject(raw) ||
    !isString(raw.action) ||
    !NavigationActions.has(raw.action as WorkbenchBrowserNavigationAction)
  )
    throw new AppError('VALIDATION', workbenchMainText('browser.invalidRequest'))
  const action = raw.action as WorkbenchBrowserNavigationAction
  if (action !== 'goto') return { action }
  if (!isNonBlankString(raw.url))
    throw new AppError('VALIDATION', workbenchMainText('browser.invalidRequest'))
  return { action, url: raw.url }
}
