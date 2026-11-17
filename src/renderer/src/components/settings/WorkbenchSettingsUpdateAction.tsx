import {
  ArrowCounterClockwiseIcon,
  DownloadSimpleIcon,
  PauseIcon,
  PlayIcon,
} from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'
import type { ReactElement } from 'react'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'

import type { WorkbenchUpdateState } from '@shared/workbenchUpdate'

import styles from '../../styles/WorkbenchSettingsUpdateAction.module.css'

export function WorkbenchSettingsUpdateAction({
  state,
  onError,
}: {
  state: WorkbenchUpdateState
  onError: (error: unknown) => void
}): ReactElement {
  const { t } = useWorkbenchI18n()
  const run = (operation: Promise<unknown>): void => {
    void operation.catch(onError)
  }
  const phase = state.phase
  const percent = Math.round(Math.max(0, Math.min(100, state.percent ?? 0)))
  const preparing = phase === 'verifying' || phase === 'preparing'
  const active = preparing || phase === 'downloading' || phase === 'retrying' || phase === 'paused'
  let label = `${percent}%`
  if (phase === 'paused') label = `${t('workbench.updateResume')} · ${percent}%`
  else if (phase === 'verifying') label = `${t('workbench.updateVerifyingShort')} · ${percent}%`
  else if (phase === 'preparing')
    label = `${t(state.preparationStep === 'checking-files' ? 'workbench.updateCheckingFilesShort' : 'workbench.updateExtractingShort')} · ${percent}%`
  else if (phase === 'retrying')
    label = t('workbench.updateRetrying', { attempt: state.retryAttempt ?? 1 })
  return (
    <div className={styles.host}>
      {active ? (
        <button
          type="button"
          className={styles.progress}
          disabled={preparing}
          aria-label={
            preparing
              ? label
              : phase === 'paused'
                ? t('workbench.updateResume')
                : t('workbench.updatePause')
          }
          onClick={() =>
            run(
              phase === 'paused'
                ? window.velarosWorkbenchUpdate.resume()
                : window.velarosWorkbenchUpdate.pause()
            )
          }
        >
          <span className={styles.fill} style={{ width: `${percent}%` }} aria-hidden="true" />
          <span className={styles.label} aria-live="polite">
            {!preparing &&
              (phase === 'paused' ? (
                <PlayIcon size={13} weight="fill" />
              ) : (
                <PauseIcon size={13} weight="fill" />
              ))}
            {label}
          </span>
        </button>
      ) : (
        <Button
          size="sm"
          variant={phase === 'downloaded' ? 'default' : 'outline'}
          disabled={phase === 'checking'}
          onClick={() =>
            run(
              phase === 'downloaded'
                ? window.velarosWorkbenchUpdate.restart()
                : phase === 'available'
                  ? window.velarosWorkbenchUpdate.download()
                  : window.velarosWorkbenchUpdate.check()
            )
          }
        >
          {phase === 'available' ? (
            <DownloadSimpleIcon size={14} />
          ) : (
            phase !== 'downloaded' && <ArrowCounterClockwiseIcon size={14} />
          )}
          {t(
            phase === 'downloaded'
              ? 'workbench.settingsRestartToUpdate'
              : phase === 'available'
                ? 'workbench.settingsDownloadUpdate'
                : phase === 'checking'
                  ? 'workbench.settingsCheckingForUpdates'
                  : 'workbench.settingsCheckForUpdates'
          )}
        </Button>
      )}
      {phase === 'error' && (
        <span className={styles.error} role="alert">
          {state.error}
        </span>
      )}
    </div>
  )
}
