import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import type { StandaloneAgentTerminalKind } from './standaloneWorkbenchChatRuntime'

export type StandaloneAgentStopSettlement =
  | {
      readonly kind: 'terminal'
      readonly terminalKind: StandaloneAgentTerminalKind
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'request-rejected' }
  | { readonly kind: 'request-error'; readonly error: unknown }

interface AwaitStandaloneAgentStopSettlementInput {
  readonly requestAbort: () => Promise<boolean>
  readonly terminalSettlement: Promise<StandaloneAgentTerminalKind>
  readonly readTerminalKind: () => StandaloneAgentTerminalKind | null
  readonly timeoutMs: number
}

type AbortRequestSettlement =
  | { readonly kind: 'request-accepted' }
  | Extract<
      StandaloneAgentStopSettlement,
      { readonly kind: 'request-rejected' | 'request-error' }
    >

/**
 * Renderer 侧 Stop 的有界协调器。
 *
 * timeout 在调用 IPC 前就开始计时，因此 preload/main 卡住也不会把 composer 永久留在
 * stopping。运行时终态始终优先；超时仅表示控制链没有确认终止，调用方不能把它伪装成
 * 已成功 aborted。
 */
export async function awaitStandaloneAgentStopSettlement(
  input: AwaitStandaloneAgentStopSettlementInput
): Promise<StandaloneAgentStopSettlement> {
  const timers = new TimerScope({ name: 'WorkbenchChat.stopSettlement' })
  try {
    const timeoutSettlement = new Promise<StandaloneAgentStopSettlement>((resolve) => {
      timers.after(
        Math.max(0, input.timeoutMs),
        () => resolve({ kind: 'timeout' }),
        { label: 'agent.stop-settlement' }
      )
    })
    const terminalSettlement = input.terminalSettlement.then((terminalKind) => ({
      kind: 'terminal' as const,
      terminalKind,
    }))
    const abortRequestSettlement = Promise.resolve()
      .then(input.requestAbort)
      .then<AbortRequestSettlement, AbortRequestSettlement>(
        (accepted) => accepted
          ? { kind: 'request-accepted' }
          : { kind: 'request-rejected' },
        (error: unknown) => ({ kind: 'request-error', error })
      )

    const first = await Promise.race([
      terminalSettlement,
      timeoutSettlement,
      abortRequestSettlement,
    ])
    if (first.kind === 'request-accepted')
      return await Promise.race([terminalSettlement, timeoutSettlement])
    if (first.kind === 'request-rejected' || first.kind === 'request-error') {
      const terminalKind = input.readTerminalKind()
      if (terminalKind) return { kind: 'terminal', terminalKind }
      const delayedTerminal = await Promise.race([terminalSettlement, timeoutSettlement])
      return delayedTerminal.kind === 'terminal' ? delayedTerminal : first
    }
    return first
  } finally {
    timers.dispose()
  }
}
