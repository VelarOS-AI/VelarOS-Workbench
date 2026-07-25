/**
 * Git 新文件追踪器（照搬 desktop `workspace/storage/git/NewFileTracker.ts`）。
 *
 * 只暂存 Git 已识别为未追踪且未被忽略的新文件；已跟踪文件、忽略文件、目录和非仓库根目录都会跳过，
 * 避免普通文件创建流程被意外改变。任何失败只降级为 skipped + 日志，不影响创建本身。
 *
 * 独立应用适配：desktop 经 `shellEnvService` 取真实登录 shell PATH；独立应用先用
 * `process.env` 直跑（Finder 启动场景 git 不可达时按"非仓库"优雅跳过），shell 环境
 * 探针随片5 终端面接入时再统一。
 */
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import { execa } from 'execa'

import { isEmpty, isObject, isPresent, Log } from '@velaros/core'
import {
  getRelativePathInsideRoot,
  toPortableRelativePath,
} from '@velaros/core/utils/PathContainmentHelper'

interface GitNewFileTrackResult {
  rootPath: string
  repository: boolean
  requestedPaths: string[]
  trackedPaths: string[]
  skippedPaths: string[]
  error: Nullable<string>
}

class GitNewFileTracker {
  private readonly log = Log.tag('GitNewFileTracker')

  /** 检查候选路径并把仓库内可追踪的新文件加入暂存区。 */
  public async trackNewFiles(
    rootPath: string,
    paths: readonly string[]
  ): Promise<GitNewFileTrackResult> {
    const normalizedRoot = resolve(rootPath)
    const requestedPaths = this.normalizeCandidatePaths(normalizedRoot, paths)
    const result: GitNewFileTrackResult = {
      rootPath: normalizedRoot,
      repository: false,
      requestedPaths,
      trackedPaths: [],
      skippedPaths: [],
      error: null,
    }

    if (isEmpty(requestedPaths)) return result

    try {
      const gitRoot = await this.findGitRoot(normalizedRoot)
      if (!gitRoot) {
        result.skippedPaths = requestedPaths
        return result
      }

      result.repository = true
      const existingFiles = await this.filterExistingFiles(requestedPaths)
      if (!existingFiles.length) {
        result.skippedPaths = requestedPaths
        return result
      }

      const relativePaths = this.toGitRelativePaths(gitRoot, existingFiles)
      const untrackedPaths = await this.listUntrackedPaths(gitRoot, relativePaths)
      if (!untrackedPaths.length) {
        result.skippedPaths = requestedPaths
        return result
      }

      await this.runGit(gitRoot, ['add', '--', ...untrackedPaths])
      result.trackedPaths = untrackedPaths
      const tracked = new Set(untrackedPaths)
      result.skippedPaths = relativePaths.filter((path) => !tracked.has(path))
      return result
    } catch (error) {
      const message = this.getErrorMessage(error)
      result.error = message
      result.skippedPaths = requestedPaths
      this.log.warn('自动追踪 Git 新文件失败', {
        rootPath: normalizedRoot,
        paths: requestedPaths,
        error: message,
      })
      return result
    }
  }

  private normalizeCandidatePaths(rootPath: string, paths: readonly string[]): string[] {
    const normalized = new Set<string>()
    for (const path of paths) {
      const trimmedPath = path.trim()
      if (!trimmedPath) {
        continue
      }

      const absolutePath = isAbsolute(trimmedPath)
        ? resolve(trimmedPath)
        : resolve(rootPath, trimmedPath)
      if (!isPresent(getRelativePathInsideRoot(rootPath, absolutePath))) {
        continue
      }
      normalized.add(absolutePath)
    }
    return [...normalized]
  }

  private async findGitRoot(rootPath: string): Promise<Nullable<string>> {
    try {
      const output = await this.runGit(rootPath, ['rev-parse', '--show-toplevel'])
      return output.trim() ? resolve(output.trim()) : null
    } catch (error) {
      this.log.debug('解析新文件追踪的 Git 根目录失败', { rootPath, error })
      return null
    }
  }

  private async filterExistingFiles(paths: readonly string[]): Promise<string[]> {
    const files: string[] = []
    for (const path of paths) {
      const fileStats = await stat(path).catch(() => null)
      if (fileStats?.isFile()) {
        files.push(await realpath(path).catch(() => path))
      }
    }
    return files
  }

  private toGitRelativePaths(gitRoot: string, paths: readonly string[]): string[] {
    const normalized = new Set<string>()
    for (const path of paths) {
      const relativePath = getRelativePathInsideRoot(gitRoot, path)
      if (relativePath && relativePath !== '.') {
        normalized.add(toPortableRelativePath(relativePath))
      }
    }
    return [...normalized]
  }

  private async listUntrackedPaths(
    gitRoot: string,
    relativePaths: readonly string[]
  ): Promise<string[]> {
    if (isEmpty(relativePaths)) return []

    const output = await this.runGit(gitRoot, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      ...relativePaths,
    ])
    return output.split('\0').filter(Boolean)
  }

  private async runGit(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execa('git', args, {
      cwd,
      env: process.env,
      maxBuffer: 1024 * 1024,
    })
    return stdout
  }

  private getErrorMessage(error: unknown): string {
    if (!isPresent(error) || !isObject(error)) return String(error)

    const record = error as { stderr?: unknown; stdout?: unknown; message?: unknown }
    const stderr = String(record.stderr ?? '').trim()
    const stdout = String(record.stdout ?? '').trim()
    const message = String(record.message ?? '').trim()
    return stderr || stdout || message || 'unknown error'
  }
}

export { GitNewFileTracker }
export type { GitNewFileTrackResult }
