/**
 * 文件列举、路径解析与文件监听统一跳过的目录名：版本库内部、依赖与构建产物。
 *
 * 原先借 Platform 项目包的 `shouldSkipProjectDirectory`。Platform 现在只给范围更宽的
 * `DiscoverySkippedDirectoryNames`（连 `.idea`、`.vscode`、`coverage`、`vendor` 也跳），那是给模型遍历用的；
 * IDE 里这些目录照样要看得到、改了要听得到，名单留在 Workbench 自己这里。
 */
const WorkbenchSkippedDirectoryNames: ReadonlySet<string> = new Set([
  '.codegraph',
  '.data',
  '.git',
  'build',
  'dist',
  'node_modules',
  'out',
])

export function shouldSkipProjectDirectory(name: string): boolean {
  return WorkbenchSkippedDirectoryNames.has(name)
}
