import { type WorkspaceGitRemoteAction } from '@shared/contracts/system'

/**
 * 一个项目正在跑的远端操作（获取、拉取、同步、推送）。顶栏的分支菜单、提交面板的推送按钮都能发起远端
 * 操作；登记在这里之后，不管谁发起的，别处都看得到它在跑、都能取消它，也不会同时再起一个。
 */
export interface WorkbenchGitRemoteOperation {
  /** 这次操作的编号，随请求带给主进程，取消时凭它对号。 */
  id: string
  workspaceRoot: string
  action: WorkspaceGitRemoteAction
  /** 已经点了取消，在等 git 进程收场。 */
  cancelling: boolean
}

const operations = new Map<string, WorkbenchGitRemoteOperation>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function findById(id: string): Nullable<WorkbenchGitRemoteOperation> {
  for (const operation of operations.values()) if (operation.id === id) return operation
  return null
}

/** 登记一个要开始的远端操作；这个项目已经有一个在跑时为 null（同一时刻只跑一个）。 */
export function beginWorkbenchGitRemoteOperation(
  workspaceRoot: string,
  action: WorkspaceGitRemoteAction
): Nullable<WorkbenchGitRemoteOperation> {
  if (operations.has(workspaceRoot)) return null
  const operation: WorkbenchGitRemoteOperation = {
    id: crypto.randomUUID(),
    workspaceRoot,
    action,
    cancelling: false,
  }
  operations.set(workspaceRoot, operation)
  notify()
  return operation
}

/** 操作收场了（成功、失败、被取消都算）。 */
export function endWorkbenchGitRemoteOperation(id: string): void {
  const operation = findById(id)
  if (!operation) return
  operations.delete(operation.workspaceRoot)
  notify()
}

/** 记下已经请求取消：按钮上换成「正在取消」，不再重复发取消。 */
export function markWorkbenchGitRemoteOperationCancelling(id: string): void {
  const operation = findById(id)
  if (!operation || operation.cancelling) return
  // 换一个新对象：订阅方按引用比较快照。
  operations.set(operation.workspaceRoot, { ...operation, cancelling: true })
  notify()
}

export function readWorkbenchGitRemoteOperation(
  workspaceRoot: string
): Nullable<WorkbenchGitRemoteOperation> {
  return operations.get(workspaceRoot) ?? null
}

export function subscribeWorkbenchGitRemoteOperations(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
