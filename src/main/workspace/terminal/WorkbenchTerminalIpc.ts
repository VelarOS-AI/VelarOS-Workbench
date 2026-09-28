/**
 * 持久终端 IPC 装配：handle start / write / resize / stop 四通道，start 的流式输出只回发给发起窗口。
 *
 * IPC 入参是边界外来数据，在此解析一次（形状不符按无效请求处理），服务内部只见类型。异常经
 * `callWithEnvelope` 降为错误信封，renderer 侧再升回 Result。终端输出走 `event.sender.send`
 * （与 WorkbenchFsIpc 的 runCommand 同模式）：每条事件带 sessionId，renderer 单一监听按 sessionId
 * 路由到对应终端/运行卡。
 */
import { ipcMain } from 'electron'

import { toOptional } from '@velaros-ai/core'

import type {
  WorkbenchTerminalInputRequest,
  WorkbenchTerminalResizeRequest,
  WorkbenchTerminalStartRequest,
  WorkbenchTerminalStopRequest,
} from '@shared/contracts'

import { WorkbenchTerminalChannels } from '../../../shared/workbenchTerminal'
import {
  callWithEnvelope,
  hasStringFields,
  invalidRequest,
  isRecord,
  optionalBoolean,
  optionalNumber,
  optionalString,
} from '../ipcBoundary'

import type { TerminalSessions } from './TerminalSessions'

export function registerWorkbenchTerminalIpc(terminal: TerminalSessions): void {
  ipcMain.handle(WorkbenchTerminalChannels.start, (event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseStartRequest(request)
      if (!parsed) return invalidRequest()

      const sender = event.sender
      return terminal.startTerminalSession(parsed, (outputEvent) => {
        if (!sender.isDestroyed()) {
          sender.send(WorkbenchTerminalChannels.output, outputEvent)
        }
      }, sender.id)
    })
  )

  ipcMain.handle(WorkbenchTerminalChannels.write, (event, request: unknown) =>
    callWithEnvelope(async () => {
      const parsed = parseInputRequest(request)
      if (!parsed) return invalidRequest()

      terminal.writeTerminalInput(parsed, event.sender.id)
    })
  )

  ipcMain.handle(WorkbenchTerminalChannels.resize, (event, request: unknown) =>
    callWithEnvelope(async () => {
      const parsed = parseResizeRequest(request)
      if (!parsed) return invalidRequest()

      terminal.resizeTerminalSession(parsed, event.sender.id)
    })
  )

  ipcMain.handle(WorkbenchTerminalChannels.stop, (event, request: unknown) =>
    callWithEnvelope(async () => {
      const parsed = parseStopRequest(request)
      if (!parsed) return invalidRequest()

      await terminal.stopTerminalSession(parsed, event.sender.id)
    })
  )

  // 单向消息，不回复：会话已经结束、请求不对都直接忽略。
  ipcMain.on(WorkbenchTerminalChannels.acknowledge, (event, request: unknown) => {
    if (!hasStringFields(request, ['sessionId']) || !isRecord(request)) return
    const chars = request['chars']
    if (typeof chars !== 'number' || !Number.isFinite(chars) || chars <= 0) return
    try {
      terminal.acknowledgeTerminalOutput(
        { sessionId: request['sessionId'] as string, chars },
        event.sender.id
      )
    } catch {
      // arch-guard:silent-catch-ok 别的窗口的会话：确认不属于它，丢掉即可。
    }
  })
}

function parseStartRequest(input: unknown): Nullable<WorkbenchTerminalStartRequest> {
  if (!hasStringFields(input, ['projectRoot'])) return null

  return {
    projectRoot: input['projectRoot'] as string,
    ...optionalString(input, 'cwd'),
    ...optionalString(input, 'initialCommand'),
    ...optionalNumber(input, 'cols'),
    ...optionalNumber(input, 'rows'),
  }
}

function parseInputRequest(input: unknown): Nullable<WorkbenchTerminalInputRequest> {
  if (!hasStringFields(input, ['sessionId', 'input'])) return null

  return {
    sessionId: input['sessionId'] as string,
    input: input['input'] as string,
  }
}

function parseResizeRequest(input: unknown): Nullable<WorkbenchTerminalResizeRequest> {
  if (!hasStringFields(input, ['sessionId']) || !isRecord(input)) return null
  if (typeof input['cols'] !== 'number' || typeof input['rows'] !== 'number') return null

  return {
    sessionId: input['sessionId'] as string,
    cols: input['cols'],
    rows: input['rows'],
  }
}

function parseStopRequest(input: unknown): Nullable<WorkbenchTerminalStopRequest> {
  if (!hasStringFields(input, ['sessionId']) || !isRecord(input)) return null

  const signal = parseStopSignal(input['signal'])

  return {
    sessionId: input['sessionId'] as string,
    signal: toOptional(signal),
    ...optionalBoolean(input, 'skipForceKill'),
    ...optionalBoolean(input, 'waitForExit'),
  }
}

function parseStopSignal(input: unknown): Nullable<'SIGINT' | 'SIGTERM'> {
  return input === 'SIGINT' || input === 'SIGTERM' ? input : null
}
