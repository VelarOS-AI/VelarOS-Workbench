/**
 * 终端输出总线：主进程送来的伪终端数据按会话直接交给 xterm，不经 React 状态——每个输出片段都走一遍
 * setState、让整个面板连同所有行重渲染，正是旧终端「反应迟钝」的原因之一。
 *
 * 视图还没挂上（面板折叠、标签在后台、会话刚建）时先攒着（有上限），视图一挂上整段回放，之后逐段直送。
 * 会话被关掉时通知视图层释放它的 xterm 实例。
 */
const MaxBufferedChars = 512 * 1024

interface WorkbenchTerminalOutputChannel {
  listener: Nullable<(chunk: string) => void>
  buffered: string[]
  bufferedChars: number
}

const channels = new Map<string, WorkbenchTerminalOutputChannel>()
const discardListeners = new Set<(sessionId: string) => void>()

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
    channel.listener(chunk)
    return
  }
  channel.buffered.push(chunk)
  channel.bufferedChars += chunk.length
  while (channel.bufferedChars > MaxBufferedChars && channel.buffered.length > 1) {
    channel.bufferedChars -= channel.buffered.shift()!.length
  }
}

/** 挂上消费者（每个会话同时只有一个：它的 xterm）；之前攒下的输出先整段回放。 */
export function attachWorkbenchTerminalOutput(
  sessionId: string,
  listener: (chunk: string) => void
): () => void {
  const channel = channelFor(sessionId)
  channel.listener = listener
  if (channel.buffered.length > 0) {
    const replay = channel.buffered.join('')
    channel.buffered = []
    channel.bufferedChars = 0
    listener(replay)
  }
  return () => {
    if (channel.listener === listener) channel.listener = null
  }
}

/** 会话从界面上关掉：丢掉攒着的输出，并让视图层释放它的 xterm 实例。 */
export function discardWorkbenchTerminalOutput(sessionId: string): void {
  channels.delete(sessionId)
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
