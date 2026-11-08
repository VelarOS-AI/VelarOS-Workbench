import { XIcon } from '@phosphor-icons/react'
import { useWorkbenchUpdate } from '@renderer/hooks/useWorkbenchUpdate'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'
import type { KeyboardEvent, MouseEvent, ReactElement } from 'react'

import styles from '../styles/WorkbenchUpdateProgress.module.css'

function updateLabel(
  phase: ReturnType<typeof useWorkbenchUpdate>['phase'],
  percent: number,
  targetVersion: string,
  retryAttempt: number,
  t: ReturnType<typeof useWorkbenchI18n>['t']
): string {
  if (phase === 'paused') return t('workbench.updatePaused', { percent, version: targetVersion })
  if (phase === 'downloaded') return t('workbench.updateDownloaded', { version: targetVersion })
  if (phase === 'verifying') return t('workbench.updateVerifying')
  if (phase === 'preparing') return t('workbench.updatePreparing')
  if (phase === 'retrying') return t('workbench.updateRetrying', { attempt: retryAttempt })
  return t('workbench.updateDownloading', { percent, version: targetVersion })
}

export function WorkbenchUpdateProgress(): Nullable<ReactElement> {
  const state = useWorkbenchUpdate()
  const { t } = useWorkbenchI18n()
  if (
    !['downloading', 'retrying', 'verifying', 'preparing', 'paused', 'downloaded'].includes(
      state.phase
    )
  )
    return null
  const percent = Math.round(state.percent ?? 0)
  const targetVersion = state.targetVersion ?? ''
  const preparing = state.phase === 'verifying' || state.phase === 'preparing'
  const label = updateLabel(state.phase, percent, targetVersion, state.retryAttempt ?? 1, t)

  const toggle = (): void => {
    if (preparing) return
    if (state.phase === 'downloading' || state.phase === 'retrying')
      void window.velarosWorkbenchUpdate.pause()
    else if (state.phase === 'paused') void window.velarosWorkbenchUpdate.resume()
    else void window.velarosWorkbenchUpdate.restart()
  }
  const cancel = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    void window.velarosWorkbenchUpdate.cancel()
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    toggle()
  }

  return (
    <div className={styles.host} data-phase={state.phase}>
      <div
        role="button"
        tabIndex={preparing ? -1 : 0}
        className={styles.progressButton}
        onClick={toggle}
        onKeyDown={handleKeyDown}
        aria-label={label}
        aria-disabled={preparing}
        title={label}
      >
        <span className={styles.track} aria-hidden="true">
          <span className={styles.fill} style={{ width: `${percent}%` }} />
        </span>
        <span className={styles.label}>{label}</span>
        {state.phase === 'paused' && (
          <button
            type="button"
            className={styles.cancelButton}
            aria-label={t('workbench.updateCancel')}
            title={t('workbench.updateCancel')}
            onClick={cancel}
          >
            <XIcon size={13} weight="bold" />
          </button>
        )}
      </div>
    </div>
  )
}
