import { type ReactElement, useCallback, useEffect, useMemo, useRef } from 'react'

import {
  type WorkbenchControlledBrowserPage,
  WorkbenchWebviewDebugPanel,
} from './WorkbenchWebviewDebugPanel'

/** 接管失败时重试的次数与间隔：运行时刚知道站点、webview 刚挂上，偶尔要等一下。 */
const AttachRetries = 10
const AttachRetryDelayMs = 200

/**
 * 编辑区里的 Agent 浏览器标签：同一个 webview 交给主进程的浏览器运行时接管，模型和用户操作的是同一页。
 *
 * 标签切走时把页面交还（运行时隐藏它，这一轮运行要用网页时由后台页面顶上：藏起来的 webview 截不到图）；切回来
 * 再交出去。导航都经运行时，面板不自己 loadURL。
 */
export function WorkbenchAgentBrowserPanel({
  projectRoot,
  sessionId,
  url,
  active,
}: {
  projectRoot: string
  sessionId: string
  url: string
  active: boolean
}): ReactElement {
  /** 这个 webview 的 guest；dom-ready 时拿到。 */
  const guestIdRef = useRef<Nullable<number>>(null)
  /** 已经交给运行时的 guest；交还之后清空。 */
  const attachedIdRef = useRef<Nullable<number>>(null)
  const activeRef = useRef(active)
  activeRef.current = active

  const attachGuest = useCallback(
    (webContentsId: number, attempt = 0): void => {
      if (!activeRef.current || attachedIdRef.current === webContentsId) return
      attachedIdRef.current = webContentsId
      void window.velarosWorkbenchBrowser
        .attachPage({ projectRoot, sessionId, webContentsId })
        .catch((error: unknown) => ({ ok: false as const, message: String(error) }))
        .then((result) => {
          if (result.ok || attachedIdRef.current !== webContentsId) return
          attachedIdRef.current = null
          if (attempt + 1 < AttachRetries)
            setTimeout(() => attachGuest(webContentsId, attempt + 1), AttachRetryDelayMs)
        })
    },
    [projectRoot, sessionId]
  )

  const detachGuest = useCallback((): void => {
    if (attachedIdRef.current === null) return
    attachedIdRef.current = null
    void window.velarosWorkbenchBrowser.detachPage({ projectRoot, sessionId }).catch(() => undefined)
  }, [projectRoot, sessionId])

  useEffect(() => {
    if (active && guestIdRef.current !== null) attachGuest(guestIdRef.current)
    if (!active) detachGuest()
  }, [active, attachGuest, detachGuest])

  // 标签关掉（或换了会话）：页面交还给运行时，站点不动。
  useEffect(() => detachGuest, [detachGuest])

  const controlled = useMemo<WorkbenchControlledBrowserPage>(
    () => ({
      attach: (webContentsId) => {
        guestIdRef.current = webContentsId
        attachGuest(webContentsId)
      },
      navigate: (action, target) => {
        void window.velarosWorkbenchBrowser
          .navigate({ projectRoot, sessionId, action, url: target })
          .catch(() => undefined)
      },
    }),
    [attachGuest, projectRoot, sessionId]
  )

  return <WorkbenchWebviewDebugPanel url={url} controlled={controlled} />
}
