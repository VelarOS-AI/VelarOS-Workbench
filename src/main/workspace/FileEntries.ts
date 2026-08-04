/**
 * 目录条目辅助（照搬 desktop `workspace/workbench/FileEntries.ts`，保形零改动）。
 *
 * 两套可见性规则并存：搜索/变异面用 shouldIncludeEntry（内部重型目录整体隐身），
 * 目录列表面用 shouldIncludeDirectoryListingEntry（仅 `.git` 恒隐藏）。
 */
import { opendir, realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'

import { shouldSkipProjectDirectory } from '@velaros-ai/project/files'

import type { WorkbenchDirectoryEntry } from '@shared/contracts'

import type { PathResolver } from './PathResolver'

class DirectoryEntries {
  constructor(private readonly pathResolver: PathResolver) {}

  public async toDirectoryEntry(
    projectRoot: string,
    requestedPath: string,
    includeHidden: boolean
  ): Promise<WorkbenchDirectoryEntry> {
    const realPath = await realpath(requestedPath)
    this.pathResolver.assertAllowedProjectPath(projectRoot, requestedPath, requestedPath)
    this.pathResolver.assertAllowedProjectPath(projectRoot, realPath, requestedPath)

    const entryStats = await stat(realPath)
    const isDirectory = entryStats.isDirectory()

    return {
      name: basename(requestedPath),
      path: this.pathResolver.toProjectRelativePath(projectRoot, requestedPath),
      type: isDirectory ? 'directory' : 'file',
      size: entryStats.isFile() ? entryStats.size : null,
      modifiedAt: entryStats.mtimeMs,
      hasChildren: isDirectory ? await this.hasVisibleChildren(realPath, includeHidden) : false,
    }
  }

  public shouldIncludeEntry(name: string, isDirectory: boolean, includeHidden: boolean): boolean {
    if (isDirectory && shouldSkipProjectDirectory(name)) return false

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

  public async hasVisibleChildren(path: string, includeHidden: boolean): Promise<boolean> {
    const directory = await opendir(path).catch(() => null)
    if (!directory) return false

    for await (const entry of directory) {
      if (this.shouldIncludeEntry(entry.name, entry.isDirectory(), includeHidden)) return true
    }
    return false
  }
}

export { DirectoryEntries, DirectoryEntries as WorkbenchDirectoryEntryHelper }
