/**
 * 编辑器标签上显示的名字：只显示文件名；几个打开的文件同名时，像 VS Code 那样在名字后面
 * 补上能把它们区分开的上级目录（最少的末尾几级，前面还有更多目录时以 `…/` 开头）。
 */

export interface WorkbenchEditorTabLabel {
  name: string
  /** 区分同名文件的上级目录；不同名时为 null。项目根下的文件写作 `./`。 */
  description: Nullable<string>
}

function splitPathSegments(path: string): string[] {
  return path.split('/').filter((segment) => !!segment)
}

function describeParentSuffix(parents: readonly string[], depth: number): string {
  if (parents.length === 0) return './'

  const suffix = parents.slice(-depth).join('/')
  return parents.length > depth ? `…/${suffix}` : suffix
}

export function buildWorkbenchEditorTabLabels(
  paths: readonly string[]
): Map<string, WorkbenchEditorTabLabel> {
  const labels = new Map<string, WorkbenchEditorTabLabel>()
  const pathsByName = new Map<string, string[]>()
  for (const path of paths) {
    const name = splitPathSegments(path).at(-1) ?? path
    labels.set(path, { name, description: null })
    pathsByName.set(name, [...(pathsByName.get(name) ?? []), path])
  }

  for (const group of pathsByName.values()) {
    if (group.length < 2) continue

    const parentsByPath = new Map(
      group.map((path) => [path, splitPathSegments(path).slice(0, -1)] as const)
    )
    const deepest = Math.max(...[...parentsByPath.values()].map((parents) => parents.length))
    // 从末尾一级目录开始往上加，直到这一组里每个文件补出来的目录都不一样。
    // 比的是目录本身，不算 `…/`：`a/x` 与 `x` 末一级都是 x，要再往上一级才分得开。
    let depth = 1
    while (depth < deepest) {
      const suffixes = group.map((path) =>
        (parentsByPath.get(path) ?? []).slice(-depth).join('/')
      )
      if (new Set(suffixes).size === suffixes.length) break
      depth += 1
    }

    for (const path of group) {
      const label = labels.get(path)
      if (label) label.description = describeParentSuffix(parentsByPath.get(path) ?? [], depth)
    }
  }
  return labels
}
