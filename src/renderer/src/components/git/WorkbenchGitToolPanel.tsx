import { type ReactElement, useEffect, useMemo, useState } from 'react'
import { GitBranchIcon, SpinnerGapIcon } from '@phosphor-icons/react'
import { useWorkbenchGitStashes } from '@renderer/hooks/useWorkbenchGitStashes'
import { workbenchHost } from '@renderer/host'
import {
  filterWorkbenchGitLogCommits,
  formatWorkbenchGitCommitRelativeDate,
  isSameWorkbenchGitLog,
} from '@renderer/models/git/changesPanel.model'
import { getWorkbenchGitStashTitle } from '@renderer/models/git/workbenchGitStashModel'
import { useStableWorkbenchMessageTranslate } from '@renderer/runtime/useStableWorkbenchMessaging'

import { AppError } from '@velaros-ai/core'
import { Result } from '@velaros-ai/core/result'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { SearchField } from '@velaros-ai/ui/primitives/forms/SearchField'
import { ScrollArea } from '@velaros-ai/ui/primitives/layout/ScrollArea'

import type {
  SystemWorkspaceGitSummary,
  WorkspaceGitLogEntry,
  WorkspaceGitStash,
  WorkspaceGitStashAction,
} from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'
import { HistoryTimeline, type HistoryTimelineItem } from '../editor/HistoryTimeline'

import {
  WorkbenchGitDetailsPane,
  type WorkbenchGitDetailsTarget,
} from './WorkbenchGitDetailsPane'
import { WorkbenchGitRefsPane } from './WorkbenchGitRefsPane'

interface WorkbenchGitToolPanelProps {
  workspaceRoot: string
  summary: Nullable<SystemWorkspaceGitSummary>
  isLoading: boolean
  error: Nullable<string>
  /** 编辑器里有没保存的内容：取回贮藏会改写磁盘上的文件，先提醒保存。 */
  hasUnsavedOpenTabs: boolean
  onInitialize: () => Promise<void>
  /** 动过工作区之后（取回贮藏）刷新文件树与 Git 状态。 */
  onRefresh: () => Promise<void>
  /** 取回贮藏出了冲突：打开提交面板，冲突文件列在「合并冲突」里。 */
  onOpenCommitTool: () => void
}

/** 读到的提交日志属于哪个项目、哪个分支；换了才显示「读取中」，同一份刷新时原地更新。 */
interface WorkbenchGitLogState {
  key: string
  commits: WorkspaceGitLogEntry[]
  error: Nullable<string>
}

/** 冲突提示挂得久一点：要照着它去解决。 */
const ConflictNoticeDurationMs = 12_000

const StashActions = ['apply', 'pop', 'drop'] as const satisfies readonly WorkspaceGitStashAction[]

const StashActionLabelKeys: Record<WorkspaceGitStashAction, string> = {
  apply: 'workbench.gitStashApply',
  pop: 'workbench.gitStashPop',
  drop: 'workbench.gitStashDrop',
}

const StashActionHintKeys: Record<WorkspaceGitStashAction, string> = {
  apply: 'workbench.gitStashApplyHint',
  pop: 'workbench.gitStashPopHint',
  drop: 'workbench.gitStashDropHint',
}

const StashActionSuccessTitleKeys: Record<WorkspaceGitStashAction, string> = {
  apply: 'workbench.gitStashApplySuccessTitle',
  pop: 'workbench.gitStashPopSuccessTitle',
  drop: 'workbench.gitStashDropSuccessTitle',
}

/**
 * 拆分前 Workbench 底部 Git 工具：查看分支与提交历史，不承担提交操作。贮藏也列在这里（左侧分支下面）：
 * 点一条看它里面的改动，应用、弹出或删除。
 */
export function WorkbenchGitToolPanel({
  workspaceRoot,
  summary,
  isLoading,
  error,
  hasUnsavedOpenTabs,
  onInitialize,
  onRefresh,
  onOpenCommitTool,
}: WorkbenchGitToolPanelProps): ReactElement {
  const { locale, t, messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  const [logBranch, setLogBranch] = useState('')
  const [logSearch, setLogSearch] = useState('')
  const [logState, setLogState] = useState<Nullable<WorkbenchGitLogState>>(null)
  const [selectedCommitSha, setSelectedCommitSha] = useState<Nullable<string>>(null)
  /** 选中的贮藏：选着它时右侧看的是它，不是日志里选中的提交。 */
  const [selectedStashSha, setSelectedStashSha] = useState<Nullable<string>>(null)
  const [pendingStashAction, setPendingStashAction] =
    useState<Nullable<WorkspaceGitStashAction>>(null)
  const isRepository = !!summary?.repository
  const stashList = useWorkbenchGitStashes({
    workspaceRoot,
    enabled: isRepository,
    revision: summary?.checkedAt ?? null,
  })

  const logKey = `${workspaceRoot}\0${logBranch}`
  const currentLog = logState?.key === logKey ? logState : null
  const commits = useMemo(() => currentLog?.commits ?? [], [currentLog])
  const logLoading = !currentLog
  // 刷新失败时已经列着的提交照旧显示，只有什么都没读到时才显示错误。
  const logError = currentLog && !currentLog.commits.length ? currentLog.error : null

  const branches = summary?.branches ?? []
  const filteredCommits = useMemo(
    () => filterWorkbenchGitLogCommits(commits, logSearch),
    [commits, logSearch]
  )
  const selectedStash = useMemo(
    () => stashList.stashes.find((stash) => stash.sha === selectedStashSha) ?? null,
    [selectedStashSha, stashList.stashes]
  )
  const detailsTarget = useMemo<Nullable<WorkbenchGitDetailsTarget>>(() => {
    if (selectedStash) return { kind: 'stash', stash: selectedStash }
    const commit = commits.find((candidate) => candidate.sha === selectedCommitSha)
    return commit ? { kind: 'commit', commit } : null
  }, [commits, selectedCommitSha, selectedStash])
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

  useEffect(() => {
    if (!summary?.repository) {
      setLogBranch('')
      return
    }
    setLogBranch((current) => current || summary.status?.branch || '')
  }, [summary?.repository, summary?.status?.branch])

  // 工作区一有改动 summary 就刷新一次：日志跟着重读，但原地更新——不闪「读取中」，列表不卸载，
  // 滚动位置和选中的提交都留着。只有换了项目或分支才从「读取中」开始。
  useEffect(() => {
    if (!summary?.repository) {
      setLogState(null)
      setSelectedCommitSha(null)
      return
    }
    let active = true
    const key = `${workspaceRoot}\0${logBranch}`
    void runBackground(async () => {
      const result = Result.unwrap(
        await workbenchHost.kernel.workspace.getWorkspaceGitLog(workspaceRoot, {
          branch: logBranch || undefined,
          limit: 80,
        })
      )
      if (!active) return
      setLogState((current) =>
        current?.key === key && !current.error && isSameWorkbenchGitLog(current.commits, result.commits)
          ? current
          : { key, commits: result.commits, error: null }
      )
      setSelectedCommitSha((current) =>
        current && result.commits.some((commit) => commit.sha === current)
          ? current
          : (result.commits[0]?.sha ?? null)
      )
    }).catch((loadError) => {
      if (!active) return
      const message = AppError.getMessage(loadError)
      setLogState((current) => ({
        key,
        commits: current?.key === key ? current.commits : [],
        error: message,
      }))
    })
    return () => {
      active = false
    }
  }, [logBranch, summary?.checkedAt, summary?.repository, workspaceRoot])

  /**
   * 应用、弹出会改写工作区里的文件（编辑器里有没保存的内容时先提醒保存）；删除之后里面的改动取不回来，
   * 先问。取回时冲突了不算失败：冲突文件交给提交面板的「合并冲突」，贮藏留着。
   */
  async function runStashAction(
    stash: WorkspaceGitStash,
    action: WorkspaceGitStashAction
  ): Promise<void> {
    if (pendingStashAction) return
    if (action !== 'drop' && hasUnsavedOpenTabs) {
      messageLatest.current.warning({
        title: tLatest.current('workbench.gitUnsavedBlockedTitle'),
        description: tLatest.current('workbench.gitUnsavedBlockedDescription'),
      })
      return
    }
    const name = getWorkbenchGitStashTitle(stash, tLatest.current)
    if (
      action === 'drop' &&
      !window.confirm(
        tLatest.current(
          stash.includesUntracked
            ? 'workbench.gitStashDropUntrackedConfirm'
            : 'workbench.gitStashDropConfirm',
          { name }
        )
      )
    )
      return

    try {
      setPendingStashAction(action)
      const result = Result.unwrap(
        await workbenchHost.kernel.workspace.performWorkspaceGitStashAction(
          workspaceRoot,
          stash.sha,
          action
        )
      )
      stashList.replace(result.stashes)
      await onRefresh()
      if (result.stashAction.conflicts.length > 0) {
        messageLatest.current.warning({
          title: tLatest.current('workbench.gitStashConflictsTitle'),
          description: tLatest.current('workbench.gitStashConflictsDescription', {
            count: result.stashAction.conflicts.length,
          }),
          duration: ConflictNoticeDurationMs,
        })
        onOpenCommitTool()
        return
      }
      messageLatest.current.success({
        title: tLatest.current(StashActionSuccessTitleKeys[action]),
        description: name,
      })
    } catch (actionError) {
      const appError = AppError.from(actionError)
      messageLatest.current.open({
        title: tLatest.current('workbench.gitStashActionFailedTitle'),
        description:
          appError.message.trim() || tLatest.current('workbench.gitStashFailedFallback'),
        tone: appError.code === 'VALIDATION' ? 'warning' : 'error',
        showClose: true,
      })
      await onRefresh()
    } finally {
      setPendingStashAction(null)
    }
  }

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
            <WorkbenchGitRefsPane
              branches={branches}
              logBranch={logBranch}
              onSelectBranch={setLogBranch}
              stashes={stashList.stashes}
              stashesError={stashList.error}
              selectedStashSha={selectedStash?.sha ?? null}
              onSelectStash={(stash) => setSelectedStashSha(stash.sha)}
            />
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
                    selectedId={selectedStash ? null : selectedCommitSha}
                    onSelect={(sha) => {
                      setSelectedStashSha(null)
                      setSelectedCommitSha(sha)
                    }}
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
              <WorkbenchGitDetailsPane
                workspaceRoot={workspaceRoot}
                target={detailsTarget}
                actions={
                  selectedStash && (
                    <div className={styles.gitDetailActions}>
                      {StashActions.map((action) => (
                        <Button
                          key={action}
                          size="sm"
                          variant={action === 'drop' ? 'destructiveOutline' : 'outline'}
                          disabled={
                            !!pendingStashAction || (action !== 'drop' && hasUnsavedOpenTabs)
                          }
                          title={t(StashActionHintKeys[action])}
                          onClick={() => void runStashAction(selectedStash, action)}
                        >
                          {pendingStashAction === action && (
                            <SpinnerGapIcon size={12} className={styles.spinIcon} />
                          )}
                          {t(StashActionLabelKeys[action])}
                        </Button>
                      ))}
                    </div>
                  )
                }
              />
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
