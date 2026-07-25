import { useMemo, useSyncExternalStore } from 'react'

import { isEmpty } from '@velaros/core'

/**
 * 工作台行内评论存储（**仅会话内存，不落盘**）。
 *
 * 编辑器与聊天面板是兄弟组件，靠这个模块级单例互通：
 * - 编辑器负责在打开文件时用行号把评论重新锚定成实时块，并在块被整体删掉时移除评论；
 * - 聊天面板用 `@` 菜单列出所有评论、选中成 chip，发送后消费。
 *
 * `snippet` 是评论创建那一刻的块内容快照（语义上「评论当时看到的代码」，不随后续编辑变化）；
 * `startLine`/`endLine` 会随编辑实时更新，供 location 展示与重开文件时的再锚定。
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

let comments: readonly WorkbenchComment[] = []
const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach((listener) => listener())
}

function createCommentId(): string {
  return `wb-comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 形如 `src/foo.ts:12` 或 `src/foo.ts:12-20` 的展示定位。 */
export function formatWorkbenchCommentLocation(comment: WorkbenchComment): string {
  return comment.startLine === comment.endLine
    ? `${comment.path}:${comment.startLine}`
    : `${comment.path}:${comment.startLine}-${comment.endLine}`
}

export function subscribeWorkbenchComments(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getWorkbenchCommentsSnapshot(): readonly WorkbenchComment[] {
  return comments
}

export function getWorkbenchComment(id: string): Nullable<WorkbenchComment> {
  return comments.find((comment) => comment.id === id) ?? null
}

export function addWorkbenchComment(input: AddWorkbenchCommentInput): WorkbenchComment {
  const comment: WorkbenchComment = {
    ...input,
    id: createCommentId(),
    createdAt: Date.now(),
  }
  comments = [...comments, comment]
  emit()
  return comment
}

export function removeWorkbenchComment(id: string): void {
  const next = comments.filter((comment) => comment.id !== id)
  if (next.length === comments.length) return

  comments = next
  emit()
}

/** 修改评论正文；空正文不覆盖原评论。 */
export function updateWorkbenchCommentBody(id: string, rawBody: string): void {
  const body = rawBody.trim()
  if (!body) return

  let changed = false
  const next = comments.map((comment) => {
    if (comment.id !== id || comment.body === body) return comment
    changed = true
    return { ...comment, body }
  })
  if (!changed) return

  comments = next
  emit()
}

export function removeWorkbenchComments(ids: readonly string[]): void {
  if (isEmpty(ids)) return
  const removed = new Set(ids)
  const next = comments.filter((comment) => !removed.has(comment.id))
  if (next.length === comments.length) return

  comments = next
  emit()
}

function isPathOrUnder(candidate: string, base: string): boolean {
  return candidate === base || candidate.startsWith(`${base}/`)
}

/** 删除文件或文件夹时清掉该路径（含其子路径）下的所有评论。 */
export function removeWorkbenchCommentsUnderPath(projectRoot: string, path: string): void {
  const next = comments.filter(
    (comment) => !(comment.projectRoot === projectRoot && isPathOrUnder(comment.path, path))
  )
  if (next.length === comments.length) return

  comments = next
  emit()
}

/** 重命名/移动文件或文件夹时把该路径（含子路径）下的评论迁到新路径。 */
export function renameWorkbenchCommentsPath(
  projectRoot: string,
  fromPath: string,
  toPath: string
): void {
  let changed = false
  const next = comments.map((comment) => {
    if (comment.projectRoot !== projectRoot || !isPathOrUnder(comment.path, fromPath))
      return comment
    changed = true
    return { ...comment, path: `${toPath}${comment.path.slice(fromPath.length)}` }
  })
  if (!changed) return

  comments = next
  emit()
}

/** 块随编辑移动时更新起止行（仅在行号真的变化时才 emit，避免逐字符抖动）。 */
export function updateWorkbenchCommentAnchor(
  id: string,
  anchor: { startLine: number; endLine: number }
): void {
  let changed = false
  const next = comments.map((comment) => {
    if (comment.id !== id) return comment
    if (comment.startLine === anchor.startLine && comment.endLine === anchor.endLine) return comment
    changed = true
    return { ...comment, startLine: anchor.startLine, endLine: anchor.endLine }
  })
  if (!changed) return

  comments = next
  emit()
}

const EmptyComments: readonly WorkbenchComment[] = []

/** 订阅评论列表；传 `projectRoot` 则只取该项目的。 */
export function useWorkbenchComments(
  projectRoot?: LooseOptional<string>
): readonly WorkbenchComment[] {
  const snapshot = useSyncExternalStore(
    subscribeWorkbenchComments,
    getWorkbenchCommentsSnapshot,
    getWorkbenchCommentsSnapshot
  )
  return useMemo(() => {
    if (!projectRoot) return snapshot
    const scoped = snapshot.filter((comment) => comment.projectRoot === projectRoot)
    return scoped.length === snapshot.length ? snapshot : scoped
  }, [snapshot, projectRoot])
}

/** 只取某文件的评论（编辑器再锚定用）。 */
export function listWorkbenchCommentsForPath(
  projectRoot: string,
  path: string
): WorkbenchComment[] {
  return comments.filter((comment) => comment.projectRoot === projectRoot && comment.path === path)
}

export { EmptyComments as EmptyWorkbenchComments }
