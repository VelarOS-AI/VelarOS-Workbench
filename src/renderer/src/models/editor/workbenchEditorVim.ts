/**
 * Vim 键位方案里编辑器与页面之间的那一小块：此刻是什么模式（状态栏显示），以及 `:q`、`:wq`、`:wa` 交给页面做的事。
 *
 * 模式编辑本身在 `workbenchEditorVimLayer.ts`，只有选了 Vim 方案才加载；这里不引它，状态栏（在启动就加载的那
 * 一块里）只认这个文件。
 *
 * 编辑区拆成左右两组时有两个编辑器：状态栏显示的是用户最近把焦点放进去的那个（`owner` 就是那个编辑器的视图）。
 */

/** Vim 的模式；可视模式分按字符、按行（`V`）、按块（`Ctrl+V`）。 */
export type WorkbenchEditorVimMode =
  | 'normal'
  | 'insert'
  | 'replace'
  | 'visual'
  | 'visual-line'
  | 'visual-block'

/** 状态栏上的写法：Vim 自己的叫法，不随界面语言翻译。 */
const VimModeLabels: Record<WorkbenchEditorVimMode, string> = {
  normal: 'NORMAL',
  insert: 'INSERT',
  replace: 'REPLACE',
  visual: 'VISUAL',
  'visual-line': 'VISUAL LINE',
  'visual-block': 'VISUAL BLOCK',
}

export function formatWorkbenchEditorVimMode(mode: WorkbenchEditorVimMode): string {
  return VimModeLabels[mode]
}

/**
 * Vim 那一层报出来的模式（`vim-mode-change` 事件的 `mode` 与 `subMode`）归到上面这几种；不认识的按普通模式。
 */
export function resolveWorkbenchEditorVimMode(
  mode: unknown,
  subMode?: unknown
): WorkbenchEditorVimMode {
  if (mode === 'insert' || mode === 'replace') return mode
  if (mode !== 'visual') return 'normal'
  if (subMode === 'linewise') return 'visual-line'
  return subMode === 'blockwise' ? 'visual-block' : 'visual'
}

/** Vim 的 ex 命令里要页面去做的：`:q` 关标签，`:wq` 存好了再关，`:wa` 保存全部。`:w` 走编辑器平常的保存。 */
export type WorkbenchEditorVimHostCommand = 'quit' | 'write-quit' | 'write-all'

/** 各个开着 Vim 的编辑器此刻的模式，后登记的在前。 */
const modes: Array<{ owner: object; mode: WorkbenchEditorVimMode }> = []
const listeners = new Set<() => void>()
/** 最近得到焦点的编辑器；它不在了（卸载、关了 Vim）就退到最近登记的那个。 */
let focusedOwner: Nullable<object> = null
let snapshot: Nullable<WorkbenchEditorVimMode> = null
/** 上一次报给订阅者的模式，和有没有一次通知排着队。 */
let notified: Nullable<WorkbenchEditorVimMode> = null
let notifying = false

/**
 * 换文件时编辑器先撤掉旧状态里的 Vim、紧接着在新状态里再建一个：模式瞬间是「没有 → 普通」。通知推后一步合并
 * 发，这种来回订阅者根本看不到（状态栏不会为每次换文件重画）。
 */
function refresh(): void {
  snapshot = (modes.find((entry) => entry.owner === focusedOwner) ?? modes[0])?.mode ?? null
  if (notifying || snapshot === notified) return
  notifying = true
  queueMicrotask(() => {
    notifying = false
    if (snapshot === notified) return
    notified = snapshot
    for (const listener of [...listeners]) listener()
  })
}

/** 这个编辑器（`owner`）进了这个模式；`null` 是它不再用 Vim（卸载、换了键位方案）。 */
export function setWorkbenchEditorVimMode(
  owner: object,
  mode: Nullable<WorkbenchEditorVimMode>
): void {
  const index = modes.findIndex((entry) => entry.owner === owner)
  if (index !== -1) modes.splice(index, 1)
  if (mode) modes.unshift({ owner, mode })
  refresh()
}

/** 焦点进了这个编辑器：状态栏显示它的模式。 */
export function focusWorkbenchEditorVimMode(owner: object): void {
  if (focusedOwner === owner) return
  focusedOwner = owner
  refresh()
}

export function subscribeWorkbenchEditorVimMode(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 眼前那个编辑器的 Vim 模式；没有编辑器开着 Vim 是 null（给 `useSyncExternalStore` 用）。 */
export function getWorkbenchEditorVimModeSnapshot(): Nullable<WorkbenchEditorVimMode> {
  return snapshot
}
