/**
 * 文件树里的符号链接：链接本身总是显示出来。目标在工程里的照常当目录 / 文件用；
 * 目标在工程外或已不存在的只显示链接本身，不跟进去——只解析路径判断在哪，
 * 不读目标的信息、不列举、不读取。
 */
import type { Stats } from 'node:fs'
import { readlink, realpath, stat } from 'node:fs/promises'

import type { WorkbenchDirectoryEntrySymlink } from '@shared/contracts'

import { isPathInsideRoot } from './PathContainmentHelper'

export interface WorkbenchSymlinkDescription {
  symlink: WorkbenchDirectoryEntrySymlink
  /** 目标在工程里时：解析后的真实路径与目标的信息。在工程外或已不存在时为 null。 */
  resolved: Nullable<{ realPath: string; stats: Stats }>
}

/** 看一个链接指向哪。`linkPath` 是链接本身的路径，`projectRoot` 是真实路径。 */
export async function describeWorkbenchSymlink(
  projectRoot: string,
  linkPath: string
): Promise<WorkbenchSymlinkDescription> {
  const target = await readlink(linkPath).catch(() => '')
  const unresolved = (targetState: 'outside' | 'missing'): WorkbenchSymlinkDescription => ({
    symlink: { target, targetState },
    resolved: null,
  })

  // 解析到底（链接可能一环套一环，也可能经由别的链接绕出工程）再判断在不在工程里。
  const realPath = await realpath(linkPath).catch(() => null)
  if (!realPath) return unresolved('missing')
  if (!isPathInsideRoot(projectRoot, realPath)) return unresolved('outside')

  const stats = await stat(realPath).catch(() => null)
  if (!stats) return unresolved('missing')

  return { symlink: { target, targetState: 'inside' }, resolved: { realPath, stats } }
}
