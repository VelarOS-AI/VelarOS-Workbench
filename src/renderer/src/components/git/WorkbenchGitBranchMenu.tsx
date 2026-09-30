import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type RefObject,
  useMemo,
  useState,
} from 'react'
import {
  ArrowDownIcon,
  ArrowsClockwiseIcon,
  ArrowUpIcon,
  CaretDownIcon,
  CloudArrowDownIcon,
  FolderIcon,
  GitBranchIcon,
  type Icon,
  PlusIcon,
  SpinnerGapIcon,
} from '@phosphor-icons/react'
import { describeWorkbenchGitRemoteActionCancel } from '@renderer/hooks/useWorkbenchGitRemoteAction'
import { useWorkbenchI18n } from '@renderer/i18n'
import {
  buildWorkbenchGitBranchTree,
  filterWorkbenchGitBranches,
  isWorkbenchGitRemoteBranch,
  type WorkbenchGitBranchNamespace,
  type WorkbenchGitBranchTreeNode,
  type WorkbenchGitRemoteActionItem,
} from '@renderer/models/git/workbenchGitBranchMenuModel'
import type { WorkbenchGitRemoteOperation } from '@renderer/models/git/workbenchGitRemoteOperation'

import { SearchField } from '@velaros-ai/ui/primitives/forms/SearchField'

import type { WorkspaceGitBranch, WorkspaceGitRemoteAction } from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'

const RemoteActionIcons: Record<WorkspaceGitRemoteAction, Icon> = {
  pull: ArrowDownIcon,
  upload: ArrowUpIcon,
  sync: ArrowsClockwiseIcon,
  fetch: CloudArrowDownIcon,
}

/** 分支行的缩进：每进一层目录多这么多。 */
const BranchIndentStepPx = 14
const BranchRowPaddingPx = 6

/**
 * 菜单里能用方向键走到的项，按从上到下的顺序：远端操作、搜索框、目录与分支、「新建分支」。行内悬停才出的
 * 小按钮不算（Tab 能到）。
 */
const MenuItemSelector = 'input, [data-git-menu-item]:not(:disabled)'

interface WorkbenchGitBranchMenuProps {
  branches: readonly WorkspaceGitBranch[]
  /** 当前分支；分离的 HEAD 上为 null（没有哪个分支算当前的）。 */
  currentBranch: Nullable<string>
  search: string
  searchRef: RefObject<Nullable<HTMLInputElement>>
  remoteActions: readonly WorkbenchGitRemoteActionItem[]
  /** 远端操作下面的一行说明：为什么有的按不了。 */
  remoteNote: Nullable<string>
  /** 这个项目正在跑的远端操作（不管是哪里发起的）。 */
  running: Nullable<WorkbenchGitRemoteOperation>
  /** 正在签出的分支名；没有为 null。 */
  switchingBranch: Nullable<string>
  /** 有远端操作或者分支操作在跑：别的都先按不了。 */
  locked: boolean
  /** 合并、变基之类进行到一半：不能切分支、新建分支，这是原因（悬停时看得到）。 */
  branchesBlocked: Nullable<string>
  onSearchChange: (search: string) => void
  onRunRemoteAction: (action: WorkspaceGitRemoteAction) => void
  onCancelRemoteAction: () => void
  onSwitchBranch: (branch: WorkspaceGitBranch) => void
  onPushBranch: (branch: WorkspaceGitBranch) => void
  onOpenCreateBranch: () => void
}

/**
 * 顶栏分支按钮展开的那一块：上面是当前分支的远端操作（拉取、推送、同步、获取远端；跑着的时候换成进度和
 * 取消），中间是搜索和分支列表（点一下签出，悬停出「签出」「推送」），最下面是新建分支。
 */
export function WorkbenchGitBranchMenu({
  branches,
  currentBranch,
  search,
  searchRef,
  remoteActions,
  remoteNote,
  running,
  switchingBranch,
  locked,
  branchesBlocked,
  onSearchChange,
  onRunRemoteAction,
  onCancelRemoteAction,
  onSwitchBranch,
  onPushBranch,
  onOpenCreateBranch,
}: WorkbenchGitBranchMenuProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(() => new Set())
  const searching = !!search.trim()
  const branchesLocked = locked || !!branchesBlocked
  const trees = useMemo(() => {
    const matched = filterWorkbenchGitBranches(branches, search)
    return {
      local: buildWorkbenchGitBranchTree(
        matched.filter((branch) => !isWorkbenchGitRemoteBranch(branch)),
        'local'
      ),
      remote: buildWorkbenchGitBranchTree(matched.filter(isWorkbenchGitRemoteBranch), 'remote'),
    }
  }, [branches, search])
  const runningLabel = running
    ? (remoteActions.find((item) => item.action === running.action)?.label ?? '')
    : ''

  function toggleFolder(key: string): void {
    setCollapsedFolders((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** ↑ ↓ 在菜单的各项之间走（到头绕回），Home / End 到头尾；搜索框里的 Home / End 是移动光标，不拦。 */
  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const vertical = event.key === 'ArrowDown' || event.key === 'ArrowUp'
    if (!vertical && event.key !== 'Home' && event.key !== 'End') return
    if (!vertical && event.target === searchRef.current) return

    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(MenuItemSelector)]
    if (items.length === 0) return
    event.preventDefault()
    if (!vertical) {
      ;(event.key === 'Home' ? items[0] : items.at(-1))?.focus()
      return
    }
    const index = items.indexOf(document.activeElement as HTMLElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    items[index < 0 ? 0 : (index + step + items.length) % items.length]?.focus()
  }

  function renderBranch(branch: WorkspaceGitBranch, label: string, depth: number): ReactElement {
    const remote = isWorkbenchGitRemoteBranch(branch)
    const current = !remote && (branch.current || branch.name === currentBranch)
    const checkoutLabel = t('workbench.gitBranchCheckoutCreated')
    const pushLabel = t('workbench.gitUpload')
    return (
      <div
        key={`${remote ? 'remote' : 'local'}:${branch.name}`}
        className={styles.gitBranchMenuRow}
        data-current={current || undefined}
        title={branchesBlocked && !current ? branchesBlocked : branch.name}
      >
        <button
          type="button"
          className={styles.gitBranchMenuRowMain}
          style={{ paddingLeft: BranchRowPaddingPx + depth * BranchIndentStepPx }}
          data-git-menu-item
          aria-current={current || undefined}
          disabled={branchesLocked || current}
          onClick={() => onSwitchBranch(branch)}
        >
          {switchingBranch === branch.name ? (
            <SpinnerGapIcon size={13} className={styles.spinIcon} />
          ) : (
            <GitBranchIcon size={13} weight={current ? 'fill' : 'regular'} />
          )}
          <span>{label}</span>
          {current && !!branch.upstream && <small>{branch.upstream}</small>}
        </button>
        {!current && (
          <div className={styles.gitBranchMenuRowActions} role="group">
            <button
              type="button"
              disabled={branchesLocked}
              title={checkoutLabel}
              aria-label={`${checkoutLabel} ${branch.name}`}
              onClick={() => onSwitchBranch(branch)}
            >
              <GitBranchIcon size={12} />
              <span>{checkoutLabel}</span>
            </button>
            {!remote && (
              <button
                type="button"
                disabled={branchesLocked}
                title={pushLabel}
                aria-label={`${pushLabel} ${branch.name}`}
                onClick={() => onPushBranch(branch)}
              >
                <ArrowUpIcon size={12} />
                <span>{pushLabel}</span>
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  function renderNode(node: WorkbenchGitBranchTreeNode, depth: number): Nullable<ReactElement> {
    if (node.children.length === 0)
      return node.branch ? renderBranch(node.branch, node.segment, depth) : null
    // 搜索时一律展开：搜到的分支不能藏在收起的目录里。
    const expanded = searching || !collapsedFolders.has(node.key)
    return (
      <div key={node.key} className={styles.gitBranchMenuFolder}>
        <button
          type="button"
          className={styles.gitBranchMenuFolderHeader}
          style={{ paddingLeft: BranchRowPaddingPx + depth * BranchIndentStepPx }}
          data-git-menu-item
          aria-expanded={expanded}
          onClick={() => toggleFolder(node.key)}
        >
          <CaretDownIcon
            size={11}
            className={styles.gitBranchMenuFolderCaret}
            data-collapsed={!expanded || undefined}
          />
          <FolderIcon size={14} />
          <span>{node.segment}</span>
        </button>
        {expanded && node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    )
  }

  function renderGroup(
    namespace: WorkbenchGitBranchNamespace,
    label: string
  ): Nullable<ReactElement> {
    const nodes = trees[namespace]
    if (nodes.length === 0) return null
    return (
      <section className={styles.gitBranchMenuGroup} aria-label={label}>
        <div className={styles.gitBranchMenuGroupTitle}>{label}</div>
        {nodes.map((node) => renderNode(node, 0))}
      </section>
    )
  }

  return (
    // 这是一块带搜索框的面板，不是纯菜单：按键只认方向键，其余照常（打字、Tab、Esc 关掉）。
    <div className={styles.gitBranchMenu} onKeyDown={handleKeyDown}>
      <div
        className={styles.gitBranchMenuRemote}
        role="group"
        aria-label={t('workbench.gitRemoteActionsMenu')}
      >
        {running ? (
          <div className={styles.gitBranchMenuRunning} role="status">
            <SpinnerGapIcon size={13} className={styles.spinIcon} />
            <span>{t('workbench.gitRemoteActionRunning', { action: runningLabel })}</span>
            <button
              type="button"
              className={styles.gitBranchMenuCancel}
              data-git-menu-item
              title={describeWorkbenchGitRemoteActionCancel(running, t)}
              disabled={running.cancelling}
              onClick={onCancelRemoteAction}
            >
              {running.cancelling ? t('workbench.gitRemoteActionCancelling') : t('common.cancel')}
            </button>
          </div>
        ) : (
          <div className={styles.gitBranchMenuActions}>
            {remoteActions.map((item) => {
              const ActionIcon = RemoteActionIcons[item.action]
              const unavailable = item.disabled || locked
              return (
                // 按不了的也留着焦点和悬停说明（原因写在 title 里），所以用 aria-disabled 而不是 disabled。
                <button
                  key={item.action}
                  type="button"
                  className={styles.gitBranchMenuAction}
                  data-git-menu-item
                  data-action={item.action}
                  aria-disabled={unavailable || undefined}
                  title={item.hint}
                  onClick={() => {
                    if (!unavailable) onRunRemoteAction(item.action)
                  }}
                >
                  <ActionIcon size={13} />
                  <span>{item.label}</span>
                  {item.count > 0 && <small>{item.count}</small>}
                </button>
              )
            })}
          </div>
        )}
        {!!remoteNote && !running && <p className={styles.gitBranchMenuNote}>{remoteNote}</p>}
      </div>
      <div className={styles.gitBranchMenuSearch}>
        <SearchField
          ref={searchRef}
          size="sm"
          value={search}
          placeholder={t('workbench.gitBranchSearchPlaceholder')}
          aria-label={t('workbench.gitBranchSearchPlaceholder')}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </div>
      <div className={styles.gitBranchMenuList}>
        {renderGroup('local', t('workbench.gitBranchLocal'))}
        {renderGroup('remote', t('workbench.gitBranchRemoteGroup'))}
        {trees.local.length === 0 && trees.remote.length === 0 && (
          <div className={styles.gitBranchMenuEmpty}>{t('workbench.gitBranchNoMatch')}</div>
        )}
      </div>
      <div className={styles.gitBranchMenuFooter}>
        <button
          type="button"
          className={styles.gitBranchMenuCreate}
          data-git-menu-item
          disabled={branchesLocked}
          title={branchesBlocked ?? undefined}
          onClick={onOpenCreateBranch}
        >
          <PlusIcon size={14} />
          <span>{t('workbench.gitBranchCreateDialogTitle')}</span>
        </button>
      </div>
    </div>
  )
}
