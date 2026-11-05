import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react'

import { AppError } from '@velaros-ai/velaros/core'

/**
 * 工作台行内评论。评论默认仅存在于当前 `WorkbenchCommentStore` 实例中，不负责持久化。
 */
export interface WorkbenchComment {
  id: string
  projectRoot: string
  path: string
  /** 1 基起始行（含）。 */
  startLine: number
  /** 1 基结束行（含）。 */
  endLine: number
  /** 创建时的块内容快照。 */
  snippet: string
  /** 用户填写的评论正文。 */
  body: string
  /** 代码围栏语言标识，如 `ts`。 */
  language: string
  createdAt: number
}

export interface AddWorkbenchCommentInput {
  projectRoot: string
  path: string
  startLine: number
  endLine: number
  snippet: string
  body: string
  language: string
}

export interface WorkbenchCommentStoreOptions {
  createId?: () => string
  now?: () => number
}

function defaultCommentId(): string {
  return `wb-comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function isPathOrUnder(candidate: string, base: string): boolean {
  return candidate === base || candidate.startsWith(`${base}/`)
}

/**
 * 一个可独立创建、订阅和销毁的会话评论仓库。
 *
 * 所有公开方法都已绑定实例，可直接作为 React 外部存储回调或事件处理器传递。
 */
export class WorkbenchCommentStore {
  private comments: readonly WorkbenchComment[] = []
  private readonly listeners = new Set<() => void>()
  private readonly createId: () => string
  private readonly now: () => number
  private disposed = false

  public constructor(options: WorkbenchCommentStoreOptions = {}) {
    this.createId = options.createId ?? defaultCommentId
    this.now = options.now ?? Date.now
  }

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.assertActive()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public readonly getSnapshot = (): readonly WorkbenchComment[] => this.comments

  public readonly get = (id: string): Nullable<WorkbenchComment> =>
    this.comments.find((comment) => comment.id === id) ?? null

  public readonly add = (input: AddWorkbenchCommentInput): WorkbenchComment => {
    this.assertActive()
    const comment: WorkbenchComment = {
      ...input,
      id: this.createId(),
      createdAt: this.now(),
    }
    this.comments = [...this.comments, comment]
    this.emit()
    return comment
  }

  public readonly remove = (id: string): void => {
    this.replace(this.comments.filter((comment) => comment.id !== id))
  }

  public readonly updateBody = (id: string, rawBody: string): void => {
    this.assertActive()
    const body = rawBody.trim()
    if (!body) return
    this.replace(
      this.comments.map((comment) =>
        comment.id === id && comment.body !== body ? { ...comment, body } : comment
      )
    )
  }

  public readonly removeMany = (ids: readonly string[]): void => {
    this.assertActive()
    if (ids.length === 0) return
    const removed = new Set(ids)
    this.replace(this.comments.filter((comment) => !removed.has(comment.id)))
  }

  public readonly removeUnderPath = (projectRoot: string, path: string): void => {
    this.replace(
      this.comments.filter(
        (comment) => !(comment.projectRoot === projectRoot && isPathOrUnder(comment.path, path))
      )
    )
  }

  public readonly renamePath = (projectRoot: string, fromPath: string, toPath: string): void => {
    this.assertActive()
    this.replace(
      this.comments.map((comment) =>
        comment.projectRoot === projectRoot && isPathOrUnder(comment.path, fromPath)
          ? { ...comment, path: `${toPath}${comment.path.slice(fromPath.length)}` }
          : comment
      )
    )
  }

  public readonly updateAnchor = (
    id: string,
    anchor: { startLine: number; endLine: number }
  ): void => {
    this.assertActive()
    this.replace(
      this.comments.map((comment) =>
        comment.id === id &&
        (comment.startLine !== anchor.startLine || comment.endLine !== anchor.endLine)
          ? { ...comment, ...anchor }
          : comment
      )
    )
  }

  public readonly listForPath = (projectRoot: string, path: string): WorkbenchComment[] =>
    this.comments.filter((comment) => comment.projectRoot === projectRoot && comment.path === path)

  /** 清理订阅与内存数据；销毁后的写入会显式报错。 */
  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.comments = []
    this.listeners.clear()
  }

  private replace(next: readonly WorkbenchComment[]): void {
    this.assertActive()
    if (
      next.length === this.comments.length &&
      next.every((comment, index) => comment === this.comments[index])
    )
      return
    this.comments = next
    this.emit()
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener())
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new AppError('INVARIANT', 'Workbench comment store has been disposed')
    }
  }
}

/** 旧入口使用的默认实例。新应用应在 composition root 注入自己的实例。 */
export const workbenchCommentStore = new WorkbenchCommentStore()

const WorkbenchCommentStoreContext = createContext<Nullable<WorkbenchCommentStore>>(null)

export function WorkbenchCommentStoreProvider({
  children,
  store,
}: {
  children: ReactNode
  store: WorkbenchCommentStore
}): React.JSX.Element {
  return createElement(WorkbenchCommentStoreContext.Provider, { value: store }, children)
}

/** 未安装 Provider 时回退默认实例，仅用于兼容旧应用。 */
export function useWorkbenchCommentStore(): WorkbenchCommentStore {
  return useContext(WorkbenchCommentStoreContext) ?? workbenchCommentStore
}

/** 形如 `src/foo.ts:12` 或 `src/foo.ts:12-20` 的展示定位。 */
export function formatWorkbenchCommentLocation(comment: WorkbenchComment): string {
  return comment.startLine === comment.endLine
    ? `${comment.path}:${comment.startLine}`
    : `${comment.path}:${comment.startLine}-${comment.endLine}`
}

/** @deprecated 使用 `WorkbenchCommentStore.subscribe`。 */
export const subscribeWorkbenchComments = workbenchCommentStore.subscribe
/** @deprecated 使用 `WorkbenchCommentStore.getSnapshot`。 */
export const getWorkbenchCommentsSnapshot = workbenchCommentStore.getSnapshot
/** @deprecated 使用 `WorkbenchCommentStore.get`。 */
export const getWorkbenchComment = workbenchCommentStore.get
/** @deprecated 使用 `WorkbenchCommentStore.add`。 */
export const addWorkbenchComment = workbenchCommentStore.add
/** @deprecated 使用 `WorkbenchCommentStore.remove`。 */
export const removeWorkbenchComment = workbenchCommentStore.remove
/** @deprecated 使用 `WorkbenchCommentStore.updateBody`。 */
export const updateWorkbenchCommentBody = workbenchCommentStore.updateBody
/** @deprecated 使用 `WorkbenchCommentStore.removeMany`。 */
export const removeWorkbenchComments = workbenchCommentStore.removeMany
/** @deprecated 使用 `WorkbenchCommentStore.removeUnderPath`。 */
export const removeWorkbenchCommentsUnderPath = workbenchCommentStore.removeUnderPath
/** @deprecated 使用 `WorkbenchCommentStore.renamePath`。 */
export const renameWorkbenchCommentsPath = workbenchCommentStore.renamePath
/** @deprecated 使用 `WorkbenchCommentStore.updateAnchor`。 */
export const updateWorkbenchCommentAnchor = workbenchCommentStore.updateAnchor
/** @deprecated 使用 `WorkbenchCommentStore.listForPath`。 */
export const listWorkbenchCommentsForPath = workbenchCommentStore.listForPath

const EmptyComments: readonly WorkbenchComment[] = []

/** 订阅当前 Provider 的评论列表；传 `projectRoot` 则只取该项目的。 */
export function useWorkbenchComments(
  projectRoot?: LooseOptional<string>
): readonly WorkbenchComment[] {
  const store = useWorkbenchCommentStore()
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return useMemo(() => {
    if (!projectRoot) return snapshot
    const scoped = snapshot.filter((comment) => comment.projectRoot === projectRoot)
    return scoped.length === snapshot.length ? snapshot : scoped
  }, [snapshot, projectRoot])
}

export { EmptyComments as EmptyWorkbenchComments }
