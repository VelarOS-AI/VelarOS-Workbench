// 终端探针要真的起伪终端。node-pty 在 bun 下收不到数据（bun 对 N-API 模块的事件循环集成不完整），
// 所以先用 bun 把探针打包成 ESM，再用应用自己的 Electron 运行时（ELECTRON_RUN_AS_NODE）跑——
// 这也正是打包后主进程所处的环境。产物放在 build/electron 下，原生模块从仓库 node_modules 解析。
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const outDir = path.join(repositoryRoot, 'build', 'electron', 'probe')
const outFile = path.join(outDir, 'terminalProbe.mjs')
mkdirSync(outDir, { recursive: true })

const build = spawnSync(
  'bun',
  [
    'build',
    'src/main/workspace/terminal/terminalProbe.ts',
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
const run = spawnSync(electronExecutablePath, [outFile], {
  cwd: repositoryRoot,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})
process.exit(run.status ?? 1)
