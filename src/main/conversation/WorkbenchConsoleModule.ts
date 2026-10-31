import type { OperationContext, OperationModuleDefinition } from '@velaros-ai/kernel'
import { createCapabilityModule } from '@velaros-ai/velaros'
import type { ShellBackgroundTaskRecord } from '@velaros-ai/velaros/execution/contracts'

import { WorkbenchConsoleCapability } from './WorkbenchConsoleCapability'
import type { WorkbenchShellHostRegistryApi } from './WorkbenchShellHostRegistry'

interface ConsoleTaskSummary {
  taskId: string
  command: string
  status: string
}

function taskSummary(task: ShellBackgroundTaskRecord): ConsoleTaskSummary {
  return { taskId: task.id, command: task.command, status: task.status }
}

/** 能力绑定宿主会话而非模型给出的身份，子任务共享该工作区的受管后台进程。 */
export function createWorkbenchConsoleModule(
  shells: WorkbenchShellHostRegistryApi,
  sessionId: string,
  cwd: string,
  sandbox: boolean,
  confirm: (command: string, signal: AbortSignal) => Promise<void>,
): OperationModuleDefinition {
  return createCapabilityModule({
    surface: WorkbenchConsoleCapability,
    instanceId: sessionId,
    context: (call) => call,
    implementation: {
      async start(
        input: { command: string },
        call: OperationContext,
      ): Promise<ConsoleTaskSummary> {
        call.signal.throwIfAborted()
        await confirm(input.command, call.signal)
        call.signal.throwIfAborted()
        call.recordEffect('unknown')
        const { task } = await shells.startConsoleCommand({
          sessionId,
          cwd,
          command: input.command,
          sandbox,
        })
        call.recordEffect('committed')
        return taskSummary(task)
      },
      async list(call: OperationContext): Promise<ConsoleTaskSummary[]> {
        call.signal.throwIfAborted()
        call.recordEffect('none')
        return (await shells.listBackgroundTasks({ sessionId }, cwd)).map(taskSummary)
      },
      async read(
        input: { taskId: string; cursor?: number },
        call: OperationContext,
      ): Promise<{
        text: string
        cursor: number
        droppedChars: number
        status: string
      }> {
        call.signal.throwIfAborted()
        call.recordEffect('none')
        const result = await shells.readConsoleOutput({ ...input, sessionId }, cwd)
        return {
          text: result.text,
          cursor: result.cursor,
          droppedChars: result.droppedChars,
          status: result.status,
        }
      },
      async stop(
        input: { taskId: string },
        call: OperationContext,
      ): Promise<{ terminated: boolean; status: string; message: string }> {
        call.signal.throwIfAborted()
        call.recordEffect('unknown')
        const result = await shells.terminateBackgroundTask(
          { ...input, sessionId, force: true },
          cwd,
        )
        call.recordEffect('committed')
        return {
          terminated: result.terminated,
          status: result.statusAfter,
          message: result.message,
        }
      },
    },
  })
}
