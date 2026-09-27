/**
 * 文件搜索与文件监听按位置对待的目录（文件树照样列出它们）。
 *
 * - 内部目录，任何层级：版本库（`.git`）与应用自己的数据目录（`.codegraph`、`.data`）。
 *   不搜，改动不报（版本库的几个状态文件除外，见文件监听）。
 * - 生成出来的重型目录：依赖目录 `node_modules` 在任何层级；构建产物 `build` / `dist` / `out`
 *   只认工程根目录下的——更深处同名的目录常常就是源码（`src/build/`、`scripts/out/`），
 *   要搜得到、改了要听得到。它们不搜；改动收成那个目录本身报一次，展开着的 `dist/` 照样跟着刷新。
 *
 * 不按 .gitignore 来：不是每个工程都是 Git 仓库，搜索要在热路径上逐目录问 `git check-ignore`；
 * 忽略规则在文件树里已经以「弱化」的样子显示出来。原先借 Platform 项目包的名单范围更宽
 * （连 `.idea`、`coverage` 也跳），那是给模型遍历用的，IDE 里这些目录要看得到、搜得到，
 * 名单留在 Workbench 自己这里。
 */
const InternalDirectoryNames: ReadonlySet<string> = new Set(['.codegraph', '.data', '.git'])
const DependencyDirectoryNames: ReadonlySet<string> = new Set(['node_modules'])
const RootBuildOutputDirectoryNames: ReadonlySet<string> = new Set(['build', 'dist', 'out'])

/** 版本库与应用自己的数据目录：里面的东西不是项目文件。 */
export function isInternalProjectDirectory(name: string): boolean {
  return InternalDirectoryNames.has(name)
}

/** 生成出来的重型目录：`node_modules` 在任何层级；`build` / `dist` / `out` 只在工程根目录下。 */
export function isGeneratedProjectDirectory(name: string, atProjectRoot: boolean): boolean {
  return (
    DependencyDirectoryNames.has(name) || (atProjectRoot && RootBuildOutputDirectoryNames.has(name))
  )
}

/** 文件搜索要不要跳过这个目录：`atProjectRoot` 表示它直接在工程根目录下。 */
export function shouldSkipProjectDirectory(name: string, atProjectRoot: boolean): boolean {
  return isInternalProjectDirectory(name) || isGeneratedProjectDirectory(name, atProjectRoot)
}
