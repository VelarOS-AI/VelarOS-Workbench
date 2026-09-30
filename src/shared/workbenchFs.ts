/**
 * 独立 Workbench 应用「项目工作区」的 main ↔ renderer IPC 契约（应用私有）。
 *
 * 这是 `WorkbenchHost.kernel.project` 端口在独立应用侧的实装传输面：请求/结果形状
 * 直接复用 `@shared/contracts` 的 Workbench Kernel contracts（单源，不另造镜像），本文件
 * 只补通道名与跨进程错误信封。镜像 projectHub 契约的模式：main 侧服务是唯一权威，
 * renderer 经 preload 桥调用；kernel-protocol 客户端接入后本传输面整体替换，端口面不动。
 *
 * 片1 起覆盖四簇：文件系统（纯读 + 写族）/ 双搜索（内容搜索可边搜边推送、可取消；外加快速打开用的整份
 * 文件清单）与替换 / 一次性命令运行 /
 * 本地历史读。
 * `saveFileSync` 是 beforeunload 兜底路径，走 `ipcRenderer.sendSync` 同步信封。
 */
import type { ErrorCode } from '@velaros-ai/core/error'

import type {
  WorkbenchCancelSearchContentRequest,
  WorkbenchCopyEntryRequest,
  WorkbenchCreateEntryRequest,
  WorkbenchDeleteEntryRequest,
  WorkbenchDeleteEntryResult,
  WorkbenchEntryMutationResult,
  WorkbenchFindExistingFilesRequest,
  WorkbenchFindExistingFilesResult,
  WorkbenchInspectDeleteEntryRequest,
  WorkbenchInspectDeleteEntryResult,
  WorkbenchListDirectoryRequest,
  WorkbenchListDirectoryResult,
  WorkbenchListLocalHistoryRequest,
  WorkbenchListLocalHistoryResult,
  WorkbenchListProjectFilesRequest,
  WorkbenchListProjectFilesResult,
  WorkbenchMoveEntryRequest,
  WorkbenchMoveEntryResult,
  WorkbenchReadFileRequest,
  WorkbenchReadFileResult,
  WorkbenchReadImageFileRequest,
  WorkbenchReadImageFileResult,
  WorkbenchReadLocalHistorySnapshotRequest,
  WorkbenchReadLocalHistorySnapshotResult,
  WorkbenchRenameEntryRequest,
  WorkbenchReplaceContentRequest,
  WorkbenchReplaceContentResult,
  WorkbenchRestoreDeletedEntryRequest,
  WorkbenchRestoreDeletedEntryResult,
  WorkbenchRestoreMissingFileRequest,
  WorkbenchRunCommandOutputEvent,
  WorkbenchRunCommandRequest,
  WorkbenchRunCommandResult,
  WorkbenchSaveFileRequest,
  WorkbenchSaveFileResult,
  WorkbenchSearchContentProgressEvent,
  WorkbenchSearchContentRequest,
  WorkbenchSearchContentResult,
  WorkbenchSearchEntriesRequest,
  WorkbenchSearchEntriesResult,
} from '@shared/contracts'

export const WorkbenchFsChannels = {
  listDirectory: 'workbench-app:fs:list-directory',
  readFile: 'workbench-app:fs:read-file',
  readImageFile: 'workbench-app:fs:read-image-file',
  findExistingFiles: 'workbench-app:fs:find-existing-files',
  saveFile: 'workbench-app:fs:save-file',
  saveFileSync: 'workbench-app:fs:save-file-sync',
  createEntry: 'workbench-app:fs:create-entry',
  renameEntry: 'workbench-app:fs:rename-entry',
  moveEntry: 'workbench-app:fs:move-entry',
  copyEntry: 'workbench-app:fs:copy-entry',
  inspectDeleteEntry: 'workbench-app:fs:inspect-delete-entry',
  deleteEntry: 'workbench-app:fs:delete-entry',
  restoreDeletedEntry: 'workbench-app:fs:restore-deleted-entry',
  restoreMissingFile: 'workbench-app:fs:restore-missing-file',
  listLocalHistory: 'workbench-app:history:list',
  readLocalHistorySnapshot: 'workbench-app:history:read-snapshot',
  searchEntries: 'workbench-app:search:entries',
  searchContent: 'workbench-app:search:content',
  searchContentProgress: 'workbench-app:search:content-progress',
  cancelSearchContent: 'workbench-app:search:cancel-content',
  replaceContent: 'workbench-app:search:replace-content',
  listProjectFiles: 'workbench-app:search:files',
  runCommand: 'workbench-app:command:run',
  runCommandOutput: 'workbench-app:command:output',
} as const

/**
 * IPC 越进程错误信封：main 侧异常降为数据，renderer 侧再升回 Result。
 * `code` 保留 AppError 语义码（VALIDATION / CONFLICT / NOT_FOUND / PERMISSION …），
 * 编辑器冲突分支（保存撞外部修改）依赖它区分处理。
 */
export type WorkbenchFsCallResult<TValue> =
  | { ok: true; value: TValue }
  | { ok: false; message: string; code?: ErrorCode }

/** preload 通过 contextBridge 暴露给 renderer 的项目工作区桥面。 */
export interface WorkbenchFsBridge {
  listDirectory: (
    request: WorkbenchListDirectoryRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchListDirectoryResult>>
  readFile: (
    request: WorkbenchReadFileRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchReadFileResult>>
  readImageFile: (
    request: WorkbenchReadImageFileRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchReadImageFileResult>>
  findExistingFiles: (
    request: WorkbenchFindExistingFilesRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchFindExistingFilesResult>>
  saveFile: (
    request: WorkbenchSaveFileRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchSaveFileResult>>
  saveFileSync: (
    request: WorkbenchSaveFileRequest
  ) => WorkbenchFsCallResult<WorkbenchSaveFileResult>
  createEntry: (
    request: WorkbenchCreateEntryRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchEntryMutationResult>>
  renameEntry: (
    request: WorkbenchRenameEntryRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchEntryMutationResult>>
  moveEntry: (
    request: WorkbenchMoveEntryRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchMoveEntryResult>>
  copyEntry: (
    request: WorkbenchCopyEntryRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchEntryMutationResult>>
  inspectDeleteEntry: (
    request: WorkbenchInspectDeleteEntryRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchInspectDeleteEntryResult>>
  deleteEntry: (
    request: WorkbenchDeleteEntryRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchDeleteEntryResult>>
  restoreDeletedEntry: (
    request: WorkbenchRestoreDeletedEntryRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchRestoreDeletedEntryResult>>
  restoreMissingFile: (
    request: WorkbenchRestoreMissingFileRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchSaveFileResult>>
  listLocalHistory: (
    request: WorkbenchListLocalHistoryRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchListLocalHistoryResult>>
  readLocalHistorySnapshot: (
    request: WorkbenchReadLocalHistorySnapshotRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchReadLocalHistorySnapshotResult>>
  searchEntries: (
    request: WorkbenchSearchEntriesRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchSearchEntriesResult>>
  searchContent: (
    request: WorkbenchSearchContentRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchSearchContentResult>>
  cancelSearchContent: (
    request: WorkbenchCancelSearchContentRequest
  ) => Promise<WorkbenchFsCallResult<void>>
  replaceContent: (
    request: WorkbenchReplaceContentRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchReplaceContentResult>>
  /** 带 searchId 的内容搜索边搜边推送的结果（只推给发起搜索的窗口）。 */
  onSearchContentProgress: (
    listener: (event: WorkbenchSearchContentProgressEvent) => void
  ) => () => void
  listProjectFiles: (
    request: WorkbenchListProjectFilesRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchListProjectFilesResult>>
  runCommand: (
    request: WorkbenchRunCommandRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchRunCommandResult>>
  onRunCommandOutput: (listener: (event: WorkbenchRunCommandOutputEvent) => void) => () => void
}
