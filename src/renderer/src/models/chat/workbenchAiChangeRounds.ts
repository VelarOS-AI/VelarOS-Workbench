import { type ChatMessage } from '@velaros-ai/ui/conversation/contracts'

import type {
  WorkbenchChatRunChangesSummary,
  WorkbenchChatRunFileChange,
} from '@shared/workbenchGit'

import {
  buildWorkbenchPatchDiffRows,
  type WorkbenchUnifiedDiffRow,
} from '../git/workbenchGitDiffModel'

export interface WorkbenchAiChangeRoundSource {
  readonly id: string
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
 * 所在的回答往前找。
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

/** 一个会话里改过文件的轮次，最近的在前。 */
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
    runNumber: number
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
  })

  const rounds = markers.flatMap((marker, index) =>
    marker.runChanges && hasRoundChanges(marker.runChanges)
      ? [
          toRound(
            marker.runChanges,
            messageIndexes.get(marker.messageId) ?? session.messages.length,
            index + 1
          ),
        ]
      : []
  )
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
    .map((change): WorkbenchAiChangeTreeNode => ({
      kind: 'file',
      key: `file:${change.path}`,
      name: change.path.slice(change.path.lastIndexOf('/') + 1),
      path: change.path,
      change,
    }))
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
  | { readonly kind: 'rows'; readonly rows: WorkbenchUnifiedDiffRow[] }
  | { readonly kind: 'binary' }
  | { readonly kind: 'omitted' }
  | { readonly kind: 'empty' }

/** 按提交顺序显示归档的补丁。 */
export function buildWorkbenchAiChangeDiffView(
  change: WorkbenchChatRunFileChange
): WorkbenchAiChangeDiffView {
  if (change.binary) return { kind: 'binary' }
  const rows = change.patches.flatMap(buildWorkbenchPatchDiffRows)
  if (rows.length > 0) return { kind: 'rows', rows }
  return { kind: change.patchOmitted ? 'omitted' : 'empty' }
}
