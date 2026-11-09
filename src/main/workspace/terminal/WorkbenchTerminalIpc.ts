/**
 * 持久终端 IPC 装配：启动、输入、尺寸、停止、目录与输出确认；流式输出只回发给发起窗口。
 *
 * IPC 入参是边界外来数据，在此解析一次（形状不符按无效请求处理），服务内部只见类型。异常经
 * `callWithEnvelope` 降为错误信封，renderer 侧再升回 Result。终端输出走 `event.sender.send`
 * （与 WorkbenchFsIpc 的 runCommand 同模式）：每条事件带 sessionId，renderer 单一监听按 sessionId
 * 路由到对应终端/运行卡。
 */
import { ipcMain } from 'electron'

import {
  type WorkbenchTerminalInputRequest,
  type WorkbenchTerminalResizeRequest,
  type WorkbenchTerminalStartRequest,
  type WorkbenchTerminalStopRequest,
} from '@shared/contracts/workbench'

import { readWorkbenchRunEnvironment } from '../../../shared/workbenchRunEnvironment'
import { WorkbenchTerminalChannels } from '../../../shared/workbenchTerminal'
import {
  callWithEnvelope,
  callWithEnvelopeSync,
  hasStringFields,
  invalidRequest,
  optionalBoolean,
  optionalNumber,
  optionalString,
} from '../ipcBoundary'
import { readWorkbenchProcessTarget } from '../WorkbenchProcessLaunch'

import type { TerminalSessions } from './TerminalSessions'

export function registerWorkbenchTerminalIpc(terminal: TerminalSessions): void {
  ipcMain.handle(WorkbenchTerminalChannels.start, (event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseStartRequest(request)
      if (!parsed) return invalidRequest()

      const sender = event.sender
      return terminal.startTerminalSession(
        parsed,
        (outputEvent) => {
          if (!sender.isDestroyed()) {
            sender.send(WorkbenchTerminalChannels.output, outputEvent)
          }
        },
        sender.id
      )
    })
  )

  ipcMain.handle(WorkbenchTerminalChannels.write, (event, request: unknown) =>
    callWithEnvelopeSync(() => {
      const parsed = parseInputRequest(request)
      if (!parsed) return invalidRequest()

      terminal.writeTerminalInput(parsed, event.sender.id)
    })
  )

  ipcMain.handle(WorkbenchTerminalChannels.resize, (event, request: unknown) =>
    callWithEnvelopeSync(() => {
      const parsed = parseResizeRequest(request)
      if (!parsed) return invalidRequest()

      terminal.resizeTerminalSession(parsed, event.sender.id)
    })
  )

  ipcMain.handle(WorkbenchTerminalChannels.stop, (event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseStopRequest(request)
      if (!parsed) return invalidRequest()

      return terminal.stopTerminalSession(parsed, event.sender.id)
    })
  )

  ipcMain.handle(WorkbenchTerminalChannels.cwd, (event, request: unknown) =>
    callWithEnvelope(() => {
      if (!hasStringFields(request, ['sessionId'])) return invalidRequest()

      return terminal.readTerminalCwd(
        { sessionId: request['sessionId'] as string },
        event.sender.id
      )
    })
  )

  // 单向消息，不回复：会话已经结束、请求不对都直接忽略。
  ipcMain.on(WorkbenchTerminalChannels.acknowledge, (event, request: unknown) => {
    if (!hasStringFields(request, ['sessionId'])) return
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
  // 环境变量有一项不合规（名字不对、值不是字符串）就整份拒绝：悄悄丢掉一个变量，程序会带着错的配置跑起来。
  const env = readWorkbenchRunEnvironment(input['env'])
  if (!env) return null
  if (input['initialCommand'] !== undefined && typeof input['initialCommand'] !== 'string')
    return null
  if (input['initialCommand'] !== undefined && input['initialProcess'] !== undefined) return null
  const initialProcess = input['initialProcess'] === undefined
    ? null
    : readWorkbenchProcessTarget(input['initialProcess'])
  if (input['initialProcess'] !== undefined && !initialProcess) return null

  const request: WorkbenchTerminalStartRequest = {
    projectRoot: input['projectRoot'] as string,
    ...optionalString(input, 'cwd'),
    ...optionalString(input, 'initialCommand'),
    ...optionalNumber(input, 'cols'),
    ...optionalNumber(input, 'rows'),
  }
  if (initialProcess) request.initialProcess = initialProcess
  if (Object.keys(env).length > 0) request.env = env
  return request
}

function parseInputRequest(input: unknown): Nullable<WorkbenchTerminalInputRequest> {
  if (!hasStringFields(input, ['sessionId', 'input'])) return null

  return {
    sessionId: input['sessionId'] as string,
    input: input['input'] as string,
  }
}

function parseResizeRequest(input: unknown): Nullable<WorkbenchTerminalResizeRequest> {
  if (!hasStringFields(input, ['sessionId'])) return null
  if (typeof input['cols'] !== 'number' || typeof input['rows'] !== 'number') return null

  return {
    sessionId: input['sessionId'] as string,
    cols: input['cols'],
    rows: input['rows'],
  }
}

function parseStopRequest(input: unknown): Nullable<WorkbenchTerminalStopRequest> {
  if (!hasStringFields(input, ['sessionId'])) return null

  return {
    sessionId: input['sessionId'] as string,
    signal: input['signal'] === 'SIGINT' ? 'SIGINT' : 'SIGTERM',
    ...optionalBoolean(input, 'waitForExit'),
  }
}
