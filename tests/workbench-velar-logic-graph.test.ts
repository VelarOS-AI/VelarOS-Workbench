import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, test } from 'bun:test'

import type { ProjectCodeIndexQuery } from '@velaros-ai/project/contracts'

import { WorkbenchCodeGraphResource } from '../src/main/resources/WorkbenchCodeGraphResource'
import {
  type VelarLogicGraphLanguagePort,
  WorkbenchVelarLogicGraphService,
} from '../src/main/workspace/language/WorkbenchVelarLogicGraphService'
import { WorkbenchAgentExtensionTools } from '../src/plugins/agent-engines/main/WorkbenchAgentExtensionTools'
import {
  discoverWorkbenchVelarProjectRoots,
  getWorkbenchVelarDefaultScopePaths,
  mergeWorkbenchVelarProjectSnapshotIndex,
  mergeWorkbenchVelarProjectSnapshots,
  selectWorkbenchVelarProjectRoots,
  updateWorkbenchVelarProjectSnapshotIndex,
} from '../src/renderer/src/models/codeGraph/workbenchVelarProjectGraph'
import {
  applyVelarLogicGraphResponse,
  parseVelarLogicGraphResponse,
  selectVelarLogicGraphNeighborhood,
  velarLogicGraphForWorkbench,
  type VelarLogicGraphResponse,
} from '../src/shared/contributions/velar/logicGraph'

const RevisionA = 'a'.repeat(64)
const RevisionB = 'b'.repeat(64)

function graphResponse(
  overrides: Partial<VelarLogicGraphResponse> = {}
): VelarLogicGraphResponse {
  return {
    protocolVersion: 1,
    mode: 'snapshot',
    rootUri: 'file:///project',
    revision: RevisionA,
    nodes: [
      {
        id: 'module:main',
        kind: 'module',
        name: 'main',
        path: 'main.vel',
        selectionRange: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 4 },
        },
      },
      {
        id: 'function:run',
        kind: 'function',
        name: 'run',
        documentation: 'Runs the project.',
        context: 'Order checkout',
        type: '() -> void',
        path: 'main.vel',
        selectionRange: {
          start: { line: 2, character: 4 },
          end: { line: 2, character: 7 },
        },
      },
    ],
    edges: [{ id: 'contains:run', kind: 'contains', from: 'module:main', to: 'function:run' }],
    removedNodeIds: [],
    removedEdgeIds: [],
    coverage: {
      modulesTotal: 1,
      modulesIncluded: 1,
      complete: true,
      callRelations: 'resolved',
      memberCallRelations: true,
    },
    limitReached: false,
    durationMs: 2,
    activity: { strategy: 'full', modulesVisited: 1 },
    ...overrides,
  }
}

void describe('Workbench Velar compiler graph consumer', () => {
  void test('parses, patches, maps, and focuses the compiler-owned graph', () => {
    const parsed = parseVelarLogicGraphResponse(graphResponse())
    assert.ok(parsed)
    const snapshot = applyVelarLogicGraphResponse(null, parsed)
    assert.ok(snapshot)

    const patch = parseVelarLogicGraphResponse(graphResponse({
      mode: 'patch',
      revision: RevisionB,
      baseRevision: RevisionA,
      nodes: [{ id: 'state:ready', kind: 'state', name: 'ready', path: 'main.vel' }],
      edges: [{ id: 'reads:ready', kind: 'reads', from: 'function:run', to: 'state:ready' }],
      removedNodeIds: [],
      removedEdgeIds: [],
      activity: { strategy: 'affected-modules', modulesVisited: 1 },
    }))
    assert.ok(patch)
    const updated = applyVelarLogicGraphResponse(snapshot, patch)
    assert.ok(updated)
    assert.equal(updated.revision, RevisionB)
    assert.deepEqual(updated.nodes.map((node) => node.id), [
      'module:main',
      'function:run',
      'state:ready',
    ])

    const focused = selectVelarLogicGraphNeighborhood(updated, 'run', 1, 10)
    assert.deepEqual([...focused], ['function:run', 'state:ready', 'module:main'])
    const view = velarLogicGraphForWorkbench('/project', updated, focused)
    const run = view.nodes.find((node) => node.id === 'function:run')
    assert.deepEqual(
      { path: run?.path, line: run?.line, column: run?.column, type: run?.type },
      { path: 'main.vel', line: 3, column: 5, type: '() -> void' }
    )
    assert.equal(run?.context, 'Order checkout')
    assert.equal(view.edges.length, 2)

    const readsFromRun = selectVelarLogicGraphNeighborhood(
      updated,
      'run',
      1,
      10,
      { direction: 'outgoing', relationKinds: new Set(['reads']) }
    )
    assert.deepEqual([...readsFromRun], ['function:run', 'state:ready'])
    const ownerOfRun = selectVelarLogicGraphNeighborhood(
      updated,
      'run',
      1,
      10,
      { direction: 'incoming', relationKinds: new Set(['contains']) }
    )
    assert.deepEqual([...ownerOfRun], ['function:run', 'module:main'])
  })

  void test('rejects unsafe, duplicate, or unbounded protocol data', () => {
    assert.equal(parseVelarLogicGraphResponse(graphResponse({
      nodes: [{ id: 'outside', kind: 'module', name: 'outside', path: '../secret.vel' }],
    })), null)
    assert.equal(parseVelarLogicGraphResponse(graphResponse({
      nodes: [
        { id: 'same', kind: 'module', name: 'a' },
        { id: 'same', kind: 'function', name: 'b' },
      ],
    })), null)
    assert.equal(parseVelarLogicGraphResponse(graphResponse({
      nodes: Array.from({ length: 20_001 }, (_, index) => ({
        id: `node:${index}`,
        kind: 'function',
        name: `node${index}`,
      })),
    })), null)
  })

  void test('composes nested Velar projects in workspace-relative coordinates', () => {
    const projectRoots = discoverWorkbenchVelarProjectRoots([
      'README.md',
      'apps/server/velar.json',
      'apps/server/src/main.vel',
      'apps/web/velar.json',
      'apps/web/src/main.vel',
      'packages/blocks/velar.json',
      'packages/blocks/src/index.vel',
    ])
    assert.deepEqual(projectRoots, ['apps/server', 'apps/web', 'packages/blocks'])
    const defaultScopePaths = getWorkbenchVelarDefaultScopePaths(projectRoots, projectRoots[0]!)
    assert.deepEqual(defaultScopePaths, [])
    assert.deepEqual(
      selectWorkbenchVelarProjectRoots(projectRoots, defaultScopePaths, null),
      projectRoots
    )
    assert.deepEqual(getWorkbenchVelarDefaultScopePaths(['apps/server'], 'apps/server'), [
      'apps/server',
    ])
    assert.deepEqual(
      selectWorkbenchVelarProjectRoots(projectRoots, ['apps'], null),
      ['apps/server', 'apps/web']
    )
    assert.deepEqual(
      selectWorkbenchVelarProjectRoots(projectRoots, ['packages/blocks/tools'], null),
      ['packages/blocks']
    )

    const server = applyVelarLogicGraphResponse(null, graphResponse({
      rootUri: 'file:///workspace/apps/server',
      nodes: graphResponse().nodes.map((node) => ({ ...node, path: 'src/main.vel' })),
    }))
    const web = applyVelarLogicGraphResponse(null, graphResponse({
      rootUri: 'file:///workspace/apps/web',
      revision: RevisionB,
      nodes: graphResponse().nodes.map((node) => ({ ...node, path: 'src/main.vel' })),
    }))
    assert.ok(server)
    assert.ok(web)
    const merged = mergeWorkbenchVelarProjectSnapshots([
      { projectRoot: 'apps/server', snapshot: server },
      { projectRoot: 'apps/web', snapshot: web },
    ])
    assert.ok(merged)
    assert.deepEqual(
      merged.nodes.filter((node) => node.kind === 'module').map((node) => node.path),
      ['apps/server/src/main.vel', 'apps/web/src/main.vel']
    )
    assert.equal(new Set(merged.nodes.map((node) => node.id)).size, merged.nodes.length)
    assert.equal(new Set(merged.edges.map((edge) => edge.id)).size, merged.edges.length)
    assert.deepEqual(
      selectWorkbenchVelarProjectRoots(projectRoots, [merged.nodes[0]!.id], merged),
      ['apps/server']
    )

    const projectIndex = updateWorkbenchVelarProjectSnapshotIndex(new Map(), [
      { projectRoot: 'apps/server', snapshot: server },
      { projectRoot: 'apps/web', snapshot: web },
    ])
    const refreshedServer = { ...server, revision: RevisionB }
    const refreshedIndex = updateWorkbenchVelarProjectSnapshotIndex(projectIndex, [
      { projectRoot: 'apps/server', snapshot: refreshedServer },
    ])
    assert.equal(refreshedIndex.get('apps/server')?.revision, RevisionB)
    assert.equal(refreshedIndex.get('apps/web')?.revision, RevisionB)
    assert.deepEqual(
      mergeWorkbenchVelarProjectSnapshotIndex(refreshedIndex)?.nodes
        .filter((node) => node.kind === 'module')
        .map((node) => node.path),
      ['apps/server/src/main.vel', 'apps/web/src/main.vel']
    )
  })

  void test('materializes incremental responses once and serves AI from the same snapshot', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'workbench-velar-graph-'))
    await writeFile(join(projectRoot, 'velar.json'), JSON.stringify({ entry: 'main.vel' }))
    await writeFile(join(projectRoot, 'main.vel'), 'def run():\n  pass\n')
    const requests: Array<Record<string, unknown> | undefined> = []
    const language: VelarLogicGraphLanguagePort = {
      requestExtension: async (request) => {
        requests.push(request.parameters)
        const previousRevision = request.parameters?.['previousRevision']
        const result = previousRevision === undefined
          ? graphResponse()
          : previousRevision === RevisionA
            ? graphResponse({
                mode: 'patch',
                revision: RevisionB,
                baseRevision: RevisionA,
                nodes: [{ id: 'function:helper', kind: 'function', name: 'helper', path: 'main.vel' }],
                edges: [{ id: 'calls:helper', kind: 'calls', from: 'function:run', to: 'function:helper' }],
                removedNodeIds: [],
                removedEdgeIds: [],
                activity: { strategy: 'affected-modules', modulesVisited: 1 },
              })
            : graphResponse({
                mode: 'patch',
                revision: RevisionB,
                baseRevision: RevisionB,
                nodes: [],
                edges: [],
                removedNodeIds: [],
                removedEdgeIds: [],
                activity: { strategy: 'affected-modules', modulesVisited: 0 },
              })
        return {
          projectRoot,
          path: 'main.vel',
          requestId: request.requestId,
          result,
        }
      },
    }
    const service = new WorkbenchVelarLogicGraphService(language)
    try {
      assert.equal(service.isProject(projectRoot), true)
      assert.equal((await service.graph(projectRoot)).revision, RevisionA)
      assert.equal((await service.graph(projectRoot)).revision, RevisionB)
      const query = await service.queryProjectCode(projectRoot, {
        action: 'search_symbols',
        query: 'helper',
        limit: 10,
      } as ProjectCodeIndexQuery) as {
        source: string
        provider: string
        revision: string
        nodes: Array<{ id: string }>
        relations: Array<{ kind: string }>
      }
      assert.equal(query.source, 'velar-compiler')
      assert.equal(query.provider, 'velar-compiler')
      assert.equal(query.revision, RevisionB)
      assert.deepEqual(query.nodes.map((node) => node.id).sort(), ['function:helper', 'function:run'])
      assert.deepEqual(query.relations.map((edge) => edge.kind), ['calls'])
      const businessContext = await service.queryProjectCode(projectRoot, {
        action: 'search_symbols',
        query: 'order checkout',
        limit: 10,
      } as ProjectCodeIndexQuery) as { nodes: Array<{ id: string; context?: string }> }
      assert.equal(businessContext.nodes.find((node) => node.id === 'function:run')?.context, 'Order checkout')
      const trace = await service.queryProjectCode(projectRoot, {
        action: 'trace',
        fromSymbol: 'run',
        toSymbol: 'helper',
      } as ProjectCodeIndexQuery) as { found: boolean; path: string[] }
      assert.equal(trace.found, true)
      assert.deepEqual(trace.path, ['function:run', 'function:helper'])
      assert.deepEqual(requests.map((request) => request?.['previousRevision']), [
        undefined,
        RevisionA,
        RevisionB,
        RevisionB,
        RevisionB,
      ])
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('does not accept a manifest entry that resolves outside the project', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'workbench-velar-boundary-'))
    const projectRoot = join(parent, 'project')
    await mkdir(projectRoot)
    await writeFile(join(parent, 'outside.vel'), '')
    await writeFile(join(projectRoot, 'velar.json'), JSON.stringify({ entry: '../outside.vel' }))
    const service = new WorkbenchVelarLogicGraphService({
      requestExtension: async () => { throw new Error('must not request') },
    })
    try {
      assert.equal(service.isProject(projectRoot), false)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  void test('routes external Agent engine symbol search to the same compiler graph', async () => {
    const calls: unknown[] = []
    const velarLogicGraph = {
      isProject: () => true,
      queryProjectCode: async (_root: string, input: unknown) => {
        calls.push(input)
        return { source: 'velar-compiler', nodes: [{ id: 'function:run' }] }
      },
    } as unknown as WorkbenchVelarLogicGraphService
    const tools = new WorkbenchAgentExtensionTools(
      new WorkbenchCodeGraphResource(),
      velarLogicGraph
    )

    const result = await tools.execute('/project', 'project_query_code', {
      query: 'run',
      limit: 12,
    }) as { source: string }
    assert.equal(result.source, 'velar-compiler')
    assert.deepEqual(calls, [{
      action: 'search_symbols',
      query: 'run',
      kind: undefined,
      limit: 12,
    }])
  })
})
