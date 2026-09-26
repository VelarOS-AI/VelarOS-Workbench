import type { UtilityProcess } from 'electron'
import { utilityProcess } from 'electron'

import { AppError } from '@velaros-ai/core/error'
import type {
  CodeRunnerApi,
  ScriptProcess,
  ScriptProcessEvents,
  ScriptWorkerCommand,
} from '@velaros-ai/script'
import { createSubprocessCodeRunner } from '@velaros-ai/script'

/** 子进程运行所需的构建产物。 */
interface WorkbenchScriptRunnerOptions {
  /** 构建器提供的独立 ESM worker 入口，开发和打包环境使用同一声明。 */
  workerPath: string
}

/** Electron 只提供子进程、消息和回收；脚本隔离与能力调用由 Platform 管理。 */
class ElectronScriptProcess implements ScriptProcess {
  private readonly child: UtilityProcess
  private readonly closed: Promise<void>
  private exited = false
  private stopping = false

  public constructor(options: WorkbenchScriptRunnerOptions, events: ScriptProcessEvents) {
    this.child = utilityProcess.fork(options.workerPath, [], {
      serviceName: 'VelarOS Workbench Script',
      stdio: ['ignore', 'ignore', 'pipe'],
      execArgv: [`--max-old-space-size=${events.heapMb}`],
    })
    this.child.on('message', (message: unknown) => {
      if (!this.stopping) events.onMessage(message)
    })
    this.child.on('error', (error) => events.onError(error))
    const stderr = this.child.stderr
    stderr?.setEncoding('utf8')
    stderr?.on('data', (text: string) => events.onStderr(text))
    this.child.once('spawn', () => {
      if (this.stopping && !this.exited) this.child.kill()
    })
    this.closed = new Promise((resolve) => {
      this.child.once('exit', (code) => {
        this.exited = true
        // Electron 在 exit 回调后清除 stdio 监听并释放进程句柄；该事件就是回收回执。
        this.child.removeAllListeners()
        events.onExit(code)
        resolve()
      })
    })
  }

  public send(message: ScriptWorkerCommand): void {
    if (this.stopping || this.exited) throw new AppError('UNAVAILABLE', '脚本子进程已关闭。')
    this.child.postMessage(message)
  }

  public terminate(): Promise<void> {
    if (!this.stopping) {
      this.stopping = true
      if (!this.exited) this.child.kill()
    }
    return this.closed
  }
}

/** 将 Electron 宿主进程接到 Platform 的统一脚本运行器。 */
export function createWorkbenchScriptRunner(options: WorkbenchScriptRunnerOptions): CodeRunnerApi {
  return createSubprocessCodeRunner({
    launch: (events) => new ElectronScriptProcess(options, events),
  })
}
