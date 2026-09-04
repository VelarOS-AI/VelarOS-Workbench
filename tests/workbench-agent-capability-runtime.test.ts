import assert from 'node:assert/strict'

import { describe, mock, test } from 'bun:test'

import type { AgentCapabilityExecutionContext } from '@velaros-ai/agent'
import { ChatRuntimeEvents } from '@velaros-ai/agent/protocol'
import {
  type AgentCapabilityExecutionEventEnvelopeV1,
  AgentCapabilityExecutionEventType,
  AgentCapabilityProtocolVersion,
} from '@velaros-ai/agent/protocol/agent-capability'
import type { KernelEvent } from '@velaros-ai/kernel/contracts/abi'
import type { Kernel } from '@velaros-ai/kernel/runtime'

import type {
  WorkbenchAgentExecutionStack,
  WorkbenchAgentRunInput,
  WorkbenchAgentRunResult,
} from '../src/main/agent/WorkbenchAgentExecutionStack'
import { WorkbenchAgentCapabilityRuntime } from '../src/main/kernel/WorkbenchAgentCapabilityRuntime'
import { WorkbenchKernelChannels } from '../src/shared/workbenchKernel'

interface PublishedCapabilityEvent {
  readonly type: string
  readonly payload: AgentCapabilityExecutionEventEnvelopeV1
}

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
const rendererMessages: Array<{ channel: string; payload: unknown }> = []

mock.module('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, payload: unknown) => {
          rendererMessages.push({ channel, payload })
        },
      },
    }],
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      ipcHandlers.delete(channel)
    },
  },
}))

void describe('Workbench Agent capability runtime', () => {
  void test('adds a done event after text when the execution stack omits its terminal event', async () => {
    const runtime = createRuntime(async (input) => {
      input.events.emitTextDelta('answer')
      return { status: 'completed' }
    })
    const published = await execute(runtime)

    assert.deepEqual(readAgentEvents(published).map(readAgentEventKind), [
      'text-delta',
      'done',
    ])
  })

  void test('adds aborted and error terminal events for terminal results', async () => {
    for (const status of ['aborted', 'error'] as const) {
      const runtime = createRuntime(async () => ({ status }))
      const published = await execute(runtime)

      assert.deepEqual(readTerminalKinds(published), [status])
    }
  })

  void test('does not duplicate terminal events already emitted by the execution stack', async () => {
    const scenarios = [
      {
        result: { status: 'completed' } as const,
        emit: (input: WorkbenchAgentRunInput) =>
          input.events.emitRuntime(ChatRuntimeEvents.done('already complete')),
        kind: 'done',
      },
      {
        result: { status: 'aborted' } as const,
        emit: (input: WorkbenchAgentRunInput) =>
          input.events.emitRuntime(ChatRuntimeEvents.aborted('already aborted')),
        kind: 'aborted',
      },
      {
        result: { status: 'error' } as const,
        emit: (input: WorkbenchAgentRunInput) =>
          input.events.emitRuntime(ChatRuntimeEvents.error('already failed')),
        kind: 'error',
      },
    ]

    for (const scenario of scenarios) {
      const runtime = createRuntime(async (input) => {
        scenario.emit(input)
        return scenario.result
      })
      const published = await execute(runtime)

      assert.deepEqual(readTerminalKinds(published), [scenario.kind])
    }
  })

  void test('emits an error terminal event and rethrows the original execution error', async () => {
    const failure = new Error('provider exploded')
    const runtime = createRuntime(async () => {
      throw failure
    })
    const published: PublishedCapabilityEvent[] = []

    await assert.rejects(execute(runtime, published), (error) => error === failure)
    assert.deepEqual(readTerminalKinds(published), ['error'])
    const terminal = readAgentEvents(published).find(
      (event) => readAgentEventKind(event) === 'error'
    )
    assert.equal(
      ((terminal as { payload: { message?: unknown } }).payload.message),
      failure.message
    )
  })

  void test('forwards only the Kernel event payload to renderer subscribers', async () => {
    rendererMessages.length = 0
    let subscription: ((event: KernelEvent<unknown>) => unknown) | undefined
    const runtime = {
      subscribeEvent: (
        type: string,
        handler: (event: KernelEvent<unknown>) => unknown
      ) => {
        assert.equal(type, AgentCapabilityExecutionEventType)
        subscription = handler
        return () => undefined
      },
    } as unknown as Kernel
    const { registerWorkbenchKernelIpc } = await import(
      '../src/main/kernel/WorkbenchKernelIpc'
    )
    const unregister = registerWorkbenchKernelIpc(
      runtime,
      {} as never,
      {} as never,
      () => false,
      () => false
    )
    const payload = {
      protocolVersion: AgentCapabilityProtocolVersion,
      executionId: 'execution-1',
      sourceProductId: 'velaros.workbench',
      sourceSessionId: 'session-1',
      channel: 'agent',
      payload: { type: 'text-delta', text: 'answer' },
    } satisfies AgentCapabilityExecutionEventEnvelopeV1
    assert.ok(subscription)

    await subscription({
      type: AgentCapabilityExecutionEventType,
      payload,
      sourceModuleId: 'velaros.agent.runtime',
      sourceGeneration: 1,
      sequence: 9,
    })

    assert.deepEqual(rendererMessages, [{
      channel: WorkbenchKernelChannels.agentExecution,
      payload,
    }])
    unregister()
  })
})

function createRuntime(
  run: (input: WorkbenchAgentRunInput) => Promise<WorkbenchAgentRunResult>
): WorkbenchAgentCapabilityRuntime {
  const stack = {
    run,
    dispose: async () => undefined,
  } as unknown as WorkbenchAgentExecutionStack
  return new WorkbenchAgentCapabilityRuntime(stack)
}

async function execute(
  runtime: WorkbenchAgentCapabilityRuntime,
  published: PublishedCapabilityEvent[] = []
): Promise<PublishedCapabilityEvent[]> {
  const context: AgentCapabilityExecutionContext = {
    signal: new AbortController().signal,
    publish: async (type, payload) => {
      published.push({
        type,
        payload: payload as AgentCapabilityExecutionEventEnvelopeV1,
      })
    },
  }
  await runtime.execute(undefined, {
    protocolVersion: AgentCapabilityProtocolVersion,
    execution: {
      id: 'execution-1',
      source: {
        productId: 'velaros.workbench',
        sessionId: 'session-1',
        correlationId: 'correlation-1',
      },
      scopeMetadata: { resourceId: '/workspace' },
    },
    messages: [{ role: 'user', content: 'hello' }],
    config: {
      modelSelection: { provider: 'test', model: 'test' },
      executionModes: [],
    },
  }, context)
  return published
}

function readAgentEvents(published: readonly PublishedCapabilityEvent[]): unknown[] {
  return published
    .filter(({ type, payload }) =>
      type === AgentCapabilityExecutionEventType && payload.channel === 'agent'
    )
    .map(({ payload }) => payload.payload)
}

function readTerminalKinds(published: readonly PublishedCapabilityEvent[]): string[] {
  return readAgentEvents(published)
    .map(readAgentEventKind)
    .filter((kind): kind is string =>
      kind === 'done' || kind === 'aborted' || kind === 'error'
    )
}

function readAgentEventKind(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const event = value as { type?: unknown; payload?: unknown }
  if (event.type === 'runtime' && event.payload && typeof event.payload === 'object') {
    const kind = (event.payload as { kind?: unknown }).kind
    return typeof kind === 'string' ? kind : null
  }
  return typeof event.type === 'string' ? event.type : null
}
