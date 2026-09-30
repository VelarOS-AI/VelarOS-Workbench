/**
 * 要在「眼前这个编辑器」里做的动作（跑光标处的测试、在光标那一行切断点……）：编辑器挂着的时候把它此刻做得了的
 * 登记进来，命令面板据此决定列不列这些命令，选中时调它。编辑器是按需加载的，页面不直接拿它的实例。
 *
 * 编辑区拆成左右两组时有两个编辑器：算数的是用户最近把焦点放进去的那个（`owner` 就是那个编辑器的视图）。
 */
export type WorkbenchEditorActionId =
  | 'debug-test-at-cursor'
  | 'run-test-at-cursor'
  | 'run-test-file'
  | 'toggle-breakpoint'

type WorkbenchEditorActionHandlers = Partial<Record<WorkbenchEditorActionId, () => void>>

interface Registration {
  owner: object
  handlers: WorkbenchEditorActionHandlers
}

/** 后登记的在前：同一个编辑器的同一个动作以最近登记的那份为准（换文件时新旧两份会短暂同时在）。 */
const registrations: Registration[] = []
const listeners = new Set<() => void>()
/** 最近得到焦点的编辑器；它没有登记（已经卸载）时退到最近登记的那个。 */
let focusedOwner: Nullable<object> = null
let snapshot = ''

function activeHandlers(): WorkbenchEditorActionHandlers[] {
  const owner = registrations.some((registration) => registration.owner === focusedOwner)
    ? focusedOwner
    : registrations[0]?.owner
  return registrations
    .filter((registration) => registration.owner === owner)
    .map((registration) => registration.handlers)
}

function refresh(): void {
  const next = [...new Set(activeHandlers().flatMap((handlers) => Object.keys(handlers)))]
    .sort()
    .join(' ')
  if (next === snapshot) return
  snapshot = next
  for (const listener of [...listeners]) listener()
}

/** 登记这个编辑器（`owner`）此刻做得了的动作；返回撤销登记的函数。 */
export function registerWorkbenchEditorActions(
  owner: object,
  handlers: WorkbenchEditorActionHandlers
): () => void {
  const registration = { owner, handlers }
  registrations.unshift(registration)
  refresh()
  return () => {
    const index = registrations.indexOf(registration)
    if (index !== -1) registrations.splice(index, 1)
    refresh()
  }
}

/** 焦点进了这个编辑器：之后的动作归它。 */
export function focusWorkbenchEditorActions(owner: object): void {
  if (focusedOwner === owner) return
  focusedOwner = owner
  refresh()
}

/** 做这个动作；此刻眼前的编辑器做不了它就返回 false。 */
export function runWorkbenchEditorAction(id: WorkbenchEditorActionId): boolean {
  const handler = activeHandlers().find((handlers) => handlers[id])?.[id]
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
