import { type ReactElement, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { WorkbenchCodeActionMenuRow } from '@renderer/models/editor/workbenchCodeActions'

import type { WorkbenchLanguageServiceCodeAction } from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'
import { useEventListener } from '../../support/genericHooks'
import { useDismissOnWindowInteract } from '../../support/useDismissOnWindowInteract'
import {
  focusFirstWorkbenchMenuItem,
  handleWorkbenchMenuKeyDown,
} from '../chrome/WorkbenchContextMenu'

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
 * 光标处的动作菜单（⌥↩ / ⌘.）：上下键选、回车套用、Esc 或点别处收起。菜单开着时焦点在菜单里，
 * 编辑器收不到按键，正文不会在菜单底下被改掉。方向键、Home / End 与工作台别的菜单是同一套
 * （handleWorkbenchMenuKeyDown）；收起之后焦点由调用方还给编辑器。
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
  const hasActions = !!rows?.some((row) => row.kind === 'action')

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

  // 一打开焦点就进菜单：动作还没问到时先落在菜单本身上，问到了落到第一项上，方向键和回车马上能用。
  useEffect(() => {
    if (hasActions) focusFirstWorkbenchMenuItem(menuRef.current)
    else menuRef.current?.focus()
  }, [hasActions])

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
        // Esc 在这里收住，不往窗口上传：全局快捷键里 Esc 还管着收起右侧面板。
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
          return
        }
        handleWorkbenchMenuKeyDown(event)
      }}
    >
      {error ? (
        <div className={styles.editorCodeActionMenuStatus} data-tone="error">
          {error}
        </div>
      ) : !rows ? (
        <div className={styles.editorCodeActionMenuStatus}>{loadingLabel}</div>
      ) : !hasActions ? (
        <div className={styles.editorCodeActionMenuStatus}>{emptyLabel}</div>
      ) : (
        rows.map((row) =>
          row.kind === 'header' ? (
            <div key={row.key} className={styles.editorCodeActionMenuHeader} role="presentation">
              {row.title}
            </div>
          ) : (
            <button
              key={row.key}
              type="button"
              role="menuitem"
              className={styles.editorCodeActionMenuItem}
              title={row.action.title}
              // 正在算改动时不收新的选择，但不真的禁用：禁用的按钮留不住焦点，按键就漏到菜单外面去了。
              aria-disabled={busy}
              onClick={() => {
                if (!busy) onChoose(row.action)
              }}
            >
              {row.action.title}
            </button>
          )
        )
      )}
    </div>
  )
}
