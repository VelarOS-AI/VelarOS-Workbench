import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import {
  buildWorkbenchTerminalFindPattern,
  DefaultWorkbenchTerminalFindOptions,
  type WorkbenchTerminalFindOptions,
} from '@renderer/models/commands/workbenchTerminalFind'
import {
  EmptyWorkbenchEditorFindStatus,
  type WorkbenchEditorFindStatus,
} from '@renderer/models/editor/workbenchEditorFindState'
import type { WorkbenchThemeId } from '@renderer/models/settings/workbenchPreferences'

import styles from '../../styles/workbenchPageStyles'
import { useLatest } from '../../support/genericHooks'

import { WorkbenchTerminalFindBar } from './WorkbenchTerminalFindBar'
import {
  acquireWorkbenchTerminal,
  closeWorkbenchTerminalFind,
  findInWorkbenchTerminal,
  findWorkbenchTerminal,
  mountWorkbenchTerminal,
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
  /** 并排的几个终端里，这个是不是当前的那个：是才在挂上时拿焦点，变成当前的时也把焦点拿过来。不给按是。 */
  isActive?: boolean
  /** 终端一共有几个：别的终端关掉之后（点了它的关闭按钮，焦点没了着落），当前的这个把焦点接过来。 */
  sessionCount?: number
  /** 焦点进了这个终端（点了它、它的查找栏）。 */
  onActivate?: () => void
  onPaneAction?: WorkbenchTerminalInstanceHandlers['onPaneAction']
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
  isActive = true,
  sessionCount,
  onActivate,
  onPaneAction,
}: WorkbenchTerminalViewProps): ReactElement {
  const frameRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const cwdLatest = useLatest(cwd)
  const isActiveLatest = useLatest(isActive)
  const onPaneActionLatest = useLatest(onPaneAction)
  const onDataLatest = useLatest(onData)
  const onResizeLatest = useLatest(onResize)
  const onOpenLinkLatest = useLatest(onOpenLink)
  const onResolveFileLinksLatest = useLatest(onResolveFileLinks)
  const onOpenFileLinkLatest = useLatest(onOpenFileLink)
  const [find, setFind] = useState<Nullable<TerminalFindState>>(null)
  const [findStatus, setFindStatus] = useState<WorkbenchEditorFindStatus>(
    EmptyWorkbenchEditorFindStatus
  )

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
        onPaneAction: (action) => onPaneActionLatest.current?.(action) ?? false,
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
    if (isActiveLatest.current) instance.terminal.focus()

    return () => {
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
      unmountWorkbenchTerminal(sessionId)
    }
  }, [
    cwdLatest,
    isActiveLatest,
    onDataLatest,
    onOpenFileLinkLatest,
    onOpenLinkLatest,
    onPaneActionLatest,
    onResizeLatest,
    onResolveFileLinksLatest,
    sessionId,
  ])

  // 成了当前的那个终端（换到旁边的终端），或者别的终端关掉了：把焦点拿过来。焦点在别处（编辑器、输入框）时不抢。
  useEffect(() => {
    const frame = frameRef.current
    const focused = document.activeElement
    if (!isActive || !frame || frame.contains(focused)) return
    const besidePanes = frame.closest('[data-terminal-split-group]')
    if (focused && focused !== document.body && !besidePanes?.contains(focused)) return
    findWorkbenchTerminal(sessionId)?.terminal.focus()
  }, [isActive, sessionCount, sessionId])

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
    <div
      ref={frameRef}
      className={styles.terminalViewFrame}
      data-terminal-session={sessionId}
      onFocusCapture={onActivate}
    >
      <div ref={containerRef} className={styles.terminalViewHost} data-running={isRunning} />
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
