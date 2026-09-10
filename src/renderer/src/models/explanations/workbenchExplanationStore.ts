import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from 'react'

/**
 * AI 钉在代码上的讲解气泡（`workbench:explain_code`）。只活在当前窗口的内存里：讲解是这一次对话里
 * 带人看代码用的，不是项目资产，关掉窗口就散。
 */
export interface WorkbenchExplanation {
  id: string
  projectRoot: string
  sessionId: string
  /** 相对项目根。 */
  path: string
  /** 1 基起始行（含）。 */
  startLine: number
  /** 1 基结束行（含）。 */
  endLine: number
  title: string
  text: string
  createdAt: number
  /** 在同一批讲解里的次序；「上一条 / 下一条」按（createdAt, order）走。 */
  order: number
}

export interface WorkbenchExplanationInput {
  path: string
  startLine: number
  endLine: number
  title: string
  text: string
}

export interface WorkbenchExplanationSnapshot {
  readonly explanations: readonly WorkbenchExplanation[]
  /** 当前展开气泡的讲解；null = 全部收起成行尾标记。 */
  readonly activeId: string | null
  /**
   * 每次主动切到某条讲解（新加一批、上一条 / 下一条、点标记）加一；编辑器与页面据此把它带进视野，
   * 单纯的行号回写不会让画面跳走。
   */
  readonly focusRevision: number
}

const EmptySnapshot: WorkbenchExplanationSnapshot = Object.freeze({
  explanations: Object.freeze([]) as readonly WorkbenchExplanation[],
  activeId: null,
  focusRevision: 0,
})

function normalizeRoot(projectRoot: string): string {
  return projectRoot.trim().replaceAll('\\', '/').replace(/\/+$/u, '')
}

function compareTourOrder(left: WorkbenchExplanation, right: WorkbenchExplanation): number {
  return left.createdAt - right.createdAt || left.order - right.order
}

export class WorkbenchExplanationStore {
  private snapshot: WorkbenchExplanationSnapshot = EmptySnapshot
  private readonly listeners = new Set<() => void>()
  private sequence = 0

  public constructor(private readonly now: () => number = Date.now) {}

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public readonly getSnapshot = (): WorkbenchExplanationSnapshot => this.snapshot

  /** 本项目的讲解，按讲解路线排好。 */
  public readonly listForProject = (projectRoot: string): WorkbenchExplanation[] => {
    const root = normalizeRoot(projectRoot)
    return this.snapshot.explanations
      .filter((explanation) => explanation.projectRoot === root)
      .sort(compareTourOrder)
  }

  /** 加一批讲解并展开第一条；`replace` 先清掉本项目已有的讲解（一次只走一条讲解路线）。 */
  public readonly addBatch = (input: {
    projectRoot: string
    sessionId: string
    explanations: readonly WorkbenchExplanationInput[]
    replace: boolean
  }): WorkbenchExplanation[] => {
    const root = normalizeRoot(input.projectRoot)
    const createdAt = Math.max(this.now(), this.latestCreatedAt() + 1)
    const batch = input.explanations.map((explanation, order) => ({
      ...explanation,
      id: `wb-explanation-${createdAt.toString(36)}-${(this.sequence += 1).toString(36)}`,
      projectRoot: root,
      sessionId: input.sessionId,
      createdAt,
      order,
    }))
    const kept = input.replace
      ? this.snapshot.explanations.filter((explanation) => explanation.projectRoot !== root)
      : this.snapshot.explanations
    this.commit({
      explanations: [...kept, ...batch],
      activeId: batch[0]?.id ?? this.snapshot.activeId,
      focusRevision: this.snapshot.focusRevision + (batch.length > 0 ? 1 : 0),
    })
    return batch
  }

  /** 清掉本项目的讲解（给 path 只清这个文件上的），返回清掉的条数。 */
  public readonly clear = (projectRoot: string, path: string | null = null): number => {
    const root = normalizeRoot(projectRoot)
    const kept = this.snapshot.explanations.filter(
      (explanation) =>
        explanation.projectRoot !== root || (path !== null && explanation.path !== path)
    )
    const removed = this.snapshot.explanations.length - kept.length
    if (removed === 0) return 0
    this.commit({
      explanations: kept,
      activeId: kept.some((explanation) => explanation.id === this.snapshot.activeId)
        ? this.snapshot.activeId
        : null,
      focusRevision: this.snapshot.focusRevision,
    })
    return removed
  }

  /** 展开某条讲解（null = 全部收起）。展开会把它带进视野。 */
  public readonly activate = (id: string | null): void => {
    if (id !== null && !this.snapshot.explanations.some((explanation) => explanation.id === id))
      return
    this.commit({
      explanations: this.snapshot.explanations,
      activeId: id,
      focusRevision: this.snapshot.focusRevision + (id === null ? 0 : 1),
    })
  }

  /** 沿讲解路线前后移动一条；到头了原地不动。返回新的当前讲解。 */
  public readonly step = (fromId: string, direction: 1 | -1): WorkbenchExplanation | null => {
    const current = this.snapshot.explanations.find((explanation) => explanation.id === fromId)
    if (!current) return null
    const tour = this.listForProject(current.projectRoot)
    const next = tour[tour.findIndex((explanation) => explanation.id === fromId) + direction]
    if (!next) return current
    this.activate(next.id)
    return next
  }

  /** 编辑器里改动代码时，讲解跟着代码走：回写新的起止行，不触发视野跳转。 */
  public readonly updateLines = (
    updates: ReadonlyArray<{ id: string; startLine: number; endLine: number }>
  ): void => {
    const byId = new Map(updates.map((update) => [update.id, update]))
    let changed = false
    const explanations = this.snapshot.explanations.map((explanation) => {
      const update = byId.get(explanation.id)
      if (
        !update ||
        (update.startLine === explanation.startLine && update.endLine === explanation.endLine)
      )
        return explanation
      changed = true
      return { ...explanation, startLine: update.startLine, endLine: update.endLine }
    })
    if (changed) this.commit({ ...this.snapshot, explanations })
  }

  /** 讲解钉住的代码整段被删掉：讲解跟着消失。 */
  public readonly removeMany = (ids: readonly string[]): void => {
    if (ids.length === 0) return
    const removed = new Set(ids)
    const kept = this.snapshot.explanations.filter((explanation) => !removed.has(explanation.id))
    if (kept.length === this.snapshot.explanations.length) return
    this.commit({
      explanations: kept,
      activeId:
        this.snapshot.activeId && removed.has(this.snapshot.activeId) ? null : this.snapshot.activeId,
      focusRevision: this.snapshot.focusRevision,
    })
  }

  private latestCreatedAt(): number {
    return this.snapshot.explanations.reduce(
      (latest, explanation) => Math.max(latest, explanation.createdAt),
      0
    )
  }

  private commit(next: WorkbenchExplanationSnapshot): void {
    this.snapshot = Object.freeze(next)
    for (const listener of this.listeners) listener()
  }
}

/** 默认实例：一个窗口一份。组合根要隔离时经 Provider 注入自己的实例。 */
export const workbenchExplanationStore = new WorkbenchExplanationStore()

const WorkbenchExplanationStoreContext = createContext<WorkbenchExplanationStore | null>(null)

export function WorkbenchExplanationStoreProvider({
  children,
  store,
}: {
  children: ReactNode
  store: WorkbenchExplanationStore
}): React.JSX.Element {
  return createElement(WorkbenchExplanationStoreContext.Provider, { value: store }, children)
}

export function useWorkbenchExplanationStore(): WorkbenchExplanationStore {
  return useContext(WorkbenchExplanationStoreContext) ?? workbenchExplanationStore
}

export function useWorkbenchExplanations(): WorkbenchExplanationSnapshot {
  const store = useWorkbenchExplanationStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
