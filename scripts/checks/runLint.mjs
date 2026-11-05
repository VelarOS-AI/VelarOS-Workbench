// 用途：逐分区隔离运行全部 ESLint 规则，避免同一进程长期缓存多个类型程序。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

import { TypecheckPartitions } from '../typecheck/partitions.mjs'
import { qualityDeadline, runQualityProcess } from './qualityProcess.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const partitions = [...TypecheckPartitions, { name: 'tests', config: 'tsconfig/tests.json' }]
const groups = []
const visited = new Set()
for (const partition of partitions) {
  const path = resolve(root, partition.config)
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      },
    }
  )
  if (!parsed || parsed.errors.length) throw new Error(`Invalid lint partition: ${path}`)
  const files = parsed.fileNames.filter(
    (file) => /\.tsx?$/u.test(file) && !/\.d\.ts$/u.test(file) && !visited.has(file)
  )
  files.forEach((file) => visited.add(file))
  const declarations = parsed.fileNames.filter(
    (file) => /\.d\.ts$/u.test(file) || /\bdeclare\b/u.test(readFileSync(file, 'utf8'))
  )
  // 每个子组只以自己的文件和原分区的声明文件为程序根，保留导入图与类型选项。
  // 仅缩小 lintFiles 而仍加载整份 tsconfig，不会缩小类型程序的冷启动开销。
  const groupSize = partition.name.endsWith('tests') ? 35 : 50
  if (files.length > groupSize) {
    for (let offset = 0; offset < files.length; offset += groupSize)
      groups.push({
        ...partition,
        options: parsed.options,
        declarations,
        name: `${partition.name}-${Math.floor(offset / groupSize) + 1}`,
        files: files.slice(offset, offset + groupSize),
      })
  } else groups.push({ ...partition, files, options: parsed.options, declarations })
}
groups.push({ name: 'scripts', files: ['**/*.{js,jsx,mjs,cjs}', '**/*.d.ts'] })
const args = process.argv.slice(2)
const fix = args.includes('--fix')
const partitionFlag = args.indexOf('--partition')

if (partitionFlag >= 0) {
  const group = groups.find((candidate) => candidate.name === args[partitionFlag + 1])
  if (!group) throw new Error('Unknown lint partition')
  const { ESLint } = await import('eslint')
  const program = group.options
    ? ts.createProgram([...group.files, ...group.declarations], group.options)
    : null
  const engine = new ESLint({
    cwd: root,
    fix,
    errorOnUnmatchedPattern: false,
    overrideConfig: group.config
      ? [
          {
            files: ['**/*.{ts,tsx}'],
            languageOptions: {
              parserOptions: { project: false, programs: [program], tsconfigRootDir: root },
            },
          },
        ]
      : [],
  })
  const results = group.files.length ? await engine.lintFiles(group.files) : []
  console.info(`[lint] ${group.name}: ${results.length} files`)
  if (fix) await ESLint.outputFixes(results)
  const failures = ESLint.getErrorResults(results)
  if (failures.length) {
    console.error((await engine.loadFormatter('stylish')).format(failures))
    process.exitCode = 1
  }
} else {
  if (args.some((arg) => arg !== '--fix')) throw new Error('Unknown lint option')
  const results = []
  const controller = new AbortController()
  const stop = () => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  for (const group of groups) {
    const result = await runQualityProcess(
      process.execPath,
      [
        '--max-old-space-size=2048',
        fileURLToPath(import.meta.url),
        '--partition',
        group.name,
        ...(fix ? ['--fix'] : []),
      ],
      { cwd: root, deadline: qualityDeadline(45_000), signal: controller.signal }
    )
    results.push({ name: group.name, ...result })
    console.info(`[lint] ${group.name} ${result.durationMs}ms exit=${result.exitCode}`)
    if (result.exitCode !== 0 || result.timedOut) console.error(result.output)
  }
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
  const report = resolve(root, '.velaros/workspace/checks/lint.json')
  mkdirSync(dirname(report), { recursive: true })
  writeFileSync(report, JSON.stringify(results, null, 2) + '\n')
  if (
    controller.signal.aborted ||
    results.some((result) => result.exitCode !== 0 || result.timedOut)
  )
    process.exitCode = 1
}
