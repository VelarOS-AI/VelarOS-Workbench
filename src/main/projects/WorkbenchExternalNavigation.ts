export interface WorkbenchWindowOpenRequest {
  readonly url: string
}

export interface WorkbenchWindowOpenResponse {
  readonly action: 'deny'
}

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

/**
 * Renderer `window.open` is only a request to launch the system browser. The
 * Electron child-window path is denied for every URL, including malformed or
 * disallowed schemes, after the main process has validated the destination.
 */
export function installWorkbenchExternalNavigation(
  setWindowOpenHandler: SetWorkbenchWindowOpenHandler,
  openExternal: OpenWorkbenchExternalUrl,
  reportFailure: ReportWorkbenchExternalUrlFailure = () => undefined
): void {
  setWindowOpenHandler(({ url }) => {
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
