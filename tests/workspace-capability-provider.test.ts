import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { VelarosWorkspaceBridge } from '@velaros-ai/workspace'

import { PublishedWorkspaceCapabilityProvider } from '../apps/workbench/src/main/workspace/PublishedWorkspaceCapabilityProvider'

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
})
