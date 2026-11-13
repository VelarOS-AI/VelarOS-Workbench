#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { OwnedChildProcess, unclosedTerminationCommands } from '../processLifecycle.mjs'

const maximumConcurrency = 4
// Windows 同时启动多组 Git/PTY 集成测试会争抢磁盘；逐文件执行保留每项原有超时预算。
const nativeConcurrency = process.platform === 'win32' ? 1 : maximumConcurrency
const testFileTimeoutMilliseconds = 120_000
const testFilePattern = /\.test\.(?:ts|js|mjs|cjs)$/u

export async function discoverTestFiles(rootDirectory) {
  const files = []

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => compareText(left.name, right.name))

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(entryPath)
      else if (entry.isFile() && testFilePattern.test(entry.name)) files.push(entryPath)
    }
  }

  await visit(rootDirectory)
  return files
}

export async function runWithConcurrency(items, requestedConcurrency, execute) {
  const concurrency = Math.max(
    1,
    Math.min(maximumConcurrency, requestedConcurrency, items.length || 1)
  )
  const results = new Array(items.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await execute(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return results
}

async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const testsRoot = path.join(repositoryRoot, 'tests')
  const testFiles = await discoverTestFiles(testsRoot)
  if (testFiles.length === 0) throw new Error(`No test files found under ${testsRoot}.`)

  const activeChildren = new Map()
  let interruptedSignal

  const stopChildren = (signal) => {
    interruptedSignal ??= signal
    for (const owner of activeChildren.values()) void owner.stop(signal).catch(console.error)
  }
  const onSigint = () => stopChildren('SIGINT')
  const onSigterm = () => stopChildren('SIGTERM')
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)

  const startedAt = performance.now()
  let results
  try {
    results = await runWithConcurrency(testFiles, nativeConcurrency, async (file, index) => {
      if (interruptedSignal) return interruptedResult(file, interruptedSignal)
      console.info(`START ${path.relative(repositoryRoot, file)}`)
      const result = await runTestFile({ activeChildren, file, repositoryRoot })
      printResult(result, index + 1, testFiles.length, repositoryRoot)
      return result
    })
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    const cleanup = await Promise.allSettled(
      [...activeChildren.values()].map((owner) => owner.stop('SIGKILL'))
    )
    for (const result of cleanup) if (result.status === 'rejected') console.error(result.reason)
    if (activeChildren.size || unclosedTerminationCommands.size) process.exitCode = 1
  }

  let failureCount = 0
  let testCount = 0
  for (const result of results) {
    if (!result.ok) failureCount += 1
    testCount += result.testCount
  }

  const elapsedSeconds = ((performance.now() - startedAt) / 1_000).toFixed(2)
  const summary =
    failureCount === 0
      ? `${testCount} tests across ${results.length} files passed in ${elapsedSeconds}s.`
      : `${failureCount}/${results.length} test files failed after ${testCount} tests in ${elapsedSeconds}s.`
  console.info(`\n${summary}`)

  if (interruptedSignal) process.exitCode = interruptedSignal === 'SIGINT' ? 130 : 143
  else if (failureCount > 0 || activeChildren.size || unclosedTerminationCommands.size)
    process.exitCode = 1
}

export function runTestFile({
  activeChildren,
  file,
  repositoryRoot,
  spawnChild = spawn,
  timeoutMs = testFileTimeoutMilliseconds,
}) {
  return new Promise((resolve) => {
    const startedAt = performance.now()
    const deadlineAt = Date.now() + timeoutMs
    const relativeFile = path.relative(repositoryRoot, file)
    const preload = path.join(repositoryRoot, 'scripts/test/setRepositoryCwd.mjs')
    // .test.mjs 是原生 Node 集成测试；更新器会把当前运行时复制为 node.exe。
    // 在 Bun 中运行会改变 worker 的 IPC、进程退出和文件锁行为。
    const nativeNode = file.endsWith('.test.mjs')
    const child = spawnChild(
      nativeNode ? process.execPath : 'bun',
      nativeNode ? ['--test', file] : ['test', '--preload', preload, file],
      {
        // Bun 1.3.13 loses piped child stdout when its initial cwd is this repository root.
        // Initialize one level above it, then let the preload restore the cwd expected by tests.
        cwd: nativeNode ? repositoryRoot : path.dirname(repositoryRoot),
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    const stdout = []
    const stderr = []
    const owner = new OwnedChildProcess(child, { deadlineAt, label: `test ${relativeFile}` })
    activeChildren.set(child, owner)
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    void owner.done.then(({ record, timedOut, stopped, error }) => {
      if (record) activeChildren.delete(child)
      const capturedStdout = Buffer.concat(stdout).toString('utf8')
      const capturedStderr = Buffer.concat(stderr).toString('utf8')
      resolve({
        code: record?.code ?? null,
        durationMilliseconds: performance.now() - startedAt,
        file,
        ok: !!record && !timedOut && !stopped && !error && record.code === 0,
        signal: record?.signal ?? null,
        spawnError: error,
        stderr: timedOut
          ? `${capturedStderr}\nTest file exceeded its ${timeoutMs}ms budget: ${relativeFile}\n`
          : capturedStderr,
        stdout: capturedStdout,
        testCount: readTestCount(`${capturedStdout}\n${capturedStderr}`),
      })
    })
  })
}

function interruptedResult(file, signal) {
  return {
    code: null,
    durationMilliseconds: 0,
    file,
    ok: false,
    signal,
    stderr: '',
    stdout: '',
    testCount: 0,
  }
}

function printResult(result, index, total, repositoryRoot) {
  const label = result.ok ? 'PASS' : 'FAIL'
  const duration = (result.durationMilliseconds / 1_000).toFixed(2)
  const relativeFile = path.relative(repositoryRoot, result.file)
  console.info(`\n[${index}/${total}] ${label} ${relativeFile} (${duration}s)`)
  writeCapturedOutput(result.stdout)
  writeCapturedOutput(result.stderr)
  if (result.spawnError) console.error(result.spawnError.stack ?? String(result.spawnError))
  else if (!result.ok) {
    const reason = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`
    console.error(`${relativeFile} ended with ${reason}.`)
  }
}

function writeCapturedOutput(output) {
  if (!output) return
  process.stdout.write(output)
  if (!output.endsWith('\n')) process.stdout.write('\n')
}

function compareText(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function readTestCount(output) {
  const matches = [...output.matchAll(/Ran (\d+) tests? across \d+ files?/gu)]
  return Number(matches.at(-1)?.[1] ?? output.match(/^# tests (\d+)$/mu)?.[1] ?? 0)
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error))
    process.exitCode = 1
  })
}
