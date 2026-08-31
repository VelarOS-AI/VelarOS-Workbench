import { describe, expect, test } from 'bun:test'

import type { ElectronBrowserRuntime } from '@velaros-ai/browser/runtime'

import { WorkbenchBrowserController } from '../src/main/kernel/WorkbenchBrowserController'

describe('Workbench Browser controller', () => {
  test('runs create, open, navigate, inspect, input, selection and close through the injected runtime', async () => {
    const calls: Array<{ operation: string; args: unknown[] }> = []
    const runtime = {
      launchExternalBrowserPage: async (...args: unknown[]) => {
        calls.push({ operation: 'create', args })
        return { sessionId: 'browser-1', url: 'https://example.test/one' }
      },
      openPage: async (...args: unknown[]) => {
        calls.push({ operation: 'open', args })
      },
      getPageState: async (...args: unknown[]) => {
        calls.push({ operation: 'state', args })
        return { sessionId: 'browser-1', url: 'https://example.test/two' }
      },
      navigatePage: async (...args: unknown[]) => {
        calls.push({ operation: 'navigate', args })
        return { url: 'https://example.test/three' }
      },
      inspectPage: async (...args: unknown[]) => {
        calls.push({ operation: 'inspect', args })
        return { title: 'Example', text: 'Visible content' }
      },
      typeText: async (...args: unknown[]) => {
        calls.push({ operation: 'input', args })
        return { typed: true }
      },
      evaluateScript: async (...args: unknown[]) => {
        calls.push({ operation: 'selection', args })
        return {
          result: {
            id: 'selection-1',
            url: 'https://example.test/three',
            title: 'Example',
            label: 'Submit',
            tagName: 'button',
            role: null,
            text: 'Submit',
            attributes: { type: 'submit' },
            selector: '#submit',
            rect: {
              x: 1,
              y: 2,
              width: 30,
              height: 12,
              centerX: 16,
              centerY: 8,
            },
            viewportWidth: 1024,
            viewportHeight: 768,
            target: null,
            capturedAt: 1,
          },
        }
      },
      closeSession: async (...args: unknown[]) => {
        calls.push({ operation: 'close', args })
      },
      closeAllSessions: (...args: unknown[]) => {
        calls.push({ operation: 'close-all', args })
      },
    } as unknown as ElectronBrowserRuntime
    const controller = new WorkbenchBrowserController(
      runtime,
      (projectRoot) => projectRoot === '/workspace/project'
    )
    const binding = {
      agentSessionId: 'agent-1',
      browserSessionId: 'browser-1',
      projectRoot: '/workspace/project',
    }

    await expect(
      controller.create({
        ...binding,
        projectRoot: '/workspace/not-active',
        url: 'https://example.test/forbidden',
      })
    ).rejects.toMatchObject({ code: 'PERMISSION' })
    await controller.create({ ...binding, url: 'https://example.test/one' })
    await expect(
      controller.open({
        ...binding,
        agentSessionId: 'agent-2',
        url: 'https://example.test/forbidden',
      })
    ).rejects.toMatchObject({ code: 'PERMISSION' })
    await controller.open({ ...binding, url: 'https://example.test/two' })
    await controller.navigate({
      browserSessionId: binding.browserSessionId,
      action: 'goto',
      url: 'https://example.test/three',
    })
    await controller.inspect({ browserSessionId: binding.browserSessionId })
    await controller.input({ browserSessionId: binding.browserSessionId, text: 'hello' })
    const selection = await controller.selection({
      browserSessionId: binding.browserSessionId,
      selector: '#submit',
    })
    await controller.close({ browserSessionId: binding.browserSessionId })
    controller.closeAll()

    expect(calls.map((call) => call.operation)).toEqual([
      'create',
      'open',
      'state',
      'navigate',
      'inspect',
      'input',
      'selection',
      'close',
      'close-all',
    ])
    expect(selection).toMatchObject({
      id: 'selection-1',
      tagName: 'button',
      selector: '#submit',
      url: 'https://example.test/three',
    })
  })
})
