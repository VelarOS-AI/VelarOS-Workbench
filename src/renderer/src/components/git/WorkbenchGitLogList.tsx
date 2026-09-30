import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { GitBranchIcon, TagIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import {
  formatWorkbenchGitCommitRelativeDate,
  isWorkbenchGitHeadCommit,
  sortWorkbenchGitRefs,
} from '@renderer/models/git/changesPanel.model'
import {
  resolveWorkbenchGitLogWindow,
  type WorkbenchGitGraphRow,
} from '@renderer/models/git/workbenchGitGraph'

import { ScrollArea } from '@velaros-ai/ui/primitives/layout/ScrollArea'

import type { WorkspaceGitLogEntry, WorkspaceGitRef } from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'

/** 每行固定这么高：列表只画看得见的那些行，靠它算哪几行在视口里。 */
export const WorkbenchGitLogRowHeight = 26
/** 视口上下各多画这么多行，滚动时不露白。 */
const OverscanRows = 12
/** 离已经读到的末尾还剩这么多行时就去读下一页。 */
const LoadMoreThresholdRows = 40
const LaneWidth = 12
const GraphPadding = 6
const DotRadius = 3.5
/** 泳道的颜色轮着用这几种（见样式里的 --git-graph-lane-N）。 */
const LaneColorCount = 6
/** 一行上最多摆这么多个引用标签，多的收成「+N」。 */
const RefsShown = 3

interface WorkbenchGitLogListProps {
  commits: readonly WorkspaceGitLogEntry[]
  /** 每个提交在提交图里怎么画，与 `commits` 一一对应；不画图（在搜索）时为 null。 */
  graph: Nullable<readonly WorkbenchGitGraphRow[]>
  /** 提交图那一栏留几条泳道的宽度。 */
  graphLanes: number
  selectedSha: Nullable<string>
  onSelect: (sha: string) => void
  hasMore: boolean
  /**
   * 快滚到末尾时自己去读下一页。搜索时关掉：匹配的提交没几行，列表永远「快到末尾」，会一页接一页
   * 把整段历史都读进来；这时在末尾放一个「读取更早的提交」，由用户点。
   */
  autoLoadMore: boolean
  loadMoreLabel: string
  onLoadMore: () => void
  /** 在提交上点右键。 */
  onCommitContextMenu?: (commit: WorkspaceGitLogEntry, event: MouseEvent) => void
  /** 在提交行的引用标签上点右键。 */
  onRefContextMenu?: (ref: WorkspaceGitRef, commit: WorkspaceGitLogEntry, event: MouseEvent) => void
  ariaLabel: string
}

function laneX(lane: number): number {
  return GraphPadding + LaneWidth / 2 + lane * LaneWidth
}

function laneColor(lane: number): string {
  return `var(--git-graph-lane-${lane % LaneColorCount})`
}

/** 一行的提交图：直穿的线、并进来的线、往下接的线，和提交自己的圆点。 */
function GraphCell({
  row,
  lanes,
  head,
}: {
  row: WorkbenchGitGraphRow
  lanes: number
  head: boolean
}): ReactElement {
  const height = WorkbenchGitLogRowHeight
  const middle = height / 2
  const x = laneX(row.lane)
  return (
    <svg
      className={styles.gitGraphCell}
      width={GraphPadding * 2 + lanes * LaneWidth}
      height={height}
      aria-hidden
    >
      {row.passing.map((lane) => (
        <line
          key={`p${lane}`}
          x1={laneX(lane)}
          x2={laneX(lane)}
          y1={0}
          y2={height}
          stroke={laneColor(lane)}
        />
      ))}
      {row.mergingIn.map((lane) => (
        <path
          key={`m${lane}`}
          d={`M ${laneX(lane)} 0 Q ${laneX(lane)} ${middle} ${x} ${middle}`}
          stroke={laneColor(lane)}
        />
      ))}
      {row.branchingOut.map((lane) =>
        lane === row.lane ? (
          <line key={`b${lane}`} x1={x} x2={x} y1={middle} y2={height} stroke={laneColor(lane)} />
        ) : (
          <path
            key={`b${lane}`}
            d={`M ${x} ${middle} Q ${laneX(lane)} ${middle} ${laneX(lane)} ${height}`}
            stroke={laneColor(lane)}
          />
        )
      )}
      {row.fromAbove && <line x1={x} x2={x} y1={0} y2={middle} stroke={laneColor(row.lane)} />}
      <circle
        cx={x}
        cy={middle}
        r={DotRadius}
        data-head={head ? 'true' : undefined}
        fill={laneColor(row.lane)}
        stroke={laneColor(row.lane)}
      />
    </svg>
  )
}

/**
 * Git 工具窗的提交列表：每行是提交图、引用标签（分支、标签、HEAD）、提交说明、作者、时间。
 *
 * 行高固定，只画视口里的那些行（上下各多画几行），读进来几千个提交滚动也不卡；快滚到已经读到的末尾时
 * 去要下一页。上下方向键换选中的提交。
 */
export function WorkbenchGitLogList({
  commits,
  graph,
  graphLanes,
  selectedSha,
  onSelect,
  hasMore,
  autoLoadMore,
  loadMoreLabel,
  onLoadMore,
  onCommitContextMenu,
  onRefContextMenu,
  ariaLabel,
}: WorkbenchGitLogListProps): ReactElement {
  const { locale } = useWorkbenchI18n()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 0 })

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const measure = (): void =>
      setViewport((current) =>
        current.top === element.scrollTop && current.height === element.clientHeight
          ? current
          : { top: element.scrollTop, height: element.clientHeight }
      )
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const visibleRows = Math.ceil(viewport.height / WorkbenchGitLogRowHeight)
  const { start, end } = resolveWorkbenchGitLogWindow({
    scrollTop: viewport.top,
    viewportHeight: viewport.height,
    rowHeight: WorkbenchGitLogRowHeight,
    rowCount: commits.length,
    overscan: OverscanRows,
  })

  // 快到已经读到的末尾了：要下一页。列表不满一屏时也会走到这里，一直读到满屏或者读完。
  useEffect(() => {
    if (!autoLoadMore || !hasMore || viewport.height === 0) return
    if (end >= commits.length - LoadMoreThresholdRows) onLoadMore()
  }, [autoLoadMore, commits.length, end, hasMore, onLoadMore, viewport.height])

  function scrollToIndex(index: number): void {
    const element = scrollRef.current
    if (!element) return
    const top = index * WorkbenchGitLogRowHeight
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + WorkbenchGitLogRowHeight > element.scrollTop + element.clientHeight)
      element.scrollTop = top + WorkbenchGitLogRowHeight - element.clientHeight
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const step =
      event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowUp'
          ? -1
          : event.key === 'PageDown'
            ? Math.max(1, visibleRows - 1)
            : event.key === 'PageUp'
              ? -Math.max(1, visibleRows - 1)
              : 0
    if (!step || commits.length === 0) return
    event.preventDefault()
    const current = commits.findIndex((commit) => commit.sha === selectedSha)
    const next = Math.min(commits.length - 1, Math.max(0, (current < 0 ? -1 : current) + step))
    const target = commits[next]
    if (!target) return
    onSelect(target.sha)
    scrollToIndex(next)
  }

  return (
    <ScrollArea
      ref={scrollRef}
      className={styles.gitGraphScroll}
      role="listbox"
      aria-label={ariaLabel}
      tabIndex={0}
      onScroll={(event) => {
        const { scrollTop, clientHeight } = event.currentTarget
        setViewport((current) =>
          current.top === scrollTop && current.height === clientHeight
            ? current
            : { top: scrollTop, height: clientHeight }
        )
      }}
      onKeyDown={handleKeyDown}
    >
      <div
        className={styles.gitGraphList}
        style={{ height: commits.length * WorkbenchGitLogRowHeight }}
      >
        <div style={{ transform: `translateY(${start * WorkbenchGitLogRowHeight}px)` }}>
          {commits.slice(start, end).map((commit, offset) => {
            const row = graph?.[start + offset]
            const refs = sortWorkbenchGitRefs(commit.refs)
            return (
              <div
                key={commit.sha}
                role="option"
                aria-selected={commit.sha === selectedSha}
                className={styles.gitGraphRow}
                data-active={commit.sha === selectedSha}
                onClick={() => onSelect(commit.sha)}
                onContextMenu={(event) => {
                  if (!onCommitContextMenu) return
                  event.preventDefault()
                  onSelect(commit.sha)
                  onCommitContextMenu(commit, event)
                }}
              >
                {!!row && (
                  <GraphCell
                    row={row}
                    lanes={graphLanes}
                    head={isWorkbenchGitHeadCommit(commit)}
                  />
                )}
                <span className={styles.gitGraphSummary}>
                  {refs.slice(0, RefsShown).map((ref) => (
                    <span
                      key={`${ref.kind}:${ref.name}`}
                      className={styles.gitGraphRef}
                      data-kind={ref.kind}
                      data-current={ref.current ? 'true' : undefined}
                      title={ref.name}
                      onContextMenu={(event) => {
                        if (!onRefContextMenu) return
                        event.preventDefault()
                        event.stopPropagation()
                        onSelect(commit.sha)
                        onRefContextMenu(ref, commit, event)
                      }}
                    >
                      {ref.kind === 'tag' ? <TagIcon size={10} /> : <GitBranchIcon size={10} />}
                      <span>{ref.name}</span>
                    </span>
                  ))}
                  {refs.length > RefsShown && (
                    <span
                      className={styles.gitGraphRef}
                      data-kind="more"
                      title={refs
                        .slice(RefsShown)
                        .map((ref) => ref.name)
                        .join('\n')}
                    >
                      +{refs.length - RefsShown}
                    </span>
                  )}
                  <span className={styles.gitGraphSubject} title={commit.subject}>
                    {commit.subject}
                  </span>
                </span>
                <span className={styles.gitGraphAuthor} title={commit.authorName}>
                  {commit.authorName}
                </span>
                <span className={styles.gitGraphDate}>
                  {formatWorkbenchGitCommitRelativeDate(locale, commit)}
                </span>
              </div>
            )
          })}
        </div>
      </div>
      {hasMore && !autoLoadMore && (
        <button type="button" className={styles.gitGraphLoadMore} onClick={onLoadMore}>
          {loadMoreLabel}
        </button>
      )}
    </ScrollArea>
  )
}
