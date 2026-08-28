/**
 * 独立 Workbench 应用 main 侧项目文件系统服务（host 实装第一段：纯读两动词）。
 *
 * 行为蒸馏自 desktop 被摘除前的 workbench main 面（DirectoryListing / FileOperations /
 * PathResolver，可考古 `cf62413e4^`），契约形状单源于 `@shared/contracts`：
 * - 目录列表：projectRoot 越界防护（realpath 收束）、`.git` 恒隐藏、点号项默认隐藏、
 *   目录优先 + localeCompare 排序、hasChildren 可见子项探针、limit 钳制 + truncated。
 * - 读文件：文本似然门（NUL + 控制字节占比）、maxChars 钳制截断、totalLines 全文行数。
 *
 * Git 排除装饰沿用 Desktop 语义：每次目录读取批量调用一次 `git check-ignore`，
 * 已排除目录的子树继承弱化状态；非 Git 工程或 Git 不可用时安全退化为普通目录。
 * 符号链接实体仍只允许留在项目边界内。
 * 错误一律抛 Error，由 IPC 装配层降为 `WorkbenchFsCallResult` 信封。
 */
import { opendir, readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { execa } from 'execa'

import { AppError } from '@velaros-ai/core/error'

import type {
  WorkbenchDirectoryEntry,
  WorkbenchListDirectoryRequest,
  WorkbenchListDirectoryResult,
  WorkbenchReadFileRequest,
  WorkbenchReadFileResult,
} from '@shared/contracts'

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
    const requestedPath = request.path ?? '.'
    let projectRoot: string
    let directoryPath: string
    try {
      projectRoot = await this.resolveProjectRoot(request.projectRoot)
      directoryPath = await this.resolveInsideProject(projectRoot, requestedPath)
    } catch (error) {
      throw this.normalizeDirectoryReadError(error, requestedPath)
    }

    const directoryStats = await stat(directoryPath).catch((error: unknown) => {
      throw this.normalizeDirectoryReadError(error, requestedPath)
    })
    if (!directoryStats.isDirectory()) {
      throw new Error('工作台目录读取目标必须是目录。')
    }

    const includeHidden = !!request.includeHidden
    const limit = this.clampLimit(request.limit)
    const dirents = await readdir(directoryPath, { withFileTypes: true }).catch(
      (error: unknown) => {
        throw this.normalizeDirectoryReadError(error, requestedPath)
      }
    )
    const visibleDirents = dirents.filter((entry) =>
      this.shouldIncludeEntry(entry.name, entry.isDirectory(), includeHidden)
    )
    const limitedDirents = visibleDirents.slice(0, limit)
    const directoryRelativePath = this.toProjectRelativePath(projectRoot, directoryPath)
    const entryRelativePaths = limitedDirents.map((entry) =>
      this.toProjectRelativePath(projectRoot, resolve(directoryPath, entry.name))
    )
    const gitIgnoredPaths = await this.getGitIgnoredPaths(projectRoot, [
      ...(directoryRelativePath === '.' ? [] : [directoryRelativePath]),
      ...entryRelativePaths,
    ])
    const isDirectoryGitIgnored = gitIgnoredPaths.has(directoryRelativePath)

    const entries: WorkbenchDirectoryEntry[] = []
    for (const [index, dirent] of limitedDirents.entries()) {
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
        path: entryRelativePaths[index]!,
        type: isDirectory ? 'directory' : 'file',
        size,
        modifiedAt,
        gitIgnored: isDirectoryGitIgnored || gitIgnoredPaths.has(entryRelativePaths[index]!),
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
    try {
      const projectRoot = await this.resolveProjectRoot(request.projectRoot)
      const filePath = await this.resolveInsideProject(projectRoot, request.path)
      const fileStats = await stat(filePath)
      if (!fileStats.isFile()) {
        throw new AppError('VALIDATION', '工作台文件读取目标必须是文件。')
      }

      const buffer = await readFile(filePath)
      if (!this.isLikelyTextFile(buffer)) {
        throw new AppError('VALIDATION', '当前文件不是可预览的文本文件。')
      }

      const maxChars = this.clampReadMaxChars(request.maxChars)
      const fullContent = buffer.toString('utf8')
      const truncated = fullContent.length > maxChars
      const relativePath = this.toProjectRelativePath(projectRoot, filePath)
      const gitIgnored = (await this.getGitIgnoredPaths(projectRoot, [relativePath])).has(
        relativePath
      )

      return {
        projectRoot,
        path: relativePath,
        content: truncated ? fullContent.slice(0, maxChars) : fullContent,
        size: fileStats.size,
        modifiedAt: fileStats.mtimeMs,
        totalLines: fullContent.split(/\r?\n/).length,
        truncated,
        gitIgnored,
      }
    } catch (error) {
      throw this.normalizeReadError(error, request.path)
    }
  }

  private normalizeReadError(error: unknown, path: string): Error {
    if (error instanceof AppError) return error

    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return new AppError('NOT_FOUND', `文件已被删除或移动：${path}`)
    if (code === 'EACCES' || code === 'EPERM')
      return new AppError('PERMISSION', `没有权限读取文件：${path}`)

    return AppError.from(error)
  }

  private normalizeDirectoryReadError(error: unknown, path: string): Error {
    if (error instanceof AppError) return error

    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return new AppError('NOT_FOUND', `目录已被删除或移动：${path}`)
    if (code === 'EACCES' || code === 'EPERM')
      return new AppError('PERMISSION', `没有权限读取目录：${path}`)

    return AppError.from(error)
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

  private async getGitIgnoredPaths(projectRoot: string, paths: readonly string[]): Promise<Set<string>> {
    const normalizedPaths = paths.filter((path) => path && path !== '.')
    if (normalizedPaths.length === 0) return new Set()

    try {
      const result = await execa('git', ['-C', projectRoot, 'check-ignore', '-z', '--stdin'], {
        input: `${normalizedPaths.join('\0')}\0`,
        stderr: 'ignore',
        reject: false,
      })
      if (result.exitCode !== 0) return new Set()
      return new Set(
        result.stdout
          .split('\0')
          .filter(Boolean)
          .map((path) => path.split(sep).join('/'))
      )
    } catch {
      return new Set()
    }
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
