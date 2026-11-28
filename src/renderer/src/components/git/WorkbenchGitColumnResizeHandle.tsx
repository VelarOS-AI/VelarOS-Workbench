import { type PointerEvent, type ReactElement, useRef } from 'react'

import styles from '../../styles/workbenchPageStyles'

function columnWidthsProperty(container: HTMLElement): string {
  return container.lastElementChild?.classList.contains(styles.gitCommitPatch)
    ? '--git-log-custom-patch-columns'
    : '--git-log-custom-columns'
}

export function WorkbenchGitColumnResizeHandle({ label }: { label: string }): ReactElement {
  const drag = useRef<{ pointerId: number; move: (clientX: number) => void } | null>(null)

  function beginResize(event: PointerEvent<HTMLDivElement>): void {
    const handle = event.currentTarget
    const container = handle.parentElement
    if (!container || event.button !== 0 || drag.current) return

    const columns = [...container.children].filter(
      (child) => child.getAttribute('role') !== 'separator'
    )
    const left = columns.findIndex((column) => column === handle.previousElementSibling)
    const widths = columns.map((column) => column.getBoundingClientRect().width)
    const leftWidth = widths[left]
    const rightWidth = widths[left + 1]
    if (!leftWidth || !rightWidth) return

    const minimum = Math.min(120, container.clientWidth / 5)
    const property = columnWidthsProperty(container)
    const { clientX, pointerId } = event
    event.preventDefault()
    handle.setPointerCapture(pointerId)
    drag.current = {
      pointerId,
      move(nextX) {
        // Keep the total width of the neighboring panes fixed while moving their boundary.
        const delta = Math.max(minimum - leftWidth, Math.min(rightWidth - minimum, nextX - clientX))
        widths[left] = leftWidth + delta
        widths[left + 1] = rightWidth - delta
        container.style.setProperty(
          property,
          widths.map((width) => `minmax(var(--git-log-min-column-width), ${width}fr)`).join(' 0 ')
        )
      },
    }
  }

  return (
    <div
      className={`${styles.verticalResizeHandle} ${styles.gitColumnResizeHandle}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={beginResize}
      onPointerMove={(event) => {
        if (drag.current?.pointerId === event.pointerId) drag.current.move(event.clientX)
      }}
      onLostPointerCapture={(event) => {
        if (drag.current?.pointerId === event.pointerId) drag.current = null
      }}
      onDoubleClick={(event) => {
        const container = event.currentTarget.parentElement
        if (container) container.style.removeProperty(columnWidthsProperty(container))
      }}
    />
  )
}
