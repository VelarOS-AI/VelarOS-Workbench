/**
 * 会话 → 它所在的项目根。共享会话界面（目标卡、动作端口）只按会话 id 说话，主进程的会话通道却要按
 * (项目根, 会话) 认：聊天适配器在会话建出、恢复时登记，动作端口据此补上项目根。
 */
import { AppError } from '@velaros-ai/velaros/core/error'

export interface StandaloneChatSessionOwner {
  readonly sessionId: string
  readonly projectRoot: string
  readonly controller: AbortController
}

const owners =
  (import.meta.hot?.data.sessionOwners as Map<string, StandaloneChatSessionOwner> | undefined) ??
  new Map<string, StandaloneChatSessionOwner>()

export function registerStandaloneChatSession(sessionId: string, projectRoot: string): void {
  if (!sessionId || !projectRoot) return
  const existing = owners.get(sessionId)
  if (existing) {
    if (existing.projectRoot !== projectRoot)
      throw new AppError('CONFLICT', '会话已绑定到其它项目。')
    return
  }
  owners.set(sessionId, { sessionId, projectRoot, controller: new AbortController() })
}

export function forgetStandaloneChatSession(sessionId: string): void {
  const owner = owners.get(sessionId)
  owners.delete(sessionId)
  owner?.controller.abort(new AppError('CANCELLED', '会话已移除。'))
}

export function resolveStandaloneChatSessionProjectRoot(sessionId: string): Nullable<string> {
  return owners.get(sessionId)?.projectRoot ?? null
}

export function readStandaloneChatSessionOwner(
  projectRoot: string,
  sessionId: string
): Nullable<StandaloneChatSessionOwner> {
  const owner = owners.get(sessionId)
  return owner?.projectRoot === projectRoot ? owner : null
}

if (import.meta.hot)
  import.meta.hot.dispose((data) => {
    data.sessionOwners = owners
  })
