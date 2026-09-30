import { useRef, useState } from 'react'
import {
  createWorkbenchEditorGroupsLayout,
  focusWorkbenchEditorGroup,
  keepWorkbenchEditorTab,
  moveWorkbenchEditorTabToGroup,
  pinWorkbenchEditorTab,
  reorderWorkbenchEditorTab,
  setWorkbenchEditorSplitRatio,
  unpinWorkbenchEditorTab,
  type WorkbenchEditorGroupsLayout,
} from '@renderer/models/editor/workbenchEditorGroups'

import { useMemoizedFn } from '../support/genericHooks'

/**
 * 编辑区标签布局的状态：左右两组各自的标签栏顺序与当前标签、当前组、分隔条位置（见 workbenchEditorGroups）。
 *
 * 只动布局的操作（拖动标签、把预览标签留下、固定与取消固定、换当前组、把标签挪到另一组、拖分隔条）在这里
 * 接好；要同时动文件正文的（打开、关闭、改名、恢复会话）由 useWorkbenchEditorController 拿 `layoutRef` 与
 * `commitLayout` 自己算。
 */
export function useWorkbenchEditorTabLayout() {
  const [layout, setLayout] = useState(createWorkbenchEditorGroupsLayout)
  // 同一轮事件里接连改两次布局（文件读完紧接着又关掉别的标签）时，后一次要接在前一次的结果上：
  // 渲染出来的那份此刻还是旧的，所以最新的布局另记在 ref 里。
  const layoutRef = useRef(layout)

  const commitLayout = useMemoizedFn((next: WorkbenchEditorGroupsLayout): void => {
    if (next === layoutRef.current) return
    layoutRef.current = next
    setLayout(next)
  })

  const reorderOpenTabs = useMemoizedFn((fromPath: string, toPath: string): void => {
    commitLayout(reorderWorkbenchEditorTab(layoutRef.current, fromPath, toPath))
  })

  /** 把预览标签留下（双击标签、编辑、保存）；不是预览标签时什么也不做。 */
  const keepOpenFile = useMemoizedFn((path: string): void => {
    commitLayout(keepWorkbenchEditorTab(layoutRef.current, path))
  })

  /** 固定标签：挪到标签栏左边的固定区里。 */
  const pinOpenFile = useMemoizedFn((path: string): void => {
    commitLayout(pinWorkbenchEditorTab(layoutRef.current, path))
  })

  const unpinOpenFile = useMemoizedFn((path: string): void => {
    commitLayout(unpinWorkbenchEditorTab(layoutRef.current, path))
  })

  /** 把全局动作（保存、查找、跳行……）交给这一组。 */
  const focusEditorGroup = useMemoizedFn((groupIndex: number): void => {
    commitLayout(focusWorkbenchEditorGroup(layoutRef.current, groupIndex))
  })

  /**
   * 把标签挪到另一组并切过去（「拆分并右移」、「移到另一侧」、拖到另一组的标签栏上）；右边那组还不存在
   * 就新开出来。`beforePath` 是拖放时落在哪个标签前面。返回挪完之后的布局（原来那组挪空了会收掉，标签
   * 最后在哪一组要看它）。
   */
  const moveOpenFileToGroup = useMemoizedFn(
    (path: string, groupIndex: number, beforePath?: Nullable<string>): WorkbenchEditorGroupsLayout => {
      commitLayout(moveWorkbenchEditorTabToGroup(layoutRef.current, path, groupIndex, beforePath))
      return layoutRef.current
    }
  )

  const setEditorSplitRatio = useMemoizedFn((ratio: number): void => {
    commitLayout(setWorkbenchEditorSplitRatio(layoutRef.current, ratio))
  })

  return {
    layout,
    layoutRef,
    commitLayout,
    reorderOpenTabs,
    keepOpenFile,
    pinOpenFile,
    unpinOpenFile,
    focusEditorGroup,
    moveOpenFileToGroup,
    setEditorSplitRatio,
  }
}
