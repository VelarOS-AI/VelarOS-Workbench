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

import type { WorkbenchCodeGraphNode } from '@shared/contracts'
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

const MaximumVisibleNodes = 120
const MaximumVisibleEdges = 240

interface WorkbenchLogicGraphDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectRoot: string
  selectedFilePath: Nullable<string>
  selectedContent: string
  openTabs: readonly WorkbenchOpenEditorTab[]
  projectFiles: ReadonlyArray<{ path: string }>
  refreshVersion: number
  onOpenLocation: (path: string, line?: number, column?: number) => void
}

interface PositionedNode extends WorkbenchCodeGraphNode {
  x: number
  y: number
}

type LogicGraphLayer = 'business' | 'modules' | 'execution' | 'state' | 'detail'
type LogicGraphDirection = 'incoming' | 'outgoing' | 'both'

interface PositionedContextLane {
  name: string
  y: number
  height: number
}

interface LogicGraphLayout {
  nodes: PositionedNode[]
  lanes: PositionedContextLane[]
  width: number
  height: number
}

const LogicGraphLayers: readonly LogicGraphLayer[] = [
  'business',
  'modules',
  'execution',
  'state',
  'detail',
]

const LayerRelationKinds: Record<LogicGraphLayer, ReadonlySet<string>> = {
  business: new Set(['owns', 'calls', 'reads', 'writes', 'derives', 'crossesCapability']),
  modules: new Set(['imports']),
  execution: new Set(['owns', 'calls', 'crossesCapability']),
  state: new Set(['owns', 'reads', 'writes', 'derives', 'projectsReadonly']),
  detail: new Set([
    'imports',
    'owns',
    'reads',
    'writes',
    'derives',
    'calls',
    'crossesCapability',
    'projectsReadonly',
  ]),
}

const LayerNodeKinds: Record<LogicGraphLayer, ReadonlySet<string> | null> = {
  business: new Set(['component', 'action', 'function', 'state', 'computed', 'capability']),
  modules: new Set(['module', 'capability']),
  execution: new Set(['component', 'action', 'function', 'capability']),
  state: new Set([
    'component',
    'action',
    'function',
    'state',
    'computed',
    'variable',
    'member',
    'readonlyProjection',
  ]),
  detail: null,
}

function nodeLayer(kind: string, layer: LogicGraphLayer): number {
  if (layer === 'business') {
    if (kind === 'component') return 0
    if (kind === 'action' || kind === 'function') return 1
    if (kind === 'state' || kind === 'computed') return 2
    if (kind === 'capability') return 3
    return 4
  }
  if (layer === 'modules') return kind === 'module' ? 0 : 1
  if (layer === 'execution') {
    if (kind === 'component') return 0
    if (kind === 'action' || kind === 'function') return 1
    if (kind === 'capability') return 2
    return 3
  }
  if (layer === 'state') {
    if (kind === 'component') return 0
    if (kind === 'action' || kind === 'function') return 1
    if (kind === 'state' || kind === 'variable' || kind === 'member') return 2
    if (kind === 'computed' || kind === 'readonlyProjection') return 3
    return 4
  }
  if (kind === 'module') return 0
  if (['component', 'class', 'type', 'enum'].includes(kind)) return 1
  if (['function', 'action'].includes(kind)) return 2
  if (['state', 'computed', 'variable', 'member'].includes(kind)) return 3
  return 4
}

function positionNodes(
  nodes: readonly WorkbenchCodeGraphNode[],
  layer: LogicGraphLayer,
  inferredContextLabel: string
): LogicGraphLayout {
  if (layer === 'business') {
    const grouped = new Map<string, WorkbenchCodeGraphNode[]>()
    for (const node of nodes) {
      const context = node.context?.trim() || inferredContextLabel
      grouped.set(context, [...(grouped.get(context) ?? []), node])
    }
    const entries = [...grouped.entries()].sort(([left], [right]) => {
      if (left === inferredContextLabel) return 1
      if (right === inferredContextLabel) return -1
      return left.localeCompare(right)
    })
    const positioned: PositionedNode[] = []
    const lanes: PositionedContextLane[] = []
    let laneY = 22
    for (const [name, values] of entries) {
      const columns = new Map<number, WorkbenchCodeGraphNode[]>()
      for (const node of values) {
        const column = nodeLayer(node.kind, layer)
        columns.set(column, [...(columns.get(column) ?? []), node])
      }
      const rows = Math.max(1, ...[...columns.values()].map((items) => items.length))
      const height = Math.max(116, 58 + rows * 70)
      lanes.push({ name, y: laneY, height })
      for (const [column, items] of columns) {
        items.sort((left, right) => left.path.localeCompare(right.path) || left.label.localeCompare(right.label))
        items.forEach((node, index) => positioned.push({
          ...node,
          x: 150 + column * 245,
          y: laneY + 38 + index * 70,
        }))
      }
      laneY += height + 18
    }
    return {
      nodes: positioned,
      lanes,
      width: 1_290,
      height: Math.max(560, laneY + 18),
    }
  }
  const layers = new Map<number, WorkbenchCodeGraphNode[]>()
  for (const node of nodes) {
    const column = nodeLayer(node.kind, layer)
    layers.set(column, [...(layers.get(column) ?? []), node])
  }
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
  return { nodes: positioned, lanes: [], width: 1_210, height: Math.max(560, rows * 76 + 70) }
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

function compactGraphText(value: string, maximum = 24): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`
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
  refreshVersion,
  onOpenLocation,
}: WorkbenchLogicGraphDialogProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const runtime = useWorkbenchHostRuntime()
  const [snapshot, setSnapshot] = useState<VelarLogicGraphSnapshot | null>(null)
  const snapshotRef = useRef<VelarLogicGraphSnapshot | null>(null)
  const [focus, setFocus] = useState('')
  const [depth, setDepth] = useState(1)
  const [layer, setLayer] = useState<LogicGraphLayer>('business')
  const [direction, setDirection] = useState<LogicGraphDirection>('both')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestSequence = useRef(0)
  const velarPath = (selectedFilePath?.endsWith('.vel') ? selectedFilePath : null)
    ?? openTabs.find((tab) => tab.path.endsWith('.vel'))?.path
    ?? projectFiles.find((file) => file.path.endsWith('.vel'))?.path
    ?? null

  const load = useCallback(async (forceSnapshot = false): Promise<void> => {
    if (!open) return
    const sequence = ++requestSequence.current
    setLoading(true)
    setError(null)
    try {
      if (!velarPath) throw new Error(t('workbench.codeGraphEmpty'))
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
    } catch (reason) {
      if (sequence === requestSequence.current) {
        setError(reason instanceof Error ? reason.message : t('workbench.codeGraphError'))
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false)
    }
  }, [
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
    if (!open || !velarPath) return
    setFocus(velarPath)
    setDepth(1)
  }, [open, velarPath])

  useEffect(() => {
    if (open) return
    requestSequence.current += 1
    setSelectedNodeId(null)
    setFocus('')
    setDepth(1)
    setLayer('business')
    setDirection('both')
  }, [open])

  const projectedSnapshot = useMemo(() => {
    if (!snapshot) return null
    const nodeKinds = LayerNodeKinds[layer]
    const nodes = nodeKinds
      ? snapshot.nodes.filter((node) => nodeKinds.has(node.kind))
      : snapshot.nodes
    const nodeIds = new Set(nodes.map((node) => node.id))
    const relationKinds = LayerRelationKinds[layer]
    const edges = snapshot.edges.filter((edge) =>
      relationKinds.has(edge.kind) && nodeIds.has(edge.from) && nodeIds.has(edge.to))
    return { ...snapshot, nodes, edges }
  }, [layer, snapshot])

  const graph = useMemo(() => {
    if (!projectedSnapshot) return { nodes: [], edges: [], truncated: false }
    const focusQuery = focus.trim() || velarPath || ''
    const selected = focusQuery
      ? selectVelarLogicGraphNeighborhood(
          projectedSnapshot,
          focusQuery,
          depth,
          MaximumVisibleNodes,
          { direction, relationKinds: LayerRelationKinds[layer] }
        )
      : new Set<string>()
    const view = velarLogicGraphForWorkbench(projectRoot, projectedSnapshot, selected)
    return {
      nodes: view.nodes,
      edges: view.edges.slice(0, MaximumVisibleEdges),
      truncated: view.truncated || view.edges.length > MaximumVisibleEdges,
    }
  }, [depth, direction, focus, layer, projectRoot, projectedSnapshot, velarPath])
  const inferredContextLabel = t('workbench.logicGraphInferredContext')
  const layout = useMemo(
    () => positionNodes(graph.nodes, layer, inferredContextLabel),
    [graph.nodes, inferredContextLabel, layer]
  )
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
  const contextCount = new Set(graph.nodes.flatMap((node) => node.context ? [node.context] : [])).size
  const layerLabels: Record<LogicGraphLayer, { label: string; description: string }> = {
    business: {
      label: t('workbench.logicGraphLayerBusiness'),
      description: t('workbench.logicGraphLayerBusinessDescription'),
    },
    modules: {
      label: t('workbench.logicGraphLayerModules'),
      description: t('workbench.logicGraphLayerModulesDescription'),
    },
    execution: {
      label: t('workbench.logicGraphLayerExecution'),
      description: t('workbench.logicGraphLayerExecutionDescription'),
    },
    state: {
      label: t('workbench.logicGraphLayerState'),
      description: t('workbench.logicGraphLayerStateDescription'),
    },
    detail: {
      label: t('workbench.logicGraphLayerDetail'),
      description: t('workbench.logicGraphLayerDetailDescription'),
    },
  }
  const relationLabels: Record<string, string> = {
    imports: t('workbench.logicGraphRelationImports'),
    owns: t('workbench.logicGraphRelationOwns'),
    reads: t('workbench.logicGraphRelationReads'),
    writes: t('workbench.logicGraphRelationWrites'),
    derives: t('workbench.logicGraphRelationDerives'),
    calls: t('workbench.logicGraphRelationCalls'),
    crossesCapability: t('workbench.logicGraphRelationCapability'),
    projectsReadonly: t('workbench.logicGraphRelationReadonly'),
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={styles.logicGraphDialog}>
        <DialogHeader className={styles.logicGraphHeader}>
          <div>
            <DialogTitle>{t('workbench.velarLogicGraphTitle')}</DialogTitle>
            <DialogDescription>{t('workbench.logicGraphCompilerDescription')}</DialogDescription>
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
        <div className={styles.logicGraphLayerBar}>
          <div className={styles.logicGraphLayerTabs} role="tablist" aria-label={t('workbench.logicGraphLayers')}>
            {LogicGraphLayers.map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={layer === item}
                data-active={layer === item}
                onClick={() => {
                  setLayer(item)
                  setSelectedNodeId(null)
                }}
              >
                <strong>{layerLabels[item].label}</strong>
                <span>{layerLabels[item].description}</span>
              </button>
            ))}
          </div>
          <div className={styles.logicGraphDirection} aria-label={t('workbench.logicGraphDirection')}>
            {(['incoming', 'both', 'outgoing'] as const).map((item) => (
              <button
                key={item}
                type="button"
                data-active={direction === item}
                onClick={() => setDirection(item)}
              >
                {item === 'incoming'
                  ? t('workbench.logicGraphIncoming')
                  : item === 'outgoing'
                    ? t('workbench.logicGraphOutgoing')
                    : t('workbench.logicGraphBoth')}
              </button>
            ))}
          </div>
        </div>
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
          <span>{layerLabels[layer].description}</span>
          <span>{t('workbench.codeGraphNodes', { nodes: graph.nodes.length, edges: graph.edges.length })}</span>
          {contextCount > 0 && (
            <span>{t('workbench.logicGraphContextCount', { count: contextCount })}</span>
          )}
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
                aria-label={t('workbench.velarLogicGraphTitle')}
                data-layer={layer}
              >
                <defs>
                  <marker id="logic-graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                    <path d="M 0 0 L 8 4 L 0 8 z" />
                  </marker>
                </defs>
                {layout.lanes.length > 0 && (
                  <g className={styles.logicGraphContextLanes}>
                    {layout.lanes.map((lane) => (
                      <g key={lane.name}>
                        <rect x="18" y={lane.y} width={layout.width - 36} height={lane.height} rx="12" />
                        <text x="32" y={lane.y + 23}>{compactGraphText(lane.name, 42)}</text>
                        <title>{lane.name}</title>
                      </g>
                    ))}
                  </g>
                )}
                <g className={styles.logicGraphEdges}>
                  {visibleEdges.map(({ edge, from, to }) => (
                    <path
                      key={edge.id ?? `${edge.from}:${edge.to}:${edge.kind}`}
                      d={edgePath(from, to)}
                      markerEnd="url(#logic-graph-arrow)"
                      data-kind={edge.kind}
                      data-active={selectedNodeId === edge.from || selectedNodeId === edge.to}
                    >
                      <title>{relationLabels[edge.kind] ?? edge.kind}</title>
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
                      <text x="12" y="20" className={styles.logicGraphNodeTitle}>
                        {compactGraphText(node.label)}
                      </text>
                      <text x="12" y="38" className={styles.logicGraphNodeMeta}>
                        {compactGraphText(node.context ? `${node.kind} · ${node.context}` : node.kind, 28)}
                      </text>
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
                {selectedNode.context && (
                  <div className={styles.logicGraphDetailContext}>
                    {t('workbench.logicGraphBusinessContext')}: {selectedNode.context}
                  </div>
                )}
                {selectedNode.type && <div className={styles.logicGraphDetailType}>{selectedNode.type}</div>}
                {selectedNode.documentation && <p>{selectedNode.documentation}</p>}
                <div className={styles.logicGraphRelationList}>
                  {selectedRelations.slice(0, 80).map((edge) => {
                    const incoming = edge.to === selectedNode.id
                    const other = positionedById.get(incoming ? edge.from : edge.to)
                    return (
                      <button key={edge.id ?? `${edge.from}:${edge.to}:${edge.kind}`} onClick={() => setSelectedNodeId(other?.id ?? null)}>
                        <span>{incoming ? '←' : '→'} {relationLabels[edge.kind] ?? edge.kind}</span>
                        <strong>{other?.label ?? (incoming ? edge.from : edge.to)}</strong>
                      </button>
                    )
                  })}
                </div>
                {selectedNode.path && (
                  <div className={styles.logicGraphDetailActions}>
                    <Button size="sm" variant="outline" onClick={() => setFocus(selectedNode.id)}>
                      {t('workbench.logicGraphFocusNode')}
                    </Button>
                    <Button size="sm" onClick={() => onOpenLocation(selectedNode.path, selectedNode.line, selectedNode.column)}>
                      <ArrowSquareOutIcon size={15} />
                      {t('workbench.logicGraphOpenSource')}
                    </Button>
                  </div>
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
