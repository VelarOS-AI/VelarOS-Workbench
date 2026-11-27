import { isAbsolute, normalize } from 'node:path'

import { formatPatch, parsePatch } from 'diff'

import type { ActTracePage, ActTraceQuery } from '@velaros-ai/velaros'
import {
  isArray,
  isFalse,
  isFiniteNumber,
  isNull,
  isPlainObject,
  isPresent,
  isString,
  isTrue,
  Log,
} from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'

import type { WorkbenchChatRunFileChange } from '../../shared/workbenchGit'

type TraceReader = (query: ActTraceQuery) => Promise<ActTracePage>
type Invocation = ActTracePage['turns'][number]['invocations'][number]

const Limits = {
  files: 1000,
  pathChars: 4096,
  patchFiles: 200,
  patchLinesPerFile: 4000,
  patchCharsPerFile: 256 * 1024,
  patchCharsTotal: 1024 * 1024,
}
const log = Log.tag('WorkbenchConversationCommits')

interface Commit {
  key: string
  transactionKey: string
  root: string
  paths: string[]
  diff: string
  patchOmitted: boolean
  oldRevisions: Record<string, unknown>
  newRevisions: Record<string, unknown>
  fileStats: Record<string, { additions: number; deletions: number }>
}

interface CommitChanges {
  changes: WorkbenchChatRunFileChange[]
  omittedFiles: number
}

/** 复用项目提交的权威回执，按运行边界排除旧事务与其他会话。 */
export class WorkbenchConversationCommits {
  private readonly previous = new Set<string>()
  private readonly cursors = new Map<string, TraceCursor>()

  public constructor(
    private readonly sessionId: string,
    private readonly workspace: string,
    private readonly read: TraceReader
  ) {}

  public async prepare(signal: AbortSignal): Promise<void> {
    const invocations = await readInvocations(this.read, this.sessionId, this.cursors, true, signal)
    for (const { sessionId, invocation } of invocations) {
      const commit = readCommit(sessionId, invocation)
      if (commit && rootKey(commit.root) === rootKey(this.workspace))
        this.previous.add(commit.transactionKey)
      else this.previous.add(`${sessionId}:${invocation.id}`)
    }
    signal.throwIfAborted()
  }

  public async collect(turnIds: readonly string[], signal: AbortSignal): Promise<CommitChanges> {
    const invocations = await readInvocations(
      this.read,
      this.sessionId,
      this.cursors,
      false,
      signal,
      turnIds
    )
    signal.throwIfAborted()
    const seen = new Set(this.previous)
    const files = new Map<string, WorkbenchChatRunFileChange>()
    const patchedFiles = new Set<string>()
    const omitted = new Set<string>()
    let patchChars = 0
    for (const { sessionId, invocation } of invocations) {
      const commit = readCommit(sessionId, invocation)
      if (
        !commit ||
        rootKey(commit.root) !== rootKey(this.workspace) ||
        seen.has(commit.key) ||
        seen.has(commit.transactionKey)
      )
        continue
      seen.add(commit.transactionKey)
      const patches = splitPatches(commit.patchOmitted ? '' : commit.diff)
      for (const path of commit.paths) {
        if (!safePath(path)) continue
        let file = files.get(path)
        if (!file) {
          if (files.size >= Limits.files) {
            omitted.add(path)
            continue
          }
          file = {
            path,
            status:
              commit.newRevisions[path] === 'deleted'
                ? 'deleted'
                : path in commit.newRevisions && !(path in commit.oldRevisions)
                  ? 'added'
                  : 'modified',
            additions: 0,
            deletions: 0,
            binary: false,
            patches: [],
            patchOmitted: false,
            statsOmitted: false,
          }
          files.set(path, file)
        } else file.status = 'modified'
        const stats = commit.fileStats[path]
        const filePatches = patches.get(path) ?? []
        file.additions +=
          stats?.additions ?? filePatches.reduce((sum, patch) => sum + patch.additions, 0)
        file.deletions +=
          stats?.deletions ?? filePatches.reduce((sum, patch) => sum + patch.deletions, 0)
        file.statsOmitted ||= !stats && filePatches.length === 0
        file.patchOmitted ||= commit.patchOmitted
        let fileChars = file.patches.reduce((sum, patch) => sum + patch.length, 0)
        if (file.additions + file.deletions > Limits.patchLinesPerFile) {
          patchChars -= fileChars
          file.patches = []
          patchedFiles.delete(path)
          file.patchOmitted = true
          continue
        }
        for (const patch of filePatches) {
          if (
            fileChars + patch.text.length > Limits.patchCharsPerFile ||
            patchChars + patch.text.length > Limits.patchCharsTotal ||
            (!patchedFiles.has(path) && patchedFiles.size >= Limits.patchFiles)
          ) {
            file.patchOmitted = true
            continue
          }
          file.patches.push(patch.text)
          fileChars += patch.text.length
          patchChars += patch.text.length
          patchedFiles.add(path)
        }
      }
    }
    return { changes: [...files.values()], omittedFiles: omitted.size }
  }
}

/** 基线尾记录重读一次以接住迟到回执；模型请求与活动各自保持游标。 */
interface TraceCursor {
  after?: number
  activityAfter?: number
}

/** 两套游标独立推进；同一调用在回合与活动中重复出现时只留一份。 */
async function readInvocations(
  read: TraceReader,
  rootSessionId: string,
  cursors: Map<string, TraceCursor>,
  baseline = false,
  signal?: AbortSignal,
  turnIds?: readonly string[]
): Promise<Array<{ sessionId: string; invocation: Invocation }>> {
  const sessions = new Set([rootSessionId])
  const records = new Map<string, { sessionId: string; invocation: Invocation }>()
  const childSessions = new Set<string>()
  const executionIds = new Set<string>()
  for (const sessionId of sessions) {
    const cursor = cursors.get(sessionId)
    let after = cursor?.after
    let activityAfter = cursor?.activityAfter
    let lastTurn = 0
    let lastActivity = 0
    let pendingActivity = Number.POSITIVE_INFINITY
    let turnsDone = false
    let activityDone = false
    do {
      signal?.throwIfAborted()
      const page = await read({
        sessionId,
        after: turnsDone ? Number.MAX_SAFE_INTEGER : after,
        activityAfter: activityDone ? Number.MAX_SAFE_INTEGER : activityAfter,
        limit: 32,
        activityLimit: 32,
        fullContent: true,
      })
      if (page.rootSessionId !== rootSessionId || page.sessionId !== sessionId)
        throw new AppError('PERMISSION', 'Trace session ownership does not match')
      for (const turn of page.turns) lastTurn = Math.max(lastTurn, turn.request.sequence)
      for (const entry of page.sessionActivity.entries) {
        lastActivity = Math.max(lastActivity, entry.startedSequence)
        if (!entry.resultRef) pendingActivity = Math.min(pendingActivity, entry.startedSequence)
      }
      const selectedTurns =
        turnIds && sessionId === rootSessionId
          ? page.turns.filter((turn) => turnIds.includes(turn.turnId))
          : page.turns
      for (const turn of selectedTurns) {
        for (const execution of turn.executions ?? []) executionIds.add(execution.executionId)
        for (const agent of turn.agents ?? []) {
          childSessions.add(agent.sessionId)
          if (turnIds) sessions.add(agent.sessionId)
        }
      }
      for (const branch of page.branches)
        if (
          branch.rootSessionId === rootSessionId &&
          (!turnIds || childSessions.has(branch.sessionId))
        )
          sessions.add(branch.sessionId)
      const invocations = [
        ...(!turnsDone ? selectedTurns.flatMap((turn) => turn.invocations) : []),
        ...(!activityDone
          ? page.sessionActivity.entries
              .filter(
                (entry) =>
                  !turnIds || sessionId !== rootSessionId || executionIds.has(entry.executionId)
              )
              .flatMap((entry) => entry.invocations)
          : []),
      ]
      for (const invocation of invocations)
        records.set(`${sessionId}:${invocation.id}`, { sessionId, invocation })
      if (!turnsDone) {
        const next = page.nextAfter
        if (isNull(next)) turnsDone = true
        else if (isPresent(after) && next <= after)
          throw new AppError('PROTOCOL', 'Trace turn cursor did not advance')
        else after = next
      }
      if (!activityDone) {
        const next = page.sessionActivity.nextAfter
        if (isNull(next)) activityDone = true
        else if (isPresent(activityAfter) && next <= activityAfter)
          throw new AppError('PROTOCOL', 'Trace activity cursor did not advance')
        else activityAfter = next
      }
    } while (!turnsDone || !activityDone)
    if (baseline)
      cursors.set(sessionId, {
        after: lastTurn ? lastTurn - 1 : undefined,
        activityAfter: lastActivity ? Math.min(lastActivity, pendingActivity) - 1 : undefined,
      })
  }
  return [...records.values()]
}

/** 优先用完整领域回执；正文被裁剪时只读 Runtime 从同一诊断提取的独立提交事实。 */
function readCommit(sessionId: string, invocation: Invocation): Nullable<Commit> {
  if (invocation.truncated || !invocation.body) {
    const { projectChange, moduleId, operation, effect } = invocation.summary
    if (
      !projectChange ||
      moduleId !== 'velaros:project' ||
      effect !== 'committed' ||
      operation !== 'commit' ||
      projectChange.lifecycle !== 'applied'
    )
      return null
    return {
      key: `${sessionId}:${invocation.id}`,
      transactionKey: JSON.stringify([
        sessionId,
        rootKey(projectChange.root),
        projectChange.transactionId,
      ]),
      root: projectChange.root,
      paths: [...projectChange.changedFiles],
      diff: projectChange.diff,
      patchOmitted: projectChange.patchOmitted,
      oldRevisions: {},
      newRevisions: {},
      fileStats: readFileStats(projectChange.fileStats),
    }
  }
  try {
    const record: unknown = JSON.parse(invocation.body)
    if (!isPlainObject(record) || !isPlainObject(record.prepared) || !isPlainObject(record.receipt))
      return null
    const { prepared, receipt } = record
    if (
      prepared.sessionId !== sessionId ||
      prepared.id !== invocation.id ||
      prepared.executionId !== invocation.executionId ||
      !isPlainObject(prepared.binding) ||
      prepared.binding.moduleId !== 'velaros:project' ||
      prepared.operation !== 'commit' ||
      receipt.effect !== 'committed'
    )
      return null
    const diagnostic = receipt.diagnostic
    if (
      !isPlainObject(diagnostic) ||
      diagnostic.code !== 'PROJECT_TRANSACTION_COMMITTED' ||
      diagnostic.truncated ||
      !isString(diagnostic.message)
    )
      return null
    const fact: unknown = JSON.parse(diagnostic.message)
    if (
      !isPlainObject(fact) ||
      !isString(fact.root) ||
      !isString(fact.transactionId) ||
      fact.lifecycle !== 'applied' ||
      !isArray(fact.changedFiles) ||
      !fact.changedFiles.every(isString)
    )
      return null
    const value = isPlainObject(receipt.value) ? receipt.value : {}
    if (isFalse(value.changed)) return null
    // 领域诊断有独立的字符上限。完整成功回执仍在时，用它恢复被该上限省掉的路径。
    const completePaths = value.changedFiles
    const paths =
      isArray(completePaths) &&
      completePaths.every(isString) &&
      completePaths.length === fact.changedFiles.length + Number(fact.omittedFiles) &&
      fact.changedFiles.every((path, index) => path === completePaths[index])
        ? completePaths
        : fact.changedFiles
    return {
      key: `${sessionId}:${invocation.id}`,
      transactionKey: JSON.stringify([sessionId, rootKey(fact.root), fact.transactionId]),
      root: fact.root,
      paths,
      diff: isString(value.diff) ? value.diff : '',
      patchOmitted: isTrue(value.diffTruncated) || !value.diff,
      oldRevisions: isPlainObject(value.oldRevisions) ? value.oldRevisions : {},
      newRevisions: isPlainObject(value.newRevisions) ? value.newRevisions : {},
      fileStats: readFileStats(fact.fileStats),
    }
  } catch (error) {
    log.caught('忽略无效的受控事务回执', error)
    return null
  }
}

function rootKey(root: string): string {
  const value = normalize(root)
  return process.platform === 'win32' ? value.toLowerCase() : value
}

/** 行数独立于补丁正文保存；无完整统计的历史回执继续使用实际补丁。 */
function readFileStats(value: unknown): Commit['fileStats'] {
  if (!isPlainObject(value)) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([path, stats]) => {
      if (
        !isPlainObject(stats) ||
        !isFiniteNumber(stats.additions) ||
        !Number.isSafeInteger(stats.additions) ||
        stats.additions < 0 ||
        !isFiniteNumber(stats.deletions) ||
        !Number.isSafeInteger(stats.deletions) ||
        stats.deletions < 0
      )
        return []
      return [[path, { additions: stats.additions, deletions: stats.deletions }]]
    })
  )
}
function safePath(path: string): boolean {
  return (
    Boolean(path) &&
    path.length <= Limits.pathChars &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    !path.split('/').includes('..') &&
    !path.includes('\0')
  )
}
function splitPatches(
  diff: string
): Map<string, Array<{ text: string; additions: number; deletions: number }>> {
  const result = new Map<string, Array<{ text: string; additions: number; deletions: number }>>()
  if (!diff) return result
  try {
    for (const patch of parsePatch(diff)) {
      const path = patch.newFileName?.replace(/^b\//u, '')
      if (!path || !safePath(path)) continue
      const lines = patch.hunks.flatMap((hunk) => hunk.lines)
      const parts = result.get(path) ?? []
      parts.push({
        text: formatPatch(patch),
        additions: lines.filter((line) => line.startsWith('+')).length,
        deletions: lines.filter((line) => line.startsWith('-')).length,
      })
      result.set(path, parts)
    }
  } catch (error) {
    log.caught('受控事务补丁无法解析，保留提交文件身份', error)
  }
  return result
}
