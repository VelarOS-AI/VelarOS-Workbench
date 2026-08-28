import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
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

import styles from '../../styles/workbenchPageStyles'

const MaximumVisibleNodes = 320
const MaximumVisibleEdges = 900

interface WorkbenchCodeGraphDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectRoot: string
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
  for (const node of nodes) {
    const layer = nodeLayer(node.kind)
    layers.set(layer, [...(layers.get(layer) ?? []), node])
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

export function WorkbenchCodeGraphDialog({
  open,
  onOpenChange,
  projectRoot,
  onOpenLocation,
}: WorkbenchCodeGraphDialogProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const runtime = useWorkbenchHostRuntime()
  const [nodes, setNodes] = useState<WorkbenchCodeGraphNode[]>([])
  const [edges, setEdges] = useState<WorkbenchCodeGraphEdge[]>([])
  const [truncated, setTruncated] = useState(false)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    if (!open) return
    setLoading(true)
    setError(null)
    try {
      const response = await runtime.kernel.project.getWorkbenchCodeGraph({
        projectRoot,
        mode: 'full',
        maxNodes: MaximumVisibleNodes,
      })
      if (!response.ok) throw response.error
      setNodes(response.data.nodes)
      setEdges(response.data.edges.slice(0, MaximumVisibleEdges))
      setTruncated(response.data.truncated || response.data.edges.length > MaximumVisibleEdges)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('workbench.codeGraphError'))
    } finally {
      setLoading(false)
    }
  }, [open, projectRoot, runtime, t])

  useEffect(() => {
    if (open) void load()
  }, [load, open])

  useEffect(() => {
    if (!open) setSelectedNodeId(null)
  }, [open])

  const layout = useMemo(() => positionNodes(nodes), [nodes])
  const positionedById = useMemo(
    () => new Map(layout.nodes.map((node) => [node.id, node])),
    [layout.nodes]
  )
  const visibleEdges = edges.flatMap((edge) => {
    const from = positionedById.get(edge.from)
    const to = positionedById.get(edge.to)
    return from && to ? [{ edge, from, to }] : []
  })
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null
  const selectedRelations = selectedNode
    ? edges.filter((edge) => edge.from === selectedNode.id || edge.to === selectedNode.id)
    : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={styles.logicGraphDialog}>
        <DialogHeader className={styles.logicGraphHeader}>
          <div>
            <DialogTitle>{t('workbench.codeGraphTitle')}</DialogTitle>
            <DialogDescription>{t('workbench.codeGraphHint')}</DialogDescription>
          </div>
          <IconButton
            label={t('workbench.codeGraphReload')}
            title={t('workbench.codeGraphReload')}
            onClick={() => void load()}
          >
            <ArrowClockwiseIcon size={16} />
          </IconButton>
        </DialogHeader>
        <div className={styles.logicGraphStatus}>
          <span>{loading
            ? t('workbench.codeGraphLoading')
            : t('workbench.codeGraphNodes', { nodes: nodes.length, edges: edges.length })}</span>
          {truncated && <span>{t('workbench.codeGraphTruncated')}</span>}
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
            ) : !loading && nodes.length === 0 ? (
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
                  <marker id="code-graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                    <path d="M 0 0 L 8 4 L 0 8 z" />
                  </marker>
                </defs>
                <g className={styles.logicGraphEdges}>
                  {visibleEdges.map(({ edge, from, to }) => (
                    <path key={edge.id ?? `${edge.from}:${edge.to}:${edge.kind}`} d={edgePath(from, to)} markerEnd="url(#code-graph-arrow)">
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
              <p>{t('workbench.codeGraphHint')}</p>
            )}
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  )
}
