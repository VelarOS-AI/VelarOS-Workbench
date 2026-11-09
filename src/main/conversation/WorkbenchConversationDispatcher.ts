import { resolve } from 'node:path'

import { Log } from '@velaros-ai/velaros/core'
import { AppError, createAbortError } from '@velaros-ai/velaros/core/error'

import type {
  WorkbenchAgentEngineStatus,
  WorkbenchConversationCancelResult,
} from '../../shared/workbenchConversation'
import type { WorkbenchEngineConversationRuntime } from '../engines/WorkbenchEngineConversationRuntime'
import { workbenchMainText } from '../i18n/workbenchMainMessages'

import type { WorkbenchConversationRecovery } from './WorkbenchConversationRecovery'
import type {
  WorkbenchConversationRef,
  WorkbenchConversationRuntimeApi,
  WorkbenchConversationSink,
} from './WorkbenchConversationRuntime'

export interface WorkbenchPreparedConversation {
  sink: WorkbenchConversationSink
  finish(result: { started: boolean; reason?: unknown }): Promise<void>
}

/** IPC 的真实 UI/持久流准备：准备后仍由同一提交持有，结束前等全部写盘回执。 */
export type WorkbenchConversationPreparation = (
  signal: AbortSignal
) => Promise<WorkbenchPreparedConversation>

/** 主聊天的控制面，外加外部引擎在本机的情况。 */
export interface WorkbenchConversationDispatcherApi extends WorkbenchConversationRuntimeApi {
  submit(
    sink: WorkbenchConversationSink | WorkbenchConversationPreparation,
    request: Parameters<WorkbenchConversationRuntimeApi['submit']>[1],
    preparationSignal?: AbortSignal
  ): ReturnType<WorkbenchConversationRuntimeApi['submit']>
  engines(refresh: boolean): Promise<WorkbenchAgentEngineStatus[]>
}

interface Submission {
  ref: WorkbenchConversationRef
  controller: AbortController
  backend?: Pick<WorkbenchConversationRuntimeApi, 'cancel'>
  stopping?: Promise<WorkbenchConversationCancelResult>
  completed: Promise<void>
  /** 执行失败由原运行交付；准备/持久流收束失败仍须向取消、删除和关闭交付。 */
  lifecycleFailures: unknown[]
}

const log = Log.tag('WorkbenchConversationDispatcher')

/**
 * 两个执行后端共用产品会话的准入：先登记提交，再准备持久流；删除等准备、执行和写盘全部收束后才开闸。
 * 同一删除共享回执，关闭也等这些产品资源，不只看后端已经接到的运行。
 */
export function createWorkbenchConversationDispatcher(
  platform: WorkbenchConversationRuntimeApi,
  engines: WorkbenchEngineConversationRuntime,
  recovery: Pick<WorkbenchConversationRecovery, 'remove'>
): WorkbenchConversationDispatcherApi {
  const submissions = new Map<string, Submission>()
  const deletions = new Map<string, Promise<void>>()
  const projectCancellations = new Map<string, Promise<void>>()
  const settledListeners = new Set<(ref: WorkbenchConversationRef) => void>()
  let closing: Promise<void> | undefined

  const admit = (ref: WorkbenchConversationRef): void => {
    if (closing || deletions.has(key(ref)) || projectCancellations.has(resolve(ref.projectRoot)))
      throw new AppError('VALIDATION', workbenchMainText('conversation.closing'))
  }
  const stop = (submission: Submission): void => {
    submission.controller.abort(createAbortError(workbenchMainText('conversation.runStopped')))
    if (submission.backend && !submission.stopping) {
      submission.stopping = Promise.resolve().then(() => submission.backend!.cancel(submission.ref))
      // close 可能先等待别的慢资源；拒绝先有人接收，join 仍交付原失败。
      void Promise.allSettled([submission.stopping])
    }
  }
  const join = async (entries: readonly Submission[]): Promise<unknown[]> => {
    const stops = await Promise.allSettled(entries.map((entry) => entry.stopping))
    // completed 可能因正常取消或执行失败拒绝；仍须等 finish 真正结束。
    await Promise.allSettled(entries.map((entry) => entry.completed))
    return [...rejections(stops), ...entries.flatMap((entry) => entry.lifecycleFailures)]
  }

  const dispatcher: WorkbenchConversationDispatcherApi = {
    isRunning: (ref) => submissions.has(key(ref)) || engines.has(ref) || platform.isRunning(ref),
    subscribeRunSettled: (listener) => {
      settledListeners.add(listener)
      return () => settledListeners.delete(listener)
    },
    subscribeRunOutcome: (listener) => platform.subscribeRunOutcome(listener),
    submit: (sink, request, preparationSignal) => {
      admit(request)
      const id = key(request)
      if (submissions.has(id))
        throw new AppError('VALIDATION', workbenchMainText('conversation.busy'))
      let accept!: () => void
      let reject!: (reason: unknown) => void
      const accepted = new Promise<void>((yes, no) => {
        accept = yes
        reject = no
      })
      const submission: Submission = {
        ref: { projectRoot: request.projectRoot, sessionId: request.sessionId },
        controller: new AbortController(),
        completed: Promise.resolve(),
        lifecycleFailures: [],
      }
      submissions.set(id, submission)
      const abortPreparation = (): void => submission.controller.abort(preparationSignal?.reason)
      preparationSignal?.addEventListener('abort', abortPreparation, { once: true })
      if (preparationSignal?.aborted) abortPreparation()
      const detachPreparation = (): void =>
        preparationSignal?.removeEventListener('abort', abortPreparation)
      submission.completed = Promise.resolve()
        .then(async () => {
          const signal = submission.controller.signal
          let prepared: WorkbenchPreparedConversation | undefined
          let started = false
          const failures: unknown[] = []
          try {
            signal.throwIfAborted()
            if (typeof sink === 'function') prepared = await sink(signal)
            signal.throwIfAborted()
            const backend = request.engine ? engines : platform
            const running = backend.submit(
              typeof sink === 'function' ? prepared!.sink : sink,
              request
            )
            submission.backend = backend
            started = true
            // 调用者只取消准备；同步交接给后端后，父会话取消不能杀掉已交出的对方运行。
            detachPreparation()
            void running.accepted.then(accept, reject)
            await running.completed
            await running.accepted
          } catch (error) {
            failures.push(error)
            if (!started && !signal.aborted) submission.lifecycleFailures.push(error)
            reject(error)
          } finally {
            detachPreparation()
            try {
              await prepared?.finish({ started, reason: failures[0] ?? signal.reason })
            } catch (error) {
              submission.lifecycleFailures.push(error)
              failures.push(error)
              reject(error)
            }
          }
          throwFailures(failures)
        })
        .finally(() => {
          if (submissions.get(id) === submission) submissions.delete(id)
          for (const listener of settledListeners) {
            try {
              listener(submission.ref)
            } catch (error) {
              log.warn('会话结束通知失败', { error })
            }
          }
        })
      void Promise.allSettled([accepted, submission.completed])
      return { accepted, completed: submission.completed }
    },
    cancel: async (ref) => {
      const submission = submissions.get(key(ref))
      if (!submission) return engines.has(ref) ? engines.cancel(ref) : platform.cancel(ref)
      stop(submission)
      throwFailures(await join([submission]))
      return submission.stopping ?? { aborted: true }
    },
    guidance: async (ref, input) => {
      admit(ref)
      if (engines.has(ref))
        throw new AppError(
          'VALIDATION',
          workbenchMainText('conversation.engineGuidanceUnsupported')
        )
      await platform.guidance(ref, input)
    },
    input: async (ref, answer) => {
      admit(ref)
      await (engines.has(ref) ? engines.input(ref, answer) : platform.input(ref, answer))
    },
    answer: async (ref, requestId, answer) => {
      admit(ref)
      await (engines.has(ref)
        ? engines.answer(ref, requestId, answer)
        : platform.answer(ref, requestId, answer))
    },
    listNotes: async (ref, input) => {
      admit(ref)
      return platform.listNotes(ref, input)
    },
    readNote: async (ref, input) => {
      admit(ref)
      return platform.readNote(ref, input)
    },
    subscribeNotesChanged: (listener) => platform.subscribeNotesChanged(listener),
    getGoal: async (ref) => {
      admit(ref)
      return platform.getGoal(ref)
    },
    controlGoal: async (ref, input) => {
      admit(ref)
      return platform.controlGoal(ref, input)
    },
    deleteSession: (ref) => {
      const id = key(ref)
      const existing = deletions.get(id)
      if (existing) return existing
      try {
        admit(ref)
      } catch (error) {
        return Promise.reject(error)
      }
      const submission = submissions.get(id)
      const deletion = Promise.resolve()
        .then(async () => {
          const failures = await join(submission ? [submission] : [])
          const results = await Promise.allSettled([
            Promise.resolve().then(() => engines.deleteSession(ref)),
            Promise.resolve().then(() => platform.deleteSession(ref)),
          ])
          failures.push(...rejections(results))
          try {
            await recovery.remove(ref)
          } catch (error) {
            failures.push(error)
          }
          throwFailures(failures)
        })
        .finally(() => {
          if (deletions.get(id) === deletion) deletions.delete(id)
        })
      deletions.set(id, deletion)
      if (submission) stop(submission)
      return deletion
    },
    cancelProject: (projectRoot) => {
      const root = resolve(projectRoot)
      const existing = projectCancellations.get(root)
      if (existing) return existing
      if (closing)
        return Promise.reject(new AppError('VALIDATION', workbenchMainText('conversation.closing')))
      const entries = [...submissions.values()].filter(
        (entry) => resolve(entry.ref.projectRoot) === root
      )
      const cancellation = Promise.resolve()
        .then(async () => {
          const deleting = [...deletions]
            .filter(([id]) => id.startsWith(`${root}\0`))
            .map(([, pending]) => pending)
          const results = await Promise.allSettled([
            ...deleting,
            Promise.resolve().then(() => engines.cancelProject(projectRoot)),
            Promise.resolve().then(() => platform.cancelProject(projectRoot)),
          ])
          throwFailures([...rejections(results), ...(await join(entries))])
        })
        .finally(() => {
          if (projectCancellations.get(root) === cancellation) projectCancellations.delete(root)
        })
      projectCancellations.set(root, cancellation)
      for (const entry of entries) stop(entry)
      return cancellation
    },
    close: () => {
      if (closing) return closing
      const entries = [...submissions.values()]
      closing = Promise.resolve().then(async () => {
        // 删除/项目关闭已负责这些提交的收束及错误，避免同一错误在 close 回执里重复登记。
        const unowned = entries.filter(
          (entry) =>
            !deletions.has(key(entry.ref)) &&
            !projectCancellations.has(resolve(entry.ref.projectRoot))
        )
        const results = await Promise.allSettled([
          ...deletions.values(),
          ...projectCancellations.values(),
          Promise.resolve().then(() => engines.close()),
          Promise.resolve().then(() => platform.close()),
        ])
        const failures = [...rejections(results), ...(await join(unowned))]
        settledListeners.clear()
        throwFailures(failures)
      })
      for (const entry of entries) stop(entry)
      return closing
    },
    engines: (refresh) => engines.status(refresh),
  }
  return dispatcher
}

function key(ref: WorkbenchConversationRef): string {
  return `${resolve(ref.projectRoot)}\0${ref.sessionId}`
}

function rejections(results: ReadonlyArray<PromiseSettledResult<unknown>>): unknown[] {
  return results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
}

function throwFailures(failures: readonly unknown[]): void {
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, '会话资源收束失败')
}
