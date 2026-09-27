/**
 * 独立 Workbench 应用 main 侧项目文件系统服务（host 实装第一段：项目范围内的纯读能力）。
 *
 * 行为蒸馏自 desktop 被摘除前的 workbench main 面（DirectoryListing / FileOperations /
 * PathResolver，可考古 `cf62413e4^`），契约形状单源于 `@shared/contracts`：
 * - 目录列表：projectRoot 越界防护（realpath 收束）、`.git` 恒隐藏、点号项默认隐藏、
 *   目录优先 + localeCompare 排序、hasChildren 可见子项探针、limit 钳制 + truncated。
 * - 读文本：文本似然门（NUL + 控制字节占比）、认编码与换行符（`TextCodec`）、maxChars 钳制截断。
 * - 读图片：PNG / SVG / WebP 白名单、格式头校验、读取体积上限和同句柄变更检测。
 *
 * Git 排除装饰沿用 Desktop 语义：每次目录读取批量调用一次 `git check-ignore`，
 * 已排除目录的子树继承弱化状态；非 Git 工程或 Git 不可用时安全退化为普通目录。
 * 符号链接总是列出来：目标在工程里的按目标算，在工程外或已不存在的只显示链接本身（不能展开，
 * 不跟进去）。经由工程里的目录链接展开时，子项路径挂在链接下面。
 * 错误一律抛 Error，由 IPC 装配层降为 `WorkbenchFsCallResult` 信封。
 */
import type { Stats } from 'node:fs'
import { open, opendir, readdir, realpath, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

import { execa } from 'execa'

import { AppError } from '@velaros-ai/core/error'

import type {
  WorkbenchDirectoryEntry,
  WorkbenchDirectoryEntrySymlink,
  WorkbenchListDirectoryRequest,
  WorkbenchListDirectoryResult,
  WorkbenchReadFileRequest,
  WorkbenchReadFileResult,
  WorkbenchReadImageFileRequest,
  WorkbenchReadImageFileResult,
} from '@shared/contracts'
import {
  resolveWorkbenchImageMediaType,
  type WorkbenchImageMediaType,
} from '@shared/workbenchImage'
import { DefaultWorkbenchTextFormat } from '@shared/workbenchTextFormat'

import { isPathInsideRoot } from './PathContainmentHelper'
import { readWorkbenchTextFile } from './TextFile'
import { describeWorkbenchSymlink } from './WorkbenchSymlinks'

const DefaultDirectoryLimit = 1000
const MaxDirectoryLimit = 5000
const DefaultReadMaxChars = 300_000
const MaxReadChars = 1_000_000
const MaxImageReadBytes = 10 * 1024 * 1024
const SvgProbeMaxBytes = 64 * 1024
const PngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

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
    // 条目路径按请求的路径拼：经由工程里的目录链接展开时，子项挂在链接下面（`linkdir/a.ts`），
    // 不换成链接指向的目录——否则同一个文件在树里出现两次、ID 撞车，链接下面也永远是空的。
    // 读目录、查 Git 排除仍按真实路径（Git 不认经过链接的路径）。
    const logicalDirectoryPath = resolve(projectRoot, requestedPath.trim() || '.')
    const realDirectoryRelativePath = this.toProjectRelativePath(projectRoot, directoryPath)
    const entryRelativePaths = limitedDirents.map((entry) =>
      this.toProjectRelativePath(projectRoot, resolve(logicalDirectoryPath, entry.name))
    )
    const realEntryRelativePaths = limitedDirents.map((entry) =>
      this.toProjectRelativePath(projectRoot, resolve(directoryPath, entry.name))
    )
    const gitIgnoredPaths = await this.getGitIgnoredPaths(projectRoot, [
      ...(realDirectoryRelativePath === '.' ? [] : [realDirectoryRelativePath]),
      ...realEntryRelativePaths,
    ])
    const isDirectoryGitIgnored = gitIgnoredPaths.has(realDirectoryRelativePath)

    const entries: WorkbenchDirectoryEntry[] = []
    for (const [index, dirent] of limitedDirents.entries()) {
      const entryAbsolutePath = resolve(directoryPath, dirent.name)
      if (!this.isInsideProject(projectRoot, entryAbsolutePath)) continue

      let isDirectory = dirent.isDirectory()
      let isFile = dirent.isFile()
      let size: Nullable<number> = null
      let modifiedAt: Nullable<number> = null
      let symlink: WorkbenchDirectoryEntrySymlink | undefined
      if (dirent.isSymbolicLink()) {
        // 目标在工程里按目标算；在工程外或已不存在就只是链接本身，一项不能展开的叶子。
        const link = await describeWorkbenchSymlink(projectRoot, entryAbsolutePath)
        const targetStats = link.resolved?.stats
        symlink = link.symlink
        isDirectory = !!targetStats?.isDirectory()
        isFile = targetStats ? targetStats.isFile() : true
        size = targetStats?.isFile() ? targetStats.size : null
        modifiedAt = targetStats?.mtimeMs ?? null
      }
      // 套接字、管道、设备文件（以及指向它们的链接）不进文件树。
      if (!isDirectory && !isFile) continue

      entries.push({
        name: dirent.name,
        path: entryRelativePaths[index]!,
        type: isDirectory ? 'directory' : 'file',
        size,
        modifiedAt,
        gitIgnored: isDirectoryGitIgnored || gitIgnoredPaths.has(realEntryRelativePaths[index]!),
        hasChildren: isDirectory
          ? await this.hasVisibleChildren(entryAbsolutePath, includeHidden)
          : false,
        symlink,
      })
    }

    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1

      return a.name.localeCompare(b.name)
    })

    return {
      projectRoot,
      path: this.toProjectRelativePath(projectRoot, logicalDirectoryPath),
      entries,
      truncated: visibleDirents.length > limit,
    }
  }

  public async readTextFile(request: WorkbenchReadFileRequest): Promise<WorkbenchReadFileResult> {
    try {
      const projectRoot = await this.resolveProjectRoot(request.projectRoot)
      const filePath = await this.resolveInsideProject(projectRoot, request.path)
      const file = await readWorkbenchTextFile(filePath, this.clampReadMaxChars(request.maxChars))
      const relativePath = this.toProjectRelativePath(projectRoot, filePath)
      const gitIgnored = (await this.getGitIgnoredPaths(projectRoot, [relativePath])).has(
        relativePath
      )

      return {
        projectRoot,
        path: relativePath,
        ...file,
        gitIgnored,
      }
    } catch (error) {
      throw this.normalizeReadError(error, request.path)
    }
  }

  public async readImageFile(
    request: WorkbenchReadImageFileRequest
  ): Promise<WorkbenchReadImageFileResult> {
    try {
      const projectRoot = await this.resolveProjectRoot(request.projectRoot)
      const filePath = await this.resolveInsideProject(projectRoot, request.path)
      const mediaType = resolveWorkbenchImageMediaType(filePath)
      if (!mediaType) {
        throw new AppError('VALIDATION', '当前文件不是受支持的图片格式。')
      }

      const maxBytes = this.clampImageReadMaxBytes(request.maxBytes)
      const handle = await open(filePath, 'r')
      let fileStats: Stats
      let buffer = Buffer.alloc(0)
      try {
        fileStats = await handle.stat()
        if (!fileStats.isFile()) {
          throw new AppError('VALIDATION', '工作台图片读取目标必须是文件。')
        }
        if (fileStats.size > maxBytes) {
          throw new AppError(
            'VALIDATION',
            `图片超过 ${this.formatByteLimit(maxBytes)} 的预览上限。`
          )
        }

        buffer = Buffer.allocUnsafe(fileStats.size)
        let offset = 0
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
          if (bytesRead === 0) break
          offset += bytesRead
        }
        const finalStats = await handle.stat()
        if (
          offset !== buffer.length
          || finalStats.size !== fileStats.size
          || finalStats.mtimeMs !== fileStats.mtimeMs
        ) {
          throw new AppError('CONFLICT', '图片在读取过程中发生变化，请重新打开。')
        }
      } finally {
        await handle.close()
      }

      if (!this.matchesImageFormat(buffer, mediaType)) {
        throw new AppError('VALIDATION', '图片内容与文件格式不匹配。')
      }

      const relativePath = this.toProjectRelativePath(projectRoot, filePath)
      const gitIgnored = (await this.getGitIgnoredPaths(projectRoot, [relativePath])).has(
        relativePath
      )
      return {
        projectRoot,
        path: relativePath,
        content: '',
        // 图片不进文本保存链路；编码字段只为与文本结果同形。
        ...DefaultWorkbenchTextFormat,
        size: fileStats.size,
        modifiedAt: fileStats.mtimeMs,
        totalLines: 1,
        truncated: false,
        gitIgnored,
        imagePreview: {
          mediaType,
          data: Uint8Array.from(buffer),
        },
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

  /** 只有 `..` 这一段才是往上走：`..foo` 这样以两个点开头的名字仍在工程里。 */
  private isInsideProject(projectRoot: string, absolutePath: string): boolean {
    return isPathInsideRoot(projectRoot, absolutePath)
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

  private clampLimit(value: number | undefined): number {
    if (!value || !Number.isFinite(value)) return DefaultDirectoryLimit

    return Math.min(MaxDirectoryLimit, Math.max(1, Math.round(value)))
  }

  private clampReadMaxChars(value: number | undefined): number {
    if (!value || !Number.isFinite(value)) return DefaultReadMaxChars

    return Math.min(MaxReadChars, Math.max(1, Math.round(value)))
  }

  private clampImageReadMaxBytes(value: number | undefined): number {
    if (!value || !Number.isFinite(value)) return MaxImageReadBytes

    return Math.min(MaxImageReadBytes, Math.max(1, Math.round(value)))
  }

  private formatByteLimit(value: number): string {
    if (value < 1024) return `${value} B`
    if (value < 1024 * 1024) return `${Math.round(value / 1024)} KiB`

    return `${Math.round(value / (1024 * 1024))} MiB`
  }

  private matchesSvgFormat(buffer: Buffer): boolean {
    if (buffer.includes(0)) return false

    let source: string
    try {
      const sample = buffer.subarray(0, SvgProbeMaxBytes)
      source = new TextDecoder('utf-8', { fatal: true }).decode(sample, {
        stream: buffer.length > sample.length,
      })
    } catch {
      return false
    }

    source = source.replace(/^\uFEFF/u, '')
    for (let prefixCount = 0; prefixCount < 32; prefixCount += 1) {
      source = source.trimStart()
      if (source.startsWith('<?')) {
        const end = source.indexOf('?>')
        if (end < 0) return false
        source = source.slice(end + 2)
        continue
      }
      if (source.startsWith('<!--')) {
        const end = source.indexOf('-->')
        if (end < 0) return false
        source = source.slice(end + 3)
        continue
      }
      if (/^<!doctype\s+svg(?:\s|>)/iu.test(source)) {
        const end = source.indexOf('>')
        if (end < 0 || source.slice(0, end).includes('[')) return false
        source = source.slice(end + 1)
        continue
      }
      break
    }

    return /^<svg(?:[\s/>])/iu.test(source.trimStart())
  }

  private matchesPngFormat(buffer: Buffer): boolean {
    if (
      buffer.length < 45
      || !buffer.subarray(0, PngSignature.length).equals(PngSignature)
    ) return false

    let offset = PngSignature.length
    let hasImageData = false
    let chunkIndex = 0
    while (offset + 12 <= buffer.length) {
      const dataLength = buffer.readUInt32BE(offset)
      if (dataLength > buffer.length - offset - 12) return false

      const chunkType = buffer.toString('ascii', offset + 4, offset + 8)
      if (chunkIndex === 0 && (chunkType !== 'IHDR' || dataLength !== 13)) return false
      if (chunkType === 'IDAT') hasImageData = true

      offset += dataLength + 12
      if (chunkType === 'IEND')
        return dataLength === 0 && hasImageData && offset === buffer.length
      chunkIndex += 1
    }

    return false
  }

  private matchesWebpFormat(buffer: Buffer): boolean {
    if (
      buffer.length < 20
      || buffer.toString('ascii', 0, 4) !== 'RIFF'
      || buffer.toString('ascii', 8, 12) !== 'WEBP'
      || buffer.readUInt32LE(4) + 8 !== buffer.length
    ) return false

    const chunkType = buffer.toString('ascii', 12, 16)
    if (chunkType !== 'VP8 ' && chunkType !== 'VP8L' && chunkType !== 'VP8X') return false

    const chunkLength = buffer.readUInt32LE(16)
    const paddedChunkLength = chunkLength + (chunkLength % 2)
    return paddedChunkLength <= buffer.length - 20
  }

  private matchesImageFormat(buffer: Buffer, mediaType: WorkbenchImageMediaType): boolean {
    switch (mediaType) {
      case 'image/png':
        return this.matchesPngFormat(buffer)
      case 'image/webp':
        return this.matchesWebpFormat(buffer)
      case 'image/svg+xml':
        return this.matchesSvgFormat(buffer)
    }
  }
}
