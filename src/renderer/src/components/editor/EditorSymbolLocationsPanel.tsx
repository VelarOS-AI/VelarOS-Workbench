import {
  type CSSProperties,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { ArrowLeftIcon, CodeIcon, XIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import {
  sameWorkbenchSymbolLocation,
  workbenchSymbolLocationDisplayPath,
  type WorkbenchSymbolLocationsState,
} from '@renderer/models/editor/workbenchSymbolLocations'

import type { WorkbenchLanguageServiceLocation } from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'

interface EditorSymbolLocationsPanelProps {
  anchor: { left: number; top: number; bottom: number }
  boundaryRef: RefObject<HTMLElement | null>
  projectRoot: string
  state: WorkbenchSymbolLocationsState
  onClose: () => void
  onNavigate: (location: WorkbenchLanguageServiceLocation) => void
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
}: EditorSymbolLocationsPanelProps) {
  const { t } = useWorkbenchI18n()
  const popupRef = useRef<HTMLElement>(null)
  const [position, setPosition] = useState<CSSProperties>({
    left: anchor.left,
    top: anchor.bottom + 6,
    visibility: 'hidden',
  })
  const referenceCount = state.items.filter((item) => item.kind === 'reference').length

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

  useEffect(() => {
    const handleMouseDown = (event: globalThis.MouseEvent): void => {
      if (event.target instanceof Node && popupRef.current?.contains(event.target)) return
      onClose()
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('mousedown', handleMouseDown, true)
    window.addEventListener('keydown', handleKeyDown, true)
    return () => {
      window.removeEventListener('mousedown', handleMouseDown, true)
      window.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [onClose])

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
          {state.truncated && <span>{t('workbench.symbolLocationsTruncated')}</span>}
        </div>
        <button
          type="button"
          className={styles.editorSymbolLocationsClose}
          aria-label={t('workbench.symbolLocationsClose')}
          title={t('workbench.symbolLocationsClose')}
          onClick={onClose}
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

      <div className={styles.editorSymbolLocationsBody}>
        {state.items.length > 0 ? (
          state.items.map((item) => {
            const active = sameWorkbenchSymbolLocation(state.activeLocation, item.location)
            return (
              <button
                key={item.id}
                type="button"
                className={styles.editorSymbolLocationRow}
                data-active={active ? 'true' : undefined}
                title={locationLabel(projectRoot, item.location)}
                onClick={() => onNavigate(item.location)}
              >
                <span className={styles.editorSymbolLocationKind} data-kind={item.kind}>
                  {t(
                    item.kind === 'definition'
                      ? 'workbench.symbolLocationsDefinition'
                      : 'workbench.symbolLocationsReference'
                  )}
                </span>
                <span className={styles.editorSymbolLocationPath}>
                  {workbenchSymbolLocationDisplayPath(projectRoot, item.location.path)}
                </span>
                <span className={styles.editorSymbolLocationPosition}>
                  {item.location.line}:{item.location.column}
                </span>
              </button>
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
