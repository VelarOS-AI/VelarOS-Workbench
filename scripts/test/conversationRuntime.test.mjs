// 用途：在 Node 里用真的 ScriptAct 循环（脚本化的模型 + 真的脚本子进程 + 临时项目）检查 Workbench 的会话运行时。
// Platform 的本地存储要 node:sqlite，bun 没有，所以把运行时打成包放进 Node 跑（与 Desktop 的运行时测试同一做法）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '../..')
// 包放在仓库里：外置的依赖要从仓库的 node_modules 解析。测试项目与会话数据放在系统临时目录。
await mkdir(join(root, '.velaros/workspace'), { recursive: true })
const bundleDirectory = await mkdtemp(join(root, '.velaros/workspace/conversation-runtime-test-'))
const build = await mkdtemp(join(tmpdir(), 'workbench-conversation-runtime-'))
after(() => rm(bundleDirectory, { recursive: true, force: true }))
after(() => rm(build, { recursive: true, force: true }))
const bundle = join(bundleDirectory, 'runtime.mjs')
const built = spawnSync(
  'bun',
  [
    'build',
    'tests/fixtures/conversationRuntimeEntry.ts',
    '--target=node',
    '--format=esm',
    '--packages=external',
    '--outfile',
    bundle,
  ],
  { cwd: root, encoding: 'utf8' }
)
assert.equal(built.status, 0, built.stderr)
const {
  createWorkbenchConversationRuntime,
  WorkbenchMemoryService,
  WorkbenchShellHostRegistry,
  WorkbenchSessionPeers,
} = await import(pathToFileURL(bundle).href)

/** 原生工具协议：exec 执行标准 Node 程序，done 明确提交本轮完成结果。 */
let toolSequence = 0
const execute = (_frame, code) => ({
  type: 'tool-call',
  value: { id: `exec-${++toolSequence}`, name: 'exec', input: { code } },
})
const done = (_frame, message = '完成') => ({
  type: 'tool-call',
  value: { id: `done-${++toolSequence}`, name: 'done', input: { message } },
})

function modelFrom(frames, generate, id = 'integration-model') {
  return {
    id,
    nativeTools: true,
    limits: { contextTokens: 128_000, inputTokens: 110_000, outputTokens: 12_000 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'test' }),
    async *stream(input, signal) {
      frames.push(input)
      yield* generate(input, signal, frames.length)
    },
  }
}

async function fixture(t, generate, options = {}) {
  const directory = await mkdtemp(join(build, 'case-'))
  const workspace = join(directory, 'project')
  await mkdir(workspace)
  const events = []
  const frames = []
  const windows = { begun: 0, finished: 0 }
  // 项目编辑写到的文件：记下当时界面已经收到几次「改项目」通知（语言服务要先于界面拿到）
  const edits = []
  const activity = {
    beginFileWrite: () => () => undefined,
    beginCommand: () => {
      windows.begun += 1
      return () => {
        windows.finished += 1
      }
    },
  }
  const shells = new WorkbenchShellHostRegistry()
  const memory = new WorkbenchMemoryService(join(directory, 'memory'))
  // 网上查资料的无头页面：测试里只看模块挂没挂上，不真的开网页。
  const webPages = {
    openPage: async () => {
      throw new Error('测试不开网页')
    },
  }
  // Agent 浏览器：测试里只看模块挂没挂上、每帧带不带页面，不真的开页面。
  const browserCalls = []
  const browser = {
    conversation: (ref) => {
      browserCalls.push(['conversation', ref.sessionId])
      return {
        port: () => {
          throw new Error('测试不开页面')
        },
        environment: () => ({ browser: '还没进站点' }),
      }
    },
    settleRun: (ref) => browserCalls.push(['settleRun', ref.sessionId]),
    leaveSite: async (ref) => {
      browserCalls.push(['leaveSite', ref.sessionId])
    },
  }
  const runtime = createWorkbenchConversationRuntime({
    nodeExecutable: process.execPath,
    shells,
    dataDir: join(directory, 'state'),
    configure: async () => ({
      model: modelFrom(frames, generate),
      provider: 'test',
      imageInput: options.imageInput ?? true,
    }),
    environment: () => ({ os: 'test-os' }),
    activity: () => activity,
    projectFilesEdited: (ref, paths) =>
      edits.push({
        sessionId: ref.sessionId,
        paths: [...paths],
        notices: events.filter((event) => event.kind === 'conversation-project-activity').length,
      }),
    projectRules: async () => options.rules ?? [],
    memory: (workspace) => memory.forRun(workspace),
    webPages,
    browser,
    sessions: options.sessions,
  })
  t.after(async () => {
    await runtime.close()
    await shells.dispose()
  })
  const sink = {
    notice: (kind, payload) => events.push({ type: 'notice', kind, payload }),
    state: (payload) => events.push({ type: 'state', payload }),
  }
  const request = (text, overrides = {}) => ({
    sessionId: 'session-1',
    projectRoot: workspace,
    inputId: `input-${text}`,
    text,
    locale: 'zh-CN',
    model: {
      provider: 'openrouter',
      model: 'test-model',
      apiKey: 'test',
      baseURL: 'http://localhost',
    },
    reasoningLevel: 'medium',
    executionModes: [],
    permissionMode: 'standard-open',
    memory: true,
    webSearchEngine: 'google',
    ...overrides,
  })
  const lastState = () => events.filter((event) => event.type === 'state').at(-1)?.payload ?? null
  return {
    runtime,
    workspace,
    directory,
    events,
    frames,
    windows,
    edits,
    memory,
    shells,
    browserCalls,
    sink,
    request,
    lastState,
  }
}

test(
  'executes native Node and project edits, refreshes the IDE and preserves process output',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(
      t,
      async function* (frame, _signal, call) {
        if (call === 1)
          yield execute(
            frame,
            "// 改一下文件再跑命令\nimport {edit} from 'velaros:project';import {execa} from 'execa';await edit({steps:[{action:'replace',path:'hello.txt',oldText:'before',newText:'after'}]});await execa('sh',['-c','printf verified > shell-proof.txt']);console.log('NODE-PROOF');"
          )
        else yield done(frame, '改好了')
        yield { type: 'finish', reason: 'stop' }
      },
      { rules: [{ relativePath: 'AGENTS.md', content: '项目规则：回答要简短。' }] }
    )
    await writeFile(join(f.workspace, 'hello.txt'), 'before\n')
    const run = f.runtime.submit(f.sink, f.request('改一下'))
    await run.accepted
    await run.completed
    assert.equal(await readFile(join(f.workspace, 'hello.txt'), 'utf8'), 'after\n')
    assert.equal(await readFile(join(f.workspace, 'shell-proof.txt'), 'utf8'), 'verified')
    assert.equal(f.lastState()?.kind, 'done', JSON.stringify(f.events.slice(-5)))
    const request = JSON.stringify(f.frames[0])
    assert.match(request, /你是 VelarOS Workbench（一个 IDE）里的编程助手/u)
    assert.match(request, /Shell 用 #，Node 用 \/\//u)
    assert.match(request, /<project-rules path=\\"AGENTS\.md\\">\\n项目规则：回答要简短。/u)
    assert(f.windows.begun >= 2)
    assert.equal(f.windows.finished, f.windows.begun)
    assert.equal(
      f.events.filter((event) => event.kind === 'conversation-project-activity').length,
      f.windows.finished
    )
    // 原生进程的外层时间窗还未关闭时，项目编辑先交给语言服务。
    assert.deepEqual(f.edits, [{ sessionId: 'session-1', paths: ['hello.txt'], notices: 0 }])
    const receipt = f.events.find(
      (event) => event.kind === 'conversation-script' && event.payload.status === 'succeeded'
    )?.payload
    assert(receipt, JSON.stringify(f.events))
    assert.equal(receipt.language, 'node')
    assert.match(receipt.processOutput, /NODE-PROOF/u)
    assert(receipt.source.startsWith('// 改一下文件'))
    assert(
      f.events.some(
        (event) =>
          event.kind === 'conversation-text' &&
          event.payload.phase === 'accepted' &&
          event.payload.text.includes('改好了')
      )
    )
  }
)

test(
  'ask-every-time shows the complete Node source and a refusal starts no process',
  { timeout: 30_000 },
  async (t) => {
    const code =
      "// 写入执行凭据\nimport {writeFile} from 'node:fs/promises';await writeFile('ran.txt','ran');"
    const f = await fixture(t, async function* (frame, _signal, call) {
      if (call === 1) yield execute(frame, code)
      else yield done(frame, '已按回复处理')
      yield { type: 'finish', reason: 'stop' }
    })
    const run = f.runtime.submit(f.sink, f.request('写凭据', { permissionMode: 'ask-every-time' }))
    await run.accepted
    let card
    for (let attempt = 0; attempt < 200 && !card; attempt++) {
      card = f.events.find(
        (event) => event.kind === 'conversation-interaction' && event.payload.status === 'pending'
      )?.payload
      if (!card) await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert(card, 'expected Node approval')
    assert.equal(card.message, code)
    await f.runtime.answer({ projectRoot: f.workspace, sessionId: 'session-1' }, card.id, {
      approved: false,
    })
    await run.completed
    await assert.rejects(stat(join(f.workspace, 'ran.txt')), { code: 'ENOENT' })
    assert.equal(f.windows.begun, 0)
    assert.equal(f.lastState()?.kind, 'done')
  }
)

test(
  'recalls project memory on demand and disables its operations for the next session',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, async function* (frame, _signal, call) {
      if (call === 1)
        yield execute(
          frame,
          "// 查构建记忆和网页能力\nimport {memory} from 'velaros:system';import {search} from 'velaros:web';console.log('memory-recall:' + JSON.stringify(await memory.recall({id:'build-command'})));console.log('web-module:' + typeof search);"
        )
      else if (call === 3)
        yield execute(
          frame,
          "// 检查当前记忆操作\nimport {memory} from 'velaros:system';console.log('memory-recall-type:' + typeof memory.recall);"
        )
      else yield done(frame, '好了')
      yield { type: 'finish', reason: 'stop' }
    })
    const { scope } = await f.memory.forRun(await realpath(f.workspace))
    await scope.save({
      id: 'build-command',
      type: 'work',
      title: '构建用 bun run build',
      description: '项目的构建命令',
      content: '构建前先跑 bun install。',
    })
    await f.runtime.submit(f.sink, f.request('构建怎么跑')).completed
    assert.equal(f.lastState()?.kind, 'done', JSON.stringify(f.events.slice(-3)))
    assert.doesNotMatch(JSON.stringify(f.frames[0]), /构建用 bun run build/u)
    assert.match(JSON.stringify(f.frames[1]), /构建用 bun run build/u)
    assert.match(JSON.stringify(f.frames[1]), /web-module:function/u)
    await f.runtime.submit(f.sink, f.request('再问一次', { memory: false, sessionId: 'session-2' }))
      .completed
    assert.match(JSON.stringify(f.frames[3]), /memory-recall-type:undefined/u)
    assert.doesNotMatch(JSON.stringify(f.frames[3]), /构建用 bun run build/u)
  }
)

test(
  'discovers project and browser capabilities on demand and settles the session browser',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, async function* (frame, _signal, call) {
      if (call === 1)
        yield execute(
          frame,
          "// 查看代码能力\nimport {open} from 'velaros:browser';import {list} from 'velaros:modules';console.log('browser-module:'+typeof open);console.log('mounted:'+JSON.stringify(await list({limit:100}))); "
        )
      else yield done(frame, '好了')
      yield { type: 'finish', reason: 'stop' }
    })
    await f.runtime.submit(f.sink, f.request('有哪些模块')).completed
    assert.equal(f.lastState()?.kind, 'done', JSON.stringify(f.events.slice(-3)))
    assert.match(JSON.stringify(f.frames[0]), /还没进站点/u)
    const observed = JSON.stringify(f.frames[1])
    assert.match(observed, /browser-module:function/u)
    for (const moduleId of [
      'velaros:browser',
      'velaros:devtools',
      'velaros:cdp',
      'velaros:web',
      'velaros:project',
      'velaros:code',
      'velaros:images',
      'velaros:agents',
    ])
      assert(observed.includes(moduleId), moduleId)
    assert.deepEqual(f.browserCalls, [
      ['conversation', 'session-1'],
      ['settleRun', 'session-1'],
    ])
    await f.runtime.deleteSession({ projectRoot: f.workspace, sessionId: 'session-1' })
    assert.deepEqual(f.browserCalls.at(-1), ['leaveSite', 'session-1'])
  }
)

test(
  'host image capability delivers project images and enforces the project path boundary',
  { timeout: 30_000 },
  async (t) => {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a+9sAAAAASUVORK5CYII='
    const f = await fixture(t, async function* (frame, _signal, call) {
      if (call === 1)
        yield execute(
          frame,
          "// 查看项目图片\nimport assert from 'node:assert/strict';import {view} from 'velaros:images';const result=await view({files:[{path:'tiny.png'},{path:'../outside.png'}]});assert.deepEqual(result.files[0].sent,{width:1,height:1});assert.equal(result.files[1].error.code,'PERMISSION');console.log('IMAGE-BOUNDARY-VERIFIED');"
        )
      else {
        assert.equal(frame.images.length, 1)
        assert.equal(frame.images[0].data, png)
        yield done(frame)
      }
      yield { type: 'finish', reason: 'stop' }
    })
    await writeFile(join(f.workspace, 'tiny.png'), Buffer.from(png, 'base64'))
    await writeFile(join(f.directory, 'outside.png'), Buffer.from(png, 'base64'))
    await f.runtime.submit(f.sink, f.request('查看项目图片')).completed
    assert.equal(f.frames.length, 2)
    assert.equal(f.lastState()?.kind, 'done', JSON.stringify(f.events.slice(-3)))
    const receipt = f.events.find(
      (event) => event.kind === 'conversation-script' && event.payload.status === 'succeeded'
    )?.payload
    assert(receipt, JSON.stringify(f.events))
    assert.match(receipt.processOutput, /IMAGE-BOUNDARY-VERIFIED/u)
  }
)

test(
  'queries project diagnostics and imports code tools directly in a regular run',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, async function* (frame, _signal, call) {
      if (call === 1)
        yield execute(
          frame,
          "// 查询项目并使用代码工具\nimport {query} from 'velaros:code';console.log('DIAGNOSTICS:'+JSON.stringify(await query({intent:'diagnostics',path:'answer.ts'})));const tools=['ts-morph','prettier','jsonc-parser','@ast-grep/napi','@playwright/test'];for(const name of tools)await import(name);console.log('CODE-TOOLS:'+tools.length);const {format}=await import('prettier');console.log('FORMATTED:'+await format('const n:number=42',{parser:'typescript',semi:false}));"
        )
      else yield done(frame)
      yield { type: 'finish', reason: 'stop' }
    })
    await writeFile(join(f.workspace, 'answer.ts'), 'export const answer: number = "wrong";')
    await f.runtime.submit(f.sink, f.request('检查代码')).completed
    assert.equal(f.lastState()?.kind, 'done', JSON.stringify(f.events.slice(-3)))
    const observed = JSON.stringify(f.frames[1])
    assert.match(observed, /DIAGNOSTICS:.*2322/u)
    assert.match(observed, /CODE-TOOLS:5/u)
    assert.match(observed, /FORMATTED:const n: number = 42/u)
  }
)

test(
  'workspace sandbox denies native writes outside the project',
  { timeout: 30_000 },
  async (t) => {
    let outside
    const f = await fixture(t, async function* (frame, _signal, call) {
      if (call === 1)
        yield execute(
          frame,
          `// 检查项目写入边界\nimport {writeFile} from 'node:fs/promises';await writeFile(${JSON.stringify(outside)},'outside');`
        )
      else yield done(frame, '已核验边界')
      yield { type: 'finish', reason: 'stop' }
    })
    outside = join(bundleDirectory, 'sandbox-outside.txt')
    await f.runtime.submit(f.sink, f.request('写入边界', { sandbox: true })).completed
    await assert.rejects(stat(outside), { code: 'ENOENT' })
    assert(
      f.events.some(
        (event) => event.kind === 'conversation-script' && event.payload.status === 'failed'
      )
    )
    assert.match(JSON.stringify(f.frames[0]), /workspace-write sandbox/u)
  }
)

test(
  'notes persist across controls and subsequent runs, with versioned reads and notifications',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, async function* (frame, _signal, call) {
      if (call === 1)
        yield execute(
          frame,
          "// 记录工作笔记\nimport {memory} from 'velaros:system';await memory.update({key:'progress',title:'工作进展',baseRevision:0,body:'NOTE-PERSISTENCE-PROOF'});"
        )
      else if (call === 3)
        yield execute(
          frame,
          "// 更新工作笔记\nimport {memory} from 'velaros:system';await memory.update({key:'progress',baseRevision:1,body:'SECOND-REVISION',resident:false});"
        )
      else yield done(frame)
      yield { type: 'finish', reason: 'stop' }
    })
    const ref = { projectRoot: f.workspace, sessionId: 'session-1' }
    assert.deepEqual(await f.runtime.listNotes(ref), { items: [], nextAfter: null })
    let changes = 0
    const unsubscribe = f.runtime.subscribeNotesChanged((changed) => {
      assert.deepEqual(changed, ref)
      changes++
    })
    await f.runtime.submit(f.sink, f.request('记录')).completed
    assert.equal((await f.runtime.listNotes(ref)).items[0].title, '工作进展')
    assert.equal(
      (await f.runtime.readNote(ref, { key: 'progress', revision: 1 })).text,
      'NOTE-PERSISTENCE-PROOF'
    )
    await f.runtime.submit(f.sink, f.request('更新')).completed
    const entry = (await f.runtime.listNotes(ref)).items[0]
    assert.equal(entry.revision, 2)
    assert.equal(entry.resident, false)
    assert.equal(
      (await f.runtime.readNote(ref, { key: 'progress', revision: 2, offset: 7, limit: 8 })).text,
      'REVISION'
    )
    await assert.rejects(f.runtime.readNote(ref, { key: 'progress', revision: 1 }), {
      code: 'WORKSPACE_CONFLICT',
    })
    assert(changes >= 2)
    unsubscribe()
    await f.runtime.deleteSession(ref)
    assert.deepEqual(await f.runtime.listNotes(ref), { items: [], nextAfter: null })
  }
)

test('rejects a concurrent submission and cancellation aborts the active model', async (t) => {
  const f = await fixture(t, async function* (_frame, signal) {
    await new Promise((resolve) => {
      if (signal.aborted) resolve()
      else signal.addEventListener('abort', resolve, { once: true })
    })
    signal.throwIfAborted()
  })
  const run = f.runtime.submit(f.sink, f.request('等着'))
  await run.accepted
  assert.throws(() => f.runtime.submit(f.sink, f.request('又一条')), /正在运行/u)
  assert.equal(
    (await f.runtime.cancel({ projectRoot: f.workspace, sessionId: 'session-1' })).aborted,
    true
  )
  await run.completed
  assert.equal(f.lastState()?.kind, 'aborted')
})

test(
  'cancel stops a running native Node process and closes its write window',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, async function* (frame) {
      yield execute(
        frame,
        "// 等待取消\nimport {writeFile} from 'node:fs/promises';await writeFile('started.txt','started');await new Promise(resolve=>setTimeout(resolve,30000));await writeFile('finished.txt','finished');"
      )
      yield { type: 'finish', reason: 'stop' }
    })
    const run = f.runtime.submit(f.sink, f.request('运行到取消'))
    await run.accepted
    let started = false
    for (let i = 0; i < 200 && !started; i++) {
      started = await stat(join(f.workspace, 'started.txt')).then(
        () => true,
        () => false
      )
      if (!started) await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert(started)
    await f.runtime.cancel({ projectRoot: f.workspace, sessionId: 'session-1' })
    await run.completed
    await assert.rejects(stat(join(f.workspace, 'finished.txt')), { code: 'ENOENT' })
    assert.equal(f.lastState()?.kind, 'aborted')
    assert.equal(f.windows.begun, f.windows.finished)
  }
)

test('deleting a session clears its persistent goal and notes', async (t) => {
  const f = await fixture(t, async function* (frame) {
    yield done(frame)
    yield { type: 'finish', reason: 'stop' }
  })
  const ref = { projectRoot: f.workspace, sessionId: 'session-1' }
  assert.equal(await f.runtime.getGoal(ref), null)
  await f.runtime.submit(f.sink, f.request('随便说一句')).completed
  assert.equal(f.lastState()?.kind, 'done')
  await f.runtime.deleteSession(ref)
  assert.equal(await f.runtime.getGoal(ref), null)
})

test('text-only models receive the image fallback', async (t) => {
  const f = await fixture(
    t,
    async function* (frame) {
      yield done(frame)
      yield { type: 'finish', reason: 'stop' }
    },
    { imageInput: false }
  )
  await f.runtime.submit(
    f.sink,
    f.request('看图', {
      images: [
        { data: Buffer.from('fake').toString('base64'), mediaType: 'image/png', label: 'shot.png' },
      ],
    })
  ).completed
  assert.match(JSON.stringify(f.frames.at(-1)), /当前模型不能看图/u)
})

test(
  'discovers npm metadata without loading implementation and imports the project version when used',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, async function* (frame, _signal, call) {
      if (call === 1)
        yield execute(
          frame,
          "// 查看可用包目录\nimport {readFile} from 'node:fs/promises';const catalog=JSON.parse(await readFile(process.env.VELAROS_HOST_DIR+'/index.json','utf8'));console.log('PACKAGE:'+JSON.stringify(catalog.packages.find(pkg=>pkg.name==='prettier')));"
        )
      else if (call === 3)
        yield execute(
          frame,
          "// 按需使用项目依赖\nimport {format} from 'prettier';console.log(await format('source'));"
        )
      else yield done(frame)
      yield { type: 'finish', reason: 'stop' }
    })
    const dependency = join(f.workspace, 'node_modules', 'prettier')
    const marker = join(f.workspace, 'loaded.txt')
    await mkdir(dependency, { recursive: true })
    await writeFile(
      join(dependency, 'package.json'),
      JSON.stringify({ name: 'prettier', version: '1.0.0', type: 'module', exports: './index.js' })
    )
    await writeFile(
      join(dependency, 'index.js'),
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'loaded');export const format=(text)=>'WORKSPACE:'+text;`
    )
    await f.runtime.submit(f.sink, f.request('发现代码工具')).completed
    assert.equal(f.lastState()?.kind, 'done', JSON.stringify(f.events.slice(-3)))
    assert.match(JSON.stringify(f.frames[1]), /PACKAGE:.*workspace/u)
    await assert.rejects(stat(marker), { code: 'ENOENT' })
    await f.runtime.submit(f.sink, f.request('使用格式化')).completed
    assert.equal(f.lastState()?.kind, 'done', JSON.stringify(f.events.slice(-3)))
    assert.match(JSON.stringify(f.frames[3]), /WORKSPACE:source/u)
    assert.equal(await readFile(marker, 'utf8'), 'loaded')
  }
)

test(
  'native project sessions delegate to a visible peer and receive its completed result',
  { timeout: 30_000 },
  async (t) => {
    let peers
    const members = [{ sessionId: 'session-1', title: '代码审查' }]
    const prepared = []
    const outcomes = []
    const f = await fixture(
      t,
      async function* (frame, _signal, call) {
        if (call === 1)
          yield execute(
            frame,
            `// 交接代码检查\nimport {ask} from 'velaros:sessions';console.log('PEER:'+JSON.stringify(await ask({workspace:'project',root:${JSON.stringify(f.workspace)},task:'检查项目代码并回复 child-proof'})));`
          )
        else yield done(frame, call === 2 ? 'child-proof' : 'parent-proof')
        yield { type: 'finish', reason: 'stop' }
      },
      { sessions: (request) => peers.forSession(request) }
    )
    peers = new WorkbenchSessionPeers({
      runtime: f.runtime,
      catalog: () => members,
      prepare: async (task) => {
        prepared.push(task)
        members.push({ sessionId: task.sessionId, title: '代码检查' })
        return f.sink
      },
      cancelPreparation: () => assert.fail('the prepared peer should be accepted'),
      failure: (_ref, message) => assert.fail(message),
    })
    t.after(() => peers.close())
    const off = f.runtime.subscribeRunOutcome((outcome) => outcomes.push(outcome))
    t.after(off)
    await f.runtime.submit(f.sink, f.request('交接任务')).completed
    assert.equal(prepared.length, 1)
    assert.equal(f.frames.length, 3, JSON.stringify(f.events.slice(-4)))
    assert.match(JSON.stringify(f.frames[2]), /child-proof/u)
    assert.match(JSON.stringify(f.frames[2]), /completed/u)
    assert.deepEqual(
      outcomes.map((outcome) => outcome.result.answer),
      ['child-proof', 'parent-proof']
    )
    assert.equal(f.runtime.isRunning({ projectRoot: f.workspace, sessionId: 'session-1' }), false)
  }
)

test(
  'background consoles retain launch-project ownership across cwd and same-id sessions',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, async function* () {
      yield { type: 'finish', reason: 'stop' }
    })
    const firstRoot = await realpath(f.workspace)
    const otherDirectory = join(f.directory, 'other-project')
    await mkdir(otherDirectory)
    const secondRoot = await realpath(otherDirectory)
    const first = f.shells.host(firstRoot, 'danger-full-access')
    const second = f.shells.host(secondRoot, 'danger-full-access')
    const changes = []
    const off = f.shells.addBackgroundTasksListener((event) => changes.push(event))
    t.after(off)
    const command = {
      file: process.execPath,
      args: [
        '-e',
        'console.log("console-ready");process.stdin.on("data",text=>console.log("echo:"+text.toString().trim()));',
      ],
    }
    const options = {
      sessionId: 'same-id',
      background: true,
      interactive: true,
      cwd: secondRoot,
      nativeCommand: command,
    }
    const a = (await first.runCommand('node interactive-test', options)).backgroundProcess
    const b = (await second.runCommand('node interactive-test', options)).backgroundProcess
    assert(a?.taskId && b?.taskId)
    const request = { taskId: a.taskId, sessionId: 'same-id' }
    assert.deepEqual(
      (await first.listBackgroundTasks({ sessionId: 'same-id' })).map((task) => task.id),
      [a.taskId]
    )
    assert.deepEqual(
      (await second.listBackgroundTasks({ sessionId: 'same-id' })).map((task) => task.id),
      [b.taskId]
    )
    await assert.rejects(f.shells.writeConsoleInput({ ...request, text: 'foreign' }, secondRoot), {
      code: 'NOT_FOUND',
    })
    await assert.rejects(
      f.shells.terminateBackgroundTask({ ...request, force: true }, secondRoot),
      { code: 'NOT_FOUND' }
    )
    await assert.rejects(
      f.shells.writeConsoleInput({ ...request, sessionId: 'other', text: 'foreign' }, firstRoot),
      { code: 'PERMISSION' }
    )
    assert.equal(
      (await f.shells.writeConsoleInput({ ...request, text: 'hello' }, firstRoot)).accepted,
      true
    )
    let output = ''
    for (let attempt = 0; attempt < 50 && !output.includes('echo:hello'); attempt++) {
      output = (await first.listBackgroundTasks({ taskId: a.taskId }))[0]?.recentOutput ?? ''
      if (!output.includes('echo:hello')) await new Promise((done) => setTimeout(done, 20))
    }
    assert.match(output, /echo:hello/u)
    assert.equal(
      (await f.shells.terminateBackgroundTask({ ...request, force: false }, firstRoot)).statusAfter,
      'exited'
    )
    assert.equal((await second.listBackgroundTasks({ onlyRunning: true })).length, 1)
    assert.equal(await f.shells.terminateSessionBackgroundTasks('same-id', secondRoot), 0)
    assert.equal((await second.listBackgroundTasks({ onlyRunning: true })).length, 0)
    assert(
      changes.some((event) => event.projectRoot === firstRoot && event.sessionId === 'same-id')
    )
    assert(
      changes.some((event) => event.projectRoot === secondRoot && event.sessionId === 'same-id')
    )
  }
)
