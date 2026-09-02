import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import * as tar from 'tar'

import {
  resolveVelarOSSharedDataRoot,
  resolveVelarOSSharedResourcesRoot,
} from '../src/main/resources/VelarOSSharedResourceStore'
import {
  type CodeGraphProcessRunner,
  WorkbenchCodeGraphResource,
} from '../src/main/resources/WorkbenchCodeGraphResource'
import { WorkbenchResourcePluginService } from '../src/main/resources/WorkbenchResourcePluginService'
import { WorkbenchAgentPluginResolver } from '../src/plugins/agent-engines/main/WorkbenchAgentPluginResolver'

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

  test('downloads Claude and Codex plugins by their canonical ids and resolves bundled commands', async () => {
    const fixture = createCodeGraphFixture()
    const archives = new Map([
      ['claude-agent', await createAgentPluginArchive(fixture.projectRoot, 'claude-agent')],
      ['codex-agent', await createAgentPluginArchive(fixture.projectRoot, 'codex-agent')],
    ] as const)
    const plugins = Object.fromEntries(
      [...archives].map(([id, archive]) => [id, {
        version: '1.0.0',
        platforms: {
          [`${process.platform}-${process.arch}`]: {
            file: `${id}.tar.gz`,
            sha256: createHash('sha256').update(archive).digest('hex'),
            size: archive.byteLength,
          },
        },
      }])
    )
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.pathname.endsWith('/manifest.json')) return Response.json({ plugins })
      const id = url.pathname.split('/').at(-1)?.replace(/\.tar\.gz$/u, '')
      const archive = id ? archives.get(id as 'claude-agent' | 'codex-agent') : undefined
      return archive ? new Response(archive) : new Response(null, { status: 404 })
    }) as typeof fetch
    const service = new WorkbenchResourcePluginService(
      join(fixture.projectRoot, '.workbench-data'),
      new WorkbenchCodeGraphResource({
        sharedResourcesRoot: fixture.sharedResourcesRoot,
        platform: process.platform,
        arch: process.arch,
      }),
      {
        ...resourcePluginOptions(fixture.sharedResourcesRoot),
        fetchImpl,
      }
    )

    await service.install('claude-agent')
    await service.install('codex-agent')

    expect(service.listCatalog().plugins.slice(1)).toMatchObject([
      { id: 'claude-agent', installed: true, enabled: true, status: 'available' },
      { id: 'codex-agent', installed: true, enabled: true, status: 'available' },
    ])
    const resolver = new WorkbenchAgentPluginResolver(fixture.sharedResourcesRoot)
    expect(resolver.resolveClaudeCommand()).not.toBeNull()
    expect(resolver.resolveCodexCommand()).not.toBeNull()
  })
})

async function createAgentPluginArchive(
  parentRoot: string,
  id: 'claude-agent' | 'codex-agent'
): Promise<Buffer> {
  const sourceRoot = mkdtempSync(join(parentRoot, `${id}-source-`))
  const archivePath = join(parentRoot, `${id}.tar.gz`)
  writeFileSync(join(sourceRoot, 'package.json'), JSON.stringify({ version: '1.0.0' }))
  if (id === 'claude-agent') {
    const sdkRoot = join(sourceRoot, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
    const runtimeRoot = join(
      sourceRoot,
      'node_modules',
      '@anthropic-ai',
      `claude-agent-sdk-${process.platform}-${process.arch}`
    )
    mkdirSync(sdkRoot, { recursive: true })
    mkdirSync(runtimeRoot, { recursive: true })
    writeFileSync(join(sdkRoot, 'sdk.mjs'), 'export function query() {}\n')
    writeFileSync(join(runtimeRoot, `claude${process.platform === 'win32' ? '.exe' : ''}`), '')
  } else {
    const triple = CodexTargetTriples[`${process.platform}-${process.arch}`]
    if (!triple) throw new Error('Unsupported Codex test platform.')
    const sdkRoot = join(sourceRoot, 'node_modules', '@openai', 'codex-sdk', 'dist')
    const runtimeRoot = join(
      sourceRoot,
      'node_modules',
      '@openai',
      `codex-${process.platform}-${process.arch}`,
      'vendor',
      triple,
      'bin'
    )
    mkdirSync(sdkRoot, { recursive: true })
    mkdirSync(runtimeRoot, { recursive: true })
    writeFileSync(join(sdkRoot, 'index.js'), 'export const codex = true\n')
    writeFileSync(join(runtimeRoot, `codex${process.platform === 'win32' ? '.exe' : ''}`), '')
  }
  await tar.c({ cwd: sourceRoot, file: archivePath, gzip: true }, ['package.json', 'node_modules'])
  return readFileSync(archivePath)
}

const CodexTargetTriples: Readonly<Record<string, string>> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'win32-x64': 'x86_64-pc-windows-msvc',
}

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
