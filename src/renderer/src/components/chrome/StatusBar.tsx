import { CaretRightIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import type { ReactElement } from 'react'

import { Text } from '@velaros-ai/ui/primitives/display/Text'

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
  /** 当前文件处于只读模式（或无法在编辑器里修改）。 */
  readOnly?: boolean
  isSavingFile: boolean
  openFileCount: number
  commandStatusLabel: string
}

export function StatusBar({
  projectName,
  selectedFilePath,
  cursorPosition,
  hasUnsavedChanges,
  readOnly = false,
  isSavingFile,
  openFileCount,
  commandStatusLabel,
}: StatusBarProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const pathSegments = selectedFilePath?.split('/').filter((value) => !!value) ?? []
  const fileName = pathSegments.at(-1) ?? ''

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
      {!!selectedFilePath && readOnly && (
        <Text truncate tone="caption" className={styles.statusBarItem}>
          {t('workbench.readOnlyFile')}
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
    </footer>
  )
}
