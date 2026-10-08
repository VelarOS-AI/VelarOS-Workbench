import { type ReactElement, type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLatest } from 'ahooks'

import { WorkbenchAgentConsoleFrameName } from '@shared/workbenchAgentProcesses'

import styles from '../../styles/WorkbenchAgentProcesses.module.css'

interface WorkbenchAgentConsoleWindowProps {
  activationRequest: number
  title: string
  children: ReactNode
  onClose: () => void
  onError: (error: unknown) => void
}

function syncConsoleDocument(target: Document, title: string): void {
  const source = document.querySelector('.wb_workbenchShell') ?? document.documentElement
  target.documentElement.className = document.documentElement.className
  target.documentElement.lang = document.documentElement.lang
  for (const attribute of document.documentElement.attributes) {
    if (attribute.name.startsWith('data-')) target.documentElement.setAttribute(attribute.name, attribute.value)
  }
  target.documentElement.style.cssText = document.documentElement.style.cssText
  const computed = getComputedStyle(source)
  for (const name of computed) {
    if (name.startsWith('--')) target.documentElement.style.setProperty(name, computed.getPropertyValue(name))
  }
  target.title = title
}

function copyConsoleStyles(target: Document): void {
  const base = target.createElement('base')
  base.href = window.location.href
  target.head.replaceChildren(base)
  for (const node of document.querySelectorAll('style, link[rel="stylesheet"]'))
    target.head.appendChild(node.cloneNode(true))
}

/** 主窗口持有会话状态与 IPC，原生控制台子窗只承载同一棵 React 树的 portal。 */
export function WorkbenchAgentConsoleWindow({
  activationRequest,
  title,
  children,
  onClose,
  onError,
}: WorkbenchAgentConsoleWindowProps): Nullable<ReactElement> {
  const titleLatest = useLatest(title)
  const closeLatest = useLatest(onClose)
  const errorLatest = useLatest(onError)
  const windowRef = useRef<Nullable<Window>>(null)
  const [container, setContainer] = useState<Nullable<HTMLElement>>(null)

  useEffect(() => {
    const popout = window.open('about:blank', WorkbenchAgentConsoleFrameName, 'popup=yes,width=720,height=540')
    if (!popout) {
      errorLatest.current(new Error(titleLatest.current))
      closeLatest.current()
      return
    }
    windowRef.current = popout
    const target = popout.document
    copyConsoleStyles(target)
    syncConsoleDocument(target, titleLatest.current)
    target.documentElement.classList.add(styles.document)
    target.body.className = styles.document
    const root = target.createElement('div')
    root.className = styles.windowRoot
    target.body.replaceChildren(root)
    setContainer(root)

    const onClosed = (): void => {
      windowRef.current = null
      setContainer(null)
      closeLatest.current()
    }
    popout.addEventListener('beforeunload', onClosed)
    const syncTheme = (): void => {
      syncConsoleDocument(target, titleLatest.current)
      target.documentElement.classList.add(styles.document)
    }
    const themeObserver = new MutationObserver(syncTheme)
    themeObserver.observe(document.documentElement, { attributes: true })
    const shell = document.querySelector('.wb_workbenchShell')
    if (shell) themeObserver.observe(shell, { attributes: true })
    const styleObserver = new MutationObserver(() => {
      copyConsoleStyles(target)
      syncTheme()
    })
    styleObserver.observe(document.head, { attributes: true, childList: true, characterData: true, subtree: true })

    return () => {
      themeObserver.disconnect()
      styleObserver.disconnect()
      popout.removeEventListener('beforeunload', onClosed)
      windowRef.current = null
      if (!popout.closed) popout.close()
    }
  }, [closeLatest, errorLatest, titleLatest])

  useEffect(() => {
    const popout = windowRef.current
    if (popout && !popout.closed) popout.document.title = title
  }, [title])

  useEffect(() => {
    const focus = (): void => {
      const popout = windowRef.current
      if (popout && !popout.closed) popout.focus()
    }
    void window.velarosWorkbenchAgentProcesses.focusConsole()
      .then((focused) => { if (!focused) focus() })
      .catch(focus)
  }, [activationRequest])

  return container ? createPortal(children, container) : null
}
