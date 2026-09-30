import { type ReactElement, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  nextWorkbenchCodeActionRowIndex,
  type WorkbenchCodeActionMenuRow,
} from '@renderer/models/editor/workbenchCodeActions'

import type { WorkbenchLanguageServiceCodeAction } from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'
import { useEventListener } from '../../support/genericHooks'
import { useDismissOnWindowInteract } from '../../support/useDismissOnWindowInteract'

const MenuEdgeInset = 8
const MenuAnchorGap = 4

export interface EditorCodeActionMenuAnchor {
  left: number
  top: number
  bottom: number
}

interface EditorCodeActionMenuProps {
  /** 光标在窗口里的位置：菜单贴着这一行的下沿，放不下就翻到上面。 */
  anchor: EditorCodeActionMenuAnchor
  /** 能选的动作；null 表示还在问语言服务。 */
  rows: Nullable<readonly WorkbenchCodeActionMenuRow[]>
  /** 没问成（语言服务出错、超时）时的说明。 */
  error: Nullable<string>
  /** 选中的动作正在算改动：这期间不收新的选择。 */
  busy: boolean
  label: string
  loadingLabel: string
  emptyLabel: string
  onChoose: (action: WorkbenchLanguageServiceCodeAction) => void
  onClose: () => void
}

/**
 * 光标处的动作菜单（⌥↩ / ⌘.）：上下键选、回车套用、Esc 或点别处收起。菜单开着时焦点在菜单上，
 * 编辑器收不到按键，正文不会在菜单底下被改掉。
 */
export function EditorCodeActionMenu({
  anchor,
  rows,
  error,
  busy,
  label,
  loadingLabel,
  emptyLabel,
  onChoose,
  onClose,
}: EditorCodeActionMenuProps): ReactElement {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: anchor.left, top: anchor.bottom + MenuAnchorGap })
  const [activeIndex, setActiveIndex] = useState(-1)
  const firstActionIndex = rows ? nextWorkbenchCodeActionRowIndex(rows, -1, 1) : -1
  const selectedIndex = rows?.[activeIndex]?.kind === 'action' ? activeIndex : firstActionIndex

  useDismissOnWindowInteract({
    enabled: true,
    onDismiss: onClose,
    // Esc 由菜单自己接（同一次按键不再交给全局快捷键）；滚动在下面另接，菜单自己的滚动不算。
    escapeKey: false,
    scroll: false,
    ignoreMouseDown: (event) =>
      event.target instanceof Node && !!menuRef.current?.contains(event.target),
  })
  // 背后的编辑器滚走了，菜单指着的那一行就不在原处了：收起。动作多的时候菜单自己能滚，不收。
  useEventListener(
    'scroll',
    (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return
      onClose()
    },
    { capture: true }
  )

  useEffect(() => {
    menuRef.current?.focus()
  }, [])

  // 行数变了（动作到了）菜单的高度跟着变：重新摆，别伸到窗口外面。
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return

    const { width, height } = menu.getBoundingClientRect()
    const below = anchor.bottom + MenuAnchorGap
    const above = anchor.top - MenuAnchorGap - height
    const top =
      below + height <= window.innerHeight - MenuEdgeInset || above < MenuEdgeInset ? below : above
    const left = Math.max(
      MenuEdgeInset,
      Math.min(anchor.left, window.innerWidth - width - MenuEdgeInset)
    )
    setPosition((current) =>
      current.left === left && current.top === top ? current : { left, top }
    )
  }, [anchor.bottom, anchor.left, anchor.top, error, rows])

  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLElement>(`[data-code-action-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  function choose(index: number): void {
    const row = rows?.[index]
    if (busy || row?.kind !== 'action') return
    onChoose(row.action)
  }

  return (
    <div
      ref={menuRef}
      className={styles.editorCodeActionMenu}
      style={position}
      role="menu"
      aria-label={label}
      aria-busy={busy || rows === null}
      tabIndex={-1}
      onKeyDown={(event) => {
        // 菜单开着时按键都归菜单：不漏给编辑器，也不触发全局快捷键。
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
          return
        }
        if (!rows) return

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          setActiveIndex(
            nextWorkbenchCodeActionRowIndex(rows, selectedIndex, event.key === 'ArrowDown' ? 1 : -1)
          )
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          setActiveIndex(
            event.key === 'Home'
              ? firstActionIndex
              : nextWorkbenchCodeActionRowIndex(rows, rows.length, -1)
          )
        } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault()
          choose(selectedIndex)
        }
      }}
    >
      {error ? (
        <div className={styles.editorCodeActionMenuStatus} data-tone="error">
          {error}
        </div>
      ) : !rows ? (
        <div className={styles.editorCodeActionMenuStatus}>{loadingLabel}</div>
      ) : firstActionIndex < 0 ? (
        <div className={styles.editorCodeActionMenuStatus}>{emptyLabel}</div>
      ) : (
        rows.map((row, index) =>
          row.kind === 'header' ? (
            <div key={row.key} className={styles.editorCodeActionMenuHeader} role="presentation">
              {row.title}
            </div>
          ) : (
            <button
              key={row.key}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={styles.editorCodeActionMenuItem}
              data-active={index === selectedIndex ? 'true' : undefined}
              data-code-action-index={index}
              title={row.action.title}
              disabled={busy}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              {row.action.title}
            </button>
          )
        )
      )}
    </div>
  )
}
