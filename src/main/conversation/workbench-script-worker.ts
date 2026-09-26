import { AppError } from '@velaros-ai/core/error'
import type { ScriptWorkerCommand } from '@velaros-ai/script/worker'
import { startScriptWorker } from '@velaros-ai/script/worker'

/** 模型脚本的隔离执行进程：由 Electron utilityProcess 拉起，执行本身全归 Platform（与 Desktop 同一入口）。 */
const port = process.parentPort
if (!port) throw new AppError('UNAVAILABLE', '脚本 worker 必须由 Electron utilityProcess 启动。')

await startScriptWorker({
  send: (message) => port.postMessage(message),
  onMessage: (listener) => {
    const receive = (event: { data: ScriptWorkerCommand }): void => listener(event.data)
    port.on('message', receive)
    return () => port.off('message', receive)
  },
  exit: (code) => process.exit(code),
})
