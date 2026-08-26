import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, test } from 'node:test'

import { WorkbenchKernelPermissionPolicy } from '../src/main/kernel/WorkbenchKernelPermissionPolicy'
import { parseWorkbenchKernelInvokeRequest } from '../src/main/kernel/WorkbenchKernelProtocol'
import { DefaultWorkbenchKernelCapabilityRoutes } from '../src/main/WorkbenchMainCapabilityProviders'

const repositoryRoot = resolve(import.meta.dirname, '..')

void describe('standalone Workbench Kernel contract', () => {
  void test('routes only to the standard Agent and Browser capability ids', () => {
    assert.deepEqual(DefaultWorkbenchKernelCapabilityRoutes['agent.execute'], {
      capabilityId: 'velaros.agent',
      operation: 'execute',
    })
    assert.deepEqual(DefaultWorkbenchKernelCapabilityRoutes['agent.health'], {
      capabilityId: 'velaros.agent',
      operation: 'health',
    })
    assert.deepEqual(DefaultWorkbenchKernelCapabilityRoutes['browser.close-session'], {
      capabilityId: 'velaros.browser',
      operation: 'close_session',
    })
    assert.deepEqual(DefaultWorkbenchKernelCapabilityRoutes['browser.close-all-sessions'], {
      capabilityId: 'velaros.browser',
      operation: 'close_all_sessions',
    })
    assert.deepEqual(
      [...new Set(
        Object.values(DefaultWorkbenchKernelCapabilityRoutes)
          .map(({ capabilityId }) => capabilityId)
      )].sort(),
      ['velaros.agent', 'velaros.browser']
    )
  })

  void test('rejects renderer privilege fields and malformed scopes at the IPC boundary', () => {
    const valid = {
      route: 'agent.execute',
      input: { protocolVersion: 1 },
      scope: {
        id: '/probe',
        ownerModuleId: 'velaros.project',
        kind: 'project',
      },
    }
    assert.deepEqual(
      parseWorkbenchKernelInvokeRequest(valid, DefaultWorkbenchKernelCapabilityRoutes),
      valid
    )
    for (const invalid of [
      { ...valid, capabilityId: 'velaros.browser' },
      { ...valid, operation: 'close_all_sessions' },
      { ...valid, permission: 'agent:execute' },
      { ...valid, scope: { ...valid.scope, ownerModuleId: '' } },
      { ...valid, scope: { ...valid.scope, injected: true } },
      { route: 'unknown.route', input: {} },
      { route: 'agent.execute' },
    ]) {
      assert.equal(
        parseWorkbenchKernelInvokeRequest(
          invalid,
          DefaultWorkbenchKernelCapabilityRoutes
        ),
        null
      )
    }
  })

  void test('grants only the main-bound Workbench Agent execution route', async () => {
    const policy = new WorkbenchKernelPermissionPolicy()
    assert.deepEqual(
      await policy.request({
        moduleId: 'velaros.agent.runtime',
        generation: 1,
        permission: 'agent:execute',
        details: {
          productId: 'velaros.workbench',
          route: 'agent.execute',
        },
      }),
      { status: 'granted', grantId: 'workbench:agent.execute' }
    )
    for (const request of [
      {
        moduleId: 'velaros.agent.runtime',
        generation: 1,
        permission: 'agent:execute',
        details: { productId: 'velaros.workbench', route: 'agent.health' },
      },
      {
        moduleId: 'velaros.browser.electron',
        generation: 1,
        permission: 'browser:control',
        details: { productId: 'velaros.workbench', route: 'agent.execute' },
      },
      {
        moduleId: 'velaros.agent.runtime',
        generation: 1,
        permission: 'agent:execute',
        details: { productId: 'forged.product', route: 'agent.execute' },
      },
    ]) {
      assert.equal((await policy.request(request)).status, 'denied')
    }
  })

  void test('Agent execute uses the product-neutral v1 execution envelope', async () => {
    const source = await readFile(
      resolve(
        repositoryRoot,
        'src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx'
      ),
      'utf8'
    )
    const invocation = extractInvocation(source, 'agent.execute')

    assert.match(invocation, /\bprotocolVersion\s*:\s*AgentCapabilityProtocolVersion\b/u)
    assert.match(invocation, /\bexecution\s*:\s*\{/u)
    assert.match(invocation, /\bid\s*:\s*executionId\b/u)
    assert.match(invocation, /\bsource\s*:\s*\{/u)
    assert.match(invocation, /\bproductId\s*:\s*['"]velaros\.workbench['"]/u)
    assert.match(invocation, /\bsessionId\s*:\s*latest\.sessionId\b/u)
    assert.match(invocation, /\bcorrelationId\s*:\s*sessionCorrelationId\b/u)
    assert.match(invocation, /\bscopeMetadata\s*:\s*\{/u)
    assert.match(invocation, /\bresourceId\s*:\s*projectRoot\b/u)
    assert.match(invocation, /\bmessages\s*:/u)
    assert.match(invocation, /\bconfig\s*:\s*\{/u)
    assert.match(invocation, /\bmodelSelection\s*:\s*\{/u)
    assert.match(invocation, /\bexecutionModes\s*:\s*\[/u)
    assert.doesNotMatch(invocation, /\bscope\s*:\s*\{/u)
    for (const legacyField of [
      'sourceSessionId',
      'sessionCorrelationId',
      'projectRoot',
      'modelProfileId',
      'browserSessionId',
    ]) {
      assert.doesNotMatch(invocation, new RegExp(`\\b${legacyField}\\s*:`))
    }

    // 版本化信封由 Agent domain 唯一拥有；Workbench 只做产品身份与 scope 解释。
    const runtimeSource = await readFile(
      resolve(
        repositoryRoot,
        'src/main/kernel/WorkbenchAgentCapabilityRuntime.ts'
      ),
      'utf8'
    )
    assert.match(runtimeSource, /parseAgentCapabilityExecuteEnvelopeV1/u)
    assert.match(runtimeSource, /@velaros-ai\/agent\/protocol\/agent-capability/u)
    assert.match(runtimeSource, /scopeMetadata\.resourceId/u)
    assert.match(runtimeSource, /velaros\.workbench/u)
    assert.match(runtimeSource, /normalizeExecutionModes/u)
    assert.match(runtimeSource, /config\.executionModes/u)
    assert.doesNotMatch(runtimeSource, /allowedKeys/u)
    assert.doesNotMatch(runtimeSource, /protocolVersion\s*!==\s*1/u)
  })

  void test('Agent execution stream handles every terminal state with correlation', async () => {
    const source = await readFile(
      resolve(
        repositoryRoot,
        'src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx'
      ),
      'utf8'
    )

    for (const field of [
      'protocolVersion',
      'executionId',
      'sourceProductId',
      'sourceSessionId',
      'sessionCorrelationId',
    ]) {
      assert.match(source, new RegExp(`\\b${field}\\b`))
    }
    for (const eventType of ['text-delta', 'done', 'error', 'aborted']) {
      assert.match(source, new RegExp(`['"]${eventType}['"]`))
    }

    assert.match(
      source,
      /envelope\.protocolVersion\s*!==\s*AgentCapabilityProtocolVersion/u
    )
    assert.match(
      source,
      /envelope\.sourceProductId\s*!==\s*['"]velaros\.workbench['"]/u
    )
    assert.match(
      source,
      /envelope\.sourceSessionId\s*!==\s*activeExecution\.sessionId/u
    )
    assert.match(source, /envelope\.executionId/u)
    assert.match(source, /envelope\.sessionCorrelationId/u)
    assert.match(source, /activeAgentExecutions\.get\(executionId\)/u)
  })

  void test('in-process Agent capability emits the standard execution event schema', async () => {
    const source = await readFile(
      resolve(
        repositoryRoot,
        'src/main/kernel/WorkbenchAgentCapabilityRuntime.ts'
      ),
      'utf8'
    )

    // Host 只把三通道接入 Agent 的公共 publisher；事件类型、信封和有序排空不再复制。
    assert.match(source, /AgentCapabilityEventPublisher/u)
    assert.match(source, /scopeMetadata\.resourceId/u)
    assert.doesNotMatch(source, /OrderedKernelEventPublisher/u)
    assert.doesNotMatch(source, /WorkbenchAgentExecutionEventType/u)
    for (const channel of ['agent', 'state', 'debug']) {
      assert.match(source, new RegExp(`['"]${channel}['"]`))
    }

    const ipcSource = await readFile(
      resolve(repositoryRoot, 'src/main/kernel/WorkbenchKernelIpc.ts'),
      'utf8'
    )
    assert.match(ipcSource, /AgentCapabilityExecutionEventType/u)
    assert.match(ipcSource, /@velaros-ai\/agent\/protocol\/agent-capability/u)
  })

  void test('renderer stream reader covers every terminal agent event', async () => {
    const source = await readFile(
      resolve(
        repositoryRoot,
        'src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx'
      ),
      'utf8'
    )

    for (const eventType of ['text-delta', 'done', 'error', 'aborted']) {
      assert.match(source, new RegExp(`['"]${eventType}['"]`))
    }
  })

  void test('browser surface consumes the standard Browser capability and session schema', async () => {
    const source = await readFile(
      resolve(
        repositoryRoot,
        'src/renderer/src/browser/standaloneBrowserCompositionAdapter.tsx'
      ),
      'utf8'
    )

    assert.match(source, /capability\.id\s*===\s*['"]velaros\.browser['"]/u)
    assert.match(source, /input:\s*\{\s*sessionId:\s*input\.sessionId\s*\}/u)
    assert.doesNotMatch(source, /input:\s*\{\s*browserSessionId:\s*input\.sessionId\s*\}/u)
  })
})

function extractInvocation(source: string, route: string): string {
  const routeIndex = source.indexOf(`route: '${route}'`)
  assert.notEqual(routeIndex, -1, `missing ${route} invocation`)
  const nextRouteIndex = source.indexOf('route:', routeIndex + 8)
  return source.slice(
    routeIndex,
    nextRouteIndex === -1 ? Math.min(source.length, routeIndex + 3_000) : nextRouteIndex
  )
}
