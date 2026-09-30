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

  void test('organize imports takes the file, its text and its indentation', async () => {
    const calls = await registerWithRecorder()
    const channel = WorkbenchLanguageChannels.organizeImports
    const format = { tabSize: 4, indentSize: 4, insertSpaces: true }

    assert.equal(await invoke(channel, { ...Base, format, unknown: true }), true)
    assert.deepEqual(calls['getOrganizeImports'], [{ ...Base, format }])
    assert.equal(await invoke(channel, { projectRoot: '/project' }), false)
    assert.equal(await invoke(channel, null), false)
    assert.equal(calls['getOrganizeImports']?.length, 1)
  })
})

void describe('language service IPC: call hierarchy', () => {
  void test('needs a position and one of the two directions', async () => {
    const calls = await registerWithRecorder()
    const channel = WorkbenchLanguageChannels.callHierarchy
    const position = { line: 3, column: 7 }

    assert.equal(await invoke(channel, { ...Base, position, direction: 'incoming', extra: 1 }), true)
    assert.equal(await invoke(channel, { ...Base, position, direction: 'outgoing' }), true)
    assert.deepEqual(
      calls['getCallHierarchy']?.map((call) => {
        const { direction, position: parsed } = call as { direction: string; position: unknown }
        return [direction, parsed]
      }),
      [
        ['incoming', position],
        ['outgoing', position],
      ]
    )

    for (const request of [
      { ...Base, position },
      { ...Base, position, direction: 'both' },
      { ...Base, direction: 'incoming' },
      { ...Base, position: { line: '3', column: 7 }, direction: 'incoming' },
      { position, direction: 'incoming' },
    ])
      assert.equal(await invoke(channel, request), false, JSON.stringify(request))
    assert.equal(calls['getCallHierarchy']?.length, 2)
  })
})

void describe('language service IPC: imports after a file rename', () => {
  void test('takes the renames and the open buffers, and refuses anything malformed', async () => {
    const calls = await registerWithRecorder()
    const channel = WorkbenchLanguageChannels.fileRenameEdits
    const renames = [
      { previousPath: 'src/a.ts', path: 'src/b.ts' },
      { previousPath: 'src/util', path: 'src/shared' },
    ]
    const openFiles = [{ path: 'src/main.ts', content: "import './a'\n" }]

    assert.equal(await invoke(channel, { projectRoot: '/project', renames, openFiles, extra: 1 }), true)
    assert.deepEqual(calls['getFileRenameEdits'], [{ projectRoot: '/project', renames, openFiles }])
    assert.equal(
      await invoke(channel, { projectRoot: '/project', renames: [{ ...renames[0], kind: 'file' }] }),
      true
    )
    assert.deepEqual(calls['getFileRenameEdits']?.[1], { projectRoot: '/project', renames: [renames[0]] })

    for (const request of [
      null,
      { renames },
      { projectRoot: '/project' },
      { projectRoot: '/project', renames: [] },
      { projectRoot: '/project', renames: 'src/a.ts' },
      { projectRoot: '/project', renames: [{ previousPath: 'src/a.ts' }] },
      { projectRoot: '/project', renames: [{ previousPath: 'src/a.ts', path: 42 }] },
      { projectRoot: '/project', renames: [{ previousPath: '', path: 'src/b.ts' }] },
      { projectRoot: '/project', renames: [{ previousPath: 'src/a.ts', path: 'src/a.ts' }] },
      { projectRoot: '/project', renames: Array.from({ length: 513 }, () => renames[0]) },
    ])
      assert.equal(await invoke(channel, request), false, JSON.stringify(request)?.slice(0, 120))
    assert.equal(calls['getFileRenameEdits']?.length, 2)
  })
})
