/**
 * 调试器 IPC 装配。入参是边界外来数据，在这里解析一次（形状不符按无效请求处理），服务内部只见类型；异常经
 * `callWithEnvelope` 降为错误信封。
 *
 * 每个会话归发起它的窗口（`event.sender.id`）：状态变化只推给那个窗口，被调试程序的输出走那个窗口的终端
 * 输出通道——界面上它就是一张运行卡。
 */
import { ipcMain } from 'electron'

import {
  type WorkbenchDebuggerBreakpoint,
  WorkbenchDebuggerChannels,
  type WorkbenchDebuggerControlAction,
  type WorkbenchDebuggerLaunchTarget,
  type WorkbenchDebuggerStartRequest,
} from '../../../shared/workbenchDebugger'
import { readWorkbenchRunEnvironment } from '../../../shared/workbenchRunEnvironment'
import { WorkbenchTerminalChannels } from '../../../shared/workbenchTerminal'
import type { WorkbenchWindowManager } from '../../projects/WorkbenchWindowManager'
import {
  callWithEnvelope,
  hasStringFields,
  invalidRequest,
  isRecord,
  optionalNumber,
  optionalString,
} from '../ipcBoundary'
import { readWorkbenchProcessTarget } from '../WorkbenchProcessLaunch'

import type { WorkbenchDebugSessions } from './WorkbenchDebugSessions'

/** 一次最多带这么多个断点：再多不是人手点出来的。 */
const MaxBreakpoints = 2_000
const MaxExpressionLength = 10_000
const ControlActions = new Set<WorkbenchDebuggerControlAction>([
  'continue',
  'pause',
  'step-into',
  'step-out',
  'step-over',
])

export function registerWorkbenchDebugIpc(
  debug: WorkbenchDebugSessions,
  windows: Pick<WorkbenchWindowManager, 'assertProjectForWebContents'>
): () => void {
  ipcMain.handle(WorkbenchDebuggerChannels.start, (event, request: unknown) =>
    callWithEnvelope(() => {
      const parsed = parseStartRequest(request)
      if (!parsed) return invalidRequest()

      const sender = event.sender
      windows.assertProjectForWebContents(sender, parsed.projectRoot)
      return debug.startDebugSession(
        parsed,
        {
          emit: (debugEvent) => {
            if (!sender.isDestroyed()) sender.send(WorkbenchDebuggerChannels.event, debugEvent)
          },
          terminalOutput: (outputEvent) => {
            if (!sender.isDestroyed()) sender.send(WorkbenchTerminalChannels.output, outputEvent)
          },
        },
        sender.id
      )
    })
  )

  ipcMain.handle(WorkbenchDebuggerChannels.stop, (event, request: unknown) =>
    callWithEnvelope(async () => {
      if (!hasStringFields(request, ['sessionId'])) return invalidRequest()

      await debug.stopDebugSession({ sessionId: request['sessionId'] as string }, event.sender.id)
    })
  )

  ipcMain.handle(WorkbenchDebuggerChannels.control, (event, request: unknown) =>
    callWithEnvelope(async () => {
      if (!hasStringFields(request, ['sessionId', 'action'])) return invalidRequest()
      const action = request['action'] as WorkbenchDebuggerControlAction
      if (!ControlActions.has(action)) return invalidRequest()

      await debug.controlDebugSession(
        { sessionId: request['sessionId'] as string, action },
        event.sender.id
      )
    })
  )

  ipcMain.handle(WorkbenchDebuggerChannels.setBreakpoints, (event, request: unknown) =>
    callWithEnvelope(() => {
      if (!hasStringFields(request, ['sessionId'])) return invalidRequest()
      const breakpoints = parseBreakpoints(request['breakpoints'])
      if (!breakpoints) return invalidRequest()

      return debug.setBreakpoints(
        { sessionId: request['sessionId'] as string, breakpoints },
        event.sender.id
      )
    })
  )

  ipcMain.handle(WorkbenchDebuggerChannels.setExceptionPause, (event, request: unknown) =>
    callWithEnvelope(async () => {
      if (!hasStringFields(request, ['sessionId']) || typeof request['uncaught'] !== 'boolean')
        return invalidRequest()

      await debug.setExceptionPause(
        { sessionId: request['sessionId'] as string, uncaught: request['uncaught'] },
        event.sender.id
      )
    })
  )

  ipcMain.handle(WorkbenchDebuggerChannels.variables, (event, request: unknown) =>
    callWithEnvelope(() => {
      if (!hasStringFields(request, ['sessionId', 'objectId'])) return invalidRequest()

      return debug.getVariables(
        { sessionId: request['sessionId'] as string, objectId: request['objectId'] as string },
        event.sender.id
      )
    })
  )

  ipcMain.handle(WorkbenchDebuggerChannels.evaluate, (event, request: unknown) =>
    callWithEnvelope(() => {
      if (!hasStringFields(request, ['sessionId', 'expression'])) return invalidRequest()
      const expression = request['expression'] as string
      if (!expression.trim() || expression.length > MaxExpressionLength) return invalidRequest()

      return debug.evaluate(
        {
          sessionId: request['sessionId'] as string,
          expression,
          ...optionalString(request, 'frameId'),
          sideEffectFree: request['sideEffectFree'] === true,
        },
        event.sender.id
      )
    })
  )

  return () => {
    for (const channel of [
      WorkbenchDebuggerChannels.start,
      WorkbenchDebuggerChannels.stop,
      WorkbenchDebuggerChannels.control,
      WorkbenchDebuggerChannels.setBreakpoints,
      WorkbenchDebuggerChannels.setExceptionPause,
      WorkbenchDebuggerChannels.variables,
      WorkbenchDebuggerChannels.evaluate,
    ])
      ipcMain.removeHandler(channel)
  }
}

function parseStartRequest(input: unknown): Nullable<WorkbenchDebuggerStartRequest> {
  if (!hasStringFields(input, ['projectRoot'])) return null
  const target = parseTarget(input['target'])
  const breakpoints = parseBreakpoints(input['breakpoints'])
  // 环境变量与运行卡同一条规矩：有一项不合规就整份拒绝。
  const env = readWorkbenchRunEnvironment(input['env'])
  if (!target || !breakpoints || !env) return null

  const request: WorkbenchDebuggerStartRequest = {
    projectRoot: input['projectRoot'] as string,
    target,
    breakpoints,
    pauseOnUncaughtExceptions: input['pauseOnUncaughtExceptions'] === true,
    ...optionalString(input, 'cwd'),
    ...optionalNumber(input, 'cols'),
    ...optionalNumber(input, 'rows'),
  }
  if (Object.keys(env).length > 0) request.env = env
  return request
}

function parseTarget(input: unknown): Nullable<WorkbenchDebuggerLaunchTarget> {
  if (!isRecord(input)) return null

  switch (input['kind']) {
    case 'node-script':
    case 'node-package-bin': {
      const target = readWorkbenchProcessTarget(input)
      return target?.kind === 'node-script' || target?.kind === 'node-package-bin' ? target : null
    }
    case 'inspect-process': {
      const process = readWorkbenchProcessTarget(input['process'])
      return process?.kind === 'package-manager' ? { kind: 'inspect-process', process } : null
    }
    case 'inspect-command':
      return hasStringFields(input, ['command']) && !(input['command'] as string).includes('\0')
        ? { kind: 'inspect-command', command: input['command'] as string }
        : null
    default:
      return null
  }
}

function parseBreakpoints(input: unknown): Nullable<WorkbenchDebuggerBreakpoint[]> {
  if (!Array.isArray(input) || input.length > MaxBreakpoints) return null

  const breakpoints: WorkbenchDebuggerBreakpoint[] = []
  for (const item of input) {
    if (!hasStringFields(item, ['path'])) return null
    const line = item['line']
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return null
    breakpoints.push({ path: item['path'] as string, line })
  }
  return breakpoints
}
