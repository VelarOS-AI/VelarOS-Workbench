// 要真的起伪终端的探针。node-pty 在 bun 下收不到数据（bun 对 N-API 模块的事件循环集成不完整），
// 所以先用 bun 把探针打包成 ESM，再用应用自己的 Electron 运行时（ELECTRON_RUN_AS_NODE）跑——
// 这也正是打包后主进程所处的环境。产物放在 build/electron 下，原生模块从仓库 node_modules 解析。
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** 打包并在 Electron 运行时里跑一个探针；`entry` 是仓库里的源文件，进程以探针的退出码结束。 */
export function runElectronRuntimeProbe(entry) {
  const outDir = path.join(repositoryRoot, 'build', 'electron', 'probe')
  const outFile = path.join(outDir, `${path.basename(entry, path.extname(entry))}.mjs`)
  mkdirSync(outDir, { recursive: true })

  const build = spawnSync(
    'bun',
    [
      'build',
      entry,
      '--target=node',
      '--format=esm',
      '--conditions=source',
      '--external',
      '@lydell/node-pty',
      `--outfile=${outFile}`,
    ],
    { cwd: repositoryRoot, stdio: 'inherit' }
  )
  if (build.status !== 0) process.exit(build.status ?? 1)

  const electronExecutablePath = require('electron')
  const entrypoint = fileURLToPath(new URL('./electronProbeEntrypoint.mjs', import.meta.url))
  const run = spawnSync(electronExecutablePath, [entrypoint, outFile], {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 120_000,
    killSignal: 'SIGKILL',
  })
  if (run.error) console.error(run.error)
  process.exit(run.status ?? 1)
}
