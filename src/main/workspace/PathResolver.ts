/**
 * 工作台路径解析器（照搬 desktop `workspace/workbench/PathResolver.ts`，保形零改动）。
 *
 * root 越界防护单源：requestedPath 与 realpath 双重收束进 projectRoot，
 * 越界一律 PERMISSION 拒绝；条目名规范化拒绝路径分隔符 / 隐藏项 / 内部重型目录。
 */
import { realpathSync, statSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { AppError } from '@velaros-ai/core/error'
import { LoggerFactory } from '@velaros-ai/core/logger'

import {
  getRelativePathInsideRoot,
  toPortableRelativePath,
} from './PathContainmentHelper'
import { shouldSkipProjectDirectory } from './WorkbenchSkippedDirectories'

interface ResolvedPath {
  requestedPath: string
  realPath: string
}

const log = LoggerFactory.create('WorkbenchPathResolver')

class PathResolver {
  public async resolveProjectRoot(input: string): Promise<string> {
    if (!input.trim()) {
      throw new AppError('VALIDATION', '需要选择一个工程目录。')
    }

    const projectRoot = resolve(input)
    const projectStats = await stat(projectRoot)
    if (!projectStats.isDirectory()) {
      throw new AppError('VALIDATION', '需要选择一个工程目录。')
    }

    return realpath(projectRoot)
  }

  public resolveProjectRootSync(input: string): string {
    if (!input.trim()) {
      throw new AppError('VALIDATION', '需要选择一个工程目录。')
    }

    const projectRoot = resolve(input)
    const projectStats = statSync(projectRoot)
    if (!projectStats.isDirectory()) {
      throw new AppError('VALIDATION', '需要选择一个工程目录。')
    }

    return realpathSync(projectRoot)
  }

  public async resolveInsideProject(projectRoot: string, inputPath: string): Promise<ResolvedPath> {
    const requestedPath = inputPath.trim() || '.'
    const resolvedPath = resolve(projectRoot, requestedPath)
    this.assertAllowedProjectPath(projectRoot, resolvedPath, inputPath)

    const realPath = await realpath(resolvedPath).catch((error: unknown) => {
      throw this.normalizeResolveError(error, inputPath)
    })
    this.assertAllowedProjectPath(projectRoot, realPath, inputPath)

    return {
      requestedPath: resolvedPath,
      realPath,
    }
  }

  public resolveInsideProjectSync(projectRoot: string, inputPath: string): ResolvedPath {
    const requestedPath = inputPath.trim() || '.'
    const resolvedPath = resolve(projectRoot, requestedPath)
    this.assertAllowedProjectPath(projectRoot, resolvedPath, inputPath)

    let realPath: string
    try {
      realPath = realpathSync(resolvedPath)
    } catch (error) {
      throw this.normalizeResolveError(error, inputPath)
    }
    this.assertAllowedProjectPath(projectRoot, realPath, inputPath)

    return {
      requestedPath: resolvedPath,
      realPath,
    }
  }

  public assertAllowedProjectPath(
    projectRoot: string,
    absolutePath: string,
    inputPath: string
  ): void {
    const relativePath = getRelativePathInsideRoot(projectRoot, absolutePath)
    if (!relativePath) {
      throw new AppError('PERMISSION', `路径超出工程范围：${inputPath}`)
    }
  }

  public isAllowedProjectPath(projectRoot: string, absolutePath: string): boolean {
    try {
      this.assertAllowedProjectPath(projectRoot, absolutePath, absolutePath)
      return true
    } catch (error) {
      log.debug('工作台路径解析器拒绝项目路径', {
        projectRoot,
        absolutePath,
        error,
      })
      return false
    }
  }

  public toProjectRelativePath(projectRoot: string, absolutePath: string): string {
    const relativePath = getRelativePathInsideRoot(projectRoot, absolutePath)
    if (!relativePath || relativePath === '.') return '.'

    return toPortableRelativePath(relativePath)
  }

  public normalizeEntryName(name: string): string {
    const trimmedName = name.trim()
    if (!trimmedName) {
      throw new AppError('VALIDATION', '名称不能为空。')
    }

    if (trimmedName === '.' || trimmedName === '..') {
      throw new AppError('VALIDATION', '名称不能是 . 或 ..。')
    }

    if (
      trimmedName.includes('/') ||
      trimmedName.includes('\\') ||
      basename(trimmedName) !== trimmedName
    ) {
      throw new AppError('VALIDATION', '名称不能包含路径分隔符。')
    }

    if (trimmedName.startsWith('.')) {
      throw new AppError('VALIDATION', '当前工作台暂不直接管理隐藏项。')
    }

    if (shouldSkipProjectDirectory(trimmedName)) {
      throw new AppError('VALIDATION', '当前名称属于内部或重型目录，不能在工作台中直接管理。')
    }

    return trimmedName
  }

  public resolveChildPath(projectRoot: string, parentPath: string, name: string): string {
    const targetPath = resolve(parentPath, name)
    this.assertAllowedProjectPath(projectRoot, targetPath, name)
    return targetPath
  }

  private normalizeResolveError(error: unknown, path: string): AppError {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return new AppError('NOT_FOUND', `文件或目录已被删除或移动：${path}`)
    if (code === 'EACCES' || code === 'EPERM')
      return new AppError('PERMISSION', `没有权限访问文件或目录：${path}`)

    return AppError.from(error)
  }
}

export { PathResolver, PathResolver as WorkbenchPathResolver }
export type { ResolvedPath, ResolvedPath as ResolvedWorkbenchPath }
