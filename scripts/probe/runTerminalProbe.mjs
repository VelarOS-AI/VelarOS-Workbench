// 终端探针要真的起伪终端：在 Electron 运行时里跑（原因见 runElectronRuntimeProbe.mjs）。
import { runElectronRuntimeProbe } from './runElectronRuntimeProbe.mjs'

runElectronRuntimeProbe('src/main/workspace/terminal/terminalProbe.ts')
