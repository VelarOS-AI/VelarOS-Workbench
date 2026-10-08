/**
 * 独立 Workbench 应用「持久终端会话」的 main ↔ renderer IPC 契约（应用私有）。
 *
 * 这是 `WorkbenchHost.kernel.project` 端口四个终端动词（start / write / resize / stop）+ 输出事件在独立
 * 应用侧的实装传输面：请求/结果形状直接复用 `@shared/contracts` 的 Workbench Kernel contracts
 * （单源，不另造镜像），本文件只补通道名与桥面。错误信封复用 `WorkbenchFsCallResult`（main 侧
 * 异常降为数据，renderer 侧再升回 Result）。
 *
 * 与一次性命令运行（workbenchFs.ts 的 runCommand）拆成两个概念：命令运行是「起进程 → 收口 →
 * 一次性结果」，终端会话是「起 shell → 持续输入/输出 → 手动终止」的持久 PTY 卡片。两者的流式
 * 输出都靠 `event.sender.send(...output 通道...)` 回发给发起窗口，renderer 按 sessionId 路由。
 */
import { type WorkbenchTerminalAcknowledgeRequest, type WorkbenchTerminalCwdRequest, type WorkbenchTerminalCwdResult, type WorkbenchTerminalInputRequest, type WorkbenchTerminalOutputEvent, type WorkbenchTerminalResizeRequest, type WorkbenchTerminalStartRequest, type WorkbenchTerminalStartResult, type WorkbenchTerminalStopRequest } from '@shared/contracts/workbench'

import type { WorkbenchFsCallResult } from './workbenchFs'

export const WorkbenchTerminalChannels = {
  start: 'workbench-app:terminal:start',
  write: 'workbench-app:terminal:write',
  resize: 'workbench-app:terminal:resize',
  stop: 'workbench-app:terminal:stop',
  cwd: 'workbench-app:terminal:cwd',
  output: 'workbench-app:terminal:output',
  /** renderer → main 的单向消息：一段输出已经写进 xterm（流控用，不等回复）。 */
  acknowledge: 'workbench-app:terminal:acknowledge',
} as const

/** preload 通过 contextBridge 暴露给 renderer 的终端会话桥面（4 动词 + 输出订阅）。 */
export interface WorkbenchTerminalBridge {
  startSession: (
    request: WorkbenchTerminalStartRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchTerminalStartResult>>
  writeInput: (
    request: WorkbenchTerminalInputRequest
  ) => Promise<WorkbenchFsCallResult<void>>
  resizeSession: (
    request: WorkbenchTerminalResizeRequest
  ) => Promise<WorkbenchFsCallResult<void>>
  stopSession: (
    request: WorkbenchTerminalStopRequest
  ) => Promise<WorkbenchFsCallResult<void>>
  readCwd: (
    request: WorkbenchTerminalCwdRequest
  ) => Promise<WorkbenchFsCallResult<WorkbenchTerminalCwdResult>>
  onOutput: (listener: (event: WorkbenchTerminalOutputEvent) => void) => () => void
  acknowledgeOutput: (request: WorkbenchTerminalAcknowledgeRequest) => void
}
