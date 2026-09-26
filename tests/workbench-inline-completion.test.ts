import { describe, expect, test } from 'bun:test'

import type { ModelRequestClient } from '@velaros-ai/model'

import { WorkbenchInlineCompletionGenerator } from '../src/main/workspace/language/WorkbenchInlineCompletion'
import {
  createStandaloneWorkbenchConfiguredModelSelectorProviders,
  createStandaloneWorkbenchProviderModelOptions,
  getStandaloneWorkbenchModelProviderPreset,
  listStandaloneWorkbenchVisibleModelProviderPresets,
  resolveStandaloneWorkbenchProviderModel,
  StandaloneWorkbenchModelProviderPresets,
} from '../src/renderer/src/runtime/standaloneWorkbenchModelCatalog'
import {
  getStandaloneWorkbenchModelConfig,
  selectStandaloneWorkbenchAgentModel,
  selectStandaloneWorkbenchModel,
  selectStandaloneWorkbenchModelProvider,
  StandaloneWorkbenchCompletionDisabledOptionValue,
  updateStandaloneWorkbenchModelConfig,
} from '../src/renderer/src/runtime/standaloneWorkbenchModelConfig'

import { assertCurrentWorkbenchPrompt } from './helpers/workbenchPromptAudit'

describe('Workbench inline completion', () => {
  test('offers supported providers without raw custom-provider setup', () => {
    expect(StandaloneWorkbenchModelProviderPresets.some((provider) => provider.id === 'openai'))
      .toBe(true)
    expect(StandaloneWorkbenchModelProviderPresets.some((provider) => provider.id === 'anthropic'))
      .toBe(true)
    expect(StandaloneWorkbenchModelProviderPresets.some((provider) => provider.id === 'custom'))
      .toBe(false)
    expect(StandaloneWorkbenchModelProviderPresets.some((provider) => String(provider.id) === 'velar-dev'))
      .toBe(false)

    const openAI = getStandaloneWorkbenchModelProviderPreset('openai')
    expect(openAI.defaultBaseURL).toBe('https://api.openai.com/v1')
    expect(openAI.baseURLConfigurable).toBe(false)
    expect(openAI.models).toContain(openAI.defaultModel)
    expect(openAI.models).toContain(openAI.completionModel)
    expect(resolveStandaloneWorkbenchProviderModel('openai', 'remote-model-next', 'agent'))
      .toBe('remote-model-next')

    const gateway = getStandaloneWorkbenchModelProviderPreset('openai-compatible-gateway')
    expect(gateway.baseURLConfigurable).toBe(true)
    expect(gateway.validationKind).toBe('openai-compatible-models')
  })

  test('adds Velar Dev only from explicit online account authorization', () => {
    expect(listStandaloneWorkbenchVisibleModelProviderPresets([]).some(
      (provider) => String(provider.id) === 'velar-dev'
    )).toBe(false)

    const providers = listStandaloneWorkbenchVisibleModelProviderPresets([{
      providerId: 'velar-dev',
      displayName: 'Velar Dev',
      enabled: true,
      defaultModel: 'velar-dev/Z3B0LTUuNi1zb2w',
      models: [
        {
          id: 'velar-dev/Z3B0LTUuNi1zb2w',
          label: 'GPT 5.6 Sol',
          status: 'available',
        },
      ],
    }])
    expect(providers[0]).toMatchObject({
      id: 'velar-dev',
      label: 'VelarOS-Dev',
      defaultModel: 'velar-dev/Z3B0LTUuNi1zb2w',
      models: ['velar-dev/Z3B0LTUuNi1zb2w'],
      apiKeyOptional: true,
      baseURLConfigurable: false,
    })
  })

  test('projects only the configured chat model into the composer selector', () => {
    const providers = createStandaloneWorkbenchConfiguredModelSelectorProviders(
      'openai',
      'gpt-configured'
    )

    expect(providers).toHaveLength(1)
    expect(providers[0]?.value).toBe('openai')
    expect(providers[0]?.models).toEqual([{
      value: 'gpt-configured',
      label: 'gpt-configured',
    }])
  })

  test('uses the remote provider catalog while retaining configured selections', () => {
    expect(createStandaloneWorkbenchProviderModelOptions(
      [
        { id: 'remote-a', label: 'Remote A' },
        { id: 'remote-b', label: 'Remote B' },
      ],
      ['remote-a', 'configured-legacy']
    )).toEqual([
      { value: 'remote-a', label: 'Remote A' },
      { value: 'remote-b', label: 'Remote B' },
      { value: 'configured-legacy', label: 'configured-legacy' },
    ])

    expect(createStandaloneWorkbenchProviderModelOptions(
      [{ id: 'velar-dev/current', label: 'Current' }],
      ['velar-dev/stale'],
      false
    )).toEqual([{ value: 'velar-dev/current', label: 'Current' }])
  })

  test('keeps a custom gateway address when the configured model changes', () => {
    const originalConfig = getStandaloneWorkbenchModelConfig()
    try {
      selectStandaloneWorkbenchModelProvider('openai-compatible-gateway')
      updateStandaloneWorkbenchModelConfig({
        baseURL: 'https://gateway.example.com/v1',
      })
      selectStandaloneWorkbenchAgentModel('openai-compatible-gateway', 'relay-model')

      expect(getStandaloneWorkbenchModelConfig()).toMatchObject({
        provider: 'openai-compatible-gateway',
        model: 'relay-model',
        baseURL: 'https://gateway.example.com/v1',
      })
    } finally {
      updateStandaloneWorkbenchModelConfig(originalConfig)
    }
  })

  test('uses the completion model selection as the completion enabled state', () => {
    const originalConfig = getStandaloneWorkbenchModelConfig()
    try {
      selectStandaloneWorkbenchModel(
        'openrouter',
        StandaloneWorkbenchCompletionDisabledOptionValue,
        'completion'
      )
      expect(getStandaloneWorkbenchModelConfig().completionModel).toBe('')

      selectStandaloneWorkbenchModel('openrouter', 'openrouter/auto', 'completion')
      expect(getStandaloneWorkbenchModelConfig().completionModel).toBe('openrouter/auto')
    } finally {
      updateStandaloneWorkbenchModelConfig(originalConfig)
    }
  })

  test('uses the independent completion model path and cleans fenced output', async () => {
    let prompt = ''
    let instructions = ''
    const requestPort: Pick<ModelRequestClient, 'collectTextStream'> = {
      collectTextStream: async (request) => {
        instructions = request.system ?? ''
        const content = request.messages[0]?.content
        prompt = typeof content === 'string' ? content : ''
        expect(request.endpoint).toBe('workbench.inline-completion')
        expect(request.system).toContain('Continue the code exactly at the cursor marked by <|cursor|>.')
        expect(request.system).toContain('Output ONLY the raw text to insert at the cursor.')
        expect(request.maxOutputTokens).toBe(160)
        expect(request.maxRetries).toBe(0)
        expect(request.stopWhen?.('x'.repeat(480))).toBe(false)
        expect(request.stopWhen?.('x'.repeat(481))).toBe(true)
        return '```ts\nreturn total + 1\n```\n'
      },
    }
    const generator = new WorkbenchInlineCompletionGenerator(requestPort)
    const result = await generator.generate({
      projectRoot: '/tmp/project',
      path: 'src/value.ts',
      language: 'typescript',
      prefix: 'function next(total: number) {\n  ',
      suffix: '\n}',
      modelSelection: {
        provider: 'ollama',
        model: 'gpt-oss:20b',
        apiKey: '',
        baseURL: 'http://localhost:11434/v1',
      },
    })

    expect(result).toEqual({ completion: 'return total + 1' })
    assertCurrentWorkbenchPrompt({ prompt: [{ role: 'system', content: instructions }] })
    expect(prompt).toContain('Language: typescript')
    expect(prompt).toContain('File: value.ts')
    expect(prompt).toContain('<|cursor|>')
  })

  test('does not request a model for an empty prefix', async () => {
    let calls = 0
    const requestPort: Pick<ModelRequestClient, 'collectTextStream'> = {
      collectTextStream: async () => {
        calls += 1
        return 'unused'
      },
    }
    const generator = new WorkbenchInlineCompletionGenerator(requestPort)
    const result = await generator.generate({
      projectRoot: '/tmp/project',
      language: 'typescript',
      prefix: '   ',
      suffix: '',
      modelSelection: {
        provider: 'ollama',
        model: 'gpt-oss:20b',
        apiKey: '',
        baseURL: 'http://localhost:11434/v1',
      },
    })

    expect(result).toEqual({ completion: '' })
    expect(calls).toBe(0)
  })
})
