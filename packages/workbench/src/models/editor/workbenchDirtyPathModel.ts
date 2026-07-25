import type { WorkbenchOpenEditorTab } from '../../types/workbenchTypes'
import { getParentPath, ROOT_PATH } from '../shared/workbenchUtils'

export function buildWorkbenchDirtyPathSet(openTabs: WorkbenchOpenEditorTab[]): Set<string> {
  return new Set(openTabs.filter((tab) => tab.content !== tab.file.content).map((tab) => tab.path))
}

export function buildWorkbenchDirtyPathDecorations(
  openTabs: WorkbenchOpenEditorTab[]
): Set<string> {
  const dirtyPaths = buildWorkbenchDirtyPathSet(openTabs)
  const decorations = new Set<string>()

  for (const dirtyPath of dirtyPaths) {
    decorations.add(dirtyPath)

    let parentPath = getParentPath(dirtyPath)
    while (parentPath && !decorations.has(parentPath)) {
      decorations.add(parentPath)
      if (parentPath === ROOT_PATH) {
        break
      }
      parentPath = getParentPath(parentPath)
    }
  }

  return decorations
}
