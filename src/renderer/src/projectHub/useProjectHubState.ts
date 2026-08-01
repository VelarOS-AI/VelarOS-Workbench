/**
 * 项目枢纽状态投影 hook：初始拉取 + 订阅 main 广播；动作一律直通 preload 桥
 * （`window.velarosWorkbenchProjectHub`），renderer 不持有第二份权威状态。
 */
import { useEffect, useState } from 'react'

import type { WorkbenchProjectHubState } from '../../../shared/projectHub'

interface ProjectHubStateProjection {
  state: WorkbenchProjectHubState
  /** 初始状态是否已从 main 到达（避免起手页/工作台在拉取完成前闪跳）。 */
  ready: boolean
}

const EmptyProjectHubState: WorkbenchProjectHubState = {
  currentProject: null,
  recentProjects: [],
}

export function useProjectHubState(): ProjectHubStateProjection {
  const [state, setState] = useState<WorkbenchProjectHubState>(EmptyProjectHubState)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let disposed = false

    void window.velarosWorkbenchProjectHub.getState().then((initial) => {
      if (disposed) return

      setState(initial)
      setReady(true)
    })

    const unsubscribe = window.velarosWorkbenchProjectHub.onStateChanged((next) => {
      setState(next)
      setReady(true)
    })

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  return { state, ready }
}
