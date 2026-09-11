/**
 * 聊天历史的**合并写**（用法见 standaloneWorkbenchChatAdapter 的 persistState）。
 *
 * 状态每变一次只登记「这个 key 要写」，一个窗口期内同一 key 只写一次；真正写之前按落盘字段的
 * 身份与上次写入比，逐项相同就跳过。流式输出按 token 频率改状态，写入却要把整个项目的历史
 * 序列化进 localStorage 与磁盘备份——两者的频率必须拆开。
 *
 * 独立成模块是为了能脱离 window / localStorage 单测：计时器可注入。
 */
export interface CoalescedChatPersistence<Target> {
  /** 登记一次写；`immediate` 时连同其它待写的一起立刻写（结构性变化：新建、切换、归档会话）。 */
  schedule: (key: string, target: Target, options?: { immediate?: boolean }) => void
  /** 立刻写完所有待写的（一轮收尾、窗口隐藏或关闭）。 */
  flush: () => void
}

export function createCoalescedChatPersistence<Target>(options: {
  delayMs: number
  /** 落盘字段的身份列表：状态按不可变方式更新，字段没换引用就是没变。 */
  readSignature: (target: Target) => readonly unknown[]
  write: (key: string, target: Target) => void
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
}): CoalescedChatPersistence<Target> {
  const pending = new Map<string, Target>()
  const lastSignatures = new Map<string, readonly unknown[]>()
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let timer: unknown = null

  const flush = (): void => {
    if (timer !== null) clearTimer(timer)
    timer = null
    const targets = [...pending]
    pending.clear()
    for (const [key, target] of targets) {
      const signature = options.readSignature(target)
      const previous = lastSignatures.get(key)
      if (previous && isSameIdentityList(previous, signature)) continue
      lastSignatures.set(key, signature)
      options.write(key, target)
    }
  }

  return {
    schedule: (key, target, scheduleOptions) => {
      pending.set(key, target)
      if (scheduleOptions?.immediate) {
        flush()
        return
      }
      timer ??= setTimer(flush, options.delayMs)
    },
    flush,
  }
}

/** 两份身份列表逐项 `Object.is` 相同。 */
export function isSameIdentityList(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
}
