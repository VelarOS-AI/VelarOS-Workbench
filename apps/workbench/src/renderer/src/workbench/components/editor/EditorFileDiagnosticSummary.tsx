import { type ReactElement } from 'react'
import { CaretDownIcon, CaretUpIcon } from '@phosphor-icons/react'
import { WorkbenchProblemSeverityIcon } from '@workbench/components/editor/WorkbenchProblemSeverityIcon'
import type { WorkbenchLanguageServiceDiagnostic } from '@workbench/contracts'
import { useWorkbenchI18n } from '@workbench/i18n'
import {
  countWorkbenchFileDiagnostics,
  sortWorkbenchFileDiagnostics,
} from '@workbench/models/editor/workbenchCodeInsightModel'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'

import styles from '../../styles/workbenchPageStyles'

interface EditorFileDiagnosticSummaryProps {
  diagnostics: readonly WorkbenchLanguageServiceDiagnostic[]
  onOpenProblems: () => void
  onNavigatePrevious: () => void
  onNavigateNext: () => void
}

export function EditorFileDiagnosticSummary({
  diagnostics,
  onOpenProblems,
  onNavigatePrevious,
  onNavigateNext,
}: EditorFileDiagnosticSummaryProps): Nullable<ReactElement> {
  const { t } = useWorkbenchI18n()
  const sortedDiagnostics = sortWorkbenchFileDiagnostics(diagnostics)
  const { errorCount, warningCount } = countWorkbenchFileDiagnostics(sortedDiagnostics)

  if (!errorCount && !warningCount) return null

  const summaryLabel = t('workbench.editorFileDiagnosticSummary', {
    errorCount,
    warningCount,
  })

  return (
    <div
      className={styles.editorViewportDiagnosticSummary}
      role="status"
      aria-label={summaryLabel}
      title={summaryLabel}
    >
      {(errorCount > 0) && (
        <button
          type="button"
          className={styles.editorViewportDiagnosticGroup}
          data-severity="error"
          title={t('workbench.editorFileErrorCount', { count: errorCount })}
          aria-label={t('workbench.editorFileErrorCount', { count: errorCount })}
          onClick={onOpenProblems}
        >
          <WorkbenchProblemSeverityIcon kind="error" size={12} />
          <span>{errorCount}</span>
        </button>
      )}
      {(warningCount > 0) && (
        <button
          type="button"
          className={styles.editorViewportDiagnosticGroup}
          data-severity="warning"
          title={t('workbench.editorFileWarningCount', { count: warningCount })}
          aria-label={t('workbench.editorFileWarningCount', { count: warningCount })}
          onClick={onOpenProblems}
        >
          <WorkbenchProblemSeverityIcon kind="warning" size={12} />
          <span>{warningCount}</span>
        </button>
      )}
      <div className={styles.editorViewportDiagnosticNav}>
        <IconButton
          variant="ghost"
          size="icon-sm"
          label={t('workbench.editorFileDiagnosticPrevious')}
          title={t('workbench.editorFileDiagnosticPrevious')}
          disabled={!sortedDiagnostics.length}
          onClick={onNavigatePrevious}
        >
          <CaretUpIcon size={14} />
        </IconButton>
        <IconButton
          variant="ghost"
          size="icon-sm"
          label={t('workbench.editorFileDiagnosticNext')}
          title={t('workbench.editorFileDiagnosticNext')}
          disabled={!sortedDiagnostics.length}
          onClick={onNavigateNext}
        >
          <CaretDownIcon size={14} />
        </IconButton>
      </div>
    </div>
  )
}
