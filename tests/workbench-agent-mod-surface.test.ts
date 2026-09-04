import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'
import { z } from 'zod'

import { CodingSessionTracker } from '@velaros-ai/agent'
import type { ToolCategoryDefinition } from '@velaros-ai/agent/protocol'
import type { ProjectKernel } from '@velaros-ai/project/runtime'

import {
  composeWorkbenchAgentRunToolSnapshot,
  createWorkbenchToolContext,
  WorkbenchAgentExecutionStack,
  type WorkbenchAgentModSurfaceProvider,
  type WorkbenchAgentModSurfaceSnapshot,
} from '../src/main/agent/WorkbenchAgentExecutionStack'
import {
  type WorkbenchAgentToolDefinition,
  WorkbenchAgentToolRegistry,
} from '../src/main/agent/WorkbenchAgentToolRegistry'
import type {
  WorkbenchProjectCapability,
  WorkbenchProjectCapabilityProvider,
} from '../src/main/workspace/ProjectCapabilityProvider'

const ProjectCategory: ToolCategoryDefinition = {
  id: 'project-files',
  label: 'Project files',
  description: 'Read project files.',
  toolOs: { domain: 'project', defaultState: 'resident' },
}

const BrowserCategory: ToolCategoryDefinition = {
  id: 'browser-core',
  label: 'Browser core',
  description: 'Inspect and operate the page.',
  toolOs: { domain: 'browser', defaultState: 'loadable' },
}

function createTool(input: {
  name: string
  categoryId: string
  available?: boolean
  requiresImage?: boolean
}): WorkbenchAgentToolDefinition {
  return {
    name: input.name,
    categoryId: input.categoryId,
    role: 'inspect',
    description: `Run ${input.name}`,
    permissions: ['network'],
    capabilities: { effectKind: 'read', concurrency: 'safe' },
    requiredModelInputModalities: input.requiresImage ? ['image'] : undefined,
    exposure: { tier: 'common', rank: 12 },
    usageSkillId: 'browser-control',
    outputInline: true,
    providerId: 'velaros.browser',
    providerKind: 'mod',
    schema: z.object({}),
    isAvailable: input.available === undefined ? undefined : () => input.available === true,
    execute: async () => ({ ok: true }),
  }
}

function createProjectCapability(projectRoot = '/tmp/workbench-project'): WorkbenchProjectCapability {
  const projectTool = createTool({ name: 'project:read', categoryId: 'project-files' })
  return {
    kernel: { root: projectRoot } as ProjectKernel,
    tools: [projectTool],
    categoryDefinitions: { 'project-files': ProjectCategory },
    enabledCategoryIds: ['project-files'],
    residentCategoryIds: ['project-files'],
    initialVisibleToolNames: ['project:read'],
  }
}

function createModSurface(
  generation: number,
  tools: readonly WorkbenchAgentToolDefinition[] = []
): WorkbenchAgentModSurfaceSnapshot {
  const hasBrowser = tools.length > 0
  return {
    generation,
    tools,
    categoryDefinitions: hasBrowser ? { 'browser-core': BrowserCategory } : {},
    enabledCategoryIds: hasBrowser ? ['browser-core'] : [],
    residentCategoryIds: [],
    initialVisibleToolNames: hasBrowser ? tools.slice(0, 1).map((tool) => tool.name) : [],
  }
}

void describe('Workbench Agent Mod surface', () => {
  void test('retains VelaTool descriptor metadata and real category definitions', () => {
    const available = createTool({ name: 'browser:enter_site', categoryId: 'browser-core' })
    const unavailable = createTool({
      name: 'browser:capture_screenshot',
      categoryId: 'browser-core',
      available: false,
      requiresImage: true,
    })
    const registry = new WorkbenchAgentToolRegistry(
      [available, unavailable],
      { 'browser-core': BrowserCategory },
      7
    )

    assert.deepEqual(registry.getDescriptor(available.name), {
      descriptorId: available.name,
      name: available.name,
      description: available.description,
      role: 'inspect',
      permissions: ['network'],
      capabilities: { effectKind: 'read', concurrency: 'safe' },
      requiredModelInputModalities: undefined,
      exposure: { tier: 'common', rank: 12 },
      usageSkillId: 'browser-control',
      outputInline: true,
      categoryId: 'browser-core',
      systemEnabled: true,
      providerId: 'velaros.browser',
      providerKind: 'mod',
      registrationStatus: 'active',
    })
    assert.deepEqual(registry.listCategories({}, undefined, 'all')[0]?.category, BrowserCategory)
    assert.deepEqual(registry.listAvailable({}, undefined, 'all').map((tool) => tool.name), [
      available.name,
    ])
    assert.deepEqual(registry.listAvailable({}, undefined, 'catalog').map((tool) => tool.name), [
      available.name,
      unavailable.name,
    ])
    assert.equal(registry.getCapabilityRevision(), 7)
    assert.match(registry.getRegistrationSignature(available.name) ?? '', /^7:/)
  })

  void test('composes Project and globally enabled Mod tools with an explicit resident set', () => {
    const browserTool = createTool({ name: 'browser:enter_site', categoryId: 'browser-core' })
    const snapshot = composeWorkbenchAgentRunToolSnapshot(
      createProjectCapability(),
      createModSurface(3, [browserTool])
    )

    assert.equal(snapshot.generation, 3)
    assert.deepEqual(snapshot.tools.map((tool) => tool.name), [
      'project:read',
      'browser:enter_site',
    ])
    assert.deepEqual(snapshot.enabledCategoryIds, ['project-files', 'browser-core'])
    assert.deepEqual(snapshot.residentCategoryIds, ['project-files'])
    assert.deepEqual(snapshot.initialVisibleToolNames, [
      'project:read',
      'browser:enter_site',
    ])
    assert.equal(snapshot.categoryDefinitions['browser-core'], BrowserCategory)

    const registry = new WorkbenchAgentToolRegistry(
      snapshot.tools,
      snapshot.categoryDefinitions,
      snapshot.generation
    )
    const tracker = new CodingSessionTracker([...snapshot.enabledCategoryIds], undefined, [], [], {
      toolCategoryToolNames: registry.toolCategoryToolNames,
      residentToolCategories: snapshot.residentCategoryIds,
    })
    const context = createWorkbenchToolContext({
      sessionId: 'session-residency',
      projectRoot: '/tmp/workbench-project',
      abortSignal: new AbortController().signal,
      tracker,
      registry,
      enabledCategoryIds: snapshot.enabledCategoryIds,
      initialVisibleToolNames: snapshot.initialVisibleToolNames,
    }) as {
      capabilityPorts: {
        scopePolicy: {
          getResidency(input: unknown): { residentToolNames: readonly string[] }
        }
      }
    }
    assert.deepEqual(
      context.capabilityPorts.scopePolicy.getResidency({}).residentToolNames,
      ['project:read', 'browser:enter_site']
    )
  })

  void test('reuses an equivalent tool surface across UI revisions and rebuilds real Mod changes', async () => {
    let currentSurface = createModSurface(1)
    const modSurfaceProvider: WorkbenchAgentModSurfaceProvider = {
      captureSnapshot: () => currentSurface,
    }
    const projectProvider: WorkbenchProjectCapabilityProvider = {
      invoke: () => Promise.resolve(null),
      resolveProject: (projectRoot) => Promise.resolve(createProjectCapability(projectRoot)),
      dispose: () => Promise.resolve(),
    }
    const stack = new WorkbenchAgentExecutionStack(
      projectProvider,
      undefined,
      modSurfaceProvider
    )
    const resolveSession = (
      stack as unknown as {
        resolveSession(input: {
          sessionId: string
          projectRoot: string
          abortSignal: AbortSignal
        }): Promise<{
          generation: number
          surfaceSignature: string
          tracker: CodingSessionTracker
          registry: WorkbenchAgentToolRegistry
          loop: unknown
        }>
      }
    ).resolveSession.bind(stack)
    const input = {
      sessionId: 'session-a',
      projectRoot: '/tmp/workbench-project',
      abortSignal: new AbortController().signal,
    }

    const first = await resolveSession(input)
    const same = await resolveSession(input)
    assert.equal(same, first)

    // Browser host 也用 generation 广播 URL/title/load 等 UI 变化。工具面不变时
    // 不得丢掉已有 tracker/loop。
    currentSurface = createModSurface(2)
    const emptyUiRevision = await resolveSession(input)
    assert.equal(emptyUiRevision, first)
    assert.equal(emptyUiRevision.tracker, first.tracker)
    assert.equal(emptyUiRevision.loop, first.loop)

    const otherSession = await resolveSession({ ...input, sessionId: 'session-b' })
    assert.notEqual(otherSession.loop, first.loop)

    const browserTool = {
      ...createTool({ name: 'browser:enter_site', categoryId: 'browser-core' }),
      registrationSignature: '3:velaros.browser:browser:enter_site',
    }
    currentSurface = createModSurface(3, [browserTool])
    const enabledBrowser = await resolveSession(input)
    assert.notEqual(enabledBrowser, first)
    assert.notEqual(enabledBrowser.loop, first.loop)
    assert.deepEqual(first.registry.names, ['project:read'])
    assert.deepEqual(enabledBrowser.registry.names, ['project:read', 'browser:enter_site'])

    // capture 会重建宿主 wrapper，并用当前 UI generation 作注册签名前缀；
    // 这些都不是 Mod 工具面变化。
    const sameBrowserTool = {
      ...createTool({ name: 'browser:enter_site', categoryId: 'browser-core' }),
      registrationSignature: '4:velaros.browser:browser:enter_site',
    }
    currentSurface = createModSurface(4, [sameBrowserTool])
    const browserUiRevision = await resolveSession(input)
    assert.equal(browserUiRevision, enabledBrowser)
    assert.equal(browserUiRevision.tracker, enabledBrowser.tracker)
    assert.equal(browserUiRevision.loop, enabledBrowser.loop)

    currentSurface = createModSurface(5, [{
      ...sameBrowserTool,
      registrationSignature: '5:velaros.browser:browser:enter_site',
      description: 'Updated Browser Mod tool description',
    }])
    const changedBrowserSurface = await resolveSession(input)
    assert.notEqual(changedBrowserSurface, enabledBrowser)
    assert.notEqual(changedBrowserSurface.loop, enabledBrowser.loop)
    assert.notEqual(changedBrowserSurface.surfaceSignature, enabledBrowser.surfaceSignature)

    const nextRoot = await resolveSession({ ...input, projectRoot: '/tmp/other-project' })
    assert.notEqual(nextRoot, changedBrowserSurface)
    await stack.dispose()
  })
})
