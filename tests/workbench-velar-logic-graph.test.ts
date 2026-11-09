import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import {
  discoverWorkbenchVelarProjectRoots,
  getWorkbenchVelarDefaultScopePaths,
  mergeWorkbenchVelarProjectSnapshotIndex,
  mergeWorkbenchVelarProjectSnapshots,
  selectWorkbenchVelarProjectRoots,
  updateWorkbenchVelarProjectSnapshotIndex,
} from '../src/renderer/src/models/workbenchVelarProjectGraph'
import {
  applyVelarLogicGraphResponse,
  parseVelarLogicGraphResponse,
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
  void test('parses, patches, and maps the compiler-owned graph', () => {
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

    const view = velarLogicGraphForWorkbench('/project', updated)
    const run = view.nodes.find((node) => node.id === 'function:run')
    assert.deepEqual(
      { path: run?.path, line: run?.line, column: run?.column, type: run?.type },
      { path: 'main.vel', line: 3, column: 5, type: '() -> void' }
    )
    assert.equal(run?.context, 'Order checkout')
    assert.equal(view.edges.length, 2)

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
})
