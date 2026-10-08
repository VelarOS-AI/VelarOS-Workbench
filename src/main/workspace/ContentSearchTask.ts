/**
 * 内容搜索与替换里跑用户正则的那一段：逐个文件读、解码、匹配、按额度列出，以及算替换后的正文。
 *
 * 这些在搜索 worker 里跑（见 ContentSearchWorker、ContentSearchWorkerHost）：用户写的正则可能回溯很久
 * （`(\w+)+;` 碰上一长串字母），放在 Electron 主进程里会卡住所有窗口，取消的请求也送不进来；放在 worker 里，
 * 取消或久不报进度就直接结束 worker。
 *
 * - 读盘后按编辑器同一套规则解码（认编码、去 BOM、换行统一为 LF），GB18030 / UTF-16 文件照样搜得到，行列号
 *   与编辑器对得上。匹配规则见 `@shared/workbenchTextSearch`。
 * - 往前预读几个文件，按路径顺序出结果；第一批一有结果就交出，之后隔一小段时间交一批，前面的结果先显示。
 * - 搜索途中每秒报一声心跳：等读盘时事件循环照转、报得出来，卡在正则里就报不出来，主进程据此判断卡住。
 * - 列到 limit 处匹配就停（truncated）；每个文件的匹配总数照样数全，替换时说得清换几处。
 * - 调用方开着的文件（openPaths）只报在不在搜索范围里：结果由调用方在编辑器正文上算。用正则搜时先拿磁盘上
 *   的版本试跑一遍：正则要是在它上面跑不完，卡住的是这个 worker（会被结束，报出这个文件），调用方收不到这个
 *   路径，也就不会在自己的线程（窗口）里再跑一遍把界面卡死。字面查找不会回溯，不读它们。
 */
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { AppError } from '@velaros-ai/core/error'
import { type AppLocale } from '@velaros-ai/ui/conversation/contracts'

import { type WorkbenchContentSearchFileResult, type WorkbenchContentSearchMatchResult, type WorkbenchSearchContentBatch } from '@shared/contracts/workbench'
import {
  buildWorkbenchTextSearchPreview,
  compileWorkbenchTextSearch,
  replaceWorkbenchTextSearchMatches,
  scanWorkbenchTextSearch,
  WorkbenchContentSearchMaxFileBytes,
  type WorkbenchTextSearchMatcher,
  type WorkbenchTextSearchQuery,
  workbenchTextSearchRangeKey,
} from '@shared/workbenchTextSearch'

import { setWorkbenchMainLocale } from '../i18n/workbenchMainLocale'
import { workbenchMainText } from '../i18n/workbenchMainMessages'

import { decodeWorkbenchTextContent } from './TextCodec'
import { isLikelyTextFile } from './TextFile'

/** 往前预读的文件数。 */
const ReadAhead = 8
/** 第一批之后，隔这么久交出一批结果。 */
const BatchIntervalMs = 80
/** 搜索途中隔这么久报一声心跳（要远小于主进程判定卡住的时限）。 */
const HeartbeatIntervalMs = 1000

/** 在一组文件里搜。 */
export interface WorkbenchContentSearchTask {
  projectRoot: string
  /** 要搜的文件（工程相对路径），已经筛过范围、按顺序排好。 */
  paths: string[]
  /** 调用方开着的文件：只报在不在范围里（用正则时先在磁盘版本上试跑，见文件头）。 */
  openPaths: string[]
  query: WorkbenchTextSearchQuery
  /** 最多列出多少处匹配。 */
  limit: number
  /** 每个文件最多列出几处。 */
  maxResultsPerFile: number
}

/** 搜完：最后一批还没交出去的结果，加上截断与跳过的说明。 */
export interface WorkbenchContentSearchTaskResult extends WorkbenchSearchContentBatch {
  truncated: boolean
  skippedLargeFileCount: number
}

/** 替换一个文件的正文。 */
export interface WorkbenchContentReplaceTask {
  /** 去掉 BOM、换行统一为 LF 的正文。 */
  content: string
  query: WorkbenchTextSearchQuery
  replacement: string
  /** 只换这几处（起止行列的键，见 workbenchTextSearchRangeKey）；不给就全换。 */
  selectedKeys?: string[]
}

export interface WorkbenchContentReplaceTaskResult {
  content: string
  count: number
}

/** 每个请求都带着此刻的界面语言：worker 与主进程不共用模块状态，这里出的文字按它来。 */
export type WorkbenchContentSearchWorkerRequest =
  /** stream：边搜边交出批次；不要的话结果全在最后的 result 里。 */
  | {
      id: number
      kind: 'search'
      locale: AppLocale
      task: WorkbenchContentSearchTask
      stream: boolean
    }
  | { id: number; kind: 'replace'; locale: AppLocale; task: WorkbenchContentReplaceTask }

export type WorkbenchContentSearchWorkerResponse =
  /** 接下这个请求、开始干活了：主进程从这时起才算它有没有动静（起 worker 花的时间不算）。 */
  | { id: number; kind: 'started' }
  /** 开始搜这个文件了（卡住时据此说是哪个文件）。 */
  | { id: number; kind: 'file'; path: string }
  /** 还活着：事件循环在转，上一个文件已经搜完。 */
  | { id: number; kind: 'heartbeat' }
  | { id: number; kind: 'batch'; batch: WorkbenchSearchContentBatch }
  | { id: number; kind: 'result'; result: WorkbenchContentSearchTaskResult | WorkbenchContentReplaceTaskResult }
  | { id: number; kind: 'error'; message: string; code?: string }

interface LoadedSearchTextFile {
  kind: 'text'
  path: string
  content: string
  modifiedAt: number
  size: number
}

type LoadedSearchFile = LoadedSearchTextFile | { kind: 'large' } | { kind: 'skipped' }

interface ContentSearchTaskHooks {
  onBatch?: (batch: WorkbenchSearchContentBatch) => void
  onFile?: (path: string) => void
}

/** 处理 worker 收到的一个请求，结果（以及搜索途中的批次、进度）经 post 发回。 */
export async function handleWorkbenchContentSearchWorkerRequest(
  request: WorkbenchContentSearchWorkerRequest,
  post: (response: WorkbenchContentSearchWorkerResponse) => void
): Promise<void> {
  const { id } = request
  setWorkbenchMainLocale(request.locale)
  post({ id, kind: 'started' })
  const heartbeat = setInterval(() => post({ id, kind: 'heartbeat' }), HeartbeatIntervalMs)
  try {
    const result =
      request.kind === 'search'
        ? await runWorkbenchContentSearchTask(request.task, {
            onBatch: request.stream ? (batch) => post({ id, kind: 'batch', batch }) : undefined,
            onFile: (path) => post({ id, kind: 'file', path }),
          })
        : runWorkbenchContentReplaceTask(request.task)
    post({ id, kind: 'result', result })
  } catch (error) {
    const appError = AppError.from(error)
    post({ id, kind: 'error', message: appError.message, code: appError.code })
  } finally {
    clearInterval(heartbeat)
  }
}

export async function runWorkbenchContentSearchTask(
  task: WorkbenchContentSearchTask,
  hooks: ContentSearchTaskHooks = {}
): Promise<WorkbenchContentSearchTaskResult> {
  const matcher = compileMatcher(task.query)
  const result: WorkbenchContentSearchTaskResult = {
    files: [],
    openPathsInScope: [],
    truncated: false,
    skippedLargeFileCount: 0,
  }
  const openPaths = new Set(task.openPaths)
  /** 开着的文件要不要先在磁盘版本上试跑（只有正则会回溯）。 */
  const probeOpenFiles = task.query.regex
  const budget = { remaining: task.limit }
  const pending = new Map<string, Promise<LoadedSearchFile>>()
  let batch: WorkbenchSearchContentBatch = { files: [], openPathsInScope: [] }
  let lastBatchAt: Nullable<number> = null

  for (let index = 0; index < task.paths.length; index += 1) {
    const readAheadEnd = Math.min(task.paths.length, index + ReadAhead)
    for (let ahead = index; ahead < readAheadEnd; ahead += 1) {
      const path = task.paths[ahead]!
      if ((probeOpenFiles || !openPaths.has(path)) && !pending.has(path))
        pending.set(path, loadSearchFile(task.projectRoot, path))
    }

    const path = task.paths[index]!
    if (openPaths.has(path)) {
      if (probeOpenFiles) {
        const onDisk = await pending.get(path)!
        pending.delete(path)
        if (onDisk.kind === 'text') {
          hooks.onFile?.(path)
          scanWorkbenchTextSearch(onDisk.content, matcher, () => undefined)
        }
      }
      batch.openPathsInScope.push(path)
      continue
    }
    const loaded = await pending.get(path)!
    pending.delete(path)
    if (loaded.kind === 'large') result.skippedLargeFileCount += 1
    if (loaded.kind !== 'text') continue

    hooks.onFile?.(path)
    const { file, cut } = collectMatches(loaded, matcher, task.maxResultsPerFile, budget)
    if (file.matchCount > 0) batch.files.push(file)
    if (budget.remaining <= 0) {
      result.truncated = cut || index < task.paths.length - 1
      break
    }
    // 第一批一有内容就交出，之后隔 BatchIntervalMs 交一批。
    if (
      hooks.onBatch
      && (batch.files.length > 0 || batch.openPathsInScope.length > 0)
      && (lastBatchAt === null || Date.now() - lastBatchAt >= BatchIntervalMs)
    ) {
      hooks.onBatch(batch)
      batch = { files: [], openPathsInScope: [] }
      lastBatchAt = Date.now()
    }
  }

  result.files = batch.files
  result.openPathsInScope = batch.openPathsInScope
  return result
}

export function runWorkbenchContentReplaceTask(
  task: WorkbenchContentReplaceTask
): WorkbenchContentReplaceTaskResult {
  const matcher = compileMatcher(task.query)
  const selected = task.selectedKeys ? new Set(task.selectedKeys) : null
  return replaceWorkbenchTextSearchMatches(
    task.content,
    matcher,
    task.replacement,
    selected ? (hit) => selected.has(workbenchTextSearchRangeKey(hit)) : undefined
  )
}

function compileMatcher(query: WorkbenchTextSearchQuery): WorkbenchTextSearchMatcher {
  const compiled = compileWorkbenchTextSearch(query)
  if (compiled.status === 'ready') return compiled.matcher
  throw new AppError(
    'VALIDATION',
    compiled.status === 'invalid'
      ? workbenchMainText('search.invalidRegex', { message: compiled.message })
      : workbenchMainText('search.queryEmpty')
  )
}

/** 读一个要搜的文件：不是普通文件（目录、符号链接）或不像文本的跳过，太大的记一笔。 */
async function loadSearchFile(projectRoot: string, path: string): Promise<LoadedSearchFile> {
  const absolutePath = join(projectRoot, path)
  const fileStats = await lstat(absolutePath).catch(() => null)
  if (!fileStats?.isFile()) return { kind: 'skipped' }
  if (fileStats.size > WorkbenchContentSearchMaxFileBytes) return { kind: 'large' }

  const buffer = await readFile(absolutePath).catch(() => null)
  if (!buffer || !isLikelyTextFile(buffer)) return { kind: 'skipped' }

  return {
    kind: 'text',
    path,
    // 与编辑器读到的正文一致（认编码、去 BOM、换行统一为 LF），结果的行列才对得上。
    content: decodeWorkbenchTextContent(buffer),
    modifiedAt: fileStats.mtimeMs,
    size: fileStats.size,
  }
}

/** 一个文件的匹配：总数数全；列出的受每个文件的上限与剩下的总额度限制，`cut` 表示总额度用完少列了。 */
function collectMatches(
  file: LoadedSearchTextFile,
  matcher: WorkbenchTextSearchMatcher,
  perFileLimit: number,
  budget: { remaining: number }
): { file: WorkbenchContentSearchFileResult; cut: boolean } {
  const matches: WorkbenchContentSearchMatchResult[] = []
  let matchCount = 0
  let cut = false
  scanWorkbenchTextSearch(file.content, matcher, (hit) => {
    matchCount += 1
    if (matches.length >= perFileLimit) return
    if (budget.remaining <= 0) {
      cut = true
      return
    }

    const preview = buildWorkbenchTextSearchPreview(file.content, hit)
    matches.push({
      line: hit.line,
      column: hit.column,
      endLine: hit.endLine,
      endColumn: hit.endColumn,
      excerpt: preview.text,
      excerptMatchStart: preview.matchStart,
      excerptMatchEnd: preview.matchEnd,
    })
    budget.remaining -= 1
  })

  return {
    file: { path: file.path, modifiedAt: file.modifiedAt, size: file.size, matchCount, matches },
    cut,
  }
}
