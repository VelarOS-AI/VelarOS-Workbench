import { type ReactElement, useEffect, useRef } from 'react'
import type { WorkbenchThemeId } from '@renderer/models/settings/workbenchPreferences'

import styles from '../../styles/workbenchPageStyles'
import { useLatest } from '../../support/genericHooks'

import {
  acquireWorkbenchTerminal,
  findWorkbenchTerminal,
  mountWorkbenchTerminal,
  unmountWorkbenchTerminal,
  type WorkbenchTerminalInstanceHandlers,
} from './workbenchTerminalInstances'
import { buildWorkbenchTerminalTheme, readWorkbenchTerminalFontFamily } from './workbenchTerminalTheme'

interface WorkbenchTerminalViewProps {
  sessionId: string
  /** 会话的起始目录：输出里的相对路径按它解析（shell 用 OSC 7 报了新目录就按新的）。 */
  cwd: string
  isRunning: boolean
  workbenchTheme: WorkbenchThemeId
  onData: (sessionId: string, data: string) => void
  onResize: (sessionId: string, cols: number, rows: number) => void
  onOpenLink?: (url: string) => void
  onResolveFileLinks?: WorkbenchTerminalInstanceHandlers['resolveFileLinks']
  onOpenFileLink?: WorkbenchTerminalInstanceHandlers['onOpenFileLink']
}

/**
 * 一个终端 / 运行卡的 xterm 视图。按键（含输入法组合完成后的中文）由 xterm 收齐后经 onData 原样送回伪终端；
 * 容器尺寸变了就重新量格子数并告诉伪终端。实例本身活在 {@link acquireWorkbenchTerminal} 的表里，卸载只摘 DOM。
 */
export function WorkbenchTerminalView({
  sessionId,
  cwd,
  isRunning,
  workbenchTheme,
  onData,
  onResize,
  onOpenLink,
  onResolveFileLinks,
  onOpenFileLink,
}: WorkbenchTerminalViewProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const cwdLatest = useLatest(cwd)
  const onDataLatest = useLatest(onData)
  const onResizeLatest = useLatest(onResize)
  const onOpenLinkLatest = useLatest(onOpenLink)
  const onResolveFileLinksLatest = useLatest(onResolveFileLinks)
  const onOpenFileLinkLatest = useLatest(onOpenFileLink)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined

    const instance = acquireWorkbenchTerminal(
      sessionId,
      {
        onData: (data) => onDataLatest.current(sessionId, data),
        onOpenLink: (url) => {
          const open = onOpenLinkLatest.current
          if (open) open(url)
          else window.open(url, '_blank', 'noopener,noreferrer')
        },
        resolveFileLinks: async (paths, directory) =>
          (await onResolveFileLinksLatest.current?.(paths, directory)) ?? paths.map(() => null),
        onOpenFileLink: (path, line, column) => onOpenFileLinkLatest.current?.(path, line, column),
      },
      { fontFamily: readWorkbenchTerminalFontFamily(container), cwd: cwdLatest.current }
    )
    mountWorkbenchTerminal(sessionId, container)

    let lastSize = ''
    let frame: Nullable<number> = null
    const fitNow = (): void => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      instance.fit.fit()
      const size = `${instance.terminal.cols}x${instance.terminal.rows}`
      if (size === lastSize) return
      lastSize = size
      onResizeLatest.current(sessionId, instance.terminal.cols, instance.terminal.rows)
    }
    const scheduleFit = (): void => {
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        fitNow()
      })
    }
    const observer = new ResizeObserver(scheduleFit)
    observer.observe(container)
    scheduleFit()
    instance.terminal.focus()

    return () => {
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
      unmountWorkbenchTerminal(sessionId)
    }
  }, [
    cwdLatest,
    onDataLatest,
    onOpenFileLinkLatest,
    onOpenLinkLatest,
    onResizeLatest,
    onResolveFileLinksLatest,
    sessionId,
  ])

  useEffect(() => {
    const container = containerRef.current
    const instance = findWorkbenchTerminal(sessionId)
    if (!container || !instance) return
    instance.terminal.options.theme = buildWorkbenchTerminalTheme(container)
  }, [sessionId, workbenchTheme])

  useEffect(() => {
    const instance = findWorkbenchTerminal(sessionId)
    if (instance) instance.terminal.options.disableStdin = !isRunning
  }, [isRunning, sessionId])

  return <div ref={containerRef} className={styles.terminalViewHost} data-running={isRunning} />
}
