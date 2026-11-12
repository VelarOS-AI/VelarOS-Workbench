import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
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

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'

import { findWorkbenchTerminalWebLinks } from '../../models/commands/workbenchTerminalWebLinks'
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
  const { t } = useWorkbenchI18n()
  const containerRef = useRef<HTMLDivElement>(null)
  const [externalLinks, setExternalLinks] = useState<
    Array<{ url: string; left: number; top: number; width: number; height: number }>
  >([])
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
    const container = containerRef.current
    const instance = findWorkbenchTerminal(sessionId)
    if (!container || !instance) return undefined
    let frame: Nullable<number> = null
    let previous = ''
    const refresh = (): void => {
      frame = null
      const screen = instance.terminal.element?.querySelector('.xterm-screen')
      if (!screen || !container.parentElement) return
      const rect = screen.getBoundingClientRect()
      const parentRect = container.parentElement.getBoundingClientRect()
      const cellWidth = rect.width / instance.terminal.cols
      const cellHeight = rect.height / instance.terminal.rows
      const links = findWorkbenchTerminalWebLinks(instance.terminal).map((link) => ({
        url: link.url,
        left: rect.left - parentRect.left + link.column * cellWidth,
        top: rect.top - parentRect.top + link.row * cellHeight,
        width: cellWidth * 2,
        height: cellHeight,
      }))
      const projection = JSON.stringify(links)
      if (projection === previous) return
      previous = projection
      setExternalLinks(links)
    }
    const schedule = (): void => {
      frame ??= requestAnimationFrame(refresh)
    }
    const rendered = instance.terminal.onRender(schedule)
    const scrolled = instance.terminal.onScroll(schedule)
    const observer = new ResizeObserver(schedule)
    observer.observe(container)
    schedule()
    return () => {
      rendered.dispose()
      scrolled.dispose()
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [sessionId])

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
    <div className={styles.terminalViewFrame} data-terminal-session={sessionId}>
      <div ref={containerRef} className={styles.terminalViewHost} data-running={isRunning} />
      {externalLinks.map((link) => (
        <IconButton
          key={`${link.url}:${link.top}:${link.left}`}
          type="button"
          variant="ghost"
          size="icon-sm"
          className={styles.terminalLinkExternalButton}
          style={{ left: link.left, top: link.top, width: link.width, height: link.height }}
          label={t('workbench.runOpenExternal')}
          title={`${t('workbench.runOpenExternal')}: ${link.url}`}
          onClick={() => window.open(link.url, '_blank', 'noopener,noreferrer')}
        >
          <ArrowSquareOutIcon size={11} />
        </IconButton>
      ))}
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
