import { type ReactElement, useEffect, useState } from 'react'
import { useStandaloneWorkbenchLocalization } from '@renderer/i18n/useStandaloneWorkbenchLocalization'
import {
  useWorkbenchI18n,
  WorkbenchLocalizationProvider,
} from '@renderer/i18n/WorkbenchLocalizationProvider'

import type { WorkbenchHistoryWindowState } from '@shared/workbenchHistoryWindow'

import { FileHistoryView } from '../components/editor/FileHistoryView'
import { useWorkbenchPreferences } from '../hooks/useWorkbenchPreferences'
import { WorkbenchMessageHost } from '../runtime/workbenchMessageHost'
import styles from '../styles/workbenchPageStyles'

function HistorySurface(): ReactElement {
  const preferences = useWorkbenchPreferences()
  const { t } = useWorkbenchI18n()
  const [state, setState] = useState<WorkbenchHistoryWindowState | null>(null)
  const [failed, setFailed] = useState(false)
  const bridge = window.velarosWorkbenchHistoryWindow
  useEffect(() => {
    let active = true
    let pushed = false
    const remove = bridge.onChanged((next) => {
      pushed = true
      if (active) setState(next)
    })
    void bridge
      .getState()
      .then((next) => {
        if (active && !pushed) setState(next)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    const keydown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      if (
        event.key === 'Escape' ||
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'w')
      ) {
        event.preventDefault()
        void bridge.close()
      }
    }
    window.addEventListener('keydown', keydown)
    return () => {
      active = false
      remove()
      window.removeEventListener('keydown', keydown)
    }
  }, [bridge])
  useEffect(() => {
    document.title = state
      ? t('workbench.fileHistoryTitle', { file: state.path.split('/').at(-1) ?? state.path })
      : t('workbench.editorContextLocalHistory')
  }, [state?.path, t])
  const failureMessages = {
    stale: t('workbench.fileHistoryRestoreStale'),
    closed: t('workbench.fileHistoryRestoreClosed'),
    'read-only': t('workbench.fileHistoryRestoreReadOnly'),
    unavailable: t('workbench.fileHistoryRestoreUnavailable'),
  }
  return (
    <div
      className={`${styles.root} ${styles.workbenchShell} ${styles.fileHistoryWindow}`}
      style={preferences.style}
    >
      {state ? (
        <FileHistoryView
          key={state.id}
          projectRoot={state.projectRoot}
          path={state.path}
          initialMode={state.mode}
          currentContent={state.currentContent}
          workbenchTheme={preferences.preferences.theme}
          restoreDisabledReason={
            !state.available
              ? failureMessages.closed
              : !state.editable
                ? failureMessages['read-only']
                : undefined
          }
          onRestore={async (content) => {
            const result = await bridge
              .restore({ id: state.id, content, expectedContent: state.currentContent })
              .catch(() => ({ ok: false as const, reason: 'unavailable' as const }))
            if (!result.ok) throw new Error(failureMessages[result.reason])
            await bridge.close()
          }}
        />
      ) : (
        <div className={styles.fileHistoryWindowEmpty} role="status">
          {failed ? failureMessages.unavailable : t('workbench.localHistoryLoading')}
        </div>
      )}
      <WorkbenchMessageHost />
    </div>
  )
}

export function StandaloneWorkbenchHistoryWindow(): ReactElement {
  const localization = useStandaloneWorkbenchLocalization()
  return (
    <WorkbenchLocalizationProvider value={localization}>
      <HistorySurface />
    </WorkbenchLocalizationProvider>
  )
}
