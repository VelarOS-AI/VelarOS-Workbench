export type WorkbenchCommandStatusMessageKey =
  | 'workbench.commandFailedStatus'
  | 'workbench.commandIdle'
  | 'workbench.commandRunning'
  | 'workbench.commandStale'
  | 'workbench.commandSucceeded'
  | 'workbench.commandTimedOut'

type Translate = (
  key: WorkbenchCommandStatusMessageKey,
  params?: Record<string, string | number>
) => string

interface WorkbenchCommandStatusState {
  commandResult: LooseOptional<{
    success: boolean
    timedOut?: boolean
  }>
  isRunningCommand: boolean
  isValidationStale: boolean
}

export function getWorkbenchCommandStatusLabel(
  state: WorkbenchCommandStatusState,
  t: Translate
): string {
  if (state.isRunningCommand) return t('workbench.commandRunning')

  if (state.isValidationStale) return t('workbench.commandStale')

  if (!state.commandResult) return t('workbench.commandIdle')

  if (state.commandResult.success) return t('workbench.commandSucceeded')

  return state.commandResult.timedOut
    ? t('workbench.commandTimedOut')
    : t('workbench.commandFailedStatus')
}
