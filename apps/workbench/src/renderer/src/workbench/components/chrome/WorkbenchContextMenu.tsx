import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'

import { isEmpty } from '@velaros/core'

import styles from '../../styles/workbenchPageStyles'
import { useBlockWheelScroll } from '../../support/useBlockWheelScroll'
import { useDismissOnWindowInteract } from '../../support/useDismissOnWindowInteract'

export interface WorkbenchContextMenuItem {
  id: string
  label: string
  icon: ReactNode
  disabled?: boolean
  separatorBefore?: boolean
  onSelect: () => void | Promise<void>
}

interface WorkbenchContextMenuProps {
  x: number
  y: number
  items: readonly WorkbenchContextMenuItem[]
  onDismiss: () => void
  ariaLabel?: string
  compact?: boolean
}

const ViewportPadding = 8

export function WorkbenchContextMenu({
  x,
  y,
  items,
  onDismiss,
  ariaLabel,
  compact = false,
}: WorkbenchContextMenuProps): ReactElement {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x, y })

  useDismissOnWindowInteract({
    enabled: true,
    onDismiss,
    ignoreMouseDown: (event) =>
      event.target instanceof Node && !!menuRef.current?.contains(event.target),
  })
  useBlockWheelScroll(menuRef, true)

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return

    const rect = menu.getBoundingClientRect()
    setPosition({
      x: Math.max(ViewportPadding, Math.min(x, window.innerWidth - rect.width - ViewportPadding)),
      y: Math.max(ViewportPadding, Math.min(y, window.innerHeight - rect.height - ViewportPadding)),
    })
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [x, y, items])

  function moveFocus(event: KeyboardEvent<HTMLDivElement>, direction: 1 | -1): void {
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
    ]
    if (isEmpty(buttons)) return

    const currentIndex = buttons.findIndex((button) => button === document.activeElement)
    const nextIndex =
      currentIndex < 0 ? 0 : (currentIndex + direction + buttons.length) % buttons.length
    buttons[nextIndex]?.focus()
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    event.stopPropagation()
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveFocus(event, 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event, -1)
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const buttons = [
        ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
      ]
      const target = event.key === 'Home' ? buttons[0] : buttons.at(-1)
      target?.focus()
    }
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      className={styles.workbenchContextMenu}
      data-compact={compact ? 'true' : undefined}
      style={{ left: position.x, top: position.y }}
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {items.map((item) => (
        <div key={item.id} className={styles.workbenchContextMenuItemShell}>
          {!!item.separatorBefore && <span className={styles.workbenchContextMenuSeparator} />}
          <button
            type="button"
            role="menuitem"
            className={styles.workbenchContextMenuItem}
            disabled={item.disabled}
            onClick={() => {
              onDismiss()
              void item.onSelect()
            }}
          >
            <span className={styles.workbenchContextMenuIcon} aria-hidden>
              {item.icon}
            </span>
            <span className={styles.workbenchContextMenuLabel}>{item.label}</span>
          </button>
        </div>
      ))}
    </div>
  )
}
