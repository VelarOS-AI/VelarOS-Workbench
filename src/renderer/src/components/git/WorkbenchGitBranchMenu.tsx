import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  ArrowDownIcon,
  ArrowLineUpIcon,
  ArrowsClockwiseIcon,
  ArrowUpIcon,
  CaretDownIcon,
  CaretRightIcon,
  ClockCounterClockwiseIcon,
  CloudArrowDownIcon,
  CopyIcon,
  FolderIcon,
  GitBranchIcon,
  GitDiffIcon,
  GitMergeIcon,
  type Icon,
  PencilSimpleIcon,
  PlusIcon,
  SpinnerGapIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import {
  describeWorkbenchGitRemoteActionCancel,
  describeWorkbenchGitRemoteActionProgress,
} from '@renderer/hooks/useWorkbenchGitRemoteAction'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'
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

import { type WorkspaceGitBranch } from '@shared/contracts/system'

import styles from '../../styles/workbenchPageStyles'

const RemoteActionIcons: Record<WorkbenchGitRemoteActionItem['action'], Icon> = {
  pull: ArrowDownIcon,
  upload: ArrowUpIcon,
  fetch: CloudArrowDownIcon,
  sync: ArrowsClockwiseIcon,
}

/** 分支行的缩进：每进一层目录多这么多。 */
const BranchIndentStepPx = 14
const BranchRowPaddingPx = 6

const MenuItemSelector = 'input, [data-git-menu-item]:not(:disabled)'
const SubmenuGap = 8
const SubmenuViewportInset = 8

interface WorkbenchGitBranchMenuProps {
  branches: readonly WorkspaceGitBranch[]
  /** 当前分支；分离的 HEAD 上为 null（没有哪个分支算当前的）。 */
  currentBranch: Nullable<string>
  selectedBranch: Nullable<WorkspaceGitBranch>
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
  canIntegrate: boolean
  onSearchChange: (search: string) => void
  onSelectBranch: (branch: Nullable<WorkspaceGitBranch>) => void
  onRunRemoteAction: (action: WorkbenchGitRemoteActionItem['action']) => void
  onCancelRemoteAction: () => void
  onSwitchBranch: (branch: WorkspaceGitBranch) => void
  onPushBranch: (branch: WorkspaceGitBranch) => void
  onRunBranchOperation: (action: 'merge' | 'rebase', branch: WorkspaceGitBranch) => void
  onOpenCreateBranch: (branch?: WorkspaceGitBranch) => void
  onOpenRenameBranch: (branch: WorkspaceGitBranch) => void
  onDeleteBranch: (branch: WorkspaceGitBranch) => void
  onCopyBranch: (branch: WorkspaceGitBranch) => void
  onInspectBranch: (branch: WorkspaceGitBranch, compare: boolean) => void
}

export function WorkbenchGitBranchMenu({
  branches,
  currentBranch,
  selectedBranch,
  search,
  searchRef,
  remoteActions,
  remoteNote,
  running,
  switchingBranch,
  locked,
  branchesBlocked,
  canIntegrate,
  onSearchChange,
  onSelectBranch,
  onRunRemoteAction,
  onCancelRemoteAction,
  onSwitchBranch,
  onPushBranch,
  onRunBranchOperation,
  onOpenCreateBranch,
  onOpenRenameBranch,
  onDeleteBranch,
  onCopyBranch,
  onInspectBranch,
}: WorkbenchGitBranchMenuProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const detailsId = useId()
  const menuRef = useRef<HTMLDivElement>(null)
  const detailsRef = useRef<HTMLElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(hoverTimer.current), [])
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(() => new Set())
  const searching = !!search.trim()
  const branchesLocked = locked || !!branchesBlocked
  const { matched, trees } = useMemo(() => {
    const matched = filterWorkbenchGitBranches(branches, search)
    return {
      matched,
      trees: {
        local: buildWorkbenchGitBranchTree(
          matched.filter((branch) => !isWorkbenchGitRemoteBranch(branch)),
          'local'
        ),
        remote: buildWorkbenchGitBranchTree(matched.filter(isWorkbenchGitRemoteBranch), 'remote'),
      },
    }
  }, [branches, search])

  const selected = matched.find(
    (branch) =>
      selectedBranch &&
      branch.name === selectedBranch.name &&
      isWorkbenchGitRemoteBranch(branch) === isWorkbenchGitRemoteBranch(selectedBranch)
  )
  const selectedRemote = !!selected && isWorkbenchGitRemoteBranch(selected)
  const selectedCurrent =
    !!selected && !selectedRemote && (selected.current || selected.name === currentBranch)
  const runningInDetails =
    ((running?.action === 'pull' || running?.action === 'sync') && selectedCurrent) ||
    (running?.action === 'upload' &&
      !!selected &&
      !selectedRemote &&
      (running.branch ? running.branch === selected.name : selectedCurrent))

  useLayoutEffect(() => {
    const menu = menuRef.current
    const details = detailsRef.current
    const row = menu?.querySelector('[data-selected="true"]')
    const panel = menu?.parentElement
    const view = menu?.ownerDocument.defaultView
    if (!menu || !details || !row || !panel || !view) return

    const position = (): void => {
      const origin = menu.getBoundingClientRect()
      const bounds = panel.getBoundingClientRect()
      const anchor = row.getBoundingClientRect()
      const list = row.closest(`.${styles.gitBranchMenuList}`)?.getBoundingClientRect()
      const { width, height } = details.getBoundingClientRect()
      const right = bounds.right + SubmenuGap
      const left = bounds.left - SubmenuGap - width
      const maxX = view.innerWidth - width - SubmenuViewportInset
      const x = right <= maxX || left < SubmenuViewportInset ? right : left
      const maxY = view.innerHeight - height - SubmenuViewportInset
      details.style.left = `${Math.max(SubmenuViewportInset, Math.min(x, maxX)) - origin.left}px`
      details.style.top = `${Math.max(SubmenuViewportInset, Math.min(anchor.top, maxY)) - origin.top}px`
      details.style.visibility =
        list && (anchor.bottom <= list.top || anchor.top >= list.bottom) ? 'hidden' : 'visible'
      details.dataset.side = x === left ? 'left' : 'right'
    }

    position()
    const observer = new ResizeObserver(position)
    observer.observe(panel)
    observer.observe(details)
    let frame = 0
    const handleResize = (): void => {
      view.cancelAnimationFrame(frame)
      frame = view.requestAnimationFrame(position)
    }
    view.addEventListener('resize', handleResize)
    view.addEventListener('scroll', position, true)
    return () => {
      observer.disconnect()
      view.cancelAnimationFrame(frame)
      view.removeEventListener('resize', handleResize)
      view.removeEventListener('scroll', position, true)
    }
  }, [selected])

  function cancelHoverTimer(): void {
    clearTimeout(hoverTimer.current)
  }

  function openHoveredBranch(branch: WorkspaceGitBranch): void {
    cancelHoverTimer()
    // 横向移入子菜单时，鼠标可能短暂经过旁边的分支行。
    if (!selected || selected === branch) onSelectBranch(branch)
    else hoverTimer.current = setTimeout(() => onSelectBranch(branch), 100)
  }

  function closeHoveredBranch(): void {
    cancelHoverTimer()
    hoverTimer.current = setTimeout(() => {
      if (!detailsRef.current?.contains(menuRef.current?.ownerDocument.activeElement ?? null))
        onSelectBranch(null)
    }, 220)
  }

  function renderRemoteAction(
    item: WorkbenchGitRemoteActionItem,
    active?: Nullable<WorkbenchGitRemoteOperation>,
    branch?: WorkspaceGitBranch
  ): ReactElement {
    const ActionIcon = RemoteActionIcons[item.action]
    const unavailable = active ? active.cancelling : item.disabled || locked || !!running
    const label = branch ? `${item.label} ${branch.name}` : item.label
    const cancelLabel = active ? describeWorkbenchGitRemoteActionCancel(active, t) : undefined
    const hint = `${item.label}${item.count > 0 ? ` (${item.count})` : ''} · ${item.hint}`
    const iconOnly = item.action === 'fetch'
    return (
      <button
        key={item.action}
        type="button"
        className={iconOnly ? styles.gitBranchMenuAction : styles.gitBranchMenuCommand}
        data-git-menu-item
        data-action={item.action}
        data-running={!!active || undefined}
        aria-label={cancelLabel ?? label}
        aria-description={
          active ? describeWorkbenchGitRemoteActionProgress(active.action, t) : hint
        }
        aria-disabled={unavailable || undefined}
        disabled={active?.cancelling}
        title={cancelLabel ?? hint}
        onClick={() => {
          if (unavailable) return
          if (active) onCancelRemoteAction()
          else if (branch) onPushBranch(branch)
          else onRunRemoteAction(item.action)
        }}
      >
        {active ? (
          <SpinnerGapIcon size={15} className={styles.spinIcon} aria-hidden="true" />
        ) : (
          <ActionIcon size={15} aria-hidden="true" />
        )}
        {!iconOnly && <span>{cancelLabel ?? item.label}</span>}
      </button>
    )
  }

  function toggleFolder(key: string, expanded: boolean): void {
    if (searching) return
    cancelHoverTimer()
    onSelectBranch(null)
    setCollapsedFolders((current) => {
      const next = new Set(current)
      if (expanded) next.add(key)
      else next.delete(key)
      return next
    })
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement
    const inDetails = !!detailsRef.current?.contains(target)
    if (event.key === 'ArrowRight' && target.hasAttribute('data-git-branch-row')) {
      event.preventDefault()
      target.click()
      return
    }
    if (event.key === 'ArrowLeft' && inDetails) {
      event.preventDefault()
      cancelHoverTimer()
      event.currentTarget.querySelector<HTMLElement>('[data-selected="true"] > button')?.focus()
      onSelectBranch(null)
      return
    }
    const vertical = event.key === 'ArrowDown' || event.key === 'ArrowUp'
    if (!vertical && event.key !== 'Home' && event.key !== 'End') return
    if (!vertical && event.target === searchRef.current) return

    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(MenuItemSelector)].filter(
      (item) => !!detailsRef.current?.contains(item) === inDetails
    )
    if (items.length === 0) return
    event.preventDefault()
    if (!vertical) {
      ;(event.key === 'Home' ? items[0] : items.at(-1))?.focus()
      return
    }
    const index = items.indexOf(target)
    const step = event.key === 'ArrowDown' ? 1 : -1
    items[index < 0 ? 0 : (index + step + items.length) % items.length]?.focus()
  }

  function renderBranch(branch: WorkspaceGitBranch, label: string, depth: number): ReactElement {
    const remote = isWorkbenchGitRemoteBranch(branch)
    const current = !remote && (branch.current || branch.name === currentBranch)
    const isSelected = selected === branch
    return (
      <div
        key={`${remote ? 'remote' : 'local'}:${branch.name}`}
        className={styles.gitBranchMenuRow}
        data-current={current || undefined}
        data-selected={isSelected || undefined}
        title={branch.name}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'touch') openHoveredBranch(branch)
        }}
        onPointerLeave={closeHoveredBranch}
      >
        <button
          type="button"
          className={styles.gitBranchMenuRowMain}
          style={{ paddingLeft: BranchRowPaddingPx + depth * BranchIndentStepPx }}
          data-git-menu-item
          data-git-branch-row
          aria-current={current || undefined}
          aria-expanded={isSelected}
          aria-controls={isSelected ? detailsId : undefined}
          onClick={(event) => {
            cancelHoverTimer()
            onSelectBranch(branch)
            if (event.detail === 0) {
              requestAnimationFrame(() => {
                const first = detailsRef.current?.querySelector<HTMLElement>(MenuItemSelector)
                ;(first ?? detailsRef.current)?.focus()
              })
            }
          }}
        >
          {switchingBranch === branch.name ? (
            <SpinnerGapIcon size={13} className={styles.spinIcon} />
          ) : (
            <GitBranchIcon size={13} weight={current ? 'fill' : 'regular'} />
          )}
          <span className={styles.gitBranchMenuBranchName}>{label}</span>
          {current && !!branch.upstream && <small>{branch.upstream}</small>}
          <CaretRightIcon size={11} aria-hidden="true" />
        </button>
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
          onClick={() => toggleFolder(node.key, expanded)}
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

  function renderDetails(branch: WorkspaceGitBranch): ReactElement {
    const pull = remoteActions.find((item) => item.action === 'pull')
    const push = remoteActions.find((item) => item.action === 'upload')
    const sync = remoteActions.find((item) => item.action === 'sync')
    return (
      <section
        ref={detailsRef}
        id={detailsId}
        className={styles.gitBranchMenuDetails}
        aria-label={t('workbench.gitBranchActions', { branch: branch.name })}
        tabIndex={-1}
        onPointerEnter={cancelHoverTimer}
        onPointerLeave={closeHoveredBranch}
      >
        <div className={styles.gitBranchMenuDetailsList}>
          {!selectedCurrent &&
            renderCommand('workbench.gitBranchCheckoutCreated', GitBranchIcon, () =>
              onSwitchBranch(branch)
            )}
          {renderCommand('workbench.gitBranchCreateFromSelected', PlusIcon, () =>
            onOpenCreateBranch(branch)
          )}
          {selectedCurrent &&
            pull &&
            renderRemoteAction(pull, running?.action === 'pull' ? running : null)}
          {!selectedRemote &&
            push &&
            renderRemoteAction(
              selectedCurrent
                ? push
                : {
                    ...push,
                    hint: branchesBlocked ?? branch.name,
                    disabled: !!branchesBlocked,
                    count: 0,
                  },
              runningInDetails && running?.action === 'upload' ? running : null,
              selectedCurrent ? undefined : branch
            )}
          {!selectedCurrent && canIntegrate && (
            <>
              {renderCommand('workbench.gitMergeIntoCurrent', GitMergeIcon, () =>
                onRunBranchOperation('merge', branch)
              )}
              {renderCommand('workbench.gitRebaseCurrentOnto', ArrowLineUpIcon, () =>
                onRunBranchOperation('rebase', branch)
              )}
            </>
          )}
          {selectedCurrent &&
            sync &&
            renderRemoteAction(sync, running?.action === 'sync' ? running : null)}
          <div className={styles.gitBranchMenuSeparator} />
          {renderCommand(
            'workbench.gitBranchShowLog',
            ClockCounterClockwiseIcon,
            () => onInspectBranch(branch, false),
            false
          )}
          {!selectedCurrent &&
            renderCommand(
              currentBranch ? 'workbench.gitBranchCompare' : 'workbench.gitBranchCompareWithHead',
              GitDiffIcon,
              () => onInspectBranch(branch, true),
              false
            )}
          {renderCommand(
            'workbench.gitBranchCopyName',
            CopyIcon,
            () => onCopyBranch(branch),
            false
          )}
          {!selectedRemote && (
            <>
              <div className={styles.gitBranchMenuSeparator} />
              {renderCommand('workbench.gitBranchRename', PencilSimpleIcon, () =>
                onOpenRenameBranch(branch)
              )}
              {!selectedCurrent &&
                renderCommand('workbench.gitBranchDelete', TrashIcon, () => onDeleteBranch(branch))}
            </>
          )}
        </div>
      </section>
    )
  }

  function renderCommand(
    key: string,
    CommandIcon: Icon,
    onClick: () => void,
    mutates = true
  ): ReactElement {
    return (
      <button
        type="button"
        className={styles.gitBranchMenuCommand}
        data-git-menu-item
        disabled={mutates && branchesLocked}
        title={mutates ? (branchesBlocked ?? undefined) : undefined}
        onClick={onClick}
      >
        <CommandIcon size={15} aria-hidden="true" />
        <span>{t(key)}</span>
      </button>
    )
  }

  return (
    <div ref={menuRef} className={styles.gitBranchMenu} onKeyDown={handleKeyDown}>
      <div className={styles.gitBranchMenuBrowser}>
        <div className={styles.gitBranchMenuSearch}>
          <SearchField
            ref={searchRef}
            size="sm"
            value={search}
            placeholder={t('workbench.gitBranchSearchPlaceholder')}
            aria-label={t('workbench.gitBranchSearchPlaceholder')}
            onChange={(event) => {
              cancelHoverTimer()
              const nextSearch = event.target.value
              if (selected && filterWorkbenchGitBranches([selected], nextSearch).length === 0)
                onSelectBranch(null)
              onSearchChange(nextSearch)
            }}
          />
          <div
            className={styles.gitBranchMenuActions}
            role="group"
            aria-label={t('workbench.gitRemoteActionsMenu')}
          >
            {remoteActions
              .filter((item) => item.action === 'fetch')
              .map((item) => renderRemoteAction(item, runningInDetails ? null : running))}
          </div>
        </div>
        {remoteNote && (
          <div className={styles.gitBranchMenuRemote}>
            <p className={styles.gitBranchMenuNote}>{remoteNote}</p>
          </div>
        )}
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
            onClick={() => onOpenCreateBranch()}
          >
            <PlusIcon size={14} />
            <span>{t('workbench.gitBranchCreateDialogTitle')}</span>
          </button>
        </div>
      </div>
      {selected && renderDetails(selected)}
    </div>
  )
}
