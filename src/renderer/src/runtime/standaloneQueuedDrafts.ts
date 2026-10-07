import { useEffect, useSyncExternalStore } from 'react'

import type { ChatInputQueuedDraft } from '@velaros-ai/ui/conversation/composer'

import { useMemoizedFn } from '../support/genericHooks'

import {
  snapshotWorkbenchComposerContext,
  type WorkbenchComposerContext,
} from './standaloneChatDrafts'

/**
 * 「当前任务结束后发送」的排队草稿，按会话隔离。
 *
 * 语义与 Desktop 的 QueuedComposerDraftStore 对齐：运行中显式选「结束后发送」才入队；本轮一收尾
 * 自动取出第一项按普通消息发出，一次只出一项（发出去又开始运行，下一项继续等）；排队中的草稿可以
 * 编辑、上下移动、删除、放回输入框、立即运行，或在运行中改为引导注入当前这一轮。
 *
 * 两种情况不自动出队，只能由用户「继续」或「立即运行」：
 * - 某一项投递没被受理（模型未配置、账号未登录……）——它留在队首并挡住自动出队，否则每次快照
 *   变化都会重投一遍、把同一条警告弹个不停；
 * - 会话停止中 / 已中止 / 已失败——用户刚按了停止，不能替他把下一条自动发出去。
 */
export interface WorkbenchQueuedDraft extends ChatInputQueuedDraft {
  context?: WorkbenchComposerContext
}

interface WorkbenchQueueInput {
  value: string
  files: File[]
  context?: WorkbenchComposerContext
}

interface QueueSnapshot {
  readonly drafts: readonly WorkbenchQueuedDraft[]
  readonly drainingId: string | null
  /** 投递未被受理、挡住自动出队的那一项。 */
  readonly blockedId: string | null
  readonly errorMessage: string | null
}

const EmptySnapshot: QueueSnapshot = Object.freeze({
  drafts: [],
  drainingId: null,
  blockedId: null,
  errorMessage: null,
})

export class StandaloneQueuedDraftStore {
  private readonly scopes = new Map<string, QueueSnapshot>()
  private readonly listeners = new Set<() => void>()

  public readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public snapshot(scopeId: string): QueueSnapshot {
    return this.scopes.get(scopeId) ?? EmptySnapshot
  }

  public enqueue(scopeId: string, draft: WorkbenchQueueInput): string {
    const id = crypto.randomUUID()
    const current = this.snapshot(scopeId)
    this.write(scopeId, {
      ...current,
      drafts: [
        ...current.drafts,
        {
          ...draft,
          id,
          files: [...draft.files],
          context: draft.context && snapshotWorkbenchComposerContext(draft.context),
        },
      ],
    })
    return id
  }

  public forget(scopeId: string): void {
    this.write(scopeId, EmptySnapshot)
  }

  public remove(scopeId: string, id: string): void {
    const current = this.snapshot(scopeId)
    const unblocked = current.blockedId === id
    this.write(scopeId, {
      ...current,
      drafts: current.drafts.filter((draft) => draft.id !== id),
      blockedId: unblocked ? null : current.blockedId,
      errorMessage: unblocked ? null : current.errorMessage,
    })
  }

  public take(scopeId: string, id: string): WorkbenchQueuedDraft | null {
    const draft = this.snapshot(scopeId).drafts.find((entry) => entry.id === id) ?? null
    if (draft) this.remove(scopeId, id)
    return draft
  }

  public edit(scopeId: string, id: string, value: string): void {
    const current = this.snapshot(scopeId)
    this.write(scopeId, {
      ...current,
      drafts: current.drafts.map((draft) => (draft.id === id ? { ...draft, value } : draft)),
    })
  }

  public move(scopeId: string, id: string, direction: 'up' | 'down'): void {
    const current = this.snapshot(scopeId)
    const index = current.drafts.findIndex((draft) => draft.id === id)
    const target = direction === 'up' ? index - 1 : index + 1
    if (index < 0 || target < 0 || target >= current.drafts.length) return
    const drafts = [...current.drafts]
    ;[drafts[index], drafts[target]] = [drafts[target], drafts[index]]
    this.write(scopeId, { ...current, drafts })
  }

  /**
   * 发出一项草稿；发送方回 true（已受理）才出队。没受理或抛错时这一项挡住自动出队，
   * 等用户处理。显式提交某一项只解除它自己的阻挡，别的阻挡项仍等用户明确继续。
   */
  public async submit(
    scopeId: string,
    id: string,
    send: (draft: WorkbenchQueuedDraft) => Promise<boolean>
  ): Promise<void> {
    const current = this.snapshot(scopeId)
    const draft = current.drafts.find((entry) => entry.id === id)
    if (current.drainingId || !draft) return

    const preservedBlock = current.blockedId !== id ? current.blockedId : null
    this.write(scopeId, {
      ...current,
      drainingId: id,
      blockedId: preservedBlock,
      errorMessage: preservedBlock ? current.errorMessage : null,
    })
    try {
      const accepted = await send(draft)
      const latest = this.snapshot(scopeId)
      if (latest.drainingId !== id) return
      this.write(
        scopeId,
        accepted
          ? {
              ...latest,
              drainingId: null,
              drafts: latest.drafts.filter((entry) => entry.id !== id),
            }
          : { ...latest, drainingId: null, blockedId: preservedBlock ?? id }
      )
    } catch (error) {
      if (this.snapshot(scopeId).drainingId !== id) return
      this.write(scopeId, {
        ...this.snapshot(scopeId),
        drainingId: null,
        blockedId: preservedBlock ?? id,
        errorMessage: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** 自动出队：会话空闲、没有暂停、队首没被挡住时发出第一项。 */
  public async drain(
    scopeId: string,
    state: { busy: boolean; paused: boolean },
    send: (draft: WorkbenchQueuedDraft) => Promise<boolean>
  ): Promise<void> {
    const current = this.snapshot(scopeId)
    const first = current.drafts[0]
    if (state.busy || state.paused || !first || current.blockedId !== null) return
    await this.submit(scopeId, first.id, send)
  }

  private write(scopeId: string, next: QueueSnapshot): void {
    if (next.drafts.length === 0 && !next.drainingId && !next.errorMessage)
      this.scopes.delete(scopeId)
    else this.scopes.set(scopeId, next)
    for (const listener of [...this.listeners]) listener()
  }
}

const store = new StandaloneQueuedDraftStore()

/** 删除会话也释放它的队列；迟到的发送回执不会重新建出已删除的队列。 */
export function forgetStandaloneQueuedDrafts(scopeId: string): void {
  store.forget(scopeId)
}

export function useStandaloneQueuedDrafts({
  scopeId,
  isRunBlocked,
  pauseAutomaticDrain = false,
  submitDraft,
}: {
  scopeId: string
  /** 当前会话还在运行（或等待交互）时为 true：队列不出队，「立即运行」也不可用。 */
  isRunBlocked: boolean
  /** 停止中 / 已中止 / 已失败：保留队列但不自动出队，用户「继续」或「立即运行」才发。 */
  pauseAutomaticDrain?: boolean
  submitDraft: (draft: WorkbenchQueuedDraft) => Promise<boolean>
}) {
  const snapshot = useSyncExternalStore(store.subscribe, () => store.snapshot(scopeId))
  const send = useMemoizedFn(submitDraft)

  useEffect(() => {
    void store.drain(scopeId, { busy: isRunBlocked, paused: pauseAutomaticDrain }, send)
  }, [isRunBlocked, pauseAutomaticDrain, scopeId, send, snapshot])

  const runNow = async (id: string): Promise<void> => {
    if (!isRunBlocked) await store.submit(scopeId, id, send)
  }

  return {
    drafts: snapshot.drafts as WorkbenchQueuedDraft[],
    drainingId: snapshot.drainingId,
    isDraining: !!snapshot.drainingId,
    isPaused: pauseAutomaticDrain || snapshot.blockedId !== null,
    errorMessage: snapshot.errorMessage,
    enqueue: (draft: WorkbenchQueueInput) => store.enqueue(scopeId, draft),
    remove: (id: string) => store.remove(scopeId, id),
    update: (id: string, value: string) => store.edit(scopeId, id, value),
    move: (id: string, direction: 'up' | 'down') => store.move(scopeId, id, direction),
    take: (id: string) => store.take(scopeId, id),
    runNow,
    /** 继续：发出队首一项；它被受理后会话进入运行，其余项照常在本轮结束后自动出队。 */
    resume: async () => {
      const first = store.snapshot(scopeId).drafts[0]
      if (first) await runNow(first.id)
    },
  }
}
