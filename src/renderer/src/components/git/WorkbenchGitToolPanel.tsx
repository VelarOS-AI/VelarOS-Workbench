import { type ReactElement, useEffect, useMemo, useState } from 'react'
import { GitBranchIcon, GitForkIcon, SpinnerGapIcon } from '@phosphor-icons/react'
import { useWorkbenchGitLog } from '@renderer/hooks/useWorkbenchGitLog'
import { useWorkbenchGitStashes } from '@renderer/hooks/useWorkbenchGitStashes'
import { workbenchHost } from '@renderer/host'
import { filterWorkbenchGitLogCommits } from '@renderer/models/git/changesPanel.model'
import {
  layoutWorkbenchGitGraph,
  measureWorkbenchGitGraphLanes,
} from '@renderer/models/git/workbenchGitGraph'
import { getWorkbenchGitStashTitle } from '@renderer/models/git/workbenchGitStashModel'
import { useStableWorkbenchMessageTranslate } from '@renderer/runtime/useStableWorkbenchMessaging'

import { AppError } from '@velaros-ai/core'
import { Result } from '@velaros-ai/core/result'
import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'
import { SearchField } from '@velaros-ai/ui/primitives/forms/SearchField'

import type {
  SystemWorkspaceGitSummary,
  WorkspaceGitStash,
  WorkspaceGitStashAction,
} from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'

import {
  WorkbenchGitDetailsPane,
  type WorkbenchGitDetailsTarget,
} from './WorkbenchGitDetailsPane'
import { WorkbenchGitLogList } from './WorkbenchGitLogList'
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
 * 拆分前 Workbench 底部 Git 工具：查看分支与提交历史，不承担提交操作。中间是提交图（默认全部本地分支和
 * 远端分支，左侧点一个分支就只看它），右侧是选中提交的改动。贮藏也列在这里（左侧分支下面）：点一条看它
 * 里面的改动，应用、弹出或删除。
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
  const { t, messageLatest, tLatest } = useStableWorkbenchMessageTranslate()
  /** 日志只看的那个分支；空串是全部分支。 */
  const [logBranch, setLogBranch] = useState('')
  const [logSearch, setLogSearch] = useState('')
  const [selectedCommitSha, setSelectedCommitSha] = useState<Nullable<string>>(null)
  /** 选中的贮藏：选着它时右侧看的是它，不是日志里选中的提交。 */
  const [selectedStashSha, setSelectedStashSha] = useState<Nullable<string>>(null)
  const [pendingStashAction, setPendingStashAction] =
    useState<Nullable<WorkspaceGitStashAction>>(null)
  const isRepository = !!summary?.repository
  const revision = summary?.checkedAt ?? null
  const branches = useMemo(() => summary?.branches ?? [], [summary?.branches])
  const currentBranch = summary?.status?.branch ?? null
  const log = useWorkbenchGitLog({ workspaceRoot, branch: logBranch, enabled: isRepository, revision })
  const stashList = useWorkbenchGitStashes({ workspaceRoot, enabled: isRepository, revision })

  const { commits } = log
  const searching = !!logSearch.trim()
  const filteredCommits = useMemo(
    () => filterWorkbenchGitLogCommits(commits, logSearch),
    [commits, logSearch]
  )
  // 提交图按读到的全部提交排；搜索时列表里只剩匹配的提交，线接不上，不画图。
  const graph = useMemo(() => layoutWorkbenchGitGraph(commits).rows, [commits])
  const graphLanes = useMemo(() => measureWorkbenchGitGraphLanes(graph), [graph])
  const selectedStash = useMemo(
    () => stashList.stashes.find((stash) => stash.sha === selectedStashSha) ?? null,
    [selectedStashSha, stashList.stashes]
  )
  const detailsTarget = useMemo<Nullable<WorkbenchGitDetailsTarget>>(() => {
    if (selectedStash) return { kind: 'stash', stash: selectedStash }
    const commit = commits.find((candidate) => candidate.sha === selectedCommitSha)
    return commit ? { kind: 'commit', commit } : null
  }, [commits, selectedCommitSha, selectedStash])

  // 只看的那个分支没了（删掉了、换了项目）：回到全部分支。
  useEffect(() => {
    if (logBranch && !branches.some((branch) => branch.name === logBranch)) setLogBranch('')
  }, [branches, logBranch])

  // 选中的提交还在日志里就留着（日志原地刷新、往后翻页都不动它），不在了选最新的那个。
  useEffect(() => {
    setSelectedCommitSha((current) =>
      current && commits.some((commit) => commit.sha === current)
        ? current
        : (commits[0]?.sha ?? null)
    )
  }, [commits])

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

  // 范围标签点一下：在「全部分支」与当前分支之间切换（在看别的分支时先回到全部）。
  const scopeToggleTarget = logBranch ? '' : (currentBranch ?? '')
  const scopeToggleLabel = logBranch
    ? t('workbench.gitLogShowAllBranches')
    : currentBranch
      ? t('workbench.gitLogShowCurrentBranch', { branch: currentBranch })
      : t('workbench.gitLogAllBranches')

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
                <button
                  type="button"
                  className={styles.gitLogScope}
                  title={scopeToggleLabel}
                  aria-label={scopeToggleLabel}
                  disabled={!logBranch && !currentBranch}
                  onClick={() => setLogBranch(scopeToggleTarget)}
                >
                  {logBranch ? <GitBranchIcon size={12} /> : <GitForkIcon size={12} />}
                  <span>{logBranch || t('workbench.gitLogAllBranches')}</span>
                </button>
                <span className={styles.gitLogCount}>
                  {log.isLoadingMore && <SpinnerGapIcon size={11} className={styles.spinIcon} />}
                  {t(log.hasMore ? 'workbench.gitLogResultCountMore' : 'workbench.gitLogResultCount', {
                    count: filteredCommits.length,
                  })}
                </span>
              </div>
              {log.isLoading ? (
                <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
                  {t('workbench.gitLogLoading')}
                </Paragraph>
              ) : log.error ? (
                <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
                  {log.error}
                </Paragraph>
              ) : filteredCommits.length || log.hasMore ? (
                <WorkbenchGitLogList
                  commits={filteredCommits}
                  graph={searching ? null : graph}
                  graphLanes={graphLanes}
                  selectedSha={selectedStash ? null : selectedCommitSha}
                  onSelect={(sha) => {
                    setSelectedStashSha(null)
                    setSelectedCommitSha(sha)
                  }}
                  hasMore={log.hasMore}
                  autoLoadMore={!searching}
                  loadMoreLabel={t('workbench.gitLogLoadOlder', { count: commits.length })}
                  onLoadMore={log.loadMore}
                  ariaLabel={t('workbench.gitLog')}
                />
              ) : (
                <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
                  {t('workbench.gitLogEmpty')}
                </Paragraph>
              )}
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
