/**
 * Vim 键位方案：模式编辑那一层怎么加载、按键归 Vim 还是归工作台、`:w` / `:q` / `:wq` / `:wa` 落到哪、模式怎么报给
 * 状态栏。真正的编辑行为是 `@replit/codemirror-vim` 的，这里钉的是接进工作台的那一层，以及它对那个包的几处假设。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'

import { describe, test } from 'bun:test'

import {
  focusWorkbenchEditorVimMode,
  formatWorkbenchEditorVimMode,
  getWorkbenchEditorVimModeSnapshot,
  resolveWorkbenchEditorVimMode,
  setWorkbenchEditorVimMode,
  subscribeWorkbenchEditorVimMode,
  type WorkbenchEditorVimMode,
} from '../src/renderer/src/models/editor/workbenchEditorVim'
import {
  shouldWorkbenchVimHandleKey,
  WorkbenchVimInsertModeKeys,
  type WorkbenchVimKeyContext,
  WorkbenchVimNormalModeIdleKey,
  WorkbenchVimNormalModeKeys,
} from '../src/renderer/src/models/editor/workbenchEditorVimKeys'
import {
  installWorkbenchVimExCommands,
  installWorkbenchVimKeyOwnership,
  type WorkbenchEditorVimHost,
  WorkbenchVimExCommands,
} from '../src/renderer/src/models/editor/workbenchEditorVimLayer'
import {
  getWorkbenchKeymapPresetShortcuts,
  resolveWorkbenchKeyboardShortcutMap,
  type WorkbenchKeyboardShortcutMap,
} from '../src/renderer/src/models/layout/workbenchKeyboardShortcuts'

import {
  keymapTestEventFor,
  type KeymapTestKeyEvent,
  type KeymapTestPlatform,
  KeymapTestPlatforms,
} from './helpers/workbenchKeymapChords'

const Mac = 'MacIntel'
const Windows = 'Win32'
const Linux = 'Linux x86_64'

function readSource(path: string): string {
  return readFileSync(resolvePath(process.cwd(), path), 'utf8')
}

/** 目录下全部源码文件（相对仓库根）。 */
function listSourceFiles(directory: string): string[] {
  return readdirSync(resolvePath(process.cwd(), directory), { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return listSourceFiles(path)
    return /\.tsx?$/u.test(entry.name) ? [path] : []
  })
}

/** 去掉注释的源码：钉「代码里有没有这一句」时不被注释里的说明骗到。 */
function readCode(path: string): string {
  return readSource(path).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gmu, '')
}

const vimPackage = await import('@replit/codemirror-vim')
const vimCore = readSource('node_modules/@replit/codemirror-vim-core/vim.js')
const vimAdapter = readSource('node_modules/@replit/codemirror-vim/dist/index.js')

void describe('vim: what the layer assumes about the package', () => {
  /** 包的默认键位表里带 Ctrl 的键：第一键、类型、限定的模式。 */
  const ctrlEntries = [
    ...vimCore.matchAll(/^\s*\{ keys: '(<C-[^>]+>)[^']*', type: '(\w+)'([^\n]*)\},?[^\n]*$/gmu),
  ].map(([, key, type, rest]) => ({
    key: key!,
    type: type!,
    context: /context: '(\w+)'/u.exec(rest!)?.[1] ?? null,
  }))

  void test('the keys Vim has a command for are the ones the key table lists', () => {
    assert.ok(ctrlEntries.length >= 30, 'the default keymap of the package was not found')
    // 限定模式的只有 normal 与 insert：可视模式用的是不限模式的那些（所以普通、可视共用一张表）。
    assert.deepEqual([...new Set(ctrlEntries.map((entry) => entry.context))].sort(), [
      'insert',
      'normal',
      null,
    ])

    const normal = ctrlEntries.filter((entry) => entry.context !== 'insert' && entry.type !== 'idle')
    assert.deepEqual(
      [...new Set(normal.map((entry) => entry.key))].sort(),
      [...WorkbenchVimNormalModeKeys].sort()
    )
    const insert = ctrlEntries.filter((entry) => entry.context === 'insert')
    assert.deepEqual(
      [...new Set(insert.map((entry) => entry.key))].sort(),
      [...WorkbenchVimInsertModeKeys].sort()
    )
    // 吞掉不做事的只有普通模式的 Ctrl+W。
    assert.deepEqual(
      ctrlEntries.filter((entry) => entry.type === 'idle'),
      [{ key: WorkbenchVimNormalModeIdleKey, type: 'idle', context: 'normal' }]
    )
    // 表里没有带 Alt / ⌘ 的键：那些都不归 Vim。
    assert.doesNotMatch(vimCore, /\{ keys: '<(?:[CS]-)*[AMD]-/u)
  })

  void test('the package asks Vim.vimKeyFromEvent for the key and drops a key without a name', () => {
    assert.match(
      vimAdapter,
      /const key = Vim\.vimKeyFromEvent\(e, vim\);\s*CodeMirror\.signal\(this\.cm, 'inputEvent', \{ type: "handleKey", key \}\);\s*if \(!key\)\s*return;/u
    )
    // 用掉的键不再往下传：后面的按键处理收不到（所以归属要在这一步定）。
    assert.match(vimAdapter, /if \(result\) \{[\s\S]{0,120}e\.preventDefault\(\);\s*e\.stopPropagation\(\);/u)
    // 普通模式里没用到的单个字符、macOS 上没用到的 ⌥+字符会被吞掉。
    assert.match(
      vimCore,
      /return !vim\.insertMode && \(key\.length === 1 \|\| \(CM\.isMac && \/<A-\.>\/\.test\(key\)\)\)\? function\(\) \{ return true; \} : undefined;/u
    )
  })

  void test('names the keys the way the key table writes them', () => {
    const name = (chord: string): string | undefined =>
      vimPackage.Vim.vimKeyFromEvent(keymapTestEventFor(chord, Windows) as unknown as KeyboardEvent)
    assert.equal(name('Ctrl+D'), '<C-d>')
    assert.equal(name('Ctrl+['), '<C-[>')
    assert.equal(name('Ctrl+Space'), '<C-Space>')
    assert.equal(name('Ctrl+Backspace'), '<C-BS>')
    assert.equal(name('Ctrl+Escape'), '<C-Esc>')
    assert.equal(name('Ctrl+W'), '<C-w>')
    assert.equal(name('Ctrl+Shift+P'), '<C-S-P>')
    assert.equal(name('Escape'), '<Esc>')
    assert.equal(name('J'), 'j')
  })

  void test('reports mode changes, and closes its prompt through the state the layer resets', () => {
    // 模式：`vim-mode-change` 带着 mode 与 subMode。
    assert.match(vimCore, /CM\.signal\(cm, "vim-mode-change", \{mode: "visual", subMode: /u)
    assert.match(vimCore, /CM\.signal\(cm, "vim-mode-change", \{mode: "insert"\}\)/u)
    assert.match(vimCore, /CM\.signal\(cm, "vim-mode-change", \{mode: "normal"\}\)/u)
    // 提示条开合：没有状态条时改视图的状态，有状态条时只改状态条——换文件时靠这两条收掉旧的。
    assert.match(
      vimAdapter,
      /this\.cm\.on\("dialog", \(\) => \{\s*if \(this\.cm\.state\.statusbar\) \{\s*this\.updateStatus\(\);\s*\}\s*else \{\s*view\.dispatch\(\{\s*effects: showVimPanel\.of\(!!this\.cm\.state\.dialog\),\s*\}\);\s*\}\s*\}\);/u
    )
    assert.match(vimAdapter, /cm\.state\.currentNotificationClose = newVal;/u)
    assert.match(vimAdapter, /dom\.className = "cm-vim-panel";/u)
    assert.match(vimAdapter, /"cm-fat-cursor cm-cursor-primary"/u)
    assert.match(vimAdapter, /this\.cursorLayer\.className = "cm-cursorLayer cm-vimCursorLayer";/u)
    // 只读的文件：包自己不改正文、不进插入模式。
    assert.match(vimAdapter, /function dispatchChange\(cm, transaction\) \{\s*var view = cm\.cm6;\s*if \(view\.state\.readOnly\)\s*return;/u)
  })
})

void describe('vim: who gets a key', () => {
  const VimKeymap: Record<KeymapTestPlatform, WorkbenchKeyboardShortcutMap> = {
    [Mac]: getWorkbenchKeymapPresetShortcuts('vim', Mac),
    [Windows]: getWorkbenchKeymapPresetShortcuts('vim', Windows),
    [Linux]: getWorkbenchKeymapPresetShortcuts('vim', Linux),
  }

  /** 包给这次按键起的名字，再经工作台那一层：归 Vim 返回名字，不归返回 undefined。 */
  function owner(
    chord: string | KeymapTestKeyEvent,
    platform: KeymapTestPlatform,
    context: WorkbenchVimKeyContext,
    keymap: WorkbenchKeyboardShortcutMap = VimKeymap[platform]
  ): 'vim' | 'workbench' {
    const event = typeof chord === 'string' ? keymapTestEventFor(chord, platform) : chord
    const vimKey = vimPackage.Vim.vimKeyFromEvent(event as unknown as KeyboardEvent)
    assert.ok(vimKey, `the package gave no name to ${JSON.stringify(chord)}`)
    return shouldWorkbenchVimHandleKey({ vimKey, event, context, keymap, platform })
      ? 'vim'
      : 'workbench'
  }

  const NonApple = [Windows, Linux] as const
  const Contexts = ['normal', 'visual', 'insert'] as const

  void test('keys without Ctrl, Alt or the command key always go to Vim', () => {
    for (const platform of KeymapTestPlatforms)
      for (const context of Contexts)
        for (const chord of ['J', 'Shift+G', 'Escape', 'Enter', 'Tab', 'ArrowDown', 'Backspace', 'Shift+;', 'F8', 'Shift+F12'])
          assert.equal(owner(chord, platform, context), 'vim', `${platform} ${context} ${chord}`)
  })

  void test('Windows and Linux, normal and visual mode: Vim takes the Ctrl keys it has a command for', () => {
    for (const platform of NonApple)
      for (const context of ['normal', 'visual'] as const) {
        for (const chord of [
          'Ctrl+A', // 工作台：全选
          'Ctrl+B',
          'Ctrl+C', // 复制
          'Ctrl+D', // 选中下一处相同的文字
          'Ctrl+E',
          'Ctrl+F', // 查找
          'Ctrl+I', // 触发补全
          'Ctrl+N',
          'Ctrl+O', // 菜单：打开项目
          'Ctrl+Q',
          'Ctrl+R', // 菜单：重新加载
          'Ctrl+U', // 撤销选区变化
          'Ctrl+V', // 粘贴
          'Ctrl+X', // 剪切
          'Ctrl+Y', // 重做
          'Ctrl+[', // 减少缩进
          'Ctrl+Space', // 触发补全
          'Ctrl+Backspace',
        ])
          assert.equal(owner(chord, platform, context), 'vim', `${platform} ${context} ${chord}`)

        // 全局快捷键表上的键照常：默认键里与 Vim 撞的只有 Ctrl+P。
        for (const chord of ['Ctrl+P', 'Ctrl+Shift+P', 'Ctrl+Shift+F', 'Ctrl+S', 'Ctrl+Shift+S', 'Ctrl+\\', 'Ctrl+1', 'Alt+ArrowLeft', 'Ctrl+Enter'])
          assert.equal(owner(chord, platform, context), 'workbench', `${platform} ${context} ${chord}`)
        // Vim 没有命令的编辑器命令照常。
        for (const chord of ['Ctrl+G', 'Ctrl+L', 'Ctrl+H', 'Ctrl+Z', 'Ctrl+/', 'Ctrl+]', 'Ctrl+M', 'Ctrl+Shift+K', 'Ctrl+Alt+L', 'Alt+Z', 'Alt+Enter', 'Shift+Alt+ArrowDown', 'Alt+ArrowUp'])
          assert.equal(owner(chord, platform, context), 'workbench', `${platform} ${context} ${chord}`)
        // Ctrl+W：这里没有窗口命令，放给应用菜单的「关闭编辑器」。
        assert.equal(owner('Ctrl+W', platform, context), 'workbench', `${platform} ${context} Ctrl+W`)
      }
  })

  void test('Windows and Linux, insert mode: only the Vim insert keys go to Vim', () => {
    for (const platform of NonApple) {
      for (const chord of ['Ctrl+C', 'Ctrl+D', 'Ctrl+O', 'Ctrl+R', 'Ctrl+T', 'Ctrl+U', 'Ctrl+W', 'Ctrl+['])
        assert.equal(owner(chord, platform, 'insert'), 'vim', `${platform} insert ${chord}`)
      // 别的照常：全局快捷键，和 Vim 在插入模式里不用的编辑器命令。
      for (const chord of ['Ctrl+P', 'Ctrl+S', 'Ctrl+F', 'Ctrl+I', 'Ctrl+Space', 'Ctrl+Y', 'Ctrl+Z', 'Ctrl+G', 'Ctrl+/', 'Ctrl+]', 'Alt+Z'])
        assert.equal(owner(chord, platform, 'insert'), 'workbench', `${platform} insert ${chord}`)
      // 不是编辑器命令、Vim 也不用的键留给 Vim 看（它不认就原样放过去：全选、粘贴照常）。
      for (const chord of ['Ctrl+A', 'Ctrl+V', 'Ctrl+X'])
        assert.equal(owner(chord, platform, 'insert'), 'vim', `${platform} insert ${chord}`)
    }
  })

  void test('macOS: the command keys stay with the workbench, the Ctrl keys with Vim', () => {
    for (const context of Contexts) {
      // ⌘ 键 Vim 都不用：是全局快捷键、编辑器命令的放行，其余给 Vim 看（它不认，原样放过去）。
      for (const chord of ['Mod+P', 'Mod+Shift+P', 'Mod+S', 'Mod+F', 'Mod+D', 'Mod+/', 'Mod+Z', 'Mod+Enter', 'Mod+Alt+L'])
        assert.equal(owner(chord, Mac, context), 'workbench', `${context} ${chord}`)
      // 工作台在 macOS 上用 Control 的那几个：全局的后退 / 前进、跳到行、调用层次。
      for (const chord of ['Ctrl+Minus', 'Ctrl+Shift+Minus', 'Ctrl+G', 'Ctrl+Alt+H', 'Ctrl+L'])
        assert.equal(owner(chord, Mac, context), 'workbench', `${context} ${chord}`)
    }
    for (const context of ['normal', 'visual'] as const) {
      for (const chord of ['Ctrl+D', 'Ctrl+F', 'Ctrl+B', 'Ctrl+U', 'Ctrl+R', 'Ctrl+V', 'Ctrl+O', 'Ctrl+I', 'Ctrl+A', 'Ctrl+[', 'Ctrl+Space'])
        assert.equal(owner(chord, Mac, context), 'vim', `${context} ${chord}`)
      // ⌃T 是重构；普通模式、可视模式里 Vim 不用它。
      assert.equal(owner('Ctrl+T', Mac, context), 'workbench')
      // ⌃W 不是 macOS 菜单的键：留给 Vim（普通模式里它什么也不做）。
      assert.equal(owner('Ctrl+W', Mac, context), 'vim')
    }
    // 插入模式：⌃T 是 Vim 的缩进，⌃Space 触发补全。
    assert.equal(owner('Ctrl+T', Mac, 'insert'), 'vim')
    assert.equal(owner('Ctrl+W', Mac, 'insert'), 'vim')
    assert.equal(owner('Ctrl+Space', Mac, 'insert'), 'workbench')
  })

  void test('macOS: Option keys that are editor commands are not swallowed by normal mode', () => {
    for (const context of Contexts) {
      // ⌥Z 自动换行、⇧⌥A 块注释、⇧⌥M Tab 键移动焦点、⇧⌥O 整理 import、⌥↩ 快速修复、⌥↑ 上移行。
      for (const chord of ['Alt+Z', 'Shift+Alt+A', 'Shift+Alt+M', 'Shift+Alt+O', 'Alt+Enter', 'Alt+ArrowUp', 'Shift+Alt+ArrowDown', 'Alt+F7'])
        assert.equal(owner(chord, Mac, context), 'workbench', `${context} ${chord}`)
      // 不是编辑器命令的 ⌥+字符仍归 Vim：普通模式里吞掉（不打出字符），插入模式里照常打字。
      for (const chord of ['Alt+Q', 'Alt+8', 'Shift+Alt+K'])
        assert.equal(owner(chord, Mac, context), 'vim', `${context} ${chord}`)
    }
  })

  void test('a key the user recorded for an app-wide action wins over Vim in every mode', () => {
    for (const platform of KeymapTestPlatforms) {
      const keymap = resolveWorkbenchKeyboardShortcutMap(
        { preset: 'vim', overrides: { 'toggle-problems': 'Ctrl+D', 'quick-open': 'Ctrl+E' } },
        platform
      )
      for (const context of Contexts) {
        assert.equal(owner('Ctrl+D', platform, context, keymap), 'workbench')
        assert.equal(owner('Ctrl+E', platform, context, keymap), 'workbench')
      }
      // 腾出来的 Ctrl+P（Windows / Linux 上原来的快速打开）回到 Vim 手里。
      if (platform !== Mac) assert.equal(owner('Ctrl+P', platform, 'normal', keymap), 'vim')
    }
    // 不带修饰键的全局快捷键（Esc 关右侧面板）不抢 Vim 的键。
    for (const platform of KeymapTestPlatforms) assert.equal(owner('Escape', platform, 'normal'), 'vim')
  })

  void test('the layer decides inside Vim.vimKeyFromEvent, and leaves prompt keys alone', () => {
    const seen: string[] = []
    const vim = {
      vimKeyFromEvent: (event: KeymapTestKeyEvent, state?: { insertMode?: boolean; visualMode?: boolean }) => {
        seen.push(`${event.key}:${state ? 'editor' : 'prompt'}`)
        return vimPackage.Vim.vimKeyFromEvent(event as unknown as KeyboardEvent)
      },
    }
    let keymap = VimKeymap[Windows]
    installWorkbenchVimKeyOwnership(vim, () => keymap, () => Windows)

    const press = (chord: string, state?: { insertMode?: boolean; visualMode?: boolean }) =>
      vim.vimKeyFromEvent(keymapTestEventFor(chord, Windows), state)
    assert.equal(press('Ctrl+D', {}), '<C-d>')
    assert.equal(press('Ctrl+P', {}), undefined)
    assert.equal(press('Ctrl+W', {}), undefined)
    assert.equal(press('Ctrl+W', { visualMode: true }), undefined)
    assert.equal(press('Ctrl+W', { insertMode: true }), '<C-w>')
    assert.equal(press('Ctrl+F', {}), '<C-f>')
    assert.equal(press('Ctrl+F', { insertMode: true }), undefined)
    assert.equal(press('J', {}), 'j')
    // 包认不出名字的键（只按了修饰键）原样是空。
    assert.equal(
      vim.vimKeyFromEvent({ key: 'Control', code: 'ControlLeft', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false }, {}),
      undefined
    )
    // 没有编辑器状态的调用不归这一层管。
    assert.equal(press('Ctrl+P'), '<C-p>')
    // 用的是此刻的键位：设置改了马上跟上。
    keymap = resolveWorkbenchKeyboardShortcutMap({ preset: 'vim', overrides: { 'quick-open': 'Ctrl+E' } }, Windows)
    assert.equal(press('Ctrl+P', {}), '<C-p>')
    assert.equal(press('Ctrl+E', {}), undefined)
    assert.ok(seen.includes('d:editor') && seen.includes('p:prompt'))
  })
})

void describe('vim: ex commands', () => {
  /** 包的 ex 命令执行时要的那一点编辑器；`cm6` 是命令落到的那个视图。 */
  function fakeEditor(view: object) {
    return {
      cm6: view,
      curOp: null as unknown,
      state: { vim: { visualMode: false, insertMode: false } },
      operation(run: () => unknown) {
        this.curOp = {}
        try {
          return run()
        } finally {
          this.curOp = null
        }
      },
      getCursor: () => ({ line: 0, ch: 0 }),
      firstLine: () => 0,
      lastLine: () => 0,
    }
  }

  void test(':w, :q, :wq and :wa reach the editor they were typed in', () => {
    assert.deepEqual(
      WorkbenchVimExCommands.map((command) => `${command.prefix} ${command.name} ${command.run}`),
      ['w write save', 'q quit quit', 'wq wq saveAndQuit', 'wa wall saveAll']
    )

    const calls: string[] = []
    const hosts = new Map<object, WorkbenchEditorVimHost>()
    const hostFor = (label: string): object => {
      const view = { label }
      hosts.set(view, {
        save: (target) => calls.push(`${label}:save:${target === (view as unknown)}`),
        quit: () => calls.push(`${label}:quit`),
        saveAndQuit: () => calls.push(`${label}:saveAndQuit`),
        saveAll: () => calls.push(`${label}:saveAll`),
      })
      return view
    }
    const left = hostFor('left')
    const right = hostFor('right')
    installWorkbenchVimExCommands(vimPackage.Vim, (view) => hosts.get(view) ?? null)

    const run = (view: object, input: string): string[] => {
      calls.length = 0
      vimPackage.Vim.handleEx(fakeEditor(view) as never, input)
      return [...calls]
    }
    assert.deepEqual(run(left, 'w'), ['left:save:true'])
    assert.deepEqual(run(left, 'write'), ['left:save:true'])
    assert.deepEqual(run(right, 'q'), ['right:quit'])
    assert.deepEqual(run(right, 'quit'), ['right:quit'])
    assert.deepEqual(run(left, 'wq'), ['left:saveAndQuit'])
    assert.deepEqual(run(right, 'wa'), ['right:saveAll'])
    assert.deepEqual(run(right, 'wall'), ['right:saveAll'])
    // `!`、文件名这些多出来的部分不看：`:q!` 与 `:q` 一样走平常的关闭。
    assert.deepEqual(run(left, 'q!'), ['left:quit'])
    assert.deepEqual(run(left, 'wq!'), ['left:saveAndQuit'])
    assert.deepEqual(run(left, 'w other.ts'), ['left:save:true'])
    // 没有宿主的编辑器（命令不起作用）不报错。
    assert.deepEqual(run({ label: 'orphan' }, 'w'), [])
  })

  void test('commands that were not defined stay unknown', () => {
    const calls: string[] = []
    installWorkbenchVimExCommands(vimPackage.Vim, () => ({
      save: () => calls.push('save'),
      quit: () => calls.push('quit'),
      saveAndQuit: () => calls.push('saveAndQuit'),
      saveAll: () => calls.push('saveAll'),
    }))
    // 不认识的命令包会去提示「Not an editor command」——这里没有界面，提示那一步抛错；要紧的是没有误触发。
    for (const input of ['x', 'wqa', 'qa', 'wn', 'e', 'bd']) {
      assert.throws(() => vimPackage.Vim.handleEx(fakeEditor({}) as never, input), undefined, input)
      assert.deepEqual(calls, [], input)
    }
  })
})

void describe('vim: the mode in the status bar', () => {
  void test('maps what the package reports to the modes shown', () => {
    const cases: Array<[unknown, unknown, WorkbenchEditorVimMode, string]> = [
      ['normal', undefined, 'normal', 'NORMAL'],
      ['insert', undefined, 'insert', 'INSERT'],
      ['replace', undefined, 'replace', 'REPLACE'],
      ['visual', '', 'visual', 'VISUAL'],
      ['visual', 'linewise', 'visual-line', 'VISUAL LINE'],
      ['visual', 'blockwise', 'visual-block', 'VISUAL BLOCK'],
      [undefined, undefined, 'normal', 'NORMAL'],
      ['something-new', 'linewise', 'normal', 'NORMAL'],
    ]
    for (const [mode, subMode, expected, label] of cases) {
      assert.equal(resolveWorkbenchEditorVimMode(mode, subMode), expected)
      assert.equal(formatWorkbenchEditorVimMode(expected), label)
    }
  })

  void test('shows the editor that had focus last, and nothing once no editor runs Vim', async () => {
    const settle = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve))
    const left = {}
    const right = {}
    let notifications = 0
    const unsubscribe = subscribeWorkbenchEditorVimMode(() => {
      notifications += 1
    })
    assert.equal(getWorkbenchEditorVimModeSnapshot(), null)

    setWorkbenchEditorVimMode(left, 'normal')
    assert.equal(getWorkbenchEditorVimModeSnapshot(), 'normal')
    setWorkbenchEditorVimMode(right, 'insert')
    // 还没有谁得过焦点：最近报过模式的那个。
    assert.equal(getWorkbenchEditorVimModeSnapshot(), 'insert')
    focusWorkbenchEditorVimMode(left)
    assert.equal(getWorkbenchEditorVimModeSnapshot(), 'normal')
    setWorkbenchEditorVimMode(right, 'visual-line')
    assert.equal(getWorkbenchEditorVimModeSnapshot(), 'normal')
    setWorkbenchEditorVimMode(left, 'visual')
    assert.equal(getWorkbenchEditorVimModeSnapshot(), 'visual')
    await settle()
    // 连着的几次变化合成一次通知。
    assert.equal(notifications, 1)

    // 换文件：编辑器先撤掉 Vim、紧接着又建一个——订阅者看不到这一下来回。
    setWorkbenchEditorVimMode(left, null)
    assert.equal(getWorkbenchEditorVimModeSnapshot(), 'visual-line')
    setWorkbenchEditorVimMode(left, 'normal')
    setWorkbenchEditorVimMode(left, 'visual')
    await settle()
    assert.equal(notifications, 1)

    // 有焦点的那个不用 Vim 了：退到另一个；都不用了就没有。
    setWorkbenchEditorVimMode(left, null)
    await settle()
    assert.equal(getWorkbenchEditorVimModeSnapshot(), 'visual-line')
    assert.equal(notifications, 2)
    setWorkbenchEditorVimMode(right, null)
    await settle()
    assert.equal(getWorkbenchEditorVimModeSnapshot(), null)
    assert.equal(notifications, 3)
    unsubscribe()
  })
})

void describe('vim: loaded only for the Vim preset, only in the file editor', () => {
  const sources = listSourceFiles('src')

  void test('the package is only ever imported dynamically', () => {
    const importers = sources.filter((path) => readCode(path).includes('@replit/codemirror-vim'))
    assert.deepEqual(importers, ['src/renderer/src/models/editor/workbenchEditorVimLayer.ts'])

    const layer = readCode('src/renderer/src/models/editor/workbenchEditorVimLayer.ts')
    const mentions = [...layer.matchAll(/^.*@replit\/codemirror-vim.*$/gmu)].map((match) => match[0].trim())
    assert.deepEqual(mentions, [
      "type VimPackage = typeof import('@replit/codemirror-vim')",
      "layer ??= import('@replit/codemirror-vim')",
    ])
    // 没有哪个文件用 import … from / require 引它。
    for (const path of sources)
      assert.doesNotMatch(
        readCode(path),
        /from\s+['"]@replit\/codemirror-vim|require\(\s*['"]@replit\/codemirror-vim/u,
        path
      )
  })

  void test('the layer itself is loaded on demand, from the hook the editor uses', () => {
    const hook = 'src/renderer/src/hooks/useWorkbenchEditorVim.ts'
    const importers = sources.filter(
      (path) =>
        /workbenchEditorVimLayer['"]/u.test(readCode(path))
        && path !== 'src/renderer/src/models/editor/workbenchEditorVimLayer.ts'
    )
    assert.deepEqual(importers, [hook])
    const code = readCode(hook)
    // 值只经动态 import 拿；静态的只有类型。
    assert.match(code, /void import\('\.\.\/models\/editor\/workbenchEditorVimLayer'\)\s*\.then\(\(module\) => module\.loadWorkbenchEditorVimLayer\(\)\)/u)
    assert.match(code, /import type \{\s*WorkbenchEditorVimHost,\s*WorkbenchEditorVimLayer,\s*\} from '\.\.\/models\/editor\/workbenchEditorVimLayer'/u)
    assert.equal(code.match(/workbenchEditorVimLayer'/gu)?.length, 2)
    // 没选 Vim 方案不加载。
    assert.match(code, /if \(!enabled \|\| layer\) return/u)
    assert.match(code, /enabled && layer\s*\? layer\.extension\(/u)

    // 认按键归属的那部分跟着这一层走，不进编辑器那一块。
    assert.deepEqual(
      sources.filter((path) => /workbenchEditorVimKeys['"]/u.test(readCode(path))),
      ['src/renderer/src/models/editor/workbenchEditorVimLayer.ts']
    )
  })

  void test('only the file editor uses it, and only under the Vim preset', () => {
    assert.deepEqual(
      sources.filter((path) => readCode(path).includes('useWorkbenchEditorVimExtension')),
      [
        'src/renderer/src/components/editor/CodeMirrorEditor.tsx',
        'src/renderer/src/hooks/useWorkbenchEditorVim.ts',
      ]
    )
    const editor = readSource('src/renderer/src/components/editor/CodeMirrorEditor.tsx')
    assert.match(editor, /useWorkbenchEditorVimExtension\(keymapPreset === 'vim', \{/u)
    // Vim 的按键处理排在编辑器所有按键处理之前：这个 compartment 是文件扩展列表的第一项。
    assert.match(
      editor,
      /const buildFileExtensions = [\s\S]*?return \[\s*(?:\/\/[^\n]*\n\s*)*vimCompartment\.of\(current\.vim\),\s*instance\.keymap,/u
    )
    assert.match(editor, /\[vimCompartment, current\.vim\],/u)
    assert.match(editor, /reconfigureCompartment\(viewRef\.current, vimCompartment, vimExtension\)/u)
    // 文件编辑器只有这两处：编辑区，和轻量预览标签。差异、文件历史、提交信息框用的不是它。
    assert.deepEqual(
      sources.filter((path) => /<(?:Lazy)?CodeMirrorEditor\b/u.test(readCode(path))),
      [
        'src/renderer/src/components/editor/EditorPanel.tsx',
        'src/renderer/src/components/editor/WorkbenchLightFilePanel.tsx',
      ]
    )
  })
})

void describe('vim: :w, :q, :wq and :wa in the editor', () => {
  void test(':w is the normal save of the editor; the rest is handed to the page', () => {
    const editor = readSource('src/renderer/src/components/editor/CodeMirrorEditor.tsx')
    // 保存只有一份：⌘S 与 `:w` 走的是同一个函数（保存时格式化、收拾空白都在里面）。
    assert.equal(editor.match(/const saveFromEditor = async \(view: EditorView\): Promise<void> => \{/gu)?.length, 1)
    assert.match(editor, /save: \(view\) => \{\s*void saveFromEditor\(view\)\s*return true\s*\},/u)
    assert.match(editor, /save: \(view\) => void saveFromEditor\(view\),/u)
    assert.match(editor, /quit: \(\) => callbacksRef\.current\.onVimCommand\?\.\('quit'\),/u)
    assert.match(editor, /saveAll: \(\) => callbacksRef\.current\.onVimCommand\?\.\('write-all'\),/u)
    // `:wq`：先走完保存，再报给页面；等保存的时候换了文件就只存不关。
    assert.match(
      editor,
      /saveAndQuit: \(view\) => \{[\s\S]*?const savedPath = pathRef\.current\s*void saveFromEditor\(view\)\.then\(\(\) => \{\s*if \(pathRef\.current === savedPath\) callbacksRef\.current\.onVimCommand\?\.\('write-quit'\)\s*\}\)/u
    )
  })
})
