import type { WorkbenchOpenEditorTab } from '../../types/workbenchTypes'

import {
  isWorkbenchFileEditable,
  resolveWorkbenchEditorEditMode,
  type WorkbenchEditorEditMode,
} from './workbenchEditorEditMode'
import type { WorkbenchEditorGroupsLayout } from './workbenchEditorGroups'

/**
 * 编辑区里一组的样子：标签栏上的标签、正在显示的文件。标签布局只认路径（workbenchEditorGroups），这里把
 * 每一组的路径配上文件的正文与磁盘快照，给这一组的面板渲染。
 */
export interface WorkbenchEditorGroupView {
  /** 在布局里的下标：0 是左边那组，1 是右边那组。 */
  index: number
  /** 全局动作（保存、查找、跳行……）此刻作用在这一组上。 */
  focused: boolean
  /** 标签栏顺序的标签：前 `pinnedCount` 个是固定标签。 */
  tabs: WorkbenchOpenEditorTab[]
  pinnedCount: number
  /** 预览标签的路径；没有为 null。 */
  previewPath: Nullable<string>
  /** 正在显示的标签；组里没有标签时为 null。 */
  activeTab: Nullable<WorkbenchOpenEditorTab>
  /** 正在显示的文件的只读 / 编辑模式；没有文件时为 null。 */
  editMode: Nullable<WorkbenchEditorEditMode>
  /** 此刻能不能往正在显示的文件里打字。 */
  canEdit: boolean
}

export function buildWorkbenchEditorGroupViews(
  layout: WorkbenchEditorGroupsLayout,
  tabsByPath: ReadonlyMap<string, WorkbenchOpenEditorTab>,
  chosenEditModes: ReadonlyMap<string, WorkbenchEditorEditMode>
): WorkbenchEditorGroupView[] {
  return layout.groups.map((group, index) => {
    const tabs = group.paths.flatMap((path) => {
      const tab = tabsByPath.get(path)
      return tab ? [tab] : []
    })
    const activeTab = (group.activePath ? tabsByPath.get(group.activePath) : null) ?? null
    const chosenMode = activeTab ? chosenEditModes.get(activeTab.path) : undefined
    return {
      index,
      focused: index === layout.focusedGroup,
      tabs,
      pinnedCount: group.paths.slice(0, group.pinnedCount).filter((path) => tabsByPath.has(path))
        .length,
      previewPath: group.previewPath,
      activeTab,
      editMode: activeTab ? resolveWorkbenchEditorEditMode(activeTab.file, chosenMode) : null,
      canEdit: !!activeTab && isWorkbenchFileEditable(activeTab.file, chosenMode),
    }
  })
}
