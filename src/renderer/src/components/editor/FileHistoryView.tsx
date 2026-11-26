import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react'
import { CaretDownIcon, CaretUpIcon, ClockCounterClockwiseIcon } from '@phosphor-icons/react'
import {
  useWorkbenchFileHistory,
  type WorkbenchFileHistoryMode,
} from '@renderer/hooks/useWorkbenchFileHistory'
import { useWorkbenchHistoryRecordContent } from '@renderer/hooks/useWorkbenchHistoryRecordContent'
import { useWorkbenchHistorySearchIndex } from '@renderer/hooks/useWorkbenchHistorySearchIndex'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'
import { buildWorkbenchContentDiffRows } from '@renderer/models/git/workbenchGitDiffModel'
import type { WorkbenchThemeId } from '@renderer/models/workbenchPreferences'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Text } from '@velaros-ai/ui/primitives/display/Text'
import { SearchField } from '@velaros-ai/ui/primitives/forms/SearchField'
import { SegmentedControl } from '@velaros-ai/ui/primitives/forms/SegmentedControl'
import { ScrollArea } from '@velaros-ai/ui/primitives/layout/ScrollArea'
import { isEmpty, isNotNull, toNullable } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'

import styles from '../../styles/workbenchPageStyles'
import { WorkbenchFileTypeIcon } from '../files/WorkbenchFileTypeIcon'
import { WorkbenchDiffLayoutToggle } from '../git/WorkbenchDiffLayoutToggle'
import { WorkbenchGitReloadLink } from '../git/WorkbenchGitReloadLink'
import type { WorkbenchUnifiedDiffRowsHandle } from '../git/WorkbenchUnifiedDiffRows'
import { WorkbenchUnifiedDiffRows } from '../git/WorkbenchUnifiedDiffRows'

import { HistoryTimeline } from './HistoryTimeline'
import { ReadOnlyWorkbenchCode } from './ReadOnlyWorkbenchCode'

export type FileHistoryMode = WorkbenchFileHistoryMode

function fileNameFromPath(path: string): string {
  return path.split('/').findLast(Boolean) ?? path
}

export function FileHistoryView({
  projectRoot,
  path,
  workbenchTheme,
  initialMode,
  currentContent,
  onRestore,
  restoreDisabledReason,
}: {
  projectRoot: string
  path: string
  workbenchTheme: WorkbenchThemeId
  initialMode: FileHistoryMode
  currentContent: string
  onRestore: (content: string) => void | Promise<void>
  restoreDisabledReason?: string
}): ReactElement {
  const { t, locale } = useWorkbenchI18n()
  const [mode, setMode] = useState<FileHistoryMode>(initialMode)
  const [view, setView] = useState<'content' | 'diff'>('content')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<Nullable<string>>(null)
  const [isRestoring, setIsRestoring] = useState(false)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const diffViewRef = useRef<WorkbenchUnifiedDiffRowsHandle>(null)
  const source = useWorkbenchFileHistory({
    mode,
    projectRoot,
    path,
    locale,
    enabled: true,
  })
  const selected = useWorkbenchHistoryRecordContent({
    loadContent: source.loadContent,
    selectedId,
  })
  const trimmedQuery = query.trim()
  const searchActive = !isEmpty(trimmedQuery)
  const searchIndex = useWorkbenchHistorySearchIndex({
    records: source.records,
    loadContent: source.loadContent,
    active: searchActive,
  })
  const filteredRecords = useMemo(() => {
    if (!searchActive) return source.records
    const needle = trimmedQuery.toLowerCase()
    return source.records.filter((record) =>
      (searchIndex.contents.get(record.id) ?? '').toLowerCase().includes(needle)
    )
  }, [searchActive, searchIndex.contents, source.records, trimmedQuery])

  // 改名、挪位置之前的提交：作者后面写上文件当时的路径（太长被截断时悬停看全）。
  const timelineItems = useMemo(
    () =>
      filteredRecords.map((record) => {
        if (!record.formerPath) return record
        const formerPath = t('workbench.fileHistoryFormerPath', { path: record.formerPath })
        return {
          ...record,
          subtitle: record.subtitle ? `${record.subtitle} · ${formerPath}` : formerPath,
          tooltip: formerPath,
        }
      }),
    [filteredRecords, t]
  )

  useEffect(() => {
    if (searchActive && searchIndex.isIndexing) return
    if (selectedId && filteredRecords.some((record) => record.id === selectedId)) return
    setSelectedId(toNullable(filteredRecords[0]?.id))
  }, [filteredRecords, searchActive, searchIndex.isIndexing, selectedId])

  const diffRows = useMemo(
    () =>
      view === 'diff' && isNotNull(selected.content)
        ? buildWorkbenchContentDiffRows(path, selected.content, currentContent, { fullFile: true })
        : [],
    [currentContent, path, selected.content, view]
  )
  const changeCount = useMemo(() => {
    let count = 0
    for (let index = 0; index < diffRows.length; index += 1) {
      const row = diffRows[index]
      const previous = diffRows[index - 1]
      const changed = row.kind === 'addition' || row.kind === 'deletion'
      const previousChanged = previous?.kind === 'addition' || previous?.kind === 'deletion'
      if (changed && !previousChanged) count += 1
    }
    return count
  }, [diffRows])
  const selectedRecord = source.records.find((record) => record.id === selectedId)
  const canRestore =
    isNotNull(selected.content) && !selected.isLoading && !isRestoring && !restoreDisabledReason
  const showIndexing = searchActive && searchIndex.isIndexing
  const emptyMessage = searchActive
    ? t('workbench.fileHistorySearchNoMatch')
    : mode === 'local'
      ? t('workbench.localHistoryEmpty')
      : t('workbench.gitLogEmpty')
  const loadingMessage = showIndexing
    ? t('workbench.fileHistorySearching')
    : mode === 'local'
      ? t('workbench.localHistoryLoading')
      : t('workbench.gitLogLoading')

  return (
    <div className={styles.fileHistoryRoot}>
      <header className={styles.fileHistoryHeader}>
        <div className={styles.fileHistoryIdentity}>
          <WorkbenchFileTypeIcon fileName={path} size={18} />
          <div className={styles.fileHistoryFile}>
            <Text truncate className={styles.fileHistoryFileName}>
              {fileNameFromPath(path)}
            </Text>
            <Text truncate className={styles.fileHistoryFilePath}>
              {path}
            </Text>
          </div>
        </div>
        <SegmentedControl
          variant="subtle"
          ariaLabel={t('workbench.fileHistoryTitle', { file: fileNameFromPath(path) })}
          value={mode}
          options={[
            { value: 'local', label: t('workbench.editorContextLocalHistory') },
            { value: 'git', label: t('workbench.editorContextGitHistory') },
          ]}
          onChange={setMode}
        />
      </header>
      <div className={styles.fileHistoryBody}>
        <aside
          className={styles.fileHistorySidebar}
          aria-label={t('workbench.fileHistoryVersions')}
        >
          <div className={styles.fileHistoryListHeading}>
            <Text>{t('workbench.fileHistoryVersions')}</Text>
            <span className={styles.fileHistoryRecordCount}>{filteredRecords.length}</span>
          </div>
          <div className={styles.editorHistorySearch}>
            <SearchField
              size="sm"
              value={query}
              placeholder={t('workbench.fileHistorySearchPlaceholder')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <ScrollArea className={styles.editorGitHistoryList}>
            {source.isLoadingList || showIndexing ? (
              <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
                {loadingMessage}
              </Paragraph>
            ) : source.listError ? (
              <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
                {source.listError}
                {source.isGitMissing && <WorkbenchGitReloadLink />}
              </Paragraph>
            ) : isEmpty(filteredRecords) ? (
              <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
                {emptyMessage}
              </Paragraph>
            ) : (
              <HistoryTimeline
                items={timelineItems}
                selectedId={selectedId}
                onSelect={setSelectedId}
              />
            )}
          </ScrollArea>
        </aside>
        <section
          className={styles.editorHistoryRight}
          aria-label={t('workbench.fileHistoryViewContent')}
        >
          <div className={styles.fileHistoryPreviewHeader}>
            <Text truncate className={styles.fileHistorySelectedVersion}>
              {selectedRecord?.title ?? ''}
            </Text>
            <SegmentedControl
              variant="subtle"
              ariaLabel={t('workbench.fileHistoryViewContent')}
              value={view}
              options={[
                { value: 'content', label: t('workbench.fileHistoryViewContent') },
                { value: 'diff', label: t('workbench.fileHistoryViewDiff') },
              ]}
              onChange={setView}
            />
            <Button
              size="sm"
              variant="secondary"
              className={styles.fileHistoryRestoreButton}
              disabled={!canRestore}
              onClick={() => {
                if (!isNotNull(selected.content) || !canRestore) return
                setIsRestoring(true)
                setRestoreError(null)
                void Promise.resolve()
                  .then(() => onRestore(selected.content!))
                  .catch((error: unknown) => {
                    setRestoreError(AppError.getMessage(error))
                  })
                  .finally(() => setIsRestoring(false))
              }}
            >
              <ClockCounterClockwiseIcon size={14} />
              {isRestoring
                ? t('workbench.fileHistoryRestoring')
                : t('workbench.localHistoryRestore')}
            </Button>
          </div>
          {(restoreError || restoreDisabledReason) && (
            <p className={styles.fileHistoryNotice} role={restoreError ? 'alert' : 'status'}>
              {restoreError ?? restoreDisabledReason}
            </p>
          )}
          {renderRight()}
        </section>
      </div>
    </div>
  )

  function renderRight(): ReactElement {
    if (!selectedId)
      return (
        <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
          {mode === 'local' ? t('workbench.localHistoryEmpty') : t('workbench.gitCommitSelect')}
        </Paragraph>
      )
    if (selected.isLoading)
      return (
        <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
          {mode === 'local' ? t('workbench.localHistoryLoading') : t('workbench.gitDiffLoading')}
        </Paragraph>
      )
    if (selected.error)
      return (
        <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
          {selected.error}
        </Paragraph>
      )
    if (view === 'diff') {
      if (isEmpty(diffRows))
        return (
          <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
            {t('workbench.fileHistoryNoDiff')}
          </Paragraph>
        )
      return (
        <div className={styles.editorHistoryDiffPane}>
          <div className={styles.editorHistoryDiffToolbar}>
            <Text truncate className={styles.editorHistoryDiffLabel}>
              {selectedRecord?.title ?? ''}
            </Text>
            <span className={styles.editorHistoryDiffArrow} aria-hidden>
              →
            </span>
            <Text truncate className={styles.editorHistoryDiffLabel}>
              {t('workbench.fileHistoryDiffCurrent')}
            </Text>
            <span className={styles.editorHistoryDiffSpacer} />
            <span className={styles.editorHistoryDiffCount}>
              {t('workbench.fileHistoryDiffCount', { count: changeCount })}
            </span>
            <WorkbenchDiffLayoutToggle />
            <IconButton
              variant="ghost"
              size="icon-sm"
              disabled={!changeCount}
              label={t('workbench.fileHistoryDiffPrev')}
              title={t('workbench.fileHistoryDiffPrev')}
              onClick={() => diffViewRef.current?.goToChange(-1)}
            >
              <CaretUpIcon size={14} />
            </IconButton>
            <IconButton
              variant="ghost"
              size="icon-sm"
              disabled={!changeCount}
              label={t('workbench.fileHistoryDiffNext')}
              title={t('workbench.fileHistoryDiffNext')}
              onClick={() => diffViewRef.current?.goToChange(1)}
            >
              <CaretDownIcon size={14} />
            </IconButton>
          </div>
          <WorkbenchUnifiedDiffRows
            ref={diffViewRef}
            rows={diffRows}
            path={path}
            workbenchTheme={workbenchTheme}
          />
        </div>
      )
    }
    return (
      <ReadOnlyWorkbenchCode
        content={selected.content ?? ''}
        path={path}
        workbenchTheme={workbenchTheme}
        highlightQuery={searchActive ? trimmedQuery : ''}
      />
    )
  }
}
