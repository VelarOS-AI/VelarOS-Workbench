import type {
  WorkbenchDirectoryEntry,
  WorkbenchReadFileResult,
  WorkbenchRunCommandResult,
} from '@velaros-ai/core/types'
import type { WorkbenchCommandHistoryItem } from '@velaros-ai/workbench/models/commands/workbenchCommandHistory'
import type { WorkbenchCommandSuggestion } from '@velaros-ai/workbench/models/commands/workbenchCommandSuggestions'
import type { WorkbenchRunConfiguration } from '@velaros-ai/workbench/models/commands/workbenchRunConfigurations'
import type {
  WorkbenchProjectContextFile,
  WorkbenchProjectContextIndex,
} from '@velaros-ai/workbench/models/project/workbenchProjectContextIndex'
import type { WorkbenchProject } from '@velaros-ai/workbench/models/project/workbenchProjects'
import type { WorkbenchOpenEditorTab } from '@velaros-ai/workbench/types/workbenchTypes'

import type { WorkbenchTerminalSessionView } from '../hooks/useWorkbenchCommandController'

/** 活动项目和已索引文件，用于提示、补全和上下文。 */
export interface WorkbenchProjectBundle {
  project: WorkbenchProject
  projectContextIndex: WorkbenchProjectContextIndex
}

/** 文件树选择状态和已加载编辑器文件元数据。 */
export interface WorkbenchSelectionBundle {
  selectedEntry: Nullable<WorkbenchDirectoryEntry>
  selectedFilePath: Nullable<string>
  selectedFile: Nullable<WorkbenchReadFileResult>
}

/** 编辑器侧面板共享的打开标签、缓冲文本和脏状态。 */
export interface WorkbenchEditorDocumentBundle {
  editorContent: string
  openTabs: WorkbenchOpenEditorTab[]
  hasUnsavedChanges: boolean
}

/** 完整编辑器面板状态，包括保存状态和项目索引。 */
export interface WorkbenchEditorSurfaceBundle extends WorkbenchEditorDocumentBundle {
  selectedFilePath: Nullable<string>
  selectedFile: Nullable<WorkbenchReadFileResult>
  canEditSelectedFile: boolean
  projectContextIndex: WorkbenchProjectContextIndex
  isSavingFile: boolean
}

/** 命令输入、上次运行结果、建议和运行器标记。 */
export interface WorkbenchCommandBundle {
  commandInput: string
  commandResult: Nullable<WorkbenchRunCommandResult>
  commandSuggestions: WorkbenchCommandSuggestion[]
  runConfigurations: WorkbenchRunConfiguration[]
  isValidationStale: boolean
  isRunningCommand: boolean
}

/** 运行卡（PTY 运行会话）+ 终端补全所需的历史、配置和文件列表。 */
export interface WorkbenchRunToolBundle {
  runSessions: WorkbenchTerminalSessionView[]
  activeRunSessionId: Nullable<string>
  commandHistory: WorkbenchCommandHistoryItem[]
  runConfigurations: WorkbenchRunConfiguration[]
  projectFiles: WorkbenchProjectContextFile[]
}

export interface WorkbenchTerminalToolBundle {
  terminalSessions: WorkbenchTerminalSessionView[]
  activeTerminalSessionId: Nullable<string>
}

/** 编辑器外壳使用的短项目身份，包括名称和根路径。 */
export interface WorkbenchEditorProjectBundle {
  name: string
  rootPath: string
}
