import {
  createContext,
  type CSSProperties,
  type KeyboardEvent,
  memo,
  type MouseEvent,
  type ReactElement,
  useContext,
  useEffect,
  useRef,
} from 'react'
import {
  CaretDownIcon,
  CaretRightIcon,
  FolderIcon,
  FolderOpenIcon,
  PlayCircleIcon,
} from '@phosphor-icons/react'
import { type FileTreeNodeData } from '@renderer/models/files/fileTree.model'
import { isWorkbenchTestFilePath } from '@renderer/models/files/workbenchTestFile'
import type { WorkbenchGitDecorationMap } from '@renderer/models/git/workbenchGitModel'
import { isWorkbenchTreeRoot } from '@renderer/models/shared/workbenchUtils'
import type { NodeRendererProps } from 'react-arborist'

import { isNumber } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import { StyleUtils } from '@velaros-ai/ui'
import { Input } from '@velaros-ai/ui/primitives/forms/Input'

import type { WorkbenchDirectoryEntry } from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'

import { WorkbenchFileTypeIcon } from './WorkbenchFileTypeIcon'

const cx = StyleUtils.bindCx(styles)

/** 树缩进之后的额外内缩，会再按内容左侧裁剪量向面板边缘收紧。 */
const TREE_ROW_SIDE_GUTTER = 4
const TREE_ROW_ROOT_SIDE_GUTTER = 2
/** 将目录行进一步左移；只扣减前导留白，尾部留白不变。 */
const TREE_ROW_CONTENT_LEFT_TRIM_PX = 4

function arboristTreeRowOuterStyle(
  style: CSSProperties | undefined,
  entry: Pick<WorkbenchDirectoryEntry, 'path'>
): CSSProperties {
  const base = style ?? {}
  const indent = isNumber(base.paddingLeft)
    ? base.paddingLeft
    : Number.parseFloat(String(base.paddingLeft ?? '0')) || 0

  const rawLeading = isWorkbenchTreeRoot(entry) ? TREE_ROW_ROOT_SIDE_GUTTER : TREE_ROW_SIDE_GUTTER
  const leadingGutter = Math.max(0, rawLeading - TREE_ROW_CONTENT_LEFT_TRIM_PX)

  return {
    ...base,
    paddingLeft: indent + leadingGutter,
    paddingRight: TREE_ROW_SIDE_GUTTER,
  }
}

export interface FileTreeRowRuntime {
  collapseDirectoryLabel: string
  expandDirectoryLabel: string
  gitDecorations: WorkbenchGitDecorationMap
  isMutatingTree: boolean
  onContextMenuEntry: (entry: WorkbenchDirectoryEntry, event: MouseEvent) => void
}

export const FileTreeRowRuntimeContext = createContext<Nullable<FileTreeRowRuntime>>(null)

export const FileTreeRow = memo(function FileTreeRow({
  node,
  style,
  dragHandle,
}: NodeRendererProps<FileTreeNodeData>): ReactElement {
  const runtime = useContext(FileTreeRowRuntimeContext)
  if (!runtime) throw new AppError('INVARIANT', '文件树行缺少运行时上下文')

  const {
    collapseDirectoryLabel,
    expandDirectoryLabel,
    gitDecorations,
    isMutatingTree,
    onContextMenuEntry,
  } = runtime
  const inputRef = useRef<HTMLInputElement>(null)
  const entry = node.data.entry
  const canExpandDirectory = entry.type === 'directory' && entry.hasChildren
  const showExpandDisclosure = canExpandDirectory && !isWorkbenchTreeRoot(entry)
  const expanded = canExpandDirectory && node.isOpen
  const gitDecoration = gitDecorations.get(entry.path)
  const isGitIgnored = !!entry.gitIgnored
  const fileKind = node.data.fileKind
  const isTreeRoot = isWorkbenchTreeRoot(entry)
  const isTestFile = entry.type === 'file' && isWorkbenchTestFilePath(entry.path)

  useEffect(() => {
    if (!node.isEditing) return

    inputRef.current?.focus()
    inputRef.current?.select()
  }, [node.isEditing])

  function submitEdit(): void {
    const nextName = inputRef.current?.value ?? ''
    node.submit(nextName)
  }

  function handleEditKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      node.reset()
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      submitEdit()
    }
  }

  return (
    <div
      ref={dragHandle}
      className={cx(
        'treeRow',
        'arboristTreeRow',
        node.isSelected && 'treeRowSelected',
        node.isFocused && 'arboristTreeRowFocused',
        node.isDragging && 'arboristTreeRowDragging',
        node.willReceiveDrop && 'arboristTreeRowDropTarget',
        isGitIgnored && 'treeRowIgnored'
      )}
      data-tree-path={entry.path}
      data-tree-kind={entry.type}
      data-tree-root={isTreeRoot || undefined}
      data-git-tone={entry.type === 'file' ? gitDecoration?.tone : undefined}
      data-excluded={isGitIgnored || undefined}
      style={arboristTreeRowOuterStyle(style, entry)}
      onContextMenu={(event) => onContextMenuEntry(entry, event)}
    >
      {entry.type === 'directory' ? (
        <>
          {showExpandDisclosure ? (
            <button
              type="button"
              className={styles.treeDisclosureButton}
              aria-label={expanded ? collapseDirectoryLabel : expandDirectoryLabel}
              title={expanded ? collapseDirectoryLabel : expandDirectoryLabel}
              disabled={isMutatingTree}
              onClick={(event) => {
                event.stopPropagation()
                node.toggle()
              }}
            >
              {expanded ? <CaretDownIcon size={13} /> : <CaretRightIcon size={13} />}
            </button>
          ) : (
            !isWorkbenchTreeRoot(entry) && <span className={styles.treeSpacer} />
          )}
          <span className={styles.treeFolderIcon}>
            {expanded ? <FolderOpenIcon size={15} /> : <FolderIcon size={15} />}
          </span>
        </>
      ) : (
        <>
          <span className={styles.treeSpacer} />
          <span
            className={styles.treeFileIcon}
            data-kind={fileKind}
            data-test-file={isTestFile || undefined}
          >
            <WorkbenchFileTypeIcon
              fileName={entry.name}
              size={15}
              weight="regular"
              color="currentColor"
            />
            {isTestFile && (
              <PlayCircleIcon
                size={8}
                weight="fill"
                className={styles.treeTestFileBadge}
                aria-hidden="true"
              />
            )}
          </span>
        </>
      )}
      {node.isEditing ? (
        <Input
          ref={inputRef}
          variant="ghost"
          size="sm"
          className={styles.treeInlineInput}
          defaultValue={entry.name}
          disabled={isMutatingTree}
          onBlur={() => node.reset()}
          onKeyDown={handleEditKeyDown}
          onMouseDown={(event) => event.stopPropagation()}
        />
      ) : (
        <span className={styles.treeName}>{entry.name}</span>
      )}
    </div>
  )
})
