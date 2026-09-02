import assert from 'node:assert/strict'

import { test } from 'bun:test'

import { createWorkbenchToolContext } from '../src/main/agent/WorkbenchAgentExecutionStack'

void test('Workbench agent tool context tracks model input modalities required by SoloLoop', () => {
  const context = createWorkbenchToolContext({
    sessionId: 'session-1',
    projectRoot: '/tmp/workbench-project',
    abortSignal: new AbortController().signal,
    tracker: {} as never,
    registry: {
      names: [],
      listAvailable: () => [],
      listCategories: () => [],
    } as never,
  }) as {
    getSupportedModelInputModalities: () => readonly string[]
    setSupportedModelInputModalities: (
      modalities: ReadonlyArray<'text' | 'image' | 'audio'>
    ) => void
  }

  assert.deepEqual(context.getSupportedModelInputModalities(), ['text'])
  context.setSupportedModelInputModalities(['text', 'image', 'image'])
  assert.deepEqual(context.getSupportedModelInputModalities(), ['text', 'image'])
})
