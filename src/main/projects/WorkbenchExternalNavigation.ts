import type { BrowserWindowConstructorOptions, WindowOpenHandlerResponse } from 'electron'

import { WorkbenchAgentConsoleFrameName } from '../../shared/workbenchAgentProcesses'

export interface WorkbenchWindowOpenRequest {
  readonly url: string
  readonly frameName?: string
}

export type WorkbenchWindowOpenResponse = WindowOpenHandlerResponse

export type WorkbenchWindowOpenHandler = (
  request: WorkbenchWindowOpenRequest
) => WorkbenchWindowOpenResponse

type SetWorkbenchWindowOpenHandler = (handler: WorkbenchWindowOpenHandler) => void
type OpenWorkbenchExternalUrl = (url: string) => Promise<void>
type ReportWorkbenchExternalUrlFailure = (url: string, error: unknown) => void

const DenyWindowOpen = { action: 'deny' } as const

const WorkbenchExternalSchemes = new Set(['http:', 'https:', 'mailto:'])

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

export function normalizeWorkbenchExternalUrl(rawUrl: string): string | null {
  if (containsControlCharacter(rawUrl)) return null

  try {
    const url = new URL(rawUrl)
    if (!WorkbenchExternalSchemes.has(url.protocol)) return null
    if (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (!url.hostname || url.username || url.password)
    )
      return null
    return url.href
  } catch {
    return null
  }
}

export function isWorkbenchAgentConsoleRequest(request: WorkbenchWindowOpenRequest): boolean {
  return request.url === 'about:blank' && request.frameName === WorkbenchAgentConsoleFrameName
}

/** The app may host its named console portal; validated external URLs use the system browser. */
export function installWorkbenchExternalNavigation(
  setWindowOpenHandler: SetWorkbenchWindowOpenHandler,
  openExternal: OpenWorkbenchExternalUrl,
  reportFailure: ReportWorkbenchExternalUrlFailure = () => undefined,
  consoleOptions?: BrowserWindowConstructorOptions
): void {
  setWindowOpenHandler((request) => {
    if (consoleOptions && isWorkbenchAgentConsoleRequest(request))
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...consoleOptions,
          webPreferences: {
            preload: '',
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webviewTag: false,
          },
        },
      }
    const { url } = request
    const externalUrl = normalizeWorkbenchExternalUrl(url)
    if (externalUrl) {
      try {
        void openExternal(externalUrl).catch((error) => reportFailure(externalUrl, error))
      } catch (error) {
        reportFailure(externalUrl, error)
      }
    }
    return DenyWindowOpen
  })
}
