/**
 * 会话 → 它所在的项目根。共享会话界面（目标卡、动作端口）只按会话 id 说话，主进程的会话通道却要按
 * (项目根, 会话) 认：聊天适配器在会话建出、恢复时登记，动作端口据此补上项目根。
 */
const projectRootsBySession = new Map<string, string>()

export function registerStandaloneChatSession(sessionId: string, projectRoot: string): void {
  if (sessionId && projectRoot) projectRootsBySession.set(sessionId, projectRoot)
}

export function forgetStandaloneChatSession(sessionId: string): void {
  projectRootsBySession.delete(sessionId)
}

export function resolveStandaloneChatSessionProjectRoot(sessionId: string): Nullable<string> {
  return projectRootsBySession.get(sessionId) ?? null
}
