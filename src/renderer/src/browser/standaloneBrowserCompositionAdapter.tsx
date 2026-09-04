import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { WorkbenchWebviewDebugPanel } from '@renderer/components/editor/WorkbenchWebviewDebugPanel'

import type {
  BrowserCompositionAdapter,
  ControlledBrowserSurface,
  ControlledBrowserSurfaceInput,
} from '@velaros-ai/browser/composition'

import type { WorkbenchBrowserState } from '@shared/workbenchBrowser'

function useKernelBrowserSurface(
  input: ControlledBrowserSurfaceInput
): ControlledBrowserSurface {
  const [browserState, setBrowserState] = useState<WorkbenchBrowserState | null>(null)
  const latestGenerationRef = useRef(0)
  const presentedGuestRef = useRef<string | null>(null)
  const activeSessionRef = useRef(input.sessionId)
  activeSessionRef.current = input.sessionId

  const acceptAuthoritativeState = useCallback((next: WorkbenchBrowserState): void => {
    if (
      activeSessionRef.current !== input.sessionId
      || next.sessionId !== input.sessionId
    ) return
    latestGenerationRef.current = Math.max(latestGenerationRef.current, next.generation)
    setBrowserState((current) => {
      if (
        current?.sessionId === next.sessionId
        && current.generation > next.generation
      ) return current
      return next
    })
  }, [input.sessionId])

  useEffect(() => {
    let disposed = false
    let requestSequence = 0
    latestGenerationRef.current = 0
    presentedGuestRef.current = null

    const refresh = async (): Promise<void> => {
      const sequence = requestSequence += 1
      try {
        const next = await window.velarosWorkbenchBrowser.getState({
          sessionId: input.sessionId,
        })
        if (!disposed) acceptAuthoritativeState(next)
      } catch {
        // 状态仍由 main 持有；短暂 IPC 失败时保留最后一份已确认快照，等下一次通知重取。
        if (sequence !== requestSequence) return
      }
    }

    setBrowserState((current) => current?.sessionId === input.sessionId ? current : null)
    void refresh()
    const unsubscribe = window.velarosWorkbenchBrowser.onChanged((event) => {
      if (event.generation <= latestGenerationRef.current) return
      void refresh()
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [acceptAuthoritativeState, input.sessionId])

  const currentState = browserState?.sessionId === input.sessionId ? browserState : null
  const handleWebContentsReady = useCallback((webContentsId: number): void => {
    const presentationKey = `${input.sessionId}:${webContentsId}`
    if (presentedGuestRef.current === presentationKey) return
    presentedGuestRef.current = presentationKey
    void window.velarosWorkbenchBrowser.presentPage({
      sessionId: input.sessionId,
      webContentsId,
    }).then(acceptAuthoritativeState).catch(() => {
      // dom-ready 会在重新加载后再次触发；清除键即可允许同一 guest 重试绑定。
      if (presentedGuestRef.current === presentationKey) presentedGuestRef.current = null
    })
  }, [acceptAuthoritativeState, input.sessionId])

  const render = useCallback(
    (): ReactNode => (
      <WorkbenchWebviewDebugPanel
        url={currentState?.url ?? 'about:blank'}
        onWebContentsReady={handleWebContentsReady}
      />
    ),
    [currentState?.url, handleWebContentsReady]
  )

  return {
    sessionId: input.sessionId,
    active: currentState?.active === true,
    activationToken: currentState?.active
      ? `velaros.browser:${input.sessionId}:${currentState.generation}`
      : null,
    page: {
      url: currentState?.url ?? null,
      title: currentState?.title ?? 'Browser',
    },
    render,
  }
}

/**
 * Browser 是否出现、显示哪一页都来自 main runtime 的会话状态；renderer 只把受控 webview
 * 交给该 runtime，并投影成 Browser composition 所需的界面模型。
 */
export const standaloneBrowserCompositionAdapter: BrowserCompositionAdapter = {
  useControlledSurface: useKernelBrowserSurface,
}
