import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, test } from 'node:test'

import { DefaultWorkbenchKernelCapabilityRoutes } from '../apps/workbench/src/main/WorkbenchMainCapabilityProviders'

const repositoryRoot = resolve(import.meta.dirname, '..')

void describe('standalone Workbench Kernel contract', () => {
  void test('publishes the complete Agent, Model and Browser route catalog', () => {
    assert.deepEqual(DefaultWorkbenchKernelCapabilityRoutes['agent.execute'], {
      capabilityId: 'velaros.agent',
      operation: 'execute',
    })
    assert.deepEqual(DefaultWorkbenchKernelCapabilityRoutes['agent.abort'], {
      capabilityId: 'velaros.workbench.agent-control',
      operation: 'abort',
    })
    assert.deepEqual(DefaultWorkbenchKernelCapabilityRoutes['model.configure-profile'], {
      capabilityId: 'velaros.workbench.model-profiles',
      operation: 'configure',
    })

    for (const operation of [
      'create',
      'open',
      'navigate',
      'inspect',
      'input',
      'selection',
    ] as const) {
      assert.deepEqual(
        DefaultWorkbenchKernelCapabilityRoutes[`browser.${operation}`],
        {
          capabilityId: 'velaros.workbench.browser-control',
          operation,
        }
      )
    }
  })

  void test('Agent execute uses a strict profile-owned, project-scoped envelope', async () => {
    const source = await readFile(
      resolve(
        repositoryRoot,
        'apps/workbench/src/renderer/src/workbench/runtime/standaloneWorkbenchChatAdapter.tsx'
      ),
      'utf8'
    )
    const invocation = extractInvocation(source, 'agent.execute')

    for (const field of [
      'protocolVersion',
      'executionId',
      'sourceSessionId',
      'sessionCorrelationId',
      'projectRoot',
      'modelProfileId',
      'browserSessionId',
      'messages',
    ]) {
      assert.match(invocation, new RegExp(`\\b${field}\\b(?:\\s*:|\\s*[,}])`))
    }
    for (const legacyField of ['config', 'provider', 'apiKey', 'baseURL']) {
      assert.doesNotMatch(invocation, new RegExp(`\\b${legacyField}\\s*:`))
    }

    assert.match(invocation, /\bscope\s*:\s*\{/u)
    assert.match(invocation, /\bid\s*:\s*projectRoot\b/u)
    assert.match(invocation, /\bkind\s*:\s*['"]project['"]/u)

    const runtimeSource = await readFile(
      resolve(
        repositoryRoot,
        'apps/workbench/src/main/kernel/WorkbenchStandaloneKernelRuntime.ts'
      ),
      'utf8'
    )
    const owner = runtimeSource.match(
      /const WorkbenchWorkspaceScopeOwner\s*=\s*(['"])([^'"]+)\1/u
    )?.[2]
    assert.ok(owner)
    assert.match(
      invocation,
      new RegExp(`\\bownerModuleId\\s*:\\s*['"]${escapeRegExp(owner)}['"]`)
    )

    for (const field of [
      'protocolVersion',
      'executionId',
      'sourceSessionId',
      'sessionCorrelationId',
      'projectRoot',
      'modelProfileId',
      'browserSessionId',
      'messages',
    ]) {
      assert.match(runtimeSource, new RegExp(`['"]${field}['"]`))
    }
    assert.match(runtimeSource, /Object\.keys\(record\).*allowedKeys/u)
    assert.match(runtimeSource, /'config'\s+in\s+record/u)
  })

  void test('Agent execution stream handles every terminal state with correlation', async () => {
    const source = await readFile(
      resolve(
        repositoryRoot,
        'apps/workbench/src/renderer/src/workbench/runtime/standaloneWorkbenchChatAdapter.tsx'
      ),
      'utf8'
    )

    for (const field of ['executionId', 'sourceSessionId', 'sessionCorrelationId']) {
      assert.match(source, new RegExp(`\\b${field}\\b`))
    }
    for (const eventType of ['text-delta', 'done', 'error', 'aborted']) {
      assert.match(source, new RegExp(`['"]${eventType}['"]`))
    }

    assert.match(source, /envelope\.sourceSessionId\s*!==\s*chat\.sessionId/u)
    assert.match(source, /envelope\.executionId/u)
    assert.match(source, /envelope\.sessionCorrelationId/u)
    assert.match(source, /activeExecutionRef\.current/u)
  })

  void test('standalone runtime validates project-owned Workspace scopes and event schema', async () => {
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
    assert.match(source, /scope\.id\s*!==\s*projectRoot/u)
    assert.match(source, /!options\.isWorkspaceRootAllowed\(scope\.id\)/u)
    assert.match(source, /!this\.isWorkspaceRootAllowed\(input\.projectRoot\)/u)
    assert.match(
      source,
      /export\s*\{[\s\S]*AgentExecutionEventType,[\s\S]*WorkbenchWorkspaceScopeOwner,[\s\S]*\}/u
    )

    assert.match(source, /const AgentExecutionEventType\s*=/u)
    for (const field of ['executionId', 'sourceSessionId', 'sessionCorrelationId']) {
      assert.match(source, new RegExp(`\\b${field}\\b`))
    }
    for (const eventType of ['start', 'text-delta', 'done', 'error', 'aborted']) {
      assert.match(source, new RegExp(`['"]${eventType}['"]`))
    }
  })

  void test('browser surface consumes the Workbench control capability and typed session key', async () => {
    const source = await readFile(
      resolve(
        repositoryRoot,
        'apps/workbench/src/renderer/src/browser/standaloneBrowserCompositionAdapter.tsx'
      ),
      'utf8'
    )

    assert.match(source, /capability\.id\s*===\s*['"]velaros\.workbench\.browser-control['"]/u)
    assert.match(source, /input:\s*\{\s*browserSessionId:\s*input\.sessionId\s*\}/u)
    assert.doesNotMatch(source, /input:\s*\{\s*sessionId:\s*input\.sessionId\s*\}/u)
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

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
