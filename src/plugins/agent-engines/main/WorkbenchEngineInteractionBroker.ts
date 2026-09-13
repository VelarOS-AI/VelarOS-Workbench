import type { ExecutionEventBus } from '@velaros-ai/agent'
import { isNonBlankString, optionalWhen } from '@velaros-ai/core'

export interface WorkbenchAgentEngineQuestion {
  id: string
  header: string
  question: string
  options: ReadonlyArray<{
    label: string
    description?: string
  }>
  multiple?: boolean
}

interface PendingInput {
  questions: readonly WorkbenchAgentEngineQuestion[]
  resolve: (answers: Record<string, string[]>) => void
  reject: (error: Error) => void
}

interface PendingConfirmation {
  resolve: (decision: { approved: boolean; message?: string }) => void
  reject: (error: Error) => void
}

/**
 * 外部 Agent 与 Workbench 会话界面之间的等待输入桥。
 *
 * 协议与状态事件复用 Platform 的 `awaiting-input`，但等待中的 Promise 与实际回答属于
 * Electron 宿主进程：引擎不直接碰 renderer，也不会在终端里阻塞读 stdin。
 */
export class WorkbenchEngineInteractionBroker {
  private readonly pendingBySession = new Map<string, PendingInput>()
  private readonly confirmationsBySession = new Map<string, PendingConfirmation>()

  public requestInput(input: {
    sessionId: string
    executionId: string
    questions: readonly WorkbenchAgentEngineQuestion[]
    events: ExecutionEventBus
    signal: AbortSignal
  }): Promise<Record<string, string[]>> {
    if (input.questions.length === 0) return Promise.resolve({})
    if (this.pendingBySession.has(input.sessionId)) return Promise.reject(new Error('这个会话已有一个问题正在等待回答。'))

    input.events.emitRuntime({
      kind: 'awaiting-input',
      executionId: input.executionId,
      question: formatQuestions(input.questions),
    })

    return new Promise((resolve, reject) => {
      const abort = (): void => {
        this.pendingBySession.delete(input.sessionId)
        reject(new Error('用户已停止本次执行。'))
      }
      input.signal.addEventListener('abort', abort, { once: true })
      this.pendingBySession.set(input.sessionId, {
        questions: input.questions,
        resolve: (answers) => {
          input.signal.removeEventListener('abort', abort)
          resolve(answers)
        },
        reject: (error) => {
          input.signal.removeEventListener('abort', abort)
          reject(error)
        },
      })
    })
  }

  public resolveInput(sessionId: string, answer: string): boolean {
    const pending = this.pendingBySession.get(sessionId)
    if (!pending) return false
    this.pendingBySession.delete(sessionId)
    pending.resolve(parseAnswers(pending.questions, answer))
    return true
  }

  public requestConfirmation(input: {
    sessionId: string
    executionId: string
    message: string
    categoryId: string
    categoryLabel: string
    toolName: string
    events: ExecutionEventBus
    signal: AbortSignal
  }): Promise<{ approved: boolean; message?: string }> {
    if (this.confirmationsBySession.has(input.sessionId)) return Promise.reject(new Error('这个会话已有一个操作正在等待确认。'))
    input.events.emitRuntime({
      kind: 'awaiting-confirmation',
      executionId: input.executionId,
      confirmationMessage: input.message,
      confirmationDetail: {
        kind: 'tool-category-authorization',
        categoryId: input.categoryId,
        categoryLabel: input.categoryLabel,
        toolName: input.toolName,
      },
    })
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        this.confirmationsBySession.delete(input.sessionId)
        reject(new Error('用户已停止本次执行。'))
      }
      input.signal.addEventListener('abort', abort, { once: true })
      this.confirmationsBySession.set(input.sessionId, {
        resolve: (decision) => {
          input.signal.removeEventListener('abort', abort)
          resolve(decision)
        },
        reject: (error) => {
          input.signal.removeEventListener('abort', abort)
          reject(error)
        },
      })
    })
  }

  public resolveConfirmation(
    sessionId: string,
    approved: boolean,
    rejectionMessage?: string
  ): boolean {
    const pending = this.confirmationsBySession.get(sessionId)
    if (!pending) return false
    this.confirmationsBySession.delete(sessionId)
    pending.resolve({
      approved,
      message: optionalWhen(isNonBlankString, rejectionMessage)?.trim(),
    })
    return true
  }

  public cancelSession(sessionId: string, message = '会话已停止。'): void {
    const pending = this.pendingBySession.get(sessionId)
    if (pending) {
      this.pendingBySession.delete(sessionId)
      pending.reject(new Error(message))
    }
    const confirmation = this.confirmationsBySession.get(sessionId)
    if (confirmation) {
      this.confirmationsBySession.delete(sessionId)
      confirmation.reject(new Error(message))
    }
  }

  public dispose(): void {
    for (const pending of this.pendingBySession.values()) {
      pending.reject(new Error('Workbench 正在退出。'))
    }
    this.pendingBySession.clear()
    for (const pending of this.confirmationsBySession.values()) {
      pending.reject(new Error('Workbench 正在退出。'))
    }
    this.confirmationsBySession.clear()
  }
}

function formatQuestions(questions: readonly WorkbenchAgentEngineQuestion[]): string {
  return questions.map((question, index) => {
    const options = question.options.map((option, optionIndex) => {
      const suffix = option.description ? `：${option.description}` : ''
      return `${String.fromCharCode(65 + optionIndex)}. ${option.label}${suffix}`
    })
    return [
      questions.length > 1 ? `${index + 1}. ${question.question}` : question.question,
      ...options,
    ].join('\n')
  }).join('\n\n')
}

function parseAnswers(
  questions: readonly WorkbenchAgentEngineQuestion[],
  rawAnswer: string
): Record<string, string[]> {
  const answer = rawAnswer.trim()
  if (questions.length === 1) return {
    [questions[0]!.id]: resolveOptionAnswers(questions[0]!, splitAnswer(answer)),
  }

  const byId = new Map<string, string>()
  const positional: string[] = []
  for (const line of answer.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean)) {
    const separator = line.indexOf('=')
    if (separator > 0) byId.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
    else positional.push(line.replace(/^\d+[.)]\s*/u, ''))
  }
  return Object.fromEntries(questions.map((question, index) => [
    question.id,
    resolveOptionAnswers(
      question,
      splitAnswer(byId.get(question.id) ?? positional[index] ?? answer)
    ),
  ]))
}

function resolveOptionAnswers(
  question: WorkbenchAgentEngineQuestion,
  answers: string[]
): string[] {
  return answers.map((answer) => {
    const optionIndex = /^[A-Z]$/iu.test(answer) ? answer.toUpperCase().charCodeAt(0) - 65 : -1
    return question.options[optionIndex]?.label ?? answer
  })
}

function splitAnswer(answer: string): string[] {
  const values = answer.split(/[,，]/u).map((item) => item.trim()).filter(Boolean)
  return values.length > 0 ? values : ['']
}
