/**
 * 工作台路径解析器（源自 desktop `workspace/workbench/PathResolver.ts`）。
 *
 * root 越界防护单源：requestedPath 与 realpath 双重收束进 projectRoot，越界一律 PERMISSION 拒绝。
 * 文件树里看得到的都能管：点号开头的名字（`.env`）、`dist` / `node_modules` 这类目录照样能新建、
 * 改名、移动；真正要挡的只有越出工程与版本库内部（任何一段是 `.git`）。
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

interface ResolvedPath {
  requestedPath: string
  realPath: string
}

const log = LoggerFactory.create('WorkbenchPathResolver')

/**
 * 这一段名字是不是版本库目录：大小写不敏感的文件系统上 `.GIT` 就是 `.git`，Windows 还会吞掉
 * 末尾的点与空格（`.git.` 也是它）。
 */
function isGitDirectoryName(name: string): boolean {
  return name.toLowerCase().replace(/[. ]+$/u, '') === '.git'
}

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

    if (isGitDirectoryName(trimmedName)) {
      throw new AppError('VALIDATION', '.git 是版本库的内部目录，不能在工作台中直接管理。')
    }

    return trimmedName
  }

  /**
   * 文件树的写操作不碰版本库内部：路径里任何一段是 `.git`（含嵌套仓库与子模块的 `.git`）就拒绝。
   * 逻辑路径与解析过链接的真实路径都要查，免得经由指向 `.git` 的链接绕进去。
   */
  public assertOutsideGitInternals(
    projectRoot: string,
    absolutePath: string,
    inputPath: string
  ): void {
    const relativePath = getRelativePathInsideRoot(projectRoot, absolutePath)
    if (!relativePath) {
      throw new AppError('PERMISSION', `路径超出工程范围：${inputPath}`)
    }

    if (relativePath.split(/[\\/]/u).some(isGitDirectoryName)) {
      throw new AppError('VALIDATION', `不能在工作台中直接改动版本库内部：${inputPath}`)
    }
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
