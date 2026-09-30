import type { WorkbenchOpenEditorTab } from '@renderer/types/workbenchTypes'

import { hasWorkspaceGitConflictMarkers } from '@shared/workbenchGit'

export interface WorkbenchMergeResolutionScan {
  /** 各个打开着的冲突文件，存下来的那一版还有没有冲突标记。 */
  markers: ReadonlyMap<string, boolean>
  /** 这一次刚解决完的：上次看还有冲突标记，存下来的新一版没有了。 */
  resolved: string[]
}

/**
 * 看打开着的冲突文件（git 里还是冲突状态的）存下来的那一版：从有冲突标记变成没有，就是在编辑器里解决完、
 * 存了盘，该问一句要不要标记为已解决。打开时就已经没有标记的（在别处解决的）不算；关掉了的、已经不是冲突的
 * 不再记着。
 */
export function scanWorkbenchMergeResolutions(
  previous: ReadonlyMap<string, boolean>,
  conflictedPaths: ReadonlySet<string>,
  openTabs: readonly WorkbenchOpenEditorTab[]
): WorkbenchMergeResolutionScan {
  const markers = new Map<string, boolean>()
  const resolved: string[] = []
  for (const tab of openTabs) {
    if (!conflictedPaths.has(tab.path) || tab.file.imagePreview) continue
    const hasMarkers = hasWorkspaceGitConflictMarkers(tab.file.content)
    markers.set(tab.path, hasMarkers)
    if (previous.get(tab.path) && !hasMarkers) resolved.push(tab.path)
  }
  return { markers, resolved }
}
