import { useSyncExternalStore } from 'react'

import { isEmpty, Log } from '@velaros-ai/core'
import { Result } from '@velaros-ai/core/result'

import {
  runWorkbenchDebugAction,
  type WorkbenchDebugStatus,
} from '../models/debug/workbenchDebugBridge'
import {
  buildWorkbenchLanguageServiceRequestBase,
  resolveWorkbenchBuiltinLanguageServiceRuntime,
} from '../models/editor/workbenchCodeMirrorLanguageService'
import {
  getWorkbenchEditorActionsSnapshot,
  runWorkbenchEditorAction,
  subscribeWorkbenchEditorActions,
  type WorkbenchEditorActionId,
} from '../models/editor/workbenchEditorActions'
import type { WorkbenchEditorCommandId } from '../models/editor/workbenchEditorCommands'
import { canEditWorkbenchFileContent } from '../models/editor/workbenchEditorEditMode'
import { moveWorkbenchEditorTabToGroup } from '../models/editor/workbenchEditorGroups'
import { toggleWorkbenchGitBlameVisible } from '../models/editor/workbenchGitBlameVisibility'
import {
  detectWorkbenchIndentation,
  resolveWorkbenchIndentation,
  toWorkbenchLanguageServiceEditFormat,
  type WorkbenchIndentation,
} from '../models/editor/workbenchIndentation'
import { getWorkbenchLanguageServiceFormat } from '../models/editor/workbenchLanguageServiceIpc'
import {
  type WorkbenchPaletteCommandContext,
  type WorkbenchPaletteCommandId,
  WorkbenchPaletteDebugActions,
  type WorkbenchPaletteLanguageService,
} from '../models/layout/workbenchCommandPalette'
import { fileLanguage } from '../models/shared/workbenchUtils'
import { toggleWorkbenchEditorWordWrap } from '../models/workbenchPreferences'
import { useLatest, useMemoizedFn } from '../support/genericHooks'

import type { useWorkbenchController } from './useWorkbenchController'
import type { WorkbenchSurfaceState } from './useWorkbenchSurfaceState'

const log = Log.tag('workbench-command-palette')

/** 面板自己处理的命令（切到按文件名找、`:` 跳行、`@` 找符号），不经页面。 */
export type WorkbenchPaletteInternalCommandId = Extract<
  WorkbenchPaletteCommandId,
  'go-to-file' | 'go-to-line' | 'go-to-symbol'
>
export type WorkbenchPalettePageCommandId = Exclude<
  WorkbenchPaletteCommandId,
  WorkbenchPaletteInternalCommandId
>

export interface WorkbenchCommandPaletteController {
  /** 判断命令此刻能不能跑要看的页面状态（见 isWorkbenchPaletteCommandAvailable）；不能跑的不列出来。 */
  context: WorkbenchPaletteCommandContext
  run: (id: WorkbenchPalettePageCommandId) => void
}

interface UseWorkbenchCommandPaletteOptions {
  workbench: Pick<
    ReturnType<typeof useWorkbenchController>,
    | 'activeProject'
    | 'applyLanguageServiceFileChanges'
    | 'canEditSelectedFile'
    | 'closeAllOpenFiles'
    | 'createTerminalSession'
    | 'editorContent'
    | 'editorLayout'
    | 'openTabs'
    | 'rerunLastCommand'
    | 'revealEntryPath'
    | 'saveAllOpenFiles'
    | 'saveSelectedFile'
    | 'selectedFile'
    | 'selectedFilePath'
      | 'toggleSelectedFileEditMode'
  >
  surface: WorkbenchSurfaceState
  /** 编辑区前面盖着别的（Git 对比、只读预览、调试页、结构图、AI 改动），不是当前文件的编辑器。 */
  editorCovered: boolean
  /** 编辑器报上来的当前文件的缩进（状态栏显示的那个）；编辑器没挂着时为 null。 */
  editorIndentation: Nullable<WorkbenchIndentation>
  closeActiveEditor: () => void
  exitCurrentProject: () => Promise<boolean>
  /** 打开侧栏的项目搜索（与 ⇧⌘F 同一个动作）。 */
  findInFiles: () => void
  /** 把键盘焦点放进编辑区的左边（0）或右边（1）那组（与 ⌘1 / ⌘2 同一个动作）。 */
  focusEditorGroup: (groupIndex: number) => void
  /** 把当前标签挪到右边那组（与 ⌘\ 同一个动作）。 */
  splitEditorRight: () => void
  navigateBack: () => Promise<void>
  navigateForward: () => Promise<void>
  openSettings: () => void
  /** 打开「编辑运行配置」对话框。 */
  editRunConfigurations: () => void
  /** 此刻有没有在调试、是不是停着。 */
  debugStatus: WorkbenchDebugStatus
  /** ▶ 指着的运行配置是一个 Node 程序，能调试。 */
  canDebugConfiguration: boolean
  /** 调试 ▶ 指着的那份运行配置（与 ▶ 旁边的调试按钮同一个动作）。 */
  debugConfiguration: () => void
  reopenClosedEditorTab: () => Promise<void>
  /** 作用在光标处的代码动作（快速修复……）：交给眼前的编辑器去做。 */
  runEditorCommand: (command: WorkbenchEditorCommandId) => void
  showEditorSurface: () => void
  toggleBottomTool: (tool: 'debug' | 'git' | 'problems' | 'terminal') => void
  zoomEditor: (action: 'decrease' | 'increase' | 'reset') => void
}

/** 当前文件归哪种语言服务照看；没有（纯文本、CSS……）为 null。 */
function resolveActiveFileLanguageService(
  path: Nullable<string>
): Nullable<WorkbenchPaletteLanguageService> {
  switch (resolveWorkbenchBuiltinLanguageServiceRuntime(path)) {
    case 'typescript-language-service':
      return 'typescript'
    case 'lsp-server':
    case 'python-language-server':
      return 'external'
    default:
      return null
  }
}

/**
 * 命令面板里各条命令此刻能不能跑、怎么跑：都是工作台里已有的动作（全局快捷键、菜单、编辑器里的那些），
 * 这里只把它们接到命令上。
 */
export function useWorkbenchCommandPalette({
  workbench,
  surface,
  editorCovered,
  editorIndentation,
  closeActiveEditor,
  exitCurrentProject,
  findInFiles,
  focusEditorGroup,
  splitEditorRight,
  navigateBack,
  navigateForward,
  openSettings,
  editRunConfigurations,
  debugStatus,
  canDebugConfiguration,
  debugConfiguration,
  reopenClosedEditorTab,
  runEditorCommand,
  showEditorSurface,
  toggleBottomTool,
  zoomEditor,
}: UseWorkbenchCommandPaletteOptions): WorkbenchCommandPaletteController {
  const latestEditor = useLatest({
    path: workbench.selectedFilePath,
    content: workbench.editorContent,
  })
  const { selectedFile } = workbench
  // 编辑器此刻做得了的动作（按需加载的编辑器自己登记，见 workbenchEditorActions）。
  const editorActions = useSyncExternalStore(
    subscribeWorkbenchEditorActions,
    getWorkbenchEditorActionsSnapshot
  )
  const context: WorkbenchPaletteCommandContext = {
    hasActiveFile: !!workbench.selectedFilePath,
    activeFileIsText: !selectedFile?.imagePreview,
    canEditActiveFile: workbench.canEditSelectedFile,
    canToggleReadOnly: !!selectedFile && canEditWorkbenchFileContent(selectedFile),
    editorCovered,
    openTabCount: workbench.openTabs.length,
    canSplitEditorRight:
      !!workbench.selectedFilePath &&
      moveWorkbenchEditorTabToGroup(workbench.editorLayout, workbench.selectedFilePath, 1) !==
        workbench.editorLayout,
    editorGroupCount: workbench.editorLayout.groups.length,
    activeFileLanguageService: resolveActiveFileLanguageService(workbench.selectedFilePath),
    editorActions: editorActions ? (editorActions.split(' ') as WorkbenchEditorActionId[]) : [],
    debugStatus,
    canDebugConfiguration,
  }

  /**
   * 格式化当前文件：与编辑器里 ⌥⌘L 同一个格式化服务（项目的 Prettier 优先，内置规则回退，内置规则按这个
   * 文件的缩进排）。改动按标签的外部改动套进编辑器（最小改动、单独一步撤销）；格式化期间正文又改了或换了
   * 文件，这份结果作废。
   */
  const formatDocument = useMemoizedFn(async (): Promise<void> => {
    const project = workbench.activeProject
    const path = workbench.selectedFilePath
    if (!project || !path || !workbench.canEditSelectedFile) return

    const content = workbench.editorContent
    try {
      const result = Result.unwrap(
        await getWorkbenchLanguageServiceFormat(
          buildWorkbenchLanguageServiceRequestBase({
            projectRoot: project.rootPath,
            path,
            language: fileLanguage(path),
            content,
            openTabs: workbench.openTabs,
            // 编辑器没报上来（刚挂上）时按正文识别，不退回语言服务自己的两格。
            format: toWorkbenchLanguageServiceEditFormat(
              editorIndentation
                ?? resolveWorkbenchIndentation({
                  path,
                  detected: detectWorkbenchIndentation(content),
                  editorConfig: null,
                })
            ),
          })
        )
      )
      const change = result.changes.find((item) => item.path === path)
      if (!change || isEmpty(change.edits)) return
      if (latestEditor.current.path !== path || latestEditor.current.content !== content) return

      workbench.applyLanguageServiceFileChanges([change])
    } catch (error) {
      log.debug('命令面板格式化文档失败', { path, error })
    }
  })

  /** 左侧切到项目树（收着就展开），定位到当前文件。 */
  const revealActiveFile = (): void => {
    const path = workbench.selectedFilePath
    if (!path) return

    showEditorSurface()
    if (surface.activeLeftTool !== 'project') surface.setActiveLeftTool('project')
    if (!surface.isFilePanelOpen) surface.toggleFilePanel()
    void workbench.revealEntryPath(path)
  }

  /** 与左侧栏的项目按钮一样：项目树开着就收起，开着别的面板就换成项目树。 */
  const toggleProjectPanel = (): void => {
    showEditorSurface()
    if (surface.activeLeftTool === 'project') {
      surface.toggleFilePanel()
      return
    }
    surface.setActiveLeftTool('project')
    if (!surface.isFilePanelOpen) surface.toggleFilePanel()
  }

  const run = (id: WorkbenchPalettePageCommandId): void => {
    switch (id) {
      case 'find-in-files': {
        findInFiles()
        return
      }
      case 'split-editor-right': {
        splitEditorRight()
        return
      }
      case 'focus-left-editor-group': {
        focusEditorGroup(0)
        return
      }
      case 'focus-right-editor-group': {
        focusEditorGroup(1)
        return
      }
      case 'navigate-back': {
        void navigateBack()
        return
      }
      case 'navigate-forward': {
        void navigateForward()
        return
      }
      case 'save-current': {
        void workbench.saveSelectedFile()
        return
      }
      case 'save-all': {
        void workbench.saveAllOpenFiles()
        return
      }
      case 'close-editor': {
        closeActiveEditor()
        return
      }
      case 'close-all-editors': {
        workbench.closeAllOpenFiles()
        return
      }
      case 'reopen-closed-tab': {
        void reopenClosedEditorTab()
        return
      }
      case 'format-document': {
        void formatDocument()
        return
      }
      case 'quick-fix':
      case 'refactor':
      case 'organize-imports':
      case 'find-references':
      case 'call-hierarchy': {
        runEditorCommand(id)
        return
      }
      case 'toggle-word-wrap': {
        toggleWorkbenchEditorWordWrap()
        return
      }
      case 'toggle-read-only': {
        workbench.toggleSelectedFileEditMode()
        return
      }
      case 'toggle-git-blame': {
        toggleWorkbenchGitBlameVisible()
        return
      }
      case 'reveal-active-file': {
        revealActiveFile()
        return
      }
      case 'toggle-project-panel': {
        toggleProjectPanel()
        return
      }
      case 'toggle-problems': {
        toggleBottomTool('problems')
        return
      }
      case 'toggle-git': {
        toggleBottomTool('git')
        return
      }
      case 'toggle-terminal': {
        toggleBottomTool('terminal')
        return
      }
      case 'new-terminal': {
        surface.openBottomTool('terminal')
        void workbench.createTerminalSession()
        return
      }
      case 'toggle-chat': {
        surface.toggleRightTool('chat')
        return
      }
      case 'run-last-command': {
        void workbench.rerunLastCommand()
        return
      }
      case 'edit-run-configurations': {
        editRunConfigurations()
        return
      }
      case 'run-test-at-cursor':
      case 'run-test-file':
      case 'debug-test-at-cursor':
      case 'toggle-breakpoint': {
        runWorkbenchEditorAction(id)
        return
      }
      case 'debug-configuration': {
        debugConfiguration()
        return
      }
      case 'toggle-debug-panel': {
        toggleBottomTool('debug')
        return
      }
      case 'debug-continue':
      case 'debug-pause':
      case 'debug-step-into':
      case 'debug-step-out':
      case 'debug-step-over':
      case 'debug-stop': {
        const action = WorkbenchPaletteDebugActions[id]
        if (action) runWorkbenchDebugAction(action)
        return
      }
      case 'zoom-in': {
        zoomEditor('increase')
        return
      }
      case 'zoom-out': {
        zoomEditor('decrease')
        return
      }
      case 'zoom-reset': {
        zoomEditor('reset')
        return
      }
      case 'open-settings': {
        openSettings()
        return
      }
      case 'close-project': {
        void exitCurrentProject()
      }
    }
  }

  return { context, run }
}
