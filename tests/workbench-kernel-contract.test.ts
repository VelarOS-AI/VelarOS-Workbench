import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, test } from 'node:test'

import { DefaultWorkbenchKernelCapabilityRoutes } from '../apps/workbench/src/main/WorkbenchMainCapabilityProviders'

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

  void test('Agent execute uses the product-neutral v1 execution envelope', async () => {
    const source = await readFile(
      resolve(
        repositoryRoot,
        'apps/workbench/src/renderer/src/workbench/runtime/standaloneWorkbenchChatAdapter.tsx'
      ),
      'utf8'
    )
    const invocation = extractInvocation(source, 'agent.execute')

    assert.match(invocation, /\bprotocolVersion\s*:\s*1\b/u)
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

    // 信封解析权威从远端 client runtime 移到了进程内能力适配层（P6 宿主化）。
    const runtimeSource = await readFile(
      resolve(
        repositoryRoot,
        'apps/workbench/src/main/kernel/WorkbenchAgentCapabilityRuntime.ts'
      ),
      'utf8'
    )
    assert.match(
      runtimeSource,
      /new Set\(\[['"]protocolVersion['"], ['"]execution['"], ['"]messages['"], ['"]config['"]\]\)/u
    )
    assert.match(runtimeSource, /scopeMetadata\.resourceId/u)
    assert.match(runtimeSource, /Object\.keys\(record\).*allowedKeys/u)
    assert.match(runtimeSource, /velaros\.workbench/u)
  })

  void test('Agent execution stream handles every terminal state with correlation', async () => {
    const source = await readFile(
      resolve(
        repositoryRoot,
        'apps/workbench/src/renderer/src/workbench/runtime/standaloneWorkbenchChatAdapter.tsx'
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

    assert.match(source, /envelope\.protocolVersion\s*!==\s*1/u)
    assert.match(
      source,
      /envelope\.sourceProductId\s*!==\s*['"]velaros\.workbench['"]/u
    )
    assert.match(source, /envelope\.sourceSessionId\s*!==\s*chat\.sessionId/u)
    assert.match(source, /envelope\.executionId/u)
    assert.match(source, /envelope\.sessionCorrelationId/u)
    assert.match(source, /activeExecutionRef\.current/u)
  })

  void test('in-process Agent capability emits the standard execution event schema', async () => {
    const source = await readFile(
      resolve(
        repositoryRoot,
        'apps/workbench/src/main/kernel/WorkbenchAgentCapabilityRuntime.ts'
      ),
      'utf8'
    )

    // P6：执行不再经 daemon，作用域校验随之下沉——projectRoot 由能力适配层从
    // scopeMetadata.resourceId 取，工作区边界由 @velaros-ai/workspace bridge 自持。
    assert.match(source, /const WorkbenchAgentExecutionEventType\s*=/u)
    assert.match(source, /scopeMetadata\.resourceId/u)
    assert.match(
      source,
      /export\s*\{[\s\S]*WorkbenchAgentExecutionEventType,[\s\S]*\}/u
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
    for (const channel of ['agent', 'state', 'debug']) {
      assert.match(source, new RegExp(`['"]${channel}['"]`))
    }
  })

  void test('renderer stream reader covers every terminal agent event', async () => {
    const source = await readFile(
      resolve(
        repositoryRoot,
        'apps/workbench/src/renderer/src/workbench/runtime/standaloneWorkbenchChatAdapter.tsx'
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
        'apps/workbench/src/renderer/src/browser/standaloneBrowserCompositionAdapter.tsx'
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
