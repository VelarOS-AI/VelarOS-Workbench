import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { CaretDownIcon, CaretRightIcon, TreeStructureIcon, XIcon } from '@phosphor-icons/react'
import { useWorkbenchI18n } from '@renderer/i18n/WorkbenchLocalizationProvider'
import {
  canExpandWorkbenchCallHierarchyNode,
  listWorkbenchCallHierarchyRows,
  moveInWorkbenchCallHierarchy,
  type WorkbenchCallHierarchyNode,
  type WorkbenchCallHierarchyState,
} from '@renderer/models/editor/workbenchCallHierarchy'
import { workbenchDocumentSymbolGlyphMask } from '@renderer/models/editor/workbenchSymbolKindGlyphs'
import { workbenchSymbolLocationDisplayPath } from '@renderer/models/editor/workbenchSymbolLocations'

import { type WorkbenchLanguageServiceCallHierarchyDirection } from '@shared/contracts/workbench'

import styles from '../../styles/workbenchPageStyles'

interface EditorCallHierarchyPanelProps {
  projectRoot: string
  state: WorkbenchCallHierarchyState
  /** 展开 / 收起一个节点（第一次展开时去问它的下一层）。 */
  onToggle: (nodeId: string) => void
  /** 跳到一个节点：调用发生的那一处，或被调用的函数自己。 */
  onNavigate: (node: WorkbenchCallHierarchyNode) => void
  onDirectionChange: (direction: WorkbenchLanguageServiceCallHierarchyDirection) => void
  onClose: () => void
  /** 关掉时键盘焦点还在面板里：交还给编辑器。 */
  onFocusEditor: () => void
}

const Directions: readonly WorkbenchLanguageServiceCallHierarchyDirection[] = ['incoming', 'outgoing']

/**
 * 调用层次：光标处的函数是根，下面一层一层是调用它的函数（或它调用的函数）。停在编辑器的右上角，跳到别的
 * 文件、接着打字它都留着，Esc 或关闭按钮收起。
 *
 * 键盘：↑↓ 挪一行，→ 展开（已经展开就进到下一层），← 收起（已经收起就回上一层），回车跳过去。
 */
export function EditorCallHierarchyPanel({
  projectRoot,
  state,
  onToggle,
  onNavigate,
  onDirectionChange,
  onClose,
  onFocusEditor,
}: EditorCallHierarchyPanelProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const panelRef = useRef<HTMLElement>(null)
  const rows = useMemo(() => listWorkbenchCallHierarchyRows(state), [state])
  const root = state.nodes.get(state.rootId)
  const [activeId, setActiveId] = useState(state.rootId)
  const activeIndex = Math.max(0, rows.findIndex((row) => row.id === activeId))

  const focusRow = (index: number): void => {
    const row = rows[index]
    if (!row) return
    setActiveId(row.id)
    const element = panelRef.current?.querySelector<HTMLElement>(`[data-row-index="${index}"]`)
    element?.focus()
    element?.scrollIntoView({ block: 'nearest' })
  }

  // 面板一出来键盘焦点放到根上，接着就能用方向键看。（换一棵树、换个方向，面板是重新挂上的。）
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('[data-row-index="0"]')?.focus({ preventScroll: true })
  }, [])

  const close = (): void => {
    const hadFocus = !!panelRef.current?.contains(document.activeElement)
    onClose()
    if (hadFocus) onFocusEditor()
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    // 方向切换按钮、关闭按钮上的按键归它们自己。
    if (!(event.target instanceof HTMLElement) || !event.target.hasAttribute('data-row-index')) return

    const node = rows[activeIndex]
    if (event.key === 'Enter') {
      event.preventDefault()
      if (node) onNavigate(node)
      return
    }
    if (
      event.key !== 'ArrowUp'
      && event.key !== 'ArrowDown'
      && event.key !== 'ArrowLeft'
      && event.key !== 'ArrowRight'
    ) return

    event.preventDefault()
    const move = moveInWorkbenchCallHierarchy(rows, activeIndex, event.key)
    if (!move) return
    if ('toggle' in move) onToggle(move.toggle)
    else focusRow(move.index)
  }

  const emptyMessage =
    root && !root.loading && root.childIds?.length === 0
      ? t(
          state.direction === 'incoming'
            ? 'workbench.callHierarchyNoCallers'
            : 'workbench.callHierarchyNoCallees'
        )
      : null

  return (
    <section
      ref={panelRef}
      className={`${styles.editorSymbolLocationsPanel} ${styles.editorCallHierarchyPanel}`}
      aria-label={t('workbench.callHierarchyTitle')}
      onKeyDown={handleKeyDown}
    >
      <header className={styles.editorSymbolLocationsHeader}>
        <div className={styles.editorSymbolLocationsTitle}>
          <TreeStructureIcon size={14} />
          <strong>{root?.item.name}</strong>
        </div>
        <div className={styles.editorCallHierarchyDirections}>
          {Directions.map((direction) => (
            <button
              key={direction}
              type="button"
              aria-pressed={state.direction === direction}
              data-active={state.direction === direction ? 'true' : undefined}
              onClick={() => onDirectionChange(direction)}
            >
              {t(
                direction === 'incoming'
                  ? 'workbench.callHierarchyIncoming'
                  : 'workbench.callHierarchyOutgoing'
              )}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={styles.editorSymbolLocationsClose}
          aria-label={t('workbench.callHierarchyClose')}
          title={t('workbench.callHierarchyClose')}
          onClick={close}
        >
          <XIcon size={14} />
        </button>
      </header>

      <div className={styles.editorSymbolLocationsBody} role="tree" aria-label={t('workbench.callHierarchyTitle')}>
        {rows.map((node, index) => {
          const expandable = canExpandWorkbenchCallHierarchyNode(node)
          const mask = workbenchDocumentSymbolGlyphMask(node.item.kind)
          const displayPath = workbenchSymbolLocationDisplayPath(projectRoot, node.item.path)
          return (
            <div
              key={node.id}
              role="treeitem"
              aria-level={node.depth + 1}
              aria-expanded={expandable ? node.expanded : undefined}
              aria-selected={index === activeIndex}
              tabIndex={index === activeIndex ? 0 : -1}
              className={styles.editorCallHierarchyRow}
              data-row-index={index}
              data-active={index === activeIndex ? 'true' : undefined}
              style={{ paddingLeft: 6 + node.depth * 14 }}
              title={`${displayPath}:${node.item.line}`}
              onFocus={() => setActiveId(node.id)}
              onClick={() => {
                setActiveId(node.id)
                onNavigate(node)
              }}
            >
              <button
                type="button"
                tabIndex={-1}
                className={styles.editorCallHierarchyTwisty}
                data-loading={node.loading ? 'true' : undefined}
                disabled={!expandable || node.loading}
                aria-label={t(
                  node.expanded ? 'workbench.callHierarchyCollapse' : 'workbench.callHierarchyExpand'
                )}
                onClick={(event) => {
                  event.stopPropagation()
                  setActiveId(node.id)
                  onToggle(node.id)
                }}
              >
                {expandable &&
                  (node.expanded ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />)}
              </button>
              <span
                className={styles.quickOpenSymbolIcon}
                data-kind={node.item.kind}
                style={{ maskImage: mask, WebkitMaskImage: mask }}
                aria-hidden="true"
              />
              <span className={styles.editorCallHierarchyName}>
                {node.item.containerName ? `${node.item.containerName}.` : ''}
                {node.item.name}
              </span>
              <span className={styles.editorCallHierarchyMeta}>
                {node.error
                  ?? (node.recursive
                    ? t('workbench.callHierarchyRecursive')
                    : `${displayPath}:${node.item.line}${node.sites.length > 1 ? ` · ×${node.sites.length}` : ''}`)}
              </span>
            </div>
          )
        })}
        {emptyMessage && <div className={styles.editorSymbolLocationsEmpty}>{emptyMessage}</div>}
      </div>
    </section>
  )
}
