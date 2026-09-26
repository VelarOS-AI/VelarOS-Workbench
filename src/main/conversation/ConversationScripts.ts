import { isNull } from '@velaros-ai/core'
import type {
  ActExecutionFailure,
  ActExecutionSummary,
  ActInvocationSummary,
  ActTurnTrace,
} from '@velaros-ai/velaros/contracts'

import {
  type ConversationScriptKind,
  type ConversationScriptProjection,
  ConversationScriptSourceMaxChars,
} from '../../shared/workbenchConversation'

import type { ConversationSessionEvent } from './WorkbenchConversationTypes'

type ProgramEvent = Extract<ConversationSessionEvent, { type: 'program' }>

interface ScriptCard {
  projection: ConversationScriptProjection
  /** program 事件逐字累积的源码。 */
  body: string
  /** 上次发出的内容指纹，内容不变不重复发。 */
  delivered: string
}

/**
 * 一次运行里脚本卡的账。program 事件在模型写 execute 或 observe 声明时建卡、收源码。execute 卡由回合追踪的
 * 执行摘要按「本回合第几段 execute」对上，补上状态、调用与失败原因；observe 卡由追踪的观察摘要补上：登记的
 * 那一回合给出登记结果，之后每个回合给出喂进那一帧的观察运行，卡上换成最近一次运行的调用与结局。协议没通过
 * 的回合撤掉它写的卡；运行收尾时仍没有结局的卡不会再有消息，按取消收掉。每张卡只在内容变化时发出。
 */
export class ConversationScriptBoard {
  private readonly cards = new Map<string, ScriptCard>()
  /** 每个回合按出现顺序排的 execute 卡片 id，第 n 张对应这一回合执行摘要的 position n。 */
  private readonly turns = new Map<string, string[]>()
  /** 每个回合的 observe 卡片 id：一份响应最多登记一次观察。 */
  private readonly observations = new Map<string, string>()
  /** 登记上的最近一张观察卡：之后回合的观察运行都记在它上面；这次运行里还没登记过时没有。 */
  private watching?: string
  /**
   * 每个回合的观察运行记在哪张卡上：第一次读到这一回合时定下。同一回合的追踪会重读（执行期间定时重读、
   * 下一回合开始时、收尾时），那时 watching 可能已换成这一回合新登记的卡，运行结果不能跟着记过去。
   */
  private readonly runTargets = new Map<string, string | undefined>()
  /** 每段执行对应的卡片：子 Agent 线程挂在派发它的那张卡后面。 */
  private readonly executionCards = new Map<string, string>()

  public constructor(private readonly emit: (projection: ConversationScriptProjection) => void) {}

  /** start 建卡（编写中）；delta 只累积不发；end 转为执行中并带上完整源码。 */
  public program(turnId: string, event: ProgramEvent): void {
    if (event.kind !== 'execute' && event.kind !== 'observe') return
    const id = `conversation:script:${event.runId}:${turnId}:${event.index}`
    if (event.phase === 'start') {
      if (event.kind === 'execute') this.turns.set(turnId, [...(this.turns.get(turnId) ?? []), id])
      else this.observations.set(turnId, id)
      this.open(id, event.kind, event.runId, turnId, 'writing')
      this.publish(id)
      return
    }
    const card = this.cards.get(id)
    if (!card) return
    if (event.phase === 'delta') {
      card.body += event.text
      return
    }
    this.update(id, { status: 'running', ...clipSource(card.body) })
  }

  /** 回合的执行摘要按顺序对上这一回合的卡；程序事件没建出卡的，按摘要补一张，之后的追踪沿用它。 */
  public trace(trace: ActTurnTrace): void {
    for (const execution of trace.executions) {
      const adopted = `conversation:script:${trace.runId}:${trace.turnId}:${execution.executionId}`
      const id =
        this.turns.get(trace.turnId)?.[execution.position] ??
        (this.cards.has(adopted)
          ? adopted
          : this.open(adopted, 'execute', trace.runId, trace.turnId, 'running'))
      const card = this.cards.get(id)!
      this.executionCards.set(execution.executionId, id)
      const calls = trace.invocations
        .filter((invocation) => invocation.executionId === execution.executionId)
        .map((invocation) => invocation.summary)
      this.update(id, {
        status: settledStatus(execution, calls),
        calls,
        error: describeFailure(execution.failure),
        durationMs: execution.durationMs,
        ...clipSource(card.body || execution.source),
      })
    }
    this.observe(trace)
  }

  /** 这段执行的卡片；还没从追踪里对上时为 null。 */
  public cardOf(executionId: string): Nullable<string> {
    return this.executionCards.get(executionId) ?? null
  }

  /** 协议没通过的回合一段程序都没执行：撤掉它写的卡，修复后的回合会重新写。 */
  public reject(turnId: string): void {
    for (const id of this.turns.get(turnId) ?? []) this.update(id, { status: 'discarded' })
    const observed = this.observations.get(turnId)
    if (observed) this.update(observed, { status: 'discarded' })
    this.turns.delete(turnId)
    this.observations.delete(turnId)
  }

  /** 运行结束：还在编写或执行中的卡不会再有结果，按取消收尾。 */
  public settle(): void {
    for (const [id, card] of this.cards)
      if (card.projection.status === 'writing' || card.projection.status === 'running')
        this.update(id, { status: 'cancelled' })
  }

  /**
   * 观察摘要：喂进这一帧的运行发生在这一回合响应之前，记到第一次读到这一回合时登记上的那张卡；再处理这一
   * 回合的登记，登记上了之后的运行就归新卡。登记被拒的卡标成失败，原来那张照常接着收运行结果。
   */
  private observe(trace: ActTurnTrace): void {
    const { registration, run } = trace.observation
    if (!this.runTargets.has(trace.turnId)) this.runTargets.set(trace.turnId, this.watching)
    const target = this.runTargets.get(trace.turnId)
    if (run && target) {
      const calls = trace.invocations
        .filter((invocation) => invocation.executionId === run.executionId)
        .map((invocation) => invocation.summary)
      this.update(target, {
        status: settledStatus(run, calls),
        calls,
        error: describeFailure(run.failure),
        durationMs: run.durationMs,
      })
    }
    if (!registration) return
    const adopted = `conversation:script:${trace.runId}:${trace.turnId}:observe`
    const id =
      this.observations.get(trace.turnId) ??
      (this.cards.has(adopted)
        ? adopted
        : this.open(adopted, 'observe', trace.runId, trace.turnId, 'running'))
    this.observations.set(trace.turnId, id)
    const card = this.cards.get(id)!
    const rejected = registration.status === 'rejected'
    // 同一回合的追踪会读不止一次：卡已经收过运行结果时，登记结果不把它盖回去
    if (card.projection.status === 'writing' || card.projection.status === 'running' || rejected)
      this.update(id, {
        status: rejected ? 'failed' : 'succeeded',
        error: describeFailure(registration.failure),
        ...clipSource(card.body || registration.source),
      })
    if (rejected) return
    this.watching = registration.status === 'cleared' ? undefined : id
  }

  /** 登记一张空卡；由调用方在内容就绪后发出。 */
  private open(
    id: string,
    kind: ConversationScriptKind,
    runId: string,
    turnId: string,
    status: 'writing' | 'running'
  ): string {
    this.cards.set(id, {
      projection: {
        id,
        kind,
        runId,
        turnId,
        status,
        source: '',
        sourceTruncated: false,
        calls: [],
        error: null,
        durationMs: null,
      },
      body: '',
      delivered: '',
    })
    return id
  }

  private update(id: string, patch: Partial<ConversationScriptProjection>): void {
    const card = this.cards.get(id)
    if (!card) return
    card.projection = { ...card.projection, ...patch }
    this.publish(id)
  }

  private publish(id: string): void {
    const card = this.cards.get(id)!
    const fingerprint = JSON.stringify(card.projection)
    if (fingerprint === card.delivered) return
    card.delivered = fingerprint
    this.emit(card.projection)
  }
}

function clipSource(
  text: string
): Pick<ConversationScriptProjection, 'source' | 'sourceTruncated'> {
  return {
    source: text.slice(0, ConversationScriptSourceMaxChars),
    sourceTruncated: text.length > ConversationScriptSourceMaxChars,
  }
}

/** 能力调用失败时脚本运行时给模型附上的「（调用 …，效果 …）」；卡片展开后逐次调用都有，原因行不重复。 */
const CallSuffix = /（调用 [^，）]+，效果 [a-z]+）$/u

/** 卡片上的一句原因：失败带出错行。 */
function describeFailure(failure: Nullable<ActExecutionFailure>): Nullable<string> {
  if (!failure) return null
  const message = failure.message.replace(CallSuffix, '')
  return isNull(failure.line) ? message : `第 ${failure.line} 行：${message}`
}

/**
 * 卡片的结局。外部效果未知是运行时和模型之间要核对的事，不在卡上说，只按这一步自己做到了哪儿算：
 * 脚本出错或有调用失败算失败，有调用被取消或没落定算取消，都好好做完了算成功。
 */
function settledStatus(
  summary: Pick<ActExecutionSummary, 'status' | 'failure'>,
  calls: readonly ActInvocationSummary[]
): Exclude<ActExecutionSummary['status'], 'unknown'> {
  if (summary.status !== 'unknown') return summary.status
  if (summary.failure || calls.some((call) => call.status === 'failed')) return 'failed'
  if (calls.some((call) => call.status === 'cancelled' || call.status === 'pending'))
    return 'cancelled'
  return 'succeeded'
}
