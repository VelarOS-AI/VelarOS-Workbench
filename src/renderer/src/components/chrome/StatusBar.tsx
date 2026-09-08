import { CaretRightIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import type { ReactElement } from 'react'

import { Text } from '@velaros-ai/ui/primitives/display/Text'

import type { WorkbenchProjectAiIndexStatus } from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'
import { WorkbenchFileTypeIcon } from '../files/WorkbenchFileTypeIcon'
import { WorkbenchUpdateProgress } from '../updates/WorkbenchUpdateProgress'

interface StatusBarProps {
  projectName: string
  selectedFilePath: Nullable<string>
  cursorPosition: {
    line: number
    column: number
  }
  hasUnsavedChanges: boolean
  isSavingFile: boolean
  openFileCount: number
  commandStatusLabel: string
  isIndexingProject: boolean
  projectAiIndexStatus: Nullable<WorkbenchProjectAiIndexStatus>
  projectAiIndexSkipped: boolean
  codeGraphAvailable: boolean
  onOpenProjectAiIndexDetails?: () => void
}

export function StatusBar({
  projectName,
  selectedFilePath,
  cursorPosition,
  hasUnsavedChanges,
  isSavingFile,
  openFileCount,
  commandStatusLabel,
  isIndexingProject,
  projectAiIndexStatus,
  projectAiIndexSkipped,
  codeGraphAvailable,
  onOpenProjectAiIndexDetails,
}: StatusBarProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const pathSegments = selectedFilePath?.split('/').filter((value) => !!value) ?? []
  const fileName = pathSegments.at(-1) ?? ''
  const aiIndexLabel = getProjectAiIndexLabel(projectAiIndexStatus, projectAiIndexSkipped, t)

  return (
    <footer className={styles.statusBar}>
      {selectedFilePath ? (
        <div className={styles.statusPathTrail} title={`${projectName}/${selectedFilePath}`}>
          <Text truncate tone="caption" className={styles.statusPathSegment}>
            {projectName}
          </Text>
          {pathSegments.map((segment, index) => {
            const isFile = index === pathSegments.length - 1

            return (
              <span key={`${index}:${segment}`} className={styles.statusPathPart}>
                <CaretRightIcon size={11} className={styles.statusPathSeparator} />
                <Text
                  truncate
                  tone="caption"
                  className={isFile ? styles.statusPathFile : styles.statusPathSegment}
                >
                  {isFile && <WorkbenchFileTypeIcon fileName={fileName} size={13} />}
                  <span>{segment}</span>
                </Text>
              </span>
            )
          })}
        </div>
      ) : (
        <Text truncate tone="caption" className={styles.statusBarItem}>
          {t('workbench.noFileSelected')}
        </Text>
      )}
      <Text truncate tone="caption" className={styles.statusBarItem}>
        {t('workbench.cursorPosition', cursorPosition)}
      </Text>
      {!!selectedFilePath && (
        <Text truncate tone="caption" className={styles.statusBarItem}>
          {isSavingFile
            ? t('workbench.saving')
            : hasUnsavedChanges
              ? t('workbench.unsaved')
              : t('workbench.saved')}
        </Text>
      )}
      <span className={styles.statusBarSpacer} />
      <WorkbenchUpdateProgress />
      <Text truncate tone="caption" className={styles.statusBarItem}>
        {t('workbench.openFileCount', { count: openFileCount })}
      </Text>
      <Text truncate tone="caption" className={styles.statusBarItem}>
        {commandStatusLabel}
      </Text>
      {codeGraphAvailable && isIndexingProject && (
        <span className={styles.statusIndexProgress} role="status" aria-live="polite">
          <Text truncate tone="caption">
            {t('workbench.contextIndexing')}
          </Text>
          <span className={styles.statusIndexProgressTrack} aria-hidden="true">
            <span className={styles.statusIndexProgressIndicator} />
          </span>
        </span>
      )}
      {codeGraphAvailable && aiIndexLabel && onOpenProjectAiIndexDetails ? (
        <button
          type="button"
          className={styles.statusBarItem}
          title={getProjectAiIndexTitle(projectAiIndexStatus)}
          onClick={onOpenProjectAiIndexDetails}
        >
          <Text truncate tone="caption">
            {aiIndexLabel}
          </Text>
        </button>
      ) : (
        codeGraphAvailable &&
        !!aiIndexLabel && (
          <Text
            truncate
            tone="caption"
            className={styles.statusBarItem}
            title={getProjectAiIndexTitle(projectAiIndexStatus)}
          >
            {aiIndexLabel}
          </Text>
        )
      )}
    </footer>
  )
}

function getProjectAiIndexLabel(
  status: Nullable<WorkbenchProjectAiIndexStatus>,
  skipped: boolean,
  t: ReturnType<typeof useWorkbenchI18n>['t']
): Nullable<string> {
  if (!status) return null

  switch (status.status) {
    case 'indexing': {
      return t(projectAiIndexPhaseKey(status.phase), {
        count: status.indexedFiles,
      })
    }
    case 'ready': {
      return t('workbench.aiIndexReady')
    }
    case 'failed': {
      return t('workbench.aiIndexFailed')
    }
    default: {
      return skipped ? t('workbench.aiIndexSkipped') : t('workbench.aiIndexPending')
    }
  }
}

function getProjectAiIndexTitle(
  status: LooseOptional<WorkbenchProjectAiIndexStatus>
): string | undefined {
  return (status?.error ?? status?.memoryId) as string
}

function projectAiIndexPhaseKey(
  phase: WorkbenchProjectAiIndexStatus['phase']
):
  | 'workbench.aiIndexPreparingStatus'
  | 'workbench.aiIndexBuildingCodeGraphStatus'
  | 'workbench.aiIndexSyncingKnowledgeStatus'
  | 'workbench.aiIndexWritingMemoryStatus'
  | 'workbench.aiIndexing' {
  switch (phase) {
    case 'scanning-project':
      return 'workbench.aiIndexPreparingStatus'
    case 'building-codegraph':
      return 'workbench.aiIndexBuildingCodeGraphStatus'
    case 'syncing-knowledge':
      return 'workbench.aiIndexSyncingKnowledgeStatus'
    case 'writing-memory':
      return 'workbench.aiIndexWritingMemoryStatus'
    default:
      return 'workbench.aiIndexing'
  }
}
