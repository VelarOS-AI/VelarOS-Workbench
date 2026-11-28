import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowSquareOutIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'
import {
  buildWorkbenchTerminalFindPattern,
  DefaultWorkbenchTerminalFindOptions,
  type WorkbenchTerminalFindOptions,
} from '@renderer/models/commands/workbenchTerminalFind'
import {
  EmptyWorkbenchEditorFindStatus,
  type WorkbenchEditorFindStatus,
} from '@renderer/models/editor/workbenchEditorFindState'
import type { WorkbenchThemeId } from '@renderer/models/workbenchPreferences'

import { WorkbenchRunConsoleColumns } from '../../models/commands/workbenchTerminalPresentation'
import { findWorkbenchTerminalWebLinks } from '../../models/commands/workbenchTerminalWebLinks'
import styles from '../../styles/workbenchPageStyles'
import { useLatest } from '../../support/genericHooks'

import { WorkbenchTerminalFindBar } from './WorkbenchTerminalFindBar'
import {
  acquireWorkbenchTerminal,
  closeWorkbenchTerminalFind,
  findInWorkbenchTerminal,
  findWorkbenchTerminal,
  fitWorkbenchTerminal,
  mountWorkbenchTerminal,
  setWorkbenchRunCursorHidden,
  stepWorkbenchTerminalFind,
  unmountWorkbenchTerminal,
  type WorkbenchTerminalInstanceHandlers,
} from './workbenchTerminalInstances'
import {
  buildWorkbenchTerminalTheme,
  readWorkbenchTerminalFontFamily,
  resolveWorkbenchTerminalFindColors,
} from './workbenchTerminalTheme'

/** 打字停下这么久再找（整个滚回历史找一遍要几毫秒到几十毫秒）。 */
const FindDebounceMs = 80

interface TerminalFindState {
  query: string
  options: WorkbenchTerminalFindOptions
  /** 每要求一次聚焦查找框就加一。 */
  focusRequest: number
}

interface WorkbenchTerminalViewProps {
  sessionId: string
  /** 会话的起始目录：输出里的相对路径按它解析（shell 用 OSC 7 报了新目录就按新的）。 */
  cwd: string
  isRunning: boolean
  isRunConsole?: boolean
  workbenchTheme: WorkbenchThemeId
  onData: (sessionId: string, data: string) => void
  onResize: (sessionId: string, cols: number, rows: number) => void
  onOpenLink?: (url: string) => void
  onResolveFileLinks?: (
    paths: readonly string[],
    cwd: string,
    sessionId: string
  ) => Promise<Array<Nullable<string>>>
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
  isRunConsole = false,
  workbenchTheme,
  onData,
  onResize,
  onOpenLink,
  onResolveFileLinks,
  onOpenFileLink,
}: WorkbenchTerminalViewProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const containerRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [externalLink, setExternalLink] = useState<
    Nullable<{
      element: HTMLElement
      url: string
      left: number
      top: number
      width: number
      height: number
    }>
  >(null)
  const cwdLatest = useLatest(cwd)
  const onDataLatest = useLatest(onData)
  const onResizeLatest = useLatest(onResize)
  const onOpenLinkLatest = useLatest(onOpenLink)
  const onResolveFileLinksLatest = useLatest(onResolveFileLinks)
  const onOpenFileLinkLatest = useLatest(onOpenFileLink)
  const [find, setFind] = useState<Nullable<TerminalFindState>>(null)
  const [findStatus, setFindStatus] = useState<WorkbenchEditorFindStatus>(
    EmptyWorkbenchEditorFindStatus
  )

  const positionVerticalScrollbar = useCallback((): void => {
    const viewport = viewportRef.current
    if (!viewport || !isRunConsole) return
    const offset = Math.max(0, viewport.scrollWidth - viewport.clientWidth - viewport.scrollLeft)
    viewport.style.setProperty('--terminal-scrollbar-offset', `${-offset}px`)
  }, [isRunConsole])

  useEffect(() => {
    const container = containerRef.current
    const viewport = viewportRef.current
    if (!container || !viewport) return undefined

    const instance = acquireWorkbenchTerminal(
      sessionId,
      {
        onData: (data) => onDataLatest.current(sessionId, data),
        onOpenLink: (url) => {
          const open = onOpenLinkLatest.current
          if (open) open(url)
          else window.open(url, '_blank', 'noopener,noreferrer')
        },
        onHoverLink: (url, range) => {
          const terminal = findWorkbenchTerminal(sessionId)?.terminal
          if (!terminal) return
          const element = terminal.element
          const screen = element?.querySelector('.xterm-screen')
          if (!element || !screen) return
          // The addon's range uses 1-based buffer coordinates, even after scrolling.
          const row = range.end.y - 1 - terminal.buffer.active.viewportY
          const link = findWorkbenchTerminalWebLinks(terminal).find(
            (candidate) =>
              candidate.url === url && candidate.row === row && candidate.column === range.end.x
          )
          if (!link) return
          const rect = screen.getBoundingClientRect()
          const terminalRect = element.getBoundingClientRect()
          const cellWidth = rect.width / terminal.cols
          const cellHeight = rect.height / terminal.rows
          setExternalLink({
            element,
            url,
            left: rect.left - terminalRect.left + link.column * cellWidth,
            top: rect.top - terminalRect.top + link.row * cellHeight,
            width: cellWidth * 2,
            height: cellHeight,
          })
        },
        onLeaveLink: () => setExternalLink(null),
        resolveFileLinks: async (paths, directory) =>
          (await onResolveFileLinksLatest.current?.(paths, directory, sessionId)) ??
          paths.map(() => null),
        onOpenFileLink: (path, line, column) => onOpenFileLinkLatest.current?.(path, line, column),
        // 选中了一行里的文字就拿它当查找词（跨行的选中不算）。
        onFind: (selection) =>
          setFind((current) => ({
            query: selection && !selection.includes('\n') ? selection : (current?.query ?? ''),
            options: current?.options ?? DefaultWorkbenchTerminalFindOptions,
            focusRequest: (current?.focusRequest ?? 0) + 1,
          })),
        onFindStatusChange: setFindStatus,
      },
      {
        fontFamily: readWorkbenchTerminalFontFamily(container),
        cwd: cwdLatest.current,
        cols: isRunConsole ? WorkbenchRunConsoleColumns : undefined,
      }
    )
    mountWorkbenchTerminal(sessionId, container)
    const scrolled = instance.terminal.onScroll(() => setExternalLink(null))
    const resized = instance.terminal.onResize(() => setExternalLink(null))

    let lastSize = ''
    let frame: Nullable<number> = null
    let focusPending = true
    const fitNow = (): void => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      // Keep the existing screen while dragging; fit once the pane reaches its final size.
      if (container.closest('[data-pane-resizing]')) return
      fitWorkbenchTerminal(instance)
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
        positionVerticalScrollbar()
        // Theme/disableStdin effects recreate WebGL's blink manager. Focusing in
        // the mount effect races its cached focus state and leaves it paused.
        if (focusPending && container.clientWidth > 0 && container.clientHeight > 0) {
          focusPending = false
          instance.terminal.focus()
        }
      })
    }
    const observer = new ResizeObserver(scheduleFit)
    observer.observe(container)
    observer.observe(viewport)
    window.addEventListener('pointerup', scheduleFit)
    window.addEventListener('pointercancel', scheduleFit)
    scheduleFit()

    return () => {
      scrolled.dispose()
      resized.dispose()
      observer.disconnect()
      window.removeEventListener('pointerup', scheduleFit)
      window.removeEventListener('pointercancel', scheduleFit)
      if (frame !== null) cancelAnimationFrame(frame)
      unmountWorkbenchTerminal(sessionId)
    }
  }, [
    cwdLatest,
    isRunConsole,
    onDataLatest,
    onOpenFileLinkLatest,
    onOpenLinkLatest,
    onResizeLatest,
    onResolveFileLinksLatest,
    positionVerticalScrollbar,
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
    if (isRunConsole) setWorkbenchRunCursorHidden(sessionId, isRunning)
  }, [isRunConsole, isRunning, sessionId])

  const findQuery = find?.query
  const findOptions = find?.options
  useEffect(() => {
    if (findQuery === undefined || !findOptions) return undefined
    const timer = setTimeout(() => {
      const container = containerRef.current
      if (!container) return
      const pattern = buildWorkbenchTerminalFindPattern(findQuery, findOptions)
      const colors = resolveWorkbenchTerminalFindColors(container)
      const status = findInWorkbenchTerminal(
        sessionId,
        pattern === 'invalid' ? null : pattern,
        colors
      )
      setFindStatus(
        pattern === 'invalid'
          ? { ...EmptyWorkbenchEditorFindStatus, invalid: true }
          : (status ?? EmptyWorkbenchEditorFindStatus)
      )
    }, FindDebounceMs)
    return () => clearTimeout(timer)
  }, [findOptions, findQuery, sessionId])

  // 视图卸下（切走标签、收起面板）时查找栏跟着关，高亮也撤掉。
  useEffect(() => () => closeWorkbenchTerminalFind(sessionId), [sessionId])

  const closeFind = useCallback((): void => {
    closeWorkbenchTerminalFind(sessionId)
    setFind(null)
    setFindStatus(EmptyWorkbenchEditorFindStatus)
    findWorkbenchTerminal(sessionId)?.terminal.focus()
  }, [sessionId])

  const stepFind = (direction: 1 | -1): void => {
    const status = stepWorkbenchTerminalFind(sessionId, direction)
    if (status) setFindStatus(status)
  }

  return (
    <div className={styles.terminalViewFrame} data-terminal-session={sessionId}>
      <div
        ref={viewportRef}
        className={styles.terminalViewViewport}
        data-horizontal-scroll={isRunConsole || undefined}
        onScroll={positionVerticalScrollbar}
      >
        <div
          ref={containerRef}
          className={styles.terminalViewHost}
          data-running={isRunning}
          style={{
            minWidth: isRunConsole ? `calc(${WorkbenchRunConsoleColumns}ch + 6px)` : undefined,
          }}
        />
      </div>
      {externalLink &&
        createPortal(
          <button
            type="button"
            className={`${styles.terminalLinkExternalButton} xterm-hover`}
            style={{
              left: externalLink.left,
              top: externalLink.top,
              width: externalLink.width,
              height: externalLink.height,
            }}
            aria-label={t('workbench.runOpenExternal')}
            title={`${t('workbench.runOpenExternal')}: ${externalLink.url}`}
            onMouseDownCapture={(event) => event.stopPropagation()}
            onClick={() => window.open(externalLink.url, '_blank', 'noopener,noreferrer')}
          >
            <ArrowSquareOutIcon size={10} aria-hidden="true" />
          </button>,
          externalLink.element
        )}
      {find && (
        <WorkbenchTerminalFindBar
          query={find.query}
          options={find.options}
          status={findStatus}
          focusRequest={find.focusRequest}
          onQueryChange={(query) => setFind((current) => current && { ...current, query })}
          onToggleOption={(option) =>
            setFind(
              (current) =>
                current && {
                  ...current,
                  options: { ...current.options, [option]: !current.options[option] },
                }
            )
          }
          onFindNext={() => stepFind(1)}
          onFindPrevious={() => stepFind(-1)}
          onClose={closeFind}
        />
      )}
    </div>
  )
}
