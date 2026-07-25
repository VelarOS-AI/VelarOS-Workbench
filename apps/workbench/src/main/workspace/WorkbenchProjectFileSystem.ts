/**
 * 独立 Workbench 应用 main 侧项目文件系统服务（host 实装第一段：纯读两动词）。
 *
 * 行为蒸馏自 desktop 被摘除前的 workbench main 面（DirectoryListing / FileOperations /
 * PathResolver，可考古 `cf62413e4^`），契约形状单源于 `@velaros-ai/core/types`：
 * - 目录列表：projectRoot 越界防护（realpath 收束）、`.git` 恒隐藏、点号项默认隐藏、
 *   目录优先 + localeCompare 排序、hasChildren 可见子项探针、limit 钳制 + truncated。
 * - 读文件：文本似然门（NUL + 控制字节占比）、maxChars 钳制截断、totalLines 全文行数。
 *
 * 与 desktop 版的差异（本切片刻意收窄，后续批次补齐）：不做 git check-ignore 装饰
 * （`gitIgnored` 字段缺省）、不做符号链接实体解析（越界符号链接直接剔除）。
 * 错误一律抛 Error，由 IPC 装配层降为 `WorkbenchFsCallResult` 信封。
 */
import { opendir, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import type {
  WorkbenchDirectoryEntry,
  WorkbenchListDirectoryRequest,
  WorkbenchListDirectoryResult,
  WorkbenchReadFileRequest,
  WorkbenchReadFileResult,
} from '@velaros-ai/core/types'

const DefaultDirectoryLimit = 1000
const MaxDirectoryLimit = 5000
const DefaultReadMaxChars = 300_000
const MaxReadChars = 1_000_000
const TextProbeSampleBytes = 4096
const TextProbeSuspiciousRatio = 0.08

export class WorkbenchProjectFileSystem {
  public async listDirectory(
    request: WorkbenchListDirectoryRequest
  ): Promise<WorkbenchListDirectoryResult> {
    const projectRoot = await this.resolveProjectRoot(request.projectRoot)
    const directoryPath = await this.resolveInsideProject(projectRoot, request.path ?? '.')
    const directoryStats = await stat(directoryPath)
    if (!directoryStats.isDirectory()) {
      throw new Error('工作台目录读取目标必须是目录。')
    }

    const includeHidden = !!request.includeHidden
    const limit = this.clampLimit(request.limit)
    const dirents = await readdir(directoryPath, { withFileTypes: true })
    const visibleDirents = dirents.filter((entry) =>
      this.shouldIncludeEntry(entry.name, entry.isDirectory(), includeHidden)
    )
    const limitedDirents = visibleDirents.slice(0, limit)

    const entries: WorkbenchDirectoryEntry[] = []
    for (const dirent of limitedDirents) {
      const entryAbsolutePath = resolve(directoryPath, dirent.name)
      if (!this.isInsideProject(projectRoot, entryAbsolutePath)) continue

      let isDirectory = dirent.isDirectory()
      let isFile = dirent.isFile()
      let size: Nullable<number> = null
      let modifiedAt: Nullable<number> = null
      if (!isDirectory && !isFile) {
        // 符号链接等特殊项：解析实体并要求仍在项目内，越界一律剔除。
        const resolved = await realpath(entryAbsolutePath).catch(() => null)
        if (!resolved || !this.isInsideProject(projectRoot, resolved)) continue

        const resolvedStats = await stat(resolved).catch(() => null)
        if (!resolvedStats) continue

        isDirectory = resolvedStats.isDirectory()
        isFile = resolvedStats.isFile()
        size = isFile ? resolvedStats.size : null
        modifiedAt = resolvedStats.mtimeMs
      }
      if (!isDirectory && !isFile) continue

      entries.push({
        name: dirent.name,
        path: this.toProjectRelativePath(projectRoot, entryAbsolutePath),
        type: isDirectory ? 'directory' : 'file',
        size,
        modifiedAt,
        hasChildren: isDirectory
          ? await this.hasVisibleChildren(entryAbsolutePath, includeHidden)
          : false,
      })
    }

    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1

      return a.name.localeCompare(b.name)
    })

    return {
      projectRoot,
      path: this.toProjectRelativePath(projectRoot, directoryPath),
      entries,
      truncated: visibleDirents.length > limit,
    }
  }

  public async readTextFile(request: WorkbenchReadFileRequest): Promise<WorkbenchReadFileResult> {
    const projectRoot = await this.resolveProjectRoot(request.projectRoot)
    const filePath = await this.resolveInsideProject(projectRoot, request.path)
    const fileStats = await stat(filePath)
    if (!fileStats.isFile()) {
      throw new Error('工作台文件读取目标必须是文件。')
    }

    const buffer = await readFile(filePath)
    if (!this.isLikelyTextFile(buffer)) {
      throw new Error('当前文件不是可预览的文本文件。')
    }

    const maxChars = this.clampReadMaxChars(request.maxChars)
    const fullContent = buffer.toString('utf8')
    const truncated = fullContent.length > maxChars

    return {
      projectRoot,
      path: this.toProjectRelativePath(projectRoot, filePath),
      content: truncated ? fullContent.slice(0, maxChars) : fullContent,
      size: fileStats.size,
      modifiedAt: fileStats.mtimeMs,
      totalLines: fullContent.split(/\r?\n/).length,
      truncated,
    }
  }

  private async resolveProjectRoot(input: string): Promise<string> {
    if (!input.trim()) {
      throw new Error('需要选择一个工程目录。')
    }

    const projectRoot = resolve(input)
    const projectStats = await stat(projectRoot)
    if (!projectStats.isDirectory()) {
      throw new Error('需要选择一个工程目录。')
    }

    return realpath(projectRoot)
  }

  private async resolveInsideProject(projectRoot: string, inputPath: string): Promise<string> {
    const resolvedPath = resolve(projectRoot, inputPath.trim() || '.')
    this.assertInsideProject(projectRoot, resolvedPath, inputPath)

    const realPath = await realpath(resolvedPath)
    this.assertInsideProject(projectRoot, realPath, inputPath)
    return realPath
  }

  private assertInsideProject(projectRoot: string, absolutePath: string, inputPath: string): void {
    if (!this.isInsideProject(projectRoot, absolutePath)) {
      throw new Error(`路径超出工程范围：${inputPath}`)
    }
  }

  private isInsideProject(projectRoot: string, absolutePath: string): boolean {
    const relativePath = relative(projectRoot, absolutePath)
    return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  }

  private toProjectRelativePath(projectRoot: string, absolutePath: string): string {
    const relativePath = relative(projectRoot, absolutePath)
    if (!relativePath || relativePath === '.') return '.'

    return relativePath.split(sep).join('/')
  }

  private shouldIncludeEntry(name: string, isDirectory: boolean, includeHidden: boolean): boolean {
    if (isDirectory && name === '.git') return false

    if (!includeHidden && name.startsWith('.')) return false

    return true
  }

  private async hasVisibleChildren(path: string, includeHidden: boolean): Promise<boolean> {
    const directory = await opendir(path).catch(() => null)
    if (!directory) return false

    try {
      for await (const entry of directory) {
        if (this.shouldIncludeEntry(entry.name, entry.isDirectory(), includeHidden)) return true
      }
    } catch {
      return false
    }
    return false
  }

  private isLikelyTextFile(buffer: Buffer): boolean {
    if (buffer.length === 0) return true

    const sample = buffer.subarray(0, Math.min(buffer.length, TextProbeSampleBytes))
    if (sample.includes(0)) return false

    let suspicious = 0
    for (const byte of sample) {
      const isAllowedControl = byte === 9 || byte === 10 || byte === 13
      if (byte < 32 && !isAllowedControl) suspicious += 1
    }

    return suspicious / sample.length < TextProbeSuspiciousRatio
  }

  private clampLimit(value: number | undefined): number {
    if (!value || !Number.isFinite(value)) return DefaultDirectoryLimit

    return Math.min(MaxDirectoryLimit, Math.max(1, Math.round(value)))
  }

  private clampReadMaxChars(value: number | undefined): number {
    if (!value || !Number.isFinite(value)) return DefaultReadMaxChars

    return Math.min(MaxReadChars, Math.max(1, Math.round(value)))
  }
}
