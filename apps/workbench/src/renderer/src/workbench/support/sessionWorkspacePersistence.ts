/**
 * 独立 Workbench 应用的会话工作区快照落地降级实现
 * （对位 desktop `@/hooks/workspace/sessionWorkspacePersistence`）。
 *
 * Desktop 侧把 workspace overview 写进 chat 会话 hydration 缓存供聊天面消费；独立应用
 * 没有 chat 会话面（Phase 3 kernel-protocol 接入前），落地为 no-op。
 */
import type { SystemOverview } from '@velaros-ai/workbench/contracts'

export function persistSessionWorkspaceOverview(
  _sessionId: string,
  _overview: SystemOverview
): void {
  // Phase 3 前无会话 hydration 消费方。
}
