#!/usr/bin/env node
// 用途：按 buildPackageTopology 的拓扑序对每个 workspace 包依次跑同名 script（如 typecheck），
// 任一失败即退出非零。顺序执行、输出不交错，替代 bun run --filter 的并行噪音。
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = resolve(SCRIPT_DIR, '..')
const PACKAGES_DIR = resolve(ROOT_DIR, 'packages')

const scriptName = process.argv[2]
if (!scriptName) {
  console.error('用法：node scripts/run-workspace-script.mjs <script-name>')
  process.exit(2)
}

let failed = false
for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory()) continue
  const dir = resolve(PACKAGES_DIR, entry.name)
  const manifestPath = resolve(dir, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!manifest.scripts?.[scriptName]) {
    console.log(`· 跳过 ${manifest.name}（无 ${scriptName} 脚本）`)
    continue
  }
  console.log(`▸ ${scriptName} ${manifest.name}`)
  const result = spawnSync('bun', ['run', scriptName], { cwd: dir, env: process.env, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`✗ ${manifest.name} ${scriptName} 失败`)
    failed = true
  }
}
process.exit(failed ? 1 : 0)
