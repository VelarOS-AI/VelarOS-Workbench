import { asRecord } from './standaloneWorkbenchChatRuntime'

/**
 * 运行中的「本轮改动」实时采集：一轮跑着的时候，项目写工具的结果一到就（防抖后）重新采一次，
 * 「AI 改动」面板跟着实时刷新；收尾时停下，交给最终采集覆盖同一条记录。
 *
 * 触发只看本轮事件流里的工具事件——主 Agent 的，以及子 Agent 线程转出来的（编辑类子 Agent 也写盘）——
 * 不轮询、不监听文件系统。用户自己在编辑器里的改动不触发实时采集，收尾那一次照样会带上。
 *
 * 一轮一个实例（一个会话同一时刻只有一轮在跑），在途的采集至多一次：采集期间又有写入就记一笔，
 * 这次回来后再防抖一次。收尾（`finish`）之后挂着的采集作废、晚到的结果不再交出——主进程按会话把
 * 这一轮的全部采集排队写盘，最终采集一定最后落地。
 */

/** 可能改动项目文件的工具：它们的结果一到，本轮改动就可能变了。 */
const WorkspaceWritingToolNames: ReadonlySet<string> = new Set([
  'project:edit',
  'project:write',
  'project:rollback',
  'project:run',
])

/** 连续写入之间停顿这么久才采一次：一串编辑只采最后那一下。 */
export const StandaloneRunChangeCaptureDebounceMs = 800

export interface StandaloneRunChangeCapture {
  /** 本轮事件流里的一条 agent 事件（不是工具事件的直接忽略）。 */
  observe: (event: Record<string, unknown>) => void
  /** 这一轮收尾：取消挂着的采集，之后回来的结果一律不交出。 */
  finish: () => void
}

type ToolEvent =
  | { readonly phase: 'start'; readonly toolCallId: string; readonly toolName: string }
  | { readonly phase: 'done'; readonly toolCallId: string }

/** 主 Agent 的工具事件，或 `worker-thread` 事件里子 Agent 的工具事件（同一形状包在 chatEvent 里）。 */
function readToolEvent(event: Record<string, unknown>): ToolEvent | null {
  const source = event.type === 'worker-thread' ? asRecord(asRecord(event.payload).chatEvent) : event
  const { toolCallId, toolName } = source
  if (typeof toolCallId !== 'string') return null
  if (source.type === 'tool-start' && typeof toolName === 'string')
    return { phase: 'start', toolCallId, toolName }
  return source.type === 'tool-done' ? { phase: 'done', toolCallId } : null
}

export function createStandaloneRunChangeCapture<T>(options: {
  debounceMs: number
  /** 采一次；失败时为 null（下一次写入再试）。不 reject。 */
  capture: () => Promise<T | null>
  /** 运行中采到的结果（收尾之后才回来的不再交出）。 */
  onCaptured: (result: T) => void
}): StandaloneRunChangeCapture {
  const writingToolCalls = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let capturing = false
  let changedWhileCapturing = false
  let finished = false

  const schedule = (): void => {
    if (finished) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(run, options.debounceMs)
  }

  function run(): void {
    timer = null
    if (capturing) {
      changedWhileCapturing = true
      return
    }
    capturing = true
    void options.capture().then((result) => {
      capturing = false
      if (finished) return
      if (result !== null) options.onCaptured(result)
      if (changedWhileCapturing) {
        changedWhileCapturing = false
        schedule()
      }
    })
  }

  return {
    observe: (event) => {
      const tool = readToolEvent(event)
      if (!tool) return
      if (tool.phase === 'start') {
        if (WorkspaceWritingToolNames.has(tool.toolName)) writingToolCalls.add(tool.toolCallId)
        return
      }
      if (writingToolCalls.delete(tool.toolCallId)) schedule()
    },
    finish: () => {
      finished = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
