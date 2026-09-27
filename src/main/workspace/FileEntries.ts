/**
 * 目录条目辅助（照搬 desktop `workspace/workbench/FileEntries.ts`，保形零改动）。
 *
 * 两套可见性规则并存：搜索/变异面用 shouldIncludeEntry（内部目录与生成目录按位置隐身，
 * 见 WorkbenchSkippedDirectories），目录列表面用 shouldIncludeDirectoryListingEntry
 * （仅 `.git` 恒隐藏）。
 */
import { lstat, opendir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { WorkbenchDirectoryEntry } from '@shared/contracts'

import type { PathResolver } from './PathResolver'
import { shouldSkipProjectDirectory } from './WorkbenchSkippedDirectories'
import { describeWorkbenchSymlink } from './WorkbenchSymlinks'

class DirectoryEntries {
  constructor(private readonly pathResolver: PathResolver) {}

  public async toDirectoryEntry(
    projectRoot: string,
    requestedPath: string,
    includeHidden: boolean
  ): Promise<WorkbenchDirectoryEntry> {
    this.pathResolver.assertAllowedProjectPath(projectRoot, requestedPath, requestedPath)
    const linkStats = await lstat(requestedPath)
    if (linkStats.isSymbolicLink())
      return this.toSymlinkEntry(projectRoot, requestedPath, linkStats.mtimeMs, includeHidden)

    const realPath = await realpath(requestedPath)
    this.pathResolver.assertAllowedProjectPath(projectRoot, realPath, requestedPath)

    const entryStats = await stat(realPath)
    const isDirectory = entryStats.isDirectory()

    return {
      name: basename(requestedPath),
      path: this.pathResolver.toProjectRelativePath(projectRoot, requestedPath),
      type: isDirectory ? 'directory' : 'file',
      size: entryStats.isFile() ? entryStats.size : null,
      modifiedAt: entryStats.mtimeMs,
      hasChildren: isDirectory
        ? await this.hasVisibleChildren(realPath, includeHidden, realPath === projectRoot)
        : false,
    }
  }

  /**
   * 链接本身这一项：目标在工程里按目标算（目录照常能展开）；在工程外或已不存在就是
   * 一项不能展开的叶子，不跟进去。
   */
  private async toSymlinkEntry(
    projectRoot: string,
    requestedPath: string,
    linkModifiedAt: number,
    includeHidden: boolean
  ): Promise<WorkbenchDirectoryEntry> {
    const name = basename(requestedPath)
    const linkPath = join(await realpath(dirname(requestedPath)), name)
    const link = await describeWorkbenchSymlink(projectRoot, linkPath)
    const target = link.resolved
    const isDirectory = !!target?.stats.isDirectory()
    const isProjectRoot = target?.realPath === projectRoot
    const hasChildren =
      !!target &&
      isDirectory &&
      (await this.hasVisibleChildren(target.realPath, includeHidden, isProjectRoot))

    return {
      name,
      path: this.pathResolver.toProjectRelativePath(projectRoot, requestedPath),
      type: isDirectory ? 'directory' : 'file',
      size: target?.stats.isFile() ? target.stats.size : null,
      modifiedAt: target?.stats.mtimeMs ?? linkModifiedAt,
      hasChildren,
      symlink: link.symlink,
    }
  }

  /** `atProjectRoot`：这一项直接在工程根目录下（根目录下的构建产物才跳过）。 */
  public shouldIncludeEntry(
    name: string,
    isDirectory: boolean,
    includeHidden: boolean,
    atProjectRoot: boolean
  ): boolean {
    if (isDirectory && shouldSkipProjectDirectory(name, atProjectRoot)) return false

    if (!includeHidden && name.startsWith('.')) return false

    return true
  }

  public shouldIncludeDirectoryListingEntry(
    name: string,
    isDirectory: boolean,
    includeHidden: boolean
  ): boolean {
    if (isDirectory && name === '.git') return false

    if (!includeHidden && name.startsWith('.')) return false

    return true
  }

  public async hasVisibleDirectoryListingChildren(
    path: string,
    includeHidden: boolean
  ): Promise<boolean> {
    const directory = await opendir(path).catch(() => null)
    if (!directory) return false

    for await (const entry of directory) {
      if (this.shouldIncludeDirectoryListingEntry(entry.name, entry.isDirectory(), includeHidden))
        return true
    }
    return false
  }

  /** `isProjectRoot`：`path` 就是工程根目录。 */
  public async hasVisibleChildren(
    path: string,
    includeHidden: boolean,
    isProjectRoot: boolean
  ): Promise<boolean> {
    const directory = await opendir(path).catch(() => null)
    if (!directory) return false

    for await (const entry of directory) {
      if (this.shouldIncludeEntry(entry.name, entry.isDirectory(), includeHidden, isProjectRoot))
        return true
    }
    return false
  }
}

export { DirectoryEntries, DirectoryEntries as WorkbenchDirectoryEntryHelper }
