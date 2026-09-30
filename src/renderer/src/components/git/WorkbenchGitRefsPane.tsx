import { type MouseEvent, type ReactElement, useState } from 'react'
import { GitBranchIcon, GitForkIcon, StackIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n'
import { formatWorkbenchGitCommitRelativeDate } from '@renderer/models/git/changesPanel.model'
import {
  getWorkbenchGitStashSubtitle,
  getWorkbenchGitStashTitle,
} from '@renderer/models/git/workbenchGitStashModel'

import { SearchField } from '@velaros-ai/ui/primitives/forms/SearchField'
import { ScrollArea } from '@velaros-ai/ui/primitives/layout/ScrollArea'

import type { WorkspaceGitBranch, WorkspaceGitStash } from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'

interface WorkbenchGitRefsPaneProps {
  branches: readonly WorkspaceGitBranch[]
  /** 日志此刻只看的那个分支；空串是全部分支。 */
  logBranch: string
  onSelectBranch: (branch: string) => void
  /** 在一个分支上点右键（合并它、变基到它上面）。 */
  onBranchContextMenu: (branch: WorkspaceGitBranch, event: MouseEvent) => void
  stashes: readonly WorkspaceGitStash[]
  /** 贮藏列表读不出来的原因。 */
  stashesError: Nullable<string>
  selectedStashSha: Nullable<string>
  onSelectStash: (stash: WorkspaceGitStash) => void
}

/**
 * Git 工具窗左侧：日志看哪些分支（全部，或者点一个分支只看它），和贮藏（点一条在右侧看它里面的改动）。
 * 在分支上点右键是对它的操作（合并、变基），菜单由工具窗给。
 */
export function WorkbenchGitRefsPane({
  branches,
  logBranch,
  onSelectBranch,
  onBranchContextMenu,
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
          <button
            type="button"
            className={styles.gitBranchRow}
            data-active={logBranch === ''}
            onClick={() => onSelectBranch('')}
          >
            <GitForkIcon size={13} />
            <span className={styles.gitBranchName}>{t('workbench.gitLogAllBranches')}</span>
          </button>
          <BranchGroup
            label={t('workbench.gitBranchLocal')}
            branches={localBranches}
            logBranch={logBranch}
            onSelect={onSelectBranch}
            onContextMenu={onBranchContextMenu}
            currentLabel={t('workbench.gitBranchCurrent')}
          />
          {!!remoteBranches.length && (
            <BranchGroup
              label={t('workbench.gitBranchRemoteGroup')}
              branches={remoteBranches}
              logBranch={logBranch}
              onSelect={onSelectBranch}
              onContextMenu={onBranchContextMenu}
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
  branches: readonly WorkspaceGitBranch[]
  logBranch: string
  currentLabel: string
  onSelect: (branch: string) => void
  onContextMenu: (branch: WorkspaceGitBranch, event: MouseEvent) => void
}

function BranchGroup({
  label,
  branches,
  logBranch,
  currentLabel,
  onSelect,
  onContextMenu,
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
          onContextMenu={(event) => {
            event.preventDefault()
            onContextMenu(branch, event)
          }}
        >
          <GitBranchIcon size={13} />
          <span className={styles.gitBranchName}>{branch.name}</span>
          {branch.current && <span className={styles.gitBranchMark}>{currentLabel}</span>}
        </button>
      ))}
    </section>
  )
}
