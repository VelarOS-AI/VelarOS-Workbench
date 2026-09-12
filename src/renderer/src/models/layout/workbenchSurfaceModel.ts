/** Workbench 产品表面的稳定工具标识；组件只负责呈现，不拥有这些产品状态类型。 */
export type WorkbenchBottomTool = 'git' | 'problems' | 'run' | 'terminal'

export type WorkbenchLeftTool =
  | 'ai-changes'
  | 'commit'
  | 'issues'
  | 'project'
  | 'velar-structure'

export type WorkbenchRightToolWindow = 'chat' | 'claude' | 'chatgpt'

/**
 * 页面导航的去向。凡是从别处把东西带到用户眼前的导航，都先按这张表把编辑区与左侧一起定好：
 * - `file`：打开项目里的文件——回答里的路径、改动卡的逐文件打开、Agent 的 open_file / explain_code /
 *   读问题、快速打开、结构图与「AI 改动」对比里的「打开文件」；
 * - `file-preview`：打开项目外文件的只读预览（跨项目的改动卡），同样落在普通文件区；
 * - `reveal`：在文件树里定位（Agent 的 reveal_in_explorer）；
 * - `git-diff`：Git 工作区对比（Agent 的 open_diff）；
 * - `ai-changes`：审核一轮 AI 改动（改动卡的「审核」）。
 */
export type WorkbenchNavigationTarget = 'file' | 'file-preview' | 'reveal' | 'git-diff' | 'ai-changes'

export interface WorkbenchNavigationSurface {
  /** 编辑区落在哪一组：`primary` 是普通文件区，进入前退出结构图、「AI 改动」这类独占组。 */
  readonly editorGroup: 'primary' | 'ai-changes'
  readonly leftTool: WorkbenchLeftTool
  /** 左侧面板收起时要不要展开：定位与审核本来就是给人看左侧的；打开文件、看对比只切面板，不挤占编辑区。 */
  readonly revealLeftPanel: boolean
}

const WorkbenchNavigationSurfaces: Readonly<
  Record<WorkbenchNavigationTarget, WorkbenchNavigationSurface>
> = {
  file: { editorGroup: 'primary', leftTool: 'project', revealLeftPanel: false },
  'file-preview': { editorGroup: 'primary', leftTool: 'project', revealLeftPanel: false },
  reveal: { editorGroup: 'primary', leftTool: 'project', revealLeftPanel: true },
  'git-diff': { editorGroup: 'primary', leftTool: 'commit', revealLeftPanel: false },
  'ai-changes': { editorGroup: 'ai-changes', leftTool: 'ai-changes', revealLeftPanel: true },
}

/** 左右两侧说的是同一件事：编辑区落在哪，左侧就切到对应的面板。 */
export function resolveWorkbenchNavigationSurface(
  target: WorkbenchNavigationTarget
): WorkbenchNavigationSurface {
  return WorkbenchNavigationSurfaces[target]
}
