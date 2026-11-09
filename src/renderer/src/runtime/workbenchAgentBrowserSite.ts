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
  const [snapshot, setSnapshot] = useState<Nullable<WorkbenchBrowserState>>(null)

  useEffect(() => {
    setSnapshot(null)
    if (!projectRoot) return
    let disposed = false
    let receivedChange = false
    const unsubscribe = window.velarosWorkbenchBrowser.onChanged((state) => {
      if (disposed || state.sessionId !== sessionId || !sameRoot(state.projectRoot, projectRoot))
        return
      receivedChange = true
      setSnapshot(state)
    })
    void window.velarosWorkbenchBrowser
      .getState({ projectRoot, sessionId })
      .then((result) => {
        // 首次快照在通知之后才回来时，不覆盖已经收到的新站点。
        if (
          !disposed &&
          !receivedChange &&
          result.ok &&
          result.value.sessionId === sessionId &&
          sameRoot(result.value.projectRoot, projectRoot)
        )
          setSnapshot(result.value)
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [projectRoot, sessionId])

  return projectRoot &&
    snapshot?.sessionId === sessionId &&
    sameRoot(snapshot.projectRoot, projectRoot)
    ? snapshot.site
    : null
}

function sameRoot(left: string, right: string): boolean {
  return left.replace(/[\\/]+$/u, '') === right.replace(/[\\/]+$/u, '')
}
