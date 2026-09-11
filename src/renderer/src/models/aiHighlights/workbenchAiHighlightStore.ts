import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from 'react'

/**
 * AI 选区（`workbench:open_file` 的 highlights）：AI 指给用户看的代码，编辑器里标成淡紫色。
 *
 * 它锁在文件上，不是编辑器选区——切换文件、切走再回来都还在；用户关掉这个文件的标签才释放，
 * AI 可以用 `workbench:clear_highlights` 批量取消。界面上不给人取消按钮。只活在当前窗口的内存里。
 */
export interface WorkbenchAiHighlight {
  id: string
  projectRoot: string
  /** 相对项目根。 */
  path: string
  /** 1 基起始行（含）。 */
  startLine: number
  /** 1 基结束行（含）。 */
  endLine: number
}

export interface WorkbenchAiHighlightInput {
  path: string
  startLine: number
  endLine: number
}

const EmptyHighlights = Object.freeze([]) as readonly WorkbenchAiHighlight[]

function normalizeRoot(projectRoot: string): string {
  return projectRoot.trim().replaceAll('\\', '/').replace(/\/+$/u, '')
}

function compareHighlights(left: WorkbenchAiHighlight, right: WorkbenchAiHighlight): number {
  return left.path.localeCompare(right.path) || left.startLine - right.startLine || left.endLine - right.endLine
}

export class WorkbenchAiHighlightStore {
  private highlights: readonly WorkbenchAiHighlight[] = EmptyHighlights
  private readonly listeners = new Set<() => void>()
  private sequence = 0

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public readonly getSnapshot = (): readonly WorkbenchAiHighlight[] => this.highlights

  public readonly listForPath = (projectRoot: string, path: string): WorkbenchAiHighlight[] => {
    const root = normalizeRoot(projectRoot)
    return this.highlights.filter((highlight) => highlight.projectRoot === root && highlight.path === path)
  }

  /** 本项目的选区，按文件与行号排好。 */
  public readonly listForProject = (projectRoot: string): WorkbenchAiHighlight[] => {
    const root = normalizeRoot(projectRoot)
    return this.highlights.filter((highlight) => highlight.projectRoot === root).sort(compareHighlights)
  }

  /** 加一批选区；与已有选区完全相同的一段不重复加。返回真正加上的。 */
  public readonly add = (
    projectRoot: string,
    inputs: readonly WorkbenchAiHighlightInput[]
  ): WorkbenchAiHighlight[] => {
    const root = normalizeRoot(projectRoot)
    const keyOf = (value: { path: string; startLine: number; endLine: number }): string =>
      `${value.path}\0${value.startLine}\0${value.endLine}`
    const existing = new Set(
      this.highlights.filter((highlight) => highlight.projectRoot === root).map(keyOf)
    )
    const added: WorkbenchAiHighlight[] = []
    for (const input of inputs) {
      const startLine = Math.max(1, Math.floor(input.startLine))
      const endLine = Math.max(startLine, Math.floor(input.endLine))
      const candidate = { path: input.path, startLine, endLine }
      if (existing.has(keyOf(candidate))) continue
      existing.add(keyOf(candidate))
      added.push({
        ...candidate,
        id: `wb-ai-highlight-${(this.sequence += 1).toString(36)}`,
        projectRoot: root,
      })
    }
    if (added.length > 0) this.commit([...this.highlights, ...added])
    return added
  }

  /** 取消本项目的选区（给 paths 只取消这些文件上的），返回取消的段数。 */
  public readonly clear = (projectRoot: string, paths: readonly string[] | null = null): number => {
    const root = normalizeRoot(projectRoot)
    const targets = paths ? new Set(paths) : null
    const kept = this.highlights.filter(
      (highlight) => highlight.projectRoot !== root || (targets !== null && !targets.has(highlight.path))
    )
    const removed = this.highlights.length - kept.length
    if (removed > 0) this.commit(kept)
    return removed
  }

  /** 编辑器里改动代码时，选区跟着代码走：回写新的起止行。 */
  public readonly updateLines = (
    updates: ReadonlyArray<{ id: string; startLine: number; endLine: number }>
  ): void => {
    const byId = new Map(updates.map((update) => [update.id, update]))
    let changed = false
    const next = this.highlights.map((highlight) => {
      const update = byId.get(highlight.id)
      if (!update || (update.startLine === highlight.startLine && update.endLine === highlight.endLine))
        return highlight
      changed = true
      return { ...highlight, startLine: update.startLine, endLine: update.endLine }
    })
    if (changed) this.commit(next)
  }

  /** 选区标着的代码整段被删掉：选区跟着消失。 */
  public readonly removeMany = (ids: readonly string[]): void => {
    if (ids.length === 0) return
    const removed = new Set(ids)
    const kept = this.highlights.filter((highlight) => !removed.has(highlight.id))
    if (kept.length !== this.highlights.length) this.commit(kept)
  }

  /** 文件（或它所在的目录）改名 / 移动：选区跟着文件走，不算关掉。 */
  public readonly renamePath = (projectRoot: string, previousPath: string, nextPath: string): void => {
    if (!previousPath || previousPath === nextPath) return
    const root = normalizeRoot(projectRoot)
    let changed = false
    const next = this.highlights.map((highlight) => {
      if (highlight.projectRoot !== root) return highlight
      if (highlight.path !== previousPath && !highlight.path.startsWith(`${previousPath}/`)) return highlight
      changed = true
      return { ...highlight, path: `${nextPath}${highlight.path.slice(previousPath.length)}` }
    })
    if (changed) this.commit(next)
  }

  private commit(next: readonly WorkbenchAiHighlight[]): void {
    this.highlights = Object.freeze(next)
    for (const listener of this.listeners) listener()
  }
}

/** 某一刻编辑器里开着的标签：属于哪个项目、开着哪些文件。 */
export interface WorkbenchAiHighlightTabSet {
  root: string
  paths: ReadonlySet<string>
}

/**
 * 标签变化后该释放哪些 AI 选区：`paths` 为 null 表示释放整个项目（换了项目、关了项目）。
 * 同一个项目里只看「刚才还开着、现在没了」的文件——AI 刚标上、标签还没开出来的不算关掉。
 */
export function resolveReleasedAiHighlightTabs(
  previous: WorkbenchAiHighlightTabSet,
  next: WorkbenchAiHighlightTabSet
): { root: string; paths: string[] | null } | null {
  if (previous.root && previous.root !== next.root) return { root: previous.root, paths: null }
  if (!next.root) return null
  const closed = [...previous.paths].filter((path) => !next.paths.has(path))
  return closed.length > 0 ? { root: next.root, paths: closed } : null
}

/** 默认实例：一个窗口一份。组合根要隔离时经 Provider 注入自己的实例。 */
export const workbenchAiHighlightStore = new WorkbenchAiHighlightStore()

const WorkbenchAiHighlightStoreContext = createContext<WorkbenchAiHighlightStore | null>(null)

export function WorkbenchAiHighlightStoreProvider({
  children,
  store,
}: {
  children: ReactNode
  store: WorkbenchAiHighlightStore
}): React.JSX.Element {
  return createElement(WorkbenchAiHighlightStoreContext.Provider, { value: store }, children)
}

export function useWorkbenchAiHighlightStore(): WorkbenchAiHighlightStore {
  return useContext(WorkbenchAiHighlightStoreContext) ?? workbenchAiHighlightStore
}

export function useWorkbenchAiHighlights(): readonly WorkbenchAiHighlight[] {
  const store = useWorkbenchAiHighlightStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
