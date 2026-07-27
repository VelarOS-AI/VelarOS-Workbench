import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type {
  ConnectedKernelDaemon,
  KernelClient,
  KernelClientEventHandler,
} from '@velaros-ai/kernel-client'
import { KernelClientError } from '@velaros-ai/kernel-client'

import { WorkbenchKernelClientRuntime } from '../apps/workbench/src/main/kernel/WorkbenchKernelClientRuntime'

function createConnection(options: {
  health?: 'healthy' | 'degraded'
  instanceId?: string
  onDispose?: () => void
  onCall?: (request: {
    callId: string
    capabilityId: string
    operation: string
    input: unknown
  }) => unknown
  onSubscribe?: (eventType: string, handler: KernelClientEventHandler) => void
} = {}): ConnectedKernelDaemon {
  const modules = [
    {
      id: 'velaros.workspace.module',
      version: '1.0.0',
      apiVersion: 1,
      provides: [{ id: 'velaros.workspace', version: '1.0.0' }],
      requires: [],
      optionalRequires: [],
      permissions: [],
      isolation: 'in-process' as const,
      catalogRevision: 'velaros.workspace.module@1.0.0#1',
    },
  ]
  const health = options.health ?? 'healthy'
  const client = {
    health: async () => ({
      status: health,
      modules: [
        {
          id: modules[0]!.id,
          version: modules[0]!.version,
          generation: 1,
          status: 'ready' as const,
          health: {
            status: health === 'healthy' ? 'healthy' as const : 'degraded' as const,
          },
        },
      ],
    }),
    call: async (request: {
      protocolVersion: 2
      callId: string
      capabilityId: string
      operation: string
      scope: unknown
      input: unknown
    }) => ({
      protocolVersion: 2 as const,
      callId: request.callId,
      status: 'ok' as const,
      output: options.onCall?.(request),
    }),
    subscribe: async (eventType: string, handler: KernelClientEventHandler) => {
      options.onSubscribe?.(eventType, handler)
      return { dispose: () => undefined }
    },
    dispose: () => options.onDispose?.(),
  } as unknown as KernelClient

  return {
    client,
    descriptor: {
      authToken: 'not-exposed-to-renderer-00000000000000000000',
      instanceId: options.instanceId ?? 'kernel-instance',
      protocolVersion: 2,
      kernelVersion: '0.2.0',
      pid: 42,
      startedAt: 100,
      endpoint: { kind: 'unix', path: '/tmp/velaros-kernel.sock' },
    },
    handshake: {
      protocolVersion: 2,
      kernelVersion: '0.2.0',
      modules,
    },
  }
}

void describe('Workbench Kernel client composition root', () => {
  void test('projects handshake, health and capability catalog without secrets', async () => {
    const runtime = new WorkbenchKernelClientRuntime({
      connect: async () => createConnection(),
      now: () => 200,
    })

    const status = await runtime.start()

    assert.equal(status.state, 'ready')
    assert.equal(status.connected, true)
    assert.equal(status.handshake?.kernelVersion, '0.2.0')
    assert.equal(status.health?.status, 'healthy')
    assert.deepEqual(status.capabilities, [
      {
        id: 'velaros.workspace',
        version: '1.0.0',
        moduleId: 'velaros.workspace.module',
        moduleVersion: '1.0.0',
        catalogRevision: 'velaros.workspace.module@1.0.0#1',
      },
    ])
    assert.equal('authToken' in (status.daemon ?? {}), false)
    assert.equal('endpoint' in (status.daemon ?? {}), false)

    await runtime.dispose()
  })

  void test('degrades when daemon is absent and retries the same discovery path', async () => {
    let attempts = 0
    const runtime = new WorkbenchKernelClientRuntime({
      connect: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('daemon unavailable')
        return createConnection({ instanceId: 'recovered-instance' })
      },
      now: () => attempts,
    })

    const unavailable = await runtime.start()
    assert.equal(unavailable.state, 'degraded')
    assert.equal(unavailable.connected, false)
    assert.equal(unavailable.error?.code, 'KERNEL_CONNECTION_FAILED')
    assert.equal(unavailable.error?.retryable, true)

    const recovered = await runtime.retry()
    assert.equal(recovered.state, 'ready')
    assert.equal(recovered.daemon?.instanceId, 'recovered-instance')
    assert.equal(attempts, 2)

    await runtime.dispose()
  })

  void test('does not report an incompatible shared daemon as Workbench-ready', async () => {
    const runtime = new WorkbenchKernelClientRuntime({
      connect: async () => createConnection(),
      requiredCapabilityIds: ['velaros.workspace', 'velaros.browser'],
    })

    const status = await runtime.start()

    assert.equal(status.connected, true)
    assert.equal(status.state, 'degraded')
    assert.equal(status.error?.code, 'KERNEL_CAPABILITY_UNAVAILABLE')
    assert.match(status.error?.message ?? '', /velaros\.browser/u)
    await runtime.dispose()
  })

  void test('starts one local Kernel when daemon discovery reports not running', async () => {
    let connectAttempts = 0
    let localStarts = 0
    let localDisposals = 0
    const runtime = new WorkbenchKernelClientRuntime({
      connect: async () => {
        connectAttempts += 1
        if (connectAttempts === 1) {
          throw new KernelClientError(
            'DAEMON_NOT_RUNNING',
            'Kernel daemon endpoint is not available'
          )
        }
        return createConnection({ instanceId: 'workbench-local-kernel' })
      },
      startLocal: async () => {
        localStarts += 1
        return {
          dispose: async () => {
            localDisposals += 1
          },
        }
      },
    })

    const [first, concurrent] = await Promise.all([runtime.start(), runtime.start()])

    assert.equal(first.state, 'ready')
    assert.equal(concurrent.state, 'ready')
    assert.equal(first.daemon?.instanceId, 'workbench-local-kernel')
    assert.equal(connectAttempts, 2)
    assert.equal(localStarts, 1)

    await runtime.dispose()
    assert.equal(localDisposals, 1)
  })

  void test('connects to the race winner when local Kernel start loses the daemon lock', async () => {
    let connectAttempts = 0
    let localStarts = 0
    const runtime = new WorkbenchKernelClientRuntime({
      connect: async () => {
        connectAttempts += 1
        if (connectAttempts === 1) {
          throw new KernelClientError(
            'DAEMON_NOT_RUNNING',
            'Kernel daemon endpoint is not available'
          )
        }
        return createConnection({ instanceId: 'race-winner' })
      },
      startLocal: async () => {
        localStarts += 1
        throw new KernelClientError(
          'DAEMON_ALREADY_RUNNING',
          'A Kernel daemon already owns the local endpoint'
        )
      },
    })

    const status = await runtime.start()

    assert.equal(status.state, 'ready')
    assert.equal(status.daemon?.instanceId, 'race-winner')
    assert.equal(connectAttempts, 2)
    assert.equal(localStarts, 1)
    await runtime.dispose()
  })

  void test('invokes an injected capability through the generic Kernel envelope', async () => {
    let observed: unknown
    const runtime = new WorkbenchKernelClientRuntime({
      connect: async () => createConnection({
        onCall: (request) => {
          observed = request
          return { files: ['src/index.ts'] }
        },
      }),
      nextCallId: () => 'workbench-call-1',
    })
    await runtime.start()

    const output = await runtime.invoke(
      { capabilityId: 'velaros.workspace', operation: 'ws_list_files' },
      { recursive: true }
    )

    assert.deepEqual(output, { files: ['src/index.ts'] })
    assert.deepEqual(observed, {
      protocolVersion: 2,
      callId: 'workbench-call-1',
      capabilityId: 'velaros.workspace',
      operation: 'ws_list_files',
      scope: null,
      input: { recursive: true },
    })
    await runtime.dispose()
  })

  void test('fails clearly when Kernel or an injected capability is unavailable', async () => {
    const disconnected = new WorkbenchKernelClientRuntime({
      connect: async () => { throw new Error('not running') },
    })
    await disconnected.start()
    await assert.rejects(
      disconnected.invoke(
        { capabilityId: 'velaros.agent', operation: 'execute' },
        {}
      ),
      hasInvocationCode('KERNEL_UNAVAILABLE')
    )

    const connected = new WorkbenchKernelClientRuntime({
      connect: async () => createConnection(),
    })
    await connected.start()
    await assert.rejects(
      connected.invoke(
        { capabilityId: 'velaros.agent', operation: 'execute' },
        {}
      ),
      hasInvocationCode('KERNEL_CAPABILITY_UNAVAILABLE')
    )
    await Promise.all([disconnected.dispose(), connected.dispose()])
  })

  void test('binds injected event listeners when the daemon connects', async () => {
    let handler: KernelClientEventHandler | undefined
    const runtime = new WorkbenchKernelClientRuntime({
      connect: async () => createConnection({
        onSubscribe: (eventType, candidate) => {
          assert.equal(eventType, 'velaros.agent.execution')
          handler = candidate
        },
      }),
    })
    const payloads: unknown[] = []
    const unsubscribe = runtime.subscribeEvent(
      'velaros.agent.execution',
      (event) => payloads.push(event.payload)
    )
    await runtime.start()
    await handler?.({
      type: 'velaros.agent.execution',
      payload: { channel: 'agent', payload: { type: 'text-delta', text: 'hello' } },
      sourceModuleId: 'velaros.agent.runtime',
      sourceGeneration: 1,
      sequence: 1,
    })
    assert.deepEqual(payloads, [
      { channel: 'agent', payload: { type: 'text-delta', text: 'hello' } },
    ])
    unsubscribe()
    await runtime.dispose()
  })

  void test('keeps capability calls available when an optional event stream is absent', async () => {
    const runtime = new WorkbenchKernelClientRuntime({
      connect: async () => createConnection({
        onSubscribe: () => {
          throw new Error('event stream unavailable')
        },
        onCall: () => ({ status: 'ok' }),
      }),
    })
    runtime.subscribeEvent('velaros.agent.execution', () => undefined)

    const status = await runtime.start()
    const output = await runtime.invoke(
      { capabilityId: 'velaros.workspace', operation: 'ws_status' },
      {}
    )

    assert.equal(status.state, 'ready')
    assert.equal(status.connected, true)
    assert.deepEqual(output, { status: 'ok' })
    await runtime.dispose()
  })

  void test('disposes a connection that completes during shutdown', async () => {
    let releaseConnection: ((connection: ConnectedKernelDaemon) => void) | undefined
    let disposed = false
    const runtime = new WorkbenchKernelClientRuntime({
      connect: () =>
        new Promise((resolve) => {
          releaseConnection = resolve
        }),
    })

    const started = runtime.start()
    const disposedPromise = runtime.dispose()
    releaseConnection?.(createConnection({ onDispose: () => { disposed = true } }))

    await Promise.all([started, disposedPromise])
    assert.equal(runtime.getStatus().state, 'disposed')
    assert.equal(disposed, true)
  })
})

function hasInvocationCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error
    && 'invocationError' in error
    && (error as {
      invocationError: { code: string }
    }).invocationError.code === code
}
