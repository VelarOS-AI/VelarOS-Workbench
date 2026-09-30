import { type ReactElement, useState } from 'react'
import { GitBranchIcon, StackIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import { formatWorkbenchGitCommitRelativeDate } from '@renderer/models/git/changesPanel.model'
import {
  getWorkbenchGitStashSubtitle,
  getWorkbenchGitStashTitle,
} from '@renderer/models/git/workbenchGitStashModel'

import { SearchField } from '@velaros-ai/ui/primitives/forms/SearchField'
import { ScrollArea } from '@velaros-ai/ui/primitives/layout/ScrollArea'

import type { SystemWorkspaceGitSummary, WorkspaceGitStash } from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'

interface WorkbenchGitRefsPaneProps {
  branches: SystemWorkspaceGitSummary['branches']
  /** 日志此刻看的分支；没在看某个分支时为空串。 */
  logBranch: string
  onSelectBranch: (branch: string) => void
  stashes: readonly WorkspaceGitStash[]
  /** 贮藏列表读不出来的原因。 */
  stashesError: Nullable<string>
  selectedStashSha: Nullable<string>
  onSelectStash: (stash: WorkspaceGitStash) => void
}

/** Git 工具窗左侧：分支（点一个看它的日志）和贮藏（点一条在右侧看它里面的改动）。 */
export function WorkbenchGitRefsPane({
  branches,
  logBranch,
  onSelectBranch,
  stashes,
  stashesError,
  selectedStashSha,
  onSelectStash,
}: WorkbenchGitRefsPaneProps): ReactElement {
  const { locale, t } = useWorkbenchI18n()
  const [search, setSearch] = useState('')
  const query = search.trim().toLocaleLowerCase(locale)
  const matches = (text: string): boolean => !query || text.toLocaleLowerCase(locale).includes(query)
  const localBranches = branches.filter(
    (branch) => branch.kind !== 'remote' && matches(branch.name)
  )
  const remoteBranches = branches.filter(
    (branch) => branch.kind === 'remote' && matches(branch.name)
  )
  const visibleStashes = stashes.filter((stash) =>
    matches(`${getWorkbenchGitStashTitle(stash, t)} ${stash.branch ?? ''} ${stash.message}`)
  )

  return (
    <aside className={styles.gitLogBranchPane}>
      <div className={styles.gitBranchPaneHeader}>
        <p className={styles.gitPaneSectionTitle}>{t('workbench.gitBranches')}</p>
        <span>{branches.length}</span>
      </div>
      <div className={styles.gitBranchSearch}>
        <SearchField
          size="sm"
          value={search}
          placeholder={t('workbench.gitBranchSearchPlaceholder')}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <ScrollArea className={styles.gitBranchScroll}>
        <div className={styles.gitBranchList}>
          <BranchGroup
            label={t('workbench.gitBranchLocal')}
            branches={localBranches}
            logBranch={logBranch}
            onSelect={onSelectBranch}
            currentLabel={t('workbench.gitBranchCurrent')}
          />
          {!!remoteBranches.length && (
            <BranchGroup
              label={t('workbench.gitBranchRemoteGroup')}
              branches={remoteBranches}
              logBranch={logBranch}
              onSelect={onSelectBranch}
              currentLabel={t('workbench.gitBranchCurrent')}
            />
          )}
          <section className={styles.gitBranchGroup}>
            <p>
              {t('workbench.gitStashes')}
              {!!stashes.length && ` · ${stashes.length}`}
            </p>
            {visibleStashes.map((stash) => (
              <button
                key={stash.sha}
                type="button"
                className={styles.gitStashRow}
                data-active={selectedStashSha === stash.sha}
                title={getWorkbenchGitStashSubtitle(stash, t)}
                onClick={() => onSelectStash(stash)}
              >
                <StackIcon size={13} />
                <span className={styles.gitStashRowText}>
                  <span className={styles.gitBranchName}>
                    {getWorkbenchGitStashTitle(stash, t)}
                  </span>
                  <small>
                    {stash.branch ?? t('workbench.gitStashDetachedShort')}
                    {' · '}
                    {formatWorkbenchGitCommitRelativeDate(locale, {
                      authoredAt: stash.createdAt,
                    })}
                  </small>
                </span>
              </button>
            ))}
            {!stashes.length && (
              <span className={styles.gitStashEmpty}>
                {stashesError || t('workbench.gitStashesEmpty')}
              </span>
            )}
          </section>
        </div>
      </ScrollArea>
    </aside>
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
