import type { NodeExecutionOutput } from '@velaros-ai/velaros'
import type { ActTurnTrace } from '@velaros-ai/velaros/contracts'
import { toNullable } from '@velaros-ai/velaros/core'
import { type TimerLease, TimerScope } from '@velaros-ai/velaros/core/utils/TimerScope'

import {
  ConversationCommandOutputMaxChars,
  type ConversationCommandOutputProjection,
} from '../../shared/workbenchConversation'

/** 一段执行此刻在跑的那次调用，和它吐出的末尾一段。 */
interface RunningOutput {
  invocationId: string
  text: string
  /** 有还没发出去的新输出。 */
  dirty: boolean
  /** 发到哪张脚本卡；执行还没从追踪里对上卡时为 null。 */
  card: Nullable<string>
}

/**
 * 脚本卡上的运行中输出：Node 执行进程跑着时吐出的输出，按所在执行对到脚本卡，攒一小会儿再发。
 * 每段执行只留正在跑的那次调用的末尾一段（去掉终端控制序列，回车覆盖的只留最后一版）；换了一次调用就从头记。
 * 执行还没从回合追踪里对上卡时先攒着，对上了再发；调用有了结果、运行收尾时发空串清掉。
 */
export class ConversationCommandOutputBoard {
  /** 攒多少毫秒发一次。 */
  private static readonly FlushMs = 200
  /** 终端控制序列：CSI、OSC、选字符集与其余两字节的 ESC 序列。 */
  private static readonly ControlSequence =
    // eslint-disable-next-line no-control-regex -- 要去掉的就是终端控制字符（ESC、BEL）开头的序列
    /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()#][0-9A-Za-z]|\u001b[0-~]/gu

  private readonly executions = new Map<string, RunningOutput>()
  private readonly timers = new TimerScope({ name: 'ConversationCommandOutput' })
  private flushLease?: TimerLease
  private closed = false

  public constructor(
    private readonly emit: (projection: ConversationCommandOutputProjection) => void,
    private readonly cardOf: (executionId: string) => Nullable<string>
  ) {}

  /** 一次调用刚吐出的一段。 */
  public write({ executionId, invocationId, text }: NodeExecutionOutput): void {
    if (this.closed) return
    const current = this.executions.get(executionId)
    const previous = current?.invocationId === invocationId ? current.text : ''
    this.executions.set(executionId, {
      invocationId,
      text: (previous + text).slice(-ConversationCommandOutputMaxChars * 2),
      dirty: true,
      card: toNullable(current?.card),
    })
    this.flushLease ??= this.timers.after(ConversationCommandOutputBoard.FlushMs, () =>
      this.flush()
    )
  }

  /** 读到回合追踪：有了结果的调用不再是在跑的输出，清掉；刚对上卡的执行把攒着的发出去。 */
  public settle(trace: ActTurnTrace): void {
    for (const invocation of trace.invocations) {
      const current = this.executions.get(invocation.executionId)
      if (current?.invocationId !== invocation.id || invocation.summary.status === 'pending')
        continue
      this.clear(invocation.executionId, current)
    }
    this.flush()
  }

  /** 运行收尾：还挂着的输出全部清掉，之后再来的不收。 */
  public close(): void {
    if (this.closed) return
    this.closed = true
    for (const [executionId, current] of this.executions) this.clear(executionId, current)
    this.timers.dispose()
  }

  private flush(): void {
    this.flushLease?.cancel()
    this.flushLease = undefined
    for (const [executionId, current] of this.executions) {
      if (!current.dirty) continue
      const card = current.card ?? this.cardOf(executionId)
      if (!card) continue
      current.card = card
      current.dirty = false
      this.emit({ id: card, text: ConversationCommandOutputBoard.plain(current.text) })
    }
  }

  private clear(executionId: string, current: RunningOutput): void {
    this.executions.delete(executionId)
    if (current.card) this.emit({ id: current.card, text: '' })
  }

  /** 整成纯文本：去掉控制序列；一行里回车回到行首、后写的盖住先写的，退格往回退一格；只留末尾一段。 */
  private static plain(text: string): string {
    const lines = text
      .replace(ConversationCommandOutputBoard.ControlSequence, '')
      .split('\n')
      .map((line) => {
        const cells: string[] = []
        let column = 0
        for (const char of line) {
          if (char === '\r') column = 0
          else if (char === '\b') column = Math.max(0, column - 1)
          else if (char >= ' ' || char === '\t') {
            cells[column] = char
            column += 1
          }
        }
        return cells.join('')
      })
    return lines.join('\n').slice(-ConversationCommandOutputMaxChars)
  }
}
