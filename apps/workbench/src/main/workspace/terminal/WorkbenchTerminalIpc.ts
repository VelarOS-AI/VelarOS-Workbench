/**
 * 持久终端 IPC 装配：handle start / write / stop 三通道，start 的流式输出只回发给发起窗口。
 *
 * IPC 入参是边界外来数据，在此解析一次（形状不符按无效请求处理），服务内部只见类型。异常经
 * `callWithEnvelope` 降为错误信封，renderer 侧再升回 Result。终端输出走 `event.sender.send`
 * （与 WorkbenchFsIpc 的 runCommand 同模式）：每条事件带 sessionId，renderer 单一监听按 sessionId
 * 路由到对应终端/运行卡。
 */
import { ipcMain } from 'electron'

import type {
  WorkbenchTerminalInputRequest,
  WorkbenchTerminalStartRequest,
  WorkbenchTerminalStopRequest,
} from '@velaros-ai/core/types'

import { WorkbenchTerminalChannels } from '../../../shared/workbenchTerminal'
import {
  callWithEnvelope,
  hasStringFields,
  invalidRequest,
  isRecord,
  optionalBoolean,
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
      })
    })
  )

  ipcMain.handle(WorkbenchTerminalChannels.write, (_event, request: unknown) =>
    callWithEnvelope(async () => {
      const parsed = parseInputRequest(request)
      if (!parsed) return invalidRequest()

      terminal.writeTerminalInput(parsed)
    })
  )

  ipcMain.handle(WorkbenchTerminalChannels.stop, (_event, request: unknown) =>
    callWithEnvelope(async () => {
      const parsed = parseStopRequest(request)
      if (!parsed) return invalidRequest()

      terminal.stopTerminalSession(parsed)
    })
  )
}

function parseStartRequest(input: unknown): Nullable<WorkbenchTerminalStartRequest> {
  if (!hasStringFields(input, ['projectRoot'])) return null

  return {
    projectRoot: input['projectRoot'] as string,
    ...optionalString(input, 'cwd'),
    ...optionalString(input, 'initialCommand'),
  }
}

function parseInputRequest(input: unknown): Nullable<WorkbenchTerminalInputRequest> {
  if (!hasStringFields(input, ['sessionId', 'input'])) return null

  return {
    sessionId: input['sessionId'] as string,
    input: input['input'] as string,
    ...optionalBoolean(input, 'raw'),
  }
}

function parseStopRequest(input: unknown): Nullable<WorkbenchTerminalStopRequest> {
  if (!hasStringFields(input, ['sessionId']) || !isRecord(input)) return null

  const signal = parseStopSignal(input['signal'])

  return {
    sessionId: input['sessionId'] as string,
    ...(signal ? { signal } : {}),
    ...optionalBoolean(input, 'skipForceKill'),
  }
}

function parseStopSignal(input: unknown): Nullable<'SIGINT' | 'SIGTERM'> {
  return input === 'SIGINT' || input === 'SIGTERM' ? input : null
}
