import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

import { optionalWhen } from '@velaros-ai/core'
import type { ProjectCodeIndexQuery } from '@velaros-ai/project/contracts'

import type {
  WorkbenchLanguageServiceExtensionRequest,
  WorkbenchLanguageServiceExtensionResult,
} from '@shared/contracts'
import {
  applyVelarLogicGraphResponse,
  parseVelarLogicGraphResponse,
  selectVelarLogicGraphNeighborhood,
  type VelarLogicGraphSnapshot,
  VelarOwnershipGraphRequestId,
} from '@shared/contributions/velar/logicGraph'

interface VelarManifest {
  entry?: unknown
}

export interface VelarLogicGraphLanguagePort {
  requestExtension(
    request: WorkbenchLanguageServiceExtensionRequest
  ): Promise<WorkbenchLanguageServiceExtensionResult>
}

const MaximumVelarManifestBytes = 256 * 1024
const MaximumRelationNodes = 500
const MaximumReportedCycles = 100

interface IndexedRelation {
  id: string
  kind: string
}

interface VelarLogicGraphIndex {
  incoming: ReadonlyMap<string, readonly IndexedRelation[]>
  outgoing: ReadonlyMap<string, readonly IndexedRelation[]>
}

/**
 * Workbench-owned consumer of the compiler graph. It keeps only the latest
 * materialized snapshot; parsing and semantic ownership remain in VelarScript.
 */
export class WorkbenchVelarLogicGraphService {
  private readonly snapshots = new Map<string, VelarLogicGraphSnapshot>()
  private readonly indexes = new WeakMap<VelarLogicGraphSnapshot, VelarLogicGraphIndex>()

  public constructor(private readonly language: VelarLogicGraphLanguagePort) {}

  public isProject(projectRoot: string): boolean {
    const root = this.canonicalRoot(projectRoot)
    return root !== null && this.entryPath(root) !== null
  }

  public async graph(projectRoot: string): Promise<VelarLogicGraphSnapshot> {
    const root = this.canonicalRoot(projectRoot)
    if (!root) throw new Error('The VelarScript project root is unavailable.')
    const entry = this.entryPath(root)
    if (!entry) throw new Error('This project does not have a root VelarScript manifest.')
    const previous = this.snapshots.get(root) ?? null
    let response = await this.request(root, entry, previous?.revision)
    let next = applyVelarLogicGraphResponse(previous, response)
    if (!next) {
      response = await this.request(root, entry)
      next = applyVelarLogicGraphResponse(null, response)
    }
    if (!next) throw new Error('VelarScript language server returned an unusable graph patch.')
    this.snapshots.set(root, next)
    return next
  }

  public clear(projectRoot: string): void {
    this.snapshots.delete(this.canonicalRoot(projectRoot) ?? resolve(projectRoot))
  }

  public async queryProjectCode(
    projectRoot: string,
    input: ProjectCodeIndexQuery
  ): Promise<unknown> {
    const snapshot = await this.graph(projectRoot)
    switch (input.action) {
      case 'search_symbols': {
        const query = input.query.toLocaleLowerCase('en-US')
        const matches = snapshot.nodes
          .filter((node) => (!input.kind || node.kind === input.kind)
            && (node.name.toLocaleLowerCase('en-US').includes(query)
              || node.path?.toLocaleLowerCase('en-US').includes(query)
              || node.context?.toLocaleLowerCase('en-US').includes(query)))
          .slice(0, input.limit)
        return this.present(snapshot, new Set(matches.flatMap((node) => [
          node.id,
          ...this.neighborIds(snapshot, node.id),
        ])))
      }
      case 'build_context':
        return this.present(
          snapshot,
          selectVelarLogicGraphNeighborhood(snapshot, input.task, 2, input.maxNodes)
        )
      case 'explore': {
        const selected = new Set(input.nodeIds.flatMap((id) => [
          id,
          ...this.neighborIds(snapshot, id),
        ]))
        return this.present(snapshot, selected)
      }
      case 'trace': {
        const from = this.resolveNode(snapshot, input.fromSymbol)
        const to = this.resolveNode(snapshot, input.toSymbol)
        const path = from && to ? this.directedPath(snapshot, from.id, to.id) : []
        return {
          ...(this.present(snapshot, new Set(path)) as Record<string, unknown>),
          from: from?.id ?? null,
          to: to?.id ?? null,
          path,
          found: path.length > 0,
        }
      }
      case 'read_node':
      case 'type_hierarchy':
        return this.present(snapshot, new Set([
          input.nodeId,
          ...this.neighborIds(snapshot, input.nodeId),
        ]))
      case 'callers':
        return this.presentRelations(snapshot, input.nodeId, 'incoming', ['calls'], input.depth)
      case 'callees':
        return this.presentRelations(snapshot, input.nodeId, 'outgoing', ['calls'], input.depth)
      case 'impact':
        return this.presentRelations(snapshot, input.nodeId, 'both', null, input.depth)
      case 'file_dependencies': {
        const moduleIds = snapshot.nodes
          .filter((node) => node.kind === 'module' && node.path === input.path)
          .map((node) => node.id)
        const selected = new Set(moduleIds)
        for (const id of moduleIds) {
          for (const neighbor of this.neighborIds(snapshot, id, ['imports'])) selected.add(neighbor)
        }
        return this.present(snapshot, selected)
      }
      case 'find_cycles':
        return {
          source: 'velar-compiler',
          provider: 'velar-compiler',
          revision: snapshot.revision,
          cycles: importCycles(snapshot).slice(0, input.maxFiles ?? MaximumReportedCycles),
        }
      case 'find_dead_code': {
        const incoming = this.index(snapshot).incoming
        const candidates = snapshot.nodes.filter((node) =>
          node.kind !== 'module'
          && node.kind !== 'parameter'
          && node.kind !== 'capability'
          && node.exported !== true
          && !(incoming.get(node.id) ?? []).some((relation) => relation.kind !== 'owns')
        ).slice(0, input.limit)
        return {
          ...(this.present(snapshot, new Set(candidates.map((node) => node.id))) as Record<string, unknown>),
          analysis: 'unreferenced-non-exported-candidates',
        }
      }
      case 'build_index':
      case 'index_status':
        return this.status(snapshot)
      case 'routing_manifest': {
        const pattern = /(?:^|\/)(?:routes?|pages?|app)(?:\/|\.|$)/iu
        return {
          source: 'velar-compiler',
          provider: 'velar-compiler',
          revision: snapshot.revision,
          framework: input.framework ?? null,
          files: snapshot.nodes.filter((node) => node.path && pattern.test(node.path)),
        }
      }
    }
    throw new Error(`Unsupported compiler graph action: ${(input as { action: string }).action}`)
  }

  private async request(
    projectRoot: string,
    entry: string,
    previousRevision?: string
  ) {
    const result = await this.language.requestExtension({
      projectRoot,
      path: relative(projectRoot, entry).replaceAll('\\', '/'),
      language: 'velar',
      requestId: VelarOwnershipGraphRequestId,
      parameters: {
        maximumNodes: 10_000,
        maximumEdges: 20_000,
        previousRevision: optionalWhen(!!previousRevision, previousRevision),
      },
    })
    const parsed = parseVelarLogicGraphResponse(result.result)
    if (!parsed) throw new Error('VelarScript language server returned an invalid ownership graph.')
    return parsed
  }

  private entryPath(projectRoot: string): string | null {
    const manifestPath = resolve(projectRoot, 'velar.json')
    if (!existsSync(manifestPath)) return null
    try {
      const manifestSize = statSync(manifestPath).size
      if (manifestSize > MaximumVelarManifestBytes) return null
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as VelarManifest
      if (typeof manifest.entry !== 'string' || !manifest.entry.trim()) return null
      const entry = realpathSync(resolve(projectRoot, manifest.entry))
      const path = relative(projectRoot, entry)
      if (isAbsolute(path) || path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) return null
      return entry
    } catch {
      return null
    }
  }

  private canonicalRoot(projectRoot: string): string | null {
    try {
      return realpathSync(resolve(projectRoot))
    } catch {
      return null
    }
  }

  private neighborIds(
    snapshot: VelarLogicGraphSnapshot,
    id: string,
    kinds: readonly string[] | null = null
  ): string[] {
    const index = this.index(snapshot)
    return [...(index.outgoing.get(id) ?? []), ...(index.incoming.get(id) ?? [])]
      .filter((relation) => !kinds || kinds.includes(relation.kind))
      .map((relation) => relation.id)
  }

  private resolveNode(snapshot: VelarLogicGraphSnapshot, query: string) {
    const normalized = query.toLocaleLowerCase('en-US')
    return snapshot.nodes.find((node) => node.id.toLocaleLowerCase('en-US') === normalized)
      ?? snapshot.nodes.find((node) => node.name.toLocaleLowerCase('en-US') === normalized)
      ?? snapshot.nodes.find((node) => node.name.toLocaleLowerCase('en-US').includes(normalized))
  }

  private directedPath(
    snapshot: VelarLogicGraphSnapshot,
    from: string,
    to: string
  ): string[] {
    const outgoing = this.index(snapshot).outgoing
    const previous = new Map<string, string | null>([[from, null]])
    const pending = [from]
    for (let cursor = 0; cursor < pending.length && previous.size < MaximumRelationNodes; cursor += 1) {
      const current = pending[cursor]!
      if (current === to) break
      for (const relation of outgoing.get(current) ?? []) {
        if (previous.has(relation.id)) continue
        previous.set(relation.id, current)
        pending.push(relation.id)
      }
    }
    if (!previous.has(to)) return []
    const path: string[] = []
    for (let current: string | null = to; current !== null; current = previous.get(current) ?? null)
      path.push(current)
    return path.reverse()
  }

  private presentRelations(
    snapshot: VelarLogicGraphSnapshot,
    nodeId: string,
    direction: 'incoming' | 'outgoing' | 'both',
    kinds: readonly string[] | null,
    depth: number
  ): unknown {
    const selected = new Set<string>()
    const pending = [{ id: nodeId, depth: 0 }]
    const maximumDepth = Math.min(8, Math.max(0, Math.floor(depth)))
    const index = this.index(snapshot)
    for (let cursor = 0; cursor < pending.length && selected.size < MaximumRelationNodes; cursor += 1) {
      const current = pending[cursor]!
      if (selected.has(current.id)) continue
      selected.add(current.id)
      if (current.depth >= maximumDepth) continue
      const next = direction === 'incoming'
        ? index.incoming.get(current.id) ?? []
        : direction === 'outgoing'
          ? index.outgoing.get(current.id) ?? []
          : [...(index.outgoing.get(current.id) ?? []), ...(index.incoming.get(current.id) ?? [])]
      for (const relation of next)
        if (!kinds || kinds.includes(relation.kind))
          pending.push({ id: relation.id, depth: current.depth + 1 })
    }
    return this.present(snapshot, selected)
  }

  private index(snapshot: VelarLogicGraphSnapshot): VelarLogicGraphIndex {
    const cached = this.indexes.get(snapshot)
    if (cached) return cached
    const incoming = new Map<string, IndexedRelation[]>()
    const outgoing = new Map<string, IndexedRelation[]>()
    for (const edge of snapshot.edges) {
      const from = outgoing.get(edge.from) ?? []
      from.push({ id: edge.to, kind: edge.kind })
      outgoing.set(edge.from, from)
      const to = incoming.get(edge.to) ?? []
      to.push({ id: edge.from, kind: edge.kind })
      incoming.set(edge.to, to)
    }
    const index = { incoming, outgoing }
    this.indexes.set(snapshot, index)
    return index
  }

  private present(snapshot: VelarLogicGraphSnapshot, selected: ReadonlySet<string>): unknown {
    return {
      source: 'velar-compiler',
      provider: 'velar-compiler',
      revision: snapshot.revision,
      coverage: snapshot.coverage,
      activity: snapshot.activity,
      nodes: snapshot.nodes.filter((node) => selected.has(node.id)),
      relations: snapshot.edges.filter((edge) => selected.has(edge.from) && selected.has(edge.to)),
    }
  }

  private status(snapshot: VelarLogicGraphSnapshot): unknown {
    return {
      source: 'velar-compiler',
      providerId: 'velar-compiler',
      providerLabel: 'VelarScript compiler',
      initialized: true,
      watching: true,
      revision: snapshot.revision,
      moduleCount: snapshot.coverage.modulesTotal,
      nodeCount: snapshot.nodes.length,
      edgeCount: snapshot.edges.length,
      complete: snapshot.coverage.complete,
      limitReached: snapshot.limitReached,
      activity: snapshot.activity,
    }
  }
}

function importCycles(snapshot: VelarLogicGraphSnapshot): string[][] {
  const imports = snapshot.edges.filter((edge) => edge.kind === 'imports')
  const adjacent = new Map<string, string[]>()
  for (const edge of imports) adjacent.set(edge.from, [...(adjacent.get(edge.from) ?? []), edge.to])
  const paths: string[][] = []
  const active: string[] = []
  const activeIndex = new Map<string, number>()
  const visited = new Set<string>()
  const names = new Map(snapshot.nodes.map((node) => [node.id, node.path || node.name]))
  for (const root of adjacent.keys()) {
    if (visited.has(root)) continue
    const pending: Array<{ id: string; targets: readonly string[]; cursor: number }> = []
    const enter = (id: string): void => {
      visited.add(id)
      activeIndex.set(id, active.length)
      active.push(id)
      pending.push({ id, targets: adjacent.get(id) ?? [], cursor: 0 })
    }
    enter(root)
    while (pending.length > 0) {
      const frame = pending.at(-1)!
      const target = frame.targets[frame.cursor]
      if (target === undefined) {
        pending.pop()
        active.pop()
        activeIndex.delete(frame.id)
        continue
      }
      frame.cursor += 1
      const cycleStart = activeIndex.get(target)
      if (cycleStart !== undefined) {
        if (paths.length < MaximumReportedCycles)
          paths.push([...active.slice(cycleStart), target].map((id) => names.get(id) ?? id))
        continue
      }
      if (!visited.has(target)) enter(target)
    }
  }
  return paths
}
