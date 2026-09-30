// 调试器探针：被调试的程序跑在真的伪终端里，所以与终端探针一样在 Electron 运行时里跑。
import { runElectronRuntimeProbe } from './runElectronRuntimeProbe.mjs'

runElectronRuntimeProbe('src/main/workspace/debug/debugProbe.ts')
