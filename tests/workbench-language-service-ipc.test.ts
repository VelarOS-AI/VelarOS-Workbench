import assert from 'node:assert/strict'

import { describe, mock, test } from 'bun:test'

import { WorkbenchLanguageChannels } from '../src/shared/workbenchLanguage'

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()

mock.module('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    },
  },
}))

/** 每个动词记下 worker 客户端实际收到的请求；IPC 边界把不合形状的挡在外面。 */
async function registerWithRecorder(): Promise<Record<string, unknown[]>> {
  const calls: Record<string, unknown[]> = {}
  const client = new Proxy(
    {},
    {
      get: (_target, operation: string) => async (request: unknown) => {
        ;(calls[operation] ??= []).push(request)
        return {}
      },
    }
  )
  const { registerWorkbenchLanguageServiceIpc } = await import(
    '../src/main/workspace/language/WorkbenchLanguageServiceIpc'
  )
  registerWorkbenchLanguageServiceIpc(client as never, {} as never)
  return calls
}

async function invoke(channel: string, request: unknown): Promise<boolean> {
  const handler = ipcHandlers.get(channel)
  assert.ok(handler, channel)
  return ((await handler({}, request)) as { ok: boolean }).ok
}

const Base = { projectRoot: '/project', path: 'src/a.ts', content: 'const a = 1\n' }
const Range = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 6 }

void describe('language service IPC: code actions', () => {
  void test('a resolve request needs a range and a well-formed fix-all token', async () => {
    const calls = await registerWithRecorder()
    const channel = WorkbenchLanguageChannels.codeActionResolve

    assert.equal(
      await invoke(channel, { ...Base, range: Range, resolve: { kind: 'fix-all', fixId: 'fixMissingImport' } }),
      true
    )
    assert.deepEqual(calls['resolveCodeAction'], [
      {
        ...Base,
        format: undefined,
        range: Range,
        resolve: { kind: 'fix-all', fixId: 'fixMissingImport' },
      },
    ])

    const refactor = { kind: 'refactor', refactor: 'Extract Symbol', action: 'constant_scope_0' }
    assert.equal(await invoke(channel, { ...Base, range: Range, resolve: { ...refactor, extra: true } }), true)
    assert.deepEqual((calls['resolveCodeAction']?.[1] as { resolve: unknown }).resolve, refactor)

    for (const request of [
      { ...Base, resolve: { kind: 'fix-all', fixId: 'fixMissingImport' } },
      { ...Base, range: Range },
      { ...Base, range: Range, resolve: { kind: 'run-command', fixId: 'x' } },
      { ...Base, range: Range, resolve: { kind: 'fix-all', fixId: '' } },
      { ...Base, range: Range, resolve: { kind: 'fix-all', fixId: 42 } },
      { ...Base, range: Range, resolve: { kind: 'refactor', refactor: 'Extract Symbol' } },
      { ...Base, range: Range, resolve: { kind: 'refactor', refactor: 'x'.repeat(300), action: 'a' } },
      { ...Base, range: { ...Range, endColumn: 'six' }, resolve: { kind: 'fix-all', fixId: 'x' } },
      { range: Range, resolve: { kind: 'fix-all', fixId: 'x' } },
    ])
      assert.equal(await invoke(channel, request), false, JSON.stringify(request))
    assert.equal(calls['resolveCodeAction']?.length, 2)
  })

  void test('a code actions request may say which kinds it wants, and nothing else', async () => {
    const calls = await registerWithRecorder()
    const channel = WorkbenchLanguageChannels.codeActions
    const request = { ...Base, range: Range, diagnostics: [] }

    assert.equal(await invoke(channel, request), true)
    assert.equal(await invoke(channel, { ...request, categories: ['refactor'] }), true)
    assert.equal(await invoke(channel, { ...request, categories: ['quickfix', 'refactor'] }), true)
    assert.deepEqual(
      calls['getCodeActions']?.map((call) => (call as { categories?: unknown }).categories),
      [undefined, ['refactor'], ['quickfix', 'refactor']]
    )

    assert.equal(await invoke(channel, { ...request, categories: ['source'] }), false)
    assert.equal(await invoke(channel, { ...request, categories: 'refactor' }), false)
    assert.equal(calls['getCodeActions']?.length, 3)
  })
})
