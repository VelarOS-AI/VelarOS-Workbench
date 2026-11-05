import { useCallback, useSyncExternalStore } from 'react'

import { toNullable } from '@velaros-ai/velaros/core'

import type { ConversationCommandOutputProjection } from '@shared/workbenchConversation'

/**
 * 脚本卡上的运行中输出（与 Desktop 同一做法）：主进程按脚本卡推来的「正在跑的命令刚吐出的末尾一段」，空串
 * 就是没有了。它只是展示，不进会话记录；包内脚本卡经块钩子 `useScriptLiveOutput` 取，按卡订阅，一张卡的
 * 输出变了只重画那一张。
 */
const outputs = new Map<string, string>()
const listeners = new Map<string, Set<() => void>>()

export function applyWorkbenchScriptLiveOutput({
  id,
  text,
}: ConversationCommandOutputProjection): void {
  if (text) outputs.set(id, text)
  else outputs.delete(id)
  for (const listener of listeners.get(id) ?? []) listener()
}

export function useWorkbenchScriptLiveOutput(blockId: string): Nullable<string> {
  const subscribe = useCallback(
    (listener: () => void) => {
      const subscribed = listeners.get(blockId) ?? new Set<() => void>()
      subscribed.add(listener)
      listeners.set(blockId, subscribed)
      return () => {
        subscribed.delete(listener)
        if (!subscribed.size) listeners.delete(blockId)
      }
    },
    [blockId]
  )
  return useSyncExternalStore(
    subscribe,
    () => toNullable(outputs.get(blockId)),
    () => null
  )
}
