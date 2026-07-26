/**
 * 工作台双搜索（照搬 desktop `workspace/workbench/SearchIndex.ts` 的 searchEntries /
 * searchContent 两动词，遍历上限、评分与摘要压缩语义保形）。
 *
 * 裁剪说明：desktop 原文件还承载 AI 索引采集面（indexProject / collectIndexFiles /
 * materializeIndexFiles 及 PROFILE_* 优先级机制），那一族属 kernel/codegraph 域
 * （ProjectMemoryLifecycle 消费），独立应用 Phase3 经 kernel-protocol 接入，不在本地
 * 复制——故未随迁。readIndexedTextFile / normalizeIndexFileBytes 因内容搜索复用而保留。
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type {
  WorkbenchContentSearchMatchResult,
  WorkbenchDirectoryEntry,
  WorkbenchIndexedTextFile,
  WorkbenchSearchContentRequest,
  WorkbenchSearchContentResult,
  WorkbenchSearchEntriesRequest,
  WorkbenchSearchEntriesResult,
} from '@velaros-ai/workbench/contracts'

import type { DirectoryEntries } from './FileEntries'
import type { PathResolver } from './PathResolver'
import { isLikelyTextFile } from './TextFile'

const DEFAULT_SEARCH_LIMIT = 50
const MAX_SEARCH_LIMIT = 200
const DEFAULT_SEARCH_MAX_DEPTH = 8
const MAX_SEARCH_MAX_DEPTH = 12

const DEFAULT_INDEX_MAX_FILE_BYTES = 160_000
const MAX_INDEX_MAX_FILE_BYTES = 500_000

const DEFAULT_CONTENT_SEARCH_MAX_DEPTH = 8
const DEFAULT_CONTENT_SEARCH_MAX_RESULTS_PER_FILE = 3
const MAX_CONTENT_SEARCH_MAX_RESULTS_PER_FILE = 20

interface WorkbenchSearchCandidate {
  entry: WorkbenchDirectoryEntry
  score: number
}

interface WorkbenchContentSearchCollectionState {
  matches: WorkbenchContentSearchMatchResult[]
  truncated: boolean
  visitedRealPaths: Set<string>
}

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
    request: WorkbenchSearchContentRequest
  ): Promise<WorkbenchSearchContentResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const searchRoot = await this.pathResolver.resolveInsideProject(projectRoot, request.path ?? '.')
    const searchRootStats = await stat(searchRoot.realPath)

    if (!searchRootStats.isDirectory()) {
      throw new AppError('VALIDATION', '工作台内容搜索目标必须是目录。')
    }

    const query = this.normalizeSearchQuery(request.query)
    if (!query)
      return {
        projectRoot,
        query: '',
        matches: [],
        truncated: false,
      }

    const state: WorkbenchContentSearchCollectionState = {
      matches: [],
      truncated: false,
      visitedRealPaths: new Set<string>(),
    }

    await this.collectContentMatches({
      projectRoot,
      requestedPath: searchRoot.requestedPath,
      realPath: searchRoot.realPath,
      includeHidden: !!request.includeHidden,
      normalizedQuery: query.toLocaleLowerCase(),
      limit: this.normalizeSearchLimit(request.limit),
      maxDepth: this.normalizeSearchDepth(request.maxDepth ?? DEFAULT_CONTENT_SEARCH_MAX_DEPTH),
      maxResultsPerFile: this.normalizeContentSearchPerFileLimit(request.maxResultsPerFile),
      maxFileBytes: this.normalizeIndexFileBytes(undefined),
      depth: 0,
      state,
    })

    return {
      projectRoot,
      query,
      matches: state.matches,
      truncated: state.truncated,
    }
  }

  private normalizeContentSearchPerFileLimit(value: number | undefined): number {
    if (!value || !Number.isFinite(value)) return DEFAULT_CONTENT_SEARCH_MAX_RESULTS_PER_FILE

    return Math.min(MAX_CONTENT_SEARCH_MAX_RESULTS_PER_FILE, Math.max(1, Math.round(value)))
  }

  private async collectContentMatches(options: {
    projectRoot: string
    requestedPath: string
    realPath: string
    includeHidden: boolean
    normalizedQuery: string
    limit: number
    maxDepth: number
    maxResultsPerFile: number
    maxFileBytes: number
    depth: number
    state: WorkbenchContentSearchCollectionState
  }): Promise<void> {
    if (options.state.matches.length >= options.limit) {
      options.state.truncated = true
      return
    }

    if (options.depth > options.maxDepth) {
      options.state.truncated = true
      return
    }

    if (options.state.visitedRealPaths.has(options.realPath)) return
    options.state.visitedRealPaths.add(options.realPath)

    const entries = await readdir(options.realPath, { withFileTypes: true }).catch(() => [])
    const visibleEntries = entries
      .filter((entry) =>
        this.entryHelper.shouldIncludeEntry(entry.name, entry.isDirectory(), options.includeHidden)
      )
      .sort((left, right) => {
        if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1

        return left.name.localeCompare(right.name, 'en')
      })

    for (const entry of visibleEntries) {
      if (options.state.matches.length >= options.limit) {
        options.state.truncated = true
        return
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

      if (entryStats.isDirectory()) {
        await this.collectContentMatches({
          ...options,
          requestedPath: requestedEntryPath,
          realPath: realEntryPath,
          depth: options.depth + 1,
        })
        continue
      }

      if (!entryStats.isFile() || entryStats.size > options.maxFileBytes) {
        continue
      }

      await this.searchIndexedTextFileContent({
        projectRoot: options.projectRoot,
        requestedPath: requestedEntryPath,
        realPath: realEntryPath,
        size: entryStats.size,
        modifiedAt: entryStats.mtimeMs,
        normalizedQuery: options.normalizedQuery,
        limit: options.limit,
        maxResultsPerFile: options.maxResultsPerFile,
        maxFileBytes: options.maxFileBytes,
        state: options.state,
      })
    }
  }

  private async searchIndexedTextFileContent(options: {
    projectRoot: string
    requestedPath: string
    realPath: string
    size: number
    modifiedAt: number
    normalizedQuery: string
    limit: number
    maxResultsPerFile: number
    maxFileBytes: number
    state: WorkbenchContentSearchCollectionState
  }): Promise<void> {
    if (options.state.matches.length >= options.limit) {
      options.state.truncated = true
      return
    }

    const indexedFile = await this.readIndexedTextFile({
      projectRoot: options.projectRoot,
      requestedPath: options.requestedPath,
      realPath: options.realPath,
      size: options.size,
      modifiedAt: options.modifiedAt,
      maxCharsPerFile: options.maxFileBytes,
    })

    if (!indexedFile) return

    const lines = indexedFile.content.split('\n')
    let fileResultCount = 0

    for (let index = 0; index < lines.length; index += 1) {
      if (
        options.state.matches.length >= options.limit ||
        fileResultCount >= options.maxResultsPerFile
      ) {
        if (options.state.matches.length >= options.limit) {
          options.state.truncated = true
        }
        return
      }

      const line = lines[index]
      const matchIndex = line.toLocaleLowerCase().indexOf(options.normalizedQuery)
      if (matchIndex === -1) {
        continue
      }

      options.state.matches.push({
        path: indexedFile.path,
        line: index + 1,
        column: matchIndex + 1,
        excerpt: this.compactContentExcerpt(line, matchIndex, options.normalizedQuery.length),
      })
      fileResultCount += 1
    }
  }

  private compactContentExcerpt(line: string, matchIndex: number, queryLength: number): string {
    const compactLine = line.replace(/\s+/g, ' ').trim()
    if (compactLine.length <= 140) return compactLine

    const start = Math.max(0, matchIndex - 46)
    const end = Math.min(line.length, matchIndex + queryLength + 78)
    const excerpt = line.slice(start, end).replace(/\s+/g, ' ').trim()
    return `${start > 0 ? '...' : ''}${excerpt}${end < line.length ? '...' : ''}`
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
    for (const entry of entries) {
      if (
        !this.entryHelper.shouldIncludeEntry(entry.name, entry.isDirectory(), options.includeHidden)
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

  private normalizeIndexFileBytes(value: number | undefined): number {
    if (!value || !Number.isFinite(value)) return DEFAULT_INDEX_MAX_FILE_BYTES

    return Math.min(MAX_INDEX_MAX_FILE_BYTES, Math.max(1, Math.round(value)))
  }

  private async readIndexedTextFile(options: {
    projectRoot: string
    requestedPath: string
    realPath: string
    size: number
    modifiedAt: number
    maxCharsPerFile: number
  }): Promise<Nullable<WorkbenchIndexedTextFile>> {
    const buffer = await readFile(options.realPath).catch(() => null)
    if (!buffer || !isLikelyTextFile(buffer)) return null

    const fullContent = buffer.toString('utf8')
    const truncated = fullContent.length > options.maxCharsPerFile
    const content = truncated ? fullContent.slice(0, options.maxCharsPerFile) : fullContent

    return {
      path: this.pathResolver.toProjectRelativePath(options.projectRoot, options.requestedPath),
      content,
      size: options.size,
      modifiedAt: options.modifiedAt,
      totalLines: fullContent.split(/\r?\n/).length,
      truncated,
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

export { SearchIndex, SearchIndex as WorkbenchSearchIndexService }
