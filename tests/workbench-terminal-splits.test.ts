import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import type { WorkbenchTerminalSessionView } from '../src/renderer/src/models/commands/workbenchCommandLines'
import { buildWorkbenchTerminalSessionTitle } from '../src/renderer/src/models/commands/workbenchTerminalPresentation'
import {
  adjacentWorkbenchTerminalPane,
  closeWorkbenchTerminalSessions,
  findActiveWorkbenchTerminalGroup,
  groupWorkbenchTerminalSessions,
  insertWorkbenchTerminalSplit,
  matchWorkbenchTerminalPaneKey,
  pickWorkbenchTerminalTitle,
  resizeWorkbenchTerminalPanes,
  workbenchTerminalPaneShares,
  workbenchTerminalSplitShortcut,
} from '../src/renderer/src/models/commands/workbenchTerminalSplits'

function session(id: string, title = id): WorkbenchTerminalSessionView {
  return { id, title, shell: '/bin/zsh', cwd: '/project', isRunning: true }
}

/** 标签栏的样子：每个标签里并排的会话，如 `a+c | b`。 */
function layout(sessions: readonly WorkbenchTerminalSessionView[]): string {
  return groupWorkbenchTerminalSessions(sessions)
    .map((group) => group.sessions.map((item) => item.id).join('+'))
    .join(' | ')
}

function near(actual: readonly number[], expected: readonly number[]): void {
  assert.equal(actual.length, expected.length)
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]!) < 1e-9, `${actual}`))
}

const key = (
  code: string,
  modifiers: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}
) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers })

void describe('terminals side by side in one tab', () => {
  void test('a split goes right of the terminal it came from, in the same tab, with half its width', () => {
    const tabs = [session('a'), session('b')]
    assert.equal(layout(tabs), 'a | b')

    const split = insertWorkbenchTerminalSplit(tabs, 'a', session('c'))
    assert.equal(layout(split), 'a+c | b')
    near(workbenchTerminalPaneShares(split.slice(0, 2)), [0.5, 0.5])

    // 再拆右边那个：它把自己的一半让出来，左边的不动。
    const again = insertWorkbenchTerminalSplit(split, 'c', session('d'))
    assert.equal(layout(again), 'a+c+d | b')
    near(workbenchTerminalPaneShares(again.slice(0, 3)), [0.5, 0.25, 0.25])

    // 拆中间的：新的紧挨在它右边。
    assert.equal(layout(insertWorkbenchTerminalSplit(again, 'a', session('e'))), 'a+e+c+d | b')

    // 原来那个已经关掉了：当成新标签。
    assert.equal(layout(insertWorkbenchTerminalSplit(tabs, 'gone', session('c'))), 'a | b | c')
  })

  void test('the current tab is the one holding the current terminal', () => {
    const sessions = insertWorkbenchTerminalSplit([session('a'), session('b')], 'b', session('c'))
    assert.equal(findActiveWorkbenchTerminalGroup(sessions, 'c')?.id, 'b')
    assert.equal(findActiveWorkbenchTerminalGroup(sessions, 'a')?.id, 'a')
    assert.equal(findActiveWorkbenchTerminalGroup(sessions, null)?.id, 'a')
    assert.equal(findActiveWorkbenchTerminalGroup(sessions, 'gone')?.id, 'a')
    assert.equal(findActiveWorkbenchTerminalGroup([], null), null)
  })

  void test('closing the current terminal moves to its neighbour, then to the tab on the left', () => {
    let sessions = [session('a'), session('b'), session('z')]
    sessions = insertWorkbenchTerminalSplit(sessions, 'b', session('c'))
    sessions = insertWorkbenchTerminalSplit(sessions, 'c', session('d'))
    assert.equal(layout(sessions), 'a | b+c+d | z')
    const close = (active: Nullable<string>, ...ids: string[]) => {
      const result = closeWorkbenchTerminalSessions(sessions, active, ids)
      return `${layout(result.sessions)} -> ${result.activeSessionId}`
    }

    // 并排里关一个：右边的接上，没有右边的就左边的。
    assert.equal(close('c', 'c'), 'a | b+d | z -> d')
    assert.equal(close('d', 'd'), 'a | b+c | z -> c')
    // 关的是组里第一个：组还在（剩下的仍在同一个标签里）。
    assert.equal(close('b', 'b'), 'a | c+d | z -> c')
    // 关的不是当前的：当前的不变。
    assert.equal(close('b', 'd'), 'a | b+c | z -> b')
    // 关整个标签：到左边那个标签，最左边的关了就到右边。
    assert.equal(close('c', 'b', 'c', 'd'), 'a | z -> a')
    assert.equal(close('a', 'a'), 'b+c+d | z -> b')
    // 全关了。
    assert.equal(close('a', 'a', 'b', 'c', 'd', 'z'), ' -> null')
    // 当前的那个本来就不在了：落到最后一个。
    assert.equal(close('gone', 'a'), 'b+c+d | z -> z')
  })

  void test('moving between side-by-side terminals wraps around; a lone terminal has no neighbour', () => {
    let sessions = [session('a'), session('b')]
    sessions = insertWorkbenchTerminalSplit(sessions, 'b', session('c'))
    sessions = insertWorkbenchTerminalSplit(sessions, 'c', session('d'))
    assert.equal(adjacentWorkbenchTerminalPane(sessions, 'b', 1), 'c')
    assert.equal(adjacentWorkbenchTerminalPane(sessions, 'd', 1), 'b')
    assert.equal(adjacentWorkbenchTerminalPane(sessions, 'b', -1), 'd')
    assert.equal(adjacentWorkbenchTerminalPane(sessions, 'c', -1), 'b')
    assert.equal(adjacentWorkbenchTerminalPane(sessions, 'a', 1), null)
    assert.equal(adjacentWorkbenchTerminalPane(sessions, null, 1), null)
    assert.equal(adjacentWorkbenchTerminalPane([], 'a', 1), null)
  })

  void test('dragging a divider trades width between its two neighbours only, never below the minimum', () => {
    near(resizeWorkbenchTerminalPanes([0.5, 0.5], 0, 0.2), [0.7, 0.3])
    near(resizeWorkbenchTerminalPanes([0.5, 0.5], 0, -0.2), [0.3, 0.7])
    near(resizeWorkbenchTerminalPanes([0.5, 0.25, 0.25], 1, 0.1), [0.5, 0.35, 0.15])
    // 拖过头：停在最小宽度。
    near(resizeWorkbenchTerminalPanes([0.5, 0.5], 0, 0.9), [0.9, 0.1])
    near(resizeWorkbenchTerminalPanes([0.5, 0.5], 0, -0.9), [0.1, 0.9])
    // 两个加起来还不到两倍最小宽度：对半分为限。
    near(resizeWorkbenchTerminalPanes([0.85, 0.1, 0.05], 1, 0.5), [0.85, 0.075, 0.075])
    // 不存在的分隔条：原样。
    near(resizeWorkbenchTerminalPanes([0.5, 0.5], 1, 0.2), [0.5, 0.5])

    // 记下来的份额不必加起来是 1：按比例算。
    const weighted = [
      { ...session('a'), paneWeight: 0.7 },
      { ...session('b'), paneWeight: 0.3 },
      session('c'),
    ]
    near(workbenchTerminalPaneShares(weighted), [0.35, 0.15, 0.5])
  })

  void test('a new tab takes the first name that is not in use', () => {
    const titleAt = (index: number): string =>
      buildWorkbenchTerminalSessionTitle(index, {
        local: '本地',
        localIndexed: (number) => `本地 (${number})`,
      })
    assert.equal(pickWorkbenchTerminalTitle([], titleAt), '本地')
    assert.equal(pickWorkbenchTerminalTitle([session('a', '本地')], titleAt), '本地 (2)')
    // 并排的几个共用一个名字，不多占号。
    const split = insertWorkbenchTerminalSplit([session('a', '本地')], 'a', session('b', '本地'))
    assert.equal(pickWorkbenchTerminalTitle(split, titleAt), '本地 (2)')
    // 第一个关掉了：新开的补上它的名字，不跟现有的重名。
    assert.equal(pickWorkbenchTerminalTitle([session('b', '本地 (2)')], titleAt), '本地')
    assert.equal(
      pickWorkbenchTerminalTitle([session('a', '本地'), session('c', '本地 (3)')], titleAt),
      '本地 (2)'
    )
  })

  void test('the split and focus keys are recognised by physical key, per platform', () => {
    assert.equal(matchWorkbenchTerminalPaneKey(key('KeyD', { metaKey: true }), true), 'split')
    assert.equal(
      matchWorkbenchTerminalPaneKey(key('ArrowLeft', { metaKey: true, altKey: true }), true),
      'focus-previous'
    )
    assert.equal(
      matchWorkbenchTerminalPaneKey(key('ArrowRight', { metaKey: true, altKey: true }), true),
      'focus-next'
    )
    // Ctrl+D 是给 shell 的文件结束符，⌘⇧D、⌥← 都不是这几个动作。
    assert.equal(matchWorkbenchTerminalPaneKey(key('KeyD', { ctrlKey: true }), true), null)
    assert.equal(matchWorkbenchTerminalPaneKey(key('KeyD', { metaKey: true, shiftKey: true }), true), null)
    assert.equal(matchWorkbenchTerminalPaneKey(key('KeyD', { metaKey: true, altKey: true }), true), null)
    assert.equal(matchWorkbenchTerminalPaneKey(key('ArrowLeft', { altKey: true }), true), null)
    assert.equal(matchWorkbenchTerminalPaneKey(key('ArrowLeft', { metaKey: true }), true), null)

    assert.equal(
      matchWorkbenchTerminalPaneKey(key('Digit5', { ctrlKey: true, shiftKey: true }), false),
      'split'
    )
    assert.equal(matchWorkbenchTerminalPaneKey(key('ArrowLeft', { altKey: true }), false), 'focus-previous')
    assert.equal(matchWorkbenchTerminalPaneKey(key('ArrowRight', { altKey: true }), false), 'focus-next')
    assert.equal(matchWorkbenchTerminalPaneKey(key('KeyD', { ctrlKey: true }), false), null)
    assert.equal(matchWorkbenchTerminalPaneKey(key('Digit5', { ctrlKey: true }), false), null)
    assert.equal(
      matchWorkbenchTerminalPaneKey(key('ArrowLeft', { altKey: true, shiftKey: true }), false),
      null
    )
    assert.equal(matchWorkbenchTerminalPaneKey(key('KeyD', { metaKey: true }), false), null)

    assert.equal(workbenchTerminalSplitShortcut(true), 'Mod+D')
    assert.equal(workbenchTerminalSplitShortcut(false), 'Ctrl+Shift+5')
  })
})
