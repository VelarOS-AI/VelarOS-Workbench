import { createHash } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'

import type { InteractionAnswer } from '@velaros-ai/ui/conversation/contracts'
import { isArray, isNonBlankString, isPlainObject, isString, Log } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'

import {
  ConversationScriptNotice,
  type WorkbenchAgentEngineId,
  WorkbenchAgentEngineIds,
  type WorkbenchConversationAnswerRequest,
  type WorkbenchConversationBackupRequest,
  WorkbenchConversationChannels,
  type WorkbenchConversationEngineSelection,
  type WorkbenchConversationEventEnvelope,
  type WorkbenchConversationGuidanceRequest,
  type WorkbenchConversationImage,
  type WorkbenchConversationInputRequest,
  type WorkbenchConversationSendRequest,
  type WorkbenchConversationSessionRequest,
  type WorkbenchConversationStreamEvent,
  type WorkbenchConversationUpdateGoalRequest,
  type WorkbenchExecutionMode,
  WorkbenchPermissionConfirmationModes,
  WorkbenchWebSearchEngines,
} from '../../shared/workbenchConversation'
import { workbenchMainText } from '../i18n/workbenchMainMessages'
import type { WorkbenchProjectHub } from '../projects/ProjectHub'
import { callWithEnvelope } from '../workspace/ipcBoundary'

import type {
  WorkbenchConversationDispatcherApi,
  WorkbenchPreparedConversation,
} from './WorkbenchConversationDispatcher'
import type { WorkbenchConversationRecovery } from './WorkbenchConversationRecovery'
import { goalArtifact } from './WorkbenchConversationRules'
import type {
  WorkbenchConversationRef,
  WorkbenchConversationRuntimeApi,
  WorkbenchConversationSink,
} from './WorkbenchConversationRuntime'

const log = Log.tag('WorkbenchConversationIpc')

const ReasoningLevels = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const Locales = new Set(['zh-CN', 'en-US'])
const ExecutionModes = new Set<WorkbenchExecutionMode>(['goal', 'plan'])
const GoalActions = new Set(['resume', 'pause', 'block', 'complete', 'cancel', 'remove'])
/** 一条消息最多带这么多张图。 */
const MaxImages = 16
/** 外部引擎的模型名最长这么多字。 */
const MaxEngineModelChars = 200

/** 窗口 → 它当前打开的项目。 */
export interface WorkbenchConversationWindows {
  getHubForWebContents(sender: WebContents): Nullable<WorkbenchProjectHub>
}

/** 产品改进数据（用户同意后才记）：一轮的起止、回合、用量与脚本执行次数。 */
interface WorkbenchConversationAnalytics {
  recordRunStarted(input: {
    readonly executionId: string
    readonly sessionId: string
    readonly projectRoot: string | null
    readonly modelSelection: unknown
  }): void
  recordAgentEvent(event: unknown, projectRoot: string | null): void
  recordRunFinished(executionId: string, status: 'completed' | 'aborted' | 'error'): void
}

interface WorkbenchConversationIpcOptions {
  runtime: WorkbenchConversationDispatcherApi
  recovery: WorkbenchConversationRecovery
  windows: WorkbenchConversationWindows
  /** 聊天历史落盘备份的目录。 */
  backupDir(): string
  analytics?: WorkbenchConversationAnalytics
}

/**
 * 主聊天的 IPC 面（与 Desktop 的 chat 通道同一套动作）：发送、停止、引导、回答、目标，外加会话删除与历史
 * 备份。窗口只能动自己当前打开的项目里的会话；运行中的通知与状态只推给发起这一轮的窗口，窗口销毁时
 * 它发起的运行一并停下。
 */
export function registerWorkbenchConversationIpc(
  options: WorkbenchConversationIpcOptions
): () => void {
  const { runtime, recovery } = options
  /** 已经挂了销毁监听的窗口：窗口没了，它发起的运行跟着停。 */
  const watchedSenders = new WeakSet<WebContents>()
  const runsBySender = new Map<number, Map<string, WorkbenchConversationRef>>()

  const ownedRef = (event: IpcMainInvokeEvent, request: WorkbenchConversationSessionRequest) => {
    const project = options.windows.getHubForWebContents(event.sender)?.getState().currentProject
    if (!project || resolve(project.path) !== resolve(request.projectRoot))
      throw new AppError('PERMISSION', workbenchMainText('conversation.notInWindow'))
    return { projectRoot: project.path, sessionId: request.sessionId }
  }

  const trackRun = (
    sender: WebContents,
    ref: WorkbenchConversationRef,
    completed: Promise<void>
  ) => {
    const runs = runsBySender.get(sender.id) ?? new Map<string, WorkbenchConversationRef>()
    runsBySender.set(sender.id, runs)
    const key = `${ref.projectRoot}\0${ref.sessionId}`
    runs.set(key, ref)
    void completed
      .catch(() => undefined)
      .finally(() => {
        if (runs.get(key) === ref) runs.delete(key)
      })
    if (watchedSenders.has(sender)) return
    watchedSenders.add(sender)
    const senderId = sender.id
    sender.once('destroyed', () => {
      const orphaned = [...(runsBySender.get(senderId)?.values() ?? [])]
      runsBySender.delete(senderId)
      for (const orphan of orphaned)
        void runtime
          .cancel(orphan)
          .catch((error: unknown) =>
            log.warn('窗口关闭后没能停下运行', { error: AppError.getMessage(error) })
          )
    })
  }

  const unsubscribeNotes = runtime.subscribeNotesChanged((ref) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      const project = options.windows
        .getHubForWebContents(window.webContents)
        ?.getState().currentProject
      if (project && resolve(project.path) === resolve(ref.projectRoot))
        window.webContents.send(WorkbenchConversationChannels.notesChanged, ref)
    }
  })
  ipcMain.handle(WorkbenchConversationChannels.listNotes, (event, raw: unknown) =>
    callWithEnvelope(async () => {
      const ref = ownedRef(event, parseSessionRequest(raw))
      const input = z
        .object({
          after: z.string().max(512).optional(),
          limit: z.number().int().min(1).max(64).optional(),
        })
        .parse(raw)
      return runtime.listNotes(ref, input)
    })
  )
  ipcMain.handle(WorkbenchConversationChannels.readNote, (event, raw: unknown) =>
    callWithEnvelope(async () => {
      const ref = ownedRef(event, parseSessionRequest(raw))
      const input = z
        .object({
          key: z.string().min(1).max(512),
          revision: z.number().int().min(1),
          offset: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(32000).optional(),
        })
        .parse(raw)
      return runtime.readNote(ref, input)
    })
  )

  ipcMain.handle(WorkbenchConversationChannels.recover, (event, raw: unknown) =>
    callWithEnvelope(async () => {
      const ref = ownedRef(event, parseSessionRequest(raw))
      const cursor = z
        .object({
          streamId: z.string().max(100).optional(),
          after: z.number().int().min(0).optional(),
        })
        .parse(raw)
      return recovery.read(ref, cursor, runtime.isRunning(ref))
    })
  )
  ipcMain.handle(WorkbenchConversationChannels.send, (event, raw: unknown) =>
    callWithEnvelope(async () => {
      const request = parseSendRequest(raw)
      const ref = ownedRef(event, request)
      const executionId = `${ref.sessionId}:${request.inputId}`
      const { accepted, completed } = runtime.submit(
        async (signal) => {
          const prepared = await prepareWindowConversation({
            sender: event.sender,
            ref,
            inputId: request.inputId,
            goalMode: request.executionModes.includes('goal'),
            signal,
            recovery,
            runtime,
            analytics: options.analytics,
          })
          try {
            options.analytics?.recordRunStarted({
              executionId,
              sessionId: ref.sessionId,
              projectRoot: ref.projectRoot,
              modelSelection: request.engine
                ? { provider: request.engine.id, model: request.engine.model ?? '' }
                : { provider: request.model.provider, model: request.model.model },
            })
          } catch (error) {
            log.debug('产品改进数据记录失败', { error: AppError.getMessage(error) })
          }
          return prepared
        },
        { ...request, ...ref }
      )
      trackRun(event.sender, ref, completed)
      await accepted
    })
  )
  ipcMain.handle(WorkbenchConversationChannels.cancel, (event, raw: unknown) =>
    callWithEnvelope(() => runtime.cancel(ownedRef(event, parseSessionRequest(raw))))
  )
  ipcMain.handle(WorkbenchConversationChannels.guidance, (event, raw: unknown) =>
    callWithEnvelope(async () => {
      const request = parseGuidanceRequest(raw)
      await runtime.guidance(ownedRef(event, request), request)
    })
  )
  ipcMain.handle(WorkbenchConversationChannels.input, (event, raw: unknown) =>
    callWithEnvelope(async () => {
      const request = parseInputRequest(raw)
      await runtime.input(ownedRef(event, request), request.answer)
    })
  )
  ipcMain.handle(WorkbenchConversationChannels.answer, (event, raw: unknown) =>
    callWithEnvelope(async () => {
      const request = parseAnswerRequest(raw)
      await runtime.answer(ownedRef(event, request), request.requestId, request.answer)
    })
  )
  ipcMain.handle(WorkbenchConversationChannels.getGoal, (event, raw: unknown) =>
    callWithEnvelope(async () => {
      const ref = ownedRef(event, parseSessionRequest(raw))
      return { goal: goalArtifact(ref.sessionId, await runtime.getGoal(ref)) }
    })
  )
  ipcMain.handle(WorkbenchConversationChannels.updateGoal, (event, raw: unknown) =>
    callWithEnvelope(async () => {
      const request = parseUpdateGoalRequest(raw)
      const ref = ownedRef(event, request)
      const goal = await runtime.controlGoal(ref, {
        action: request.action,
        baseRevision: request.baseRevision,
      })
      return { goal: goalArtifact(ref.sessionId, goal) }
    })
  )
  ipcMain.handle(WorkbenchConversationChannels.deleteSession, (event, raw: unknown) =>
    callWithEnvelope(async () => {
      const ref = ownedRef(event, parseSessionRequest(raw))
      await runtime.deleteSession(ref)
    })
  )
  ipcMain.handle(WorkbenchConversationChannels.backupHistory, (_event, raw: unknown) =>
    callWithEnvelope(() => writeHistoryBackup(options.backupDir(), parseBackupRequest(raw)))
  )
  ipcMain.handle(WorkbenchConversationChannels.engines, (_event, raw: unknown) =>
    callWithEnvelope(() => runtime.engines(isPlainObject(raw) && raw.refresh === true))
  )

  return () => {
    unsubscribeNotes()
    for (const channel of [
      WorkbenchConversationChannels.recover,
      WorkbenchConversationChannels.send,
      WorkbenchConversationChannels.cancel,
      WorkbenchConversationChannels.guidance,
      WorkbenchConversationChannels.input,
      WorkbenchConversationChannels.answer,
      WorkbenchConversationChannels.listNotes,
      WorkbenchConversationChannels.readNote,
      WorkbenchConversationChannels.getGoal,
      WorkbenchConversationChannels.updateGoal,
      WorkbenchConversationChannels.deleteSession,
      WorkbenchConversationChannels.backupHistory,
      WorkbenchConversationChannels.engines,
    ])
      ipcMain.removeHandler(channel)
  }
}

/** 普通发送与会话协作共用真实持久流，完整 envelope 写盘后才交付给窗口。 */
export async function prepareWindowConversation(options: {
  sender: WebContents
  ref: WorkbenchConversationRef
  inputId: string
  goalMode: boolean
  signal: AbortSignal
  recovery: WorkbenchConversationRecovery
  runtime: Pick<WorkbenchConversationRuntimeApi, 'cancel'>
  analytics?: WorkbenchConversationAnalytics
}): Promise<WorkbenchPreparedConversation> {
  const { sender, inputId, goalMode, signal, recovery, runtime } = options
  signal.throwIfAborted()
  const ref = { projectRoot: options.ref.projectRoot, sessionId: options.ref.sessionId }
  const run = await recovery.begin(ref, inputId, goalMode)
  let journalFailed = false
  let journalFailure: unknown
  let pending = Promise.resolve()
  const sink = withAnalytics(
    createWindowSink(sender, ref, (item, deliver) => {
      if (journalFailed) return
      // Recovery 自己按会话排队；最后一条回执也等待前面的失败收束。
      pending = recovery
        .append(run, item)
        .then(deliver)
        .catch((error: unknown) => {
          if (journalFailed) return
          journalFailed = true
          journalFailure = error
          deliver({
            ...ref,
            inputId: run.inputId,
            streamId: run.id,
            event: {
              type: 'state',
              payload: {
                kind: 'error',
                message: '会话记录保存失败，执行已停止。请检查磁盘空间后重试。',
              },
            },
          })
          log.warn('会话事件持久化失败', { error: AppError.getMessage(error) })
          void runtime
            .cancel(ref)
            .catch((reason: unknown) => log.warn('停止恢复失败的会话失败', { reason }))
        })
    }),
    options.analytics,
    `${ref.sessionId}:${inputId}`,
    ref.projectRoot
  )
  return {
    sink,
    finish: async ({ started, reason }) => {
      if (!started)
        sink.state(
          signal.aborted
            ? { kind: 'aborted', message: workbenchMainText('conversation.runStopped') }
            : { kind: 'error', message: AppError.getMessage(reason) }
        )
      await pending
      if (journalFailed) throw journalFailure
    },
  }
}

/** 一轮运行的展示流直接推给发起它的窗口；窗口已经没了就丢掉（运行会因窗口销毁被停下）。 */
function createWindowSink(
  sender: WebContents,
  ref: WorkbenchConversationRef,
  persist: (
    event: WorkbenchConversationStreamEvent,
    deliver: (envelope: WorkbenchConversationEventEnvelope) => void
  ) => void
): WorkbenchConversationSink {
  const deliver = (envelope: WorkbenchConversationEventEnvelope): void => {
    if (sender.isDestroyed()) return
    try {
      sender.send(WorkbenchConversationChannels.event, envelope)
    } catch (error) {
      log.warn('聊天流发送失败', { error: AppError.getMessage(error), sessionId: ref.sessionId })
    }
  }
  const send = (event: WorkbenchConversationStreamEvent): void => {
    persist(event, deliver)
  }
  return {
    notice: (kind, payload) => send({ type: 'notice', kind, payload }),
    state: (payload) => send({ type: 'state', payload }),
  }
}

/**
 * 展示流顺带记产品改进数据：运行状态原样交给统计（回合、确认、用量、上下文占用），每张脚本卡开跑与
 * 收尾各记一次（相当于一次工具调用），终态记这一轮的结果。统计出错不影响展示。
 */
function withAnalytics(
  sink: WorkbenchConversationSink,
  analytics: WorkbenchConversationAnalytics | undefined,
  executionId: string,
  projectRoot: string
): WorkbenchConversationSink {
  if (!analytics) return sink
  const started = new Set<string>()
  const settled = new Set<string>()
  const record = (action: () => void): void => {
    try {
      action()
    } catch (error) {
      log.debug('产品改进数据记录失败', { error: AppError.getMessage(error) })
    }
  }
  return {
    notice: (kind, payload) => {
      sink.notice(kind, payload)
      if (kind !== ConversationScriptNotice || !isPlainObject(payload) || !isString(payload.id))
        return
      const { id, status, error } = payload
      if (status === 'running' && !started.has(id)) {
        started.add(id)
        record(() =>
          analytics.recordAgentEvent({ type: 'tool-start', toolName: 'script' }, projectRoot)
        )
      }
      if (
        (status === 'succeeded' || status === 'failed' || status === 'cancelled') &&
        !settled.has(id)
      ) {
        settled.add(id)
        record(() =>
          analytics.recordAgentEvent(
            {
              type: 'tool-done',
              error: status === 'failed' ? (isString(error) ? error : 'failed') : null,
            },
            projectRoot
          )
        )
      }
    },
    state: (payload) => {
      sink.state(payload)
      record(() => analytics.recordAgentEvent({ type: 'runtime', payload }, projectRoot))
      if (payload.kind === 'done' || payload.kind === 'aborted' || payload.kind === 'error')
        record(() =>
          analytics.recordRunFinished(
            executionId,
            payload.kind === 'done' ? 'completed' : payload.kind
          )
        )
    },
  }
}

/**
 * 把 renderer 送来的聊天历史原样落盘（旧 Kernel 通道的同一份实现）。主进程不解释 payload 的形状；
 * 先写 `.tmp` 再改名，写到一半崩溃不会用半截 JSON 覆盖上一份完好的备份。
 */
async function writeHistoryBackup(
  directory: string,
  request: WorkbenchConversationBackupRequest
): Promise<{ path: string }> {
  // 存储键不能直接当文件名（含分隔符且可能超长）；取稳定摘要做分片键。
  const shard = createHash('sha256').update(request.key).digest('hex').slice(0, 32)
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${shard}.json`)
  const temporaryPath = `${path}.tmp`
  await writeFile(temporaryPath, request.payload, 'utf8')
  await rename(temporaryPath, path)
  return { path }
}

// ---------------------------------------------------------------------------------------------
// 边界外来数据的解析：形状不符按无效请求处理
// ---------------------------------------------------------------------------------------------

function invalid(): never {
  throw new AppError('VALIDATION', workbenchMainText('conversation.invalidRequest'))
}

function parseSessionRequest(raw: unknown): WorkbenchConversationSessionRequest {
  if (!isPlainObject(raw) || !isNonBlankString(raw.sessionId) || !isNonBlankString(raw.projectRoot))
    return invalid()
  return { sessionId: raw.sessionId, projectRoot: raw.projectRoot }
}

function parseSendRequest(raw: unknown): WorkbenchConversationSendRequest {
  const session = parseSessionRequest(raw)
  const input = raw as Record<string, unknown>
  const model = input.model
  if (
    !isString(input.inputId) ||
    !isString(input.text) ||
    !isString(input.locale) ||
    !Locales.has(input.locale) ||
    !isString(input.reasoningLevel) ||
    !ReasoningLevels.has(input.reasoningLevel) ||
    !isString(input.permissionMode) ||
    !WorkbenchPermissionConfirmationModes.includes(
      input.permissionMode as WorkbenchConversationSendRequest['permissionMode']
    ) ||
    !isArray(input.executionModes) ||
    !input.executionModes.every(
      (mode) => isString(mode) && ExecutionModes.has(mode as WorkbenchExecutionMode)
    ) ||
    !isPlainObject(model) ||
    !isNonBlankString(model.provider) ||
    !isNonBlankString(model.model) ||
    !isString(model.apiKey) ||
    !isString(model.baseURL) ||
    typeof input.memory !== 'boolean' ||
    !WorkbenchWebSearchEngines.includes(
      input.webSearchEngine as WorkbenchConversationSendRequest['webSearchEngine']
    )
  )
    return invalid()
  const request: WorkbenchConversationSendRequest = {
    ...session,
    inputId: input.inputId,
    text: input.text,
    locale: input.locale as WorkbenchConversationSendRequest['locale'],
    model: {
      provider: model.provider as WorkbenchConversationSendRequest['model']['provider'],
      model: model.model,
      apiKey: model.apiKey,
      baseURL: model.baseURL,
    },
    reasoningLevel: input.reasoningLevel as WorkbenchConversationSendRequest['reasoningLevel'],
    executionModes: [...new Set(input.executionModes as WorkbenchExecutionMode[])],
    permissionMode: input.permissionMode as WorkbenchConversationSendRequest['permissionMode'],
    memory: input.memory,
    webSearchEngine: input.webSearchEngine as WorkbenchConversationSendRequest['webSearchEngine'],
  }
  if (input.sandbox !== undefined) {
    if (typeof input.sandbox !== 'boolean') return invalid()
    request.sandbox = input.sandbox
  }
  if (input.images !== undefined) request.images = parseImages(input.images)
  if (input.engine !== undefined) request.engine = parseEngine(input.engine)
  return request
}

function parseEngine(raw: unknown): WorkbenchConversationEngineSelection {
  if (!isPlainObject(raw) || !WorkbenchAgentEngineIds.includes(raw.id as WorkbenchAgentEngineId))
    return invalid()
  const engine: WorkbenchConversationEngineSelection = { id: raw.id as WorkbenchAgentEngineId }
  if (raw.model !== undefined) {
    if (!isNonBlankString(raw.model) || raw.model.length > MaxEngineModelChars) return invalid()
    engine.model = raw.model
  }
  return engine
}

function parseImages(raw: unknown): WorkbenchConversationImage[] {
  if (!isArray(raw) || raw.length > MaxImages) return invalid()
  return raw.map((image) => {
    if (
      !isPlainObject(image) ||
      !isNonBlankString(image.data) ||
      !isNonBlankString(image.mediaType)
    )
      return invalid()
    const parsed: WorkbenchConversationImage = { data: image.data, mediaType: image.mediaType }
    if (isString(image.label)) parsed.label = image.label
    return parsed
  })
}

function parseGuidanceRequest(raw: unknown): WorkbenchConversationGuidanceRequest {
  const session = parseSessionRequest(raw)
  const input = raw as Record<string, unknown>
  if (!isString(input.inputId) || !isNonBlankString(input.text)) return invalid()
  return { ...session, inputId: input.inputId, text: input.text }
}

function parseInputRequest(raw: unknown): WorkbenchConversationInputRequest {
  const session = parseSessionRequest(raw)
  const input = raw as Record<string, unknown>
  if (!isString(input.answer)) return invalid()
  return { ...session, answer: input.answer }
}

function parseAnswerRequest(raw: unknown): WorkbenchConversationAnswerRequest {
  const session = parseSessionRequest(raw)
  const input = raw as Record<string, unknown>
  if (!isNonBlankString(input.requestId) || !isPlainObject(input.answer)) return invalid()
  return { ...session, requestId: input.requestId, answer: input.answer as InteractionAnswer }
}

function parseUpdateGoalRequest(raw: unknown): WorkbenchConversationUpdateGoalRequest {
  const session = parseSessionRequest(raw)
  const input = raw as Record<string, unknown>
  if (
    !isString(input.action) ||
    !GoalActions.has(input.action) ||
    typeof input.baseRevision !== 'number' ||
    !Number.isSafeInteger(input.baseRevision)
  )
    return invalid()
  return {
    ...session,
    action: input.action as WorkbenchConversationUpdateGoalRequest['action'],
    baseRevision: input.baseRevision,
  }
}

function parseBackupRequest(raw: unknown): WorkbenchConversationBackupRequest {
  if (!isPlainObject(raw) || !isNonBlankString(raw.key) || !isString(raw.payload)) return invalid()
  return { key: raw.key, payload: raw.payload }
}
