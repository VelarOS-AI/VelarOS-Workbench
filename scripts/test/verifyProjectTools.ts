/** Candidate packages through Workbench's production Project provider on an explicit clean worktree. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { InMemoryContextPayloadStore } from '@velaros-ai/agent'
import { fileContextFor } from '@velaros-ai/agent/tool-contract'

import { ProjectCapabilityProvider } from '../../src/main/workspace/ProjectCapabilityProvider'

assert(process.argv[2], 'Pass an explicit disposable large-project worktree')
const root = resolve(process.argv[2]!)
assert((await lstat(join(root, '.git'))).isFile(), 'Acceptance requires a linked Git worktree')
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), '', 'Use a clean worktree')
const reportPath = process.argv[3] ? resolve(process.argv[3]) : join(await mkdtemp(join(tmpdir(), 'project-surface-acceptance-')), 'report.json')
const scratch = `project-surface-acceptance-${process.pid}`
const sourcePath = `${scratch}/source.ts`
const textPath = `${scratch}/text.txt`
const executablePath = `${scratch}/executable.mjs`
const provider = new ProjectCapabilityProvider()
const project = await provider.resolveProject(root)
const records: Array<Record<string, unknown>> = []
const context = {
  sessionId: `surface-${process.pid}`, codingSession: {}, contextPayloadStore: new InMemoryContextPayloadStore(),
  abortSignal: new AbortController().signal,
  approval: { awaitConfirmation: async () => undefined, awaitConfirmationDecision: async () => ({ approved: true, message: null }) },
}
async function call(name: string, input: unknown): Promise<Record<string, any>> {
  const tool = project.tools.find((candidate) => candidate.name === name)
  assert(tool, name)
  const started = performance.now()
  try {
    const parsed = tool.schema.safeParse(input)
    assert(parsed.success, JSON.stringify(parsed))
    const raw = await tool.execute(parsed.data, context)
    const result = await fileContextFor(context)?.finalizeModelResult(raw) ?? raw
    assert(result && typeof result === 'object')
    const output = result as Record<string, any>
    assert(!output.error, JSON.stringify(output))
    records.push({ tool: name, input, ms: Math.round(performance.now() - started), status: 'passed', degraded: output.degraded })
    return output
  } catch (error) {
    records.push({ tool: name, ms: Math.round(performance.now() - started), status: 'failed', error: String(error) })
    throw error
  }
}
async function view(path: string, range?: number | [number, number]) {
  const read = await call('project:read', { path, range })
  const file = read.files[0]
  assert.equal(file.path, path)
  assert.equal(typeof file.fileRef, 'string')
  return file
}
async function fileState(path: string) {
  const info = await lstat(join(root, path))
  return { bytes: (await readFile(join(root, path))).toString('base64'), mode: info.mode & 0o777 }
}
async function directoryState() {
  return Promise.all((await readdir(join(root, scratch))).sort().map(async (name) => [name, await fileState(`${scratch}/${name}`)]))
}
async function roundTrip(name: string, input: unknown) {
  const before = await directoryState()
  const result = await call(name, input)
  assert.equal(result.changed, true)
  assert.notDeepEqual(await directoryState(), before)
  await call('project:change', { action: 'inspect', changeRef: result.changeRef })
  await call('project:change', { action: 'undo', changeRef: result.changeRef })
  assert.deepEqual(await directoryState(), before)
}
await mkdir(join(root, scratch))
try {
  await writeFile(join(root, sourcePath), 'import { join } from "node:path"\nexport function greet(name: string) {\n  return "hello " + name\n}\nexport const message = greet("world")\n')
  await writeFile(join(root, textPath), 'first\r\nsecond 中文🙂\r\nthird\r\n')
  await writeFile(join(root, `${scratch}/consumer.ts`), 'import { greet } from "./source"\nexport const result = greet("caller")\n')
  await writeFile(join(root, executablePath), '#!/usr/bin/env node\nprocess.stdout.write("acceptance\\n")\n')
  await chmod(join(root, executablePath), 0o755)
  const tracked = execFileSync('git', ['ls-files', '-z', '--', 'packages/project/src'], { cwd: root, encoding: 'utf8' }).split('\0').filter((path) => path.endsWith('.ts'))
  assert(tracked.length >= 50, 'Use the large Platform project')
  const list = await call('project:list', { path: 'packages/project/src', recursive: true, limit: 1000 })
  assert(JSON.stringify(list).includes('agent'))
  const batch = await call('project:read', { files: [{ path: tracked[0], range: [1, 8] }, { path: textPath, range: [1, 3] }] })
  assert.equal(batch.files.length, 2)
  assert.deepEqual(batch.files[1].lines, [[1, 'first'], [2, 'second 中文🙂'], [3, 'third']])
  const search = await call('project:search', { query: 'greet', path: scratch, limit: 20 })
  assert(JSON.stringify(search).includes(sourcePath))
  const target = { path: sourcePath, symbol: 'greet' }
  for (const input of [
    { action: 'symbols', path: sourcePath, query: 'greet' },
    { action: 'symbols', target },
    { action: 'symbols', path: sourcePath, exportedOnly: true, includeReExports: true },
    { action: 'references', target, path: scratch },
    { action: 'dependencies', direction: 'outgoing', path: sourcePath },
    { action: 'dependencies', direction: 'incoming', path: sourcePath, within: scratch, includeReExports: true },
    { action: 'relations', target, kind: 'calls', direction: 'incoming' },
    { action: 'impact', target, path: scratch },
    { action: 'diagnostics', path: sourcePath },
  ]) {
    const result = await call('project:code', input)
    assert(Array.isArray(result.sources))
    assert(result.coverage)
  }
  const command = await call('project:run', { command: 'git rev-parse --show-toplevel', maxOutputChars: 2000 })
  assert.equal(command.exitCode, 0)
  const failedCommand = await call('project:run', { command: 'printf "verification output"; exit 2', maxOutputChars: 2000 })
  assert.equal(failedCommand.exitCode, 2)
  for (const edit of [
    { op: 'replace', range: 2, text: 'changed 中文🙂' },
    { op: 'replace', range: [2], match: 'second', text: 'changed' },
    { op: 'replace', match: 'second', text: 'changed' },
    { op: 'replace', range: [2, 2], text: '' },
    { op: 'insert', range: 2, side: 'before', text: 'inserted' },
    { op: 'insert', range: 2, match: 'second', side: 'after', text: ' appended' },
    { op: 'insert', at: 'start', text: 'head' },
    { op: 'insert', at: 'end', text: 'tail' },
  ]) await roundTrip('project:edit', { files: [{ fileRef: (await view(textPath)).fileRef, edits: [edit] }] })
  await roundTrip('project:file', { actions: [{ op: 'create', path: `${scratch}/created.txt`, text: '中文🙂\\n literal\n' }] })
  for (const action of [
    { op: 'overwrite', text: 'replacement\n' }, { op: 'delete' }, { op: 'move', to: `${scratch}/moved.txt` },
  ]) await roundTrip('project:file', { actions: [{ ...action, fileRef: (await view(textPath)).fileRef }] })
  await roundTrip('project:file', { actions: [{ op: 'move', fileRef: (await view(executablePath)).fileRef, to: `${scratch}/moved.mjs` }] })
  assert.equal(execFileSync(join(root, executablePath), { encoding: 'utf8' }), 'acceptance\n')
  await roundTrip('project:change', { action: 'apply', steps: [
    { tool: 'file', actions: [{ op: 'create', path: `${scratch}/planned.ts`, text: 'export const planned = 1\n' }] },
    { tool: 'edit', files: [{ path: `${scratch}/planned.ts`, edits: [{ op: 'replace', range: 1, text: 'export const planned = 2' }] }] },
    { tool: 'file', actions: [{ op: 'move', path: `${scratch}/planned.ts`, to: `${scratch}/planned-moved.ts` }] },
  ] })
  const files = tracked.slice(0, 50)
  const before = await Promise.all(files.map(fileState))
  const targets = []
  for (const path of files) targets.push({ fileRef: (await view(path, 1)).fileRef, edits: [{ op: 'insert', at: 'start', text: '// Project surface acceptance 中文🙂' }] })
  const large = await call('project:edit', { files: targets })
  assert.equal(large.changedFiles.length, 50)
  await call('project:change', { action: 'undo', changeRef: large.changeRef })
  for (const [index, path] of files.entries()) assert.deepEqual(await fileState(path), before[index])
  assert.deepEqual([...new Set(records.map((row) => row.tool))].sort(), ['project:read', 'project:list', 'project:search', 'project:code', 'project:file', 'project:edit', 'project:change', 'project:run'].sort())
  process.stdout.write(JSON.stringify({ passed: true, reportPath, calls: records.length, tools: [...new Set(records.map((row) => row.tool))] }) + '\n')
} finally {
  await provider.dispose()
  await rm(join(root, scratch), { recursive: true, force: true })
  await writeFile(reportPath, JSON.stringify(records, null, 2) + '\n')
}
