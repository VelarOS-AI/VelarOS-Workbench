import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import type { ProjectKernel } from '@velaros-ai/project/runtime'

import type { WorkbenchVelarLogicGraphService } from '../src/main/workspace/language/WorkbenchVelarLogicGraphService'
import { ProjectCapabilityProvider } from '../src/main/workspace/ProjectCapabilityProvider'

void describe('Project capability provider', () => {
  void test('creates one injected Project kernel per root and invokes it', async () => {
    let created = 0
    const calls: unknown[] = []
    const provider = new ProjectCapabilityProvider({
      createKernel: async () => {
        created += 1
        return {
          listFiles: async (input: unknown) => {
              calls.push(input)
              return [{ path: 'src/index.ts', type: 'file' }]
          },
        } as unknown as ProjectKernel
      },
    })

    const first = await provider.invoke({
      projectRoot: '/tmp/workbench-project',
      operation: 'project:list',
      input: { recursive: true },
    })
    const second = await provider.invoke({
      projectRoot: '/tmp/workbench-project',
      operation: 'project:list',
      input: { recursive: false },
    })

    assert.deepEqual(first, [{ path: 'src/index.ts', type: 'file' }])
    assert.deepEqual(second, [{ path: 'src/index.ts', type: 'file' }])
    assert.equal(created, 1)
    assert.deepEqual(calls, [{ recursive: true }, { recursive: false }])
    await provider.dispose()
  })

  void test('rejects relative roots before constructing a module', async () => {
    const provider = new ProjectCapabilityProvider({
      createKernel: async () => {
        throw new Error('must not construct')
      },
    })
    await assert.rejects(
      provider.invoke({
        projectRoot: 'relative/project',
        operation: 'project:status',
        input: {},
      }),
      /absolute path/
    )
  })

  void test('reads a real project file through the Project owner', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'velaros-workbench-workspace-'))
    const provider = new ProjectCapabilityProvider()
    try {
      await writeFile(
        join(projectRoot, 'kernel-contract.txt'),
        'workspace-owner-read',
        'utf8'
      )

      const result = await provider.invoke({
        projectRoot,
        operation: 'project:read',
        input: { path: 'kernel-contract.txt', maxChars: 1_024 },
      }) as {
        rootPath: string
        count: number
        files: Array<{
          snapshot: { path: string }
          content: string
        }>
      }

      assert.equal(result.rootPath, projectRoot)
      assert.equal(result.count, 1)
      assert.equal(result.files[0]?.snapshot.path, 'kernel-contract.txt')
      assert.equal(result.files[0]?.content, 'workspace-owner-read')
    } finally {
      await provider.dispose()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('routes the canonical AI code query to the Velar compiler graph without a CodeGraph index', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'velaros-workbench-velar-ai-'))
    const calls: unknown[] = []
    const velarLogicGraph = {
      isProject: () => true,
      queryProjectCode: async (_root: string, input: unknown) => {
        calls.push(input)
        return { source: 'velar-compiler', provider: 'velar-compiler', nodes: [] }
      },
      clear: () => undefined,
    } as unknown as WorkbenchVelarLogicGraphService
    const provider = new ProjectCapabilityProvider({
      velarLogicGraph,
      createKernel: async () => ({ root: projectRoot }) as ProjectKernel,
    })
    try {
      const project = await provider.resolveProject(projectRoot)
      const queryCode = project.tools.find((tool) => tool.name === 'project:query-code')
      assert.ok(queryCode)
      const result = await queryCode.execute({
        action: 'search_symbols',
        query: 'App',
        limit: 20,
      }, {}) as { source: string; provider: string }

      assert.deepEqual(calls, [{ action: 'search_symbols', query: 'App', limit: 20 }])
      assert.equal(result.source, 'velar-compiler')
      assert.equal(result.provider, 'velar-compiler')
    } finally {
      await provider.dispose()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})
