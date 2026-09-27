import { mkdir, rename } from 'node:fs/promises'
import { basename, join } from 'node:path'

import type { WorkbenchMoveToTrash } from '../../src/main/workspace/DeleteUndoStore'

export interface FakeTrash {
  /** 按先后记下每次移进废纸篓的绝对路径。 */
  trashed: string[]
  moveToTrash: WorkbenchMoveToTrash
}

/**
 * 测试里代替 Electron `shell.trashItem` 的废纸篓：把条目挪进给定的临时目录
 * （像系统废纸篓一样离开工程），绝不碰用户真实的废纸篓。
 */
export function createFakeTrash(trashDir: string): FakeTrash {
  const trashed: string[] = []
  return {
    trashed,
    moveToTrash: async (absolutePath) => {
      trashed.push(absolutePath)
      await mkdir(trashDir, { recursive: true })
      await rename(absolutePath, join(trashDir, `${trashed.length}-${basename(absolutePath)}`))
    },
  }
}

/** 用不到删除的测试：真走到删除就是出了错。 */
export const refuseTrash: WorkbenchMoveToTrash = async (absolutePath) => {
  throw new Error(`unexpected move to trash: ${absolutePath}`)
}
