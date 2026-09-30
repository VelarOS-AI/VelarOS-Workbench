import { WorkbenchWatchWholeRootPath } from '@shared/workbenchWatch'

/**
 * 文件变更事件里的这个路径会不会改变快速打开的文件清单：版本库状态文件（`.git/HEAD` 之类）与收成目录本身
 * 报的依赖、构建产物（`node_modules`、根目录下的 `dist`）不会——清单本来就跳过它们。
 *
 * 单独成文件：文件清单常驻工作区外壳，快速打开的打分与界面按需加载，不跟着它进外壳。
 */
export function isWorkbenchProjectFileListChange(path: string): boolean {
  if (path === WorkbenchWatchWholeRootPath) return true

  const segments = path.split('/').filter(Boolean)
  if (segments[0] === '.git') return false
  if (segments.at(-1) === 'node_modules') return false
  return !(segments.length === 1 && ['build', 'dist', 'out'].includes(segments[0]))
}
