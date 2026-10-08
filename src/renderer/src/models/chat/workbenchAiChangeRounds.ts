import { type ChatMessage } from '@velaros-ai/ui/conversation/contracts'

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
 * 「AI 改动」面板的数据模型：一个会话里每一轮 AI 运行改了哪些文件。
 *
 * 收尾的轮次来自会话的运行标记——本轮改动的摘要（记录 id、文件数、增删行）挂在标记上；还在跑的
 * 那一轮来自会话上实时采集的摘要，记录 id 与它收尾后的一样，同一轮在面板里从「进行中」无缝变成
 * 已完成。逐文件补丁在主进程的记录文件里，面板展开某一轮时再按记录 id 读。这里只做纯投影，不读盘。
 */

export interface WorkbenchAiChangeRoundSource {
  readonly id: string
  readonly messages: readonly ChatMessage[]
  readonly messageRunMarkers: ReadonlyArray<{
    readonly messageId: string
    readonly timestamp: number
    readonly runChanges?: WorkbenchChatRunChangesSummary
  }>
  readonly liveRunChanges: Nullable<{
    readonly firstMessageIndex: number
    readonly summary: WorkbenchChatRunChangesSummary
  }>
}

export interface WorkbenchAiChangeRound {
  /** `${sessionId}\0${recordId}`。 */
  readonly key: string
  readonly sessionId: string
  readonly recordId: string
  /** 最近一次采集的时刻；也是记录的版本，变了就要重读记录。 */
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
  /** 这一轮还在跑：改动随写入实时刷新，收尾时的最终采集覆盖同一条记录。 */
  readonly live: boolean
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

/**
 * 这一轮的诉求：`endIndex` 之前最近的一条用户消息（宿主写的系统留痕不算）。收尾的一轮从它的运行标记
 * 所在的回答往前找；还在跑的一轮从会话末尾往前找——与它收尾后找到的是同一条。
 */
function findRoundPrompt(messages: readonly ChatMessage[], endIndex: number): string {
  for (let cursor = endIndex - 1; cursor >= 0; cursor -= 1) {
    const message = messages[cursor]
    if (message.role !== 'user' || message.conversationKind === 'system-notice') continue
    const text = readMessageText(message)
    if (text) return text
    if (message.attachments?.length) return message.attachments.map((file) => file.name).join(', ')
  }
  return ''
}

/** 没改文件的一轮不进面板；采集失败的一轮要进，面板里说明读不出来。 */
function hasRoundChanges(summary: WorkbenchChatRunChangesSummary): boolean {
  return summary.fileCount > 0 || !!summary.error
}

/** 一个会话里改过文件的轮次，最近的在前（还在跑的那一轮排最前）。 */
export function listWorkbenchAiChangeRounds(
  session: WorkbenchAiChangeRoundSource
): WorkbenchAiChangeRound[] {
  const messageIndexes = new Map(session.messages.map((message, index) => [message.id, index]))
  const markers = [...session.messageRunMarkers].sort(
    (left, right) => left.timestamp - right.timestamp
  )
  const toRound = (
    summary: WorkbenchChatRunChangesSummary,
    promptEndIndex: number,
    runNumber: number,
    live: boolean
  ): WorkbenchAiChangeRound => ({
    key: getWorkbenchAiChangeRoundKey(session.id, summary.recordId),
    sessionId: session.id,
    recordId: summary.recordId,
    capturedAt: summary.capturedAt,
    fileCount: summary.fileCount,
    additions: summary.additions,
    deletions: summary.deletions,
    error: summary.error,
    prompt: findRoundPrompt(session.messages, promptEndIndex),
    runNumber,
    live,
  })

  const rounds = markers.flatMap((marker, index) =>
    marker.runChanges && hasRoundChanges(marker.runChanges)
      ? [
          toRound(
            marker.runChanges,
            messageIndexes.get(marker.messageId) ?? session.messages.length,
            index + 1,
            false
          ),
        ]
      : []
  )
  const live = session.liveRunChanges
  if (live && hasRoundChanges(live.summary)) {
    // 这一轮排在开跑前那些轮之后：它收尾时记下的运行标记（若已记上）不算在前面。
    const earlierRuns = markers.filter(
      (marker) => (messageIndexes.get(marker.messageId) ?? Infinity) < live.firstMessageIndex
    ).length
    rounds.push(toRound(live.summary, session.messages.length, earlierRuns + 1, true))
  }
  return rounds.reverse()
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
