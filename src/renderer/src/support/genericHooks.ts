/**
 * 独立 Workbench 应用的通用 hook 门面（对位 desktop `@hooks/generic`）。
 *
 * 复活的 workbench surface 源码原样消费 `useMemoizedFn` / `useLatest` / `useTimerScope` 等
 * 基础钩子；desktop 侧它们分散在 ahooks 门面 + 两个本地实现，这里收敛成单文件门面，
 * 行为与 desktop 逐字一致（useTimerScope / useMonotonicAsyncRequest 为 desktop 同源拷贝）。
 */
import { type MutableRefObject, useEffect, useRef } from 'react'
import { useMemoizedFn } from 'ahooks'

import type { TimerScope as TimerScopeType } from '@velaros-ai/velaros/core/utils/TimerScope'
import { TimerScope } from '@velaros-ai/velaros/core/utils/TimerScope'

export {
  useBoolean,
  useClickAway,
  useDebounceFn,
  useEventListener,
  useInterval,
  useLatest,
  useLockFn,
  useMemoizedFn,
  useMount,
  useSetState,
  useTimeout,
  useUnmount,
} from 'ahooks'

interface TimerScopeLifecycleState {
  committedEffectVersion: number
  scope: LooseOptional<TimerScopeType>
}

function createTimerScopeLifecycleState(): TimerScopeLifecycleState {
  return {
    committedEffectVersion: 0,
    scope: null,
  }
}

function prepareTimerScopeRender(state: TimerScopeLifecycleState, name?: string): TimerScopeType {
  if (!state.scope || state.scope.isDisposed) {
    state.scope = new TimerScope({ name })
  }

  return state.scope
}

function markTimerScopeCommitted(
  state: TimerScopeLifecycleState,
  scope: TimerScopeType
): () => void {
  state.committedEffectVersion += 1
  const committedEffectVersion = state.committedEffectVersion

  return () => {
    queueMicrotask(() => {
      if (state.committedEffectVersion !== committedEffectVersion) return
      if (state.scope !== scope) return

      scope.dispose()
      state.scope = null
    })
  }
}

/** 组件生命周期绑定的计时器作用域（desktop `@hooks/ui/useTimerScope` 同源）。 */
export function useTimerScope(name?: string): TimerScopeType {
  const lifecycleRef = useRef<LooseOptional<TimerScopeLifecycleState>>(null)
  if (!lifecycleRef.current) {
    lifecycleRef.current = createTimerScopeLifecycleState()
  }

  const lifecycle = lifecycleRef.current
  const timers = prepareTimerScopeRender(lifecycle, name)

  useEffect(() => markTimerScopeCommitted(lifecycle, timers), [lifecycle, timers])

  return timers
}

export interface UseMonotonicAsyncRequestResult {
  /** 开始一次逻辑异步请求代际，并标记刷新进行中。 */
  start: () => number
  /** 传入代际匹配最近一次开始结果时返回真。 */
  isActive: (generation: number) => boolean
  /** 只有没有更新请求开始时，才清理进行中标记并运行收尾回调。 */
  completeIfActive: (generation: number, finalize?: () => void) => void
  /** 当前闸门代际处于打开期间时为真。 */
  inFlightRef: MutableRefObject<boolean>
  /** 推进代际并清理进行中标记，让过期完成被忽略。 */
  abandonInFlightRequests: () => void
}

/** 请求代际守卫（desktop `@hooks/useMonotonicAsyncRequest` 同源）。 */
export function useMonotonicAsyncRequest(): UseMonotonicAsyncRequestResult {
  const generationRef = useRef(0)
  const inFlightRef = useRef(false)

  const start = useMemoizedFn((): number => {
    generationRef.current += 1
    const nextGeneration = generationRef.current
    inFlightRef.current = true
    return nextGeneration
  })

  const isActive = useMemoizedFn(
    (generation: number): boolean => generationRef.current === generation
  )

  const completeIfActive = useMemoizedFn((generation: number, finalize?: () => void): void => {
    if (generationRef.current !== generation) return
    inFlightRef.current = false
    finalize?.()
  })

  const abandonInFlightRequests = useMemoizedFn((): void => {
    generationRef.current += 1
    inFlightRef.current = false
  })

  return { start, isActive, completeIfActive, inFlightRef, abandonInFlightRequests }
}
