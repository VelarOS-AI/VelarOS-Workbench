import { isEmpty, Log } from '@velaros-ai/core'
import { Result } from '@velaros-ai/core/result'

import { buildWorkbenchLanguageServiceRequestBase } from '../models/editor/workbenchCodeMirrorLanguageService'
import { canEditWorkbenchFileContent } from '../models/editor/workbenchEditorEditMode'
import { moveWorkbenchEditorTabToGroup } from '../models/editor/workbenchEditorGroups'
import { toggleWorkbenchGitBlameVisible } from '../models/editor/workbenchGitBlameVisibility'
import { getWorkbenchLanguageServiceFormat } from '../models/editor/workbenchLanguageServiceIpc'
import type {
  WorkbenchPaletteCommandContext,
  WorkbenchPaletteCommandId,
} from '../models/layout/workbenchCommandPalette'
import { toggleWorkbenchEditorWordWrap } from '../models/settings/workbenchPreferences'
import { fileLanguage } from '../models/shared/workbenchUtils'
import { useLatest, useMemoizedFn } from '../support/genericHooks'

import type { useWorkbenchController } from './useWorkbenchController'
import type { WorkbenchSurfaceState } from './useWorkbenchSurfaceState'

const log = Log.tag('workbench-command-palette')

/** 面板自己处理的命令（切到按文件名找、`:` 跳行），不经页面。 */
export type WorkbenchPaletteInternalCommandId = Extract<
  WorkbenchPaletteCommandId,
  'go-to-file' | 'go-to-line'
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
    | 'splitTerminalSession'
    | 'toggleSelectedFileEditMode'
  >
  surface: WorkbenchSurfaceState
  /** 编辑区前面盖着别的（Git 对比、只读预览、调试页、结构图、AI 改动），不是当前文件的编辑器。 */
  editorCovered: boolean
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
  reopenClosedEditorTab: () => Promise<void>
  showEditorSurface: () => void
  toggleBottomTool: (tool: 'git' | 'problems' | 'terminal') => void
  zoomEditor: (action: 'decrease' | 'increase' | 'reset') => void
}

/**
 * 命令面板里各条命令此刻能不能跑、怎么跑：都是工作台里已有的动作（全局快捷键、菜单、编辑器里的那些），
 * 这里只把它们接到命令上。
 */
export function useWorkbenchCommandPalette({
  workbench,
  surface,
  editorCovered,
  closeActiveEditor,
  exitCurrentProject,
  findInFiles,
  focusEditorGroup,
  splitEditorRight,
  navigateBack,
  navigateForward,
  openSettings,
  reopenClosedEditorTab,
  showEditorSurface,
  toggleBottomTool,
  zoomEditor,
}: UseWorkbenchCommandPaletteOptions): WorkbenchCommandPaletteController {
  const latestEditor = useLatest({
    path: workbench.selectedFilePath,
    content: workbench.editorContent,
  })
  const { selectedFile } = workbench
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
  }

  /**
   * 格式化当前文件：与编辑器里 ⌥⌘L 同一个格式化服务（项目的 Prettier 优先，内置规则回退）。改动按标签的
   * 外部改动套进编辑器（最小改动、单独一步撤销）；格式化期间正文又改了或换了文件，这份结果作废。
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
      case 'split-terminal': {
        surface.openBottomTool('terminal')
        void workbench.splitTerminalSession()
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
