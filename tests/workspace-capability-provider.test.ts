import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import type { VelarosWorkspaceBridge } from '@velaros-ai/workspace'

import { PublishedWorkspaceCapabilityProvider } from '../src/main/workspace/PublishedWorkspaceCapabilityProvider'

void describe('published Workspace capability provider', () => {
  void test('creates one injected module bridge per project and invokes its tool', async () => {
    let created = 0
    const calls: unknown[] = []
    const provider = new PublishedWorkspaceCapabilityProvider({
      createBridge: async () => {
        created += 1
        return {
          tools: [{
            name: 'ws_list_files',
            execute: async (input: unknown) => {
              calls.push(input)
              return [{ path: 'src/index.ts', type: 'file' }]
            },
          }],
          asModule: () => ({ name: 'workspace', version: '1.2.0' }),
        } as unknown as VelarosWorkspaceBridge
      },
    })

    const first = await provider.invoke({
      projectRoot: '/tmp/workbench-project',
      operation: 'ws_list_files',
      input: { recursive: true },
    })
    const second = await provider.invoke({
      projectRoot: '/tmp/workbench-project',
      operation: 'ws_list_files',
      input: { recursive: false },
    })

    assert.deepEqual(first, [{ path: 'src/index.ts', type: 'file' }])
    assert.deepEqual(second, [{ path: 'src/index.ts', type: 'file' }])
    assert.equal(created, 1)
    assert.deepEqual(calls, [{ recursive: true }, { recursive: false }])
    await provider.dispose()
  })

  void test('rejects relative roots before constructing a module', async () => {
    const provider = new PublishedWorkspaceCapabilityProvider({
      createBridge: async () => {
        throw new Error('must not construct')
      },
    })
    await assert.rejects(
      provider.invoke({
        projectRoot: 'relative/project',
        operation: 'ws_status',
        input: {},
      }),
      /absolute path/
    )
  })

  void test('reads a real project file through the published Workspace owner', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'velaros-workbench-workspace-'))
    const provider = new PublishedWorkspaceCapabilityProvider()
    try {
      await writeFile(
        join(projectRoot, 'kernel-contract.txt'),
        'workspace-owner-read',
        'utf8'
      )

      const result = await provider.invoke({
        projectRoot,
        operation: 'ws_read',
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
