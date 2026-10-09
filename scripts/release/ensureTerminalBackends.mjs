// 终端后端 @lydell/node-pty 每个平台一个包，bun 只装当前平台那个（其余按 os/cpu 跳过）。
// 在 macOS 上打 Windows / Linux / 通用包之前，把目标平台的包从 npm 拉下来放进 node_modules，
// electron-builder 才会把它们当 @lydell/node-pty 的可选依赖一起打进 app.asar.unpacked。
// 已经在的不重复下载；只准备目标平台的发布资源，不碰 bun.lock。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extract } from 'tar'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DispatcherPackage = '@lydell/node-pty'

/** 打包目标 → 需要的平台包后缀。`universal` 的 mac 包要两个架构。 */
const TargetPlatforms = {
  darwin: ['darwin-arm64', 'darwin-x64'],
  win32: ['win32-x64', 'win32-arm64'],
  linux: ['linux-x64', 'linux-arm64'],
}

function readDispatcherManifest() {
  // 包的 exports 没有开放 package.json，按路径直接读。
  const manifestPath = path.join(repositoryRoot, 'node_modules', DispatcherPackage, 'package.json')
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

export function ensureTerminalBackends(platformNames) {
  const manifest = readDispatcherManifest()
  const optional = manifest.optionalDependencies ?? {}
  const wanted = platformNames.flatMap((platformName) => TargetPlatforms[platformName] ?? [])
  const missing = wanted
    .map((target) => `${DispatcherPackage}-${target}`)
    .filter((packageName) => packageName in optional)
    .filter((packageName) => !existsSync(path.join(repositoryRoot, 'node_modules', packageName, 'package.json')))
  if (missing.length === 0) return []

  const scratch = mkdtempSync(path.join(tmpdir(), 'workbench-terminal-backends-'))
  try {
    for (const packageName of missing) {
      const spec = `${packageName}@${optional[packageName]}`
      const pack = spawnSync('npm', ['pack', spec, '--pack-destination', scratch, '--silent'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        // Windows exposes npm as npm.cmd; Node must launch its command interpreter.
        shell: process.platform === 'win32',
      })
      if (pack.status !== 0) throw new Error(`npm pack ${spec} failed: ${pack.error?.message ?? pack.stderr}`)
      const tarball = path.join(scratch, pack.stdout.trim().split('\n').at(-1))
      const destination = path.join(repositoryRoot, 'node_modules', packageName)
      mkdirSync(destination, { recursive: true })
      // Git Bash 的 tar 不接受原生 Windows 路径；直接解压，不依赖 PATH 中的外部工具。
      extract({ file: tarball, cwd: destination, strip: 1, sync: true })
      console.info(`terminal backend ready: ${spec}`)
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  return missing
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const platforms = process.argv.slice(2)
  if (platforms.length === 0 || platforms.some((name) => !(name in TargetPlatforms))) {
    console.error('Usage: ensureTerminalBackends.mjs <darwin|win32|linux> [...]')
    process.exit(1)
  }
  ensureTerminalBackends(platforms)
}
