import { type ReactElement, useEffect, useMemo, useState } from 'react'
import { CaretDownIcon, CaretRightIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { WorkbenchProblemSeverityIcon } from '@renderer/components/editor/WorkbenchProblemSeverityIcon'
import { useWorkbenchI18n } from '@renderer/i18n'
import {
  buildWorkbenchProblemLocations,
  formatWorkbenchProblemDisplayMessage,
  groupWorkbenchProblemsByFile,
  type WorkbenchProblemLocation,
  type WorkbenchProblemLocationKind,
  type WorkbenchProblemLocationSeverity,
} from '@renderer/models/editor/workbenchCodeInsightModel'

import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { Title } from '@velaros-ai/ui/primitives/display/Title'
import { ScrollArea } from '@velaros-ai/ui/primitives/layout/ScrollArea'

import type { WorkbenchLanguageServiceInsights } from '../../hooks/useWorkbenchLanguageServiceInsights'
import styles from '../../styles/workbenchPageStyles'
import type {
  WorkbenchCommandBundle,
  WorkbenchEditorDocumentBundle,
  WorkbenchSelectionBundle,
} from '../../types/workbenchSurfaceBundles'
import { WorkbenchFileTypeIcon } from '../files/WorkbenchFileTypeIcon'

interface CodeInsightPanelProps {
  workbenchSelection: WorkbenchSelectionBundle
  workbenchEditor: Pick<WorkbenchEditorDocumentBundle, 'openTabs'>
  workbenchCommand: Pick<WorkbenchCommandBundle, 'commandResult'>
  languageServiceInsights?: LooseOptional<WorkbenchLanguageServiceInsights>
  projectRoot?: LooseOptional<string>
  hideHeader?: boolean
  activeProblemId?: LooseOptional<string>
  onActiveProblemChange?: (problem: WorkbenchProblemLocation) => void
  onGoToLocation: (path: string, line: number, column?: number) => void
}

export interface EditorNavigationRequest {
  id: number
  line: number
  column?: number
}

export function CodeInsightPanel({
  workbenchSelection: { selectedFile, selectedFilePath },
  workbenchEditor: { openTabs },
  workbenchCommand: { commandResult },
  languageServiceInsights = null,
  projectRoot = null,
  hideHeader = false,
  activeProblemId = null,
  onActiveProblemChange,
  onGoToLocation,
}: CodeInsightPanelProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const [collapsedFilePaths, setCollapsedFilePaths] = useState<ReadonlySet<string>>(() => new Set())
  const problemLocations = useMemo(
    () =>
      buildWorkbenchProblemLocations({
        commandResult,
        openTabs,
        selectedFilePath,
        diagnosticsByPath: languageServiceInsights?.diagnosticsByPath,
      }),
    [commandResult, languageServiceInsights?.diagnosticsByPath, openTabs, selectedFilePath]
  )
  const problemFileGroups = useMemo(
    () => groupWorkbenchProblemsByFile(problemLocations, projectRoot),
    [problemLocations, projectRoot]
  )
  const count = problemLocations.length

  useEffect(() => {
    setCollapsedFilePaths(new Set())
  }, [selectedFilePath])

  function problemKindLabel(kind: WorkbenchProblemLocationKind): string {
    switch (kind) {
      case 'console': {
        return t('workbench.problemConsole')
      }
      case 'debugger': {
        return t('workbench.problemDebugger')
      }
      case 'todo': {
        return t('workbench.problemTodo')
      }
      case 'command': {
        return t('workbench.problemCommand')
      }
      case 'diagnostic': {
        return t('workbench.problemDiagnostic')
      }
      default: {
        return t('workbench.problemTrailingWhitespace')
      }
    }
  }

  function problemSeverityIcon(problem: WorkbenchProblemLocation): ReactElement {
    const kind =
      problem.severity === 'error'
        ? 'error'
        : problem.severity === 'warning' || problem.isUnused
          ? 'warning'
          : 'hint'

    return <WorkbenchProblemSeverityIcon kind={kind} className={styles.problemItemIcon} />
  }

  function problemItemSeverity(problem: WorkbenchProblemLocation): WorkbenchProblemLocationSeverity {
    if (problem.isUnused) return 'warning'
    return problem.severity
  }

  function problemTooltip(problem: WorkbenchProblemLocation): string {
    return [
      problemKindLabel(problem.kind),
      `${problem.path}:${problem.line}:${problem.column}`,
      formatWorkbenchProblemDisplayMessage(problem),
      t('workbench.goToLine', { line: problem.line }),
    ].join('\n')
  }

  function toggleFileGroup(path: string): void {
    setCollapsedFilePaths((current) => {
      const next = new Set(current)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }

      return next
    })
  }

  function handleProblemSelect(problem: WorkbenchProblemLocation): void {
    onActiveProblemChange?.(problem)
    onGoToLocation(problem.path, problem.line, problem.column)
  }

  return (
    <section className={styles.toolWindowPanel}>
      {!hideHeader && (
        <div className={styles.toolWindowHeader}>
          <div className={styles.toolWindowTitleGroup}>
            <WarningCircleIcon size={15} />
            <Title level={5} className={styles.toolWindowTitle}>
              {t('workbench.editorProblems')}
            </Title>
            <Text className={styles.toolWindowMeta} tone="caption">
              {count}
            </Text>
          </div>
        </div>
      )}

      <ScrollArea className={styles.toolWindowBody}>
        {!selectedFile ? (
          <Paragraph tone="muted" spacing="none" className={styles.insightEmpty}>
            {t('workbench.selectFile')}
          </Paragraph>
        ) : problemLocations.length ? (
          <div className={styles.problemTree}>
            {problemFileGroups.map((group) => {
              const isCollapsed = collapsedFilePaths.has(group.path)

              return (
                <div key={group.path} className={styles.problemFileGroup}>
                  <button
                    type="button"
                    className={styles.problemFileHeader}
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleFileGroup(group.path)}
                  >
                    <span className={styles.problemFileDisclosure} aria-hidden>
                      {isCollapsed ? <CaretRightIcon size={12} /> : <CaretDownIcon size={12} />}
                    </span>
                    <span className={styles.problemFileIcon}>
                      <WorkbenchFileTypeIcon fileName={group.fileName} size={14} />
                    </span>
                    <span className={styles.problemFileName}>{group.fileName}</span>
                    {!!group.directoryPath && (
                      <span className={styles.problemFilePath}>{group.directoryPath}</span>
                    )}
                    <span className={styles.problemFileCount}>
                      {t('workbench.fileProblemCount', { count: group.problems.length })}
                    </span>
                  </button>
                  {!isCollapsed && (
                    <div className={styles.problemFileRows}>
                      {group.problems.map((problem) => (
                        <button
                          key={problem.id}
                          type="button"
                          className={styles.problemItem}
                          data-severity={problemItemSeverity(problem)}
                          data-selected={activeProblemId === problem.id ? 'true' : undefined}
                          data-muted={problem.isUnused ? 'true' : undefined}
                          title={problemTooltip(problem)}
                          onClick={() => handleProblemSelect(problem)}
                        >
                          {problemSeverityIcon(problem)}
                          <span className={styles.problemItemMessage}>
                            {formatWorkbenchProblemDisplayMessage(problem) ||
                              problemKindLabel(problem.kind)}
                          </span>
                          <span className={styles.problemItemLine}>:{problem.line}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <Paragraph tone="muted" spacing="none" className={styles.insightEmpty}>
            {t('workbench.noEditorProblems')}
          </Paragraph>
        )}
      </ScrollArea>
    </section>
  )
}
