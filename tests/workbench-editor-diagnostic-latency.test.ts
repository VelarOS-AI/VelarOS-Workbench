import assert from 'node:assert/strict'

import { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { test } from 'bun:test'

import { Result } from '@velaros-ai/velaros/core/result'

import { createWorkbenchCodeMirrorLintSource } from '../src/renderer/src/models/editor/workbenchCodeMirrorLintSource'
import type { WorkbenchLanguageServiceDiagnostic } from '../src/shared/contracts/workbench'

const diagnostic: WorkbenchLanguageServiceDiagnostic = {
  path: 'App.vue',
  severity: 'error',
  code: 2322,
  source: 'ts',
  message: 'Type mismatch',
  range: { startLine: 1, startColumn: 7, endLine: 1, endColumn: 12 },
}

test('Vue markers are ready immediately after diagnostics without requesting quick fixes', async () => {
  const view = { state: EditorState.create({ doc: 'const count = "bad"' }) } as EditorView
  let requests = 0
  const source = createWorkbenchCodeMirrorLintSource({
    projectRoot: '/project',
    path: 'App.vue',
    language: 'Vue',
    getOpenTabs: () => [],
    getActivePath: () => 'App.vue',
    requestDiagnostics: async () => {
      requests++
      return Result.ok({ projectRoot: '/project', path: 'App.vue', diagnostics: [diagnostic] })
    },
  })
  const result = await source(view)
  assert.equal(requests, 1)
  assert.equal(result.length, 1)
  assert.equal(result[0]?.message, diagnostic.message)
  assert.deepEqual([result[0]?.from, result[0]?.to], [6, 11])
})

test('a pending diagnostic response cannot mark an edited document or a different active file', async () => {
  let state = EditorState.create({ doc: 'const count = "bad"' })
  const view = {
    get state() {
      return state
    },
  } as EditorView
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let activePath = 'App.vue'
  const source = createWorkbenchCodeMirrorLintSource({
    projectRoot: '/project',
    path: 'App.vue',
    language: 'Vue',
    getOpenTabs: () => [],
    getActivePath: () => activePath,
    requestDiagnostics: async () => {
      await pending
      return Result.ok({ projectRoot: '/project', path: 'App.vue', diagnostics: [diagnostic] })
    },
  })
  const result = source(view)
  state = state.update({
    changes: { from: 0, to: state.doc.length, insert: 'const count = 42' },
  }).state
  release()
  assert.deepEqual(await result, [])
  const switched = source(view)
  activePath = 'Other.vue'
  assert.deepEqual(await switched, [])
})
