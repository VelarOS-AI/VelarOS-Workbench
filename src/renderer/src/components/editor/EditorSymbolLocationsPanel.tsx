import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ArrowLeftIcon, CodeIcon, XIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import {
  groupWorkbenchSymbolLocations,
  sameWorkbenchSymbolLocation,
  workbenchSymbolLocationDisplayPath,
  type WorkbenchSymbolLocationsState,
} from '@renderer/models/editor/workbenchSymbolLocations'

import type { WorkbenchLanguageServiceLocation } from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'
import { useLatest } from '../../support/genericHooks'
import { handleWorkbenchMenuKeyDown } from '../chrome/WorkbenchContextMenu'

interface EditorSymbolLocationsPanelProps {
  anchor: { left: number; top: number; bottom: number }
  boundaryRef: RefObject<HTMLElement | null>
  projectRoot: string
  state: WorkbenchSymbolLocationsState
  onClose: () => void
  onNavigate: (location: WorkbenchLanguageServiceLocation) => void
  /** 面板关掉时键盘焦点还在面板里（Esc、关闭按钮）：交还给编辑器，不让它落空。 */
  onFocusEditor?: () => void
}

function locationLabel(projectRoot: string, location: WorkbenchLanguageServiceLocation): string {
  return `${workbenchSymbolLocationDisplayPath(projectRoot, location.path)}:${location.line}:${location.column}`
}

export function EditorSymbolLocationsPanel({
  anchor,
  boundaryRef,
  projectRoot,
  state,
  onClose,
  onNavigate,
  onFocusEditor,
}: EditorSymbolLocationsPanelProps) {
  const { t } = useWorkbenchI18n()
  const popupRef = useRef<HTMLElement>(null)
  const [position, setPosition] = useState<CSSProperties>({
    left: anchor.left,
    top: anchor.bottom + 6,
    visibility: 'hidden',
  })
  const bodyRef = useRef<HTMLDivElement>(null)
  const referenceCount = state.items.filter((item) => item.kind === 'reference').length
  const groups = useMemo(
    () => groupWorkbenchSymbolLocations(state.items, state.origin.path),
    [state.items, state.origin.path]
  )

  // 「查找引用」打开的列表：键盘焦点直接放进去（眼下那一行，没有就第一行），上下键挑、回车跳过去。
  // 要等面板摆好位置显示出来：还藏着的时候接不了焦点。
  const { focusList } = state
  const placed = position.visibility === 'visible'
  useEffect(() => {
    if (!focusList || !placed) return
    const rows = [...(bodyRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    ;(rows.find((row) => row.dataset['active'] === 'true') ?? rows[0])?.focus({ preventScroll: true })
  }, [focusList, placed])

  useLayoutEffect(() => {
    const popup = popupRef.current
    const boundary = boundaryRef.current
    if (!popup || !boundary) return undefined

    const updatePosition = (): void => {
      const margin = 8
      const gap = 6
      const boundaryWidth = boundary.clientWidth
      const boundaryHeight = boundary.clientHeight
      const maxWidth = Math.max(280, boundaryWidth - margin * 2)
      const popupWidth = Math.min(popup.offsetWidth, maxWidth)
      const left = Math.min(
        Math.max(anchor.left, margin),
        Math.max(margin, boundaryWidth - popupWidth - margin)
      )
      const belowSpace = boundaryHeight - anchor.bottom - gap - margin
      const aboveSpace = anchor.top - gap - margin
      const placeAbove = belowSpace < Math.min(popup.offsetHeight, 180) && aboveSpace > belowSpace
      const maxHeight = Math.max(120, placeAbove ? aboveSpace : belowSpace)
      const top = placeAbove
        ? Math.max(margin, anchor.top - gap - Math.min(popup.offsetHeight, maxHeight))
        : Math.min(anchor.bottom + gap, Math.max(margin, boundaryHeight - margin - 120))

      setPosition({ left, top, maxWidth, maxHeight, visibility: 'visible' })
    }

    updatePosition()
    const resizeObserver = new ResizeObserver(updatePosition)
    resizeObserver.observe(popup)
    resizeObserver.observe(boundary)
    window.addEventListener('resize', updatePosition)
    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', updatePosition)
    }
  }, [anchor.bottom, anchor.left, anchor.top, boundaryRef, state])

  const closeFromInside = (): void => {
    const hadFocus = !!popupRef.current?.contains(document.activeElement)
    onClose()
    if (hadFocus) onFocusEditor?.()
  }
  const closeFromInsideLatest = useLatest(closeFromInside)

  useEffect(() => {
    const handleMouseDown = (event: globalThis.MouseEvent): void => {
      if (event.target instanceof Node && popupRef.current?.contains(event.target)) return
      onClose()
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeFromInsideLatest.current()
    }
    window.addEventListener('mousedown', handleMouseDown, true)
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('mousedown', handleMouseDown, true)
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [closeFromInsideLatest, onClose])

  return (
    <section
      ref={popupRef}
      className={styles.editorSymbolLocationsPanel}
      style={position}
      aria-label={t('workbench.symbolLocationsTitle')}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <header className={styles.editorSymbolLocationsHeader}>
        <div className={styles.editorSymbolLocationsTitle}>
          <CodeIcon size={14} />
          <strong>{state.symbol}</strong>
          <span>{t('workbench.symbolLocationsCount', { count: referenceCount })}</span>
          {groups.length > 1 && (
            <span>{t('workbench.symbolLocationsFileCount', { count: groups.length })}</span>
          )}
          {state.truncated && <span>{t('workbench.symbolLocationsTruncated')}</span>}
        </div>
        <button
          type="button"
          className={styles.editorSymbolLocationsClose}
          aria-label={t('workbench.symbolLocationsClose')}
          title={t('workbench.symbolLocationsClose')}
          onClick={closeFromInside}
        >
          <XIcon size={14} />
        </button>
      </header>

      {state.returnLocation && (
        <button
          type="button"
          className={styles.editorSymbolLocationsReturn}
          title={locationLabel(projectRoot, state.returnLocation)}
          onClick={() => onNavigate(state.returnLocation!)}
        >
          <ArrowLeftIcon size={14} />
          <span>{t('workbench.symbolLocationsReturn')}</span>
          <strong>{locationLabel(projectRoot, state.returnLocation)}</strong>
        </button>
      )}

      {/* 列表里的方向键、Home / End 与工作台的菜单同一套。 */}
      <div
        ref={bodyRef}
        className={styles.editorSymbolLocationsBody}
        role="menu"
        aria-label={t('workbench.symbolLocationsTitle')}
        onKeyDown={handleWorkbenchMenuKeyDown}
      >
        {groups.length > 0 ? (
          groups.map((group) => {
            const displayPath = workbenchSymbolLocationDisplayPath(projectRoot, group.path)
            return (
              <section key={group.path} role="group" aria-label={displayPath}>
                <header className={styles.editorSymbolLocationGroup} title={displayPath}>
                  <span>{displayPath}</span>
                  <span>{group.items.length}</span>
                </header>
                {group.items.map((item) => {
                  const active = sameWorkbenchSymbolLocation(state.activeLocation, item.location)
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="menuitem"
                      className={styles.editorSymbolLocationRow}
                      data-active={active ? 'true' : undefined}
                      title={locationLabel(projectRoot, item.location)}
                      onClick={() => onNavigate(item.location)}
                    >
                      <span className={styles.editorSymbolLocationPosition}>
                        {item.location.line}:{item.location.column}
                      </span>
                      <span className={styles.editorSymbolLocationPreview}>
                        {item.location.preview ?? state.symbol}
                      </span>
                      {item.kind === 'definition' && (
                        <span className={styles.editorSymbolLocationKind} data-kind={item.kind}>
                          {t('workbench.symbolLocationsDefinition')}
                        </span>
                      )}
                    </button>
                  )
                })}
              </section>
            )
          })
        ) : (
          <div className={styles.editorSymbolLocationsEmpty}>
            {t('workbench.symbolLocationsEmpty')}
          </div>
        )}
      </div>
    </section>
  )
}
