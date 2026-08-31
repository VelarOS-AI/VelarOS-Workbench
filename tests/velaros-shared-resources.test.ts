import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  resolveVelarOSSharedDataRoot,
  resolveVelarOSSharedResourcesRoot,
} from '../src/main/resources/VelarOSSharedResourceStore'
import {
  type CodeGraphProcessRunner,
  WorkbenchCodeGraphResource,
} from '../src/main/resources/WorkbenchCodeGraphResource'
import { WorkbenchResourcePluginService } from '../src/main/resources/WorkbenchResourcePluginService'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('VelarOS shared resources', () => {
  test('uses the organization data root rather than Workbench userData', () => {
    const options = {
      platform: 'darwin' as const,
      env: {},
      homeDirectory: '/Users/example',
    }
    expect(resolveVelarOSSharedDataRoot(options)).toBe(
      join('/Users/example', 'Library', 'Application Support', 'VelarOS')
    )
    expect(resolveVelarOSSharedResourcesRoot(options)).toBe(
      join('/Users/example', 'Library', 'Application Support', 'VelarOS', 'shared', 'resources')
    )
  })

  test('discovers and executes the CodeGraph copy installed in the shared root', async () => {
    const fixture = createCodeGraphFixture()
    const calls: string[][] = []
    const runProcess: CodeGraphProcessRunner = async (_launch, args) => {
      calls.push([...args])
      if (args[0] === 'index') return { exitCode: 1, stdout: '', stderr: 'project not initialized' }
      if (args[0] === 'status') return {
          exitCode: 0,
          stdout: JSON.stringify({
            initialized: true,
            fileCount: 2,
            nodeCount: 3,
            edgeCount: 1,
            backend: 'sqlite',
          }),
          stderr: '',
        }
      if (args[0] === 'files') return {
          exitCode: 0,
          stdout: JSON.stringify([
            { path: 'src/main.ts', language: 'typescript' },
            { path: 'src/helper.ts', language: 'typescript' },
          ]),
          stderr: '',
        }
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const resource = new WorkbenchCodeGraphResource({
      sharedResourcesRoot: fixture.sharedResourcesRoot,
      platform: 'darwin',
      arch: 'arm64',
      runProcess,
    })

    expect(resource.describe()).toMatchObject({ available: true, version: '0.9.7' })
    const diagnostics = await resource.indexProject(fixture.projectRoot)
    expect(diagnostics).toMatchObject({ initialized: true, nodeCount: 3 })
    expect(diagnostics.skipped).toBeUndefined()
    expect(calls.slice(0, 3).map((args) => args[0])).toEqual(['index', 'init', 'status'])

    const graph = await resource.getGraph({
      projectRoot: fixture.projectRoot,
      mode: 'full',
      maxNodes: 20,
    })
    expect(graph.nodes.map((node) => node.path)).toEqual(['src/main.ts', 'src/helper.ts'])
    expect(graph.edges).toEqual([
      { from: 'src/main.ts', to: 'src/helper.ts', kind: 'imports' },
    ])

    const queryResult = await resource.queryProjectCode(fixture.projectRoot, {
      action: 'search_symbols',
      query: 'helper',
      limit: 12,
    })
    expect(queryResult).toEqual({ output: '' })
    expect(calls.at(-1)).toEqual([
      'query',
      'helper',
      '--path',
      fixture.projectRoot,
      '--limit',
      '12',
      '--json',
    ])
  })

  test('shares physical plugin files while retaining a Workbench enable preference', async () => {
    const fixture = createCodeGraphFixture()
    const dataRoot = join(fixture.projectRoot, '.workbench-data')
    const resource = new WorkbenchCodeGraphResource({
      sharedResourcesRoot: fixture.sharedResourcesRoot,
      platform: 'darwin',
      arch: 'arm64',
    })
    const service = new WorkbenchResourcePluginService(
      dataRoot,
      resource,
      resourcePluginOptions(fixture.sharedResourcesRoot)
    )

    expect(service.listCatalog().plugins[0]).toMatchObject({
      id: 'codegraph',
      installed: true,
      enabled: true,
      status: 'available',
      version: '0.9.7',
    })

    await service.setEnabled('codegraph', false)
    expect(resource.describe()).toMatchObject({ available: false, version: '0.9.7' })
    expect(resource.describePhysical()).toMatchObject({ available: true, version: '0.9.7' })

    const restored = new WorkbenchResourcePluginService(
      dataRoot,
      resource,
      resourcePluginOptions(fixture.sharedResourcesRoot)
    )
    expect(restored.listCatalog().plugins[0]).toMatchObject({
      installed: true,
      enabled: false,
      status: 'disabled',
    })
  })
})

function resourcePluginOptions(sharedResourcesRoot: string) {
  return {
    sharedResourcesRoot,
    artifactBase: () => 'https://example.invalid/plugins/',
    fetchImpl: fetch,
    agentEngines: {
      listModels: async (engineId: 'claude-code' | 'codex') => ({
        engineId,
        available: false,
        models: [],
      }),
    },
  }
}

function createCodeGraphFixture(): { sharedResourcesRoot: string; projectRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'velaros-shared-resources-'))
  temporaryRoots.push(root)
  const sharedResourcesRoot = join(root, 'shared', 'resources')
  const packageRoot = join(
    sharedResourcesRoot,
    'codegraph',
    '@colbymchenry',
    'codegraph-darwin-arm64'
  )
  mkdirSync(join(packageRoot, 'bin'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ version: '0.9.7' }))
  writeFileSync(join(packageRoot, 'bin', 'codegraph'), '#!/bin/sh\n')

  const projectRoot = join(root, 'project')
  mkdirSync(join(projectRoot, 'src'), { recursive: true })
  writeFileSync(join(projectRoot, 'src', 'main.ts'), "import './helper'\n")
  writeFileSync(join(projectRoot, 'src', 'helper.ts'), 'export const helper = true\n')
  return { sharedResourcesRoot, projectRoot }
}
