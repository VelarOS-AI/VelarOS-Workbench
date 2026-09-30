import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

import { findLastRunningWorkbenchRunSession } from '../src/renderer/src/hooks/useWorkbenchTopRunControl'
import {
  buildWorkbenchRunConfigurationCommand,
  buildWorkbenchRunConfigurationLaunch,
  describeWorkbenchRunConfiguration,
  normalizeWorkbenchNamedRunConfiguration,
  normalizeWorkbenchRunConfigurationCwd,
  readWorkbenchNamedRunConfigurations,
  RUN_CONFIGURATIONS_STORAGE_KEY,
  saveWorkbenchNamedRunConfigurations,
  type WorkbenchNamedRunConfiguration,
} from '../src/renderer/src/models/commands/workbenchNamedRunConfigurations'
import {
  buildWorkbenchRunConfigurationFromDraft,
  createWorkbenchRunConfigurationDraft,
  duplicateWorkbenchRunConfigurationDraft,
  formatWorkbenchRunEnvironmentText,
  parseWorkbenchRunEnvironmentText,
  toWorkbenchRunConfigurationDraft,
  uniqueWorkbenchRunConfigurationName,
  validateWorkbenchRunConfigurationDraft,
} from '../src/renderer/src/models/commands/workbenchRunConfigurationDrafts'
import { normalizeWorkbenchProjectRunSettings } from '../src/renderer/src/models/settings/workbenchPreferences'
import type { StorageLike } from '../src/renderer/src/persistence/localStorageJsonStore'
import { readWorkbenchRunEnvironment } from '../src/shared/workbenchRunEnvironment'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

function createStorage(initial: Record<string, string> = {}): StorageLike & {
  values: Map<string, string>
} {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  }
}

const Dev: WorkbenchNamedRunConfiguration = {
  id: 'run-configuration-dev',
  name: 'API server',
  type: 'command',
  command: 'bun run dev',
  script: '',
  args: '',
  cwd: 'packages/api',
  env: { PORT: '4100', NODE_ENV: 'development' },
}

/** 一个 Node 程序：脚本在工作目录里。 */
const Server: WorkbenchNamedRunConfiguration = {
  id: 'run-configuration-server',
  name: 'Server',
  type: 'node',
  command: '',
  script: 'packages/api/src/server.js',
  args: '--port 4100',
  cwd: 'packages/api',
  env: { NODE_ENV: 'development' },
}

void describe('run configuration environment variables', () => {
  void test('reads KEY=VALUE lines, keeps values verbatim and reports the lines it cannot read', () => {
    const parsed = parseWorkbenchRunEnvironmentText(
      [
        'PORT=4100',
        '',
        '# a comment',
        '  SPACED_NAME  = padded value ',
        'URL=postgres://user:pa=ss@localhost/db',
        'QUOTED="kept as written"',
        'EMPTY=',
        'no equals sign',
        '1BAD=value',
        'PORT=4200',
      ].join('\r\n')
    )

    assert.deepEqual(parsed.environment, {
      // 同名的后一行盖掉前一行，位置留在第一次出现的地方。
      PORT: '4200',
      SPACED_NAME: ' padded value ',
      URL: 'postgres://user:pa=ss@localhost/db',
      QUOTED: '"kept as written"',
      EMPTY: '',
    })
    assert.deepEqual(parsed.issues, [
      { line: 8, text: 'no equals sign', reason: 'missing-equals' },
      { line: 9, text: '1BAD=value', reason: 'invalid-name' },
    ])
    assert.equal(
      formatWorkbenchRunEnvironmentText({ A: '1', B: 'two words' }),
      'A=1\nB=two words'
    )
    assert.deepEqual(parseWorkbenchRunEnvironmentText('').environment, {})
  })

  void test('accepts a record from outside only when every entry is a named string', () => {
    assert.deepEqual(readWorkbenchRunEnvironment(undefined), {})
    assert.deepEqual(readWorkbenchRunEnvironment({ A: '1', _b2: '' }), { A: '1', _b2: '' })
    for (const invalid of [
      'A=1',
      ['A=1'],
      { A: 1 },
      { 'A B': '1' },
      { 'A=B': '1' },
      { '': '1' },
      { A: 'nul\0byte' },
      JSON.parse('{"__proto__":"polluted"}') as unknown,
      Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`V${index}`, '1'])),
    ])
      assert.equal(readWorkbenchRunEnvironment(invalid), null)
  })
})

void describe('named run configurations', () => {
  void test('keeps a working directory inside the project', () => {
    assert.equal(normalizeWorkbenchRunConfigurationCwd(''), '')
    assert.equal(normalizeWorkbenchRunConfigurationCwd(' . '), '')
    assert.equal(normalizeWorkbenchRunConfigurationCwd('./packages//api/'), 'packages/api')
    assert.equal(normalizeWorkbenchRunConfigurationCwd('packages\\api'), 'packages/api')
    assert.equal(normalizeWorkbenchRunConfigurationCwd('/etc'), null)
    assert.equal(normalizeWorkbenchRunConfigurationCwd('C:\\work'), null)
    assert.equal(normalizeWorkbenchRunConfigurationCwd('packages/../../outside'), null)
  })

  void test('stores configurations per project and validates them again when read', () => {
    const storage = createStorage()
    assert.deepEqual(readWorkbenchNamedRunConfigurations('project-a', storage), [])

    const saved = saveWorkbenchNamedRunConfigurations('project-a', [Dev], storage, null)
    assert.deepEqual(saved, [Dev])
    assert.deepEqual(readWorkbenchNamedRunConfigurations('project-a', storage), [Dev])
    assert.deepEqual(readWorkbenchNamedRunConfigurations('project-b', storage), [])
    assert.deepEqual(readWorkbenchNamedRunConfigurations(null, storage), [])

    // 存储里的东西不原样信：认不出的项丢掉，工作目录不在项目里的退回项目根，环境变量不合规的清空。
    storage.values.set(
      RUN_CONFIGURATIONS_STORAGE_KEY,
      JSON.stringify({
        'project-a': [
          { ...Dev, cwd: '../outside', env: { 'BAD NAME': '1' } },
          { ...Dev, id: 'second', name: '  Trimmed  ', command: '  npm test  ', cwd: 7, env: null },
          { ...Dev },
          { id: 'no-command', name: 'x', command: '   ' },
          { id: 'no-name', name: '', command: 'ls' },
          { name: 'no id', command: 'ls' },
          'not an object',
          null,
          // Node 程序：脚本必须在项目里；命令那一栏不算数。
          { ...Server, command: 'ignored', script: './packages/api//src/server.js', args: '  --port 4100 ' },
          { ...Server, id: 'outside', script: '../outside.js' },
          { ...Server, id: 'no-script', script: ' ' },
          // 认不出的种类当命令型：有命令就留下，没有就丢掉。
          { ...Dev, id: 'unknown-type', type: 'python', script: 'main.py' },
          { ...Server, id: 'unknown-type-without-command', type: 'python' },
        ],
        'project-b': 'not a list',
        'project-c': [],
      })
    )
    assert.deepEqual(readWorkbenchNamedRunConfigurations('project-a', storage), [
      { ...Dev, cwd: '', env: {} },
      { ...Dev, id: 'second', name: 'Trimmed', command: 'npm test', cwd: '', env: {} },
      Server,
      { ...Dev, id: 'unknown-type' },
    ])
    // 存着的配置没有「种类」这一栏（更早存的）：就是命令型。
    assert.deepEqual(
      normalizeWorkbenchNamedRunConfiguration({ id: 'old', name: 'Old', command: 'make', cwd: '', env: {} }),
      { id: 'old', name: 'Old', type: 'command', command: 'make', script: '', args: '', cwd: '', env: {} }
    )
    assert.deepEqual(readWorkbenchNamedRunConfigurations('project-b', storage), [])

    storage.values.set(RUN_CONFIGURATIONS_STORAGE_KEY, '{ broken json')
    assert.deepEqual(readWorkbenchNamedRunConfigurations('project-a', storage), [])

    // 删光了就不留空壳。
    saveWorkbenchNamedRunConfigurations('project-a', [Dev], storage, null)
    saveWorkbenchNamedRunConfigurations('project-a', [], storage, null)
    assert.equal(storage.values.get(RUN_CONFIGURATIONS_STORAGE_KEY), '{}')
  })

  void test('tells the window when the configurations of a project were saved', () => {
    const events: string[] = []
    saveWorkbenchNamedRunConfigurations('project-a', [Dev], createStorage(), {
      dispatchEvent: (event: Event) => {
        events.push(`${event.type}:${(event as CustomEvent<{ projectId: string }>).detail.projectId}`)
        return true
      },
    })
    assert.deepEqual(events, ['velaros:workbench-run-configurations-changed:project-a'])
  })

  void test('edits a configuration through a draft and refuses to save an incomplete one', () => {
    const draft = toWorkbenchRunConfigurationDraft(Dev)
    assert.deepEqual(draft, {
      id: Dev.id,
      name: 'API server',
      type: 'command',
      command: 'bun run dev',
      script: '',
      args: '',
      cwd: 'packages/api',
      envText: 'PORT=4100\nNODE_ENV=development',
    })
    assert.equal(validateWorkbenchRunConfigurationDraft(draft), null)
    assert.deepEqual(buildWorkbenchRunConfigurationFromDraft(draft), Dev)

    const edited = { ...draft, name: '  Web  ', cwd: './apps/web/', envText: 'PORT=5173\n\n# note\n' }
    assert.deepEqual(buildWorkbenchRunConfigurationFromDraft(edited), {
      ...Dev,
      name: 'Web',
      cwd: 'apps/web',
      env: { PORT: '5173' },
    })

    const broken = { ...draft, name: ' ', command: '', cwd: '../up', envText: 'PORT 4100' }
    assert.deepEqual(validateWorkbenchRunConfigurationDraft(broken), {
      name: 'required',
      command: 'required',
      cwd: 'outside-project',
      env: [{ line: 1, text: 'PORT 4100', reason: 'missing-equals' }],
    })
    assert.equal(buildWorkbenchRunConfigurationFromDraft(broken), null)
  })

  void test('a Node program needs a script inside the project instead of a command', () => {
    const draft = toWorkbenchRunConfigurationDraft(Server)
    assert.deepEqual(
      [draft.type, draft.script, draft.args, draft.command],
      ['node', 'packages/api/src/server.js', '--port 4100', '']
    )
    assert.equal(validateWorkbenchRunConfigurationDraft(draft), null)
    assert.deepEqual(buildWorkbenchRunConfigurationFromDraft(draft), Server)

    // 换种类时另一边输入框里的字留在草稿里（换回来还在），存的时候只留这个种类用得上的。
    const switched = { ...toWorkbenchRunConfigurationDraft(Dev), type: 'node' as const, script: 'src/main.ts' }
    assert.equal(validateWorkbenchRunConfigurationDraft(switched), null)
    assert.deepEqual(buildWorkbenchRunConfigurationFromDraft(switched), {
      ...Dev,
      type: 'node',
      command: '',
      script: 'src/main.ts',
    })

    assert.deepEqual(validateWorkbenchRunConfigurationDraft({ ...draft, script: '  ', command: '' }), {
      script: 'required',
    })
    assert.deepEqual(validateWorkbenchRunConfigurationDraft({ ...draft, script: '/etc/passwd' }), {
      script: 'outside-project',
    })
    assert.deepEqual(validateWorkbenchRunConfigurationDraft({ ...draft, script: '../up.js' }), {
      script: 'outside-project',
    })
  })

  void test('creates and duplicates drafts with their own ids and names that are not taken', () => {
    const created = createWorkbenchRunConfigurationDraft('Untitled')
    assert.match(created.id, /^run-configuration-/u)
    assert.deepEqual(
      { ...created, id: '' },
      { id: '', name: 'Untitled', type: 'command', command: '', script: '', args: '', cwd: '', envText: '' }
    )

    const copy = duplicateWorkbenchRunConfigurationDraft(
      toWorkbenchRunConfigurationDraft(Dev),
      'API server copy'
    )
    assert.notEqual(copy.id, Dev.id)
    assert.equal(copy.command, Dev.command)
    assert.equal(copy.envText, 'PORT=4100\nNODE_ENV=development')

    assert.equal(uniqueWorkbenchRunConfigurationName('Untitled', []), 'Untitled')
    assert.equal(uniqueWorkbenchRunConfigurationName('Untitled', ['untitled ']), 'Untitled 2')
    assert.equal(
      uniqueWorkbenchRunConfigurationName('Untitled', ['Untitled', 'Untitled 2']),
      'Untitled 3'
    )
  })

  void test('launches with its working directory and variables, and only what it needs', () => {
    assert.deepEqual(buildWorkbenchRunConfigurationLaunch(Dev), {
      configurationId: Dev.id,
      cwd: 'packages/api',
      env: { PORT: '4100', NODE_ENV: 'development' },
    })
    assert.deepEqual(buildWorkbenchRunConfigurationLaunch({ ...Dev, cwd: '', env: {} }), {
      configurationId: Dev.id,
    })
    assert.equal(describeWorkbenchRunConfiguration(Dev), 'bun run dev · packages/api')
    assert.equal(describeWorkbenchRunConfiguration({ ...Dev, cwd: '' }), 'bun run dev')
    // 调试只对 Node 程序有意义：命令型配置要求调试也照常运行。
    assert.deepEqual(buildWorkbenchRunConfigurationLaunch(Dev, true), buildWorkbenchRunConfigurationLaunch(Dev))
  })

  void test('a Node program runs as `node script args` and can be debugged', () => {
    // 命令在工作目录里跑：脚本写成相对工作目录的路径。
    assert.equal(buildWorkbenchRunConfigurationCommand(Server, false), 'node src/server.js --port 4100')
    assert.equal(
      buildWorkbenchRunConfigurationCommand({ ...Server, cwd: '', args: '' }, false),
      'node packages/api/src/server.js'
    )
    assert.equal(
      buildWorkbenchRunConfigurationCommand({ ...Server, cwd: 'packages/web/app' }, false),
      'node ../../api/src/server.js --port 4100'
    )
    assert.equal(
      buildWorkbenchRunConfigurationCommand({ ...Server, script: 'my scripts/run it.js', cwd: '' }, false),
      "node 'my scripts/run it.js' --port 4100"
    )
    assert.equal(
      buildWorkbenchRunConfigurationCommand({ ...Server, script: 'my scripts/run it.js', cwd: '' }, true),
      'node "my scripts/run it.js" --port 4100'
    )
    assert.equal(buildWorkbenchRunConfigurationCommand(Dev, false), 'bun run dev')

    // 运行：一张普通的运行卡。调试：同样的目录与变量，另带着「调试哪个脚本」——脚本是项目里的路径，主进程自己
    // 按工作目录去拼命令。
    assert.deepEqual(buildWorkbenchRunConfigurationLaunch(Server), {
      configurationId: Server.id,
      cwd: 'packages/api',
      env: { NODE_ENV: 'development' },
    })
    assert.deepEqual(buildWorkbenchRunConfigurationLaunch(Server, true), {
      configurationId: Server.id,
      cwd: 'packages/api',
      env: { NODE_ENV: 'development' },
      debug: {
        target: { kind: 'node-script', script: 'packages/api/src/server.js', args: '--port 4100' },
      },
    })
    assert.deepEqual(buildWorkbenchRunConfigurationLaunch({ ...Server, args: '' }, true).debug, {
      target: { kind: 'node-script', script: 'packages/api/src/server.js' },
    })
  })

  void test('a running card belongs to the configuration that started it, not to its command', () => {
    const sessions = [
      { id: 'plain', command: 'bun run dev', isRunning: true },
      { id: 'configured', command: 'bun run dev', isRunning: true, launch: { configurationId: Dev.id } },
      { id: 'other', command: 'bun run dev', isRunning: true, launch: { configurationId: 'other' } },
      { id: 'stopped', command: 'bun run dev', isRunning: false, launch: { configurationId: Dev.id } },
    ]
    assert.equal(findLastRunningWorkbenchRunSession('bun run dev', sessions, Dev.id)?.id, 'configured')
    assert.equal(findLastRunningWorkbenchRunSession('bun run dev', sessions)?.id, 'plain')
    assert.equal(findLastRunningWorkbenchRunSession('bun run dev', sessions, 'missing'), undefined)

    // 运行与调试分开认：调试卡不算「这份配置正在运行」，反过来也一样。
    const debugging = [
      ...sessions,
      {
        id: 'debugging',
        command: 'node src/server.js',
        isRunning: true,
        launch: { configurationId: Dev.id, debug: { target: { kind: 'node-script' as const, script: 'a.js' } } },
      },
    ]
    assert.equal(findLastRunningWorkbenchRunSession('bun run dev', debugging, Dev.id)?.id, 'configured')
    assert.equal(findLastRunningWorkbenchRunSession('', debugging, Dev.id, true)?.id, 'debugging')
    assert.equal(findLastRunningWorkbenchRunSession('', sessions, Dev.id, true), undefined)
  })

  void test('the run button remembers which configuration it points at', () => {
    assert.deepEqual(normalizeWorkbenchProjectRunSettings(undefined), {
      command: '',
      configurationId: '',
    })
    assert.deepEqual(
      normalizeWorkbenchProjectRunSettings({ command: ' npm start ', configurationId: ` ${Dev.id} ` }),
      { command: 'npm start', configurationId: Dev.id }
    )
    assert.deepEqual(
      normalizeWorkbenchProjectRunSettings({ command: 7, configurationId: {} } as never),
      { command: '', configurationId: '' }
    )
  })

  void test('the run menu lists them first, runs them with their settings and opens the editor', () => {
    const toolbar = readSource('src/renderer/src/components/chrome/TopToolbar.tsx')
    const named = toolbar.indexOf('topRun.namedConfigurations.map')
    assert.ok(named > 0)
    assert.ok(named < toolbar.indexOf('className={styles.runActionConfig}'))
    assert.ok(named < toolbar.indexOf('topRun.options.map'))
    assert.match(toolbar, /workbench\.runConfigurationsEdit/u)
    assert.match(toolbar, /topRun\.editConfigurations\(\)/u)
    assert.match(toolbar, /topRun\.runConfiguration\(configurationId\)/u)

    const controller = readSource('src/renderer/src/hooks/useWorkbenchCommandController.ts')
    // 起卡与重启走同一个函数，它把工作目录和环境变量交给主进程（运行走终端，调试走调试器，两条路都交）。
    assert.match(controller, /initialCommand: command,\n\s+cwd: launch\?\.cwd,\n\s+env: launch\?\.env,/u)
    assert.match(controller, /target: launch\.debug\.target,\n\s+cwd: launch\.cwd,\n\s+env: launch\.env,/u)
    assert.equal(
      controller.match(/await startRunSessionProcess\(project, command, launch\)/gu)?.length,
      2
    )

    const presentation = readSource('src/renderer/src/StandaloneWorkbenchPagePresentation.tsx')
    // 对话框不进工作区外壳包，只有它用的草稿编辑也不进：外壳里的模块不引它。
    assert.match(
      presentation,
      /const LazyWorkbenchRunConfigurationsDialog = lazyWithPreload\(\s+async \(\) =>\s+\(await import\('\.\/components\/run\/WorkbenchRunConfigurationsDialog'\)\)/u
    )
    for (const shellModule of [
      'src/renderer/src/models/commands/workbenchNamedRunConfigurations.ts',
      'src/renderer/src/hooks/useWorkbenchTopRunControl.ts',
      'src/renderer/src/hooks/useWorkbenchNamedRunConfigurations.ts',
      'src/renderer/src/components/chrome/TopToolbar.tsx',
    ])
      assert.doesNotMatch(readSource(shellModule), /from '[^']*workbenchRunConfigurationDrafts'/u)
  })
})
