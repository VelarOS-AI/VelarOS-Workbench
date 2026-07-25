import {
  type FormEvent,
  type ReactElement,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  GitBranchIcon,
  MagicWandIcon,
  PlusIcon,
  UploadSimpleIcon,
} from '@phosphor-icons/react'

import { AppError } from '@velaros/core'
import { Result } from '@velaros/core/result'
import type { SystemWorkspaceGitSummary, WorkspaceGitLogEntry } from '@velaros/core/types'
import { Button } from '@velaros/ui/primitives/buttons/Button'
import { Input } from '@velaros/ui/primitives/forms/Input'
import { workbenchHost } from '@velaros/workbench/host'
import { useWorkbenchI18n } from '@velaros/workbench/i18n'
import type { WorkbenchGitChangeItem } from '@velaros/workbench/models/git/workbenchGitModel'

import styles from '../../styles/workbenchPageStyles'

interface WorkbenchGitToolPanelProps {
  workspaceRoot: string
  summary: Nullable<SystemWorkspaceGitSummary>
  changeItems: WorkbenchGitChangeItem[]
  isLoading: boolean
  error: Nullable<string>
  hasUnsavedOpenTabs: boolean
  onRefresh: () => Promise<void>
  onInitialize: () => Promise<void>
  onOpenDiff: (item: WorkbenchGitChangeItem) => void
  onRepositoryChanged: () => Promise<void>
}

export function WorkbenchGitToolPanel({
  workspaceRoot,
  summary,
  changeItems,
  isLoading,
  error,
  hasUnsavedOpenTabs,
  onRefresh,
  onInitialize,
  onOpenDiff,
  onRepositoryChanged,
}: WorkbenchGitToolPanelProps): ReactElement {
  const { locale, t } = useWorkbenchI18n()
  const [commitMessage, setCommitMessage] = useState('')
  const [newBranchName, setNewBranchName] = useState('')
  const [busyAction, setBusyAction] = useState<Nullable<string>>(null)
  const [actionError, setActionError] = useState<Nullable<string>>(null)
  const [commits, setCommits] = useState<WorkspaceGitLogEntry[]>([])
  const [selectedCommitSha, setSelectedCommitSha] = useState<Nullable<string>>(null)
  const [commitDiff, setCommitDiff] = useState('')
  const [logLoading, setLogLoading] = useState(false)

  const localBranches = useMemo(
    () => summary?.branches.filter((branch) => branch.kind !== 'remote') ?? [],
    [summary?.branches]
  )

  useEffect(() => {
    if (!summary?.repository) {
      setCommits([])
      setSelectedCommitSha(null)
      setCommitDiff('')
      return
    }
    let active = true
    setLogLoading(true)
    void workbenchHostCall(async () => {
      const result = Result.unwrap(
        await workbenchHost.kernel.workspace.getWorkspaceGitLog(workspaceRoot, { limit: 80 })
      )
      if (!active) return
      setCommits(result.commits)
      setSelectedCommitSha((current) =>
        current && result.commits.some((commit) => commit.sha === current)
          ? current
          : (result.commits[0]?.sha ?? null)
      )
    }).finally(() => {
      if (active) setLogLoading(false)
    })
    return () => {
      active = false
    }
  }, [summary?.checkedAt, summary?.repository, workspaceRoot])

  useEffect(() => {
    if (!selectedCommitSha) {
      setCommitDiff('')
      return
    }
    let active = true
    void workbenchHostCall(async () => {
      const result = Result.unwrap(
        await workbenchHost.kernel.workspace.getWorkspaceGitDiff(workspaceRoot, {
          commitSha: selectedCommitSha,
          maxChars: 120_000,
        })
      )
      if (active) setCommitDiff(result.diff)
    })
    return () => {
      active = false
    }
  }, [selectedCommitSha, workspaceRoot])

  async function runAction(id: string, action: () => Promise<void>): Promise<void> {
    if (busyAction) return
    setBusyAction(id)
    setActionError(null)
    try {
      await action()
    } catch (runError) {
      setActionError(AppError.getMessage(runError))
    } finally {
      setBusyAction(null)
    }
  }

  async function runFileAction(
    item: WorkbenchGitChangeItem,
    action: 'discard' | 'stage' | 'unstage'
  ): Promise<void> {
    if (hasUnsavedOpenTabs) {
      setActionError(t('workbench.gitUnsavedBlockedDescription'))
      return
    }
    if (
      action === 'discard' &&
      !window.confirm(t('workbench.gitDiscardConfirm', { path: item.path }))
    ) return
    await runAction(`${action}:${item.path}`, async () => {
      Result.unwrap(
        await workbenchHost.kernel.workspace.performWorkspaceGitFileAction(
          workspaceRoot,
          item.path,
          action
        )
      )
      await onRefresh()
    })
  }

  async function generateCommitMessage(): Promise<void> {
    await runAction('generate-message', async () => {
      const result = Result.unwrap(
        await workbenchHost.kernel.workspace.generateWorkspaceGitCommitMessage(
          workspaceRoot,
          locale
        )
      )
      setCommitMessage(result.message ?? '')
    })
  }

  async function commitAll(): Promise<void> {
    if (hasUnsavedOpenTabs) {
      setActionError(t('workbench.gitUnsavedBlockedDescription'))
      return
    }
    await runAction('commit', async () => {
      Result.unwrap(
        await workbenchHost.kernel.workspace.commitWorkspaceGitChanges(
          workspaceRoot,
          locale,
          commitMessage
        )
      )
      setCommitMessage('')
      await onRefresh()
    })
  }

  async function switchBranch(branch: string): Promise<void> {
    if (!branch || branch === summary?.status?.branch) return
    await runAction('switch-branch', async () => {
      Result.unwrap(
        await workbenchHost.kernel.workspace.switchWorkspaceGitBranch(
          workspaceRoot,
          branch,
          locale
        )
      )
      await onRepositoryChanged()
    })
  }

  async function createBranch(event: FormEvent): Promise<void> {
    event.preventDefault()
    const branch = newBranchName.trim()
    if (!branch) return
    await runAction('create-branch', async () => {
      Result.unwrap(
        await workbenchHost.kernel.workspace.createWorkspaceGitBranch(workspaceRoot, branch)
      )
      setNewBranchName('')
      await onRefresh()
    })
  }

  async function remoteAction(action: 'update' | 'upload'): Promise<void> {
    if (action === 'upload' && !window.confirm(t('workbench.gitPushConfirm'))) return
    await runAction(action, async () => {
      Result.unwrap(
        await workbenchHost.kernel.workspace.performWorkspaceGitAction(
          workspaceRoot,
          action
        )
      )
      await onRefresh()
    })
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
    <section className={styles.gitToolRoot}>
      <header className={styles.gitToolToolbar}>
        <label className={styles.gitToolBranchSelect}>
          <GitBranchIcon size={14} />
          <select
            value={summary.status?.branch ?? ''}
            disabled={!!busyAction || hasUnsavedOpenTabs || !!summary.status?.changedFiles}
            onChange={(event) => void switchBranch(event.target.value)}
          >
            {localBranches.map((branch) => (
              <option key={branch.name} value={branch.name}>
                {branch.name}
              </option>
            ))}
          </select>
        </label>
        <form className={styles.gitToolCreateBranch} onSubmit={createBranch}>
          <Input
            size="sm"
            value={newBranchName}
            placeholder={t('workbench.gitBranchCreatePlaceholder')}
            onChange={(event) => setNewBranchName(event.target.value)}
          />
          <Button
            type="submit"
            variant="ghost"
            size="icon-sm"
            disabled={!newBranchName.trim() || !!busyAction}
            title={t('workbench.gitBranchCreate')}
          >
            <PlusIcon size={14} />
          </Button>
        </form>
        <span className={styles.gitToolToolbarSpacer} />
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('workbench.gitUpdate')}
          disabled={!!busyAction}
          onClick={() => void remoteAction('update')}
        >
          <ArrowCounterClockwiseIcon size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('workbench.gitUpload')}
          disabled={!!busyAction}
          onClick={() => void remoteAction('upload')}
        >
          <UploadSimpleIcon size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title={t('common.refresh')}
          disabled={!!busyAction}
          onClick={() => void onRefresh()}
        >
          <ArrowClockwiseIcon size={14} />
        </Button>
      </header>
      {!!(actionError || error) && (
        <div className={styles.gitToolError}>{actionError || error}</div>
      )}
      <div className={styles.gitToolColumns}>
        <section className={styles.gitToolChanges}>
          <div className={styles.gitToolSectionTitle}>
            <span>{t('workbench.gitChanges')}</span>
            <span>{changeItems.length}</span>
          </div>
          <div className={styles.gitToolChangeList}>
            {changeItems.length === 0 ? (
              <span className={styles.gitToolMuted}>{t('workbench.gitClean')}</span>
            ) : (
              changeItems.map((item) => (
                <div key={`${item.group}:${item.path}`} className={styles.gitToolChangeRow}>
                  <button
                    type="button"
                    className={styles.gitToolPathButton}
                    title={item.path}
                    onClick={() => onOpenDiff(item)}
                  >
                    <span>{item.fileName}</span>
                    <small>{item.path}</small>
                  </button>
                  <span className={styles.gitToolStatus}>
                    {item.indexStatus}
                    {item.workTreeStatus}
                  </span>
                  <Button
                    variant="ghost"
                    size="block"
                    disabled={!!busyAction}
                    onClick={() =>
                      void runFileAction(
                        item,
                        item.group === 'staged' ? 'unstage' : 'stage'
                      )
                    }
                  >
                    {item.group === 'staged'
                      ? t('workbench.gitUnstageFile')
                      : t('workbench.gitStageFile')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="block"
                    disabled={!!busyAction}
                    onClick={() => void runFileAction(item, 'discard')}
                  >
                    {t('workbench.gitRollback')}
                  </Button>
                </div>
              ))
            )}
          </div>
          <div className={styles.gitToolCommitComposer}>
            <Input
              value={commitMessage}
              placeholder={t('workbench.gitCommitPlaceholder')}
              disabled={!!busyAction}
              onChange={(event) => setCommitMessage(event.target.value)}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              title={t('workbench.gitGenerateCommitMessage')}
              disabled={!!busyAction || changeItems.length === 0}
              onClick={() => void generateCommitMessage()}
            >
              <MagicWandIcon size={15} />
            </Button>
            <Button
              size="sm"
              disabled={!!busyAction || changeItems.length === 0}
              onClick={() => void commitAll()}
            >
              {busyAction === 'commit'
                ? t('workbench.gitCommitPending')
                : t('workbench.gitCommitButton')}
            </Button>
          </div>
        </section>
        <section className={styles.gitToolLog}>
          <div className={styles.gitToolSectionTitle}>
            <span>{t('workbench.gitLog')}</span>
            <span>{commits.length}</span>
          </div>
          <div className={styles.gitToolLogBody}>
            <div className={styles.gitToolCommitList}>
              {logLoading ? (
                <span className={styles.gitToolMuted}>{t('workbench.gitLogLoading')}</span>
              ) : commits.length === 0 ? (
                <span className={styles.gitToolMuted}>{t('workbench.gitLogEmpty')}</span>
              ) : (
                commits.map((commit) => (
                  <button
                    type="button"
                    key={commit.sha}
                    data-active={selectedCommitSha === commit.sha}
                    onClick={() => setSelectedCommitSha(commit.sha)}
                  >
                    <strong>{commit.subject}</strong>
                    <small>
                      {commit.shortSha} · {commit.authorName}
                    </small>
                  </button>
                ))
              )}
            </div>
            <pre className={styles.gitToolCommitDiff}>
              {commitDiff || t('workbench.gitCommitSelect')}
            </pre>
          </div>
        </section>
      </div>
    </section>
  )
}

async function workbenchHostCall(action: () => Promise<void>): Promise<void> {
  try {
    await action()
  } catch {
    // 背景日志/提交 diff 失败由空状态降级；显式用户动作走 runAction 展示错误。
  }
}
