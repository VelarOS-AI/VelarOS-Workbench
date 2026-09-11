import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { buildWorkbenchExplanationAnchors } from '../src/renderer/src/components/editor/workbenchExplanationExtension'
import {
  buildWorkbenchAgentRunSnapshot,
  stripWorkbenchTerminalControlSequences,
} from '../src/renderer/src/models/commands/workbenchAgentRunSnapshot'
import { buildWorkbenchAgentEditorState } from '../src/renderer/src/models/editor/workbenchAgentEditorState'
import { WorkbenchExplanationStore } from '../src/renderer/src/models/explanations/workbenchExplanationStore'
import {
  performWorkbenchAgentUiRequest,
  readWorkbenchAgentUiRequest,
  registerWorkbenchAgentUiHandler,
} from '../src/renderer/src/runtime/workbenchAgentUiHost'
import { WorkbenchAgentUiNoticeKind } from '../src/shared/workbenchAgentUi'

function explanation(path: string, startLine: number, endLine: number, text: string) {
  return { path, startLine, endLine, title: '', text }
}

void describe('Workbench explanation store', () => {
  void test('a batch becomes the walkthrough; replace starts over, append keeps going', () => {
    let now = 1_000
    const store = new WorkbenchExplanationStore(() => now)
    const first = store.addBatch({
      projectRoot: '/repo/',
      sessionId: 's1',
      explanations: [explanation('a.ts', 1, 3, 'one'), explanation('b.ts', 5, 5, 'two')],
      replace: true,
    })
    assert.equal(store.getSnapshot().activeId, first[0]?.id)
    assert.equal(store.getSnapshot().focusRevision, 1)

    now = 1_000 // 同一毫秒再加一批：路线顺序仍然按先后。
    const appended = store.addBatch({
      projectRoot: '/repo',
      sessionId: 's1',
      explanations: [explanation('a.ts', 10, 12, 'three')],
      replace: false,
    })
    assert.deepEqual(store.listForProject('/repo').map((item) => item.text), ['one', 'two', 'three'])
    assert.equal(store.getSnapshot().activeId, appended[0]?.id)

    // 沿路线前后走；到头原地不动，也不算一次「切到某条讲解」。
    assert.equal(store.step(appended[0]!.id, 1)?.text, 'three')
    assert.equal(store.getSnapshot().focusRevision, 2)
    assert.equal(store.step(appended[0]!.id, -1)?.text, 'two')
    assert.equal(store.getSnapshot().focusRevision, 3)

    store.addBatch({
      projectRoot: '/repo',
      sessionId: 's2',
      explanations: [explanation('c.ts', 1, 1, 'fresh')],
      replace: true,
    })
    assert.deepEqual(store.listForProject('/repo').map((item) => item.text), ['fresh'])
  })

  void test('clearing, collapsing and edits never jump the editor', () => {
    const store = new WorkbenchExplanationStore(() => 1)
    const [a, b] = store.addBatch({
      projectRoot: '/repo',
      sessionId: 's',
      explanations: [explanation('a.ts', 1, 2, 'a'), explanation('b.ts', 3, 4, 'b')],
      replace: true,
    })
    const focus = store.getSnapshot().focusRevision

    store.updateLines([{ id: a!.id, startLine: 2, endLine: 3 }])
    assert.equal(store.listForProject('/repo')[0]?.startLine, 2)
    store.activate(null)
    assert.equal(store.getSnapshot().activeId, null)
    assert.equal(store.getSnapshot().focusRevision, focus)

    assert.equal(store.clear('/repo', 'a.ts'), 1)
    assert.deepEqual(store.listForProject('/repo').map((item) => item.id), [b!.id])
    store.removeMany([b!.id])
    assert.equal(store.clear('/repo'), 0)
  })

  void test('anchors follow the tour order and skip stops the file no longer has', () => {
    const lines = ['const a = 1', '', 'function b() {', '  return a', '}']
    let offset = 0
    const lineStarts = lines.map((line) => {
      const start = offset
      offset += line.length + 1
      return { from: start, to: start + line.length }
    })
    const doc = { lines: lines.length, line: (n: number) => lineStarts[n - 1]! }
    const anchors = buildWorkbenchExplanationAnchors(
      doc,
      'src/a.ts',
      [
        { id: 'x', path: 'src/a.ts', startLine: 3, endLine: 9, title: 't', text: 'fn' },
        { id: 'y', path: 'src/other.ts', startLine: 1, endLine: 1, title: '', text: 'elsewhere' },
        { id: 'z', path: 'src/a.ts', startLine: 2, endLine: 2, title: '', text: 'blank line' },
        { id: 'w', path: 'src/a.ts', startLine: 40, endLine: 41, title: '', text: 'gone' },
      ],
      'z'
    )
    assert.deepEqual(
      anchors.map((anchor) => [anchor.id, anchor.from, anchor.to, anchor.index, anchor.total, anchor.active]),
      [
        ['x', lineStarts[2]!.from, lineStarts[4]!.to, 1, 4, false],
        // 空行上的讲解是零宽锚点，照样显示。
        ['z', lineStarts[1]!.from, lineStarts[1]!.from, 3, 4, true],
      ]
    )
  })
})

void describe('Workbench agent UI host', () => {
  void test('reads UI requests out of agent events and hands them to the project page', async () => {
    const request = {
      requestId: 'r1',
      executionId: 'e1',
      sessionId: 's1',
      command: { type: 'reveal-path' as const, path: 'src' },
    }
    assert.equal(readWorkbenchAgentUiRequest({ type: 'text-delta', text: 'hi' }), null)
    assert.equal(readWorkbenchAgentUiRequest({ type: 'notice', kind: 'other', payload: request }), null)
    assert.deepEqual(
      readWorkbenchAgentUiRequest({ type: 'notice', kind: WorkbenchAgentUiNoticeKind, payload: request }),
      request
    )

    assert.deepEqual(await performWorkbenchAgentUiRequest('/repo', request), {
      requestId: 'r1',
      executionId: 'e1',
      ok: false,
      message: 'The Workbench window for this project is not ready.',
    })
    const seen: unknown[] = []
    const unregister = registerWorkbenchAgentUiHandler('/repo/', async (command, context) => {
      seen.push([command, context.sessionId])
      if (command.type === 'reveal-path') return { path: command.path }
      throw new Error('not supported here')
    })
    try {
      assert.deepEqual(await performWorkbenchAgentUiRequest('/repo', request), {
        requestId: 'r1',
        executionId: 'e1',
        ok: true,
        data: { path: 'src' },
      })
      const failed = await performWorkbenchAgentUiRequest('/repo', {
        ...request,
        command: { type: 'read-editor-state' },
      })
      assert.equal(failed.ok, false)
      assert.match(failed.ok ? '' : failed.message, /not supported here/u)
      assert.deepEqual(seen[0], [{ type: 'reveal-path', path: 'src' }, 's1'])
    } finally {
      unregister()
    }
  })

  void test('reports what the user is looking at, with the selected text and unsaved files', () => {
    const state = buildWorkbenchAgentEditorState({
      view: 'file',
      selectedFilePath: 'src/a.ts',
      cursor: {
        line: 3,
        column: 5,
        selection: { startLine: 2, endLine: 3, startColumn: 3, endColumn: 5 },
      },
      editorContent: 'line one\nline two\nline three\n',
      openTabs: [
        { path: 'src/a.ts', content: 'changed', file: { content: 'original' } },
        { path: 'README.md', content: 'same', file: { content: 'same' } },
      ],
      explanationCount: 2,
    })
    assert.deepEqual(state, {
      view: 'file',
      activeFile: { path: 'src/a.ts', line: 3, column: 5, unsaved: true },
      selection: { startLine: 2, endLine: 3, text: 'ne two\nline', truncated: false },
      openFiles: [
        { path: 'src/a.ts', unsaved: true },
        { path: 'README.md', unsaved: false },
      ],
      explanationCount: 2,
    })

    // 对比视图里光标不属于可编辑文件：只报视图种类。
    const diffState = buildWorkbenchAgentEditorState({
      view: 'git-diff',
      selectedFilePath: 'src/a.ts',
      cursor: { line: 1, column: 1 },
      editorContent: '',
      openTabs: [],
      explanationCount: 0,
    })
    assert.equal(diffState.activeFile, null)
    assert.equal(diffState.selection, null)
  })
})

void describe('Workbench agent run snapshot', () => {
  void test('hands the model clean text: no colors, no redrawn progress, only the last lines', () => {
    const colored = '\u001b[32mready\u001b[39m in 120ms\r\n'
    const progress = 'building 10%\rbuilding 60%\rbuilding 100%\n'
    const title = '\u001b]0;vite\u0007Local: http://localhost:5173/\n'
    assert.equal(
      stripWorkbenchTerminalControlSequences(colored + progress + title),
      'ready in 120ms\nbuilding 100%\nLocal: http://localhost:5173/\n'
    )

    const session = {
      id: 'run-1',
      title: '开发服务器',
      shell: 'zsh',
      cwd: '/repo',
      input: '',
      isRunning: true,
      command: 'npm run dev',
      lines: [colored, progress, title].map((text, index) => ({
        id: String(index),
        stream: 'stdout' as const,
        text,
        createdAt: index,
      })),
    }
    assert.deepEqual(buildWorkbenchAgentRunSnapshot(session, 2, 'local:'), {
      sessionId: 'run-1',
      command: 'npm run dev',
      running: true,
      output: 'building 100%\nLocal: http://localhost:5173/',
      totalLines: 3,
      matched: true,
    })
    assert.equal(buildWorkbenchAgentRunSnapshot(session, 60, null).matched, undefined)
    assert.equal(buildWorkbenchAgentRunSnapshot({ ...session, isRunning: false }, 1, 'error').matched, false)
  })
})
