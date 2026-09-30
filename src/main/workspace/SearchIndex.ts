/**
 * 工作台双搜索：searchEntries 按文件名与路径找条目（照搬 desktop `workspace/workbench/SearchIndex.ts`，
 * 遍历上限与评分保形），searchContent 搜文件内容。
 *
 * 内容搜索：
 * - 文件清单见 ProjectFileListing（Git 仓库按 .gitignore 列，其它工程遍历目录）；二进制文件与超过 1 MB 的
 *   文件不搜。
 * - 读盘后按编辑器同一套规则解码（认编码、去 BOM、换行统一为 LF），GB18030 / UTF-16 文件照样搜得到，行列号
 *   与编辑器对得上。匹配规则见 `@shared/workbenchTextSearch`。
 * - 边读边搜：往前预读几个文件，按路径顺序出结果；给了 onBatch 就隔一小段时间交出一批，前面的结果先显示。
 * - 列到 limit 处匹配就停（结果标成 truncated）；每个文件的匹配总数照样数全，替换时说得清换几处。
 * - 调用方开着的文件（openPaths）不读，只报它们在不在搜索范围里：编辑器里的正文由调用方自己搜。
 *
 * listProjectFiles 是快速打开的整份文件清单：只列路径、不打分，匹配与排序在 renderer 里按输入现算。
 */
import type { Dirent } from 'node:fs'
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'

import type {
  WorkbenchContentSearchFileResult,
  WorkbenchContentSearchMatchResult,
  WorkbenchDirectoryEntry,
  WorkbenchListProjectFilesRequest,
  WorkbenchListProjectFilesResult,
  WorkbenchSearchContentBatch,
  WorkbenchSearchContentRequest,
  WorkbenchSearchContentResult,
  WorkbenchSearchEntriesRequest,
  WorkbenchSearchEntriesResult,
} from '@shared/contracts'
import {
  compileWorkbenchSearchPathFilter,
  isWorkbenchSearchPathIncluded,
  type WorkbenchSearchPathFilter,
} from '@shared/workbenchSearchGlob'
import {
  buildWorkbenchTextSearchPreview,
  compileWorkbenchTextSearch,
  scanWorkbenchTextSearch,
  WorkbenchContentSearchDefaultLimit,
  WorkbenchContentSearchMaxFileBytes,
  WorkbenchContentSearchMaxLimit,
  type WorkbenchTextSearchMatcher,
} from '@shared/workbenchTextSearch'

import type { DirectoryEntries } from './FileEntries'
import { isPathInsideRoot } from './PathContainmentHelper'
import type { PathResolver } from './PathResolver'
import {
  isInsideUnsearchedDirectory,
  listWorkbenchProjectFiles,
  sortWorkbenchSearchPaths,
} from './ProjectFileListing'
import { decodeWorkbenchTextContent } from './TextCodec'
import { isLikelyTextFile } from './TextFile'

const DEFAULT_SEARCH_LIMIT = 50
const MAX_SEARCH_LIMIT = 200
const DEFAULT_SEARCH_MAX_DEPTH = 8
const MAX_SEARCH_MAX_DEPTH = 12

/** 内容搜索往前预读的文件数。 */
const ContentSearchReadAhead = 8
/** 边搜边交出结果时，隔这么久交一批。 */
const ContentSearchBatchIntervalMs = 80

const DEFAULT_PROJECT_FILE_LIST_LIMIT = 50_000
const MAX_PROJECT_FILE_LIST_LIMIT = 100_000
/** 只有普通目录会往下走（链接到的目录不跟），不会绕圈；层数上限只是兜底。 */
const PROJECT_FILE_LIST_MAX_DEPTH = 64
/** 同一层同时读几个目录。 */
const PROJECT_FILE_LIST_READ_CONCURRENCY = 16

interface WorkbenchSearchCandidate {
  entry: WorkbenchDirectoryEntry
  score: number
}

interface WorkbenchContentSearchRunOptions {
  signal?: AbortSignal
  /** 给了就边搜边交出结果；最后一批不交，留在返回的结果里。 */
  onBatch?: (batch: WorkbenchSearchContentBatch) => void
}

/** 文件清单遍历中的一个目录：`relativePath` 相对项目根（根目录是空串），`realPath` 是磁盘上的路径。 */
interface WorkbenchProjectFileListDirectory {
  relativePath: string
  realPath: string
}

interface WorkbenchProjectFileListListing {
  files: string[]
  directories: WorkbenchProjectFileListDirectory[]
}

interface LoadedSearchTextFile {
  kind: 'text'
  path: string
  content: string
  modifiedAt: number
  size: number
}

type LoadedSearchFile = LoadedSearchTextFile | { kind: 'large' } | { kind: 'skipped' }

class SearchIndex {
  constructor(
    private readonly pathResolver: PathResolver,
    private readonly entryHelper: DirectoryEntries
  ) {}

  public async searchEntries(
    request: WorkbenchSearchEntriesRequest
  ): Promise<WorkbenchSearchEntriesResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const searchRoot = await this.pathResolver.resolveInsideProject(projectRoot, request.path ?? '.')
    const searchRootStats = await stat(searchRoot.realPath)

    if (!searchRootStats.isDirectory()) {
      throw new AppError('VALIDATION', '工作台搜索目标必须是目录。')
    }

    const query = this.normalizeSearchQuery(request.query)
    if (!query)
      return {
        projectRoot,
        query: '',
        entries: [],
        truncated: false,
      }

    const candidates: WorkbenchSearchCandidate[] = []
    const state = {
      truncated: false,
      visitedRealPaths: new Set<string>(),
    }
    await this.collectSearchEntries({
      projectRoot,
      requestedPath: searchRoot.requestedPath,
      realPath: searchRoot.realPath,
      includeHidden: !!request.includeHidden,
      query,
      queryTokens: query.toLowerCase().split(/\s+/).filter(Boolean),
      limit: this.normalizeSearchLimit(request.limit),
      maxDepth: this.normalizeSearchDepth(request.maxDepth),
      depth: 0,
      candidates,
      state,
    })

    const limit = this.normalizeSearchLimit(request.limit)
    const entries = candidates
      .sort(
        (left, right) =>
          left.score - right.score ||
          left.entry.path.length - right.entry.path.length ||
          left.entry.path.localeCompare(right.entry.path, 'en')
      )
      .slice(0, limit)
      .map((candidate) => candidate.entry)

    return {
      projectRoot,
      query,
      entries,
      truncated: state.truncated || candidates.length > limit,
    }
  }

  public async searchContent(
    request: WorkbenchSearchContentRequest,
    options: WorkbenchContentSearchRunOptions = {}
  ): Promise<WorkbenchSearchContentResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const result: WorkbenchSearchContentResult = {
      projectRoot,
      query: request.query,
      files: [],
      openPathsInScope: [],
      truncated: false,
      skippedLargeFileCount: 0,
      cancelled: false,
    }
    const compiled = compileWorkbenchTextSearch({
      query: request.query,
      matchCase: !!request.matchCase,
      wholeWord: !!request.wholeWord,
      regex: !!request.regex,
    })
    if (compiled.status === 'empty') return result
    if (compiled.status === 'invalid')
      throw new AppError('VALIDATION', `正则表达式有误：${compiled.message}`)

    const { signal, onBatch } = options
    const filter = compileWorkbenchSearchPathFilter(request.include ?? '', request.exclude ?? '')
    const paths = request.paths
      ? await this.resolveContentSearchPaths(projectRoot, request.paths, filter)
      : await listWorkbenchProjectFiles(projectRoot, { filter, signal })
    if (signal?.aborted) return { ...result, cancelled: true }

    const openPaths = new Set(request.openPaths ?? [])
    const perFileLimit = this.normalizeContentSearchPerFileLimit(request.maxResultsPerFile)
    const budget = { remaining: this.normalizeContentSearchLimit(request.limit) }
    const pending = new Map<string, Promise<LoadedSearchFile>>()
    let batch: WorkbenchSearchContentBatch = { files: [], openPathsInScope: [] }
    let batchStartedAt = Date.now()

    for (let index = 0; index < paths.length; index += 1) {
      if (signal?.aborted) {
        result.cancelled = true
        break
      }
      const readAheadEnd = Math.min(paths.length, index + ContentSearchReadAhead)
      for (let ahead = index; ahead < readAheadEnd; ahead += 1) {
        const path = paths[ahead]!
        if (!openPaths.has(path) && !pending.has(path))
          pending.set(path, this.loadContentSearchFile(projectRoot, path))
      }

      const path = paths[index]!
      if (openPaths.has(path)) {
        batch.openPathsInScope.push(path)
        continue
      }
      const loaded = await pending.get(path)!
      pending.delete(path)
      if (loaded.kind === 'large') result.skippedLargeFileCount += 1
      if (loaded.kind !== 'text') continue

      const { file, cut } = this.collectContentMatches(loaded, compiled.matcher, perFileLimit, budget)
      if (file.matchCount > 0) batch.files.push(file)
      if (budget.remaining <= 0) {
        result.truncated = cut || index < paths.length - 1
        break
      }
      if (onBatch && Date.now() - batchStartedAt >= ContentSearchBatchIntervalMs) {
        if (batch.files.length > 0 || batch.openPathsInScope.length > 0) onBatch(batch)
        batch = { files: [], openPathsInScope: [] }
        batchStartedAt = Date.now()
      }
    }

    result.files = batch.files
    result.openPathsInScope = batch.openPathsInScope
    return result
  }

  private normalizeContentSearchLimit(value: number | undefined): number {
    if (!value || !Number.isFinite(value)) return WorkbenchContentSearchDefaultLimit

    return Math.min(WorkbenchContentSearchMaxLimit, Math.max(1, Math.round(value)))
  }

  /**
   * 项目里所有文件的相对路径，跳过规则与文件搜索相同（`.git`、`node_modules`、根目录下的构建产物），
   * 点号开头的文件照列（文件树里也看得到）。一层一层读：超出上限时留下的是离根近的那部分。
   *
   * 符号链接：指向工程里文件的照列（链接自己的路径，打开读的是目标）；指向工程外、已失效的不列（打开
   * 也读不了）；链接到的目录不跟——目标在工程里的话它的文件已经按真实位置列过，跟进去只会重复一份。
   */
  public async listProjectFiles(
    request: WorkbenchListProjectFilesRequest
  ): Promise<WorkbenchListProjectFilesResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const limit = this.normalizeProjectFileListLimit(request.limit)
    const files: string[] = []
    let truncated = false
    let level: WorkbenchProjectFileListDirectory[] = [{ relativePath: '', realPath: projectRoot }]

    for (let depth = 0; level.length > 0 && !truncated; depth += 1) {
      const nextLevel: WorkbenchProjectFileListDirectory[] = []
      for (let start = 0; start < level.length && !truncated; start += PROJECT_FILE_LIST_READ_CONCURRENCY) {
        const listings = await Promise.all(
          level
            .slice(start, start + PROJECT_FILE_LIST_READ_CONCURRENCY)
            .map((directory) => this.readProjectFileListDirectory(projectRoot, directory))
        )
        for (const listing of listings) {
          const room = limit - files.length
          files.push(...listing.files.slice(0, room))
          if (listing.files.length > room) {
            truncated = true
            break
          }
          if (depth < PROJECT_FILE_LIST_MAX_DEPTH) nextLevel.push(...listing.directories)
          else if (listing.directories.length > 0) truncated = true
        }
      }
      level = nextLevel
    }

    return { projectRoot, files, truncated }
  }

  private async readProjectFileListDirectory(
    projectRoot: string,
    directory: WorkbenchProjectFileListDirectory
  ): Promise<WorkbenchProjectFileListListing> {
    const entries = await readdir(directory.realPath, { withFileTypes: true }).catch(
      (): Dirent[] => []
    )
    // 目录读出来的顺序随文件系统，按名字排好，截断时留下哪些才确定。
    entries.sort((left, right) => compareCodeUnits(left.name, right.name))

    const atProjectRoot = !directory.relativePath
    const listing: WorkbenchProjectFileListListing = { files: [], directories: [] }
    for (const entry of entries) {
      const isDirectory = entry.isDirectory()
      if (!this.entryHelper.shouldIncludeEntry(entry.name, isDirectory, true, atProjectRoot)) continue

      const relativePath = directory.relativePath
        ? `${directory.relativePath}/${entry.name}`
        : entry.name
      if (isDirectory) {
        listing.directories.push({ relativePath, realPath: join(directory.realPath, entry.name) })
      } else if (entry.isFile()) {
        listing.files.push(relativePath)
      } else if (
        entry.isSymbolicLink() &&
        (await this.isProjectFileLink(projectRoot, join(directory.realPath, entry.name)))
      ) {
        listing.files.push(relativePath)
      }
    }
    return listing
  }

  /** 链接解析到底（可能一环套一环、也可能经别的链接绕出工程）后，是不是工程里的一个文件。 */
  private async isProjectFileLink(projectRoot: string, linkPath: string): Promise<boolean> {
    const targetPath = await realpath(linkPath).catch(() => null)
    if (!targetPath || !isPathInsideRoot(projectRoot, targetPath)) return false

    const targetStats = await stat(targetPath).catch(() => null)
    return !!targetStats?.isFile()
  }

  private normalizeProjectFileListLimit(value: number | undefined): number {
    if (!value || !Number.isFinite(value)) return DEFAULT_PROJECT_FILE_LIST_LIMIT

    return Math.min(MAX_PROJECT_FILE_LIST_LIMIT, Math.max(1, Math.round(value)))
  }

  private normalizeContentSearchPerFileLimit(value: number | undefined): number {
    if (!value || !Number.isFinite(value)) return Number.POSITIVE_INFINITY

    return Math.max(1, Math.round(value))
  }

  /** 调用方点名要搜的文件：在工程里、不在不搜的目录里、落在包含 / 排除范围里的才搜。 */
  private async resolveContentSearchPaths(
    projectRoot: string,
    requestedPaths: readonly string[],
    filter: WorkbenchSearchPathFilter
  ): Promise<string[]> {
    const paths = new Set<string>()
    for (const requestedPath of requestedPaths) {
      const resolved = await this.pathResolver
        .resolveInsideProject(projectRoot, requestedPath)
        .catch(() => null)
      if (!resolved) continue

      const path = this.pathResolver.toProjectRelativePath(projectRoot, resolved.requestedPath)
      if (
        path !== '.'
        && !isInsideUnsearchedDirectory(path)
        && isWorkbenchSearchPathIncluded(filter, path)
      )
        paths.add(path)
    }
    return sortWorkbenchSearchPaths([...paths])
  }

  /** 读一个要搜的文件：不是普通文件（目录、符号链接）或不像文本的跳过，太大的记一笔。 */
  private async loadContentSearchFile(projectRoot: string, path: string): Promise<LoadedSearchFile> {
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
  private collectContentMatches(
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

  private normalizeSearchQuery(query: string): string {
    return query.trim().replace(/\s+/g, ' ')
  }

  private normalizeSearchLimit(value: number | undefined): number {
    if (!value || !Number.isFinite(value)) return DEFAULT_SEARCH_LIMIT

    return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.round(value)))
  }

  private normalizeSearchDepth(value: number | undefined): number {
    if (!value || !Number.isFinite(value)) return DEFAULT_SEARCH_MAX_DEPTH

    return Math.min(MAX_SEARCH_MAX_DEPTH, Math.max(0, Math.round(value)))
  }

  private async collectSearchEntries(options: {
    projectRoot: string
    requestedPath: string
    realPath: string
    includeHidden: boolean
    query: string
    queryTokens: string[]
    limit: number
    maxDepth: number
    depth: number
    candidates: WorkbenchSearchCandidate[]
    state: { truncated: boolean; visitedRealPaths: Set<string> }
  }): Promise<void> {
    if (options.candidates.length > options.limit * 4) {
      options.state.truncated = true
      return
    }

    if (options.state.visitedRealPaths.has(options.realPath)) return
    options.state.visitedRealPaths.add(options.realPath)

    const entries = await readdir(options.realPath, { withFileTypes: true }).catch(() => [])
    const atProjectRoot = options.requestedPath === options.projectRoot
    for (const entry of entries) {
      if (
        !this.entryHelper.shouldIncludeEntry(
          entry.name,
          entry.isDirectory(),
          options.includeHidden,
          atProjectRoot
        )
      ) {
        continue
      }

      const requestedEntryPath = resolve(options.requestedPath, entry.name)
      const realEntryPath = await realpath(requestedEntryPath).catch(() => null)
      if (!realEntryPath) {
        continue
      }

      if (
        !this.pathResolver.isAllowedProjectPath(options.projectRoot, requestedEntryPath) ||
        !this.pathResolver.isAllowedProjectPath(options.projectRoot, realEntryPath)
      ) {
        continue
      }

      const entryStats = await stat(realEntryPath).catch(() => null)
      if (!entryStats) {
        continue
      }

      const isDirectory = entryStats.isDirectory()
      const directoryEntry = await this.entryHelper.toDirectoryEntry(
        options.projectRoot,
        requestedEntryPath,
        options.includeHidden
      )
      const score = this.scoreSearchEntry(directoryEntry, options.query, options.queryTokens)
      if (isPresent(score)) {
        options.candidates.push({
          entry: directoryEntry,
          score,
        })

        if (options.candidates.length > options.limit * 4) {
          options.state.truncated = true
          return
        }
      }

      if (isDirectory && options.depth < options.maxDepth) {
        await this.collectSearchEntries({
          ...options,
          requestedPath: requestedEntryPath,
          realPath: realEntryPath,
          depth: options.depth + 1,
        })

        if (options.state.truncated) return
      }
    }
  }

  private scoreSearchEntry(
    entry: WorkbenchDirectoryEntry,
    query: string,
    queryTokens: string[]
  ): Nullable<number> {
    const lowerQuery = query.toLowerCase()
    const lowerName = entry.name.toLowerCase()
    const lowerPath = entry.path.toLowerCase()
    const extensionIndex = lowerName.lastIndexOf('.')
    const lowerNameStem = extensionIndex > 0 ? lowerName.slice(0, extensionIndex) : lowerName

    if (!queryTokens.every((token) => lowerPath.includes(token) || lowerName.includes(token)))
      return null

    let score = entry.type === 'file' ? 0 : 1
    if (lowerName === lowerQuery || lowerNameStem === lowerQuery) {
      score += 0
    } else if (lowerName.startsWith(lowerQuery)) {
      score += 4
    } else if (lowerName.includes(lowerQuery)) {
      score += 8
    } else if (lowerPath.includes(lowerQuery)) {
      score += 14
    } else {
      score += 24
    }

    return score + entry.path.length / 1000
  }
}

/** 按 UTF-16 码元比较：与区域设置无关，大目录里也快。 */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

export { SearchIndex, SearchIndex as WorkbenchSearchIndexService }
export type { WorkbenchContentSearchRunOptions }
