/**
 * 项目枢纽状态投影 hook：初始拉取 + 订阅 main 广播；动作一律直通 preload 桥
 * （`window.velarosWorkbenchProjectHub`），renderer 不持有第二份权威状态。
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react'

import { AppError } from '@velaros-ai/velaros/core/error'

import type { WorkbenchProjectHubState } from '../../../shared/projectHub'

type ProjectHubStateProjection =
  | { kind: 'loading' }
  | { kind: 'ready'; state: WorkbenchProjectHubState }
  | { kind: 'error'; message: string }

interface ProjectHubReadOwner {
  /** 广播是更新的事实；到达后初始读取及重试快照都不可再覆盖它。 */
  receivedLive: boolean
  read: Nullable<object>
}

export function useProjectHubState(): ProjectHubStateProjection & { retry(): void } {
  const [projection, setProjection] = useState<ProjectHubStateProjection>({ kind: 'loading' })
  const ownerRef = useRef<Nullable<ProjectHubReadOwner>>(null)

  const retry = useCallback((): void => {
    const owner = ownerRef.current
    if (!owner || owner.receivedLive || owner.read) return
    const read = {}
    owner.read = read
    setProjection((current) => current.kind === 'ready' ? current : { kind: 'loading' })
    void (async () => {
      try {
        const state = await window.velarosWorkbenchProjectHub.getState()
        if (ownerRef.current !== owner || owner.read !== read) return
        owner.read = null
        setProjection({ kind: 'ready', state })
      } catch (error) {
        if (ownerRef.current !== owner || owner.read !== read) return
        owner.read = null
        setProjection({ kind: 'error', message: AppError.getMessage(error) })
      }
    })()
  }, [])

  useLayoutEffect(() => {
    const owner: ProjectHubReadOwner = { receivedLive: false, read: null }
    ownerRef.current = owner

    const unsubscribe = window.velarosWorkbenchProjectHub.onStateChanged((next) => {
      if (ownerRef.current !== owner) return
      owner.receivedLive = true
      owner.read = null
      setProjection({ kind: 'ready', state: next })
    })
    retry()

    return () => {
      if (ownerRef.current === owner) ownerRef.current = null
      unsubscribe()
    }
  }, [retry])

  return { ...projection, retry }
}
