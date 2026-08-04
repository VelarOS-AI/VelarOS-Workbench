import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import type { ProjectKernel } from '@velaros-ai/project/runtime'

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
})
