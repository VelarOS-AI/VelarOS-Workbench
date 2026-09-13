/** Candidate-package acceptance through Workbench's real Project provider on a clean Git worktree. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { ProjectCapabilityProvider } from '../../src/main/workspace/ProjectCapabilityProvider'

const root = resolve(process.argv[2] ?? '')
assert(process.argv[2], 'Pass an explicit disposable large-project worktree')
assert((await lstat(join(root, '.git'))).isFile(), 'Acceptance requires a Git worktree')
assert.equal(
  execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  '',
  'Use a clean worktree',
)
const scratch = `project-v2-acceptance-${process.pid}`
const path = `${scratch}/source.ts`
const textPath = `${scratch}/text.txt`
const jsonPath = `${scratch}/data.json`
const provider = new ProjectCapabilityProvider()
const project = await provider.resolveProject(root)
const records: Array<Record<string, unknown>> = []
const context = { abortSignal: new AbortController().signal }
async function call(name: string, input: unknown) {
  const tool = project.tools.find((candidate) => candidate.name === name)
  assert(tool, name)
  const started = performance.now()
  try {
    const result = (await tool.execute(tool.schema.parse(input), context)) as Record<
      string,
      unknown
    >
    assert(!result.error, JSON.stringify(result))
    const request = input as { action?: string; edits?: Array<{ type: string }> }
    records.push({
      tool: name,
      action: request.action,
      operations: request.edits?.map((op) => op.type),
      ms: Math.round(performance.now() - started),
      status: 'passed',
    })
    return result
  } catch (error) {
    records.push({
      tool: name,
      input,
      ms: Math.round(performance.now() - started),
      status: 'failed',
      error: String(error),
    })
    throw error
  }
}
async function directoryBytes() {
  const files = (await readdir(join(root, scratch))).sort()
  return Promise.all(
    files.map(async (file) => [
      file,
      (await readFile(join(root, scratch, file))).toString('base64'),
    ]),
  )
}
async function edit(operation: Record<string, unknown>) {
  const before = await directoryBytes()
  const result = await call('project:edit', { edits: [operation] })
  assert(result.changed, JSON.stringify(result))
  assert.notDeepEqual(await directoryBytes(), before)
  await call('project:rollback', { transactionId: result.transactionId })
  assert.deepEqual(await directoryBytes(), before)
}
await mkdir(join(root, scratch))
try {
  await writeFile(
    join(root, path),
    'import { join } from "node:path"\nexport function greet(name: string) {\n  return "hello " + name\n}\nexport const message = greet("world")\n',
  )
  await writeFile(join(root, textPath), 'first\nsecond\nthird\n')
  await writeFile(join(root, jsonPath), '{"items":[1,2],"title":"original"}\n')
  const list = await call('project:list', { path: 'packages/project/src', limit: 1000 })
  assert(JSON.stringify(list).includes('agent'))
  const read = await call('project:read', {
    path: ['packages/project/src/core/project-kernel.ts', path],
    maxChars: 40000,
  })
  assert(Array.isArray(read.files))
  assert(
    read.files.some(
      (file: { snapshot: { path: string }; content: string }) =>
        file.snapshot.path === path && file.content.includes('greet'),
    ),
  )
  const search = await call('project:search', {
    query: 'greet',
    include: [`${scratch}/**`],
    limit: 20,
  })
  assert(JSON.stringify(search).includes(path))
  const importerPath = `${scratch}/consumer.ts`
  const diagnosticPath = `${scratch}/broken.ts`
  await writeFile(join(root, importerPath), 'import { greet } from "./source"\nexport const result = greet("caller")\n')
  await writeFile(join(root, diagnosticPath), 'export const broken = ;\n')
  const queryChecks = [
    { action: 'find_symbols', field: 'symbols', path },
    { action: 'list_exports', field: 'exports', path },
    { action: 'find_imports', field: 'imports', path },
    { action: 'find_importers', field: 'importers', path: scratch },
    { action: 'find_references', field: 'references', path },
    { action: 'language_diagnostics', field: 'diagnostics', path: diagnosticPath },
    { action: 'analyze_symbol_impact', field: 'definitions', path },
  ]
  for (const query of queryChecks) {
    const result = await call('project:query-code', {
      action: query.action, path: query.path, symbol: 'greet', query: 'greet',
      targetPath: path, declarationPath: path, includeExternal: true, limit: 20,
    })
    assert.equal(result.source, 'language-service')
    const found = result[query.field]
    assert(Array.isArray(found) && found.length > 0, `${query.action}: ${JSON.stringify(result)}`)
  }
  await rm(join(root, diagnosticPath))
  const command = await call('project:run', {
    command: 'git rev-parse --show-toplevel',
    maxOutputChars: 2000,
  })
  assert.equal(command.exitCode, 0)
  assert(typeof command.stdout === 'string' && command.stdout.includes(root))
  const write = await call('project:write', {
    path: `${scratch}/created.txt`,
    content: '中文🙂\\n literal\n',
    mode: 'create',
  })
  assert.equal(await readFile(join(root, scratch, 'created.txt'), 'utf8'), '中文🙂\\n literal\n')
  await call('project:rollback', { transactionId: write.transactionId })
  for (const mode of ['append', 'prepend', 'overwrite']) {
    const before = await readFile(join(root, textPath))
    const written = await call('project:write', { path: textPath, content: '中文🙂\\n literal\n', mode })
    assert.notDeepEqual(await readFile(join(root, textPath)), before)
    await call('project:rollback', { transactionId: written.transactionId })
    assert.deepEqual(await readFile(join(root, textPath)), before)
  }
  const failedCommand = await call('project:run', { command: 'printf "TS2322 stdout error"; exit 2', maxOutputChars: 2000 })
  assert.equal(failedCommand.success, false)
  assert(JSON.stringify(failedCommand.verification).includes('stdout error'))
  const lineRead = await call('project:read', { path: textPath })
  assert(Array.isArray(lineRead.files))
  const revision: unknown = lineRead.files[0].snapshot.revision
  for (const operation of [
    {
      type: 'replace_lines',
      path: textPath,
      baseRevision: revision,
      startLine: 2,
      endLine: 2,
      newLines: ['changed', 'extra'],
    },
    { type: 'replace_text', path: textPath, oldText: 'second', newText: 'changed' },
    {
      type: 'insert_text_at_anchor',
      path: textPath,
      anchorText: 'second',
      position: 'after',
      text: ' inserted',
    },
    { type: 'append_text', path: textPath, text: 'tail\n' },
    { type: 'prepend_text', path: textPath, text: 'head\n' },
    { type: 'replace_text', path: textPath, oldText: 'second\n', newText: '' },
    { type: 'create_file', path: `${scratch}/created.txt`, content: 'created' },
    { type: 'delete_file', path: textPath },
    { type: 'rename_file', from: textPath, to: `${scratch}/renamed.txt` },
    {
      type: 'replace_symbol',
      path,
      symbol: { name: 'greet' },
      replacement: 'export function greet(name: string) { return "hi " + name }',
    },
    {
      type: 'insert_around_symbol',
      path,
      symbol: { name: 'greet' },
      position: 'before',
      text: '// documented\n',
    },
    { type: 'add_import', path, module: 'node:fs', named: ['readFileSync'] },
    { type: 'remove_import', path, moduleSpecifier: 'node:path', name: 'join' },
    {
      type: 'json_patch',
      path: jsonPath,
      patches: [
        { op: 'replace', path: '/title', value: '中文🙂' },
        { op: 'add', path: '/items/-', value: 3 },
      ],
    },
  ])
    await edit(operation)

  // Exercise actual repository files in one transaction, then prove byte-for-byte restoration.
  const files = execFileSync('git', ['ls-files', 'packages/project/src'], {
    cwd: root,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter((file) => file.endsWith('.ts'))
    .slice(0, 50)
  assert.equal(files.length, 50)
  const before = await Promise.all(files.map((file) => readFile(join(root, file))))
  const large = await call('project:edit', {
    edits: files.map((path) => ({
      type: 'prepend_text',
      path,
      text: '// Project 2.0 acceptance 中文🙂\n',
    })),
  })
  assert(Array.isArray(large.changedFiles))
  assert.equal(large.changedFiles.length, 50)
  await call('project:rollback', { transactionId: large.transactionId })
  for (let index = 0; index < files.length; index++)
    assert.deepEqual(await readFile(join(root, files[index])), before[index])
  console.log(
    JSON.stringify(
      { passed: true, tools: [...new Set(records.map((r) => r.tool))], records },
      null,
      2,
    ),
  )
} finally {
  await provider.dispose()
  await rm(join(root, scratch), { recursive: true, force: true })
  await writeFile('project-v2-tools-acceptance.json', JSON.stringify(records, null, 2) + '\n')
}
