/**
 * Vim 键位方案里的模式编辑：`@replit/codemirror-vim`，加上把它接进工作台的这一层。
 *
 * 只有选了 Vim 方案才加载：`useWorkbenchEditorVim` 动态 import 这个文件，这个文件再动态 import 那个包——两者
 * 都不进启动时加载的那一块。包只许这样加载（测试钉着），这里对它只有类型引用。
 *
 * 接进来的几件事：
 *  - 按键归谁（`workbenchEditorVimKeys.ts`）：包认按键的入口是 `Vim.vimKeyFromEvent`，这里包一层，不归 Vim 的键
 *    返回空，包就当它没按过，后面的编辑器命令、全局快捷键、应用菜单照常接；
 *  - `:w`、`:q`、`:wq`、`:wa`：全局登记一次，靠编辑器状态里的宿主（`vimHost`）落到按下命令的那个编辑器上；
 *  - 模式报给状态栏（`workbenchEditorVim.ts`）；
 *  - 几处要配合的地方：离开插入模式时收起补全列表，Esc 不再漏到全局去关右侧面板，刚打开的文件按下第一个键就
 *    亮出光标，换文件时不把开着的命令行带过去；
 *  - 命令行和块状光标用工作台的颜色。
 */
import { closeCompletion } from '@codemirror/autocomplete'
import { type Extension, Facet, Prec } from '@codemirror/state'
import { EditorView, keymap, ViewPlugin, type ViewUpdate } from '@codemirror/view'

import {
  readWorkbenchKeyboardShortcutMap,
  resolveWorkbenchKeyboardShortcutMap,
  subscribeWorkbenchKeymapSettings,
  type WorkbenchKeyboardShortcutMap,
} from '../layout/workbenchKeyboardShortcuts'
import { currentWorkbenchPlatform } from '../layout/workbenchKeymapPresets'

import { revealWorkbenchActiveLine } from './workbenchCodeMirrorActiveLine'
import type { WorkbenchEditorKeyEventLike } from './workbenchEditorKeymapResolver'
import {
  focusWorkbenchEditorVimMode,
  resolveWorkbenchEditorVimMode,
  setWorkbenchEditorVimMode,
} from './workbenchEditorVim'
import { shouldWorkbenchVimHandleKey } from './workbenchEditorVimKeys'

type VimPackage = typeof import('@replit/codemirror-vim')
type VimEditor = NonNullable<ReturnType<VimPackage['getCM']>>

/** 包里编辑器此刻的 Vim 状态，认按键归属只看这两项。 */
interface VimModeState {
  insertMode?: boolean
  visualMode?: boolean
}

/** Vim 的 ex 命令落到编辑器上要做的事；每个编辑器各给各的。 */
export interface WorkbenchEditorVimHost {
  /** `:w`：走编辑器平常的保存（保存时格式化、收拾行尾空白都照常）。 */
  save: (view: EditorView) => void
  /** `:q`：关这个标签，走平常的关闭（固定的标签不关，没保存的改动先问）。 */
  quit: (view: EditorView) => void
  /** `:wq`：保存，存下了再关。 */
  saveAndQuit: (view: EditorView) => void
  /** `:wa`：保存全部。 */
  saveAll: (view: EditorView) => void
}

/** 登记的 ex 命令：全名、最短写法（`:w`、`:q`、`:wq`、`:wa`），各自落到宿主的哪件事上。 */
export const WorkbenchVimExCommands: ReadonlyArray<{
  name: string
  prefix: string
  run: keyof WorkbenchEditorVimHost
}> = [
  { name: 'write', prefix: 'w', run: 'save' },
  { name: 'quit', prefix: 'q', run: 'quit' },
  { name: 'wq', prefix: 'wq', run: 'saveAndQuit' },
  { name: 'wall', prefix: 'wa', run: 'saveAll' },
]

/** 这个编辑器的宿主。ex 命令是全局登记的，执行时靠它找到该谁去做。 */
const vimHost = Facet.define<WorkbenchEditorVimHost, Nullable<WorkbenchEditorVimHost>>({
  combine: (hosts) => hosts[0] ?? null,
})

/**
 * 登记 ex 命令（整个应用一次）。`:q!`、`:w 文件名` 里多出来的部分不看：`:q!` 与 `:q` 一样走平常的关闭，不会
 * 不问就丢掉改动。
 */
export function installWorkbenchVimExCommands(
  vim: { defineEx: (name: string, prefix: string, run: (editor: { cm6: EditorView }) => void) => void },
  hostOf: (view: EditorView) => Nullable<WorkbenchEditorVimHost> = (view) => view.state.facet(vimHost)
): void {
  for (const command of WorkbenchVimExCommands)
    vim.defineEx(command.name, command.prefix, (editor) => {
      hostOf(editor.cm6)?.[command.run](editor.cm6)
    })
}

/**
 * 按键归属：包一层 `Vim.vimKeyFromEvent`。没有编辑器状态的调用（命令行、查找输入框里的按键走的是包内部
 * 另一条路，不经这里）原样返回。
 */
export function installWorkbenchVimKeyOwnership<Event extends WorkbenchEditorKeyEventLike, State extends VimModeState>(
  vim: { vimKeyFromEvent: (event: Event, state?: State) => string | undefined },
  getKeymap: () => WorkbenchKeyboardShortcutMap,
  getPlatform: () => string = currentWorkbenchPlatform
): void {
  const vimKeyFromEvent = vim.vimKeyFromEvent
  vim.vimKeyFromEvent = (event, state) => {
    const vimKey = vimKeyFromEvent(event, state)
    if (!vimKey || !state) return vimKey
    return shouldWorkbenchVimHandleKey({
      vimKey,
      event,
      context: state.insertMode ? 'insert' : state.visualMode ? 'visual' : 'normal',
      keymap: getKeymap(),
      platform: getPlatform(),
    })
      ? vimKey
      : undefined
  }
}

/** 此刻生效的全局快捷键：读一次记着，设置变了再换。 */
let currentKeymap: Nullable<WorkbenchKeyboardShortcutMap> = null

function readCurrentKeymap(): WorkbenchKeyboardShortcutMap {
  currentKeymap ??= readWorkbenchKeyboardShortcutMap()
  return currentKeymap
}

const ModifierKeys = new Set(['Alt', 'Control', 'Meta', 'Shift'])

/** 这个编辑器里 Vim 与工作台之间要配合的几处（见文件头）。排在包的扩展后面：建的时候包那边的编辑器对象已经在了。 */
function workbenchVimBridge({ CodeMirror, getCM }: VimPackage): Extension {
  return [
    ViewPlugin.fromClass(
      class {
        private readonly editor: Nullable<VimEditor>
        private destroyed = false

        private readonly handleModeChange = (event: { mode?: unknown; subMode?: unknown }): void => {
          const mode = resolveWorkbenchEditorVimMode(event.mode, event.subMode)
          setWorkbenchEditorVimMode(this.view, mode)
          if (mode === 'insert' || mode === 'replace') return
          // 离开插入模式：补全列表不跟到普通模式里（那里 ↑ ↓、回车是 Vim 的）。模式可能是在视图更新途中变的
          // （鼠标拖出选区进可视模式），此刻不能改视图，推后一步。
          queueMicrotask(() => {
            if (!this.destroyed) closeCompletion(this.view)
          })
        }

        public constructor(private readonly view: EditorView) {
          this.editor = getCM(view)
          this.editor?.on('vim-mode-change', this.handleModeChange)
          setWorkbenchEditorVimMode(view, 'normal')
          if (view.hasFocus) focusWorkbenchEditorVimMode(view)
          // 这个状态可能是换文件换回来的：离开时开着的命令行 / 提示条在状态里还记着「开着」，到了这里却没有内容
          // 可放——留着一条空壳，而且下一次 `:` 出不来。让包按「现在没有」重新对一次。此刻视图还在更新中，
          // 推后一步。
          queueMicrotask(() => {
            const { editor } = this
            if (this.destroyed || !editor || editor.state.dialog) return
            if (view.dom.querySelector('.cm-vim-panel')) CodeMirror.signal(editor, 'dialog')
          })
        }

        public update(update: ViewUpdate): void {
          if (update.focusChanged && update.view.hasFocus) focusWorkbenchEditorVimMode(update.view)
        }

        public destroy(): void {
          this.destroyed = true
          setWorkbenchEditorVimMode(this.view, null)
          const { editor } = this
          if (!editor) return
          editor.off('vim-mode-change', this.handleModeChange)
          // 视图要换别的文件了（或者 Vim 关掉了）：还开着的提示条连同它的定时器收掉。包在提示条开合时会去改
          // 视图的状态——给它一个状态条的壳，它就只改那个壳，碰不到已经换成别的文件的视图。
          editor.state.statusbar = document.createElement('span')
          editor.state.currentNotificationClose?.()
        }
      }
    ),
    // 刚打开的文件先不亮光标和当前行，按下第一个键才亮（`workbenchCodeMirrorActiveLine.ts`）。那个按键处理
    // 排在 Vim 后面，Vim 拿走的键它收不到——这里用「旁观」的方式听，谁拿走都听得到。
    EditorView.domEventObservers({
      keydown: (event, view) => {
        if (!ModifierKeys.has(event.key)) revealWorkbenchActiveLine(view)
      },
    }),
    // Esc 在 Vim 里按得很勤（回普通模式、确认自己在普通模式）：别人都不用它的时候也留在编辑器里，不再漏到全局
    // 去关右侧面板。排在最后：补全列表、查找栏、多个选区先各自用它。
    Prec.lowest(keymap.of([{ key: 'Escape', run: () => true }])),
  ]
}

/** 命令行（`:`、`/`）与块状光标用工作台的颜色；选择器比包自带的样式多一层，盖得住它。 */
const workbenchVimTheme = EditorView.theme({
  '.cm-panels .cm-vim-panel': {
    padding: '3px 10px',
    color: 'var(--workbench-text)',
    backgroundColor: 'var(--workbench-toolbar)',
    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
    fontSize: '12px',
  },
  '.cm-panels .cm-vim-panel input': {
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 'inherit',
  },
  '.cm-panels-bottom:has(> .cm-vim-panel)': {
    borderTop: '1px solid var(--workbench-border)',
  },
  '.cm-vimCursorLayer .cm-fat-cursor': {
    background: 'var(--workbench-editor-caret)',
    color: 'var(--workbench-editor-bg) !important',
  },
  '&:not(.cm-focused) .cm-vimCursorLayer .cm-fat-cursor': {
    background: 'none',
    outline: 'solid 1px var(--workbench-editor-caret)',
    color: 'transparent !important',
  },
})

export interface WorkbenchEditorVimLayer {
  /** 挂进一个编辑器的扩展；要排在编辑器别的按键处理之前。 */
  extension: (host: WorkbenchEditorVimHost) => Extension
}

function createWorkbenchEditorVimLayer(vimPackage: VimPackage): WorkbenchEditorVimLayer {
  installWorkbenchVimKeyOwnership(vimPackage.Vim, readCurrentKeymap)
  installWorkbenchVimExCommands(vimPackage.Vim)
  subscribeWorkbenchKeymapSettings((settings) => {
    currentKeymap = resolveWorkbenchKeyboardShortcutMap(settings)
  })
  return {
    extension: (host) => [
      vimHost.of(host),
      vimPackage.vim(),
      workbenchVimBridge(vimPackage),
      workbenchVimTheme,
    ],
  }
}

let layer: Nullable<Promise<WorkbenchEditorVimLayer>> = null

/** 加载 Vim 包并接好（整个应用一次）；没加载成的话下次再试。 */
export function loadWorkbenchEditorVimLayer(): Promise<WorkbenchEditorVimLayer> {
  layer ??= import('@replit/codemirror-vim')
    .then(createWorkbenchEditorVimLayer)
    .catch((error: unknown) => {
      layer = null
      throw error
    })
  return layer
}
