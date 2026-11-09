/**
 * 工作台双搜索：searchEntries 按文件名与路径找条目（照搬 desktop `workspace/workbench/SearchIndex.ts`，
 * 遍历上限与评分保形），searchContent 搜文件内容。
 *
 * 内容搜索：主进程这里列出要搜的文件（见 ProjectFileListing：Git 仓库按 .gitignore 列，其它工程遍历目录），
 * 读、解码、跑用户的正则都交给搜索 worker（见 ContentSearchTask、ContentSearchWorkerHost）：正则回溯得再久
 * 也不卡主进程，取消就结束 worker。给了 onBatch 就把 worker 边搜边交出的结果转出去。
 *
 * listProjectFiles 是快速打开的整份文件清单：只列路径、不打分，匹配与排序在 renderer 里按输入现算。
 */
import type { Dirent } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { isPresent } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'

import {
  type WorkbenchDirectoryEntry,
  type WorkbenchListProjectFilesRequest,
  type WorkbenchListProjectFilesResult,
  type WorkbenchSearchContentBatch,
  type WorkbenchSearchContentRequest,
  type WorkbenchSearchContentResult,
  type WorkbenchSearchEntriesRequest,
  type WorkbenchSearchEntriesResult,
} from '@shared/contracts/workbench'
import {
  compileWorkbenchSearchPathFilter,
  isWorkbenchSearchPathIncluded,
  type WorkbenchSearchPathFilter,
} from '@shared/workbenchSearchGlob'
import {
  compileWorkbenchTextSearch,
  WorkbenchContentSearchDefaultLimit,
  WorkbenchContentSearchMaxLimit,
} from '@shared/workbenchTextSearch'

import { workbenchMainText } from '../i18n/workbenchMainMessages'

import type { OpenWorkbenchContentSearchSession } from './ContentSearchWorkerHost'
import type { DirectoryEntries } from './FileEntries'
import { isPathInsideRoot } from './PathContainmentHelper'
import type { PathResolver } from './PathResolver'
import {
  isInsideUnsearchedDirectory,
  listWorkbenchContentSearchFiles,
  sortWorkbenchSearchPaths,
} from './ProjectFileListing'

const DEFAULT_SEARCH_LIMIT = 50
const MAX_SEARCH_LIMIT = 200
const DEFAULT_SEARCH_MAX_DEPTH = 8
const MAX_SEARCH_MAX_DEPTH = 12

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

class SearchIndex {
  constructor(
    private readonly pathResolver: PathResolver,
    private readonly entryHelper: DirectoryEntries,
    private readonly openSearchSession: OpenWorkbenchContentSearchSession
  ) {}

  public async searchEntries(
    request: WorkbenchSearchEntriesRequest
  ): Promise<WorkbenchSearchEntriesResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const searchRoot = await this.pathResolver.resolveInsideProject(
      projectRoot,
      request.path ?? '.'
    )
    const searchRootStats = await stat(searchRoot.realPath)

    if (!searchRootStats.isDirectory()) {
      throw new AppError('VALIDATION', workbenchMainText('search.targetNotFolder'))
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
      throw new AppError(
        'VALIDATION',
        workbenchMainText('search.invalidRegex', { message: compiled.message })
      )

    const { signal, onBatch } = options
    const filter = compileWorkbenchSearchPathFilter(request.include ?? '', request.exclude ?? '')
    const paths = request.paths
      ? await this.resolveContentSearchPaths(projectRoot, request.paths, filter)
      : await listWorkbenchContentSearchFiles(projectRoot, { filter, signal })
    if (signal?.aborted) return { ...result, cancelled: true }

    const session = this.openSearchSession()
    try {
      const outcome = await session.search(
        {
          projectRoot,
          paths,
          openPaths: request.openPaths ?? [],
          query: compiled.matcher.query,
          limit: this.normalizeContentSearchLimit(request.limit),
          maxResultsPerFile: this.normalizeContentSearchPerFileLimit(request.maxResultsPerFile),
        },
        { signal, onBatch }
      )
      return outcome ? { ...result, ...outcome } : { ...result, cancelled: true }
    } finally {
      session.close()
    }
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
      for (
        let start = 0;
        start < level.length && !truncated;
        start += PROJECT_FILE_LIST_READ_CONCURRENCY
      ) {
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
      if (!this.entryHelper.shouldIncludeEntry(entry.name, isDirectory, true, atProjectRoot))
        continue

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
        path !== '.' &&
        !isInsideUnsearchedDirectory(path) &&
        isWorkbenchSearchPathIncluded(filter, path)
      )
        paths.add(path)
    }
    return sortWorkbenchSearchPaths([...paths])
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

export { SearchIndex }
export type { WorkbenchContentSearchRunOptions }
