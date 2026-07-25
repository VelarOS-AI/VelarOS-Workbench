#!/usr/bin/env node
// 用途：从 packages/*/package.json 的 @velaros-ai/* 依赖派生真实依赖图，拓扑排序后依序构建各包（支持 --for 依赖闭包与全量两种模式）。

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = resolve(SCRIPT_DIR, '../..')
const PACKAGES_DIR = resolve(ROOT_DIR, 'packages')
const VELAROS_SCOPE = '@velaros-ai/'

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function collectVelarosDeps(manifest) {
  const sections = [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies]
  const names = new Set()
  for (const section of sections) {
    if (!section) continue
    for (const key of Object.keys(section)) {
      if (key.startsWith(VELAROS_SCOPE)) names.add(key)
    }
  }
  return [...names].sort()
}

function scanPackages() {
  const byName = new Map()
  const byDir = new Map()

  for (const entry of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = resolve(PACKAGES_DIR, entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue

    let manifest
    try {
      manifest = readJson(manifestPath)
    } catch {
      continue
    }
    if (!manifest.name) continue

    const node = {
      name: manifest.name,
      dir: resolve(PACKAGES_DIR, entry.name),
      dirName: entry.name,
      deps: collectVelarosDeps(manifest),
      hasBuild: Boolean(manifest.scripts && manifest.scripts.build),
    }
    byName.set(node.name, node)
    byDir.set(entry.name, node.name)
  }

  return { byDir, byName }
}

function resolveTargetName(graph, raw) {
  if (graph.byName.has(raw)) return raw
  const scoped = raw.startsWith(VELAROS_SCOPE) ? raw : `${VELAROS_SCOPE}${raw}`
  if (graph.byName.has(scoped)) return scoped
  if (graph.byDir.has(raw)) return graph.byDir.get(raw)
  const known = [...graph.byName.keys()].sort().join(', ')
  throw new Error(`未找到目标包「${raw}」。可选：${known}`)
}

// 从目标集合出发做 deps-first 深度优先，返回拓扑构建顺序；未知 @velaros 依赖当作预构建外部叶子跳过；成环即报错。
function resolveBuildOrder(graph, targetNames) {
  const order = []
  const external = new Set()
  const state = new Map()
  const stack = []

  function visit(name) {
    const node = graph.byName.get(name)
    if (!node) {
      external.add(name)
      return
    }

    const current = state.get(name)
    if (current === 'done') return
    if (current === 'visiting') {
      const cycleStart = stack.indexOf(name)
      const cyclePath = [...stack.slice(cycleStart), name].join(' -> ')
      throw new Error(`检测到 @velaros 依赖环：${cyclePath}`)
    }

    state.set(name, 'visiting')
    stack.push(name)
    for (const dep of node.deps) visit(dep)
    stack.pop()
    state.set(name, 'done')
    order.push(node)
  }

  for (const target of targetNames) visit(target)
  return { external: [...external].sort(), order }
}

function buildPackage(node) {
  if (!node.hasBuild) {
    console.log(`· 跳过 ${node.name}（无 build 脚本）`)
    return
  }

  console.log(`▸ 构建 ${node.name}`)
  const result = spawnSync('bun', ['run', 'build'], {
    cwd: node.dir,
    env: process.env,
    stdio: 'inherit',
  })

  if (result.error) {
    throw new Error(`无法启动 ${node.name} 构建：${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = result.status === null ? `signal ${result.signal}` : `exit ${result.status}`
    throw new Error(`构建失败 ${node.name}（${detail}）`)
  }
}

function printHelp() {
  console.log(`VelarOS 包拓扑构建 runner

从 packages/*/package.json 的 @velaros-ai/* 依赖派生真实依赖图，拓扑排序后依序构建。

用法：
  node scripts/build/buildPackageTopology.mjs                 # 全量：拓扑序构建所有包
  node scripts/build/buildPackageTopology.mjs --for <pkg>     # 只建某包的依赖闭包 + 自身
  node scripts/build/buildPackageTopology.mjs --list          # 打印拓扑序，不构建

<pkg> 可用 @velaros 全名（@velaros-ai/cli）、后缀（cli）或目录名。
`)
}

function parseArgs(argv) {
  const targets = []
  let list = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--list') {
      list = true
      continue
    }
    if (arg === '--for') {
      const value = argv[index + 1]
      if (!value) throw new Error('--for 需要一个包名')
      targets.push(value)
      index += 1
      continue
    }
    if (arg.startsWith('--for=')) {
      targets.push(arg.slice('--for='.length))
      continue
    }
    throw new Error(`未知参数：${arg}`)
  }

  return { list, targets }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }

  const graph = scanPackages()

  const targetNames =
    options.targets.length > 0
      ? options.targets.map((raw) => resolveTargetName(graph, raw))
      : [...graph.byName.keys()].sort()

  const { external, order } = resolveBuildOrder(graph, targetNames)

  const mode = options.targets.length > 0 ? `--for ${targetNames.join(', ')}` : '全量'
  console.log(`拓扑构建（${mode}）：${order.map((node) => node.name).join(' -> ')}`)
  if (external.length > 0) {
    console.log(`外部/预构建依赖（跳过）：${external.join(', ')}`)
  }

  if (options.list) return

  for (const node of order) buildPackage(node)
  console.log(`完成：构建 ${order.filter((node) => node.hasBuild).length} 个包。`)
}

try {
  main()
} catch (error) {
  console.error(`拓扑构建失败：${error.message}`)
  process.exit(1)
}
