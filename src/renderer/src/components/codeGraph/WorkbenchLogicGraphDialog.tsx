import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  MagnifyingGlassIcon,
  MinusIcon,
  PlusIcon,
} from '@phosphor-icons/react'
import { useWorkbenchHostRuntime } from '@renderer/host'
import { useWorkbenchI18n } from '@renderer/i18n'

import { Button } from '@velaros-ai/ui/primitives/buttons/Button'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@velaros-ai/ui/primitives/overlays/Dialog'

import type { WorkbenchCodeGraphEdge, WorkbenchCodeGraphNode } from '@shared/contracts'
import {
  applyVelarLogicGraphResponse,
  parseVelarLogicGraphResponse,
  selectVelarLogicGraphNeighborhood,
  velarLogicGraphForWorkbench,
  type VelarLogicGraphSnapshot,
  VelarOwnershipGraphRequestId,
} from '@shared/contributions/velar/logicGraph'

import styles from '../../styles/workbenchPageStyles'
import type { WorkbenchOpenEditorTab } from '../../types/workbenchTypes'

const OverviewKinds = new Set([
  'module',
  'component',
  'state',
  'computed',
  'action',
  'function',
  'class',
  'type',
  'enum',
  'capability',
  'readonlyProjection',
])
const MaximumVisibleNodes = 320
const MaximumVisibleEdges = 900

interface WorkbenchLogicGraphDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectRoot: string
  selectedFilePath: Nullable<string>
  selectedContent: string
  openTabs: readonly WorkbenchOpenEditorTab[]
  projectFiles: ReadonlyArray<{ path: string }>
  codeGraphAvailable: boolean
  velarLogicGraphAvailable: boolean
  refreshVersion: number
  onOpenLocation: (path: string, line?: number, column?: number) => void
}

interface PositionedNode extends WorkbenchCodeGraphNode {
  x: number
  y: number
}

function nodeLayer(kind: string): number {
  if (kind === 'module') return 0
  if (['component', 'class', 'type', 'enum'].includes(kind)) return 1
  if (['function', 'action'].includes(kind)) return 2
  if (['state', 'computed', 'variable', 'member'].includes(kind)) return 3
  return 4
}

function positionNodes(nodes: readonly WorkbenchCodeGraphNode[]): {
  nodes: PositionedNode[]
  width: number
  height: number
} {
  const layers = new Map<number, WorkbenchCodeGraphNode[]>()
  for (const node of nodes) layers.set(nodeLayer(node.kind), [...(layers.get(nodeLayer(node.kind)) ?? []), node])
  const positioned: PositionedNode[] = []
  let rows = 1
  for (const [layer, values] of [...layers.entries()].sort((left, right) => left[0] - right[0])) {
    values.sort((left, right) => left.path.localeCompare(right.path) || left.label.localeCompare(right.label))
    rows = Math.max(rows, values.length)
    values.forEach((node, index) => positioned.push({
      ...node,
      x: 50 + layer * 250,
      y: 45 + index * 76,
    }))
  }
  return { nodes: positioned, width: 1_210, height: Math.max(560, rows * 76 + 70) }
}

function edgePath(from: PositionedNode, to: PositionedNode): string {
  const startX = from.x + 176
  const startY = from.y + 25
  const endX = to.x
  const endY = to.y + 25
  const bend = Math.max(42, Math.abs(endX - startX) * 0.42)
  const direction = endX >= startX ? 1 : -1
  return `M ${startX} ${startY} C ${startX + bend * direction} ${startY}, ${endX - bend * direction} ${endY}, ${endX} ${endY}`
}

function dirtyOpenFiles(openTabs: readonly WorkbenchOpenEditorTab[]) {
  return openTabs
    .filter((tab) => tab.content !== tab.file.content)
    .slice(0, 16)
    .map((tab) => ({ path: tab.path, content: tab.content }))
}

export function WorkbenchLogicGraphDialog({
  open,
  onOpenChange,
  projectRoot,
  selectedFilePath,
  selectedContent,
  openTabs,
  projectFiles,
  codeGraphAvailable,
  velarLogicGraphAvailable,
  refreshVersion,
  onOpenLocation,
}: WorkbenchLogicGraphDialogProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const runtime = useWorkbenchHostRuntime()
  const [snapshot, setSnapshot] = useState<VelarLogicGraphSnapshot | null>(null)
  const snapshotRef = useRef<VelarLogicGraphSnapshot | null>(null)
  const [fallbackNodes, setFallbackNodes] = useState<WorkbenchCodeGraphNode[]>([])
  const [fallbackEdges, setFallbackEdges] = useState<WorkbenchCodeGraphEdge[]>([])
  const [fallbackTruncated, setFallbackTruncated] = useState(false)
  const [focus, setFocus] = useState('')
  const [depth, setDepth] = useState(2)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestSequence = useRef(0)
  const velarPath = velarLogicGraphAvailable
    ? (selectedFilePath?.endsWith('.vel') ? selectedFilePath : null)
      ?? projectFiles.find((file) => file.path.endsWith('.vel'))?.path
      ?? openTabs.find((tab) => tab.path.endsWith('.vel'))?.path
      ?? null
    : null

  const load = useCallback(async (forceSnapshot = false): Promise<void> => {
    if (!open) return
    const sequence = ++requestSequence.current
    setLoading(true)
    setError(null)
    try {
      if (velarPath) {
        const activeTab = openTabs.find((tab) => tab.path === velarPath)
        const previous = forceSnapshot ? null : snapshotRef.current
        const response = await runtime.kernel.project.requestWorkbenchLanguageServiceExtension({
          projectRoot,
          path: velarPath,
          language: 'velar',
          content: activeTab?.content ?? (selectedFilePath === velarPath ? selectedContent : undefined),
          openFiles: dirtyOpenFiles(openTabs),
          requestId: VelarOwnershipGraphRequestId,
          parameters: {
            maximumNodes: 10_000,
            maximumEdges: 20_000,
            ...(previous ? { previousRevision: previous.revision } : {}),
          },
        })
        if (!response.ok) throw response.error
        const parsed = parseVelarLogicGraphResponse(response.data.result)
        if (!parsed) throw new Error(t('workbench.codeGraphError'))
        const next = applyVelarLogicGraphResponse(previous, parsed)
        if (!next && previous) {
          if (sequence === requestSequence.current) void load(true)
          return
        }
        if (!next) throw new Error(t('workbench.codeGraphError'))
        if (sequence !== requestSequence.current) return
        snapshotRef.current = next
        setSnapshot(next)
        setFallbackNodes([])
        setFallbackEdges([])
        setFallbackTruncated(false)
      } else if (codeGraphAvailable) {
        const response = await runtime.kernel.project.getWorkbenchCodeGraph({
          projectRoot,
          mode: 'full',
          maxNodes: MaximumVisibleNodes,
        })
        if (!response.ok) throw response.error
        if (sequence !== requestSequence.current) return
        setFallbackNodes(response.data.nodes)
        setFallbackEdges(response.data.edges)
        setFallbackTruncated(response.data.truncated)
      } else {
        throw new Error(t('workbench.codeGraphEmpty'))
      }
    } catch (reason) {
      if (sequence === requestSequence.current) {
        setError(reason instanceof Error ? reason.message : t('workbench.codeGraphError'))
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false)
    }
  }, [
    codeGraphAvailable,
    open,
    openTabs,
    projectRoot,
    runtime,
    selectedContent,
    selectedFilePath,
    t,
    velarPath,
  ])

  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => void load(), snapshotRef.current ? 120 : 0)
    return () => clearTimeout(timer)
  }, [load, open, refreshVersion])

  useEffect(() => {
    if (open) return
    requestSequence.current += 1
    setSelectedNodeId(null)
    setFocus('')
  }, [open])

  const graph = useMemo(() => {
    if (!snapshot) return { nodes: fallbackNodes, edges: fallbackEdges, truncated: fallbackTruncated }
    const selected = focus.trim()
      ? selectVelarLogicGraphNeighborhood(snapshot, focus, depth, MaximumVisibleNodes)
      : new Set(snapshot.nodes.filter((node) => OverviewKinds.has(node.kind)).slice(0, MaximumVisibleNodes).map((node) => node.id))
    const view = velarLogicGraphForWorkbench(projectRoot, snapshot, selected)
    return {
      nodes: view.nodes,
      edges: view.edges.slice(0, MaximumVisibleEdges),
      truncated: view.truncated || view.edges.length > MaximumVisibleEdges,
    }
  }, [depth, fallbackEdges, fallbackNodes, fallbackTruncated, focus, projectRoot, snapshot])
  const layout = useMemo(() => positionNodes(graph.nodes), [graph.nodes])
  const positionedById = useMemo(
    () => new Map(layout.nodes.map((node) => [node.id, node])),
    [layout.nodes]
  )
  const visibleEdges = graph.edges.flatMap((edge) => {
    const from = positionedById.get(edge.from)
    const to = positionedById.get(edge.to)
    return from && to ? [{ edge, from, to }] : []
  })
  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId) ?? null
  const selectedRelations = selectedNode
    ? graph.edges.filter((edge) => edge.from === selectedNode.id || edge.to === selectedNode.id)
    : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={styles.logicGraphDialog}>
        <DialogHeader className={styles.logicGraphHeader}>
          <div>
            <DialogTitle>{t('workbench.codeGraphTitle')}</DialogTitle>
            <DialogDescription>
              {snapshot
                ? t('workbench.logicGraphCompilerDescription')
                : t('workbench.codeGraphHint')}
            </DialogDescription>
          </div>
          <div className={styles.logicGraphActions}>
            <label className={styles.logicGraphSearch}>
              <MagnifyingGlassIcon size={15} />
              <input
                value={focus}
                placeholder={t('workbench.logicGraphSearchPlaceholder')}
                onChange={(event) => setFocus(event.target.value)}
              />
            </label>
            <label className={styles.logicGraphDepth}>
              {t('workbench.codeGraphDepth')}
              <select value={depth} onChange={(event) => setDepth(Number(event.target.value))}>
                {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <IconButton label={t('workbench.codeGraphReload')} title={t('workbench.codeGraphReload')} onClick={() => void load(true)}>
              <ArrowClockwiseIcon size={16} />
            </IconButton>
          </div>
        </DialogHeader>
        <div className={styles.logicGraphStatus}>
          <span data-active={snapshot?.activity.strategy === 'affected-modules'}>
            {loading
              ? t('workbench.codeGraphLoading')
              : snapshot
                ? t('workbench.logicGraphLiveStatus', {
                    modules: snapshot.activity.modulesVisited,
                    strategy: snapshot.activity.strategy === 'affected-modules'
                      ? t('workbench.logicGraphIncremental')
                      : t('workbench.logicGraphSnapshot'),
                  })
                : t('workbench.codeGraphNodes', { nodes: graph.nodes.length, edges: graph.edges.length })}
          </span>
          <span>{t('workbench.codeGraphNodes', { nodes: graph.nodes.length, edges: graph.edges.length })}</span>
          {graph.truncated && <span>{t('workbench.codeGraphTruncated')}</span>}
          <div className={styles.logicGraphZoom}>
            <IconButton label="Zoom out" title="Zoom out" onClick={() => setZoom((value) => Math.max(0.55, value - 0.1))}>
              <MinusIcon size={14} />
            </IconButton>
            <span>{Math.round(zoom * 100)}%</span>
            <IconButton label="Zoom in" title="Zoom in" onClick={() => setZoom((value) => Math.min(1.6, value + 0.1))}>
              <PlusIcon size={14} />
            </IconButton>
          </div>
        </div>
        <div className={styles.logicGraphBody}>
          <div className={styles.logicGraphViewport}>
            {error ? (
              <div className={styles.logicGraphMessage}>{error}</div>
            ) : !loading && graph.nodes.length === 0 ? (
              <div className={styles.logicGraphMessage}>{t('workbench.codeGraphEmpty')}</div>
            ) : (
              <svg
                className={styles.logicGraphCanvas}
                width={layout.width * zoom}
                height={layout.height * zoom}
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                role="img"
                aria-label={t('workbench.codeGraphTitle')}
              >
                <defs>
                  <marker id="logic-graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                    <path d="M 0 0 L 8 4 L 0 8 z" />
                  </marker>
                </defs>
                <g className={styles.logicGraphEdges}>
                  {visibleEdges.map(({ edge, from, to }) => (
                    <path key={edge.id ?? `${edge.from}:${edge.to}:${edge.kind}`} d={edgePath(from, to)}>
                      <title>{edge.kind}</title>
                    </path>
                  ))}
                </g>
                <g className={styles.logicGraphNodes}>
                  {layout.nodes.map((node) => (
                    <g
                      key={node.id}
                      transform={`translate(${node.x} ${node.y})`}
                      data-kind={node.kind}
                      data-selected={node.id === selectedNodeId}
                      tabIndex={0}
                      role="button"
                      onClick={() => setSelectedNodeId(node.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          setSelectedNodeId(node.id)
                        }
                      }}
                      onDoubleClick={() => node.path && onOpenLocation(node.path, node.line, node.column)}
                    >
                      <rect width="176" height="50" rx="8" />
                      <text x="12" y="20" className={styles.logicGraphNodeTitle}>{node.label}</text>
                      <text x="12" y="38" className={styles.logicGraphNodeMeta}>{node.kind}</text>
                      <title>{node.path || node.label}</title>
                    </g>
                  ))}
                </g>
              </svg>
            )}
          </div>
          <aside className={styles.logicGraphDetails}>
            {selectedNode ? (
              <>
                <div className={styles.logicGraphDetailHeading}>
                  <span>{selectedNode.kind}</span>
                  <strong>{selectedNode.label}</strong>
                </div>
                {selectedNode.path && <code>{selectedNode.path}</code>}
                {selectedNode.type && <div className={styles.logicGraphDetailType}>{selectedNode.type}</div>}
                {selectedNode.documentation && <p>{selectedNode.documentation}</p>}
                <div className={styles.logicGraphRelationList}>
                  {selectedRelations.slice(0, 80).map((edge) => {
                    const incoming = edge.to === selectedNode.id
                    const other = positionedById.get(incoming ? edge.from : edge.to)
                    return (
                      <button key={edge.id ?? `${edge.from}:${edge.to}:${edge.kind}`} onClick={() => setSelectedNodeId(other?.id ?? null)}>
                        <span>{incoming ? '←' : '→'} {edge.kind}</span>
                        <strong>{other?.label ?? (incoming ? edge.from : edge.to)}</strong>
                      </button>
                    )
                  })}
                </div>
                {selectedNode.path && (
                  <Button size="sm" onClick={() => onOpenLocation(selectedNode.path, selectedNode.line, selectedNode.column)}>
                    <ArrowSquareOutIcon size={15} />
                    {t('workbench.logicGraphOpenSource')}
                  </Button>
                )}
              </>
            ) : (
              <p>{t('workbench.logicGraphSelectHint')}</p>
            )}
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  )
}
