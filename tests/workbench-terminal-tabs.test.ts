import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import type { WorkbenchTerminalSessionView } from '../src/renderer/src/models/commands/workbenchCommandLines'
import {
  buildWorkbenchTerminalSessionTitle,
  closeWorkbenchTerminalSessions,
  pickWorkbenchTerminalTitle,
} from '../src/renderer/src/models/commands/workbenchTerminalPresentation'

function session(id: string, title = id): WorkbenchTerminalSessionView {
  return { id, title, shell: '/bin/zsh', cwd: '/project', isRunning: true }
}

void describe('terminal tabs', () => {
  void test('closing tabs keeps the selection or moves to the closest surviving neighbour', () => {
    const tabs = ['a', 'b', 'c', 'd'].map((id) => session(id))
    for (const [active, closing, expected] of [
      ['c', ['a'], 'c'],
      ['c', ['c'], 'b'],
      ['c', ['b', 'c'], 'a'],
      ['a', ['a', 'b'], 'c'],
      ['d', ['a', 'b', 'c', 'd'], null],
      [null, ['a', 'b'], 'd'],
    ] as const) {
      const result = closeWorkbenchTerminalSessions(tabs, active, closing)
      assert.equal(result.activeSessionId, expected)
      assert.deepEqual(result.sessions.map((item) => item.id), tabs
        .filter((item) => !(closing as readonly string[]).includes(item.id))
        .map((item) => item.id))
    }
    assert.deepEqual(closeWorkbenchTerminalSessions([], null, []), {
      sessions: [], activeSessionId: null,
    })
  })

  void test('new terminal titles reuse the first available number', () => {
    const titleAt = (index: number) => buildWorkbenchTerminalSessionTitle(index, {
      local: '本地', localIndexed: (number) => `本地 (${number})`,
    })
    assert.equal(pickWorkbenchTerminalTitle([], titleAt), '本地')
    const tabs = [session('a', '本地'), session('c', '本地 (3)')]
    assert.equal(pickWorkbenchTerminalTitle(tabs, titleAt), '本地 (2)')
    assert.equal(pickWorkbenchTerminalTitle([...tabs, session('b', '本地 (2)')], titleAt), '本地 (4)')
  })
})
