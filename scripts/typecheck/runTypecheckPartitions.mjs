#!/usr/bin/env node
// 用途：顺序运行独立增量类型检查分区，避免整仓单 Program 占满内存。

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TypecheckPartitions } from './partitions.mjs'

const ScriptDirectory = dirname(fileURLToPath(import.meta.url))
const WorkbenchRoot = resolve(ScriptDirectory, '../..')
const NativeTypeScriptCli = resolve(WorkbenchRoot, 'node_modules/@typescript/native/bin/tsc')
const JavaScriptTypeScriptCli = resolve(WorkbenchRoot, 'node_modules/typescript/bin/tsc')

function formatDuration(milliseconds) {
  return `${(milliseconds / 1000).toFixed(1)}s`
}

const useNativeCompiler = existsSync(NativeTypeScriptCli)
if (!useNativeCompiler && !existsSync(JavaScriptTypeScriptCli)) {
  throw new Error('未安装本地 TypeScript 编译器。')
}

/** `--group node|web` 或 `--partition <name>` 缩小范围；不带参数检查全部分区。 */
function selectPartitions(argv) {
  const options = { group: null, partition: null }
  for (let index = 0; index < argv.length; index += 1) {
    const name = { '--group': 'group', '--partition': 'partition' }[argv[index]]
    const value = argv[index + 1]
    if (!name || !value || value.startsWith('--') || options[name] !== null) {
      throw new Error(`类型检查参数无效：${argv.join(' ')}`)
    }
    options[name] = value
    index += 1
  }
  const selected = TypecheckPartitions.filter(
    (partition) =>
      (options.group === null || partition.group === options.group) &&
      (options.partition === null || partition.name === options.partition)
  )
  if (selected.length === 0) throw new Error(`没有匹配的类型检查分区：${argv.join(' ')}`)
  return selected
}

const selected = selectPartitions(process.argv.slice(2).filter((argument) => argument !== '--'))
const startedAt = performance.now()
for (const partition of selected) {
  const partitionStartedAt = performance.now()
  const compilerLabel = useNativeCompiler ? 'native' : 'javascript fallback'
  process.stdout.write(`typecheck [${partition.name}] (${compilerLabel})\n`)
  const typecheckArguments = ['--project', partition.config, '--pretty', 'false']
  const command = process.execPath
  const commandArguments = [
    '--max-old-space-size=2048',
    resolve(ScriptDirectory, 'compiler.mjs'),
    useNativeCompiler ? NativeTypeScriptCli : JavaScriptTypeScriptCli,
    ...typecheckArguments,
  ]
  const compilerEnvironment = useNativeCompiler
    ? { ...process.env, GOMEMLIMIT: '2GiB', GOMAXPROCS: '2' }
    : process.env
  const result =
    process.platform === 'win32'
      ? spawnSync(command, commandArguments, {
          cwd: WorkbenchRoot,
          env: compilerEnvironment,
          stdio: 'inherit',
          timeout: 45_000,
        })
      : spawnSync('nice', ['-n', '10', command, ...commandArguments], {
          cwd: WorkbenchRoot,
          env: compilerEnvironment,
          stdio: 'inherit',
          timeout: 45_000,
        })
  if (result.error?.code === 'ETIMEDOUT') {
    process.stderr.write(
      `typecheck [${partition.name}] stopped after 45s resource budget; split this partition before retrying.\n`
    )
    process.exit(1)
  }
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
  process.stdout.write(
    `typecheck [${partition.name}] ok ${formatDuration(performance.now() - partitionStartedAt)}\n`
  )
}
process.stdout.write(
  `typecheck ${selected.length} partitions ok ${formatDuration(performance.now() - startedAt)}\n`
)
