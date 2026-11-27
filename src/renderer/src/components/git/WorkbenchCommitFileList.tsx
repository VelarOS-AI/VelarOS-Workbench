import { type CSSProperties, type ReactElement, useLayoutEffect, useRef, useState } from 'react'

import { resolveWorkbenchGitLogWindow } from '@renderer/models/git/workbenchGitGraph'
import type { WorkbenchGitChangeItem } from '@renderer/models/git/workbenchGitModel'

import styles from '../../styles/workbenchPageStyles'

const CommitFileRowHeight = 24
const CommitFileOverscan = 8

/** Keep the full scroll height without mounting every file and its actions. */
export function WorkbenchCommitFileList({
  items,
  children,
}: {
  items: readonly WorkbenchGitChangeItem[]
  children: (item: WorkbenchGitChangeItem) => ReactElement
}): ReactElement {
  const listRef = useRef<HTMLDivElement>(null)
  const [visibleRows, setVisibleRows] = useState({ start: 0, end: CommitFileOverscan })

  useLayoutEffect(() => {
    const list = listRef.current
    const scroll = list?.closest<HTMLElement>('[data-slot="scroll-area"]')
    if (!list || !scroll) return
    const measure = (): void => {
      const listTop =
        list.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(list).paddingTop)
      const viewport = scroll.getBoundingClientRect()
      const next = resolveWorkbenchGitLogWindow({
        scrollTop: viewport.top - listTop,
        viewportHeight: Math.min(scroll.clientHeight, viewport.bottom - listTop),
        rowHeight: CommitFileRowHeight,
        rowCount: items.length,
        overscan: CommitFileOverscan,
      })
      setVisibleRows((current) =>
        current.start === next.start && current.end === next.end ? current : next
      )
    }
    const resize = new ResizeObserver(measure)
    resize.observe(scroll)
    resize.observe(list)
    if (scroll.firstElementChild) resize.observe(scroll.firstElementChild)
    measure()
    scroll.addEventListener('scroll', measure, { passive: true })
    return () => {
      resize.disconnect()
      scroll.removeEventListener('scroll', measure)
    }
  }, [items.length])

  const start = Math.min(visibleRows.start, items.length)
  const end = Math.min(visibleRows.end, items.length)
  return (
    <div
      ref={listRef}
      className={styles.commitFileList}
      style={{ '--commit-file-row-height': `${CommitFileRowHeight}px` } as CSSProperties}
    >
      <div aria-hidden="true" style={{ height: start * CommitFileRowHeight, flexShrink: 0 }} />
      {items.slice(start, end).map(children)}
      <div
        aria-hidden="true"
        style={{ height: (items.length - end) * CommitFileRowHeight, flexShrink: 0 }}
      />
    </div>
  )
}
