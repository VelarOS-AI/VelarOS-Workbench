import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, test } from 'bun:test'

import { createWorkbenchDebugShortcutKeydownHandler } from '../src/renderer/src/hooks/useWorkbenchDebugShortcuts'
import {
  createWorkbenchShortcutKeydownHandler,
  type UseWorkbenchKeyboardShortcutsOptions,
} from '../src/renderer/src/hooks/useWorkbenchKeyboardShortcuts'
import {
  installWorkbenchDebugActionRunner,
  publishWorkbenchDebugStatus,
} from '../src/renderer/src/models/debug/workbenchDebugBridge'
import { WorkbenchDebugSessionController } from '../src/renderer/src/models/debug/workbenchDebugSession'
import {
  buildWorkbenchKeymapConflicts,
  DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP,
} from '../src/renderer/src/models/layout/workbenchKeyboardShortcuts'
import type { WorkbenchDebuggerBridge, WorkbenchDebuggerEvent } from '../src/shared/workbenchDebugger'

import { shareHostReactWithLinkedUi } from './helpers/linkedUiReact'

shareHostReactWithLinkedUi()

const { WorkbenchLocalizationProvider } = await import('../src/renderer/src/i18n/WorkbenchLocalizationProvider')
const { WorkbenchDebugPanel } = await import('../src/renderer/src/components/WorkbenchDebugPanel')

const Mac = 'MacIntel'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

function keydown(key: string, init: { shiftKey?: boolean; metaKey?: boolean } = {}) {
  const state = { prevented: false, stopped: false }
  const event = {
    key,
    code: key,
    metaKey: init.metaKey ?? false,
    ctrlKey: false,
    shiftKey: init.shiftKey ?? false,
    altKey: false,
    target: { tagName: 'DIV', isContentEditable: true },
    get defaultPrevented() {
      return state.prevented
    },
    preventDefault() {
      state.prevented = true
    },
    stopPropagation() {
      state.stopped = true
    },
  } as unknown as KeyboardEvent
  return { event, state }
}

void describe('debugger keys', () => {
  void test('F8, F10, F11, ⇧F11 and ⇧F5 are the defaults and clash with no other shortcut', () => {
    assert.deepEqual(
      [
        DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP['debug-continue'],
        DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP['debug-step-over'],
        DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP['debug-step-into'],
        DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP['debug-step-out'],
        DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP['debug-stop'],
      ],
      ['F8', 'F10', 'F11', 'Shift+F11', 'Shift+F5']
    )
    assert.deepEqual(buildWorkbenchKeymapConflicts(DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP), [])
  })

  void test('take the key only while debugging, and only when the action applies', () => {
    const ran: string[] = []
    installWorkbenchDebugActionRunner((action) => ran.push(action))
    const handle = createWorkbenchDebugShortcutKeydownHandler(
      () => DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP,
      Mac
    )
    const press = (key: string, init?: { shiftKey?: boolean; metaKey?: boolean }) => {
      const { event, state } = keydown(key, init)
      handle(event)
      return state.prevented && state.stopped ? 'taken' : 'passed on'
    }
    try {
      // 没在调试：F8 照常是编辑器里的「下一个问题」，F11 归系统与菜单——一个都不拦。
      for (const key of ['F8', 'F10', 'F11']) assert.equal(press(key), 'passed on', key)
      assert.equal(press('F5', { shiftKey: true }), 'passed on')
      assert.deepEqual(ran, [])

      // 程序在跑：只有「结束」做得了；继续与单步的键不拦。
      publishWorkbenchDebugStatus('running')
      assert.equal(press('F8'), 'passed on')
      assert.equal(press('F10'), 'passed on')
      assert.equal(press('F5', { shiftKey: true }), 'taken')
      assert.deepEqual(ran, ['stop'])

      // 停着：五个键都归调试器，抢在焦点所在的编辑器前面（所以要拦住，不再往下传）。
      publishWorkbenchDebugStatus('paused')
      assert.equal(press('F8'), 'taken')
      assert.equal(press('F10'), 'taken')
      assert.equal(press('F11'), 'taken')
      assert.equal(press('F11', { shiftKey: true }), 'taken')
      assert.equal(press('F5', { shiftKey: true }), 'taken')
      assert.deepEqual(ran, ['stop', 'continue', 'step-over', 'step-into', 'step-out', 'stop'])
      // 别的键、带着别的修饰键的不是它的。
      assert.equal(press('F9'), 'passed on')
      assert.equal(press('F8', { metaKey: true }), 'passed on')
      assert.equal(press('s', { metaKey: true }), 'passed on')

      // 在设置里改了键位：照改过的来。
      const rebound = createWorkbenchDebugShortcutKeydownHandler(
        () => ({ ...DEFAULT_WORKBENCH_KEYBOARD_SHORTCUT_MAP, 'debug-continue': 'F9' }),
        Mac
      )
      const f9 = keydown('F9')
      rebound(f9.event)
      const f8 = keydown('F8')
      rebound(f8.event)
      assert.deepEqual([f9.state.prevented, f8.state.prevented], [true, false])
      assert.equal(ran.at(-1), 'continue')
    } finally {
      installWorkbenchDebugActionRunner(null)
      publishWorkbenchDebugStatus('idle')
    }
  })

  void test('the global shortcut handler leaves them alone', () => {
    const calls: string[] = []
    const options = new Proxy(
      { enabled: true, isQuickOpenOpen: false, activeRightTool: null, platform: Mac },
      {
        get: (target, property: string) =>
          property in target
            ? target[property as keyof typeof target]
            : property === 'keymap'
              ? undefined
              : () => calls.push(property),
      }
    ) as unknown as UseWorkbenchKeyboardShortcutsOptions
    const handle = createWorkbenchShortcutKeydownHandler(() => options)

    for (const [key, shiftKey] of [
      ['F8', false],
      ['F10', false],
      ['F11', false],
      ['F11', true],
      ['F5', true],
    ] as const) {
      const { event, state } = keydown(key, { shiftKey })
      handle(event)
      // 不拦：没在调试时这些键照常归编辑器、菜单和系统。
      assert.equal(state.prevented, false, key)
    }
    assert.deepEqual(calls, [])
  })
})

/** 一个喂得了事件的调试会话（主进程那头是假的）。 */
function createSession(): {
  session: InstanceType<typeof WorkbenchDebugSessionController>
  emit: (event: WorkbenchDebuggerEvent) => void
} {
  let listener: (event: WorkbenchDebuggerEvent) => void = () => undefined
  const bridge = {
    start: async () => ({
      ok: true,
      value: { sessionId: 'debug-1', terminalSessionId: 'terminal-1', command: 'node a.js', cwd: '/p', shell: 'sh' },
    }),
    onEvent: (next: (event: WorkbenchDebuggerEvent) => void) => {
      listener = next
      return () => undefined
    },
  } as unknown as WorkbenchDebuggerBridge
  const session = new WorkbenchDebugSessionController({
    debuggerBridge: () => bridge,
    readBreakpoints: () => [],
    readExceptionPause: () => true,
    subscribeBreakpoints: () => () => undefined,
    publishStatus: () => undefined,
    revealLocation: () => undefined,
    openPanel: () => undefined,
  })
  return { session, emit: (event) => listener(event) }
}

function renderPanel(session: InstanceType<typeof WorkbenchDebugSessionController>): string {
  return renderToStaticMarkup(
    createElement(WorkbenchLocalizationProvider, {
      value: {
        locale: 'zh-CN',
        setLocale: async () => undefined,
        t: (key, params) => (params ? `${key}${JSON.stringify(params)}` : key),
      },
      children: createElement(WorkbenchDebugPanel, {
        projectRoot: '/p',
        session,
        shortcutHints: { continue: 'F8', 'step-over': 'F10', stop: '⇧F5' },
      }),
    })
  )
}

/** 面板上某个按钮（按它的标签找）是不是禁用的。 */
function isDisabled(html: string, label: string): boolean {
  const button = new RegExp(`<button[^>]*aria-label="${label}[^"]*"[^>]*>`, 'u').exec(html)
  assert.ok(button, `${label} button should be rendered`)
  return /\sdisabled(?:=""|\s|>)/u.test(button[0])
}

void describe('debug panel', () => {
  void test('says nothing is being debugged and offers no controls', () => {
    const html = renderPanel(createSession().session)
    assert.match(html, /workbench\.debuggerIdle</u)
    assert.match(html, /workbench\.debuggerIdleHint/u)
    for (const label of [
      'workbench.debuggerContinue',
      'workbench.debuggerStepOver',
      'workbench.debuggerStepInto',
      'workbench.debuggerStepOut',
      'workbench.debuggerStop',
    ])
      assert.equal(isDisabled(html, label), true, label)
    // 按钮上写着此刻的快捷键。
    assert.match(html, /aria-label="workbench\.debuggerContinue \(F8\)"/u)
    assert.match(html, /aria-label="workbench\.debuggerStop \(⇧F5\)"/u)
    // 没有在调试：表达式框不能用；「未捕获的异常时暂停」随时能改。
    assert.match(html, /<input[^>]*disabled=""[^>]*placeholder="workbench\.debuggerExpressionPlaceholder"/u)
    assert.match(html, /workbench\.debuggerPauseOnUncaughtExceptions/u)
  })

  void test('while the program runs it can be paused or stopped', async () => {
    const { session } = createSession()
    await session.start({ projectRoot: '/p', target: { kind: 'node-script', script: 'a.js' } })
    const html = renderPanel(session)
    assert.match(html, /workbench\.debuggerRunning</u)
    assert.match(html, /workbench\.debuggerRunningHint/u)
    // 「继续」的位置换成「暂停」。
    assert.equal(isDisabled(html, 'workbench.debuggerPause'), false)
    assert.doesNotMatch(html, /aria-label="workbench\.debuggerContinue/u)
    assert.equal(isDisabled(html, 'workbench.debuggerStepOver'), true)
    assert.equal(isDisabled(html, 'workbench.debuggerStop'), false)
  })

  void test('while paused it lists the call stack, the scopes of the selected frame and what stopped it', async () => {
    const { session, emit } = createSession()
    await session.start({ projectRoot: '/p', target: { kind: 'node-script', script: 'a.js' } })
    emit({
      type: 'paused',
      sessionId: 'debug-1',
      reason: 'exception',
      exception: { type: 'object', text: 'TypeError: x is not a function', objectId: 'e' },
      frames: [
        {
          id: 'f0',
          functionName: 'emit',
          location: { path: null, source: 'node:events', line: 519, column: 28 },
          scopes: [{ type: 'local', name: null, objectId: 's0' }],
        },
        {
          id: 'f1',
          functionName: 'handle',
          location: { path: 'src/server.ts', source: '/p/src/server.ts', line: 42, column: 5 },
          scopes: [
            { type: 'local', name: null, objectId: 's1' },
            { type: 'closure', name: 'createServer', objectId: 's2' },
            { type: 'global', name: null, objectId: 's3' },
          ],
        },
        {
          id: 'f2',
          functionName: '',
          location: { path: 'src/main.ts', source: '/p/src/main.ts', line: 7, column: 1 },
          scopes: [],
        },
      ],
    })
    const html = renderPanel(session)
    assert.match(html, /workbench\.debuggerPausedException</u)
    assert.match(html, />TypeError: x is not a function</u)
    // 调用栈：函数名 + 文件名:行；匿名函数有个说法；项目之外的那一帧标了出来（画得淡）。
    assert.match(html, /data-active="false" data-external="true"[^>]*>.*?>emit<.*?>node:events:519</su)
    // 选中的是最靠里的、项目里有文件的那一帧。
    assert.match(html, /data-active="true" data-external="false"[^>]*>.*?>handle<.*?>server\.ts:42</su)
    assert.match(html, />workbench\.debuggerAnonymousFunction<.*?>main\.ts:7</su)
    // 变量按选中那一帧的作用域分组。
    assert.match(html, /workbench\.debuggerScopeLocal/u)
    assert.match(html, /workbench\.debuggerScopeClosureNamed\{&quot;name&quot;:&quot;createServer&quot;\}/u)
    assert.match(html, /workbench\.debuggerScopeGlobal/u)
    // 停着：继续与单步都能按。
    for (const label of ['workbench.debuggerContinue', 'workbench.debuggerStepInto', 'workbench.debuggerStop'])
      assert.equal(isDisabled(html, label), false, label)

    // 结束之后说一句是怎么结束的。
    emit({ type: 'ended', sessionId: 'debug-1', reason: 'exited', exitCode: 1, message: null })
    assert.match(renderPanel(session), /workbench\.debuggerEndedExited\{&quot;code&quot;:1\}/u)
  })
})

void describe('wiring of the debugger into the workspace', () => {
  void test('the session, the breakpoints and the panel stay out of the workspace shell chunk', () => {
    // 外壳里只有桥、快捷键和按钮；会话、断点存储、面板、编辑器里的扩展都按需加载。
    for (const shellModule of [
      'src/renderer/src/models/debug/workbenchDebugBridge.ts',
      'src/renderer/src/hooks/useWorkbenchDebugShortcuts.ts',
      'src/renderer/src/hooks/useWorkbenchCommandController.ts',
      'src/renderer/src/hooks/useWorkbenchCommandPalette.ts',
      'src/renderer/src/hooks/useWorkbenchTopRunControl.ts',
      'src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx',
      'src/renderer/src/models/layout/workbenchCommandPalette.ts',
      'src/renderer/src/components/chrome/TopToolbar.tsx',
      'src/renderer/src/components/terminal/CommandPanel.tsx',
      'src/renderer/src/app/StandaloneWorkbenchPagePresentation.tsx',
    ])
      assert.doesNotMatch(
        readSource(shellModule),
        /from '[^']*(?:workbenchDebugSession|workbenchBreakpoints|WorkbenchDebugPanel|workbenchBreakpointGutter|workbenchDebugHover|workbenchDebugPausedLine)'/u,
        shellModule
      )
    // 起调试时才去加载会话那一包。
    assert.match(
      readSource('src/renderer/src/models/debug/workbenchDebugBridge.ts'),
      /const \{ startWorkbenchDebugSession \} = await import\('\.\/workbenchDebugSession'\)/u
    )
    assert.match(
      readSource('src/renderer/src/app/StandaloneWorkbenchPagePresentation.tsx'),
      /const LazyWorkbenchDebugPanel = lazyWithPreload\(\s+async \(\) => \(await import\('\.\.\/components\/WorkbenchDebugPanel'\)\)\.WorkbenchDebugPanel/u
    )
  })

  void test('a pause brings its location to the front and opens the panel; keys are handled before the editor', () => {
    const pageModel = readSource('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx')
    // 还没开着的文件开成预览标签（已经开着的在它所在的那组里切过去）。
    assert.match(
      pageModel,
      /revealLocation: \(location\) => void navigate\(\{ target: 'file', \.\.\.location, preview: true \}\)/u
    )
    assert.match(pageModel, /openPanel: \(\) => openBottomToolLatest\.current\('debug'\)/u)
    // 调试之前先存盘：断点的行号要与磁盘上的文件对得上。
    assert.match(pageModel, /launch\?\.debug \? launchRunSessionFromEditor : workbench\.launchRunSession/u)

    // 捕获阶段：停着的时候 F8 先归调试器，轮不到编辑器里的「下一个问题」。
    assert.match(
      readSource('src/renderer/src/hooks/useWorkbenchDebugShortcuts.ts'),
      /window\.addEventListener\('keydown', handleKeydown, true\)/u
    )
  })

  void test('the editor takes breakpoints, the paused line and hover values through its run/debug compartment', () => {
    const hook = readSource('src/renderer/src/hooks/useWorkbenchEditorRunDebug.ts')
    assert.match(hook, /createWorkbenchBreakpointGutterExtension\(\{/u)
    assert.match(hook, /createWorkbenchDebugPausedLineExtension\(\{/u)
    assert.match(hook, /createWorkbenchDebugHoverExtension\(\{/u)
    // 悬停求值不许有副作用。
    assert.match(hook, /session\.evaluate\(expression, \{ sideEffectFree: true \}\)/u)
    // 只给 JS / TS 文件。
    assert.match(hook, /if \(!path \|\| disabled \|\| !isWorkbenchDebuggableFilePath\(path\)\) return \[\]/u)
    // 行号上的点击让给断点。
    assert.match(
      readSource('src/renderer/src/models/editor/workbenchCodeMirrorLineNumberSelection.ts'),
      /\.facet\(workbenchLineNumberClickFacet\)\s+\.some\(\(handler\) => handler\(view, lineNumber\)\)/u
    )
  })
})
