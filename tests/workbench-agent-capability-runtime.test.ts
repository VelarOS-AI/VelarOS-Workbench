import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

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
import type { WorkbenchKernelCapabilityRoutes } from '../src/main/kernel/WorkbenchKernelIpc'
import { WorkbenchKernelChannels } from '../src/shared/workbenchKernel'

interface PublishedCapabilityEvent {
  readonly type: string
  readonly payload: AgentCapabilityExecutionEventEnvelopeV1
}

class FakeIpcSender extends EventEmitter {
  public constructor(public readonly id: number) {
    super()
  }
}

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
const ipcSenders = new Map<number, FakeIpcSender>()
const rendererMessages: Array<{
  webContentsId: number
  channel: string
  payload: unknown
}> = []
const browserWindows = [1, 2].map((webContentsId) => ({
  isDestroyed: () => false,
  webContents: {
    id: webContentsId,
    send: (channel: string, payload: unknown) => {
      rendererMessages.push({ webContentsId, channel, payload })
    },
  },
}))

mock.module('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => browserWindows,
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

  void test('hands a rewind notice to the model as a system note, not a user turn', async () => {
    let received: WorkbenchAgentRunInput['messages'] = []
    const runtime = createRuntime(async (input) => {
      received = input.messages
      return { status: 'completed' }
    })
    await execute(runtime, [], new AbortController().signal, [
      { role: 'user', content: 'first request' },
      { role: 'user', content: 'Rewound 1 turn', conversationKind: 'system-notice' },
      { role: 'user', content: 'next request' },
    ])

    assert.equal(received.length, 3)
    assert.deepEqual(received[0], { role: 'user', content: 'first request' })
    assert.equal(received[1]?.role, 'user')
    assert.match(String(received[1]?.content), /^<sys_note [^>]*>[\s\S]*Rewound 1 turn/u)
    assert.deepEqual(received[2], { role: 'user', content: 'next request' })
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

  void test('settles an aborted signal as aborted even when the execution stack throws', async () => {
    const controller = new AbortController()
    const runtime = createRuntime(async (input) =>
      new Promise<WorkbenchAgentRunResult>((_resolve, reject) => {
        input.abortSignal.addEventListener('abort', () => reject(input.abortSignal.reason), {
          once: true,
        })
      })
    )
    const published: PublishedCapabilityEvent[] = []
    const execution = execute(runtime, published, controller.signal)

    controller.abort('Stopped by the user.')
    await execution

    assert.deepEqual(readTerminalKinds(published), ['aborted'])
  })

  void test('forwards only the Kernel event payload to renderer subscribers', async () => {
    rendererMessages.length = 0
    let subscription: ((event: KernelEvent<unknown>) => unknown) | undefined
    let finishInvocation!: (value: unknown) => void
    const runtime = {
      invokeCapability: () => new Promise<unknown>((resolve) => {
        finishInvocation = resolve
      }),
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
      createKernelRoutes(),
      {} as never,
      () => false,
      () => false
    )
    const payload = {
      protocolVersion: AgentCapabilityProtocolVersion,
      executionId: 'execution-1',
      sourceProductId: 'velaros.workbench',
      sourceSessionId: 'session-1',
      sessionCorrelationId: 'correlation-1',
      channel: 'agent',
      payload: { type: 'text-delta', text: 'answer' },
    } satisfies AgentCapabilityExecutionEventEnvelopeV1
    const invoke = ipcHandlers.get(WorkbenchKernelChannels.invoke)
    assert.ok(invoke)
    assert.ok(subscription)
    const pending = Promise.resolve(invoke(
      createIpcEvent(1),
      createKernelAgentRequest('execution-1', 'correlation-1')
    ))
    await Promise.resolve()

    await subscription({
      type: AgentCapabilityExecutionEventType,
      payload,
      sourceModuleId: 'velaros.agent.runtime',
      sourceGeneration: 1,
      sequence: 9,
    })

    assert.deepEqual(rendererMessages, [{
      webContentsId: 1,
      channel: WorkbenchKernelChannels.agentExecution,
      payload,
    }])
    finishInvocation({ status: 'completed' })
    await pending
    unregister()
  })

  void test('lets an observed done terminal win over a later abort request', async () => {
    rendererMessages.length = 0
    let subscription: ((event: KernelEvent<unknown>) => unknown) | undefined
    let invocationSignal: AbortSignal | undefined
    const runtime = {
      invokeCapability: (request: { signal?: AbortSignal }) => {
        invocationSignal = request.signal
        return new Promise<unknown>(() => undefined)
      },
      subscribeEvent: (
        _type: string,
        handler: (event: KernelEvent<unknown>) => unknown
      ) => {
        subscription = handler
        return () => undefined
      },
    } as unknown as Kernel
    const { registerWorkbenchKernelIpc } = await import(
      '../src/main/kernel/WorkbenchKernelIpc'
    )
    const unregister = registerWorkbenchKernelIpc(
      runtime,
      createKernelRoutes(),
      {} as never,
      () => false,
      () => false
    )
    const invoke = ipcHandlers.get(WorkbenchKernelChannels.invoke)
    const abort = ipcHandlers.get(WorkbenchKernelChannels.abortAgentExecution)
    assert.ok(invoke)
    assert.ok(abort)
    assert.ok(subscription)

    const executionId = 'execution-done-before-stop'
    const pending = Promise.resolve(invoke(
      createIpcEvent(1),
      createKernelAgentRequest(executionId, 'correlation-done-before-stop')
    ))
    await Promise.resolve()
    await subscription(createKernelAgentEvent(
      executionId,
      'correlation-done-before-stop',
      { type: 'runtime', payload: ChatRuntimeEvents.done() }
    ))

    assert.equal(await abort(createIpcEvent(1), { executionId }), false)
    assert.deepEqual(await pending, { ok: true, output: { status: 'completed' } })
    assert.equal(invocationSignal?.aborted, false)
    assert.deepEqual(rendererMessages.map(({ webContentsId }) => webContentsId), [1])

    unregister()
  })

  void test('bounds an unconfirmed abort without claiming termination and quarantines late events', async () => {
    rendererMessages.length = 0
    let subscription: ((event: KernelEvent<unknown>) => unknown) | undefined
    let invocationSignal: AbortSignal | undefined
    const neverSettles = new Promise<unknown>(() => undefined)
    const runtime = {
      invokeCapability: (request: { signal?: AbortSignal }) => {
        invocationSignal = request.signal
        return neverSettles
      },
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
      createKernelRoutes(),
      {} as never,
      () => false,
      () => false,
      { abortSettlementGraceMs: 5 }
    )
    const invoke = ipcHandlers.get(WorkbenchKernelChannels.invoke)
    const abort = ipcHandlers.get(WorkbenchKernelChannels.abortAgentExecution)
    assert.ok(invoke)
    assert.ok(abort)

    const executionId = 'execution-hung'
    const request = createKernelAgentRequest(executionId, 'correlation-hung')
    const pending = Promise.resolve(invoke(createIpcEvent(1), request))
    await Promise.resolve()

    assert.equal(await abort(createIpcEvent(1), { executionId }), true)
    const result = await pending
    assert.deepEqual(result, { ok: true, output: { status: 'error' } })
    assert.equal(invocationSignal?.aborted, true)

    const synthetic = rendererMessages.filter(
      ({ channel }) => channel === WorkbenchKernelChannels.agentExecution
    )
    assert.equal(synthetic.length, 1)
    assert.equal(synthetic[0]?.webContentsId, 1)
    assert.equal(readAgentEventKind((synthetic[0]?.payload as { payload?: unknown }).payload), 'error')

    assert.ok(subscription)
    await subscription({
      type: AgentCapabilityExecutionEventType,
      payload: {
        protocolVersion: AgentCapabilityProtocolVersion,
        executionId,
        sourceProductId: 'velaros.workbench',
        sourceSessionId: 'session-1',
        sessionCorrelationId: 'correlation-hung',
        channel: 'agent',
        payload: { type: 'text-delta', text: 'late output' },
      },
      sourceModuleId: 'velaros.agent.runtime',
      sourceGeneration: 1,
      sequence: 10,
    })
    assert.equal(rendererMessages.length, synthetic.length)

    unregister()
  })

  void test('binds execution ids and abort authority to the invoking renderer', async () => {
    rendererMessages.length = 0
    let invocationCount = 0
    let invocationSignal: AbortSignal | undefined
    const runtime = {
      invokeCapability: (request: { signal?: AbortSignal }) => {
        invocationCount += 1
        invocationSignal = request.signal
        return new Promise<unknown>(() => undefined)
      },
      subscribeEvent: () => () => undefined,
    } as unknown as Kernel
    const { registerWorkbenchKernelIpc } = await import(
      '../src/main/kernel/WorkbenchKernelIpc'
    )
    const unregister = registerWorkbenchKernelIpc(
      runtime,
      createKernelRoutes(),
      {} as never,
      () => false,
      () => false,
      { abortSettlementGraceMs: 5 }
    )
    const invoke = ipcHandlers.get(WorkbenchKernelChannels.invoke)
    const abort = ipcHandlers.get(WorkbenchKernelChannels.abortAgentExecution)
    assert.ok(invoke)
    assert.ok(abort)

    const request = createKernelAgentRequest('execution-shared', 'correlation-owner')
    const ownerInvocation = Promise.resolve(invoke(createIpcEvent(1), request))
    await Promise.resolve()

    const collision = await invoke(createIpcEvent(2), request)
    assert.equal((collision as { ok?: unknown }).ok, false)
    assert.equal(
      (collision as { error?: { code?: unknown } }).error?.code,
      'AGENT_EXECUTION_ID_CONFLICT'
    )
    assert.equal(invocationCount, 1)

    assert.equal(
      await abort(createIpcEvent(2), { executionId: 'execution-shared' }),
      false
    )
    assert.equal(invocationSignal?.aborted, false)
    assert.equal(
      await abort(createIpcEvent(1), { executionId: 'execution-shared' }),
      true
    )
    await ownerInvocation
    assert.equal(invocationSignal?.aborted, true)
    assert.deepEqual(new Set(rendererMessages.map(({ webContentsId }) => webContentsId)), new Set([1]))

    unregister()
  })

  void test('rejects an invalid Agent descriptor before invoking the Kernel', async () => {
    let invocationCount = 0
    const runtime = {
      invokeCapability: () => {
        invocationCount += 1
        return Promise.resolve({ status: 'completed' })
      },
      subscribeEvent: () => () => undefined,
    } as unknown as Kernel
    const { registerWorkbenchKernelIpc } = await import(
      '../src/main/kernel/WorkbenchKernelIpc'
    )
    const unregister = registerWorkbenchKernelIpc(
      runtime,
      createKernelRoutes(),
      {} as never,
      () => false,
      () => false
    )
    const invoke = ipcHandlers.get(WorkbenchKernelChannels.invoke)
    assert.ok(invoke)

    const valid = createKernelAgentRequest('execution-invalid', 'correlation-invalid') as {
      route: 'agent.execute'
      input: Record<string, unknown>
    }
    const invalidRequests = [
      { route: 'agent.execute', input: { execution: { id: 'missing-source' } } },
      { ...valid, input: { ...valid.input, protocolVersion: 2 } },
      { ...valid, input: { ...valid.input, config: { abortController: {} } } },
    ]
    for (const request of invalidRequests) {
      const result = await invoke(createIpcEvent(1), request)
      assert.deepEqual(result, {
        ok: false,
        error: {
          code: 'KERNEL_REQUEST_INVALID',
          message: 'Workbench Agent execution descriptor is invalid.',
          retryable: false,
          details: null,
        },
      })
    }
    assert.equal(invocationCount, 0)

    unregister()
  })

  void test('tombstones closed execution ids across delayed abort and reuse ordering', async () => {
    let invocationCount = 0
    const runtime = {
      invokeCapability: () => {
        invocationCount += 1
        return Promise.resolve({ status: 'completed' })
      },
      subscribeEvent: () => () => undefined,
    } as unknown as Kernel
    const { registerWorkbenchKernelIpc } = await import(
      '../src/main/kernel/WorkbenchKernelIpc'
    )
    const unregister = registerWorkbenchKernelIpc(
      runtime,
      createKernelRoutes(),
      {} as never,
      () => false,
      () => false
    )
    const invoke = ipcHandlers.get(WorkbenchKernelChannels.invoke)
    const abort = ipcHandlers.get(WorkbenchKernelChannels.abortAgentExecution)
    assert.ok(invoke)
    assert.ok(abort)

    const executionId = 'execution-tombstoned'
    const request = createKernelAgentRequest(executionId, 'correlation-tombstoned')
    assert.deepEqual(await invoke(createIpcEvent(1), request), {
      ok: true,
      output: { status: 'completed' },
    })

    // 旧 abort 先到，不能改变墓碑；随后相同 id 的新 invoke 仍必须被拒绝。
    assert.equal(await abort(createIpcEvent(1), { executionId }), false)
    const reused = await invoke(createIpcEvent(1), request)
    assert.equal((reused as { ok?: unknown }).ok, false)
    assert.equal(
      (reused as { error?: { code?: unknown } }).error?.code,
      'AGENT_EXECUTION_ID_CONFLICT'
    )

    // 新 invoke 尝试先到也不会占位，之后再来的旧 abort 仍只能得到 false。
    assert.equal(await abort(createIpcEvent(1), { executionId }), false)
    assert.equal(invocationCount, 1)

    unregister()
  })

  void test('aborts only the active executions owned by a destroyed renderer', async () => {
    const invocationSignals: AbortSignal[] = []
    const runtime = {
      invokeCapability: (request: { signal?: AbortSignal }) => {
        assert.ok(request.signal)
        invocationSignals.push(request.signal)
        return new Promise<unknown>(() => undefined)
      },
      subscribeEvent: () => () => undefined,
    } as unknown as Kernel
    const { registerWorkbenchKernelIpc } = await import(
      '../src/main/kernel/WorkbenchKernelIpc'
    )
    const unregister = registerWorkbenchKernelIpc(
      runtime,
      createKernelRoutes(),
      {} as never,
      () => false,
      () => false
    )
    const invoke = ipcHandlers.get(WorkbenchKernelChannels.invoke)
    assert.ok(invoke)

    const ownerOne = Promise.resolve(invoke(
      createIpcEvent(11),
      createKernelAgentRequest('execution-owner-1', 'correlation-owner-1')
    ))
    const ownerTwo = Promise.resolve(invoke(
      createIpcEvent(12),
      createKernelAgentRequest('execution-owner-2', 'correlation-owner-2')
    ))
    await Promise.resolve()
    assert.equal(invocationSignals.length, 2)

    ipcSenders.get(11)?.emit('destroyed')
    assert.deepEqual(await ownerOne, { ok: true, output: { status: 'aborted' } })
    assert.equal(invocationSignals[0]?.aborted, true)
    assert.equal(invocationSignals[1]?.aborted, false)

    unregister()
    await ownerTwo
    assert.equal(invocationSignals[1]?.aborted, true)
  })
})

function createIpcEvent(webContentsId: number): unknown {
  let sender = ipcSenders.get(webContentsId)
  if (!sender) {
    sender = new FakeIpcSender(webContentsId)
    ipcSenders.set(webContentsId, sender)
  }
  return { sender }
}

function createKernelRoutes(): WorkbenchKernelCapabilityRoutes {
  return {
    'agent.execute': { capabilityId: 'velaros.agent', operation: 'execute' },
    'agent.health': { capabilityId: 'velaros.agent', operation: 'health' },
  }
}

function createKernelAgentEvent(
  executionId: string,
  correlationId: string,
  payload: unknown
): KernelEvent<unknown> {
  return {
    type: AgentCapabilityExecutionEventType,
    payload: {
      protocolVersion: AgentCapabilityProtocolVersion,
      executionId,
      sourceProductId: 'velaros.workbench',
      sourceSessionId: 'session-1',
      sessionCorrelationId: correlationId,
      channel: 'agent',
      payload,
    },
    sourceModuleId: 'velaros.agent.runtime',
    sourceGeneration: 1,
    sequence: 1,
  }
}

function createKernelAgentRequest(executionId: string, correlationId: string): unknown {
  return {
    route: 'agent.execute',
    input: {
      protocolVersion: AgentCapabilityProtocolVersion,
      execution: {
        id: executionId,
        source: {
          productId: 'velaros.workbench',
          sessionId: 'session-1',
          correlationId,
        },
      },
      messages: [],
      config: {},
    },
  }
}

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
  published: PublishedCapabilityEvent[] = [],
  signal: AbortSignal = new AbortController().signal,
  messages: ReadonlyArray<Record<string, unknown>> = [{ role: 'user', content: 'hello' }]
): Promise<PublishedCapabilityEvent[]> {
  const context: AgentCapabilityExecutionContext = {
    signal,
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
    messages,
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
