import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

import { WorkbenchLanguageServices } from '../../src/main/workspace/language/LanguageServices'
import { VelarWorkbenchLanguageService } from '../../src/shared/contributions/velar/service'
import { registerWorkbenchLanguageService } from '../../src/shared/language/workbenchLanguageServices'

const languagePathResolver = {
  async resolveProjectRoot(input: string): Promise<string> {
    const root = await realpath(resolve(input))
    if (!(await stat(root)).isDirectory()) throw new Error('The language project root must be a directory')
    return root
  },
  assertAllowedProjectPath(projectRoot: string, absolutePath: string, inputPath: string): void {
    if (!isInside(projectRoot, absolutePath)) throw new Error(`Language path escapes the project: ${inputPath}`)
  },
  isAllowedProjectPath(projectRoot: string, absolutePath: string): boolean {
    return isInside(projectRoot, absolutePath)
  },
  toProjectRelativePath(projectRoot: string, absolutePath: string): string {
    const value = relative(projectRoot, absolutePath)
    if (!isInside(projectRoot, absolutePath)) throw new Error(`Language path escapes the project: ${absolutePath}`)
    return (value || '.').replaceAll('\\', '/')
  },
}

function isInside(projectRoot: string, absolutePath: string): boolean {
  const value = relative(projectRoot, absolutePath)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

const releaseInput = process.argv[2]
if (!releaseInput) throw new Error('Usage: bun run test:velar:installed -- /absolute/path/to/release')
if (!isAbsolute(releaseInput)) throw new Error('The Velar release directory must be absolute')
const releaseDirectory = resolve(releaseInput)

const manifest = JSON.parse(
  await readFile(join(releaseDirectory, 'velar-toolchain-release.json'), 'utf8')
) as {
  formatVersion: number
  kind: string
  mode: string
  version: string
  publish: { performed: boolean }
  packages: Array<{ name: string; version: string; fileName: string; sizeBytes: number; sha256: string }>
}
assert.equal(manifest.formatVersion, 1)
assert.equal(manifest.kind, 'velar-toolchain-release')
assert.ok(manifest.mode === 'rehearse' || manifest.mode === 'candidate')
assert.equal(manifest.publish.performed, false)
assert.deepEqual(manifest.packages.map((item) => item.name), [
  '@velarscript/cli',
  '@velarscript/compiler',
  '@velarscript/web',
  'create-velar',
])
const compiler = manifest.packages.find((item) => item.name === '@velarscript/compiler')
const web = manifest.packages.find((item) => item.name === '@velarscript/web')
const creator = manifest.packages.find((item) => item.name === 'create-velar')
const cli = manifest.packages.find((item) => item.name === '@velarscript/cli')
assert.ok(compiler && web && creator && cli)
assert.equal(compiler.version, manifest.version)
assert.equal(web.version, manifest.version)
assert.equal(creator.version, manifest.version)
assert.equal(cli.version, manifest.version)
for (const package_ of manifest.packages) {
  assert.equal(package_.fileName, basename(package_.fileName))
  assert.match(package_.sha256, /^[0-9a-f]{64}$/u)
  const body = await readFile(join(releaseDirectory, package_.fileName))
  assert.equal(body.byteLength, package_.sizeBytes)
  assert.equal(createHash('sha256').update(body).digest('hex'), package_.sha256)
}

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
    join(releaseDirectory, web.fileName),
    join(releaseDirectory, creator.fileName),
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
    join(releaseDirectory, web.fileName),
    join(releaseDirectory, creator.fileName),
    join(releaseDirectory, cli.fileName),
  ], projectRoot)
  const sdkRoot = join(projectRoot, 'node_modules', 'typed-sdk')
  await mkdir(sdkRoot, { recursive: true })
  await writeFile(join(sdkRoot, 'package.json'), '{"name":"typed-sdk","type":"module","exports":{".":{"types":"./index.d.ts","default":"./index.js"},"./client":{"types":"./client.d.ts","default":"./index.js"}},"types":"./index.d.ts"}\n', 'utf8')
  await writeFile(join(sdkRoot, 'index.js'), 'export class Client { static get version() { return "1"; } constructor(name) { this._name = name; } get name() { return this._name; } request(path) { return path; } static connect(name) { return new Client(name); } }\n', 'utf8')
  await writeFile(join(sdkRoot, 'client.d.ts'), 'declare class Client { constructor(name: string); get name(): string; static get version(): string; request(path: string, timeoutMs?: number): string; static connect(name: string): Client; }\nexport {Client};\n', 'utf8')
  await writeFile(join(sdkRoot, 'index.d.ts'), 'export {Client} from "./client.js";\n', 'utf8')

  const source = [
    'import {NavLink, RouteContext, Router, domId, route} from "velar/web"',
    'import {after, blur, closeDialog, dialogResult, every, focus, showDialog} from "velar/browser"',
    'import {numberValue, read, reset, textValue} from "velar/forms"',
    'import {findMatch, matches} from "velar/text"',
    'import js {Client as PackageClient} from "typed-sdk/client"',
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
    'const answerInRange = 0 < answer <= 10',
    'print(answerInRange)',
    'comp',
    'import {deepEqual} from "velar/json"',
    'const pageValues = [1, 2, 3].slice(0, 2)',
    'print(pageValues.length)',
    'const patternReady = matches("Velar 42", "^velar [0-9]+$", {ignoreCase: true})',
    'const firstPatternGroup = findMatch("ticket-42", "([0-9]+)")?.groups[0]',
    'const parsedPage = number("2")',
    'const sdkClient: PackageClient = PackageClient.connect("velar")',
    'const sdkLabel: string = sdkClient.request("/status", 1000)',
    'print(sdkClient.name)',
    '',
    'type TreeNode:',
    '    label: string',
    '    children: List<TreeNode>',
    '',
    'const tree: TreeNode = {label: "root", children: [{label: "leaf", children: []}]}',
    'const firstTreeLabel = tree.children[0].label',
    'const sameTree = deepEqual(tree, tree)',
    '',
    'const stopTimer = after(100, () => none)',
    'const stopPulse = every(100, () => none)',
    'const dialogTitleId = domId("dialog-title")',
    'print(dialogTitleId)',
    'stopTimer()',
    'stopPulse()',
    '',
    'enum TaskStatus:',
    '    todo',
    '    doing',
    '',
    'const status: TaskStatus = TaskStatus.todo',
    '',
    '/// Tracks a score and its ordered history.',
    'class ScoreCard:',
    '    static const category: string = "score"',
    '    private const history: List<number> = []',
    '    let total: number = 0',
    '    init:',
    '        assert self.total == 0, "ScoreCard starts empty"',
    '    def add(value: number):',
    '        self.history.append(value)',
    '        self.total += value',
    '    /// Summarizes the public score without exposing its history.',
    '    get summary() -> string:',
    '        return f"{self.total}:{self.history.length}"',
    '',
    'const scoreCard = ScoreCard()',
    'scoreCard.add(5)',
    'print(ScoreCard.category)',
    'print(scoreCard.total)',
    'print(scoreCard.summary)',
    '',
    'const ticketLabelSource: () -> Promise<string> = async () => "ready"',
    '',
    'async def loadTicketLabel() -> string:',
    '    return ticketLabelSource()',
    '',
    'const loadTicket: (string) -> Promise<string> = async (',
    '    ticketId,',
    ') => f"{ticketId}:{await loadTicketLabel()}"',
    'const loadedTicket = await loadTicket(',
    '    "ticket-42",',
    ')',
    'print(loadedTicket)',
    '',
    'type ChooseHandler = (string) -> none',
    '',
    'type FormDraft:',
    '    label: string',
    '    count: number?',
    '',
    'type DisplayValue = string | number | bool',
    '',
    'def displayValue(value: DisplayValue) -> string:',
    '    if value is string:',
    '        return f"text:{value.length}"',
    '    else if value is number:',
    '        return f"number:{value + 1}"',
    '    else:',
    '        return value ? "yes" : "no"',
    '',
    'const label = "ready"',
    'const shorthandDraft: FormDraft = {label, count: 0}',
    '',
    'component Choice(show: bool, onChoose: ChooseHandler):',
    '    return <div><button if={show} type="button" on:click={() => onChoose("ready")}>Choose</button><p else>Hidden</p></div>',
    '',
    'component InlineChart:',
    '    return <svg aria-label="Traffic" viewBox="0 0 100 40"><rect x="4" y="4" width="20" height="30" /><foreignObject x="30" y="4" width="60" height="30"><div>Summary</div></foreignObject></svg>',
    '',
    'component TicketPage(route: RouteContext):',
    '    let dialog: DialogElement? = none',
    '    let form: Element? = none',
    '    resource ticketLabel = loadTicketLabel()',
    '    action refresh():',
    '        await loadTicketLabel()',
    '    def inspect():',
    '        if form:',
    '            const draft = read(form, FormDraft)',
    '            print(draft.label)',
    '            assert draft.count != none, "Count is required"',
    '            const narrowedCount = draft.count',
    '            print(narrowedCount)',
    '            focus(form, true)',
    '            blur(form)',
    '        if dialog:',
    '            showDialog(dialog)',
    '            closeDialog(dialog, dialogResult(dialog))',
    '    return <><NavLink to="/tickets" exact={true}>Tickets</NavLink><Choice show={true} onChoose={value => none} /><form ref={form}><input name="label" aria-label="Label" /><input name="count" type="number" aria-label="Count" /></form><input aria-label="Shortcut" on:keydown={event => print(event.key)} /><p>{route.params.get("id") ?? "missing"}</p><dialog ref={dialog}>Confirm</dialog></>',
    '',
    'const ticketRoute = route("/tickets/:id", TicketPage)',
    '',
    'component MissingPage(route: RouteContext):',
    '    return <main><h1>Page not found</h1><p>{route.path}</p></main>',
    '',
    'component RoutedApp:',
    '    return <Router routes={[ticketRoute]} fallback={MissingPage} />',
    '',
  ].join('\n')
  await writeFile(join(projectRoot, 'src', 'page.vel'), 'export component Page:\n    return <h1>Page</h1>\n', 'utf8')
  await writeFile(join(projectRoot, 'src', 'main.vel'), source, 'utf8')
  removeService = registerWorkbenchLanguageService(VelarWorkbenchLanguageService)
  services = new WorkbenchLanguageServices(languagePathResolver)
  const resolved = await services.resolveLanguageService({
    projectRoot,
    path: 'src/main.vel',
    content: source,
  })
  assert.equal(resolved.service?.id, 'velarscript')
  assert.equal(resolved.service?.runtime, 'lsp-server')

  const diagnostics = await services.getDiagnostics({ projectRoot, path: 'src/main.vel', content: source })
  assert.ok(diagnostics.diagnostics.some((item) => item.code?.startsWith('VEL4')))
  assert.ok(!diagnostics.diagnostics.some((item) => item.code?.startsWith('VEL2')))
  assert.ok(!diagnostics.diagnostics.some((item) => item.code === 'VEL5029'))
  const semanticTokens = await services.getSemanticTokens({
    projectRoot,
    path: 'src/main.vel',
    content: source,
  })
  assert.ok(semanticTokens.tokens.some((token) => token.type === 'function' && token.modifiers.includes('declaration')))
  assert.ok(semanticTokens.tokens.some((token) => token.type === 'property'))
  const fixSource = 'const same = 1 === 1\n'
  await writeFile(join(projectRoot, 'src', 'fix.vel'), fixSource, 'utf8')
  const fixDiagnostics = await services.getDiagnostics({
    projectRoot,
    path: 'src/fix.vel',
    content: fixSource,
  })
  const strictEquality = fixDiagnostics.diagnostics.find((item) => item.code === 'VEL1005')
  assert.ok(strictEquality)
  const codeActions = await services.getCodeActions({
    projectRoot,
    path: 'src/fix.vel',
    content: fixSource,
    range: strictEquality.range,
    diagnostics: [strictEquality],
  })
  assert.equal(codeActions.actions[0]?.changes[0]?.path, 'src/fix.vel')
  assert.equal(codeActions.actions[0]?.changes[0]?.edits[0]?.newText, '==')
  const completions = await services.getCompletions({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: source.split('\n').findIndex((line) => line === 'comp') + 1, column: 5 },
  })
  assert.ok(completions.items.some((item) => item.label === 'component'))
  assert.ok(completions.items.some((item) => item.label === 'throw'))
  assert.ok(completions.items.some((item) => item.label === 'match'))
  assert.ok(completions.items.some((item) => item.label === 'case'))
  assert.ok(completions.items.some((item) => item.label === 'enum'))
  assert.ok(completions.items.some((item) => item.label === 'init'))
  assert.ok(completions.items.some((item) => item.label === 'get'))
  assert.ok(completions.items.some((item) => item.label === 'type'))
  assert.ok(completions.items.some((item) => item.label === 'resource'))
  assert.ok(completions.items.some((item) => item.label === 'action'))
  assert.ok(completions.items.some((item) => item.label === 'assert'))
  assert.match(completions.items.find((item) => item.label === 'ScoreCard')?.documentation ?? '',
    /Tracks a score and its ordered history/u)
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
  assert.ok(completions.items.some((item) => item.label === 'velar/web-test'))
  const narrowedCountLine = source.split('\n').findIndex((line) => line.includes('print(narrowedCount)'))
  const narrowedCountColumn = source.split('\n')[narrowedCountLine]!.indexOf('narrowedCount')
  const semanticCompletions = await services.getCompletions({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: narrowedCountLine + 1, column: narrowedCountColumn + 1 },
  })
  assert.ok(semanticCompletions.items.some((item) => item.label === 'narrowedCount'))
  assert.ok(semanticCompletions.items.some((item) => item.label === 'ticketLabel'))
  assert.ok(semanticCompletions.items.some((item) => item.label === 'refresh'))
  assert.ok(semanticCompletions.items.some((item) => item.label === 'route'))
  const pageValuesMemberLine = source.split('\n').findIndex((line) => line.includes('print(pageValues.length)'))
  const pageValuesMemberColumn = source.split('\n')[pageValuesMemberLine]!.indexOf('pageValues.') + 'pageValues.'.length
  const memberCompletions = await services.getCompletions({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: pageValuesMemberLine + 1, column: pageValuesMemberColumn + 1 },
  })
  assert.ok(memberCompletions.items.some((item) => item.label === 'length'))
  assert.ok(memberCompletions.items.some((item) => item.label === 'slice'))
  assert.ok(memberCompletions.items.some((item) => item.label === 'append'))
  assert.ok(memberCompletions.items.some((item) => item.label === 'extend'))
  assert.ok(!memberCompletions.items.some((item) => item.label === 'push'))
  assert.ok(memberCompletions.items.some((item) => item.label === 'map'))
  const sdkMemberLine = source.split('\n').findIndex((line) => line.includes('print(sdkClient.name)'))
  const sdkMemberSource = source.split('\n')[sdkMemberLine]!
  const sdkMemberColumn = sdkMemberSource.indexOf('sdkClient.') + 'sdkClient.'.length
  const sdkMemberCompletions = await services.getCompletions({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: sdkMemberLine + 1, column: sdkMemberColumn + 1 },
  })
  assert.ok(sdkMemberCompletions.items.some((item) => item.label === 'name'))
  assert.ok(sdkMemberCompletions.items.some((item) => item.label === 'request'))
  const sdkCallLine = source.split('\n').findIndex((line) => line.includes('sdkClient.request("/status"'))
  const sdkCallSource = source.split('\n')[sdkCallLine]!
  const sdkCallColumn = sdkCallSource.indexOf('sdkClient.request(') + 'sdkClient.request('.length
  const sdkSignature = await services.getSignatureHelp({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: sdkCallLine + 1, column: sdkCallColumn + 1 },
  })
  assert.equal(sdkSignature.signatureHelp?.signatures[0]?.label, 'request(string, number? = default) -> string')
  const sdkClientColumn = sdkCallSource.indexOf('sdkClient')
  const sdkHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: sdkCallLine + 1, column: sdkClientColumn + 1 },
  })
  assert.match(sdkHover.hover?.displayText ?? '', /PackageClient/u)
  const pageValuesLine = source.split('\n').findIndex((line) => line.includes('const pageValues'))
  const pageValuesDeclaration = source.split('\n')[pageValuesLine]!
  const sliceSecondArgumentColumn = pageValuesDeclaration.indexOf('slice(') + 'slice(0, '.length
  const memberSignature = await services.getSignatureHelp({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: pageValuesLine + 1, column: sliceSecondArgumentColumn + 1 },
  })
  assert.equal(memberSignature.signatureHelp?.signatures[0]?.label,
    'slice(number = default, number = default) -> List<number>')
  assert.equal(memberSignature.signatureHelp?.activeParameter, 1)
  const routeParamsLine = source.split('\n').findIndex((line) => line.includes('route.params.get("id")'))
  const routeParamsSource = source.split('\n')[routeParamsLine]!
  const routeParamsMemberColumn = routeParamsSource.indexOf('route.params.') + 'route.params.'.length
  const routeParamsCompletions = await services.getCompletions({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: routeParamsLine + 1, column: routeParamsMemberColumn + 1 },
  })
  for (const label of ['size', 'get', 'set', 'keys']) {
    assert.ok(routeParamsCompletions.items.some((item) => item.label === label), `missing route.params.${label} completion`)
  }
  const routeParamsCallColumn = routeParamsSource.indexOf('route.params.get("') + 'route.params.get('.length
  const routeParamsSignature = await services.getSignatureHelp({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: routeParamsLine + 1, column: routeParamsCallColumn + 1 },
  })
  assert.equal(routeParamsSignature.signatureHelp?.signatures[0]?.label, 'get(string) -> string?')
  assert.equal(routeParamsSignature.signatureHelp?.activeParameter, 0)
  const domIdLine = source.split('\n').findIndex((line) => line.includes('domId("dialog-title")'))
  const domIdSource = source.split('\n')[domIdLine]!
  const domIdArgumentColumn = domIdSource.indexOf('domId("') + 'domId('.length
  const domIdSignature = await services.getSignatureHelp({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: domIdLine + 1, column: domIdArgumentColumn + 1 },
  })
  assert.equal(domIdSignature.signatureHelp?.signatures[0]?.label, 'domId(string = default) -> string')
  assert.equal(domIdSignature.signatureHelp?.activeParameter, 0)
  const domIdHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: domIdLine + 1, column: domIdSource.indexOf('dialogTitleId') + 1 },
  })
  assert.match(domIdHover.hover?.displayText ?? '', /string/u)
  const routeParamsHoverColumn = routeParamsSource.indexOf('route.params') + 'route.'.length
  const routeParamsHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: routeParamsLine + 1, column: routeParamsHoverColumn + 1 },
  })
  assert.match(routeParamsHover.hover?.displayText ?? '', /field params: Map<string, string>/u)
  const scoreCardUseLine = source.split('\n').findIndex((line) => line.includes('print(scoreCard.total)'))
  const scoreCardUseSource = source.split('\n')[scoreCardUseLine]!
  const scoreCardMemberColumn = scoreCardUseSource.indexOf('scoreCard.total') + 'scoreCard.'.length
  const scoreCardCompletions = await services.getCompletions({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: scoreCardUseLine + 1, column: scoreCardMemberColumn + 1 },
  })
  assert.ok(scoreCardCompletions.items.some((item) => item.label === 'total' && item.detail === 'number'))
  assert.ok(scoreCardCompletions.items.some((item) => item.label === 'summary' && item.detail === 'string'))
  assert.match(scoreCardCompletions.items.find((item) => item.label === 'summary')?.documentation ?? '', /Summarizes the public score/u)
  assert.ok(!scoreCardCompletions.items.some((item) => item.label === 'history'))
  assert.ok(!scoreCardCompletions.items.some((item) => item.label === 'category'))
  const privateHistoryLine = source.split('\n').findIndex((line) => line.includes('self.history.append'))
  const privateHistorySource = source.split('\n')[privateHistoryLine]!
  const privateHistoryColumn = privateHistorySource.indexOf('self.history') + 'self.'.length
  const privateHistoryCompletions = await services.getCompletions({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: privateHistoryLine + 1, column: privateHistoryColumn + 1 },
  })
  assert.ok(privateHistoryCompletions.items.some((item) => item.label === 'history' && item.detail === 'List<number>'))
  const scoreCardStaticLine = source.split('\n').findIndex((line) => line.includes('print(ScoreCard.category)'))
  const scoreCardStaticSource = source.split('\n')[scoreCardStaticLine]!
  const scoreCardStaticColumn = scoreCardStaticSource.indexOf('ScoreCard.category') + 'ScoreCard.'.length
  const scoreCardStaticCompletions = await services.getCompletions({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: scoreCardStaticLine + 1, column: scoreCardStaticColumn + 1 },
  })
  assert.ok(scoreCardStaticCompletions.items.some((item) => item.label === 'category' && item.detail === 'string'))
  assert.ok(!scoreCardStaticCompletions.items.some((item) => item.label === 'total'))
  const scoreCardDefinition = await services.getDefinition({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: scoreCardUseLine + 1, column: scoreCardMemberColumn + 1 },
  })
  const scoreCardTotalDeclarationLine = source.split('\n').findIndex((line) => line.includes('let total: number = 0'))
  assert.equal(scoreCardDefinition.locations[0]?.path, 'src/main.vel')
  assert.equal(scoreCardDefinition.locations[0]?.range?.startLine, scoreCardTotalDeclarationLine + 1)
  const scoreCardSummaryLine = source.split('\n').findIndex((line) => line.includes('print(scoreCard.summary)'))
  const scoreCardSummarySource = source.split('\n')[scoreCardSummaryLine]!
  const scoreCardSummaryColumn = scoreCardSummarySource.indexOf('scoreCard.summary') + 'scoreCard.'.length
  const scoreCardSummaryDefinition = await services.getDefinition({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: scoreCardSummaryLine + 1, column: scoreCardSummaryColumn + 1 },
  })
  const scoreCardSummaryDeclarationLine = source.split('\n').findIndex((line) => line.includes('get summary() -> string'))
  assert.equal(scoreCardSummaryDefinition.locations[0]?.path, 'src/main.vel')
  assert.equal(scoreCardSummaryDefinition.locations[0]?.range?.startLine, scoreCardSummaryDeclarationLine + 1)
  const scoreCardClassLine = source.split('\n').findIndex((line) => line.includes('class ScoreCard'))
  const scoreCardClassColumn = source.split('\n')[scoreCardClassLine]!.indexOf('ScoreCard')
  const scoreCardClassHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: scoreCardClassLine + 1, column: scoreCardClassColumn + 1 },
  })
  assert.match(scoreCardClassHover.hover?.displayText ?? '', /Tracks a score and its ordered history/u)
  const asyncArrowLine = source.split('\n').findIndex((line) => line.includes('const loadTicket:'))
  const asyncArrowParameterLine = source.split('\n').findIndex((line) => line.includes('ticketId,'))
  const asyncArrowParameterColumn = source.split('\n')[asyncArrowParameterLine]!.indexOf('ticketId')
  const asyncArrowParameterHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: asyncArrowParameterLine + 1, column: asyncArrowParameterColumn + 1 },
  })
  assert.match(asyncArrowParameterHover.hover?.displayText ?? '', /parameter ticketId: string/u)
  const asyncCallLine = source.split('\n').findIndex((line) => line.includes('const loadedTicket ='))
  const asyncCallSource = source.split('\n')[asyncCallLine]!
  const asyncCallColumn = asyncCallSource.indexOf('loadTicket(') + 'loadTicket('.length
  const asyncCallSignature = await services.getSignatureHelp({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: asyncCallLine + 1, column: asyncCallColumn + 1 },
  })
  assert.equal(asyncCallSignature.signatureHelp?.signatures[0]?.label, 'loadTicket(string) -> Promise<string>')
  assert.equal(asyncCallSignature.signatureHelp?.activeParameter, 0)
  const asyncArrowHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: asyncArrowLine + 1, column: source.split('\n')[asyncArrowLine]!.indexOf('loadTicket') + 1 },
  })
  assert.match(asyncArrowHover.hover?.displayText ?? '', /\(string\) -> Promise<string>/u)
  const treeMemberLine = source.split('\n').findIndex((line) => line.includes('tree.children[0].label'))
  const treeMemberSource = source.split('\n')[treeMemberLine]!
  const treeChildrenColumn = treeMemberSource.indexOf('tree.children') + 'tree.'.length
  const treeMemberDefinition = await services.getDefinition({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: treeMemberLine + 1, column: treeChildrenColumn + 1 },
  })
  const treeChildrenDeclarationLine = source.split('\n').findIndex((line) => line.includes('children: List<TreeNode>'))
  assert.equal(treeMemberDefinition.locations[0]?.path, 'src/main.vel')
  assert.equal(treeMemberDefinition.locations[0]?.range?.startLine, treeChildrenDeclarationLine + 1)
  const treeMemberRename = await services.getRename({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: treeMemberLine + 1, column: treeChildrenColumn + 1 },
    newName: 'nodes',
  })
  assert.equal(treeMemberRename.changes.length, 1)
  assert.equal(treeMemberRename.changes[0]?.edits.length, 4)
  assert.ok(treeMemberRename.changes[0]?.edits.every((edit) => edit.newText === 'nodes'))
  const choiceDeclarationLine = source.split('\n').findIndex((line) => line.includes('component Choice(show: bool'))
  const choiceUseLine = source.split('\n').findIndex((line) => line.includes('<Choice show={true}'))
  const choiceUseSource = source.split('\n')[choiceUseLine]!
  const choiceShowColumn = choiceUseSource.indexOf('show={true}')
  const choicePropCompletions = await services.getCompletions({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: choiceUseLine + 1, column: choiceShowColumn + 1 },
  })
  assert.ok(choicePropCompletions.items.some((item) => item.label === 'show'))
  assert.ok(choicePropCompletions.items.some((item) => item.label === 'onChoose'))
  assert.ok(choicePropCompletions.items.some((item) => item.label === 'key'))
  assert.ok(!choicePropCompletions.items.some((item) => item.label === 'while'))
  const choiceTagColumn = choiceUseSource.indexOf('<Choice') + '<Ch'.length
  const choiceTagCompletions = await services.getCompletions({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: choiceUseLine + 1, column: choiceTagColumn + 1 },
  })
  assert.ok(choiceTagCompletions.items.some((item) => item.label === 'Choice'))
  assert.deepEqual(choiceTagCompletions.items.map((item) => item.label), ['Choice'])
  assert.ok(!choiceTagCompletions.items.some((item) => item.label === 'while'))
  const choiceBodyLine = source.split('\n').findIndex((line) => line.includes('return <div><button'))
  const choiceBodySource = source.split('\n')[choiceBodyLine]!
  const nativeClosingColumn = choiceBodySource.indexOf('</button>') + '</bu'.length
  const nativeClosingCompletions = await services.getCompletions({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: choiceBodyLine + 1, column: nativeClosingColumn + 1 },
  })
  assert.deepEqual(nativeClosingCompletions.items.map((item) => item.label), ['button'])
  const inlineChartLine = source.split('\n').findIndex((line) => line.includes('return <svg aria-label="Traffic"'))
  const inlineChartSource = source.split('\n')[inlineChartLine]!
  const svgTagColumn = inlineChartSource.indexOf('<svg') + '<sv'.length
  const svgTagCompletions = await services.getCompletions({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: inlineChartLine + 1, column: svgTagColumn + 1 },
  })
  assert.deepEqual(svgTagCompletions.items.map((item) => item.label), ['svg'])
  const svgAttributeColumn = inlineChartSource.indexOf('viewBox')
  const svgAttributeCompletions = await services.getCompletions({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: inlineChartLine + 1, column: svgAttributeColumn + 1 },
  })
  assert.ok(svgAttributeCompletions.items.some((item) => item.label === 'viewBox'))
  assert.ok(svgAttributeCompletions.items.some((item) => item.label === 'stroke-width'))
  const foreignObjectTagColumn = inlineChartSource.indexOf('<foreignObject') + '<foreignO'.length
  const foreignObjectCompletions = await services.getCompletions({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: inlineChartLine + 1, column: foreignObjectTagColumn + 1 },
  })
  assert.deepEqual(foreignObjectCompletions.items.map((item) => item.label), ['foreignObject'])
  const draftLiteralLine = source.split('\n').findIndex((line) => line.includes('const shorthandDraft: FormDraft'))
  const draftLiteralSource = source.split('\n')[draftLiteralLine]!
  const draftFieldColumn = draftLiteralSource.indexOf('{label') + 1
  const draftFieldCompletions = await services.getCompletions({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: draftLiteralLine + 1, column: draftFieldColumn + 1 },
  })
  assert.ok(draftFieldCompletions.items.some((item) => item.label === 'label'))
  assert.ok(draftFieldCompletions.items.some((item) => item.label === 'count'))
  assert.ok(!draftFieldCompletions.items.some((item) => item.label === 'while'))
  const choiceShowDefinition = await services.getDefinition({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: choiceUseLine + 1, column: choiceShowColumn + 1 },
  })
  assert.equal(choiceShowDefinition.locations[0]?.path, 'src/main.vel')
  assert.equal(choiceShowDefinition.locations[0]?.range?.startLine, choiceDeclarationLine + 1)
  const choiceShowHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: choiceUseLine + 1, column: choiceShowColumn + 1 },
  })
  assert.match(choiceShowHover.hover?.displayText ?? '', /parameter show: bool/u)
  const choiceShowReferences = await services.getReferences({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: choiceUseLine + 1, column: choiceShowColumn + 1 },
  })
  assert.equal(choiceShowReferences.locations.length, 3)
  const choiceShowRename = await services.getRename({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: choiceUseLine + 1, column: choiceShowColumn + 1 },
    newName: 'visible',
  })
  assert.equal(choiceShowRename.changes.length, 1)
  assert.equal(choiceShowRename.changes[0]?.edits.length, 3)
  assert.ok(choiceShowRename.changes[0]?.edits.every((edit) => edit.newText === 'visible'))
  const definition = await services.getDefinition({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: source.split('\n').findIndex((line) => line.includes('import("./page.vel")')) + 1, column: 24 },
  })
  assert.equal(definition.locations[0]?.path, 'src/page.vel')
  const signature = await services.getSignatureHelp({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: source.split('\n').findIndex((line) => line.includes('total(1, 2, 3)')) + 1, column: 28 },
  })
  assert.equal(signature.signatureHelp?.signatures[0]?.label, 'total(number, ...number) -> number')
  assert.equal(signature.signatureHelp?.activeParameter, 2)
  const hover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: source.split('\n').findIndex((line) => line.includes('const tags = Set()')) + 1, column: 8 },
  })
  assert.match(hover.hover?.displayText ?? '', /Set<string>/u)
  const pageValuesColumn = source.split('\n')[pageValuesLine]!.indexOf('pageValues')
  const pageValuesHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: pageValuesLine + 1, column: pageValuesColumn + 1 },
  })
  assert.match(pageValuesHover.hover?.displayText ?? '', /List<number>/u)
  const inlayHints = await services.getInlayHints({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    ranges: [{ from: 0, to: source.length }],
    syncOpenFiles: true,
  })
  assert.ok(inlayHints.hints.some((hint) => hint.position.line === pageValuesLine + 1
    && hint.text === ': List<number>'))
  const answerInRangeLine = source.split('\n').findIndex((line) => line.includes('const answerInRange'))
  const answerInRangeColumn = source.split('\n')[answerInRangeLine]!.indexOf('answerInRange')
  assert.ok(inlayHints.hints.some((hint) => hint.position.line === answerInRangeLine + 1
    && hint.text === ': bool'))
  const answerInRangeHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: answerInRangeLine + 1, column: answerInRangeColumn + 1 },
  })
  assert.match(answerInRangeHover.hover?.displayText ?? '', /bool/u)
  const patternReadyLine = source.split('\n').findIndex((line) => line.includes('const patternReady'))
  const patternReadyColumn = source.split('\n')[patternReadyLine]!.indexOf('patternReady')
  const patternReadyHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: patternReadyLine + 1, column: patternReadyColumn + 1 },
  })
  assert.match(patternReadyHover.hover?.displayText ?? '', /bool/u)
  const firstPatternGroupLine = source.split('\n').findIndex((line) => line.includes('const firstPatternGroup'))
  const firstPatternGroupColumn = source.split('\n')[firstPatternGroupLine]!.indexOf('firstPatternGroup')
  const firstPatternGroupHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: firstPatternGroupLine + 1, column: firstPatternGroupColumn + 1 },
  })
  assert.match(firstPatternGroupHover.hover?.displayText ?? '', /string\?/u)
  const parsedPageLine = source.split('\n').findIndex((line) => line.includes('const parsedPage'))
  const parsedPageColumn = source.split('\n')[parsedPageLine]!.indexOf('parsedPage')
  const parsedPageHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: parsedPageLine + 1, column: parsedPageColumn + 1 },
  })
  assert.match(parsedPageHover.hover?.displayText ?? '', /number\?/u)
  const treeLine = source.split('\n').findIndex((line) => line.includes('const tree: TreeNode'))
  const treeColumn = source.split('\n')[treeLine]!.indexOf('tree')
  const treeHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: treeLine + 1, column: treeColumn + 1 },
  })
  assert.match(treeHover.hover?.displayText ?? '', /TreeNode/u)
  const treeHighlights = await services.getDocumentHighlights({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: treeLine + 1, column: treeColumn + 1 },
  })
  assert.ok(treeHighlights.highlights.length >= 4,
    'the declaration and same-document tree references must be highlighted')
  assert.ok(treeHighlights.highlights.every((highlight) => highlight.kind === 'read'))
  assert.ok(!inlayHints.hints.some((hint) => hint.position.line === treeLine + 1))
  const resourceDeclarationLine = source.split('\n').findIndex((line) => line.includes('resource ticketLabel'))
  assert.ok(!inlayHints.hints.some((hint) => hint.position.line === resourceDeclarationLine + 1),
    'resource handle shapes must not be presented as source annotations')
  const firstTreeLabelLine = source.split('\n').findIndex((line) => line.includes('const firstTreeLabel'))
  const firstTreeLabelColumn = source.split('\n')[firstTreeLabelLine]!.indexOf('firstTreeLabel')
  const firstTreeLabelHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: firstTreeLabelLine + 1, column: firstTreeLabelColumn + 1 },
  })
  assert.match(firstTreeLabelHover.hover?.displayText ?? '', /string/u)
  const sameTreeLine = source.split('\n').findIndex((line) => line.includes('const sameTree'))
  const sameTreeColumn = source.split('\n')[sameTreeLine]!.indexOf('sameTree')
  const sameTreeHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: sameTreeLine + 1, column: sameTreeColumn + 1 },
  })
  assert.match(sameTreeHover.hover?.displayText ?? '', /bool/u)
  const stopTimerLine = source.split('\n').findIndex((line) => line.includes('const stopTimer'))
  const stopTimerColumn = source.split('\n')[stopTimerLine]!.indexOf('stopTimer')
  const stopTimerHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: stopTimerLine + 1, column: stopTimerColumn + 1 },
  })
  assert.match(stopTimerHover.hover?.displayText ?? '', /\(\) -> none/u)
  const enumLine = source.split('\n').findIndex((line) => line.includes('TaskStatus.todo'))
  const memberColumn = source.split('\n')[enumLine]!.indexOf('todo')
  const enumCompletions = await services.getCompletions({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: enumLine + 1, column: memberColumn + 1 },
  })
  assert.deepEqual(enumCompletions.items.map((item) => item.label), ['todo', 'doing', 'is', 'parse'])
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
  const resourceLine = source.split('\n').findIndex((line) => line.includes('resource ticketLabel'))
  const resourceColumn = source.split('\n')[resourceLine]!.indexOf('ticketLabel')
  const resourceHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: resourceLine + 1, column: resourceColumn + 1 },
  })
  assert.match(resourceHover.hover?.displayText ?? '', /resource ticketLabel/u)
  assert.match(resourceHover.hover?.displayText ?? '', /Promise<none>/u)
  const actionLine = source.split('\n').findIndex((line) => line.includes('action refresh'))
  const actionColumn = source.split('\n')[actionLine]!.indexOf('refresh')
  const actionHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: actionLine + 1, column: actionColumn + 1 },
  })
  assert.match(actionHover.hover?.displayText ?? '', /action refresh/u)
  assert.match(actionHover.hover?.displayText ?? '', /Promise<none>/u)
  const draftLine = source.split('\n').findIndex((line) => line.includes('const draft = read'))
  const draftColumn = source.split('\n')[draftLine]!.indexOf('draft')
  const draftHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: draftLine + 1, column: draftColumn + 1 },
  })
  assert.match(draftHover.hover?.displayText ?? '', /FormDraft/u)
  const shorthandDraftLine = source.split('\n').findIndex((line) => line.includes('const shorthandDraft'))
  const shorthandDraftColumn = source.split('\n')[shorthandDraftLine]!.indexOf('shorthandDraft')
  const shorthandDraftHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: shorthandDraftLine + 1, column: shorthandDraftColumn + 1 },
  })
  assert.match(shorthandDraftHover.hover?.displayText ?? '', /FormDraft/u)
  const narrowedLine = source.split('\n').findIndex((line) => line.includes('const narrowedCount'))
  const narrowedColumn = source.split('\n')[narrowedLine]!.indexOf('narrowedCount')
  const narrowedHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: narrowedLine + 1, column: narrowedColumn + 1 },
  })
  assert.match(narrowedHover.hover?.displayText ?? '', /number/u)
  assert.doesNotMatch(narrowedHover.hover?.displayText ?? '', /number\?/u)
  const aliasLine = source.split('\n').findIndex((line) => line.includes('type ChooseHandler'))
  const aliasColumn = source.split('\n')[aliasLine]!.indexOf('ChooseHandler')
  const aliasHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: aliasLine + 1, column: aliasColumn + 1 },
  })
  assert.match(aliasHover.hover?.displayText ?? '', /type ChooseHandler/u)
  assert.match(aliasHover.hover?.displayText ?? '', /\(string\) -> none/u)
  const callbackLine = source.split('\n').findIndex((line) => line.includes('onChoose: ChooseHandler'))
  const callbackColumn = source.split('\n')[callbackLine]!.indexOf('onChoose')
  const callbackHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: callbackLine + 1, column: callbackColumn + 1 },
  })
  assert.match(callbackHover.hover?.displayText ?? '', /\(string\) -> none/u)
  const aliasReferenceColumn = source.split('\n')[callbackLine]!.indexOf('ChooseHandler')
  const aliasDefinition = await services.getDefinition({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: callbackLine + 1, column: aliasReferenceColumn + 1 },
  })
  assert.equal(aliasDefinition.locations[0]?.path, 'src/main.vel')
  const aliasReferences = await services.getReferences({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: aliasLine + 1, column: aliasColumn + 1 },
  })
  assert.equal(aliasReferences.locations.length, 2)
  const eventLine = source.split('\n').findIndex((line) => line.includes('on:keydown={event'))
  const eventColumn = source.split('\n')[eventLine]!.indexOf('event =>')
  const eventHover = await services.getHover({
    projectRoot,
    path: 'src/main.vel',
    content: source,
    position: { line: eventLine + 1, column: eventColumn + 1 },
  })
  assert.match(eventHover.hover?.displayText ?? '', /KeyboardEvent/u)
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
