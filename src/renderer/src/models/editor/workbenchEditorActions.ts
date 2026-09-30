/**
 * 要在「眼前这个编辑器」里做的动作（跑光标处的测试、在光标那一行切断点……）：编辑器挂着的时候把它此刻做得了的
 * 登记进来，命令面板据此决定列不列这些命令，选中时调它。编辑器是按需加载的，页面不直接拿它的实例。
 */
export type WorkbenchEditorActionId =
  | 'debug-test-at-cursor'
  | 'run-test-at-cursor'
  | 'run-test-file'
  | 'toggle-breakpoint'

type WorkbenchEditorActionHandlers = Partial<Record<WorkbenchEditorActionId, () => void>>

/** 后登记的在前：同一个动作以最近登记的那份为准（换文件时新旧两份会短暂同时在）。 */
const registrations: WorkbenchEditorActionHandlers[] = []
const listeners = new Set<() => void>()
let snapshot = ''

function refresh(): void {
  const next = [...new Set(registrations.flatMap((handlers) => Object.keys(handlers)))]
    .sort()
    .join(' ')
  if (next === snapshot) return
  snapshot = next
  for (const listener of [...listeners]) listener()
}

/** 登记这个编辑器此刻做得了的动作；返回撤销登记的函数。 */
export function registerWorkbenchEditorActions(handlers: WorkbenchEditorActionHandlers): () => void {
  registrations.unshift(handlers)
  refresh()
  return () => {
    const index = registrations.indexOf(handlers)
    if (index !== -1) registrations.splice(index, 1)
    refresh()
  }
}

/** 做这个动作；此刻没有编辑器做得了它就返回 false。 */
export function runWorkbenchEditorAction(id: WorkbenchEditorActionId): boolean {
  const handler = registrations.find((handlers) => handlers[id])?.[id]
  if (!handler) return false
  handler()
  return true
}

export function subscribeWorkbenchEditorActions(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 此刻做得了的动作，空格隔开（给 `useSyncExternalStore` 用的不可变快照）。 */
export function getWorkbenchEditorActionsSnapshot(): string {
  return snapshot
}
