import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { javascript } from '@codemirror/lang-javascript'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, test } from 'bun:test'

import {
  installWorkbenchRunSessionLauncher,
  launchWorkbenchRunSession,
  publishWorkbenchRunSessionExit,
  publishWorkbenchRunSessionRestart,
} from '../src/renderer/src/models/commands/workbenchRunSessionBridge'
import {
  focusWorkbenchEditorActions,
  getWorkbenchEditorActionsSnapshot,
  registerWorkbenchEditorActions,
  runWorkbenchEditorAction,
  subscribeWorkbenchEditorActions,
} from '../src/renderer/src/models/editor/workbenchEditorActions'
import { buildWorkbenchTestRunGutterLines } from '../src/renderer/src/models/editor/workbenchTestRunGutter'
import {
  readWorkbenchTestRunStatus,
  subscribeWorkbenchTestRunResults,
  trackWorkbenchTestRun,
  workbenchTestRunResultKey,
} from '../src/renderer/src/models/editor/workbenchTestRunResults'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

function parse(source: string): EditorState {
  const state = EditorState.create({ doc: source, extensions: [javascript({ typescript: true })] })
  assert.ok(ensureSyntaxTree(state, source.length, 5_000), 'the document should parse')
  // ensureSyntaxTree 推进解析上下文，空事务把完整语法树同步到不可变的编辑器状态。
  return state.update({}).state
}

void describe('run markers of a test file', () => {
  const source = [
    "import { describe, it } from 'vitest'",
    '',
    "describe('suite', () => {",
    "  it('one', () => {})",
    "  it('two', () => {}); it('same line', () => {})",
    '})',
  ].join('\n')

  void test('puts the whole file on the first line and one marker on each line with a block', () => {
    const state = parse(source)
    assert.deepEqual(
      buildWorkbenchTestRunGutterLines(state, 0, source.length).map((line) => [
        state.doc.lineAt(line.position).number,
        line.target.kind,
        line.target.title,
        line.target.pattern,
      ]),
      [
        [1, 'file', '', null],
        [3, 'suite', 'suite', '^suite '],
        [4, 'test', 'one', '^suite (?:> )?one$'],
        [5, 'test', 'two', '^suite (?:> )?two$'],
      ]
    )
  })

  void test('marks only the lines inside the visible range', () => {
    const state = parse(source)
    const from = state.doc.line(4).from
    assert.deepEqual(
      buildWorkbenchTestRunGutterLines(state, from, state.doc.line(4).to).map((line) => [
        state.doc.lineAt(line.position).number,
        line.target.title,
      ]),
      // 包着它的 describe 开头在范围之上：不在这里标，但名字照样算进来。
      [[4, 'one']]
    )
    // 第一行被一个块占着时，第一行仍是「跑整个文件」。
    const compact = parse("it('first line', () => {})\nit('second', () => {})")
    assert.deepEqual(
      buildWorkbenchTestRunGutterLines(compact, 0, compact.doc.length).map((line) => line.target.title),
      ['', 'second']
    )
  })
})

void describe('results of tests run from the editor', () => {
  void test('a debugged run gives no verdict: only a normal run is followed', () => {
    // 在断点上停久了 Vitest 会报 worker 调用超时，测试过了退出码也是 1：调试的那张卡不记到标记上。
    const hook = readSource('src/renderer/src/hooks/useWorkbenchEditorRunDebug.ts')
    assert.match(
      hook,
      /if \(sessionId && !debug\) trackWorkbenchTestRun\(resultKey\(target\), sessionId\)/u
    )
  })

  void test('follows the run card: running, then passed or failed by its exit code', () => {
    const key = workbenchTestRunResultKey('/project', 'src/a.test.ts', '^suite (?:> )?one$')
    const other = workbenchTestRunResultKey('/project', 'src/a.test.ts', '')
    let notifications = 0
    const unsubscribe = subscribeWorkbenchTestRunResults(() => (notifications += 1))
    try {
      assert.equal(readWorkbenchTestRunStatus(key), null)

      trackWorkbenchTestRun(key, 'terminal-1')
      assert.equal(readWorkbenchTestRunStatus(key), 'running')
      // 别的运行卡结束与它无关。
      publishWorkbenchRunSessionExit({ sessionId: 'terminal-unrelated', exitCode: 1, interrupted: false })
      assert.equal(readWorkbenchTestRunStatus(key), 'running')

      publishWorkbenchRunSessionExit({ sessionId: 'terminal-1', exitCode: 0, interrupted: false })
      assert.equal(readWorkbenchTestRunStatus(key), 'passed')
      assert.equal(readWorkbenchTestRunStatus(other), null)

      // 再跑一次没通过。
      trackWorkbenchTestRun(key, 'terminal-2')
      publishWorkbenchRunSessionExit({ sessionId: 'terminal-2', exitCode: 1, interrupted: false })
      assert.equal(readWorkbenchTestRunStatus(key), 'failed')
      // 上一张卡后来再报什么都不算数了。
      publishWorkbenchRunSessionExit({ sessionId: 'terminal-1', exitCode: 0, interrupted: false })
      assert.equal(readWorkbenchTestRunStatus(key), 'failed')
      assert.ok(notifications >= 4)
    } finally {
      unsubscribe()
    }
  })

  void test('a stopped run has no verdict, and a restarted card is followed again', () => {
    const key = workbenchTestRunResultKey('/project', 'src/b.test.ts', '')

    trackWorkbenchTestRun(key, 'terminal-10')
    publishWorkbenchRunSessionExit({ sessionId: 'terminal-10', exitCode: 143, interrupted: true })
    assert.equal(readWorkbenchTestRunStatus(key), null)

    // 重启这张卡：旧会话先被停掉，再换成新会话。
    publishWorkbenchRunSessionRestart('terminal-10', 'terminal-11')
    assert.equal(readWorkbenchTestRunStatus(key), 'running')
    publishWorkbenchRunSessionExit({ sessionId: 'terminal-11', exitCode: 1, interrupted: false })
    assert.equal(readWorkbenchTestRunStatus(key), 'failed')

    // 跑完之后再重启同样跟着。
    publishWorkbenchRunSessionRestart('terminal-11', 'terminal-12')
    assert.equal(readWorkbenchTestRunStatus(key), 'running')
    publishWorkbenchRunSessionExit({ sessionId: 'terminal-12', exitCode: 0, interrupted: false })
    assert.equal(readWorkbenchTestRunStatus(key), 'passed')
  })

  void test('the editor starts run cards through whatever the page installed', async () => {
    assert.equal(await launchWorkbenchRunSession('npx vitest run a.test.ts'), null)

    const launched: unknown[][] = []
    installWorkbenchRunSessionLauncher(async (...launch) => {
      launched.push(launch)
      return 'terminal-7'
    })
    try {
      assert.equal(
        await launchWorkbenchRunSession('npx vitest run a.test.ts', 'a.test.ts', { cwd: 'packages/a' }),
        'terminal-7'
      )
      assert.deepEqual(launched, [['npx vitest run a.test.ts', 'a.test.ts', { cwd: 'packages/a' }]])
    } finally {
      installWorkbenchRunSessionLauncher(null)
    }
  })
})

void describe('actions of the editor in front', () => {
  void test('the command palette sees and runs what the editor in front registered', () => {
    // 编辑区左右两组各有一个编辑器。
    const left = {}
    const right = {}
    const changes: string[] = []
    const unsubscribe = subscribeWorkbenchEditorActions(() =>
      changes.push(getWorkbenchEditorActionsSnapshot())
    )
    const ran: string[] = []
    try {
      assert.equal(getWorkbenchEditorActionsSnapshot(), '')
      assert.equal(runWorkbenchEditorAction('run-test-file'), false)

      const unregisterFirst = registerWorkbenchEditorActions(left, {
        'run-test-file': () => ran.push('first file'),
        'run-test-at-cursor': () => ran.push('first cursor'),
      })
      assert.equal(getWorkbenchEditorActionsSnapshot(), 'run-test-at-cursor run-test-file')

      // 换文件时同一个编辑器的新旧两份短暂同时在：以后登记的为准，动作集合没变就不通知。
      const unregisterSecond = registerWorkbenchEditorActions(left, {
        'run-test-file': () => ran.push('second file'),
      })
      assert.equal(runWorkbenchEditorAction('run-test-file'), true)
      assert.equal(runWorkbenchEditorAction('run-test-at-cursor'), true)
      unregisterFirst()
      assert.equal(getWorkbenchEditorActionsSnapshot(), 'run-test-file')
      assert.equal(runWorkbenchEditorAction('run-test-at-cursor'), false)

      // 另一组的编辑器挂上了，它做得了别的：还没有谁得到过焦点时，算最近登记的那个。
      const unregisterRight = registerWorkbenchEditorActions(right, {
        'toggle-breakpoint': () => ran.push('right breakpoint'),
      })
      assert.equal(getWorkbenchEditorActionsSnapshot(), 'toggle-breakpoint')
      assert.equal(runWorkbenchEditorAction('run-test-file'), false)
      // 焦点进了左边的编辑器：动作归它，另一组的不算。
      focusWorkbenchEditorActions(left)
      assert.equal(getWorkbenchEditorActionsSnapshot(), 'run-test-file')
      assert.equal(runWorkbenchEditorAction('toggle-breakpoint'), false)
      assert.equal(runWorkbenchEditorAction('run-test-file'), true)
      focusWorkbenchEditorActions(right)
      assert.equal(runWorkbenchEditorAction('toggle-breakpoint'), true)
      // 得到焦点的那个编辑器卸载了：退回还在的那个。
      unregisterRight()
      assert.equal(getWorkbenchEditorActionsSnapshot(), 'run-test-file')
      unregisterSecond()
      assert.equal(getWorkbenchEditorActionsSnapshot(), '')

      assert.deepEqual(ran, ['second file', 'first cursor', 'second file', 'right breakpoint'])
      assert.deepEqual(changes, [
        'run-test-at-cursor run-test-file',
        'run-test-file',
        'toggle-breakpoint',
        'run-test-file',
        'toggle-breakpoint',
        'run-test-file',
        '',
      ])
    } finally {
      unsubscribe()
    }
  })
})

void describe('wiring of the test markers', () => {
  void test('the editor mounts them through one compartment and the page starts their runs', () => {
    const editor = readSource('src/renderer/src/components/editor/CodeMirrorEditor.tsx')
    assert.match(editor, /const runDebugExtension = useWorkbenchEditorRunDebugExtension\(\{/u)
    assert.match(editor, /runDebugCompartment\.of\(current\.runDebug\)/u)
    assert.match(editor, /\[runDebugCompartment, current\.runDebug\]/u)
    assert.match(
      editor,
      /reconfigureCompartment\(viewRef\.current, runDebugCompartment, runDebugExtension\)/u
    )

    // 起运行卡之前先存盘：运行器读的是磁盘上的文件。
    const pageModel = readSource('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx')
    assert.match(
      pageModel,
      /await workbench\.saveAllOpenFiles\(\)\s+return workbench\.launchRunSession\(\.\.\.launch\)/u
    )
    assert.match(pageModel, /installWorkbenchRunSessionLauncher\(launchRunSessionFromEditor\)/u)

    // 运行卡怎么结束的、被重启成了哪个会话，都报给结果表。
    assert.match(
      readSource('src/renderer/src/hooks/workbenchCommand/useWorkbenchCommandIpcSubscriptions.ts'),
      /publishWorkbenchRunSessionExit\(\{\s+sessionId: event\.sessionId,\s+exitCode: event\.exitCode \?\? null,\s+interrupted: !!event\.signal && event\.signal !== '0',/u
    )
    assert.match(
      readSource('src/renderer/src/hooks/useWorkbenchCommandController.ts'),
      /publishWorkbenchRunSessionRestart\(sessionId, result\.sessionId\)/u
    )
  })

  void test('detection and markers stay out of the workspace shell chunk', () => {
    // 外壳里只有桥和动作登记表这两个小模块；认运行器、找测试块、画标记都跟着编辑器按需加载。
    for (const shellModule of [
      'src/renderer/src/models/commands/workbenchRunSessionBridge.ts',
      'src/renderer/src/models/editor/workbenchEditorActions.ts',
      'src/renderer/src/hooks/useWorkbenchCommandPalette.ts',
      'src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx',
    ])
      assert.doesNotMatch(
        readSource(shellModule),
        /from '[^']*(?:workbenchTestRunner|workbenchTestBlocks|workbenchTestRunGutter|workbenchTestRunResults|useWorkbenchEditorRunDebug)'/u,
        shellModule
      )
  })
})
