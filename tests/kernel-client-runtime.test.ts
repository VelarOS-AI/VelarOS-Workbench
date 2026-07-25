import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type {
  ConnectedKernelDaemon,
  KernelClient,
} from '@velaros-ai/kernel-service'

import { WorkbenchKernelClientRuntime } from '../apps/workbench/src/main/kernel/WorkbenchKernelClientRuntime'

function createConnection(options: {
  health?: 'healthy' | 'degraded'
  instanceId?: string
  onDispose?: () => void
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
