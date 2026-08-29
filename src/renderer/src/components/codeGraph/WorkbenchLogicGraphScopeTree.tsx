import {
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  CaretDownIcon,
  CaretRightIcon,
  CubeIcon,
  DatabaseIcon,
  FolderIcon,
  FolderOpenIcon,
  FunctionIcon,
  ShapesIcon,
} from '@phosphor-icons/react'

import type {
  VelarLogicGraphNode,
  VelarLogicGraphSnapshot,
} from '@shared/contributions/velar/logicGraph'

import styles from '../../styles/workbenchPageStyles'
import { WorkbenchFileTypeIcon } from '../files/WorkbenchFileTypeIcon'

interface WorkbenchLogicGraphScopeTreeProps {
  files: ReadonlyArray<{ path: string }>
  snapshot: Nullable<VelarLogicGraphSnapshot>
  selectedPaths: readonly string[]
  onSelectionChange: (paths: readonly string[]) => void
}

type ScopeTreeNodeKind = 'directory' | 'file' | 'symbol'

interface ScopeTreeNode {
  key: string
  selection: string
  path: string
  name: string
  kind: ScopeTreeNodeKind
  symbolKind?: string
  line?: number
  children: ScopeTreeNode[]
}

const HiddenPathSegments = new Set([
  '.git',
  '.velar',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'release',
])

const StructuralKinds = new Set([
  'action',
  'class',
  'component',
  'computed',
  'enum',
  'function',
  'method',
  'state',
  'type',
])

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

export function isRelevantVelarPath(path: string): boolean {
  const normalized = normalizePath(path)
  const lowerPath = normalized.toLowerCase()
  if (!normalized.endsWith('.vel')) return false
  if (/(?:^|\/)\.[^/]+(?:\/|$)/.test(normalized)) return false
  if (/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/.test(lowerPath)) return false
  if (/(?:\.test|\.spec|_test|-test)\.vel$/.test(lowerPath)) return false
  return !normalized.split('/').some((segment) => HiddenPathSegments.has(segment))
}

function sortTreeNodes(left: ScopeTreeNode, right: ScopeTreeNode): number {
  if (left.kind !== right.kind) {
    if (left.kind === 'directory') return -1
    if (right.kind === 'directory') return 1
    if (left.kind === 'file') return -1
    return 1
  }
  if (left.kind === 'symbol')
    return (
      (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER) ||
      left.name.localeCompare(right.name)
    )
  return left.name.localeCompare(right.name)
}

function buildSymbolTrees(
  snapshot: Nullable<VelarLogicGraphSnapshot>
): Map<string, ScopeTreeNode[]> {
  if (!snapshot) return new Map()

  const sourceNodes = snapshot.nodes.filter(
    (node) => !!node.path && isRelevantVelarPath(node.path) && StructuralKinds.has(node.kind)
  )
  const graphNodes = new Map(sourceNodes.map((node) => [node.id, node]))
  const childrenByOwner = new Map<string, string[]>()
  const ownedIds = new Set<string>()
  for (const edge of snapshot.edges) {
    if (edge.kind !== 'owns') continue
    const owner = graphNodes.get(edge.from)
    const child = graphNodes.get(edge.to)
    if (!owner?.path || !child?.path || normalizePath(owner.path) !== normalizePath(child.path)) {
      continue
    }
    childrenByOwner.set(edge.from, [...(childrenByOwner.get(edge.from) ?? []), edge.to])
    ownedIds.add(edge.to)
  }

  const toTreeNode = (node: VelarLogicGraphNode, ancestors = new Set<string>()): ScopeTreeNode => {
    const nextAncestors = new Set(ancestors).add(node.id)
    const children = (childrenByOwner.get(node.id) ?? [])
      .filter((id) => !nextAncestors.has(id))
      .flatMap((id) => {
        const child = graphNodes.get(id)
        return child ? [toTreeNode(child, nextAncestors)] : []
      })
      .sort(sortTreeNodes)
    return {
      key: node.id,
      selection: node.id,
      path: normalizePath(node.path ?? ''),
      name: node.name,
      kind: 'symbol',
      symbolKind: node.kind,
      line: node.selectionRange?.start.line,
      children,
    }
  }

  const byFile = new Map<string, ScopeTreeNode[]>()
  for (const node of sourceNodes) {
    if (ownedIds.has(node.id)) continue
    const path = normalizePath(node.path ?? '')
    byFile.set(path, [...(byFile.get(path) ?? []), toTreeNode(node)].sort(sortTreeNodes))
  }
  return byFile
}

function buildScopeTree(
  files: ReadonlyArray<{ path: string }>,
  snapshot: Nullable<VelarLogicGraphSnapshot>
): ScopeTreeNode[] {
  const symbolsByFile = buildSymbolTrees(snapshot)
  const paths = new Set<string>()
  for (const file of files) {
    if (isRelevantVelarPath(file.path)) paths.add(normalizePath(file.path))
  }
  for (const node of snapshot?.nodes ?? []) {
    if (node.path && isRelevantVelarPath(node.path)) paths.add(normalizePath(node.path))
  }

  const roots: ScopeTreeNode[] = []
  const directories = new Map<string, ScopeTreeNode>()
  for (const filePath of paths) {
    const segments = filePath.split('/').filter(Boolean)
    let children = roots
    let parentPath = ''
    segments.forEach((segment, index) => {
      const path = parentPath ? `${parentPath}/${segment}` : segment
      const kind: ScopeTreeNodeKind = index === segments.length - 1 ? 'file' : 'directory'
      if (kind === 'file') {
        if (!children.some((node) => node.path === path)) {
          children.push({
            key: `file:${path}`,
            selection: path,
            path,
            name: segment,
            kind,
            children: symbolsByFile.get(path) ?? [],
          })
        }
      } else {
        let directory = directories.get(path)
        if (!directory) {
          directory = {
            key: `directory:${path}`,
            selection: path,
            path,
            name: segment,
            kind,
            children: [],
          }
          directories.set(path, directory)
          children.push(directory)
        }
        children = directory.children
      }
      parentPath = path
    })
  }

  function sortNodes(nodes: ScopeTreeNode[]): ScopeTreeNode[] {
    nodes.sort(sortTreeNodes)
    nodes.forEach((node) => sortNodes(node.children))
    return nodes
  }
  return sortNodes(roots)
}

function collectDirectoryKeys(nodes: readonly ScopeTreeNode[], target: Set<string>): void {
  for (const node of nodes) {
    if (node.kind !== 'directory') continue
    target.add(node.key)
    collectDirectoryKeys(node.children, target)
  }
}

function symbolIcon(kind: string | undefined): ReactNode {
  if (kind === 'component' || kind === 'class') return <CubeIcon size={13} />
  if (kind === 'function' || kind === 'method' || kind === 'action')
    return <FunctionIcon size={13} />
  if (kind === 'state' || kind === 'computed' || kind === 'variable' || kind === 'member')
    return <DatabaseIcon size={13} />
  return <ShapesIcon size={13} />
}

interface ScopeTreeBranchProps {
  nodes: readonly ScopeTreeNode[]
  depth: number
  expandedPaths: ReadonlySet<string>
  selectedPaths: ReadonlySet<string>
  onSelectNode: (node: ScopeTreeNode, additive: boolean) => void
  onTogglePath: (path: string) => void
}

function ScopeTreeBranch({
  nodes,
  depth,
  expandedPaths,
  selectedPaths,
  onSelectNode,
  onTogglePath,
}: ScopeTreeBranchProps): ReactElement {
  return (
    <>
      {nodes.map((node) => {
        const expandable = node.children.length > 0
        const expanded = expandable && expandedPaths.has(node.key)
        return (
          <div key={node.key}>
            <button
              type="button"
              className={styles.logicGraphScopeTreeRow}
              data-active={
                selectedPaths.has(node.selection) ||
                (depth === 0 && node.kind === 'directory' && selectedPaths.size === 0)
              }
              data-kind={node.kind}
              aria-expanded={expandable ? expanded : undefined}
              title={node.kind === 'symbol' ? `${node.name} · ${node.path}` : node.path}
              style={{ paddingLeft: 7 + depth * 14 }}
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                onSelectNode(node, event.metaKey || event.ctrlKey)
                if (expandable) onTogglePath(node.key)
              }}
            >
              {expandable ? (
                expanded ? (
                  <CaretDownIcon size={12} />
                ) : (
                  <CaretRightIcon size={12} />
                )
              ) : (
                <span className={styles.logicGraphScopeTreeSpacer} />
              )}
              {node.kind === 'directory' ? (
                expanded ? (
                  <FolderOpenIcon size={14} />
                ) : (
                  <FolderIcon size={14} />
                )
              ) : node.kind === 'file' ? (
                <WorkbenchFileTypeIcon fileName={node.name} size={14} />
              ) : (
                symbolIcon(node.symbolKind)
              )}
              <span className={styles.logicGraphScopeTreeLabel}>{node.name}</span>
              {node.kind === 'file' && node.children.length > 0 && (
                <small>{node.children.length}</small>
              )}
            </button>
            {expanded && (
              <ScopeTreeBranch
                nodes={node.children}
                depth={depth + 1}
                expandedPaths={expandedPaths}
                selectedPaths={selectedPaths}
                onSelectNode={onSelectNode}
                onTogglePath={onTogglePath}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

export function WorkbenchLogicGraphScopeTree({
  files,
  snapshot,
  selectedPaths,
  onSelectionChange,
}: WorkbenchLogicGraphScopeTreeProps): ReactElement {
  const tree = useMemo(() => buildScopeTree(files, snapshot), [files, snapshot])
  const selectedPathSet = useMemo(() => new Set(selectedPaths), [selectedPaths])
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set())
  const initializedExpansionRef = useRef(false)

  useEffect(() => {
    if (initializedExpansionRef.current || tree.length === 0) return
    const directoryKeys = new Set<string>()
    collectDirectoryKeys(tree, directoryKeys)
    initializedExpansionRef.current = true
    setExpandedPaths(directoryKeys)
  }, [tree])

  function togglePath(path: string): void {
    setExpandedPaths((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function selectNode(node: ScopeTreeNode, additive: boolean): void {
    if (!additive) {
      onSelectionChange([node.selection])
      return
    }
    const next = new Set(selectedPaths)
    if (next.has(node.selection)) next.delete(node.selection)
    else next.add(node.selection)
    onSelectionChange([...next])
  }

  return (
    <div className={styles.logicGraphScopeTree} role="tree">
      <ScopeTreeBranch
        nodes={tree}
        depth={0}
        expandedPaths={expandedPaths}
        selectedPaths={selectedPathSet}
        onSelectNode={selectNode}
        onTogglePath={togglePath}
      />
    </div>
  )
}
