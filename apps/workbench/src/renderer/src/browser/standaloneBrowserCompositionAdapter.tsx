import { type ReactNode, useCallback, useEffect, useState } from 'react'

import type {
  BrowserCompositionAdapter,
  ControlledBrowserSurface,
  ControlledBrowserSurfaceInput,
  ControlledBrowserSurfaceRenderOptions,
} from '@velaros-ai/browser/composition'

function useKernelBrowserSurface(
  input: ControlledBrowserSurfaceInput
): ControlledBrowserSurface {
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    let disposed = false
    const project = (status: Awaited<
      ReturnType<typeof window.velarosWorkbenchKernel.getStatus>
    >): void => {
      if (!disposed) {
        setAvailable(
          status.connected &&
          status.capabilities.some(
            (capability) => capability.id === 'velaros.browser'
          )
        )
      }
    }
    void window.velarosWorkbenchKernel.getStatus().then(project)
    const unsubscribe = window.velarosWorkbenchKernel.onStatusChanged(project)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  const render = useCallback(
    (options: ControlledBrowserSurfaceRenderOptions): ReactNode => (
      <section aria-label="Kernel browser session" className="wb_browserKernelSurface">
        <p>
          Browser session <code>{input.sessionId}</code> is owned by the injected
          VelarOS Browser capability.
        </p>
        <button
          type="button"
          onClick={() => {
            void window.velarosWorkbenchKernel.invoke({
              route: 'browser.close-session',
              input: { sessionId: input.sessionId },
            }).finally(options.onRequestClose)
          }}
        >
          Close browser session
        </button>
      </section>
    ),
    [input.sessionId]
  )

  return {
    sessionId: input.sessionId,
    active: available && input.activationToken !== null,
    activationToken: input.activationToken,
    page: { url: null, title: 'Kernel browser' },
    render,
  }
}

/**
 * Published browser-composition contract with a Workbench-specific Kernel
 * adapter. Browser lifecycle remains in @velaros-ai/browser/runtime; this
 * renderer only projects the semantic controlled surface.
 */
export const standaloneBrowserCompositionAdapter: BrowserCompositionAdapter = {
  useControlledSurface: useKernelBrowserSurface,
}
