import type { MemoryEntry } from '@velaros-ai/velaros/memory/contracts'

import type { WorkbenchFsCallResult } from './workbenchFs'

/**
 * 长期记忆的设置页通道：只看、只删当前窗口所在项目的那一份（作用域 `project:<项目根的真实路径>`）。
 * 记忆由模型在对话里存和删；这里不提供新建与编辑。
 */
export const WorkbenchMemoryChannels = {
  listEntries: 'workbench-app:memory:list-entries',
  removeEntry: 'workbench-app:memory:remove-entry',
} as const

export interface WorkbenchMemoryProjectRequest {
  projectRoot: string
}

export interface WorkbenchMemoryRemoveRequest extends WorkbenchMemoryProjectRequest {
  id: string
}

export type WorkbenchMemoryEntry = MemoryEntry

export interface WorkbenchMemoryBridge {
  /** 这个项目的全部记忆，最近更新的在前。 */
  listEntries(
    request: WorkbenchMemoryProjectRequest
  ): Promise<WorkbenchFsCallResult<WorkbenchMemoryEntry[]>>
  /** 删掉一条；本来就没有时 `removed` 为假。 */
  removeEntry(
    request: WorkbenchMemoryRemoveRequest
  ): Promise<WorkbenchFsCallResult<{ removed: boolean }>>
}
