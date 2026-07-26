import { isEmpty, isPresent, toNullable } from '@velaros-ai/core'

import type {
  ChatMessage,
  SystemFileChangePreviewResult,
  WorkspaceCheckpointFileDiff,
} from '../../contracts/index'
import { extractMessageFileChangeDescriptors } from '../actions/messageFileChanges'

/** Workbench 归档只消费宿主会话的最小只读投影，不拥有 Desktop 的聊天状态模型。 */
export interface WorkbenchAiChangeArchiveFolderSource {
  readonly id: string
  readonly title: string
  readonly updatedAt: number
  readonly archivedAt: Nullable<number>
  readonly surfaceScope: Nullable<{
    readonly surface: string
    readonly projectRoot: string
  }>
  readonly memberSessionIds: readonly string[]
}

export interface WorkbenchAiChangeArchiveSessionSource {
  readonly id: string
  readonly rootPath: Nullable<string>
  readonly messages: readonly ChatMessage[]
  readonly messageRunMarkers: ReadonlyArray<{
    readonly messageId: string
    readonly timestamp: number
    readonly workspaceCheckpointDiff?: {
      readonly changes: readonly WorkspaceCheckpointFileDiff[]
    }
  }>
  readonly workerThreads: ReadonlyArray<{
    readonly messages: readonly ChatMessage[]
  }>
}

export interface WorkbenchAiChangeArchiveSnapshotRef {
  id: string
  sessionId: string
  changeId: string
  path: string
  timestamp: number
  preview?: SystemFileChangePreviewResult
}

export interface WorkbenchAiChangeArchiveEntry {
  id: string
  conversationId: string
  roundId: string
  path: string
  rootPath: string
  status: 'added' | 'deleted' | 'modified'
  snapshotRefs: WorkbenchAiChangeArchiveSnapshotRef[]
  workspaceDiff: Nullable<WorkspaceCheckpointFileDiff>
}

export interface WorkbenchAiChangeArchiveRound {
  id: string
  number: number
  timestamp: number
  prompt: string
  entries: WorkbenchAiChangeArchiveEntry[]
}

export interface WorkbenchAiChangeArchiveConversation {
  id: string
  title: string
  updatedAt: number
  archived: boolean
  rounds: WorkbenchAiChangeArchiveRound[]
}

export interface WorkbenchAiChangeArchive {
  conversations: WorkbenchAiChangeArchiveConversation[]
  fileCount: number
  roundCount: number
}

export interface WorkbenchAiChangeArchiveDisplayRound {
  id: string
  number: number
  conversationId: string
  round: WorkbenchAiChangeArchiveRound
}

export interface WorkbenchAiChangeArchiveSelectionTarget {
  sessionId: string
  path: string
  changeIds?: readonly string[]
}

export function getWorkbenchAiChangeArchiveRoundId(
  conversationId: string,
  roundId: string
): string {
  return `${conversationId}\0${roundId}`
}

export function listWorkbenchAiChangeArchiveRounds(
  archive: WorkbenchAiChangeArchive
): WorkbenchAiChangeArchiveDisplayRound[] {
  return archive.conversations
    .flatMap((conversation) =>
      conversation.rounds.map((round) => ({
        id: getWorkbenchAiChangeArchiveRoundId(conversation.id, round.id),
        conversationId: conversation.id,
        round,
      }))
    )
    .sort((left, right) => left.round.timestamp - right.round.timestamp)
    .map((item, index) => ({ ...item, number: index + 1 }))
}

/**
 * 快照请求只跟真实的文件变更边界走，不跟 archive 重建后的对象引用走。
 * assistant 流式更新会频繁重建 entry；若 effect 直接依赖 entry，会反复清空并重读同一快照。
 */
export function getWorkbenchAiChangeSnapshotRequestKey(
  entry: Nullable<WorkbenchAiChangeArchiveEntry>
): string {
  if (!entry) return ''

  const firstRef = entry.snapshotRefs[0]
  const lastRef = entry.snapshotRefs.at(-1)
  return [
    entry.id,
    firstRef?.id ?? '',
    firstRef?.preview ? 'inline' : 'remote',
    lastRef?.id ?? '',
    lastRef?.preview ? 'inline' : 'remote',
    entry.workspaceDiff ? 'with-diff' : 'without-diff',
  ].join('\0')
}

interface SessionTranscript {
  session: WorkbenchAiChangeArchiveSessionSource
  messages: ChatMessage[]
}

interface RoundAccumulator {
  id: string
  timestamp: number
  prompt: string
  entries: Map<string, WorkbenchAiChangeArchiveEntry>
}

function normalizeRoot(path: LooseOptional<string>): string {
  return (path ?? '').trim().replaceAll('\\', '/').replace(/\/+$/u, '')
}

function normalizeArchivePath(path: string, projectRoot: string): string {
  const normalizedPath = path.trim().replaceAll('\\', '/')
  const normalizedRoot = normalizeRoot(projectRoot)
  if (normalizedPath === normalizedRoot) return '.'
  if (normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`))
    return normalizedPath.slice(normalizedRoot.length + 1)
  return normalizedPath.replace(/^\.\//u, '').replace(/^\/+/, '')
}

function isProjectRoot(root: LooseOptional<string>, projectRoot: string): boolean {
  return normalizeRoot(root) === normalizeRoot(projectRoot)
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

function resolveRoundKey(
  message: ChatMessage,
  sessionId: string,
  currentRoundKey: Nullable<string>
): string {
  const explicit = message.runId?.trim() || message.turnId?.trim()
  if (explicit) return `run:${explicit}`
  if (currentRoundKey) return currentRoundKey
  return `${sessionId}:message:${message.id}`
}

function getOrCreateRound(
  rounds: Map<string, RoundAccumulator>,
  id: string,
  timestamp: number
): RoundAccumulator {
  const existing = rounds.get(id)
  if (existing) {
    existing.timestamp = Math.min(existing.timestamp, timestamp)
    return existing
  }

  const created: RoundAccumulator = {
    id,
    timestamp,
    prompt: '',
    entries: new Map(),
  }
  rounds.set(id, created)
  return created
}

function getOrCreateEntry(
  round: RoundAccumulator,
  input: {
    conversationId: string
    path: string
    projectRoot: string
    status: WorkbenchAiChangeArchiveEntry['status']
  }
): WorkbenchAiChangeArchiveEntry {
  const path = normalizeArchivePath(input.path, input.projectRoot)
  const key = path.toLocaleLowerCase('en-US')
  const existing = round.entries.get(key)
  if (existing) {
    if (input.status === 'deleted' || existing.status !== 'deleted') {
      existing.status = input.status
    }
    return existing
  }

  const created: WorkbenchAiChangeArchiveEntry = {
    id: `${input.conversationId}\0${round.id}\0${path}`,
    conversationId: input.conversationId,
    roundId: round.id,
    path,
    rootPath: input.projectRoot,
    status: input.status,
    snapshotRefs: [],
    workspaceDiff: null,
  }
  round.entries.set(key, created)
  return created
}

function addMessageDescriptors(input: {
  conversationId: string
  projectRoot: string
  round: RoundAccumulator
  session: WorkbenchAiChangeArchiveSessionSource
  message: ChatMessage
}): void {
  const descriptors = extractMessageFileChangeDescriptors(input.message)
  for (const descriptor of descriptors) {
    const previewRoot = descriptor.preview?.rootPath
    const ownerRoot = previewRoot ?? input.session.rootPath
    if (ownerRoot && !isProjectRoot(ownerRoot, input.projectRoot)) continue

    const entry = getOrCreateEntry(input.round, {
      conversationId: input.conversationId,
      path: descriptor.path,
      projectRoot: input.projectRoot,
      status: descriptor.created ? 'added' : 'modified',
    })
    const refId = `${input.session.id}\0${descriptor.changeId}\0${descriptor.path}`
    if (entry.snapshotRefs.some((ref) => ref.id === refId)) continue

    entry.snapshotRefs.push({
      id: refId,
      sessionId: input.session.id,
      changeId: descriptor.changeId,
      path: descriptor.path,
      timestamp: input.message.timestamp,
      preview: descriptor.preview,
    })
  }
}

function addWorkspaceDiffs(input: {
  conversationId: string
  projectRoot: string
  round: RoundAccumulator
  changes: readonly WorkspaceCheckpointFileDiff[]
}): void {
  for (const change of input.changes) {
    if (!isProjectRoot(change.root, input.projectRoot)) continue

    const entry = getOrCreateEntry(input.round, {
      conversationId: input.conversationId,
      path: change.path,
      projectRoot: input.projectRoot,
      status: change.status,
    })
    entry.workspaceDiff = change
  }
}

function buildConversation(
  folder: WorkbenchAiChangeArchiveFolderSource,
  transcripts: readonly SessionTranscript[],
  projectRoot: string
): Nullable<WorkbenchAiChangeArchiveConversation> {
  const rounds = new Map<string, RoundAccumulator>()
  const roundKeyByMessageId = new Map<string, string>()

  for (const { session, messages } of transcripts) {
    let currentRoundKey: Nullable<string> = null
    for (const message of messages) {
      if (message.role === 'user') {
        currentRoundKey = resolveRoundKey(message, session.id, null)
      }
      const roundKey = resolveRoundKey(message, session.id, currentRoundKey)
      roundKeyByMessageId.set(`${session.id}\0${message.id}`, roundKey)
      const round = getOrCreateRound(rounds, roundKey, message.timestamp)
      if (message.role === 'user' && !round.prompt) {
        round.prompt = readMessageText(message)
      }
      if (message.role === 'assistant') {
        addMessageDescriptors({
          conversationId: folder.id,
          projectRoot,
          round,
          session,
          message,
        })
      }
    }

    for (const marker of session.messageRunMarkers) {
      const roundKey = roundKeyByMessageId.get(`${session.id}\0${marker.messageId}`)
      if (!roundKey || !marker.workspaceCheckpointDiff) continue
      const round = getOrCreateRound(rounds, roundKey, marker.timestamp)
      addWorkspaceDiffs({
        conversationId: folder.id,
        projectRoot,
        round,
        changes: marker.workspaceCheckpointDiff.changes,
      })
    }
  }

  const chronologicalRounds = [...rounds.values()].sort(
    (left, right) => left.timestamp - right.timestamp
  )
  const visibleRounds = chronologicalRounds
    .map(
      (round, index): WorkbenchAiChangeArchiveRound => ({
        id: round.id,
        number: index + 1,
        timestamp: round.timestamp,
        prompt: round.prompt,
        entries: [...round.entries.values()]
          .map((entry) => ({
            ...entry,
            snapshotRefs: [...entry.snapshotRefs].sort(
              (left, right) => left.timestamp - right.timestamp
            ),
          }))
          .sort((left, right) => left.path.localeCompare(right.path, 'en')),
      })
    )
    .filter((round) => !isEmpty(round.entries))
    .reverse()

  if (isEmpty(visibleRounds)) return null

  return {
    id: folder.id,
    title: folder.title.trim() || 'Workbench',
    updatedAt: folder.updatedAt,
    archived: isPresent(folder.archivedAt),
    rounds: visibleRounds,
  }
}

export function buildWorkbenchAiChangeArchive(input: {
  folders: readonly WorkbenchAiChangeArchiveFolderSource[]
  sessions: readonly WorkbenchAiChangeArchiveSessionSource[]
  projectRoot: string
  olderMessagesBySession?: ReadonlyMap<string, readonly ChatMessage[]>
}): WorkbenchAiChangeArchive {
  const sessionById = new Map(input.sessions.map((session) => [session.id, session]))
  const projectFolders = input.folders.filter(
    (folder) =>
      folder.surfaceScope?.surface === 'workbench' &&
      isProjectRoot(folder.surfaceScope.projectRoot, input.projectRoot)
  )
  const conversations = projectFolders
    .map((folder) => {
      const transcripts = folder.memberSessionIds
        .map((sessionId): Nullable<SessionTranscript> => {
          const session = sessionById.get(sessionId)
          if (!session) return null
          const olderMessages = input.olderMessagesBySession?.get(sessionId) ?? []
          const workerMessages = session.workerThreads.flatMap((thread) => thread.messages)
          const seen = new Set<string>()
          const messages = [...olderMessages, ...session.messages, ...workerMessages]
            .filter((message) => {
              if (seen.has(message.id)) return false
              seen.add(message.id)
              return true
            })
            .sort((left, right) => left.timestamp - right.timestamp)
          return { session, messages }
        })
        .filter(isPresent)
      return buildConversation(folder, transcripts, input.projectRoot)
    })
    .filter(isPresent)
    .sort((left, right) => right.updatedAt - left.updatedAt)

  const rounds = conversations.flatMap((conversation) => conversation.rounds)
  return {
    conversations,
    roundCount: rounds.length,
    fileCount: rounds.reduce((total, round) => total + round.entries.length, 0),
  }
}

export function findWorkbenchAiChangeArchiveEntry(
  archive: WorkbenchAiChangeArchive,
  target: WorkbenchAiChangeArchiveSelectionTarget
): Nullable<WorkbenchAiChangeArchiveEntry> {
  const changeIds = new Set(target.changeIds ?? [])
  const targetPath = normalizeArchivePath(target.path, '')
  const entries = archive.conversations.flatMap((conversation) =>
    conversation.rounds.flatMap((round) => round.entries)
  )

  if (changeIds.size > 0) {
    const byChangeId = entries.find((entry) =>
      entry.snapshotRefs.some(
        (ref) => ref.sessionId === target.sessionId && changeIds.has(ref.changeId)
      )
    )
    if (byChangeId) return byChangeId
  }

  return toNullable(
    entries.find(
      (entry) =>
        normalizeArchivePath(entry.path, '') === targetPath &&
        entry.snapshotRefs.some((ref) => ref.sessionId === target.sessionId)
    )
  )
}
