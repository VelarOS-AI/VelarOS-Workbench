import { type CSSProperties, type ReactElement, type ReactNode, useEffect, useState } from 'react'

import '../../styles/workbenchWindowChrome.css'

/** Windows supplies the caption buttons; the non-selectable drag region uses app tokens. */
export function WorkbenchWindowChrome({
  children,
  settings,
}: {
  children: ReactNode
  settings: boolean
}): ReactElement {
  const enabled = /\bWindows\b/i.test(navigator.userAgent) && !!window.velarosWorkbenchWindowState
  const [fullScreen, setFullScreen] = useState(false)
  const [title, setTitle] = useState(settings ? document.title : 'VelarOS WorkBench')
  useEffect(() => {
    if (!enabled) return undefined
    let active = true
    let pushed = false
    const changed = (state: { fullScreen: boolean }): void => {
      if (active) setFullScreen(state.fullScreen)
    }
    const remove = window.velarosWorkbenchWindowState.onChanged((state) => {
      pushed = true
      changed(state)
    })
    void window.velarosWorkbenchWindowState
      .getState()
      .then((state) => {
        if (!pushed) changed(state)
      })
      .catch(console.warn)
    if (settings) setTitle(document.title)
    const observer = new MutationObserver(() => {
      if (settings) setTitle(document.title)
    })
    observer.observe(document.querySelector('title')!, { childList: true })
    return () => {
      active = false
      remove()
      observer.disconnect()
    }
  }, [enabled, settings])
  if (!enabled) return <>{children}</>
  return (
    <div
      className="workbench-native-window"
      style={
        {
          '--workbench-window-height': fullScreen ? '100dvh' : 'calc(100dvh - 32px)',
        } as CSSProperties
      }
    >
      {!fullScreen && (
        <header className="workbench-native-caption" aria-label={title}>
          <span className="workbench-native-caption-icon" aria-hidden="true">
            W
          </span>
          <span>{title}</span>
        </header>
      )}
      <div className="workbench-native-window-content">{children}</div>
    </div>
  )
}
