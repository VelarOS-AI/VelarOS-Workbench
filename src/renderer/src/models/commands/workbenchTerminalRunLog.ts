/**
 * 运行卡的文本日志：`workbench:read_run` 读它、`start_run` 的 waitFor 等它，所以运行卡的输出除了进 xterm，
 * 还要落进 React 状态。按小周期合并再落，不逐片段重渲染。
 */
export interface WorkbenchTerminalRunLog {
  append(sessionId: string, chunk: string): void
  /** 立刻把攒着的都落下去（收口事件之前调用，保证顺序）。 */
  flush(): void
  dispose(): void
}

export function createWorkbenchTerminalRunLog({
  flushDelayMs,
  onFlush,
}: {
  flushDelayMs: number
  onFlush: (chunksBySession: ReadonlyMap<string, string>) => void
}): WorkbenchTerminalRunLog {
  const pending = new Map<string, string>()
  let timer: Nullable<ReturnType<typeof setTimeout>> = null

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (pending.size === 0) return
    const batch = new Map(pending)
    pending.clear()
    onFlush(batch)
  }

  return {
    append: (sessionId, chunk) => {
      if (!chunk) return
      pending.set(sessionId, (pending.get(sessionId) ?? '') + chunk)
      if (!timer) timer = setTimeout(flush, flushDelayMs)
    },
    flush,
    dispose: () => {
      if (timer) clearTimeout(timer)
      timer = null
      pending.clear()
    },
  }
}
