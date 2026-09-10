import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import type { ModelRuntimeComposition } from '@velaros-ai/model/node'

import { createWorkbenchTeamModelRoutingPort } from '../src/main/agent/WorkbenchSubAgentPolicy'

function catalogRuntime(
  listProviderModels: (request: { provider: string; apiKey: string }) => Promise<unknown>
): ModelRuntimeComposition {
  return { providerModelCatalogService: { listProviderModels } } as unknown as ModelRuntimeComposition
}

void describe('Workbench sub-agent model routing', () => {
  void test('offers the configured models of the main model provider and caches the catalog', async () => {
    let fetches = 0
    const port = createWorkbenchTeamModelRoutingPort(
      catalogRuntime(async (request) => {
        fetches += 1
        return {
          provider: request.provider,
          source: 'remote',
          fetchedAt: 0,
          models: [
            { id: 'deepseek-chat', label: 'DeepSeek Chat' },
            { id: 'deepseek-legacy', label: 'Legacy', available: false },
          ],
        }
      })
    )
    const selection = { provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk', baseURL: '' }

    assert.deepEqual(await port.listSelectableModels?.(selection), [
      { id: 'deepseek-chat', label: 'DeepSeek Chat' },
    ])
    await port.listSelectableModels?.(selection)
    assert.equal(fetches, 1, '每次派发都会问：缓存期内同一厂商 + 凭据只取一次目录')
    // 自定义端点接受任意 id：不给目录，调度器按原样透传。
    assert.equal(await port.listSelectableModels?.({ provider: 'custom', model: 'x' }), null)
  })

  void test('reads managed providers from the account catalog', async () => {
    const asked: string[] = []
    const port = createWorkbenchTeamModelRoutingPort(catalogRuntime(async () => null), async (id) => {
      asked.push(id)
      return [{ id: 'velar-dev/gpt-5.6-sol', label: 'gpt-5.6-sol' }]
    })

    assert.deepEqual(await port.listSelectableModels?.({ provider: 'velar-dev', model: 'x' }), [
      { id: 'velar-dev/gpt-5.6-sol', label: 'gpt-5.6-sol' },
    ])
    await port.listSelectableModels?.({ provider: 'velar-dev', model: 'x' })
    assert.deepEqual(asked, ['velar-dev'])
  })

  void test('does not pin a failed catalog read', async () => {
    let fetches = 0
    const port = createWorkbenchTeamModelRoutingPort(
      catalogRuntime(async () => {
        fetches += 1
        throw new Error('offline')
      })
    )
    const selection = { provider: 'openai', model: 'gpt-5', apiKey: 'sk', baseURL: '' }

    assert.equal(await port.listSelectableModels?.(selection), null)
    await Promise.resolve()
    assert.equal(await port.listSelectableModels?.(selection), null)
    assert.equal(fetches, 2, '读失败不进缓存，下一次派发重新尝试')
  })
})
