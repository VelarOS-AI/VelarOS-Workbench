import { useEffect, useState } from 'react'

import type { WorkbenchBrowserState } from '@shared/workbenchBrowser'

/**
 * 这个聊天会话的 Agent 浏览器此刻进的站点：先问主进程一次，之后跟着站点变化的通知走（Agent 进出站点、页面
 * 自己跳走）。没进站点为 null——编辑区的浏览器标签据此出现与收起。
 */
export function useWorkbenchAgentBrowserSite(
  projectRoot: Nullable<string>,
  sessionId: string
): WorkbenchBrowserState['site'] {
  const [site, setSite] = useState<WorkbenchBrowserState['site']>(null)

  useEffect(() => {
    setSite(null)
    if (!projectRoot) return
    let disposed = false
    const unsubscribe = window.velarosWorkbenchBrowser.onChanged((state) => {
      if (state.sessionId === sessionId && sameRoot(state.projectRoot, projectRoot)) setSite(state.site)
    })
    void window.velarosWorkbenchBrowser
      .getState({ projectRoot, sessionId })
      .then((result) => {
        if (!disposed && result.ok) setSite(result.value.site)
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [projectRoot, sessionId])

  return site
}

function sameRoot(left: string, right: string): boolean {
  return left.replace(/[\\/]+$/u, '') === right.replace(/[\\/]+$/u, '')
}
