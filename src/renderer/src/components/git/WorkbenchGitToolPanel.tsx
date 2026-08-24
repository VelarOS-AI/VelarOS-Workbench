import { type ReactElement, useEffect, useMemo, useState } from 'react'
import { GitBranchIcon } from '@phosphor-icons/react'
import { workbenchHost } from '@renderer/host'
import { useWorkbenchI18n } from '@renderer/i18n'
import {
  filterWorkbenchGitLogCommits,
  formatWorkbenchGitCommitDate,
} from '@renderer/models/git/changesPanel.model'

import { AppError } from '@velaros-ai/core'
import { Result } from '@velaros-ai/core/result'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'
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
  const [logSearch, setLogSearch] = useState('')
  const [commits, setCommits] = useState<WorkspaceGitLogEntry[]>([])
  const [selectedCommitSha, setSelectedCommitSha] = useState<Nullable<string>>(null)
  const [commitDiff, setCommitDiff] = useState('')
  const [logLoading, setLogLoading] = useState(false)
  const [logError, setLogError] = useState<Nullable<string>>(null)

  const branches = useMemo(
    () => summary?.branches.filter((branch) => branch.kind !== 'remote') ?? [],
    [summary?.branches]
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
        subtitle: commit.authorName,
        meta: formatWorkbenchGitCommitDate(locale, commit),
        timestamp: commit.authoredAt,
        special: commit.refs.some((ref) => ref.includes('HEAD')),
        badges: commit.refs.slice(0, 2),
      })),
    [filteredCommits, locale]
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
              <div className={styles.gitBranchList}>
                <p className={styles.gitPaneSectionTitle}>{t('workbench.gitBranches')}</p>
                {branches.map((branch) => (
                  <button
                    key={branch.name}
                    type="button"
                    className={styles.gitBranchRow}
                    data-active={logBranch === branch.name}
                    onClick={() => setLogBranch(branch.name)}
                  >
                    <GitBranchIcon size={13} />
                    <span className={styles.gitBranchName}>{branch.name}</span>
                    {branch.current && (
                      <span className={styles.gitBranchMark}>{t('workbench.gitBranchCurrent')}</span>
                    )}
                  </button>
                ))}
              </div>
            </aside>
            <section className={styles.gitLogListPane}>
              <div className={styles.gitLogSearchBar}>
                <Input
                  size="sm"
                  variant="ghost"
                  value={logSearch}
                  placeholder={t('workbench.gitLogSearchPlaceholder')}
                  onChange={(event) => setLogSearch(event.target.value)}
                />
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
                  <h5 className={styles.gitCommitDetailTitle}>{selectedCommit.subject}</h5>
                  <dl>
                    <div>
                      <dt>{t('workbench.gitCommitSha')}</dt>
                      <dd>{selectedCommit.shortSha}</dd>
                    </div>
                    <div>
                      <dt>{t('workbench.gitCommitAuthor')}</dt>
                      <dd>{selectedCommit.authorName}</dd>
                    </div>
                    <div>
                      <dt>{t('workbench.gitCommitDate')}</dt>
                      <dd>{formatWorkbenchGitCommitDate(locale, selectedCommit)}</dd>
                    </div>
                  </dl>
                  <section className={styles.gitCommitDiffPreview}>
                    <p className={styles.gitPaneSectionTitle}>{t('workbench.gitDiffPreview')}</p>
                    <pre className={styles.gitToolCommitDiff}>
                      {commitDiff || t('workbench.gitDiffEmpty')}
                    </pre>
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

async function runBackground(action: () => Promise<void>): Promise<void> {
  await action()
}
