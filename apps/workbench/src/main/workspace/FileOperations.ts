/**
 * 工作台文件写族（照搬 desktop `workspace/workbench/FileOperations.ts`，root 越界防护与
 * 回收站语义保形）。
 *
 * 独立应用适配（三处，均为装配面不动行为）：
 * - `storagePathService` / `workbenchLocalHistoryStore` 模块单例 → 构造注入
 *   （`WorkbenchAppStoragePaths` / `WorkbenchLocalHistoryStore`）。
 * - desktop 的 `WorkspaceCollaborationCoordinator` 租约层不随迁（独立应用没有 agent
 *   第二写者）；`runWorkbenchMutation` 保留为接缝直通，未来接协作协调时在此恢复包裹。
 * - 删除回收站布局保形：`<dataRoot>/workbench-delete-undo/<restoreId>/<basename>`，
 *   restore 记录仅存内存（应用重启即失效），与 desktop 一致。
 */
import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { isObject, isPresent } from '@velaros-ai/core'
import { AppError } from '@velaros-ai/core/error'
import type {
  WorkbenchCreateEntryRequest,
  WorkbenchDeleteEntryRequest,
  WorkbenchDeleteEntryResult,
  WorkbenchEntryMutationResult,
  WorkbenchListLocalHistoryRequest,
  WorkbenchListLocalHistoryResult,
  WorkbenchMoveEntryRequest,
  WorkbenchMoveEntryResult,
  WorkbenchReadFileRequest,
  WorkbenchReadFileResult,
  WorkbenchReadLocalHistorySnapshotRequest,
  WorkbenchReadLocalHistorySnapshotResult,
  WorkbenchRenameEntryRequest,
  WorkbenchRestoreDeletedEntryRequest,
  WorkbenchRestoreDeletedEntryResult,
  WorkbenchSaveFileRequest,
  WorkbenchSaveFileResult,
} from '@velaros-ai/core/types'

import type { DirectoryEntries } from './FileEntries'
import type { GitNewFileTracker } from './GitNewFileTracker'
import type { WorkbenchLocalHistoryStore } from './LocalHistoryStore'
import type { PathResolver, ResolvedPath } from './PathResolver'
import type { WorkbenchAppStoragePaths } from './StoragePaths'
import { isLikelyTextFile } from './TextFile'

const DEFAULT_READ_MAX_CHARS = 300_000
const MAX_READ_CHARS = 1_000_000
const MAX_WRITE_CHARS = 1_000_000
const FILE_CONFLICT_MTIME_TOLERANCE_MS = 1
const DELETE_UNDO_DIR_NAME = 'workbench-delete-undo'

interface DeletedEntryRestoreRecord {
  id: string
  projectRoot: string
  deletedPath: string
  parentPath: string
  originalPath: string
  trashPath: string
  type: 'directory' | 'file'
}

class FileOperations {
  private readonly deletedEntryRestores = new Map<string, DeletedEntryRestoreRecord>()

  constructor(
    private readonly pathResolver: PathResolver,
    private readonly entryHelper: DirectoryEntries,
    private readonly gitNewFileTracker: GitNewFileTracker,
    private readonly localHistoryStore: WorkbenchLocalHistoryStore,
    private readonly storagePaths: WorkbenchAppStoragePaths
  ) {}

  public async readFile(request: WorkbenchReadFileRequest): Promise<WorkbenchReadFileResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const filePath = await this.pathResolver.resolveInsideProject(projectRoot, request.path)
    const result = await this.readResolvedTextFile(projectRoot, filePath, request.maxChars)
    return result
  }

  public async saveFile(request: WorkbenchSaveFileRequest): Promise<WorkbenchSaveFileResult> {
    return this.saveFileSync(request)
  }

  public saveFileSync(request: WorkbenchSaveFileRequest): WorkbenchSaveFileResult {
    const projectRoot = this.pathResolver.resolveProjectRootSync(request.projectRoot)
    const filePath = this.pathResolver.resolveInsideProjectSync(projectRoot, request.path)
    return this.runWorkbenchMutationSync(() => {
      const fileStats = statSync(filePath.realPath)
      const linkStats = lstatSync(filePath.requestedPath)

      if (linkStats.isSymbolicLink()) {
        throw new AppError('VALIDATION', '工作台暂不直接编辑符号链接。')
      }

      if (!fileStats.isFile()) {
        throw new AppError('VALIDATION', '工作台文件保存目标必须是文件。')
      }

      this.assertContentIsWritable(request.content)
      this.assertFileHasNotChanged(fileStats, request)
      const currentBuffer = readFileSync(filePath.realPath)
      if (!isLikelyTextFile(currentBuffer)) {
        throw new AppError('VALIDATION', '当前文件不是可编辑的文本文件。')
      }

      writeFileSync(filePath.realPath, request.content, 'utf8')
      this.localHistoryStore.capture(projectRoot, request.path, request.content, {
        minIntervalMs: request.localHistoryMinIntervalMs,
      })
      return this.readResolvedTextFileSync(
        projectRoot,
        filePath,
        Math.max(DEFAULT_READ_MAX_CHARS, request.content.length)
      )
    })
  }

  public listLocalHistory(
    request: WorkbenchListLocalHistoryRequest
  ): WorkbenchListLocalHistoryResult {
    const projectRoot = this.pathResolver.resolveProjectRootSync(request.projectRoot)
    return this.localHistoryStore.list(projectRoot, request.path)
  }

  public readLocalHistorySnapshot(
    request: WorkbenchReadLocalHistorySnapshotRequest
  ): WorkbenchReadLocalHistorySnapshotResult {
    const projectRoot = this.pathResolver.resolveProjectRootSync(request.projectRoot)
    return this.localHistoryStore.read(projectRoot, request.path, request.id)
  }

  public async createEntry(
    request: WorkbenchCreateEntryRequest
  ): Promise<WorkbenchEntryMutationResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const parentPath = await this.pathResolver.resolveInsideProject(
      projectRoot,
      request.parentPath ?? '.'
    )
    const parentStats = await stat(parentPath.realPath)
    const parentLinkStats = await lstat(parentPath.requestedPath)

    if (!parentStats.isDirectory()) {
      throw new AppError('VALIDATION', '工作台新建目标必须位于目录内。')
    }

    if (parentLinkStats.isSymbolicLink()) {
      throw new AppError('VALIDATION', '工作台暂不在符号链接目录中新建内容。')
    }

    if (request.type !== 'directory' && request.type !== 'file') {
      throw new AppError('VALIDATION', '新建类型无效。')
    }

    const name = this.pathResolver.normalizeEntryName(request.name)
    const targetPath = this.pathResolver.resolveChildPath(
      projectRoot,
      parentPath.requestedPath,
      name
    )

    return this.runWorkbenchMutation(async () => {
      const existing = await lstat(targetPath).catch(() => null)
      if (existing) {
        throw new AppError('VALIDATION', '目标已存在。')
      }

      if (request.type === 'directory') {
        await mkdir(targetPath)
      } else {
        await writeFile(targetPath, '', { flag: 'wx' })
      }

      const entry = await this.entryHelper.toDirectoryEntry(projectRoot, targetPath, false)
      if (request.type === 'file') {
        await this.gitNewFileTracker.trackNewFiles(projectRoot, [targetPath])
      }
      return {
        projectRoot,
        parentPath: this.pathResolver.toProjectRelativePath(projectRoot, parentPath.requestedPath),
        entry,
      }
    })
  }

  public async renameEntry(
    request: WorkbenchRenameEntryRequest
  ): Promise<WorkbenchEntryMutationResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const sourcePath = await this.pathResolver.resolveInsideProject(projectRoot, request.path)
    const sourceLinkStats = await lstat(sourcePath.requestedPath)

    if (sourceLinkStats.isSymbolicLink()) {
      throw new AppError('VALIDATION', '工作台暂不直接重命名符号链接。')
    }

    if (this.pathResolver.toProjectRelativePath(projectRoot, sourcePath.requestedPath) === '.') {
      throw new AppError('VALIDATION', '不能重命名工程根目录。')
    }

    const name = this.pathResolver.normalizeEntryName(request.newName)
    const parentPath = dirname(sourcePath.requestedPath)
    const targetPath = this.pathResolver.resolveChildPath(projectRoot, parentPath, name)

    return this.runWorkbenchMutation(async () => {
      const existing = await lstat(targetPath).catch(() => null)
      if (existing) {
        throw new AppError('VALIDATION', '目标已存在。')
      }

      await rename(sourcePath.requestedPath, targetPath)
      const entry = await this.entryHelper.toDirectoryEntry(projectRoot, targetPath, false)
      return {
        projectRoot,
        parentPath: this.pathResolver.toProjectRelativePath(projectRoot, parentPath),
        entry,
      }
    })
  }

  public async moveEntry(request: WorkbenchMoveEntryRequest): Promise<WorkbenchMoveEntryResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const sourcePath = await this.pathResolver.resolveInsideProject(projectRoot, request.path)
    const parentPath = await this.pathResolver.resolveInsideProject(projectRoot, request.parentPath)
    const sourceLinkStats = await lstat(sourcePath.requestedPath)
    const parentLinkStats = await lstat(parentPath.requestedPath)

    if (sourceLinkStats.isSymbolicLink()) {
      throw new AppError('VALIDATION', '工作台暂不直接移动符号链接。')
    }

    if (parentLinkStats.isSymbolicLink()) {
      throw new AppError('VALIDATION', '工作台暂不移动内容到符号链接目录。')
    }

    const sourceRelativePath = this.pathResolver.toProjectRelativePath(
      projectRoot,
      sourcePath.requestedPath
    )
    if (sourceRelativePath === '.') {
      throw new AppError('VALIDATION', '不能移动工程根目录。')
    }

    const parentStats = await stat(parentPath.realPath)
    if (!parentStats.isDirectory()) {
      throw new AppError('VALIDATION', '工作台移动目标必须是目录。')
    }

    const sourceStats = await stat(sourcePath.realPath)
    const parentRelativePath = this.pathResolver.toProjectRelativePath(
      projectRoot,
      parentPath.requestedPath
    )
    if (
      sourceStats.isDirectory() &&
      (parentRelativePath === sourceRelativePath ||
        parentRelativePath.startsWith(`${sourceRelativePath}/`))
    ) {
      throw new AppError('VALIDATION', '不能把目录移动到自身或子目录内。')
    }

    const name = this.pathResolver.normalizeEntryName(
      request.name ?? basename(sourcePath.requestedPath)
    )
    const targetPath = this.pathResolver.resolveChildPath(
      projectRoot,
      parentPath.requestedPath,
      name
    )
    const previousParentPath = this.pathResolver.toProjectRelativePath(
      projectRoot,
      dirname(sourcePath.requestedPath)
    )
    const targetParentPath = this.pathResolver.toProjectRelativePath(
      projectRoot,
      parentPath.requestedPath
    )

    return this.runWorkbenchMutation(async () => {
      if (sourcePath.requestedPath !== targetPath) {
        const existing = await lstat(targetPath).catch(() => null)
        if (existing) {
          throw new AppError('VALIDATION', '目标已存在。')
        }

        await rename(sourcePath.requestedPath, targetPath)
      }

      const entry = await this.entryHelper.toDirectoryEntry(projectRoot, targetPath, false)
      return {
        projectRoot,
        parentPath: targetParentPath,
        previousPath: sourceRelativePath,
        previousParentPath,
        entry,
      }
    })
  }

  public async deleteEntry(
    request: WorkbenchDeleteEntryRequest
  ): Promise<WorkbenchDeleteEntryResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const targetPath = await this.pathResolver.resolveInsideProject(projectRoot, request.path)
    const relativePath = this.pathResolver.toProjectRelativePath(
      projectRoot,
      targetPath.requestedPath
    )

    if (relativePath === '.') {
      throw new AppError('VALIDATION', '不能删除工程根目录。')
    }

    return this.runWorkbenchMutation(async () => {
      const targetLinkStats = await lstat(targetPath.requestedPath)
      if (targetLinkStats.isSymbolicLink()) {
        throw new AppError('VALIDATION', '工作台暂不直接删除符号链接。')
      }

      const targetStats = await stat(targetPath.realPath)
      if (targetStats.isDirectory()) {
        const entries = await readdir(targetPath.realPath)
        if (entries.length > 0) {
          throw new AppError('VALIDATION', '目录不为空，暂不支持递归删除。')
        }
      }

      const restoreId = randomUUID()
      const trashPath = this.getDeleteUndoPath(restoreId, targetPath.requestedPath)
      await mkdir(dirname(trashPath), { recursive: true })
      await this.movePathToUndoLocation(
        targetPath.requestedPath,
        trashPath,
        targetStats.isDirectory()
      )

      const parentPath = this.pathResolver.toProjectRelativePath(
        projectRoot,
        dirname(targetPath.requestedPath)
      )
      this.deletedEntryRestores.set(restoreId, {
        id: restoreId,
        projectRoot,
        deletedPath: relativePath,
        parentPath,
        originalPath: targetPath.requestedPath,
        trashPath,
        type: targetStats.isDirectory() ? 'directory' : 'file',
      })

      return {
        projectRoot,
        parentPath,
        deletedPath: relativePath,
        restoreId,
      }
    })
  }

  public async restoreDeletedEntry(
    request: WorkbenchRestoreDeletedEntryRequest
  ): Promise<WorkbenchRestoreDeletedEntryResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const restore = this.deletedEntryRestores.get(request.restoreId)
    if (!restore || restore.projectRoot !== projectRoot) {
      throw new AppError('NOT_FOUND', '删除撤销记录不存在或已失效。')
    }

    this.pathResolver.assertAllowedProjectPath(
      projectRoot,
      restore.originalPath,
      restore.deletedPath
    )

    return this.runWorkbenchMutation(async () => {
      const existing = await lstat(restore.originalPath).catch(() => null)
      if (existing) {
        throw new AppError('CONFLICT', '还原目标已存在，无法撤销删除。')
      }

      const parentPath = dirname(restore.originalPath)
      const parentStats = await stat(parentPath)
      const parentLinkStats = await lstat(parentPath)
      if (!parentStats.isDirectory()) {
        throw new AppError('VALIDATION', '还原目标父级必须是目录。')
      }
      if (parentLinkStats.isSymbolicLink()) {
        throw new AppError('VALIDATION', '工作台暂不还原内容到符号链接目录。')
      }

      await this.movePathToUndoLocation(
        restore.trashPath,
        restore.originalPath,
        restore.type === 'directory'
      )
      const entry = await this.entryHelper.toDirectoryEntry(
        projectRoot,
        restore.originalPath,
        false
      )
      this.deletedEntryRestores.delete(restore.id)

      return {
        projectRoot,
        parentPath: restore.parentPath,
        restoredPath: restore.deletedPath,
        entry,
      }
    })
  }

  private getDeleteUndoPath(restoreId: string, originalPath: string): string {
    return join(
      this.storagePaths.getRootDir(),
      DELETE_UNDO_DIR_NAME,
      restoreId,
      basename(originalPath)
    )
  }

  private async movePathToUndoLocation(
    sourcePath: string,
    targetPath: string,
    directory: boolean
  ): Promise<void> {
    try {
      await rename(sourcePath, targetPath)
      return
    } catch (error) {
      if (!this.isCrossDeviceMoveError(error)) throw error
    }

    if (directory) {
      await cp(sourcePath, targetPath, { recursive: true, errorOnExist: true })
      await rm(sourcePath, { recursive: true, force: false })
      return
    }

    await copyFile(sourcePath, targetPath)
    await unlink(sourcePath)
  }

  private isCrossDeviceMoveError(error: unknown): boolean {
    return isObject(error) && (error as { code?: unknown }).code === 'EXDEV'
  }

  private normalizeReadMaxChars(value: number | undefined): number {
    if (!value || !Number.isFinite(value)) return DEFAULT_READ_MAX_CHARS

    return Math.min(MAX_READ_CHARS, Math.max(1, Math.round(value)))
  }

  private async readResolvedTextFile(
    projectRoot: string,
    filePath: ResolvedPath,
    maxCharsInput?: number
  ): Promise<WorkbenchReadFileResult> {
    const fileStats = await stat(filePath.realPath)

    if (!fileStats.isFile()) {
      throw new AppError('VALIDATION', '工作台文件读取目标必须是文件。')
    }

    const buffer = await readFile(filePath.realPath)
    if (!isLikelyTextFile(buffer)) {
      throw new AppError('VALIDATION', '当前文件不是可预览的文本文件。')
    }

    const maxChars = this.normalizeReadMaxChars(maxCharsInput)
    const fullContent = buffer.toString('utf8')
    const truncated = fullContent.length > maxChars
    const content = truncated ? fullContent.slice(0, maxChars) : fullContent

    return {
      projectRoot,
      path: this.pathResolver.toProjectRelativePath(projectRoot, filePath.requestedPath),
      content,
      size: fileStats.size,
      modifiedAt: fileStats.mtimeMs,
      totalLines: fullContent.split(/\r?\n/).length,
      truncated,
    }
  }

  private readResolvedTextFileSync(
    projectRoot: string,
    filePath: ResolvedPath,
    maxCharsInput?: number
  ): WorkbenchReadFileResult {
    const fileStats = statSync(filePath.realPath)

    if (!fileStats.isFile()) {
      throw new AppError('VALIDATION', '工作台文件读取目标必须是文件。')
    }

    const buffer = readFileSync(filePath.realPath)
    if (!isLikelyTextFile(buffer)) {
      throw new AppError('VALIDATION', '当前文件不是可预览的文本文件。')
    }

    const maxChars = this.normalizeReadMaxChars(maxCharsInput)
    const fullContent = buffer.toString('utf8')
    const truncated = fullContent.length > maxChars
    const content = truncated ? fullContent.slice(0, maxChars) : fullContent

    return {
      projectRoot,
      path: this.pathResolver.toProjectRelativePath(projectRoot, filePath.requestedPath),
      content,
      size: fileStats.size,
      modifiedAt: fileStats.mtimeMs,
      totalLines: fullContent.split(/\r?\n/).length,
      truncated,
    }
  }

  private assertContentIsWritable(content: string): void {
    if (content.length > MAX_WRITE_CHARS) {
      throw new AppError('VALIDATION', '当前文件内容超过工作台轻量编辑器的保存上限。')
    }
  }

  private assertFileHasNotChanged(
    fileStats: { mtimeMs: number; size: number },
    request: WorkbenchSaveFileRequest
  ): void {
    const expectedModifiedAt = request.expectedModifiedAt
    const expectedSize = request.expectedSize

    if (!isPresent(expectedModifiedAt) && !isPresent(expectedSize)) return

    const modifiedAtChanged =
      isPresent(expectedModifiedAt) &&
      Math.abs(fileStats.mtimeMs - expectedModifiedAt) > FILE_CONFLICT_MTIME_TOLERANCE_MS
    const sizeChanged = isPresent(expectedSize) && fileStats.size !== expectedSize

    if (modifiedAtChanged || sizeChanged) {
      throw new AppError('CONFLICT', '文件已在外部修改，请重新加载后再保存。')
    }
  }

  /**
   * 变异接缝：desktop 在此用 WorkspaceCollaborationCoordinator 对 (projectRoot, paths)
   * 取 path-write 租约；独立应用没有第二写者，直通执行。未来接入协作协调时恢复包裹。
   */
  private async runWorkbenchMutation<T>(action: () => Promise<T>): Promise<T> {
    return action()
  }

  private runWorkbenchMutationSync<T>(action: () => T): T {
    return action()
  }
}

export { FileOperations, FileOperations as WorkbenchFileOperationService }
