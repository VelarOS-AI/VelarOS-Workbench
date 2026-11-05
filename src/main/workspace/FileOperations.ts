/**
 * 工作台文件写族（照搬 desktop `workspace/workbench/FileOperations.ts`，root 越界防护与
 * 回收站语义保形）。
 *
 * 独立应用适配（三处，均为装配面不动行为）：
 * - `storagePathService` / `workbenchLocalHistoryStore` 模块单例 → 构造注入
 *   （`WorkbenchDeleteUndoStore` / `WorkbenchLocalHistoryStore`）。
 * - desktop 的 `WorkspaceCollaborationCoordinator` 租约层不随迁（独立应用没有 agent
 *   第二写者）；`runWorkbenchMutation` 保留为接缝直通，未来接协作协调时在此恢复包裹。
 * - 删除移到系统废纸篓，小的另留私有副本给应用内撤销（见 `WorkbenchDeleteUndoStore`）。
 */
import { randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstatSync, readFileSync, type Stats, statSync } from 'node:fs'
import { cp, lstat, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'

import { isPresent } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'

import {
  type WorkbenchCopyEntryRequest,
  type WorkbenchCreateEntryRequest,
  type WorkbenchDeleteEntryRequest,
  type WorkbenchDeleteEntryResult,
  type WorkbenchEntryMutationResult,
  type WorkbenchInspectDeleteEntryRequest,
  type WorkbenchInspectDeleteEntryResult,
  type WorkbenchListLocalHistoryRequest,
  type WorkbenchListLocalHistoryResult,
  type WorkbenchMoveEntryRequest,
  type WorkbenchMoveEntryResult,
  type WorkbenchReadFileRequest,
  type WorkbenchReadFileResult,
  type WorkbenchReadLocalHistorySnapshotRequest,
  type WorkbenchReadLocalHistorySnapshotResult,
  type WorkbenchRenameEntryRequest,
  type WorkbenchRestoreDeletedEntryRequest,
  type WorkbenchRestoreDeletedEntryResult,
  type WorkbenchRestoreMissingFileRequest,
  type WorkbenchSaveFileRequest,
  type WorkbenchSaveFileResult,
} from '@shared/contracts/workbench'
import { DefaultWorkbenchTextFormat, type WorkbenchTextFormat } from '@shared/workbenchTextFormat'

import { workbenchMainText } from '../i18n/workbenchMainMessages'

import { writeFileAtomically, writeFileAtomicallySync } from './AtomicFileWrite'
import type { WorkbenchDeleteUndoStore } from './DeleteUndoStore'
import type { DirectoryEntries } from './FileEntries'
import type { GitNewFileTracker } from './GitNewFileTracker'
import type { WorkbenchLocalHistoryStore } from './LocalHistoryStore'
import { isPathInsideRoot } from './PathContainmentHelper'
import type { PathResolver, ResolvedPath } from './PathResolver'
import { countWorkbenchTextLines, decodeWorkbenchText, encodeWorkbenchText } from './TextCodec'
import { isLikelyTextFile, readWorkbenchTextFile } from './TextFile'

const DEFAULT_READ_MAX_CHARS = 300_000
const MAX_READ_CHARS = 1_000_000
const MAX_WRITE_CHARS = 1_000_000
const FILE_CONFLICT_MTIME_TOLERANCE_MS = 1
/** 「名字 copy N」最多试到这里。 */
const MAX_COPY_NAME_ATTEMPTS = 1000
/** 复制目录时交给 Git 新文件追踪的文件数上限。 */
const MAX_TRACKED_COPIED_FILES = 500

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
  constructor(
    private readonly pathResolver: PathResolver,
    private readonly entryHelper: DirectoryEntries,
    private readonly gitNewFileTracker: GitNewFileTracker,
    private readonly localHistoryStore: WorkbenchLocalHistoryStore,
    private readonly deleteUndo: WorkbenchDeleteUndoStore
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
      throw new AppError('VALIDATION', workbenchMainText('files.restorePathInvalid'))
    }

    const parent = await this.pathResolver.resolveInsideProject(projectRoot, dirname(relativePath))
    const parentStats = await stat(parent.realPath)
    const parentLinkStats = await lstat(parent.requestedPath)
    if (!parentStats.isDirectory() || parentLinkStats.isSymbolicLink()) {
      throw new AppError('VALIDATION', workbenchMainText('files.restoreTargetNotInFolder'))
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
      if (existing) throw new AppError('CONFLICT', workbenchMainText('files.restoreFileReappeared'))

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
      throw new AppError('VALIDATION', workbenchMainText('files.createTargetNotFolder'))
    }

    if (parentLinkStats.isSymbolicLink()) {
      throw new AppError('VALIDATION', workbenchMainText('files.createInLinkedFolder'))
    }

    if (request.type !== 'directory' && request.type !== 'file') {
      throw new AppError('VALIDATION', workbenchMainText('files.createTypeInvalid'))
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
        throw new AppError('VALIDATION', workbenchMainText('files.targetExists'))
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
    // 条目本身：符号链接改的是链接的名字，不动它指向的东西（目标在工程外也能改）。
    const source = await this.pathResolver.resolveEntryInsideProject(projectRoot, request.path)

    const sourceRelativePath = this.pathResolver.toProjectRelativePath(
      projectRoot,
      source.requestedPath
    )
    if (sourceRelativePath === '.') {
      throw new AppError('VALIDATION', workbenchMainText('files.renameProjectRoot'))
    }

    const name = this.pathResolver.normalizeEntryName(request.newName)
    const parentPath = dirname(source.requestedPath)
    const targetPath = this.pathResolver.resolveChildPath(projectRoot, parentPath, name)
    const physicalTargetPath = join(dirname(source.entryPath), name)
    this.assertOutsideGitInternals(
      projectRoot,
      [source.requestedPath, source.entryPath, targetPath, physicalTargetPath],
      request.path
    )

    return this.runWorkbenchMutation(async () => {
      await this.renameEntryPath(source.entryPath, physicalTargetPath)
      await this.localHistoryStore.relocate(
        projectRoot,
        sourceRelativePath,
        this.pathResolver.toProjectRelativePath(projectRoot, targetPath),
        { includeDescendants: mayContainHistory(source.stats) }
      )
      const entry = await this.entryHelper.toDirectoryEntry(projectRoot, targetPath, false)
      return {
        projectRoot,
        parentPath: this.pathResolver.toProjectRelativePath(projectRoot, parentPath),
        entry,
      }
    })
  }

  /**
   * 把文件或目录复制到 `parentPath` 下（目录连同里面的一切；链接复制成链接，不跟进去）。目标名字已被占用时
   * 取一个空着的「名字 copy.扩展名」「名字 copy 2.扩展名」……，与访达、VS Code 一样。
   */
  public async copyEntry(
    request: WorkbenchCopyEntryRequest
  ): Promise<WorkbenchEntryMutationResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    const source = await this.pathResolver.resolveEntryInsideProject(projectRoot, request.path)
    const parentPath = await this.pathResolver.resolveInsideProject(projectRoot, request.parentPath)
    if (this.pathResolver.toProjectRelativePath(projectRoot, source.requestedPath) === '.') {
      throw new AppError('VALIDATION', workbenchMainText('files.copyProjectRoot'))
    }
    if (!(await stat(parentPath.realPath)).isDirectory()) {
      throw new AppError('VALIDATION', workbenchMainText('files.copyTargetNotFolder'))
    }
    if ((await lstat(parentPath.requestedPath)).isSymbolicLink()) {
      throw new AppError('VALIDATION', workbenchMainText('files.copyIntoLinkedFolder'))
    }
    if (source.stats.isDirectory() && isPathInsideRoot(source.entryPath, parentPath.realPath)) {
      throw new AppError('VALIDATION', workbenchMainText('files.copyIntoItself'))
    }

    return this.runWorkbenchMutation(async () => {
      const name = await this.findFreeCopyName(
        parentPath.realPath,
        this.pathResolver.normalizeEntryName(request.name ?? basename(source.requestedPath))
      )
      const targetPath = this.pathResolver.resolveChildPath(
        projectRoot,
        parentPath.requestedPath,
        name
      )
      const physicalTargetPath = join(parentPath.realPath, name)
      this.assertOutsideGitInternals(
        projectRoot,
        [source.requestedPath, source.entryPath, targetPath, physicalTargetPath],
        request.path
      )
      await cp(source.entryPath, physicalTargetPath, {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
      })
      const copiedFiles = source.stats.isDirectory()
        ? await this.listCopiedFiles(physicalTargetPath)
        : [physicalTargetPath]
      await this.gitNewFileTracker.trackNewFiles(projectRoot, copiedFiles)
      const entry = await this.entryHelper.toDirectoryEntry(projectRoot, targetPath, false)
      return {
        projectRoot,
        parentPath: this.pathResolver.toProjectRelativePath(projectRoot, parentPath.requestedPath),
        entry,
      }
    })
  }

  /** `name` 在目录里空着就用它，否则依次试「名字 copy.扩展名」「名字 copy 2.扩展名」……（`.gitignore` 这类整名算名字）。 */
  private async findFreeCopyName(directory: string, name: string): Promise<string> {
    if (!(await lstat(join(directory, name)).catch(() => null))) return name
    const extension = name.startsWith('.') && !name.includes('.', 1) ? '' : extname(name)
    const stem = name.slice(0, name.length - extension.length)
    for (let attempt = 1; attempt < MAX_COPY_NAME_ATTEMPTS; attempt += 1) {
      const candidate = `${stem} copy${attempt === 1 ? '' : ` ${attempt}`}${extension}`
      if (!(await lstat(join(directory, candidate)).catch(() => null))) return candidate
    }
    throw new AppError('VALIDATION', workbenchMainText('files.targetExists'))
  }

  /** 复制出来的目录里的文件（交给 Git 新文件追踪），最多这么多个。 */
  private async listCopiedFiles(directory: string): Promise<string[]> {
    const files: string[] = []
    const entries = await readdir(directory, { recursive: true, withFileTypes: true })
    for (const entry of entries) {
      if (files.length >= MAX_TRACKED_COPIED_FILES) break
      if (entry.isFile()) files.push(join(entry.parentPath, entry.name))
    }
    return files
  }

  public async moveEntry(request: WorkbenchMoveEntryRequest): Promise<WorkbenchMoveEntryResult> {
    const projectRoot = await this.pathResolver.resolveProjectRoot(request.projectRoot)
    // 条目本身：挪的是符号链接自己（目标在工程外也能挪），不是它指向的东西。
    const source = await this.pathResolver.resolveEntryInsideProject(projectRoot, request.path)
    const parentPath = await this.pathResolver.resolveInsideProject(projectRoot, request.parentPath)
    const parentLinkStats = await lstat(parentPath.requestedPath)

    if (parentLinkStats.isSymbolicLink()) {
      throw new AppError('VALIDATION', workbenchMainText('files.moveIntoLinkedFolder'))
    }

    const sourceRelativePath = this.pathResolver.toProjectRelativePath(
      projectRoot,
      source.requestedPath
    )
    if (sourceRelativePath === '.') {
      throw new AppError('VALIDATION', workbenchMainText('files.moveProjectRoot'))
    }

    const parentStats = await stat(parentPath.realPath)
    if (!parentStats.isDirectory()) {
      throw new AppError('VALIDATION', workbenchMainText('files.moveTargetNotFolder'))
    }

    // 按真实路径比，经由链接起的别名也拦得住；链接本身不是目录，挪到哪里都行。
    if (source.stats.isDirectory() && isPathInsideRoot(source.entryPath, parentPath.realPath)) {
      throw new AppError('VALIDATION', workbenchMainText('files.moveIntoItself'))
    }

    const name = this.pathResolver.normalizeEntryName(
      request.name ?? basename(source.requestedPath)
    )
    const targetPath = this.pathResolver.resolveChildPath(
      projectRoot,
      parentPath.requestedPath,
      name
    )
    const physicalTargetPath = join(parentPath.realPath, name)
    const previousParentPath = this.pathResolver.toProjectRelativePath(
      projectRoot,
      dirname(source.requestedPath)
    )
    const targetParentPath = this.pathResolver.toProjectRelativePath(
      projectRoot,
      parentPath.requestedPath
    )
    this.assertOutsideGitInternals(
      projectRoot,
      [source.requestedPath, source.entryPath, targetPath, physicalTargetPath],
      request.path
    )

    return this.runWorkbenchMutation(async () => {
      await this.renameEntryPath(source.entryPath, physicalTargetPath)
      await this.localHistoryStore.relocate(
        projectRoot,
        sourceRelativePath,
        this.pathResolver.toProjectRelativePath(projectRoot, targetPath),
        { includeDescendants: mayContainHistory(source.stats) }
      )

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
    // 条目本身：删符号链接删的是链接，不跟进去，也就不管它指向的目录里有没有东西。
    const target = await this.pathResolver.resolveEntryInsideProject(projectRoot, request.path)
    const relativePath = this.pathResolver.toProjectRelativePath(projectRoot, target.requestedPath)

    if (relativePath === '.') {
      throw new AppError('VALIDATION', workbenchMainText('files.deleteProjectRoot'))
    }
    this.assertOutsideGitInternals(
      projectRoot,
      [target.requestedPath, target.entryPath],
      request.path
    )

    return this.runWorkbenchMutation(async () => {
      const targetStats = await lstat(target.entryPath)
      if (targetStats.isDirectory()) {
        const entries = await readdir(target.entryPath)
        if (entries.length > 0 && !request.recursive) {
          throw new AppError('VALIDATION', workbenchMainText('files.deleteNeedsConfirmation'))
        }
      }

      const parentPath = this.pathResolver.toProjectRelativePath(
        projectRoot,
        dirname(target.requestedPath)
      )
      const restoreId = await this.deleteUndo.trash({
        projectRoot,
        deletedPath: relativePath,
        parentPath,
        entryPath: target.entryPath,
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
    const target = await this.pathResolver.resolveEntryInsideProject(projectRoot, request.path)
    const relativePath = this.pathResolver.toProjectRelativePath(projectRoot, target.requestedPath)

    if (relativePath === '.') {
      throw new AppError('VALIDATION', workbenchMainText('files.deleteProjectRoot'))
    }
    this.assertOutsideGitInternals(
      projectRoot,
      [target.requestedPath, target.entryPath],
      request.path
    )

    // 符号链接按一项叶子算（删的只是链接），即使它指向目录。
    const type = target.stats.isDirectory() ? 'directory' : 'file'
    const requiresConfirmation = type === 'file' || (await readdir(target.entryPath)).length > 0

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
    const restore = this.deleteUndo.find(projectRoot, request.restoreId)
    if (!restore) {
      throw new AppError('NOT_FOUND', workbenchMainText('files.undoDeleteExpired'))
    }

    this.assertOutsideGitInternals(projectRoot, [restore.entryPath], restore.deletedPath)

    return this.runWorkbenchMutation(async () => {
      const existing = await lstat(restore.entryPath).catch(() => null)
      if (existing) {
        throw new AppError(
          'CONFLICT',
          workbenchMainText('files.undoDeleteTargetExists', { path: restore.deletedPath })
        )
      }

      const parentPath = dirname(restore.entryPath)
      const parentStats = await stat(parentPath).catch(() => null)
      const parentLinkStats = await lstat(parentPath).catch(() => null)
      if (!parentStats?.isDirectory() || !parentLinkStats) {
        throw new AppError(
          'CONFLICT',
          workbenchMainText('files.undoDeleteParentMissing', { path: restore.deletedPath })
        )
      }
      if (parentLinkStats.isSymbolicLink()) {
        throw new AppError('VALIDATION', workbenchMainText('files.undoDeleteIntoLinkedFolder'))
      }

      await this.deleteUndo.restore(restore)
      const entry = await this.entryHelper.toDirectoryEntry(
        projectRoot,
        resolve(projectRoot, restore.deletedPath),
        false
      )

      return {
        projectRoot,
        parentPath: restore.parentPath,
        restoredPath: restore.deletedPath,
        entry,
      }
    })
  }

  /** 启动时清掉以前会话留下的删除撤销副本（见 `WorkbenchDeleteUndoStore`）。 */
  public purgePreviousDeleteUndoCopies(): Promise<void> {
    return this.deleteUndo.purgePreviousSessions()
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
      throw new AppError('VALIDATION', workbenchMainText('files.targetExists'))
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
      throw new AppError('VALIDATION', workbenchMainText('files.editSymlink'))
    }

    if (!fileStats.isFile()) {
      throw new AppError('VALIDATION', workbenchMainText('files.saveTargetNotFile'))
    }

    this.assertContentIsWritable(request.content)
    this.assertFileHasNotChanged(fileStats, request)
  }

  /** 磁盘上的现有字节必须是文本；按请求的格式（没带齐时沿用磁盘上的）编码要写的内容。 */
  private encodeSaveContent(request: WorkbenchSaveFileRequest, currentBytes: Uint8Array): Buffer {
    if (!isLikelyTextFile(currentBytes)) {
      throw new AppError('VALIDATION', workbenchMainText('files.notEditableText'))
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
      throw new AppError('VALIDATION', workbenchMainText('files.formatNotRoundTrip'))
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
      throw new AppError('VALIDATION', workbenchMainText('files.saveTooLarge'))
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
      throw new AppError('CONFLICT', workbenchMainText('files.changedOnDisk'))
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

/** 目录和目录链接下面的文件可能有本地历史（经由链接打开的文件按链接下的路径记）。 */
function mayContainHistory(stats: Stats): boolean {
  return stats.isDirectory() || stats.isSymbolicLink()
}

export { FileOperations, FileOperations as WorkbenchFileOperationService }
