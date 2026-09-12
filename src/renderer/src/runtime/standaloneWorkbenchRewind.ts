import { isConversationTurnInputMessage, isSystemNoticeMessage } from '@velaros-ai/agent/protocol'
import type { ConversationRewindPlan } from '@velaros-ai/ui/conversation'

import type { ChatMessage } from '@shared/contracts'

/**
 * 聊天回溯的判据层（纯函数，零 IO），与 Desktop 的 chatHistoryRewind / chatRewindNotice 同一套规则：
 * ① 这次回溯会移除什么（预览，喂确认框）；② 文件能不能跟着回；③ 回完之后世界和对话对不对得上
 * （决定要不要给模型留说明）。判据只建立在能证明的东西上：被移除消息里的工具调用、工具产出的
 * changedFiles、检查点是否存在、还原的实际结果。
 *
 * Workbench 的会话固定绑一个项目根，所以文件轴永远在（没有 Desktop 的「系统 / 浏览器空间」分支），
 * 快照也只有一个根。
 */

/** 每轮开跑前拍下的检查点：对话边界 + 项目工作树的 git 影子提交。 */
export interface StandaloneChatCheckpoint {
  readonly id: string
  /** 捕获瞬间 messages 的长度（= 本轮那条用户消息的下标），**永不推进**；回溯选点的唯一依据。 */
  readonly captureMessageCount: number
  readonly createdAt: number
  /** null：项目不是 git 仓库或捕获失败——这一轮只能回溯对话。 */
  readonly commitId: string | null
}

/** 单个会话保留的检查点上限；超出时淘汰最旧的（其影子 ref 交由调用方清理）。 */
const MaxRetainedCheckpoints = 80
/** 回溯说明里最多列几条路径 / 工具名，超出部分折成「等 N 项」。 */
const NoticeListCap = 12

export function appendStandaloneCheckpoint(
  checkpoints: readonly StandaloneChatCheckpoint[],
  checkpoint: StandaloneChatCheckpoint
): { checkpoints: StandaloneChatCheckpoint[]; evicted: StandaloneChatCheckpoint[] } {
  const combined = [...checkpoints, checkpoint]
  const overflow = Math.max(0, combined.length - MaxRetainedCheckpoints)
  return { checkpoints: combined.slice(overflow), evicted: combined.slice(0, overflow) }
}

/** 被移除区间的世界改动清点。 */
export interface RewindRemovalSurvey {
  removedMessageCount: number
  removedTurnCount: number
  toolCallCount: number
  toolNames: string[]
  changedFilePaths: string[]
  /** 被一并移除的上一次回溯说明条数——那次错位的记录随本次回溯消失，必须在新说明里接上。 */
  removedNoticeCount: number
}

export interface StandaloneRewindSelection {
  /** 目标消息在 messages 里的下标：它和它之后的消息都会被移除。 */
  targetIndex: number
  removedMessages: ChatMessage[]
  /** 目标那一轮开跑前的检查点（文件回退的还原点）；没有则只能回溯对话。 */
  checkpoint: StandaloneChatCheckpoint | null
  keptCheckpoints: StandaloneChatCheckpoint[]
  /** 目标之后的检查点：回溯后它们描述的是不存在的未来，影子 ref 要清掉。 */
  evictedCheckpoints: StandaloneChatCheckpoint[]
}

export function selectStandaloneRewind(
  messages: readonly ChatMessage[],
  checkpoints: readonly StandaloneChatCheckpoint[],
  messageId: string
): StandaloneRewindSelection | null {
  const targetIndex = messages.findIndex((message) => message.id === messageId)
  if (targetIndex < 0) return null
  const keptCheckpoints = checkpoints.filter(
    (checkpoint) => checkpoint.captureMessageCount <= targetIndex
  )
  return {
    targetIndex,
    removedMessages: messages.slice(targetIndex),
    checkpoint: keptCheckpoints.at(-1) ?? null,
    keptCheckpoints,
    evictedCheckpoints: checkpoints.filter(
      (checkpoint) => checkpoint.captureMessageCount > targetIndex
    ),
  }
}

export function surveyRewindRemoval(removedMessages: readonly ChatMessage[]): RewindRemovalSurvey {
  const toolNames = new Set<string>()
  const changedFilePaths = new Set<string>()
  let toolCallCount = 0
  let removedTurnCount = 0
  let removedNoticeCount = 0

  for (const message of removedMessages) {
    if (isConversationTurnInputMessage(message)) removedTurnCount += 1
    if (isSystemNoticeMessage(message)) removedNoticeCount += 1
    for (const block of message.blocks) {
      if (block.type !== 'tool-call') continue
      // 只数已完成的：中止运行会留下 isRunning 且无结果的 block，把它算成「执行过」会让说明失真。
      const finished = !block.isRunning
        && (block.result !== undefined || !!block.serializedResult || !!block.error)
      const name = block.toolName.trim()
      if (finished && name) {
        toolNames.add(name)
        toolCallCount += 1
      }
      for (const path of readChangedFilePaths(block.result)) changedFilePaths.add(path)
    }
  }

  return {
    removedMessageCount: removedMessages.length,
    removedTurnCount,
    toolCallCount,
    toolNames: [...toolNames],
    changedFilePaths: [...changedFilePaths],
    removedNoticeCount,
  }
}

function readChangedFilePaths(result: unknown): string[] {
  if (!isRecord(result)) return []
  const paths: string[] = []
  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) return
    for (const path of value) if (typeof path === 'string' && path.trim()) paths.push(path)
  }
  collect(result.changedFiles)
  if (Array.isArray(result.transactions))
    for (const entry of result.transactions) if (isRecord(entry)) collect(entry.changedFiles)
  return paths
}

export function resolveRewindFileCapability(input: {
  checkpoint: StandaloneChatCheckpoint | null
  changedFilePaths: readonly string[]
  toolCallCount: number
}): ConversationRewindPlan['files'] {
  // 闸门是「有没有跑过工具」而不是「有没有 changedFiles 证据」：模型用命令行 `sed -i` / 生成脚本
  // 改文件时一条证据都没有，拿证据当闸门会让用户在快照明明在手时连「同时回退文件」都看不到。
  if (input.toolCallCount === 0) return { kind: 'nothing-to-restore' }
  if (!input.checkpoint?.commitId)
    return { kind: 'no-snapshot', changedFileCount: input.changedFilePaths.length }
  return { kind: 'restorable', changedFileCount: input.changedFilePaths.length, rootCount: 1 }
}

export function buildRewindPlan(input: {
  survey: RewindRemovalSurvey
  files: ConversationRewindPlan['files']
}): ConversationRewindPlan {
  return {
    removedMessageCount: input.survey.removedMessageCount,
    removedTurnCount: input.survey.removedTurnCount,
    toolCallCount: input.survey.toolCallCount,
    files: input.files,
  }
}

/** 文件回退的实际结果（不是意图）。 */
export interface RewindFileOutcome {
  attempted: boolean
  restored: boolean
  error: string | null
}

export const NoRewindFileOutcome: RewindFileOutcome = Object.freeze({
  attempted: false,
  restored: false,
  error: null,
})

/**
 * 回溯保真度：`clean` = 被移除区间一次工具都没调过，世界没被动过，不留痕；`files-restored` =
 * 文件已按快照还原（文件之外的影响仍没撤销）；`diverged` = 对话回到了过去、世界停在未来。
 */
export type RewindFidelity = 'clean' | 'files-restored' | 'diverged'

export function resolveRewindFidelity(input: {
  survey: RewindRemovalSurvey
  fileOutcome: RewindFileOutcome
}): RewindFidelity {
  // 被移除区间里带着上一次回溯说明 = 那次错位还没被处理，这次不可能是干净的时光倒流。
  const hadPriorDivergence = input.survey.removedNoticeCount > 0
  if (input.survey.toolCallCount === 0 && !hadPriorDivergence) return 'clean'
  if (input.fileOutcome.restored && !hadPriorDivergence) return 'files-restored'
  return 'diverged'
}

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * 生成回溯说明（`clean` 返回 null）。非幂等的回溯必须给模型留一条看得见的说明，否则它会拿着
 * 已经不存在的历史去操作一个已经变了的工作区。说明只陈述写下时的事实，并带上文件路径。
 */
export function buildRewindNoticeText(input: {
  t: Translate
  fidelity: RewindFidelity
  survey: RewindRemovalSurvey
  fileOutcome: RewindFileOutcome
}): { summary: string; detail: string } | null {
  const { t, fidelity, survey, fileOutcome } = input
  if (fidelity === 'clean') return null

  const formatList = (values: readonly string[]): string => {
    const separator = t('workbench.chatRewindNoticeListSeparator')
    if (values.length <= NoticeListCap) return values.join(separator)
    return t('workbench.chatRewindNoticeListOverflow', {
      items: values.slice(0, NoticeListCap).join(separator),
      rest: values.length - NoticeListCap,
    })
  }
  const counts = { turns: survey.removedTurnCount, messages: survey.removedMessageCount }
  const fileParagraph = fileOutcome.attempted && !fileOutcome.restored
    ? t('workbench.chatRewindNoticeFilesRestoreFailed', { error: fileOutcome.error ?? '' })
    : fidelity === 'files-restored'
      ? t('workbench.chatRewindNoticeFilesRestored')
      : survey.changedFilePaths.length === 0
        ? t('workbench.chatRewindNoticeFilesUntouched')
        : t('workbench.chatRewindNoticeFilesKept', { files: formatList(survey.changedFilePaths) })

  const paragraphs = [
    survey.toolCallCount > 0
      ? t('workbench.chatRewindNoticeRemoved', {
          ...counts,
          tools: survey.toolCallCount,
          toolNames: formatList(survey.toolNames),
        })
      : t('workbench.chatRewindNoticeRemovedNoTools', counts),
    survey.removedNoticeCount > 0
      ? t('workbench.chatRewindNoticeCarriedDivergence', { notices: survey.removedNoticeCount })
      : '',
    fileParagraph,
    t('workbench.chatRewindNoticeGuidance'),
  ]

  return {
    summary: t(
      fidelity === 'files-restored'
        ? 'workbench.chatRewindNoticeSummaryRestored'
        : 'workbench.chatRewindNoticeSummaryDiverged',
      counts
    ),
    detail: paragraphs.filter(Boolean).join('\n'),
  }
}

/**
 * 宿主写的留痕：user role 传输、`system-notice` 语义，模型侧由 main 包进 `<sys_note>` 信封。
 * `kind` 只决定通知行的图标，缺省是会话回溯。
 */
export function createStandaloneSystemNotice(input: {
  id: string
  summary: string
  detail: string
  timestamp: number
  kind?: ChatMessage['systemNoticeKind']
}): ChatMessage {
  return {
    id: input.id,
    role: 'user',
    conversationKind: 'system-notice',
    ...(input.kind ? { systemNoticeKind: input.kind } : {}),
    blocks: [
      { type: 'text', text: input.summary },
      { type: 'text', text: input.detail },
    ],
    timestamp: input.timestamp,
  }
}

export function isStoredStandaloneCheckpoint(value: unknown): value is StandaloneChatCheckpoint {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.captureMessageCount === 'number'
    && Number.isInteger(value.captureMessageCount)
    && value.captureMessageCount >= 0
    && typeof value.createdAt === 'number'
    && (value.commitId === null || typeof value.commitId === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
