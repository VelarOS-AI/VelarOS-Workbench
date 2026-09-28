/**
 * 终端输出总线：主进程送来的伪终端数据按会话直接交给 xterm，不经 React 状态——每个输出片段都走一遍
 * setState、让整个面板连同所有行重渲染，正是旧终端「反应迟钝」的原因之一。
 *
 * 视图还没挂上（面板折叠、标签在后台、会话刚建）时先攒着（有上限），视图一挂上整段回放，之后逐段直送。
 * 会话被关掉时通知视图层释放它的 xterm 实例。
 *
 * 流控：每段输出处理完（xterm 写完，或视图没挂上、攒进了缓冲）都要确认给主进程，主进程据此暂停或继续读伪终端。
 * 确认分批发：攒够一批或隔一小会儿发一次。
 */
const MaxBufferedChars = 512 * 1024
const AcknowledgeBatchChars = 5_000
const AcknowledgeFlushDelayMs = 20

/** 视图消费一段输出：`done` 在这段写进 xterm 之后调用（回放攒下的输出时不必再确认）。 */
type WorkbenchTerminalOutputListener = (chunk: string, done: () => void) => void

interface WorkbenchTerminalOutputChannel {
  listener: Nullable<WorkbenchTerminalOutputListener>
  buffered: string[]
  bufferedChars: number
}

const channels = new Map<string, WorkbenchTerminalOutputChannel>()
const discardListeners = new Set<(sessionId: string) => void>()
let acknowledger: Nullable<(sessionId: string, chars: number) => void> = null
const pendingAcknowledgements = new Map<string, number>()
let acknowledgeTimer: Nullable<ReturnType<typeof setTimeout>> = null

/** 装上把确认发给主进程的办法（订阅终端输出的那一层装）；null 表示不再发。 */
export function setWorkbenchTerminalOutputAcknowledger(
  next: Nullable<(sessionId: string, chars: number) => void>
): void {
  acknowledger = next
  if (!next) pendingAcknowledgements.clear()
}

function acknowledge(sessionId: string, chars: number): void {
  if (!acknowledger || chars <= 0) return
  const pending = (pendingAcknowledgements.get(sessionId) ?? 0) + chars
  if (pending >= AcknowledgeBatchChars) {
    pendingAcknowledgements.delete(sessionId)
    acknowledger(sessionId, pending)
    return
  }
  pendingAcknowledgements.set(sessionId, pending)
  acknowledgeTimer ??= setTimeout(flushAcknowledgements, AcknowledgeFlushDelayMs)
}

function flushAcknowledgements(): void {
  acknowledgeTimer = null
  for (const [sessionId, chars] of pendingAcknowledgements) acknowledger?.(sessionId, chars)
  pendingAcknowledgements.clear()
}

function channelFor(sessionId: string): WorkbenchTerminalOutputChannel {
  let channel = channels.get(sessionId)
  if (!channel) {
    channel = { listener: null, buffered: [], bufferedChars: 0 }
    channels.set(sessionId, channel)
  }
  return channel
}

export function publishWorkbenchTerminalOutput(sessionId: string, chunk: string): void {
  if (!chunk) return
  const channel = channelFor(sessionId)
  if (channel.listener) {
    channel.listener(chunk, () => acknowledge(sessionId, chunk.length))
    return
  }
  // 视图还没挂上：攒下（超出上限丢最早的），并且马上确认，后台运行的程序不会因为没人看而被暂停。
  acknowledge(sessionId, chunk.length)
  channel.buffered.push(chunk)
  channel.bufferedChars += chunk.length
  while (channel.bufferedChars > MaxBufferedChars && channel.buffered.length > 1) {
    channel.bufferedChars -= channel.buffered.shift()!.length
  }
}

/** 挂上消费者（每个会话同时只有一个：它的 xterm）；之前攒下的输出先整段回放。 */
export function attachWorkbenchTerminalOutput(
  sessionId: string,
  listener: WorkbenchTerminalOutputListener
): () => void {
  const channel = channelFor(sessionId)
  channel.listener = listener
  if (channel.buffered.length > 0) {
    const replay = channel.buffered.join('')
    channel.buffered = []
    channel.bufferedChars = 0
    listener(replay, () => undefined)
  }
  return () => {
    if (channel.listener === listener) channel.listener = null
  }
}

/** 会话从界面上关掉：丢掉攒着的输出，并让视图层释放它的 xterm 实例。 */
export function discardWorkbenchTerminalOutput(sessionId: string): void {
  channels.delete(sessionId)
  pendingAcknowledgements.delete(sessionId)
  for (const listener of [...discardListeners]) listener(sessionId)
}

export function onWorkbenchTerminalOutputDiscarded(
  listener: (sessionId: string) => void
): () => void {
  discardListeners.add(listener)
  return () => {
    discardListeners.delete(listener)
  }
}

/** 攒着还没被消费的字符数（测试用）。 */
export function readWorkbenchTerminalOutputBacklog(sessionId: string): number {
  return channels.get(sessionId)?.bufferedChars ?? 0
}
