import { AppError } from '@velaros-ai/core/error'
import type { Result } from '@velaros-ai/core/result'

import { type WorkbenchDirectoryEntry, type WorkbenchLanguageServiceFileEdit, type WorkbenchLanguageServiceFileRename, type WorkbenchLanguageServiceFileRenameEditsRequest, type WorkbenchLanguageServiceFileRenameEditsResult } from '@shared/contracts/workbench'

import type { WorkbenchOpenEditorTab } from '../../types/workbenchTypes'
import { isSameOrChildPath } from '../shared/workbenchUtils'

import { usesWorkbenchTypeScriptLanguageService } from './workbenchCodeMirrorLanguageService'
import { movePath } from './workbenchEditorTabs'
import type { WorkbenchLanguageServiceEditOutcome } from './workbenchLanguageServiceEditReport'
import type { WorkbenchLanguageServiceFileChangeFailure } from './workbenchLanguageServiceFileChanges'

/** 文件树里做成了的一次改名 / 移动。 */
export interface WorkbenchEntryMove {
  previousPath: string
  path: string
  type: WorkbenchDirectoryEntry['type']
}

/** 更新 import 的结果：改了几个文件、哪些没改成；或者语言服务没答上来（`message` 是它给的原因，超时没有）。 */
export type WorkbenchImportUpdateOutcome =
  | ({ kind: 'applied' } & WorkbenchLanguageServiceEditOutcome)
  | { kind: 'failed'; message?: string }

export interface WorkbenchImportUpdatePorts {
  /** 此刻打开的项目；没有为 null。 */
  getProjectRoot(): Nullable<string>
  /** 打开着的标签与它们的编辑缓冲。 */
  getOpenTabs(): readonly WorkbenchOpenEditorTab[]
  requestEdits(
    request: WorkbenchLanguageServiceFileRenameEditsRequest
  ): Promise<Result<WorkbenchLanguageServiceFileRenameEditsResult>>
  /** 套上改动：开着的文件改编辑缓冲，没开着的写盘。 */
  applyEdits(changes: readonly WorkbenchLanguageServiceFileEdit[]): Promise<WorkbenchLanguageServiceEditOutcome>
  /** 有话要说时才调：改了文件、有文件没改成，或者没答上来。没有 import 要改就不调。 */
  report(outcome: WorkbenchImportUpdateOutcome): void
  /** 等语言服务多久；过了就当它没答上来。 */
  timeoutMs?: number
}

export interface WorkbenchImportUpdater {
  /** 文件树里的改名 / 移动做成了：去更新引用它们的 import。不挡住调用方；返回的 Promise 在这一轮做完时结束。 */
  entriesMoved(projectRoot: string, moves: readonly WorkbenchEntryMove[]): Promise<void>
}

/** 主进程给交互请求的时限是 12 秒，到点它自己会答一个超时；这里多等一会儿，只防答复根本没回来。 */
const DefaultImportUpdateTimeoutMs = 20_000

/** 算改动的工夫里引用方又被编辑了，就按新正文重算；连着这么多轮都赶不上才放弃那个文件。 */
const MaxImportUpdateAttempts = 3

/**
 * 值得去问语言服务的移动：JavaScript / TypeScript 文件，以及目录——里面有没有这类文件由语言服务自己看，
 * 没有的话它直接答「没有改动」。
 */
export function selectWorkbenchImportUpdateRenames(
  moves: readonly WorkbenchEntryMove[]
): WorkbenchLanguageServiceFileRename[] {
  return moves
    .filter(
      (move) =>
        move.previousPath !== move.path
        && (move.type === 'directory' || usesWorkbenchTypeScriptLanguageService(move.path))
    )
    .map(({ previousPath, path }) => ({ previousPath, path }))
}

/** 一个路径经过这些改名之后在哪。 */
function followWorkbenchRenames(path: string, renames: readonly WorkbenchLanguageServiceFileRename[]): string {
  let current = path
  for (const rename of renames)
    if (isSameOrChildPath(current, rename.previousPath))
      current = movePath(current, rename.previousPath, rename.path)
  return current
}

/**
 * 上一批改名的 import 还没更新完（`pending`），又来了新的一批：合成一份一起问。
 *
 * 先前 a → b，接着 b → c（或者 b 所在的目录挪了）：引用方手里写的还是 a，该问的是 a → c。新的这一步自己也留着——
 * 上一轮可能已经把一部分引用方改成了 b。改回原名的（a → b → a）不用再问。
 */
export function composeWorkbenchImportUpdateRenames(
  pending: readonly WorkbenchLanguageServiceFileRename[],
  next: readonly WorkbenchLanguageServiceFileRename[]
): WorkbenchLanguageServiceFileRename[] {
  const composed: WorkbenchLanguageServiceFileRename[] = []
  const seen = new Set<string>()
  for (const rename of [
    ...pending.map(({ previousPath, path }) => ({ previousPath, path: followWorkbenchRenames(path, next) })),
    ...next,
  ]) {
    const key = `${rename.previousPath}\u0000${rename.path}`
    if (rename.previousPath === rename.path || seen.has(key)) continue
    seen.add(key)
    composed.push(rename)
  }
  return composed
}

const TimedOut = Symbol('timed-out')

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof TimedOut> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TimedOut), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

/**
 * 文件树里改名、移动之后更新 import 的那条线。改名本身已经做成，这里在后面慢慢算，算不出来也不回头动它。
 *
 * - 一轮一轮地做，不并行：上一轮还在套改动时又有新的改名，等它停下再问，不然新一轮照着改到一半的文件算。
 * - 后来的改名顶掉还没答复的那一轮（答复回来也不用了），两批改名合成一份重新问
 *   （见 composeWorkbenchImportUpdateRenames）。
 * - 答复回来时引用方的正文已经和发请求时不一样了（用户接着打了字、标签开了又关），那个文件的改动对不上行列，
 *   按新正文重算；连着几轮都赶不上的文件不改，报给用户。
 * - 中途换了项目，这一轮作废。
 */
export function createWorkbenchImportUpdater(ports: WorkbenchImportUpdatePorts): WorkbenchImportUpdater {
  let pending: Nullable<{ projectRoot: string; renames: WorkbenchLanguageServiceFileRename[] }> = null
  let generation = 0
  let tail: Promise<void> = Promise.resolve()

  async function run(runGeneration: number): Promise<void> {
    const job = pending
    if (runGeneration !== generation || !job) return
    const { projectRoot, renames } = job
    const isCurrent = (): boolean => runGeneration === generation
    const finish = (): void => {
      if (isCurrent()) pending = null
    }
    /** 打开着的文件此刻的正文；标签还没跟着挪到新路径的，按新路径记（那里才有文件）。 */
    const openTabs = (): Array<{ path: string; content: string }> =>
      ports.getOpenTabs().map((tab) => ({
        path: followWorkbenchRenames(tab.path, renames),
        content: tab.content,
      }))

    for (let attempt = 1; ; attempt += 1) {
      if (ports.getProjectRoot() !== projectRoot) {
        finish()
        return
      }

      const sentTabs = openTabs()
      const sent = new Map(sentTabs.map((tab) => [tab.path, tab.content]))
      const result = await withTimeout(
        ports.requestEdits({
          projectRoot,
          renames,
          // 开着的 JS/TS 文件都带上正文，不只是有未保存改动的：改动最后套在编辑缓冲上，行列就得照缓冲里的
          // 正文算（标签没改过，磁盘上的文件却可能已经被别人改了）。
          openFiles: sentTabs.filter((tab) => usesWorkbenchTypeScriptLanguageService(tab.path)),
        }),
        ports.timeoutMs ?? DefaultImportUpdateTimeoutMs
      )
      if (!isCurrent()) return
      if (ports.getProjectRoot() !== projectRoot) {
        finish()
        return
      }
      if (result === TimedOut || !result.ok) {
        finish()
        ports.report({ kind: 'failed', message: result === TimedOut ? undefined : result.error.message })
        return
      }

      const current = new Map(openTabs().map((tab) => [tab.path, tab.content]))
      const changes = result.data.changes.filter((change) => change.edits.length > 0)
      const stale = changes.filter((change) => sent.get(change.path) !== current.get(change.path))
      if (stale.length > 0 && attempt < MaxImportUpdateAttempts) continue

      // 开着的排前面：它们在同一拍里改完，来不及再被编辑；写盘的放后面慢慢来。
      const fresh = changes.filter((change) => !stale.includes(change))
      const outcome = await ports.applyEdits([
        ...fresh.filter((change) => current.has(change.path)),
        ...fresh.filter((change) => !current.has(change.path)),
      ])
      finish()
      const failures: WorkbenchLanguageServiceFileChangeFailure[] = [
        ...outcome.failures,
        ...stale.map((change) => ({ path: change.path, reason: 'changed-in-editor' as const })),
      ]
      if (outcome.changedFiles > 0 || failures.length > 0)
        ports.report({ kind: 'applied', changedFiles: outcome.changedFiles, failures })
      return
    }
  }

  return {
    entriesMoved(projectRoot, moves) {
      const renames = selectWorkbenchImportUpdateRenames(moves)
      if (renames.length === 0) return tail

      pending = {
        projectRoot,
        renames: composeWorkbenchImportUpdateRenames(
          pending?.projectRoot === projectRoot ? pending.renames : [],
          renames
        ),
      }
      generation += 1
      const runGeneration = generation
      tail = tail.then(() =>
        run(runGeneration).catch((error: unknown) => {
          if (runGeneration === generation) pending = null
          ports.report({ kind: 'failed', message: AppError.from(error).message })
        })
      )
      return tail
    },
  }
}
