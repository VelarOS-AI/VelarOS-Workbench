// 用途：在 Node 里用真的 ScriptAct 循环（脚本化的模型 + 真的脚本子进程 + 临时项目）检查 Workbench 的会话运行时。
// Platform 的本地存储要 node:sqlite，bun 没有，所以把运行时打成包放进 Node 跑（与 Desktop 的运行时测试同一做法）。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'

import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

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
const { createWorkbenchConversationRuntime, WorkbenchShellHostRegistry } = await import(
  pathToFileURL(bundle).href
)

/** ScriptAct 协议的帧标记在编译好的提示词里。 */
function marker(frame) {
  const tag = /当前帧标记：(@@s[\da-f]+)。/u.exec(frame.compiledPrompt)
  assert(tag, 'The real Runtime must own the ScriptAct protocol')
  return tag[1]
}
const done = (frame, text = '完成') => `${text}\n${marker(frame)} done`
const execute = (frame, code) => `${marker(frame)} execute\n${code}\n${marker(frame)}\n`

function modelFrom(frames, generate, id = 'integration-model') {
  return {
    id,
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
  const runtime = createWorkbenchConversationRuntime({
    runner: nodeSubprocessCodeRunner,
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
    model: { provider: 'openrouter', model: 'test-model', apiKey: 'test', baseURL: 'http://localhost' },
    reasoningLevel: 'medium',
    executionModes: [],
    permissionMode: 'standard-open',
    ...overrides,
  })
  const lastState = () => events.filter((event) => event.type === 'state').at(-1)?.payload ?? null
  return { runtime, workspace, directory, events, frames, windows, edits, sink, request, lastState }
}

test(
  'edits a project file, runs a command, reports agent write windows and finishes',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(
      t,
      async function* (frame, _signal, call) {
        if (call === 1)
          yield {
            type: 'text',
            text: execute(
              frame,
              "// 改一下文件再跑命令\nimport {edit} from 'velaros:project';import {run} from 'velaros:shell';await edit({steps:[{action:'replace',path:'hello.txt',oldText:'before',newText:'after'}]});await run({command:'printf verified > shell-proof.txt'});"
            ),
          }
        else yield { type: 'text', text: done(frame, '改好了') }
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
    // 宿主说明（系统消息，不在工作内存帧里）：IDE 里的身份、脚本标题规则，以及项目规则原文
    const request = JSON.stringify(f.frames[0])
    assert.match(request, /你是 VelarOS Workbench（一个 IDE）里的编程助手/u)
    assert.match(request, /第一行写一句 \/\/ 注释/u)
    assert.match(request, /<project-rules path=\\"AGENTS\.md\\">\\n项目规则：回答要简短。/u)
    // 项目编辑与命令各是一段 Agent 动手的时间窗：都开了也都关了，并各通知一次界面
    assert(f.windows.begun >= 2, `expected write windows, got ${f.windows.begun}`)
    assert.equal(f.windows.finished, f.windows.begun)
    assert.equal(
      f.events.filter((event) => event.kind === 'conversation-project-activity').length,
      f.windows.finished
    )
    // 编辑写到的文件在那段时间窗关闭（界面收到通知）之前交给语言服务；命令的产物不在其中
    assert.deepEqual(f.edits, [{ sessionId: 'session-1', paths: ['hello.txt'], notices: 0 }])
    // 脚本卡收尾是成功的，源码从第一行注释开始（界面拿它当标题）
    assert(
      f.events.some(
        (event) =>
          event.kind === 'conversation-script'
          && event.payload.status === 'succeeded'
          && event.payload.source.startsWith('// 改一下文件')
      )
    )
    assert(
      f.events.some(
        (event) =>
          event.kind === 'conversation-text'
          && event.payload.phase === 'accepted'
          && event.payload.text.includes('改好了')
      )
    )
  }
)

test(
  'asks before a command that would discard uncommitted work, and a refusal runs nothing',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, async function* (frame, _signal, call) {
      if (call === 1)
        yield {
          type: 'text',
          text: execute(
            frame,
            "// 重置工作区\nimport {run} from 'velaros:shell';await run({command:'touch ran.txt && git reset --hard'});"
          ),
        }
      else yield { type: 'text', text: done(frame, '没有重置') }
      yield { type: 'finish', reason: 'stop' }
    })
    const run = f.runtime.submit(f.sink, f.request('重置一下'))
    await run.accepted
    // 平台把 git reset --hard 当日常命令；Workbench 在标准档照旧先问，卡片带着命令与理由。
    let card
    for (let attempt = 0; attempt < 200 && !card; attempt += 1) {
      card = f.events.find(
        (event) =>
          event.kind === 'conversation-interaction' && event.payload.status === 'pending'
      )?.payload
      if (!card) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert(card, 'expected a confirmation card for git reset --hard')
    assert.equal(card.kind, 'danger')
    // 卡片只摊开第一行：短标题加命令；完整理由在第二行
    const [title, reason] = card.message.split('\n')
    assert.equal(title, '在当前项目重置 Git 工作区：touch ran.txt && git reset --hard')
    assert.match(reason, /未提交的改动/u)
    assert.equal(card.operation?.label, 'touch ran.txt && git reset --hard')
    await f.runtime.answer(
      { projectRoot: f.workspace, sessionId: 'session-1' },
      card.id,
      { approved: false }
    )
    await run.completed
    await assert.rejects(stat(join(f.workspace, 'ran.txt')))
    assert.equal(f.lastState()?.kind, 'done')
  }
)

test('rejects a second submission while running, and cancel ends the run as aborted', async (t) => {
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
  const receipt = await f.runtime.cancel({ projectRoot: f.workspace, sessionId: 'session-1' })
  assert.equal(receipt.aborted, true)
  await run.completed
  assert.equal(f.lastState()?.kind, 'aborted')
})

test('reads no goal before a run, and deleting a session removes its data', async (t) => {
  const f = await fixture(t, async function* (frame) {
    yield { type: 'text', text: done(frame) }
    yield { type: 'finish', reason: 'stop' }
  })
  const ref = { projectRoot: f.workspace, sessionId: 'session-1' }
  assert.equal(await f.runtime.getGoal(ref), null)
  const run = f.runtime.submit(f.sink, f.request('随便说一句'))
  await run.completed
  assert.equal(f.lastState()?.kind, 'done')
  await f.runtime.deleteSession(ref)
  // 数据目录没了：读目标又回到「还没跑过」
  assert.equal(await f.runtime.getGoal(ref), null)
  await assert.rejects(stat(join(f.directory, 'state', 'missing')))
})

test('text-only models get a note instead of the images', async (t) => {
  const f = await fixture(
    t,
    async function* (frame) {
      yield { type: 'text', text: done(frame) }
      yield { type: 'finish', reason: 'stop' }
    },
    { imageInput: false }
  )
  const run = f.runtime.submit(
    f.sink,
    f.request('看图', {
      images: [{ data: Buffer.from('fake').toString('base64'), mediaType: 'image/png', label: 'shot.png' }],
    })
  )
  await run.completed
  assert.match(JSON.stringify(f.frames.at(-1)), /当前模型不能看图/u)
})
