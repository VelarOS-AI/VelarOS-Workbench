import { AppError } from '@velaros-ai/velaros/core/error'

import type {
  WorkbenchConversationBridge,
  WorkbenchConversationEventEnvelope,
  WorkbenchConversationRecoveryRun,
} from '@shared/workbenchConversation'

import {
  readStandaloneChatSessionOwner,
  type StandaloneChatSessionOwner,
} from './standaloneChatSessionRegistry'

export interface StandaloneConversationStreamRun {
  readonly projectRoot: string
  readonly sessionId: string
  readonly inputId: string
  readonly sessionOwner: StandaloneChatSessionOwner
  streamId: Nullable<string>
  lastSequence: number
}

export interface StandaloneConversationProjectOwner {
  readonly projectRoot: string
  readonly controller: AbortController
}

export interface StandaloneConversationSubmission {
  readonly project: StandaloneConversationProjectOwner
  readonly session: StandaloneChatSessionOwner
  readonly signal: AbortSignal
}

interface RecoveryBatch {
  readonly project: StandaloneConversationProjectOwner
  readonly sessions: SessionRecovery[]
  readonly promise: Promise<void>
}

interface SessionRecovery {
  readonly batch: RecoveryBatch
  readonly session: StandaloneChatSessionOwner
  readonly buffered: WorkbenchConversationEventEnvelope[]
}

/** 实际持久流的恢复、提交准备与事件归属；不持有 UI、也不另建后端准入。 */
export class StandaloneWorkbenchConversationRecovery<TRun extends StandaloneConversationStreamRun> {
  private readonly projects = new Map<string, StandaloneConversationProjectOwner>()
  private readonly batches = new Map<string, RecoveryBatch>()
  private readonly recovered = new WeakSet<StandaloneConversationProjectOwner>()
  private readonly sessions = new Map<string, SessionRecovery>()
  private readonly submissions = new Map<string, StandaloneConversationSubmission>()
  private readonly gaps = new Map<
    string,
    { run: TRun; buffered: WorkbenchConversationEventEnvelope[] }
  >()

  public constructor(
    private readonly options: {
      recover: WorkbenchConversationBridge['recover']
      readSessions: (projectRoot: string) => ReadonlyArray<{ sessionId: string }>
      readRun: (projectRoot: string, sessionId: string) => Nullable<TRun>
      createRun: (run: WorkbenchConversationRecoveryRun, owner: StandaloneChatSessionOwner) => TRun
      apply: (run: TRun, envelope: WorkbenchConversationEventEnvelope) => void
      onError: (error: unknown) => void
    }
  ) {}

  public mountProject(projectRoot: string): StandaloneConversationProjectOwner {
    const previous = this.projects.get(projectRoot)
    if (previous) this.releaseProject(previous)
    const owner = { projectRoot, controller: new AbortController() }
    this.projects.set(projectRoot, owner)
    return owner
  }

  public releaseProject(owner: StandaloneConversationProjectOwner): void {
    if (this.projects.get(owner.projectRoot) === owner) this.projects.delete(owner.projectRoot)
    owner.controller.abort(new AppError('CANCELLED', '项目会话已离开。'))
  }

  public disposePreparations(): void {
    for (const owner of this.projects.values()) this.releaseProject(owner)
  }

  public isRecovering(projectRoot: string): boolean {
    const batch = this.batches.get(projectRoot)
    return !!batch && this.projects.get(projectRoot) === batch.project
  }

  public hasSubmission(projectRoot: string, sessionId: string): boolean {
    const claim = this.submissions.get(this.key(projectRoot, sessionId))
    return !!claim && !claim.signal.aborted
  }

  public projectSignal(projectRoot: string): AbortSignal {
    const project = this.projects.get(projectRoot)
    if (!project) throw new AppError('CANCELLED', '项目会话已离开。')
    project.controller.signal.throwIfAborted()
    return project.controller.signal
  }

  public preparationSignal(
    projectRoot: string,
    sessionId: string,
    signal?: AbortSignal
  ): AbortSignal {
    const projectSignal = this.projectSignal(projectRoot)
    const session = readStandaloneChatSessionOwner(projectRoot, sessionId)
    if (!session) throw new AppError('CANCELLED', '会话已离开。')
    const combined = AbortSignal.any([
      projectSignal,
      session.controller.signal,
      ...(signal ? [signal] : []),
    ])
    combined.throwIfAborted()
    return combined
  }

  public claimSubmission(
    projectRoot: string,
    sessionId: string,
    signal?: AbortSignal
  ): StandaloneConversationSubmission {
    const combined = this.preparationSignal(projectRoot, sessionId, signal)
    if (this.hasSubmission(projectRoot, sessionId)) throw new AppError('CONFLICT', '会话正在提交。')
    const claim = {
      project: this.projects.get(projectRoot)!,
      session: readStandaloneChatSessionOwner(projectRoot, sessionId)!,
      signal: combined,
    }
    this.submissions.set(this.key(projectRoot, sessionId), claim)
    return claim
  }

  public assertSubmission(claim: StandaloneConversationSubmission): void {
    claim.signal.throwIfAborted()
    const { session, project } = claim
    if (
      this.projects.get(project.projectRoot) !== project ||
      readStandaloneChatSessionOwner(session.projectRoot, session.sessionId) !== session ||
      this.submissions.get(this.key(session.projectRoot, session.sessionId)) !== claim
    )
      throw new AppError('CANCELLED', '会话准备已撤销。')
  }

  public releaseSubmission(claim: StandaloneConversationSubmission): void {
    const key = this.key(claim.session.projectRoot, claim.session.sessionId)
    if (this.submissions.get(key) === claim) this.submissions.delete(key)
  }

  public ensureProject(projectRoot: string): Promise<void> {
    const project = this.projects.get(projectRoot)
    if (!project) return Promise.reject(new AppError('CANCELLED', '项目会话已离开。'))
    const current = this.batches.get(projectRoot)
    if (current?.project === project) return current.promise
    if (this.recovered.has(project)) return Promise.resolve()
    const batch: RecoveryBatch = {
      project,
      sessions: [],
      promise: Promise.resolve().then(() => this.recoverProject(batch)),
    }
    this.batches.set(projectRoot, batch)
    for (const initial of this.options.readSessions(projectRoot)) {
      const session = readStandaloneChatSessionOwner(projectRoot, initial.sessionId)
      if (!session || this.options.readRun(projectRoot, initial.sessionId)) continue
      const recovery: SessionRecovery = { batch, session, buffered: [] }
      batch.sessions.push(recovery)
      this.sessions.set(this.key(projectRoot, session.sessionId), recovery)
    }
    return batch.promise
  }

  public receive(envelope: WorkbenchConversationEventEnvelope): void {
    const recovery = this.sessions.get(this.key(envelope.projectRoot, envelope.sessionId))
    if (recovery && this.isCurrentRecovery(recovery)) {
      recovery.buffered.push(envelope)
      return
    }
    const run = this.matchRun(envelope)
    if (!run) return
    // journal 失败的终态没有可提交序号，仍须立即收束同一真实运行。
    if (!envelope.sequence) {
      this.apply(envelope)
      return
    }
    const streamId = envelope.streamId
    const gap = this.gaps.get(streamId)
    if (gap?.run === run) {
      gap.buffered.push(envelope)
      return
    }
    if (envelope.sequence > run.lastSequence + 1) {
      void this.recoverGap(run, envelope)
      return
    }
    this.apply(envelope)
  }

  private key(projectRoot: string, sessionId: string): string {
    return `${projectRoot}\0${sessionId}`
  }

  private isCurrentRecovery(recovery: SessionRecovery): boolean {
    const { project } = recovery.batch
    return (
      !project.controller.signal.aborted &&
      this.projects.get(project.projectRoot) === project &&
      this.batches.get(project.projectRoot) === recovery.batch &&
      readStandaloneChatSessionOwner(recovery.session.projectRoot, recovery.session.sessionId) ===
        recovery.session
    )
  }

  private async recoverProject(batch: RecoveryBatch): Promise<void> {
    const projectRoot = batch.project.projectRoot
    try {
      for (const recovery of batch.sessions) {
        batch.project.controller.signal.throwIfAborted()
        if (!this.isCurrentRecovery(recovery)) continue
        const { session } = recovery
        let after = 0
        let header: WorkbenchConversationRecoveryRun | undefined
        const events: WorkbenchConversationEventEnvelope[] = []
        for (;;) {
          const result = await this.options.recover({
            projectRoot,
            sessionId: session.sessionId,
            streamId: header?.id,
            after,
          })
          batch.project.controller.signal.throwIfAborted()
          if (!this.isCurrentRecovery(recovery)) break
          if (!result.ok) throw new AppError('UNAVAILABLE', result.message)
          const page = result.value
          if (!page) break
          if (
            page.run.projectRoot !== projectRoot ||
            page.run.sessionId !== session.sessionId ||
            !page.run.inputId ||
            (header && (page.run.id !== header.id || page.run.inputId !== header.inputId))
          )
            throw new AppError('CONFLICT', '恢复期间运行记录身份已更新。')
          header = page.run
          events.push(...page.events)
          after = page.nextAfter
          if (!page.hasMore) break
        }
        // 全部回读成功后才接纳，撤销的恢复不会留下半轮 active run。
        if (
          this.isCurrentRecovery(recovery) &&
          header &&
          !this.options.readRun(projectRoot, session.sessionId)
        ) {
          this.options.createRun(header, session)
          for (const envelope of events) this.apply(envelope)
        }
        const key = this.key(projectRoot, session.sessionId)
        if (this.sessions.get(key) === recovery) this.sessions.delete(key)
        for (const envelope of recovery.buffered) this.receive(envelope)
      }
      if (this.projects.get(projectRoot) === batch.project) this.recovered.add(batch.project)
    } catch (error) {
      if (!batch.project.controller.signal.aborted) this.options.onError(error)
      throw error
    } finally {
      for (const recovery of batch.sessions) {
        const key = this.key(projectRoot, recovery.session.sessionId)
        if (this.sessions.get(key) === recovery) this.sessions.delete(key)
      }
      if (this.batches.get(projectRoot) === batch) this.batches.delete(projectRoot)
    }
  }

  private matchRun(envelope: WorkbenchConversationEventEnvelope): Nullable<TRun> {
    const run = this.options.readRun(envelope.projectRoot, envelope.sessionId)
    if (
      !run ||
      !envelope.streamId ||
      !envelope.inputId ||
      run.inputId !== envelope.inputId ||
      readStandaloneChatSessionOwner(run.projectRoot, run.sessionId) !== run.sessionOwner ||
      (run.streamId !== null && run.streamId !== envelope.streamId)
    )
      return null
    run.streamId = envelope.streamId
    return run
  }

  private apply(envelope: WorkbenchConversationEventEnvelope): void {
    const run = this.matchRun(envelope)
    if (!run) return
    if (envelope.sequence) {
      if (envelope.sequence <= run.lastSequence) return
      run.lastSequence = envelope.sequence
    }
    this.options.apply(run, envelope)
  }

  private async recoverGap(run: TRun, first: WorkbenchConversationEventEnvelope): Promise<void> {
    const streamId = first.streamId
    const gap = { run, buffered: [first] }
    this.gaps.set(streamId, gap)
    try {
      let after = run.lastSequence
      for (;;) {
        const result = await this.options.recover({
          projectRoot: run.projectRoot,
          sessionId: run.sessionId,
          streamId,
          after,
        })
        if (this.matchRun(first) !== run) return
        if (!result.ok) throw new AppError('UNAVAILABLE', result.message)
        const page = result.value
        if (
          !page ||
          page.run.id !== streamId ||
          page.run.inputId !== run.inputId ||
          page.run.projectRoot !== run.projectRoot ||
          page.run.sessionId !== run.sessionId
        )
          throw new AppError('CONFLICT', '缺失事件所属运行记录已更新。')
        for (const envelope of page.events) this.apply(envelope)
        after = page.nextAfter
        if (!page.hasMore) break
      }
      for (const envelope of gap.buffered) this.apply(envelope)
    } catch (error) {
      if (this.matchRun(first) === run) this.options.onError(error)
    } finally {
      if (this.gaps.get(streamId) === gap) this.gaps.delete(streamId)
    }
  }
}
