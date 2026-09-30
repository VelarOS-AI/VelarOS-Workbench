import { type ReactElement, type ReactNode, useEffect, useMemo, useState } from 'react'
import {
  CalendarBlankIcon,
  FileCodeIcon,
  FilesIcon,
  GitBranchIcon,
  HashStraightIcon,
  StackIcon,
  UserCircleIcon,
} from '@phosphor-icons/react'
import { workbenchHost } from '@renderer/host'
import { useWorkbenchI18n } from '@renderer/i18n'
import {
  formatWorkbenchGitCommitDate,
  parseWorkbenchGitCommitDiff,
} from '@renderer/models/git/changesPanel.model'
import {
  getWorkbenchGitStashSubtitle,
  getWorkbenchGitStashTitle,
} from '@renderer/models/git/workbenchGitStashModel'

import { Result } from '@velaros-ai/core/result'
import { Paragraph } from '@velaros-ai/ui/primitives/display/Paragraph'

import type { WorkspaceGitLogEntry, WorkspaceGitStash } from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'

/** 右侧详情看的是什么：日志里选中的提交，或者贮藏列表里选中的一条贮藏。 */
export type WorkbenchGitDetailsTarget =
  | { kind: 'commit'; commit: WorkspaceGitLogEntry }
  | { kind: 'stash'; stash: WorkspaceGitStash }

interface WorkbenchGitDetailsPaneProps {
  workspaceRoot: string
  target: Nullable<WorkbenchGitDetailsTarget>
  /** 标题下面的一排操作（贮藏的应用、弹出、删除）。 */
  actions?: ReactNode
}

const DetailDiffMaxChars = 120_000
const PatchLinesShown = 320

function targetKey(target: Nullable<WorkbenchGitDetailsTarget>): Nullable<string> {
  if (!target) return null
  return target.kind === 'commit' ? `commit:${target.commit.sha}` : `stash:${target.stash.sha}`
}

/**
 * Git 工具窗右侧的详情：一个提交或一条贮藏改了哪些文件、每个文件的补丁。两者是同一种东西（一份统一
 * diff），只有标题那几行不一样。
 */
export function WorkbenchGitDetailsPane({
  workspaceRoot,
  target,
  actions,
}: WorkbenchGitDetailsPaneProps): ReactElement {
  const { locale, t } = useWorkbenchI18n()
  const [loaded, setLoaded] = useState<Nullable<{ key: string; diff: string }>>(null)
  const [selectedDiffPath, setSelectedDiffPath] = useState<Nullable<string>>(null)
  const key = targetKey(target)
  const commitSha = target?.kind === 'commit' ? target.commit.sha : null
  const stashSha = target?.kind === 'stash' ? target.stash.sha : null

  useEffect(() => {
    if (!key) {
      setLoaded(null)
      return
    }
    let active = true
    void workbenchHost.kernel.workspace
      .getWorkspaceGitDiff(workspaceRoot, {
        commitSha: commitSha ?? undefined,
        stashSha: stashSha ?? undefined,
        maxChars: DetailDiffMaxChars,
      })
      .then((result) => Result.unwrap(result).diff)
      .then(
        (diff) => {
          if (active) setLoaded({ key, diff })
        },
        () => {
          // 读不出来（贮藏刚被取走、提交被改写掉）就当没有改动可显示，下面写着「没有差异」。
          if (active) setLoaded({ key, diff: '' })
        }
      )
    return () => {
      active = false
    }
  }, [commitSha, key, stashSha, workspaceRoot])

  // 换了一个提交、贮藏时，上一个的补丁不拿来顶着显示。
  const diff = loaded?.key === key ? loaded.diff : ''
  const diffFiles = useMemo(() => parseWorkbenchGitCommitDiff(diff), [diff])
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

  if (!target)
    return (
      <Paragraph spacing="none" tone="muted" className={styles.gitDiffEmpty}>
        {t('workbench.gitCommitSelect')}
      </Paragraph>
    )

  return (
    <div className={styles.gitCommitDetail}>
      {target.kind === 'commit' ? (
        <>
          <header className={styles.gitCommitHeader}>
            <h5 className={styles.gitCommitDetailTitle}>{target.commit.subject}</h5>
            {!!target.commit.refs.length && (
              <div className={styles.gitCommitRefs}>
                {target.commit.refs.map((ref) => (
                  <span key={ref}>{ref}</span>
                ))}
              </div>
            )}
            {actions}
          </header>
          <dl className={styles.gitCommitMetaGrid}>
            <div>
              <span className={styles.gitCommitMetaLabel}>
                <HashStraightIcon size={14} />
                <dt>{t('workbench.gitCommitSha')}</dt>
              </span>
              <dd>{target.commit.shortSha}</dd>
            </div>
            <div>
              <span className={styles.gitCommitMetaLabel}>
                <UserCircleIcon size={14} />
                <dt>{t('workbench.gitCommitAuthor')}</dt>
              </span>
              <dd>{target.commit.authorName}</dd>
            </div>
            <div>
              <span className={styles.gitCommitMetaLabel}>
                <CalendarBlankIcon size={14} />
                <dt>{t('workbench.gitCommitDate')}</dt>
              </span>
              <dd>{formatWorkbenchGitCommitDate(locale, target.commit)}</dd>
            </div>
          </dl>
        </>
      ) : (
        <>
          <header className={styles.gitCommitHeader}>
            <h5 className={styles.gitCommitDetailTitle}>
              {getWorkbenchGitStashTitle(target.stash, t)}
            </h5>
            <div className={styles.gitCommitRefs}>
              <span>{`stash@{${target.stash.index}}`}</span>
              {target.stash.includesUntracked && (
                <span>{t('workbench.gitStashIncludesUntracked')}</span>
              )}
            </div>
            {actions}
          </header>
          <dl className={styles.gitCommitMetaGrid} data-columns="2">
            <div>
              <span className={styles.gitCommitMetaLabel}>
                {target.stash.branch ? <GitBranchIcon size={14} /> : <StackIcon size={14} />}
              </span>
              <dd title={getWorkbenchGitStashSubtitle(target.stash, t)}>
                {getWorkbenchGitStashSubtitle(target.stash, t)}
              </dd>
            </div>
            <div>
              <span className={styles.gitCommitMetaLabel}>
                <CalendarBlankIcon size={14} />
                <dt>{t('workbench.gitCommitDate')}</dt>
              </span>
              <dd>
                {formatWorkbenchGitCommitDate(locale, { authoredAt: target.stash.createdAt })}
              </dd>
            </div>
          </dl>
        </>
      )}
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
              {selectedDiffFile.lines.slice(0, PatchLinesShown).map((line, index) => (
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
  )
}
