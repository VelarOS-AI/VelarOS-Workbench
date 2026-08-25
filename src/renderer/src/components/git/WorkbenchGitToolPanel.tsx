import { type ReactElement, useEffect, useMemo, useState } from 'react'
import {
  CalendarBlankIcon,
  FileCodeIcon,
  FilesIcon,
  GitBranchIcon,
  HashStraightIcon,
  UserCircleIcon,
} from '@phosphor-icons/react'
import { workbenchHost } from '@renderer/host'
import { useWorkbenchI18n } from '@renderer/i18n'
import {
  filterWorkbenchGitLogCommits,
  formatWorkbenchGitCommitDate,
  formatWorkbenchGitCommitRelativeDate,
  parseWorkbenchGitCommitDiff,
} from '@renderer/models/git/changesPanel.model'

import { AppError } from '@velaros-ai/core'
import { Result } from '@velaros-ai/core/result'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { SearchField } from '@velaros-ai/ui/primitives/forms/SearchField'
import { ScrollArea } from '@velaros-ai/ui/primitives/layout/ScrollArea'

import type { SystemWorkspaceGitSummary, WorkspaceGitLogEntry } from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'
import { HistoryTimeline, type HistoryTimelineItem } from '../editor/HistoryTimeline'

interface WorkbenchGitToolPanelProps {
  workspaceRoot: string
  summary: Nullable<SystemWorkspaceGitSummary>
  isLoading: boolean
  error: Nullable<string>
  onInitialize: () => Promise<void>
}

/** 拆分前 Workbench 底部 Git 工具：查看分支与提交历史，不承担提交操作。 */
export function WorkbenchGitToolPanel({
  workspaceRoot,
  summary,
  isLoading,
  error,
  onInitialize,
}: WorkbenchGitToolPanelProps): ReactElement {
  const { locale, t } = useWorkbenchI18n()
  const [logBranch, setLogBranch] = useState('')
  const [branchSearch, setBranchSearch] = useState('')
  const [logSearch, setLogSearch] = useState('')
  const [commits, setCommits] = useState<WorkspaceGitLogEntry[]>([])
  const [selectedCommitSha, setSelectedCommitSha] = useState<Nullable<string>>(null)
  const [commitDiff, setCommitDiff] = useState('')
  const [selectedDiffPath, setSelectedDiffPath] = useState<Nullable<string>>(null)
  const [logLoading, setLogLoading] = useState(false)
  const [logError, setLogError] = useState<Nullable<string>>(null)

  const branches = summary?.branches ?? []
  const branchQuery = branchSearch.trim().toLocaleLowerCase(locale)
  const localBranches = branches.filter(
    (branch) =>
      branch.kind !== 'remote'
      && (!branchQuery || branch.name.toLocaleLowerCase(locale).includes(branchQuery))
  )
  const remoteBranches = branches.filter(
    (branch) =>
      branch.kind === 'remote'
      && (!branchQuery || branch.name.toLocaleLowerCase(locale).includes(branchQuery))
  )
  const filteredCommits = useMemo(
    () => filterWorkbenchGitLogCommits(commits, logSearch),
    [commits, logSearch]
  )
  const selectedCommit = useMemo(
    () => commits.find((commit) => commit.sha === selectedCommitSha) ?? null,
    [commits, selectedCommitSha]
  )
  const timelineItems = useMemo<HistoryTimelineItem[]>(
    () =>
      filteredCommits.map((commit) => ({
        id: commit.sha,
        title: commit.subject,
        subtitle: `${commit.authorName} · ${commit.shortSha}`,
        meta: formatWorkbenchGitCommitRelativeDate(locale, commit),
        timestamp: commit.authoredAt,
        special: commit.refs.some((ref) => ref.includes('HEAD')),
        badges: commit.refs.slice(0, 2),
      })),
    [filteredCommits, locale]
  )
  const diffFiles = useMemo(() => parseWorkbenchGitCommitDiff(commitDiff), [commitDiff])
  const selectedDiffFile = useMemo(
    () => diffFiles.find((file) => file.path === selectedDiffPath) ?? diffFiles[0] ?? null,
    [diffFiles, selectedDiffPath]
  )
  const diffStats = useMemo(
    () =>
      diffFiles.reduce(
        (stats, file) => ({
          additions: stats.additions + file.additions,
          deletions: stats.deletions + file.deletions,
        }),
        { additions: 0, deletions: 0 }
      ),
    [diffFiles]
  )

  useEffect(() => {
    if (!summary?.repository) {
      setLogBranch('')
      return
    }
    setLogBranch((current) => current || summary.status?.branch || '')
  }, [summary?.repository, summary?.status?.branch])

  useEffect(() => {
    if (!summary?.repository) {
      setCommits([])
      setSelectedCommitSha(null)
      setCommitDiff('')
      return
    }
    let active = true
    setLogLoading(true)
    setLogError(null)
    void runBackground(async () => {
      const result = Result.unwrap(
        await workbenchHost.kernel.workspace.getWorkspaceGitLog(workspaceRoot, {
          branch: logBranch || undefined,
          limit: 80,
        })
      )
      if (!active) return
      setCommits(result.commits)
      setSelectedCommitSha((current) =>
        current && result.commits.some((commit) => commit.sha === current)
          ? current
          : (result.commits[0]?.sha ?? null)
      )
    }).catch((loadError) => {
      if (active) setLogError(AppError.getMessage(loadError))
    }).finally(() => {
      if (active) setLogLoading(false)
    })
    return () => {
      active = false
    }
  }, [logBranch, summary?.checkedAt, summary?.repository, workspaceRoot])

  useEffect(() => {
    if (!selectedCommitSha) {
      setCommitDiff('')
      return
    }
    let active = true
    void runBackground(async () => {
      const result = Result.unwrap(
        await workbenchHost.kernel.workspace.getWorkspaceGitDiff(workspaceRoot, {
          commitSha: selectedCommitSha,
          maxChars: 120_000,
        })
      )
      if (active) setCommitDiff(result.diff)
    }).catch(() => {
      if (active) setCommitDiff('')
    })
    return () => {
      active = false
    }
  }, [selectedCommitSha, workspaceRoot])

  useEffect(() => {
    setSelectedDiffPath((current) =>
      current && diffFiles.some((file) => file.path === current)
        ? current
        : (diffFiles[0]?.path ?? null)
    )
  }, [diffFiles])

  if (!summary?.repository)
    return (
      <section className={styles.gitToolEmpty}>
        <span>{isLoading ? t('workbench.gitLoading') : error || t('workbench.gitNoRepository')}</span>
        <Button size="sm" onClick={() => void onInitialize()}>
          {t('workbench.gitInitializeRepository')}
        </Button>
      </section>
    )

  return (
    <section className={styles.toolWindowPanel}>
      <div className={styles.gitIdeShell}>
        <div className={styles.gitIdeContent}>
          <div className={styles.gitLogView}>
            <aside className={styles.gitLogBranchPane}>
              <div className={styles.gitBranchPaneHeader}>
                <p className={styles.gitPaneSectionTitle}>{t('workbench.gitBranches')}</p>
                <span>{branches.length}</span>
              </div>
              <div className={styles.gitBranchSearch}>
                <SearchField
                  size="sm"
                  value={branchSearch}
                  placeholder={t('workbench.gitBranchSearchPlaceholder')}
                  onChange={(event) => setBranchSearch(event.target.value)}
                />
              </div>
              <ScrollArea className={styles.gitBranchScroll}>
                <div className={styles.gitBranchList}>
                  <BranchGroup
                    label={t('workbench.gitBranchLocal')}
                    branches={localBranches}
                    logBranch={logBranch}
                    onSelect={setLogBranch}
                    currentLabel={t('workbench.gitBranchCurrent')}
                  />
                  {!!remoteBranches.length && (
                    <BranchGroup
                      label={t('workbench.gitBranchRemoteGroup')}
                      branches={remoteBranches}
                      logBranch={logBranch}
                      onSelect={setLogBranch}
                      currentLabel={t('workbench.gitBranchCurrent')}
                    />
                  )}
                </div>
              </ScrollArea>
            </aside>
            <section className={styles.gitLogListPane}>
              <div className={styles.gitLogSearchBar}>
                <div className={styles.gitLogSearchField}>
                  <SearchField
                    size="sm"
                    value={logSearch}
                    placeholder={t('workbench.gitLogSearchPlaceholder')}
                    onChange={(event) => setLogSearch(event.target.value)}
                  />
                </div>
                <span className={styles.gitLogScope}>
                  <GitBranchIcon size={12} />
                  {logBranch || summary.status?.branch || '-'}
                </span>
                <span className={styles.gitLogCount}>
                  {t('workbench.gitLogResultCount', { count: filteredCommits.length })}
                </span>
              </div>
              <ScrollArea className={styles.gitLogScroll}>
                {logLoading ? (
                  <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
                    {t('workbench.gitLogLoading')}
                  </Paragraph>
                ) : logError ? (
                  <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
                    {logError}
                  </Paragraph>
                ) : timelineItems.length ? (
                  <HistoryTimeline
                    items={timelineItems}
                    selectedId={selectedCommitSha}
                    onSelect={setSelectedCommitSha}
                    palette={{
                      today: 'var(--workbench-theme-color)',
                      week: 'var(--workbench-theme-color)',
                      month: 'var(--workbench-theme-color)',
                      older: 'var(--workbench-theme-color)',
                    }}
                  />
                ) : (
                  <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
                    {t('workbench.gitLogEmpty')}
                  </Paragraph>
                )}
              </ScrollArea>
            </section>
            <aside className={styles.gitCommitDetailPane}>
              {selectedCommit ? (
                <div className={styles.gitCommitDetail}>
                  <header className={styles.gitCommitHeader}>
                    <h5 className={styles.gitCommitDetailTitle}>{selectedCommit.subject}</h5>
                    {!!selectedCommit.refs.length && (
                      <div className={styles.gitCommitRefs}>
                        {selectedCommit.refs.map((ref) => <span key={ref}>{ref}</span>)}
                      </div>
                    )}
                  </header>
                  <dl className={styles.gitCommitMetaGrid}>
                    <div>
                      <span className={styles.gitCommitMetaLabel}>
                        <HashStraightIcon size={14} />
                        <dt>{t('workbench.gitCommitSha')}</dt>
                      </span>
                      <dd>{selectedCommit.shortSha}</dd>
                    </div>
                    <div>
                      <span className={styles.gitCommitMetaLabel}>
                        <UserCircleIcon size={14} />
                        <dt>{t('workbench.gitCommitAuthor')}</dt>
                      </span>
                      <dd>{selectedCommit.authorName}</dd>
                    </div>
                    <div>
                      <span className={styles.gitCommitMetaLabel}>
                        <CalendarBlankIcon size={14} />
                        <dt>{t('workbench.gitCommitDate')}</dt>
                      </span>
                      <dd>{formatWorkbenchGitCommitDate(locale, selectedCommit)}</dd>
                    </div>
                  </dl>
                  <section className={styles.gitCommitChanges}>
                    <header className={styles.gitCommitChangesHeader}>
                      <span>
                        <FilesIcon size={14} />
                        {t('workbench.gitChangedFiles', { count: diffFiles.length })}
                      </span>
                      <span className={styles.gitCommitStats}>
                        <strong>+{diffStats.additions}</strong>
                        <em>-{diffStats.deletions}</em>
                      </span>
                    </header>
                    {!!diffFiles.length && (
                      <div className={styles.gitCommitFileList}>
                        {diffFiles.map((file) => (
                          <button
                            key={file.path}
                            type="button"
                            data-active={selectedDiffFile?.path === file.path}
                            onClick={() => setSelectedDiffPath(file.path)}
                          >
                            <FileCodeIcon size={13} />
                            <span>{file.path}</span>
                            <small>
                              <strong>+{file.additions}</strong>
                              <em>-{file.deletions}</em>
                            </small>
                          </button>
                        ))}
                      </div>
                    )}
                    <div className={styles.gitCommitPatch}>
                      <p className={styles.gitPaneSectionTitle}>
                        {selectedDiffFile?.path || t('workbench.gitDiffPreview')}
                      </p>
                      {selectedDiffFile ? (
                        <pre className={styles.gitToolCommitDiff}>
                          {selectedDiffFile.lines.slice(0, 320).map((line, index) => (
                            <span
                              key={`${index}-${line.text}`}
                              className={styles.gitCommitPatchLine}
                              data-kind={line.kind}
                            >
                              {line.text || ' '}
                            </span>
                          ))}
                        </pre>
                      ) : (
                        <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
                          {t('workbench.gitDiffEmpty')}
                        </Paragraph>
                      )}
                    </div>
                  </section>
                </div>
              ) : (
                <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
                  {t('workbench.gitCommitSelect')}
                </Paragraph>
              )}
            </aside>
          </div>
        </div>
      </div>
    </section>
  )
}

interface BranchGroupProps {
  label: string
  branches: SystemWorkspaceGitSummary['branches']
  logBranch: string
  currentLabel: string
  onSelect: (branch: string) => void
}

function BranchGroup({
  label,
  branches,
  logBranch,
  currentLabel,
  onSelect,
}: BranchGroupProps): ReactElement {
  return (
    <section className={styles.gitBranchGroup}>
      <p>{label}</p>
      {branches.map((branch) => (
        <button
          key={branch.name}
          type="button"
          className={styles.gitBranchRow}
          data-active={logBranch === branch.name}
          onClick={() => onSelect(branch.name)}
        >
          <GitBranchIcon size={13} />
          <span className={styles.gitBranchName}>{branch.name}</span>
          {branch.current && <span className={styles.gitBranchMark}>{currentLabel}</span>}
        </button>
      ))}
    </section>
  )
}

async function runBackground(action: () => Promise<void>): Promise<void> {
  await action()
}
