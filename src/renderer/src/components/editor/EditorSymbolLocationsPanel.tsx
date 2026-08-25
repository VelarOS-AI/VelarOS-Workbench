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
  projectRoot: string
  state: WorkbenchSymbolLocationsState
  onClose: () => void
  onNavigate: (location: WorkbenchLanguageServiceLocation) => void
}

function locationLabel(projectRoot: string, location: WorkbenchLanguageServiceLocation): string {
  return `${workbenchSymbolLocationDisplayPath(projectRoot, location.path)}:${location.line}:${location.column}`
}

export function EditorSymbolLocationsPanel({
  projectRoot,
  state,
  onClose,
  onNavigate,
}: EditorSymbolLocationsPanelProps) {
  const { t } = useWorkbenchI18n()
  const referenceCount = state.items.filter((item) => item.kind === 'reference').length

  return (
    <section className={styles.editorSymbolLocationsPanel} aria-label={t('workbench.symbolLocationsTitle')}>
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
