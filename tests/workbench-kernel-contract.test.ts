import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, test } from 'node:test'

import {
  DefaultWorkbenchKernelCapabilityRoutes,
  RequiredWorkbenchKernelCapabilityIds,
} from '../apps/workbench/src/main/WorkbenchMainCapabilityProviders'

const repositoryRoot = resolve(import.meta.dirname, '..')

void describe('standalone Workbench Kernel contract', () => {
  void test('uses only the standard Agent, Model, Workspace and Browser capabilities', () => {
    assert.deepEqual(RequiredWorkbenchKernelCapabilityIds, [
      'velaros.agent',
      'velaros.model',
      'velaros.workspace',
      'velaros.browser',
    ])
    assert.deepEqual(DefaultWorkbenchKernelCapabilityRoutes['agent.execute'], {
      capabilityId: 'velaros.agent',
      operation: 'execute',
    })
    assert.deepEqual(DefaultWorkbenchKernelCapabilityRoutes['agent.health'], {
      capabilityId: 'velaros.agent',
      operation: 'health',
    })
    assert.deepEqual(DefaultWorkbenchKernelCapabilityRoutes['model.supports-provider'], {
      capabilityId: 'velaros.model',
      operation: 'supports_provider',
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
      ['velaros.agent', 'velaros.browser', 'velaros.model']
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

    const runtimeSource = await readFile(
      resolve(
        repositoryRoot,
        'apps/workbench/src/main/kernel/WorkbenchStandaloneKernelRuntime.ts'
      ),
      'utf8'
    )
    assert.match(
      runtimeSource,
      /new Set\(\[['"]protocolVersion['"], ['"]execution['"], ['"]messages['"], ['"]config['"]\]\)/u
    )
    assert.match(
      runtimeSource,
      /new Set\(\[['"]id['"], ['"]source['"], ['"]scopeMetadata['"]\]\)/u
    )
    assert.match(
      runtimeSource,
      /new Set\(\[['"]productId['"], ['"]sessionId['"], ['"]correlationId['"]\]\)/u
    )
    assert.match(runtimeSource, /scopeMetadata\.resourceId/u)
    assert.match(runtimeSource, /scope\s*!==\s*undefined/u)
    assert.match(runtimeSource, /Object\.keys\(record\).*allowedKeys/u)
    assert.doesNotMatch(
      runtimeSource,
      /velaros\.workbench\.(?:agent-control|model-profiles|browser-control)/u
    )
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

  void test('standalone runtime validates injected Workspace scopes and emits the standard event schema', async () => {
    const source = await readFile(
      resolve(
        repositoryRoot,
        'apps/workbench/src/main/kernel/WorkbenchStandaloneKernelRuntime.ts'
      ),
      'utf8'
    )

    assert.match(source, /const WorkbenchWorkspaceScopeOwner\s*=/u)
    assert.match(
      source,
      /scope\?\.ownerModuleId\s*!==\s*WorkbenchWorkspaceScopeOwner/u
    )
    assert.match(source, /scope\.kind\s*!==\s*['"]project['"]/u)
    assert.match(source, /!options\.isWorkspaceRootAllowed\(scope\.id\)/u)
    assert.match(source, /!this\.isWorkspaceRootAllowed\(input\.projectRoot\)/u)
    assert.match(
      source,
      /export\s*\{[\s\S]*AgentExecutionEventType,[\s\S]*WorkbenchWorkspaceScopeOwner,[\s\S]*\}/u
    )

    assert.match(source, /const AgentExecutionEventType\s*=/u)
    for (const field of [
      'protocolVersion',
      'executionId',
      'sourceProductId',
      'sourceSessionId',
      'sessionCorrelationId',
    ]) {
      assert.match(source, new RegExp(`\\b${field}\\b`))
    }
    for (const eventType of ['start', 'text-delta', 'done', 'error', 'aborted']) {
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
