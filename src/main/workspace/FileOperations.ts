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
import type { BigIntStats } from 'node:fs'
import { lstatSync, readFileSync, type Stats, statSync } from 'node:fs'
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
  WorkbenchInspectDeleteEntryRequest,
  WorkbenchInspectDeleteEntryResult,
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
  WorkbenchRestoreMissingFileRequest,
  WorkbenchSaveFileRequest,
  WorkbenchSaveFileResult,
} from '@shared/contracts'
import { DefaultWorkbenchTextFormat, type WorkbenchTextFormat } from '@shared/workbenchTextFormat'

import { writeFileAtomically, writeFileAtomicallySync } from './AtomicFileWrite'
import type { DirectoryEntries } from './FileEntries'
import type { GitNewFileTracker } from './GitNewFileTracker'
import type { WorkbenchLocalHistoryStore } from './LocalHistoryStore'
import type { PathResolver, ResolvedPath } from './PathResolver'
import type { WorkbenchAppStoragePaths } from './StoragePaths'
import { countWorkbenchTextLines, decodeWorkbenchText, encodeWorkbenchText } from './TextCodec'
import { isLikelyTextFile, readWorkbenchTextFile } from './TextFile'

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

/**
 * 比较条目名时抹掉大小写与 Unicode 组合形式的差别
 * （大小写不敏感、规范化不敏感的文件系统都这么比）。
 */
function toComparableEntryName(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

/**
 * 目标路径查到的是不是源自己：同一个文件系统对象（设备号 + inode 相同），在同一个目录里，
 * 名字只差大小写或组合形式。硬链接也是同一个 inode，但名字不同，仍算「目标已存在」。
 */
function isSameEntrySpelledDifferently(
  sourcePath: string,
  source: BigIntStats,
  targetPath: string,
  target: BigIntStats
): boolean {
  return (
    source.dev === target.dev &&
    source.ino === target.ino &&
    dirname(sourcePath) === dirname(targetPath) &&
    toComparableEntryName(basename(sourcePath)) === toComparableEntryName(basename(targetPath))
  )
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

  /** 编辑器保存：异步、原子地写（同目录临时文件 + rename，见 `AtomicFileWrite`）。 */
  public async saveFile(request: WorkbenchSaveFileRequest): Promise<WorkbenchSaveFileResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const filePath = await this.pathResolver.resolveInsideProject(projectRoot, request.path)
    return this.runWorkbenchMutation(async () => {
      const fileStats = await stat(filePath.realPath)
      this.assertSaveTarget(fileStats, await lstat(filePath.requestedPath), request)
      const bytes = this.encodeSaveContent(request, await readFile(filePath.realPath))
      await writeFileAtomically(filePath.realPath, bytes, fileStats)
      return this.recordSavedTextFile(
        projectRoot,
        filePath,
        request,
        bytes,
        await stat(filePath.realPath)
      )
    })
  }

  public async restoreMissingFile(
    request: WorkbenchRestoreMissingFileRequest
  ): Promise<WorkbenchSaveFileResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const relativePath = request.path.trim()
    const name = basename(relativePath)
    if (!relativePath || name === '.' || name === '..') {
      throw new AppError('VALIDATION', '恢复文件路径无效。')
    }

    const parent = await this.pathResolver.resolveInsideProject(projectRoot, dirname(relativePath))
    const parentStats = await stat(parent.realPath)
    const parentLinkStats = await lstat(parent.requestedPath)
    if (!parentStats.isDirectory() || parentLinkStats.isSymbolicLink()) {
      throw new AppError('VALIDATION', '恢复文件目标必须位于普通目录内。')
    }

    this.assertContentIsWritable(request.content)
    // 按文件被删前的格式写回；编辑器没带格式时按新文件处理。
    const bytes = encodeWorkbenchText(request.content, {
      encoding: request.encoding ?? DefaultWorkbenchTextFormat.encoding,
      eol: request.eol ?? DefaultWorkbenchTextFormat.eol,
    })
    const targetPath = this.pathResolver.resolveChildPath(projectRoot, parent.requestedPath, name)
    return this.runWorkbenchMutation(async () => {
      const existing = await lstat(targetPath).catch(() => null)
      if (existing) throw new AppError('CONFLICT', '文件已经重新出现，请改用磁盘版本。')

      await writeFile(targetPath, bytes, { flag: 'wx' })
      await this.gitNewFileTracker.trackNewFiles(projectRoot, [targetPath])
      const realPath = await this.pathResolver.resolveInsideProject(projectRoot, relativePath)
      return this.readResolvedTextFile(projectRoot, realPath, MAX_READ_CHARS)
    })
  }

  /** beforeunload 兜底保存（renderer sendSync）：与 {@link saveFile} 同一套校验与原子写，只是同步。 */
  public saveFileSync(request: WorkbenchSaveFileRequest): WorkbenchSaveFileResult {
    const projectRoot = this.pathResolver.resolveProjectRootSync(request.projectRoot)
    const filePath = this.pathResolver.resolveInsideProjectSync(projectRoot, request.path)
    return this.runWorkbenchMutationSync(() => {
      const fileStats = statSync(filePath.realPath)
      this.assertSaveTarget(fileStats, lstatSync(filePath.requestedPath), request)
      const bytes = this.encodeSaveContent(request, readFileSync(filePath.realPath))
      writeFileAtomicallySync(filePath.realPath, bytes, fileStats)
      return this.recordSavedTextFile(
        projectRoot,
        filePath,
        request,
        bytes,
        statSync(filePath.realPath)
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
    this.assertOutsideGitInternals(
      projectRoot,
      [targetPath, join(parentPath.realPath, name)],
      request.parentPath ?? '.'
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
    this.assertOutsideGitInternals(
      projectRoot,
      [sourcePath.requestedPath, sourcePath.realPath, targetPath],
      request.path
    )

    return this.runWorkbenchMutation(async () => {
      await this.renameEntryPath(sourcePath.requestedPath, targetPath)
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
    this.assertOutsideGitInternals(
      projectRoot,
      [sourcePath.requestedPath, sourcePath.realPath, targetPath, join(parentPath.realPath, name)],
      request.path
    )

    return this.runWorkbenchMutation(async () => {
      await this.renameEntryPath(sourcePath.requestedPath, targetPath)

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
    this.assertOutsideGitInternals(
      projectRoot,
      [targetPath.requestedPath, targetPath.realPath],
      request.path
    )

    return this.runWorkbenchMutation(async () => {
      const targetLinkStats = await lstat(targetPath.requestedPath)
      if (targetLinkStats.isSymbolicLink()) {
        throw new AppError('VALIDATION', '工作台暂不直接删除符号链接。')
      }

      const targetStats = await stat(targetPath.realPath)
      if (targetStats.isDirectory()) {
        const entries = await readdir(targetPath.realPath)
        if (entries.length > 0 && !request.recursive) {
          throw new AppError('VALIDATION', '目录包含内容，需要确认后才能删除。')
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

  public async inspectDeleteEntry(
    request: WorkbenchInspectDeleteEntryRequest
  ): Promise<WorkbenchInspectDeleteEntryResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const targetPath = await this.pathResolver.resolveInsideProject(projectRoot, request.path)
    const relativePath = this.pathResolver.toProjectRelativePath(
      projectRoot,
      targetPath.requestedPath
    )

    if (relativePath === '.') {
      throw new AppError('VALIDATION', '不能删除工程根目录。')
    }
    this.assertOutsideGitInternals(
      projectRoot,
      [targetPath.requestedPath, targetPath.realPath],
      request.path
    )

    const targetLinkStats = await lstat(targetPath.requestedPath)
    if (targetLinkStats.isSymbolicLink()) {
      throw new AppError('VALIDATION', '工作台暂不直接删除符号链接。')
    }

    const targetStats = await stat(targetPath.realPath)
    const type = targetStats.isDirectory() ? 'directory' : 'file'
    const requiresConfirmation =
      type === 'file' || (await readdir(targetPath.realPath)).length > 0

    return {
      projectRoot,
      path: relativePath,
      type,
      requiresConfirmation,
    }
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

  private assertOutsideGitInternals(
    projectRoot: string,
    absolutePaths: readonly string[],
    inputPath: string
  ): void {
    for (const absolutePath of absolutePaths) {
      this.pathResolver.assertOutsideGitInternals(projectRoot, absolutePath, inputPath)
    }
  }

  /**
   * 把条目改名或挪到 targetPath。目标已存在就拒绝——除非按新名字查到的就是源本身：大小写不敏感的
   * 文件系统（macOS、Windows 的默认格式）上只改大小写（或只改 Unicode 组合形式）时正是这样。
   * 这时经同目录下的临时名分两步改，不依赖文件系统怎么处理「改成只差大小写的名字」。
   */
  private async renameEntryPath(sourcePath: string, targetPath: string): Promise<void> {
    if (sourcePath === targetPath) return

    const existing = await lstat(targetPath, { bigint: true }).catch(() => null)
    if (!existing) {
      await rename(sourcePath, targetPath)
      return
    }

    const source = await lstat(sourcePath, { bigint: true })
    if (!isSameEntrySpelledDifferently(sourcePath, source, targetPath, existing)) {
      throw new AppError('VALIDATION', '目标已存在。')
    }

    const temporaryPath = join(dirname(sourcePath), `.velaros-rename-${randomUUID()}`)
    await rename(sourcePath, temporaryPath)
    try {
      await rename(temporaryPath, targetPath)
    } catch (error) {
      await rename(temporaryPath, sourcePath).catch(() => undefined)
      throw error
    }
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
    const file = await readWorkbenchTextFile(
      filePath.realPath,
      this.normalizeReadMaxChars(maxCharsInput)
    )

    return {
      projectRoot,
      path: this.pathResolver.toProjectRelativePath(projectRoot, filePath.requestedPath),
      ...file,
    }
  }

  /** 保存目标必须是普通文件、没有在外部改过，要写的内容在上限内。 */
  private assertSaveTarget(
    fileStats: Stats,
    linkStats: Stats,
    request: WorkbenchSaveFileRequest
  ): void {
    if (linkStats.isSymbolicLink()) {
      throw new AppError('VALIDATION', '工作台暂不直接编辑符号链接。')
    }

    if (!fileStats.isFile()) {
      throw new AppError('VALIDATION', '工作台文件保存目标必须是文件。')
    }

    this.assertContentIsWritable(request.content)
    this.assertFileHasNotChanged(fileStats, request)
  }

  /** 磁盘上的现有字节必须是文本；按请求的格式（没带齐时沿用磁盘上的）编码要写的内容。 */
  private encodeSaveContent(request: WorkbenchSaveFileRequest, currentBytes: Uint8Array): Buffer {
    if (!isLikelyTextFile(currentBytes)) {
      throw new AppError('VALIDATION', '当前文件不是可编辑的文本文件。')
    }

    return encodeWorkbenchText(request.content, this.resolveSaveTextFormat(request, currentBytes))
  }

  /** 写盘之后：按写下的字节给出保存结果，并把正文存进本地历史。 */
  private recordSavedTextFile(
    projectRoot: string,
    filePath: ResolvedPath,
    request: WorkbenchSaveFileRequest,
    bytes: Uint8Array,
    fileStats: { size: number; mtimeMs: number }
  ): WorkbenchSaveFileResult {
    const saved = this.toSavedTextFile(projectRoot, filePath, bytes, fileStats)
    this.localHistoryStore.capture(projectRoot, request.path, saved.content, {
      minIntervalMs: request.localHistoryMinIntervalMs,
    })
    return saved
  }

  /**
   * 保存用的格式：请求带齐了就按请求（编辑器里的格式，含用户明确选的转换）；没带齐时沿用
   * 磁盘上现有的格式，现有字节本身不能原样写回时拒绝保存，不猜。
   */
  private resolveSaveTextFormat(
    request: WorkbenchSaveFileRequest,
    currentBuffer: Uint8Array
  ): WorkbenchTextFormat {
    if (request.encoding && request.eol) return { encoding: request.encoding, eol: request.eol }

    const current = decodeWorkbenchText(currentBuffer)
    if (current.textIssue) {
      throw new AppError(
        'VALIDATION',
        '文件现有的编码或换行符不能原样写回，请在编辑器中打开它、确认转换后再保存。'
      )
    }

    return { encoding: request.encoding ?? current.encoding, eol: request.eol ?? current.eol }
  }

  /** 由刚写下的字节得出保存结果（与之后重新读盘得到的一致），不再回读磁盘。 */
  private toSavedTextFile(
    projectRoot: string,
    filePath: ResolvedPath,
    bytes: Uint8Array,
    fileStats: { size: number; mtimeMs: number }
  ): WorkbenchSaveFileResult {
    const decoded = decodeWorkbenchText(bytes)

    return {
      projectRoot,
      path: this.pathResolver.toProjectRelativePath(projectRoot, filePath.requestedPath),
      ...decoded,
      size: fileStats.size,
      modifiedAt: fileStats.mtimeMs,
      totalLines: countWorkbenchTextLines(decoded.content),
      truncated: false,
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
