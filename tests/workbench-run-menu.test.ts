import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { describe, test } from 'bun:test'

import { findLastRunningWorkbenchRunSession } from '../src/renderer/src/hooks/useWorkbenchTopRunControl'
import { workbenchRunCommandKey } from '../src/renderer/src/models/commands/workbenchCommandLines'
import { buildPackageScriptCommandSuggestions } from '../src/renderer/src/models/commands/workbenchCommandSuggestions'
import { buildWorkbenchPackageScriptRunCommand } from '../src/renderer/src/models/commands/workbenchPackageScriptCommand'
import { buildWorkbenchRunConfigurations } from '../src/renderer/src/models/commands/workbenchRunConfigurations'

void describe('Workbench run button menu', () => {
  void test('keeps every runnable root package.json script', () => {
    const scripts = Object.fromEntries(
      Array.from({ length: 14 }, (_, index) => [`task:${index + 1}`, `echo ${index + 1}`])
    )
    const suggestions = buildPackageScriptCommandSuggestions(JSON.stringify({ scripts }), 'bun')
    const configurations = buildWorkbenchRunConfigurations({ suggestions, history: [] })

    assert.equal(suggestions.length, 14)
    assert.equal(configurations.length, 14)
    assert.ok(configurations.some((configuration) => configuration.command === 'bun run task:14'))
  })

  void test('retains an explicit limit for consumers that request one', () => {
    const suggestions = buildPackageScriptCommandSuggestions(
      JSON.stringify({ scripts: { dev: 'vite', test: 'bun test', lint: 'eslint .' } }),
      'bun',
      2
    )

    assert.equal(suggestions.length, 2)
    assert.equal(
      buildWorkbenchRunConfigurations({ suggestions, history: [], limit: 1 }).length,
      1
    )
  })

  void test('retains literal generated targets through menus and distinguishes shell text', () => {
    const name = 'task "quoted" 100% $(echo marker) `literal`'
    const suggestions = buildPackageScriptCommandSuggestions(JSON.stringify({ scripts: { [name]: 'echo ok' } }), 'npm')
    const generated = suggestions[0]!
    const configurations = buildWorkbenchRunConfigurations({
      suggestions,
      history: [{ command: generated.command, lastRunAt: 1, lastSuccess: true, durationMs: 0, exitCode: 0 }],
    })
    assert.equal(configurations.length, 2)
    assert.deepEqual(configurations.find((configuration) => configuration.source === 'package.json')?.launch?.process, { kind: 'package-manager', program: 'npm', argv: ['run', name] })
    assert.notEqual(workbenchRunCommandKey(generated.command, generated.launch), workbenchRunCommandKey(generated.command))
    const nested = buildWorkbenchPackageScriptRunCommand({ packageJsonPath: 'packages/a $quoted/package.json', packageManager: 'pnpm', scriptName: name })
    assert.deepEqual(nested.launch, { cwd: 'packages/a $quoted', process: { kind: 'package-manager', program: 'pnpm', argv: ['run', name] } })
    const sessions = [
      { id: 'generated', command: generated.command, launch: generated.launch, isRunning: true },
      { id: 'shell', command: generated.command, isRunning: true },
    ]
    assert.equal(findLastRunningWorkbenchRunSession(generated.command, sessions)?.id, 'shell')
    assert.equal(findLastRunningWorkbenchRunSession(generated.command, sessions, undefined, false, generated.launch)?.id, 'generated')
    assert.equal(findLastRunningWorkbenchRunSession(generated.command, sessions, undefined, false, { ...generated.launch, cwd: 'another-package' }), undefined)
  })

  void test('detects the latest still-running session for the selected command only', () => {
    const match = findLastRunningWorkbenchRunSession('bun run dev', [
      { id: 'old-dev', command: 'bun run dev', isRunning: false },
      { id: 'test', command: 'bun test', isRunning: true },
      { id: 'new-dev', command: 'bun run dev', isRunning: true },
    ])

    assert.equal(match?.id, 'new-dev')
    assert.equal(
      findLastRunningWorkbenchRunSession('bun run build', [
        { id: 'dev', command: 'bun run dev', isRunning: true },
      ]),
      undefined
    )
  })

  void test('exposes right-click configuration guidance on the rail run button', async () => {
    const [toolbar, topRun, presentation, pageModel] = await Promise.all([
      readFile('src/renderer/src/components/chrome/TopToolbar.tsx', 'utf8'),
      readFile('src/renderer/src/hooks/useWorkbenchTopRunControl.ts', 'utf8'),
      readFile('src/renderer/src/app/StandaloneWorkbenchPagePresentation.tsx', 'utf8'),
      readFile('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx', 'utf8'),
    ])

    assert.match(toolbar, /onContextMenu=\{handleRunContextMenu\}/u)
    assert.match(toolbar, /runRightClickToConfigure/u)
    assert.match(toolbar, /runDuplicateDescription/u)
    assert.match(toolbar, /runStartNew/u)
    assert.match(toolbar, /common\.cancel/u)
    assert.doesNotMatch(topRun, /runConfigurations\.slice\(/u)
    assert.doesNotMatch(topRun, /onOpenRunTool/u)
    assert.match(topRun, /isActiveCommandRunning/u)
    assert.match(presentation, /workbench\.runSessions\.length\s*>\s*0/u)
    assert.match(pageModel, /createdRunSession[\s\S]*surface\.openBottomTool\('run'\)/u)
    assert.match(pageModel, /closedLastRunSession[\s\S]*surface\.collapseCommandPanel\(\)/u)
  })

  void test('renders the enabled run stop action in red', async () => {
    const [terminalChrome, styles] = await Promise.all([
      readFile('src/renderer/src/components/terminal/WorkbenchTerminalToolChrome.tsx', 'utf8'),
      readFile('src/renderer/src/styles/12-actions-terminal.module.css', 'utf8'),
    ])

    assert.match(terminalChrome, /styles\.runStopButton/u)
    assert.match(styles, /\.runStopButton:not\(:disabled\)[\s\S]*color: var\(--status-red\)/u)
    assert.match(styles, /\.runStopButton:hover:not\(:disabled\)[\s\S]*background: var\(--status-red-soft\)/u)
  })

  void test('shows a green rail indicator while any run session is still executing', async () => {
    const [presentation, styles] = await Promise.all([
      readFile('src/renderer/src/app/StandaloneWorkbenchPagePresentation.tsx', 'utf8'),
      readFile('src/renderer/src/styles/03-layout.module.css', 'utf8'),
    ])

    assert.match(
      presentation,
      /const hasRunningRunSession = workbench\.runSessions\.some\(\(session\) => session\.isRunning\)/u
    )
    assert.match(presentation, /isRunning: hasRunningRunSession/u)
    assert.match(presentation, /data-running=\{item\.isRunning\}/u)
    assert.match(presentation, /item\.isRunning[\s\S]*workbench\.commandRunning/u)
    assert.match(
      styles,
      /\.leftToolButton\[data-running='true'\]::after[\s\S]*top: 3px[\s\S]*right: 3px[\s\S]*width: 6px[\s\S]*height: 6px[\s\S]*background: var\(--status-green\)/u
    )
  })
})
