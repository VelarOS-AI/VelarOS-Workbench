import type { ChatMessage } from '@shared/contracts'
import type {
  WorkbenchChatRunChangesSummary,
  WorkbenchChatRunFileChange,
} from '@shared/workbenchGit'

import {
  buildWorkbenchContentDiffRows,
  buildWorkbenchPatchDiffRows,
  resolveWorkbenchFullFileDiffContents,
  type WorkbenchUnifiedDiffRow,
} from '../git/workbenchGitDiffModel'

/**
 * 「AI 改动」面板的数据模型：每一轮 AI 运行改了哪些文件。
 *
 * 轮次来自会话的运行标记——一轮收尾时，本轮改动的摘要（记录 id、文件数、增删行）挂在标记上；逐文件
 * 补丁在主进程的记录文件里，面板展开某一轮时再按记录 id 读。这里只做纯投影，不读盘。
 */

export interface WorkbenchAiChangeRoundSource {
  readonly id: string
  readonly title: string
  readonly messages: readonly ChatMessage[]
  readonly messageRunMarkers: ReadonlyArray<{
    readonly messageId: string
    readonly timestamp: number
    readonly runChanges?: WorkbenchChatRunChangesSummary
  }>
}

export interface WorkbenchAiChangeRound {
  /** `${sessionId}\0${recordId}`。 */
  readonly key: string
  readonly sessionId: string
  readonly sessionTitle: string
  readonly recordId: string
  readonly capturedAt: number
  readonly fileCount: number
  readonly additions: number
  readonly deletions: number
  /** 采集失败的原因；成功为 null。 */
  readonly error: string | null
  /** 触发这一轮的用户消息文字（折叠空白）；找不到时为空串。 */
  readonly prompt: string
  /** 这一轮是所属会话的第几轮运行（从 1 开始）。 */
  readonly runNumber: number
}

export function getWorkbenchAiChangeRoundKey(sessionId: string, recordId: string): string {
  return `${sessionId}\0${recordId}`
}

function readMessageText(message: ChatMessage): string {
  const parts: string[] = []
  for (const block of message.blocks) {
    if (block.type !== 'text') continue
    const text = block.text.trim()
    if (text) parts.push(text)
  }
  return parts.join(' ').replace(/\s+/gu, ' ').trim()
}

/** 这一轮的诉求：运行标记所在消息之前最近的一条用户消息（宿主写的系统留痕不算）。 */
function findRoundPrompt(messages: readonly ChatMessage[], messageId: string): string {
  const index = messages.findIndex((message) => message.id === messageId)
  for (let cursor = (index < 0 ? messages.length : index) - 1; cursor >= 0; cursor -= 1) {
    const message = messages[cursor]
    if (message.role !== 'user' || message.conversationKind === 'system-notice') continue
    const text = readMessageText(message)
    if (text) return text
    if (message.attachments?.length) return message.attachments.map((file) => file.name).join(', ')
  }
  return ''
}

/** 所有会话里改过文件的轮次，最近的在前。 */
export function listWorkbenchAiChangeRounds(
  sessions: readonly WorkbenchAiChangeRoundSource[]
): WorkbenchAiChangeRound[] {
  const rounds: WorkbenchAiChangeRound[] = []
  for (const session of sessions) {
    const markers = [...session.messageRunMarkers].sort(
      (left, right) => left.timestamp - right.timestamp
    )
    markers.forEach((marker, index) => {
      const summary = marker.runChanges
      if (!summary || (summary.fileCount === 0 && !summary.error)) return
      rounds.push({
        key: getWorkbenchAiChangeRoundKey(session.id, summary.recordId),
        sessionId: session.id,
        sessionTitle: session.title,
        recordId: summary.recordId,
        capturedAt: summary.capturedAt,
        fileCount: summary.fileCount,
        additions: summary.additions,
        deletions: summary.deletions,
        error: summary.error,
        prompt: findRoundPrompt(session.messages, marker.messageId),
        runNumber: index + 1,
      })
    })
  }
  return rounds.sort((left, right) => right.capturedAt - left.capturedAt)
}

export type WorkbenchAiChangeTreeNode =
  | {
      readonly kind: 'directory'
      readonly key: string
      /** 连续只有一个子目录的链压成一段显示（`src/components/ui`）。 */
      readonly name: string
      readonly path: string
      readonly children: WorkbenchAiChangeTreeNode[]
    }
  | {
      readonly kind: 'file'
      readonly key: string
      readonly name: string
      readonly path: string
      readonly change: WorkbenchChatRunFileChange
    }

interface MutableDirectory {
  name: string
  path: string
  directories: Map<string, MutableDirectory>
  files: WorkbenchChatRunFileChange[]
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right, 'en', { sensitivity: 'base', numeric: true })
}

function toTreeNodes(directory: MutableDirectory): WorkbenchAiChangeTreeNode[] {
  const directories = [...directory.directories.values()]
    .sort((left, right) => compareNames(left.name, right.name))
    .map((child): WorkbenchAiChangeTreeNode => {
      // 只有一个子目录、自己没有文件的目录并进子目录名里，树不必一层层点开。
      let current = child
      let name = child.name
      while (current.files.length === 0 && current.directories.size === 1) {
        const only = [...current.directories.values()][0]
        name = `${name}/${only.name}`
        current = only
      }
      return {
        kind: 'directory',
        key: `dir:${current.path}`,
        name,
        path: current.path,
        children: toTreeNodes(current),
      }
    })
  const files = [...directory.files]
    .sort((left, right) => compareNames(left.path, right.path))
    .map(
      (change): WorkbenchAiChangeTreeNode => ({
        kind: 'file',
        key: `file:${change.path}`,
        name: change.path.slice(change.path.lastIndexOf('/') + 1),
        path: change.path,
        change,
      })
    )
  return [...directories, ...files]
}

/** 一轮改动的文件树：目录在前、文件在后，各自按名字排。 */
export function buildWorkbenchAiChangeTree(
  changes: readonly WorkbenchChatRunFileChange[]
): WorkbenchAiChangeTreeNode[] {
  const root: MutableDirectory = { name: '', path: '', directories: new Map(), files: [] }
  for (const change of changes) {
    const segments = change.path.split('/').filter(Boolean)
    let directory = root
    for (const segment of segments.slice(0, -1)) {
      const path = directory.path ? `${directory.path}/${segment}` : segment
      let child = directory.directories.get(segment)
      if (!child) {
        child = { name: segment, path, directories: new Map(), files: [] }
        directory.directories.set(segment, child)
      }
      directory = child
    }
    directory.files.push(change)
  }
  return toTreeNodes(root)
}

/** 文件树里的文件顺序（与树的显示顺序一致），自动打开与「下一个文件」按它走。 */
export function listWorkbenchAiChangeTreeFiles(
  nodes: readonly WorkbenchAiChangeTreeNode[]
): WorkbenchChatRunFileChange[] {
  return nodes.flatMap((node) =>
    node.kind === 'file' ? [node.change] : listWorkbenchAiChangeTreeFiles(node.children)
  )
}

export type WorkbenchAiChangeDiffView =
  | { readonly kind: 'rows'; readonly rows: WorkbenchUnifiedDiffRow[]; readonly fullFile: boolean }
  | { readonly kind: 'binary' }
  | { readonly kind: 'omitted' }
  | { readonly kind: 'empty' }

/**
 * 一个文件在这一轮里的差异行。
 *
 * 能拼出前后两份全文时显示整份文件、改动处高亮：新建文件的「前」是空文件；改动与删除的「前」来自这一轮
 * 开跑前的检查点（`baseContent`）。拼不出来（旧记录没有起点提交、快照已被清理）时退回补丁本身。
 */
export function buildWorkbenchAiChangeDiffView(
  change: WorkbenchChatRunFileChange,
  baseContent: string | null
): WorkbenchAiChangeDiffView {
  if (change.binary) return { kind: 'binary' }
  if (change.patchOmitted) return { kind: 'omitted' }
  if (!change.patch) return { kind: 'empty' }

  const before = change.status === 'added' ? '' : baseContent
  if (before !== null) {
    const contents = resolveWorkbenchFullFileDiffContents({
      diff: change.patch,
      scope: 'staged',
      baseContent: before,
      currentContent: '',
    })
    if (contents) {
      const rows = buildWorkbenchContentDiffRows(
        change.path,
        contents.beforeContent,
        contents.afterContent,
        { fullFile: true }
      )
      if (rows.length > 0) return { kind: 'rows', rows, fullFile: true }
    }
  }
  const rows = buildWorkbenchPatchDiffRows(change.patch)
  return rows.length > 0 ? { kind: 'rows', rows, fullFile: false } : { kind: 'empty' }
}
