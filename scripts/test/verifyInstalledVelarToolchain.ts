import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { WorkbenchLanguageServices } from '../../apps/workbench/src/main/workspace/language/LanguageServices'
import { PathResolver } from '../../apps/workbench/src/main/workspace/PathResolver'
import { VelarWorkbenchLanguageService } from '../../apps/workbench/src/contributions/velar/service'
import { registerWorkbenchLanguageService } from '../../apps/workbench/src/workbench/language/workbenchLanguageServices'

const releaseInput = process.argv[2]
if (!releaseInput) throw new Error('Usage: bun run test:velar:installed -- /absolute/path/to/release')
if (!isAbsolute(releaseInput)) throw new Error('The Velar release directory must be absolute')
const releaseDirectory = resolve(releaseInput)

const manifest = JSON.parse(
  await readFile(join(releaseDirectory, 'velar-toolchain-release.json'), 'utf8')
) as {
  version: string
  publish: { performed: boolean }
  packages: Array<{ name: string; version: string; fileName: string; sha256: string }>
}
assert.equal(manifest.publish.performed, false)
const compiler = manifest.packages.find((item) => item.name === '@velarscript/compiler')
const cli = manifest.packages.find((item) => item.name === '@velarscript/cli')
assert.ok(compiler && cli)
assert.equal(compiler.version, manifest.version)
assert.equal(cli.version, manifest.version)

const temporary = await mkdtemp(join(tmpdir(), 'workbench-velar-installed-'))
const projectRoot = join(temporary, 'app')
let removeService: (() => void) | null = null
let services: WorkbenchLanguageServices | null = null
try {
  await writeFile(join(temporary, 'package.json'), '{"private":true}\n', 'utf8')
  await runNpm([
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--prefix',
    temporary,
    join(releaseDirectory, compiler.fileName),
    join(releaseDirectory, cli.fileName),
  ], temporary)
  const installedCli = join(temporary, 'node_modules', '@velarscript', 'cli', 'dist', 'cli.js')
  await run(process.execPath, [installedCli, 'create', projectRoot], temporary)
  await runNpm([
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    join(releaseDirectory, compiler.fileName),
    join(releaseDirectory, cli.fileName),
  ], projectRoot)

  const source = [
    'import {NavLink, RouteContext, route} from "velar/web"',
    'import {closeDialog, dialogResult, showDialog} from "velar/browser"',
    'import {numberValue, reset, textValue} from "velar/forms"',
    '',
    'def total(first: number, ...values: number) -> number:',
    '    return first + values.length',
    '',
    'const tags = Set()',
    'tags.add("velar")',
    '',
    'const count: number = "wrong"',
    'const page = import("./page.vel")',
    'const answer = total(1, 2, 3)',
    'comp',
    '',
    'enum TaskStatus:',
    '    todo',
    '    doing',
    '',
    'const status: TaskStatus = TaskStatus.todo',
    '',
    'component TicketPage(route: RouteContext):',
    '    let dialog: DialogElement? = none',
    '    def inspect():',
    '        if dialog:',
    '            showDialog(dialog)',
    '            closeDialog(dialog, dialogResult(dialog))',
    '    return <><NavLink to="/tickets" exact={true}>Tickets</NavLink><p>{route.params.get("id") ?? "missing"}</p><dialog ref={dialog}>Confirm</dialog></>',
    '',
    'const ticketRoute = route("/tickets/:id", TicketPage)',
    '',
  ].join('\n')
  await writeFile(join(projectRoot, 'src', 'page.vel'), 'export component Page:\n    return <h1>Page</h1>\n', 'utf8')
  await writeFile(join(projectRoot, 'src', 'main.vel'), source, 'utf8')
  removeService = registerWorkbenchLanguageService(VelarWorkbenchLanguageService)
  services = new WorkbenchLanguageServices(new PathResolver())
  const resolved = await services.resolveLanguageService({
    projectRoot,
    path: 'src/main.vel',
    content: source,
  })
  assert.equal(resolved.service?.id, 'velarscript')
  assert.equal(resolved.service?.runtime, 'lsp-server')

  const diagnostics = await services.getDiagnostics({ projectRoot, path: 'src/main.vel', content: source })
  assert.ok(diagnostics.diagnostics.some((item) => item.code?.startsWith('VEL4')))
  const completions = await services.getCompletions({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: 14, column: 5 },
  })
  assert.ok(completions.items.some((item) => item.label === 'component'))
  assert.ok(completions.items.some((item) => item.label === 'throw'))
  assert.ok(completions.items.some((item) => item.label === 'match'))
  assert.ok(completions.items.some((item) => item.label === 'case'))
  assert.ok(completions.items.some((item) => item.label === 'enum'))
  assert.ok(completions.items.some((item) => item.label === 'velar/collections'))
  assert.ok(completions.items.some((item) => item.label === 'velar/async'))
  assert.ok(completions.items.some((item) => item.label === 'velar/time'))
  assert.ok(completions.items.some((item) => item.label === 'velar/id'))
  assert.ok(completions.items.some((item) => item.label === 'velar/log'))
  assert.ok(completions.items.some((item) => item.label === 'velar/app'))
  assert.ok(completions.items.some((item) => item.label === 'velar/config'))
  assert.ok(completions.items.some((item) => item.label === 'velar/forms'))
  assert.ok(completions.items.some((item) => item.label === 'velar/browser'))
  assert.ok(completions.items.some((item) => item.label === 'velar/realtime'))
  assert.ok(completions.items.some((item) => item.label === 'velar/test'))
  const definition = await services.getDefinition({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: 12, column: 24 },
  })
  assert.equal(definition.locations[0]?.path, 'src/page.vel')
  const signature = await services.getSignatureHelp({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: 13, column: 28 },
  })
  assert.equal(signature.signatureHelp?.signatures[0]?.label, 'total(number, ...number) -> number')
  assert.equal(signature.signatureHelp?.activeParameter, 2)
  const hover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: 8, column: 8 },
  })
  assert.match(hover.hover?.displayText ?? '', /Set<string>/u)
  const enumLine = source.split('\n').findIndex((line) => line.includes('TaskStatus.todo'))
  const memberColumn = source.split('\n')[enumLine]!.indexOf('todo')
  const enumCompletions = await services.getCompletions({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: enumLine + 1, column: memberColumn + 1 },
  })
  assert.deepEqual(enumCompletions.items.map((item) => item.label), ['todo', 'doing'])
  const enumHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: enumLine + 1, column: memberColumn + 1 },
  })
  assert.match(enumHover.hover?.displayText ?? '', /TaskStatus/u)
  const enumDefinition = await services.getDefinition({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: enumLine + 1, column: memberColumn + 1 },
  })
  assert.equal(enumDefinition.locations[0]?.path, 'src/main.vel')
  const routeTypeLine = source.split('\n').findIndex((line) => line.includes('route: RouteContext'))
  const routeTypeColumn = source.split('\n')[routeTypeLine]!.indexOf('RouteContext')
  const routeTypeHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: routeTypeLine + 1, column: routeTypeColumn + 1 },
  })
  assert.match(routeTypeHover.hover?.displayText ?? '', /RouteContext/u)
  const dialogTypeLine = source.split('\n').findIndex((line) => line.includes('dialog: DialogElement'))
  const dialogTypeColumn = source.split('\n')[dialogTypeLine]!.indexOf('DialogElement')
  const dialogTypeHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: dialogTypeLine + 1, column: dialogTypeColumn + 1 },
  })
  assert.match(dialogTypeHover.hover?.displayText ?? '', /DialogElement/u)
  const enumReferences = await services.getReferences({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: enumLine + 1, column: memberColumn + 1 },
  })
  assert.equal(enumReferences.locations.length, 2)
  const enumRename = await services.getRename({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: enumLine + 1, column: memberColumn + 1 },
    newName: 'pending',
  })
  assert.equal(enumRename.changes.length, 1)
  assert.equal(enumRename.changes[0]?.edits.length, 2)
  assert.ok(enumRename.changes[0]?.edits.every((edit) => edit.newText === 'pending'))
  process.stdout.write('Workbench installed Velar toolchain acceptance passed\n')
} finally {
  await services?.dispose()
  removeService?.()
  await rm(temporary, { recursive: true, force: true })
}

async function runNpm(arguments_: readonly string[], cwd: string): Promise<void> {
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', arguments_, cwd)
}

async function run(command: string, arguments_: readonly string[], cwd: string): Promise<void> {
  const child = spawn(command, arguments_, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const code = await new Promise<number | null>((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', resolvePromise)
  })
  if (code !== 0) throw new Error(`${command} ${arguments_.join(' ')} failed (${code})\n${stdout}\n${stderr}`)
}
