/**
 * 独立 Workbench 应用 main 侧工作区服务装配（镜像 desktop `workspace/workbench/Parts.ts`）。
 *
 * 片0 的纯读服务（WorkbenchProjectFileSystem）自带路径收束逻辑、独立存在；本装配承载
 * 片1 起照搬的写族 / 双搜索 / 命令运行 / 本地历史簇，全部共享同一 PathResolver 防线。
 */
import { TerminalSessions } from './terminal/TerminalSessions'
import { CommandHelper } from './CommandHelper'
import { CommandRunner } from './CommandRunner'
import { WorkbenchDeleteUndoStore, type WorkbenchMoveToTrash } from './DeleteUndoStore'
import { DirectoryEntries } from './FileEntries'
import { FileOperations } from './FileOperations'
import { GitNewFileTracker } from './GitNewFileTracker'
import { WorkbenchLocalHistoryStore } from './LocalHistoryStore'
import { PathResolver } from './PathResolver'
import { SearchIndex } from './SearchIndex'
import { WorkbenchAppStoragePaths } from './StoragePaths'

interface WorkbenchAppParts {
  files: FileOperations
  search: SearchIndex
  commands: CommandRunner
  terminal: TerminalSessions
  storagePaths: WorkbenchAppStoragePaths
}

interface WorkbenchAppPartsDependencies {
  /** 删除时把条目移到系统废纸篓：应用里是 Electron 的 `shell.trashItem`，测试换成假的。 */
  moveToTrash: WorkbenchMoveToTrash
}

function createWorkbenchAppParts(
  dataRootDir: string,
  dependencies: WorkbenchAppPartsDependencies
): WorkbenchAppParts {
  const paths = new PathResolver()
  const entries = new DirectoryEntries(paths)
  const storagePaths = new WorkbenchAppStoragePaths(dataRootDir)
  const localHistoryStore = new WorkbenchLocalHistoryStore(storagePaths)
  const gitNewFileTracker = new GitNewFileTracker()
  const commandHelper = new CommandHelper()
  const deleteUndo = new WorkbenchDeleteUndoStore(
    () => storagePaths.getDeleteUndoDir(),
    dependencies.moveToTrash
  )

  return {
    files: new FileOperations(paths, entries, gitNewFileTracker, localHistoryStore, deleteUndo),
    search: new SearchIndex(paths, entries),
    commands: new CommandRunner(paths, commandHelper),
    terminal: new TerminalSessions(paths, commandHelper),
    storagePaths,
  }
}

export { createWorkbenchAppParts }
export type { WorkbenchAppParts, WorkbenchAppPartsDependencies }
