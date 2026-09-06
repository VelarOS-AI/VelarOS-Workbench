#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const maximumConcurrency = 4
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

  const activeChildren = new Set()
  let interruptedSignal
  let forceKillTimer

  const stopChildren = (signal) => {
    interruptedSignal ??= signal
    for (const child of activeChildren) terminateProcessTree(child, signal)
    forceKillTimer ??= setTimeout(() => {
      for (const child of activeChildren) terminateProcessTree(child, 'SIGKILL')
    }, 1_500)
  }
  const onSigint = () => stopChildren('SIGINT')
  const onSigterm = () => stopChildren('SIGTERM')
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)

  const startedAt = performance.now()
  let results
  try {
    results = await runWithConcurrency(testFiles, maximumConcurrency, async (file) => {
      if (interruptedSignal) return interruptedResult(file, interruptedSignal)
      return runTestFile({ activeChildren, file, repositoryRoot })
    })
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    if (forceKillTimer) clearTimeout(forceKillTimer)
    for (const child of activeChildren) terminateProcessTree(child, 'SIGKILL')
  }

  let failureCount = 0
  let testCount = 0
  for (const [index, result] of results.entries()) {
    if (!result.ok) failureCount += 1
    testCount += result.testCount
    printResult(result, index + 1, results.length, repositoryRoot)
  }

  const elapsedSeconds = ((performance.now() - startedAt) / 1_000).toFixed(2)
  const summary = failureCount === 0
    ? `${testCount} tests across ${results.length} files passed in ${elapsedSeconds}s.`
    : `${failureCount}/${results.length} test files failed after ${testCount} tests in ${elapsedSeconds}s.`
  console.info(`\n${summary}`)

  if (interruptedSignal) process.exitCode = interruptedSignal === 'SIGINT' ? 130 : 143
  else if (failureCount > 0) process.exitCode = 1
}

function runTestFile({ activeChildren, file, repositoryRoot }) {
  return new Promise((resolve) => {
    const startedAt = performance.now()
    const relativeFile = path.relative(repositoryRoot, file)
    const preload = path.join(repositoryRoot, 'scripts/test/setRepositoryCwd.mjs')
    const child = spawn('bun', ['test', '--preload', preload, file], {
      // Bun 1.3.13 loses piped child stdout when its initial cwd is this repository root.
      // Initialize one level above it, then let the preload restore the cwd expected by tests.
      cwd: path.dirname(repositoryRoot),
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let spawnError

    activeChildren.add(child)
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
    child.once('error', (error) => {
      spawnError = error
    })
    child.once('close', (code, signal) => {
      activeChildren.delete(child)
      terminateProcessTree(child, 'SIGTERM')
      const capturedStdout = Buffer.concat(stdout).toString('utf8')
      const capturedStderr = Buffer.concat(stderr).toString('utf8')
      resolve({
        code,
        durationMilliseconds: performance.now() - startedAt,
        file,
        ok: !spawnError && code === 0,
        signal,
        spawnError,
        stderr: capturedStderr,
        stdout: capturedStdout,
        testCount: readTestCount(`${capturedStdout}\n${capturedStderr}`),
      })
    })
  })
}

function terminateProcessTree(child, signal) {
  const pid = child.pid
  if (!pid) return

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' })
    return
  }

  try {
    process.kill(-pid, signal)
    return
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      console.error(`Unable to signal process group ${pid}: ${error.message ?? String(error)}`)
    }
  }

  try {
    child.kill(signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      console.error(`Unable to signal process ${pid}: ${error.message ?? String(error)}`)
    }
  }
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
  return Number(matches.at(-1)?.[1] ?? 0)
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error?.stack ?? String(error))
    process.exitCode = 1
  })
}
