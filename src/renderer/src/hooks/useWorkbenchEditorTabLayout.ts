import { useRef, useState } from 'react'
import {
  createWorkbenchEditorGroupsLayout,
  reorderWorkbenchEditorTab,
  type WorkbenchEditorGroupsLayout,
} from '@renderer/models/editor/workbenchEditorGroups'

import { useMemoizedFn } from '../support/genericHooks'

/**
 * 编辑区标签布局的状态：标签栏顺序、每组的当前标签、当前组（见 workbenchEditorGroups）。
 *
 * 只动布局的操作（拖动标签）在这里接好；要同时动文件正文的（打开、关闭、改名、恢复会话）由
 * useWorkbenchEditorController 拿 `layoutRef` 与 `commitLayout` 自己算。
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

  return { layout, layoutRef, commitLayout, reorderOpenTabs }
}
