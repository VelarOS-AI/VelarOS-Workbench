import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import { afterEach, beforeEach, describe, test } from 'bun:test'

import { createWorkbenchConversationDispatcher } from '../src/main/conversation/WorkbenchConversationDispatcher'
import { WorkbenchConversationRecovery } from '../src/main/conversation/WorkbenchConversationRecovery'
import type {
  WorkbenchConversationRuntimeApi,
  WorkbenchConversationSink,
} from '../src/main/conversation/WorkbenchConversationRuntime'
import { WorkbenchSessionPeers } from '../src/main/conversation/WorkbenchSessionPeers'
import { ClaudeCodeEngine } from '../src/main/engines/ClaudeCodeEngine'
import { CodexEngine } from '../src/main/engines/CodexEngine'
import { WorkbenchEngineConversationRuntime } from '../src/main/engines/WorkbenchEngineConversationRuntime'
import { withTimeout } from '../src/main/engines/WorkbenchEngineProcess'
import { WorkbenchEngineSessionStore } from '../src/main/engines/WorkbenchEngineSessionStore'
import {
  ConversationInteractionNotice,
  type ConversationInteractionProjection,
  ConversationProjectActivityNotice,
  ConversationTextNotice,
  type ConversationTextProjection,
  ConversationThinkingNotice,
  ConversationToolCallNotice,
  type ConversationToolCallProjection,
  type WorkbenchConversationSendRequest,
  type WorkbenchConversationState,
  type WorkbenchPermissionConfirmationMode,
} from '../src/shared/workbenchConversation'

/**
 * 假的 Claude Code 命令行：按 stream-json 协议握手、逐字吐正文、起一次 Bash 工具并经控制通道问权限。
 * 输入里带 danger 时命令换成 `git reset --hard`，带 ask 时先问一道 AskUserQuestion，带 slow 时等打断。
 */
const FakeClaude = String.raw`#!/usr/bin/env node
const fs = require('fs')
const readline = require('readline')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_ENGINE_LOG, JSON.stringify({ claude: args }) + '\n')
if (args[0] === 'auth') {
  process.stdout.write(JSON.stringify({ loggedIn: process.env.FAKE_CLAUDE_LOGGED_IN !== '0' }))
  process.exit(0)
}
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null
if (resume === 'gone') {
  process.stderr.write('No conversation found with session ID: gone\n')
  process.exit(1)
}
const sessionId = resume || 'session-1'
const out = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const waiting = new Map()
let interrupted = null
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.type === 'control_request' && message.request.subtype === 'initialize') {
    fs.appendFileSync(process.env.FAKE_ENGINE_LOG, JSON.stringify({ initialize: message.request }) + '\n')
    out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {
      account: { tokenSource: 'claude.ai', apiProvider: 'firstParty' },
      models: [
        { value: 'default', resolvedModel: 'claude-opus', displayName: 'Default (recommended)', description: 'Use the default model', supportsEffort: true },
        { value: 'opus', resolvedModel: 'claude-opus', displayName: 'Opus', supportsEffort: true },
        { value: 'haiku', resolvedModel: 'claude-haiku', displayName: 'Haiku' },
      ],
    } } })
    return
  }
  if (message.type === 'control_request' && message.request.subtype === 'interrupt') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } })
    if (interrupted) interrupted()
    return
  }
  if (message.type === 'control_response') {
    const resolve = waiting.get(message.response.request_id)
    if (resolve) resolve(message.response.response)
    return
  }
  if (message.type === 'user') void turn(message.message.content.map((block) => block.text || '').join(' '))
})
rl.on('close', () => process.exit(0))
function ask(requestId, request) {
  return new Promise((resolve) => {
    waiting.set(requestId, resolve)
    out({ type: 'control_request', request_id: requestId, request })
  })
}
function streamText(id, text) {
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id } } })
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
  const half = Math.ceil(text.length / 2)
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, half) } } })
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(half) } } })
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } })
  out({ type: 'assistant', parent_tool_use_id: null, message: { id, model: 'claude-opus', content: [{ type: 'text', text }] } })
}
async function turn(text) {
  out({ type: 'system', subtype: 'init', session_id: sessionId })
  if (text.includes('slow')) {
    streamText('msg-slow', 'Working on it')
    await new Promise((resolve) => { interrupted = resolve })
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId })
    return
  }
  if (text.includes('ask')) {
    const input = { questions: [{ question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue', description: 'calm' }] }] }
    const reply = await ask('ask-1', { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input, tool_use_id: 'toolu_ask' })
    fs.appendFileSync(process.env.FAKE_ENGINE_LOG, JSON.stringify({ askReply: reply }) + '\n')
  }
  streamText('msg-1', 'Hello from Claude')
  const command = text.includes('danger') ? 'git reset --hard' : 'echo hi'
  const input = { command, description: 'Say hi' }
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg-2' } } })
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} } } })
  const json = JSON.stringify(input)
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(0, 10) } } })
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(10) } } })
  out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } })
  out({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg-2', model: 'claude-opus', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input }] } })
  const permission = await ask('perm-1', { subtype: 'can_use_tool', tool_name: 'Bash', input, tool_use_id: 'toolu_1' })
  fs.appendFileSync(process.env.FAKE_ENGINE_LOG, JSON.stringify({ permission }) + '\n')
  const allowed = permission.behavior === 'allow'
  out({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: allowed ? 'hi' : permission.message, is_error: !allowed }] } })
  streamText('msg-3', 'Done.')
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: sessionId })
}
`

/** 假的 Codex app-server：JSON-RPC 握手、开 thread、跑一个回合（命令审批、改文件、计划、正文）。 */
const FakeCodex = String.raw`#!/usr/bin/env node
const fs = require('fs')
const readline = require('readline')
const log = (entry) => fs.appendFileSync(process.env.FAKE_ENGINE_LOG, JSON.stringify(entry) + '\n')
const out = (message) => process.stdout.write(JSON.stringify(message) + '\n')
if (process.argv[2] !== 'app-server') process.exit(2)
const waiting = new Map()
let nextId = 1000
const rl = readline.createInterface({ input: process.stdin })
rl.on('close', () => process.exit(0))
function request(method, params) {
  const id = nextId++
  out({ id, method, params })
  return new Promise((resolve) => waiting.set(id, resolve))
}
rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id !== undefined && message.method === undefined) {
    const resolve = waiting.get(message.id)
    if (resolve) resolve(message.result)
    return
  }
  log({ codex: message.method, params: message.params })
  switch (message.method) {
    case 'initialize': return out({ id: message.id, result: { userAgent: 'fake-codex' } })
    case 'account/read': return out({ id: message.id, result: { account: { type: 'chatgpt', email: null, planType: 'pro' }, requiresOpenaiAuth: true } })
    case 'model/list': return out({ id: message.id, result: { data: [
      { id: 'gpt-x', model: 'gpt-x', displayName: 'GPT X', description: 'fast', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
    ], nextCursor: null } })
    case 'thread/start': return out({ id: message.id, result: { thread: { id: 'thread-1' } } })
    case 'thread/resume': return out({ id: message.id, result: { thread: { id: message.params.threadId } } })
    case 'thread/goal/set':
    case 'thread/goal/clear':
      return out(process.env.FAKE_CODEX_GOAL_ERROR
        ? { id: message.id, error: { code: -32000, message: 'Goal storage unavailable' } }
        : { id: message.id, result: {} })
    case 'turn/start':
      out({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } })
      return void turn(message.params)
  }
})
async function turn(params) {
  const threadId = params.threadId
  const turnId = 'turn-1'
  const cwd = params.cwd
  out({ method: 'turn/started', params: { threadId, turn: { id: turnId } } })
  out({ method: 'item/reasoning/summaryTextDelta', params: { threadId, turnId, itemId: 'r1', delta: 'Thinking it over', summaryIndex: 0 } })
  out({ method: 'turn/plan/updated', params: { threadId, turnId, explanation: null, plan: [{ step: 'Run tests', status: 'inProgress' }] } })
  const command = { type: 'commandExecution', id: 'cmd-1', command: 'npm test', cwd, status: 'inProgress' }
  out({ method: 'item/started', params: { threadId, turnId, item: command } })
  const approval = await request('item/commandExecution/requestApproval', { threadId, turnId, itemId: 'cmd-1', command: 'npm test', cwd, reason: 'needs network' })
  log({ approval })
  const accepted = approval.decision === 'accept'
  if (accepted) out({ method: 'item/commandExecution/outputDelta', params: { threadId, turnId, itemId: 'cmd-1', delta: 'ok\n' } })
  out({ method: 'item/completed', params: { threadId, turnId, item: { ...command, status: accepted ? 'completed' : 'declined', exitCode: accepted ? 0 : null, aggregatedOutput: accepted ? 'ok\n' : null, durationMs: 5 } } })
  const change = { type: 'fileChange', id: 'fc-1', changes: [{ path: cwd + '/src/a.ts', kind: { type: 'update', move_path: null }, diff: '+x' }], status: 'inProgress' }
  out({ method: 'item/started', params: { threadId, turnId, item: change } })
  out({ method: 'item/completed', params: { threadId, turnId, item: { ...change, status: 'completed' } } })
  out({ method: 'turn/plan/updated', params: { threadId, turnId, explanation: null, plan: [{ step: 'Run tests', status: 'completed' }] } })
  out({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'msg-1', delta: 'All ' } })
  out({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: 'msg-1', delta: 'done.' } })
  out({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: 'msg-1', text: 'All done.' } } })
  out({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', error: null } } })
}
`

interface Rig {
  root: string
  project: string
  log: string
  runtime: WorkbenchEngineConversationRuntime
  sessions: WorkbenchEngineSessionStore
  activity: string[]
  edited: string[][]
  env: Record<string, string>
}

let rig: Rig

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'workbench engines-'))
  const bin = join(root, 'bin')
  const project = join(root, 'project')
  await Promise.all([
    writeFile(join(root, 'log.jsonl'), ''),
    (async () => {
      const { mkdir } = await import('node:fs/promises')
      await mkdir(bin, { recursive: true })
      await mkdir(project, { recursive: true })
      for (const [name, source] of [
        ['claude', FakeClaude],
        ['codex', FakeCodex],
      ]) {
        if (process.platform === 'win32') {
          await writeFile(join(bin, `${name}.cjs`), source)
          await writeFile(join(bin, `${name}.cmd`), `@echo off\r\nnode "%~dp0${name}.cjs" %*\r\n`)
        } else {
          await writeFile(join(bin, name), source)
          await chmod(join(bin, name), 0o755)
        }
      }
    })(),
  ])
  const env: Record<string, string> = {
    PATH: [bin, process.env.PATH ?? ''].join(delimiter),
    HOME: process.env.HOME ?? root,
    FAKE_ENGINE_LOG: join(root, 'log.jsonl'),
  }
  const environment = { getEnvironment: async () => ({ ...process.env, ...env }) }
  const sessions = new WorkbenchEngineSessionStore(root)
  const activity: string[] = []
  const edited: string[][] = []
  rig = {
    root,
    project,
    log: join(root, 'log.jsonl'),
    sessions,
    activity,
    edited,
    env,
    runtime: new WorkbenchEngineConversationRuntime({
      engines: [new ClaudeCodeEngine(environment), new CodexEngine(environment, '0.0.0-test')],
      sessions,
      activity: () => ({
        beginFileWrite: () => () => undefined,
        beginCommand: () => {
          activity.push('begin')
          return () => activity.push('end')
        },
      }),
      projectFilesEdited: (_ref, paths) => edited.push([...paths]),
    }),
  }
})

afterEach(async () => {
  await rig.runtime.close()
  await rm(rig.root, { recursive: true, force: true })
})

interface Recorded {
  sink: WorkbenchConversationSink
  notices: Array<{ kind: string; payload: unknown }>
  states: WorkbenchConversationState[]
}

/** 记下这一轮的通知与状态；有卡在等回答时按 answer 回答。 */
function record(
  answer?: (
    card: ConversationInteractionProjection
  ) => Parameters<WorkbenchEngineConversationRuntime['answer']>[2]
): Recorded {
  const recorded: Recorded = {
    notices: [],
    states: [],
    sink: {
      notice: (kind, payload) => {
        recorded.notices.push({ kind, payload })
        const card = payload as ConversationInteractionProjection
        if (kind === ConversationInteractionNotice && card.status === 'pending' && answer)
          queueMicrotask(() => {
            void rig.runtime.answer(ref(), card.id, answer(card))
          })
      },
      state: (payload) => recorded.states.push(payload),
    },
  }
  return recorded
}

function ref(): { projectRoot: string; sessionId: string } {
  return { projectRoot: rig.project, sessionId: 'chat-1' }
}

function request(
  engine: 'claude-code' | 'codex',
  text: string,
  permissionMode: WorkbenchPermissionConfirmationMode,
  model?: string
): WorkbenchConversationSendRequest {
  return {
    ...ref(),
    inputId: 'input-1',
    text,
    locale: 'zh-CN',
    model: { provider: 'openrouter', model: 'unused', apiKey: '', baseURL: '' },
    reasoningLevel: 'xhigh',
    executionModes: [],
    permissionMode,
    memory: false,
    webSearchEngine: 'google',
    engine: { id: engine, model },
  }
}

async function run(recorded: Recorded, body: WorkbenchConversationSendRequest): Promise<void> {
  const { accepted, completed } = rig.runtime.submit(recorded.sink, body)
  await accepted
  await completed
}

function latest<T extends { id: string }>(recorded: Recorded, kind: string): Map<string, T> {
  const byId = new Map<string, T>()
  for (const notice of recorded.notices)
    if (notice.kind === kind) byId.set((notice.payload as T).id, notice.payload as T)
  return byId
}

async function readLog(): Promise<Array<Record<string, unknown>>> {
  return (await readFile(rig.log, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('Claude Code engine', () => {
  test('streams the answer, draws the tool call and asks before running a command', async () => {
    const recorded = record((card) => {
      assert.equal(card.kind, 'confirm')
      assert.match(card.message, /^运行命令：echo hi/u)
      return { approved: true }
    })
    await run(recorded, request('claude-code', 'say hi', 'ask-every-time', 'opus'))

    const texts = [...latest<ConversationTextProjection>(recorded, ConversationTextNotice).values()]
    assert.deepEqual(
      texts.map((text) => [text.phase, text.text]),
      [
        ['accepted', 'Hello from Claude'],
        ['accepted', 'Done.'],
      ]
    )
    const [tool] = latest<ConversationToolCallProjection>(
      recorded,
      ConversationToolCallNotice
    ).values()
    assert.ok(tool)
    assert.equal(tool.toolName, 'project:run')
    assert.equal(tool.title, 'Say hi')
    assert.deepEqual(tool.args, { command: 'echo hi', description: 'Say hi' })
    assert.equal(tool.isRunning, false)
    assert.equal(tool.result, 'hi')
    const [card] = latest<ConversationInteractionProjection>(
      recorded,
      ConversationInteractionNotice
    ).values()
    assert.equal(card?.status, 'answered')
    assert.ok(recorded.states.some((state) => state.kind === 'awaiting-confirmation'))
    assert.deepEqual(recorded.states.at(-1), { kind: 'done' })
    // 跑命令的那段时间算 Agent 动手，结束时界面收到项目动静
    assert.deepEqual(rig.activity, ['begin', 'end'])
    assert.ok(recorded.notices.some((notice) => notice.kind === ConversationProjectActivityNotice))

    const log = await readLog()
    const args = log.find(
      (entry) => Array.isArray(entry.claude) && (entry.claude as string[]).includes('-p')
    )?.claude as string[]
    assert.ok(args.includes('--model') && args[args.indexOf('--model') + 1] === 'opus')
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'default')
    const initialization = log.find((entry) => entry.initialize)?.initialize as {
      appendSystemPrompt?: string
    }
    assert.ok(initialization.appendSystemPrompt?.includes('\n'))
    assert.equal(args.includes('--append-system-prompt'), false)
    // 没探过模型目录时不知道它能不能调思考力度：不传
    assert.equal(args.includes('--effort'), false)
    assert.deepEqual(log.find((entry) => entry.permission)?.permission, {
      behavior: 'allow',
      updatedInput: { command: 'echo hi', description: 'Say hi' },
      toolUseID: 'toolu_1',
    })
    assert.equal(await rig.sessions.get('claude-code', ref()), 'session-1')
  })

  test('the next turn resumes the same Claude session', async () => {
    await run(record(), request('claude-code', 'first', 'never-ask'))
    await run(record(), request('claude-code', 'second', 'never-ask'))
    const runs = (await readLog())
      .map((entry) => entry.claude as string[] | undefined)
      .filter((args): args is string[] => !!args?.includes('-p'))
    assert.equal(runs.length, 2)
    assert.equal(runs[0]!.includes('--resume'), false)
    assert.equal(runs[1]![runs[1]!.indexOf('--resume') + 1], 'session-1')
  })

  test('standard mode lets ordinary commands run and asks before dangerous ones', async () => {
    const plain = record(() => assert.fail('standard mode should not ask for echo hi'))
    await run(plain, request('claude-code', 'say hi', 'standard-open'))
    assert.equal(latest(plain, ConversationInteractionNotice).size, 0)

    const dangerous = record((card) => {
      assert.equal(card.kind, 'danger')
      assert.match(card.message, /^运行危险命令：git reset --hard/u)
      assert.equal(card.operation?.label, 'git reset --hard')
      return { declined: true, reason: 'keep my changes' }
    })
    await run(dangerous, request('claude-code', 'danger', 'standard-open'))
    const [tool] = latest<ConversationToolCallProjection>(
      dangerous,
      ConversationToolCallNotice
    ).values()
    assert.equal(tool?.error, 'keep my changes')
    assert.deepEqual(dangerous.states.at(-1), { kind: 'done' })
  })

  test('AskUserQuestion becomes a choice card and the answer goes back by question text', async () => {
    const recorded = record((card) =>
      card.kind === 'choice' ? { choices: [card.options![1]!.id] } : { approved: true }
    )
    await run(recorded, request('claude-code', 'ask me', 'never-ask'))
    const cards = [
      ...latest<ConversationInteractionProjection>(
        recorded,
        ConversationInteractionNotice
      ).values(),
    ]
    assert.equal(cards.length, 1)
    assert.equal(cards[0]!.message, 'Colour\nWhich colour?')
    assert.deepEqual(
      cards[0]!.options?.map((option) => option.label),
      ['Red', 'Blue']
    )
    const reply = (await readLog()).find((entry) => entry.askReply)?.askReply as Record<
      string,
      unknown
    >
    assert.equal(reply.behavior, 'allow')
    assert.deepEqual((reply.updatedInput as Record<string, unknown>).answers, {
      'Which colour?': 'Blue',
    })
  })

  test('stopping interrupts the turn and ends it as stopped', async () => {
    const recorded = record()
    const { accepted, completed } = rig.runtime.submit(
      recorded.sink,
      request('claude-code', 'slow', 'never-ask')
    )
    await accepted
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (recorded.notices.some((notice) => notice.kind === ConversationTextNotice)) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.deepEqual(await rig.runtime.cancel(ref()), { aborted: true })
    await completed
    assert.deepEqual(recorded.states.at(-1), { kind: 'aborted', message: '运行已停止。' })
    // 停下时逐字到了一半的正文照样留下
    const texts = [...latest<ConversationTextProjection>(recorded, ConversationTextNotice).values()]
    assert.equal(texts.at(-1)?.phase, 'accepted')
  })

  test('a session Claude no longer knows starts over instead of failing', async () => {
    await rig.sessions.set('claude-code', ref(), 'gone')
    const recorded = record()
    await run(recorded, request('claude-code', 'hello', 'never-ask'))
    assert.deepEqual(recorded.states.at(-1), { kind: 'done' })
    assert.equal(await rig.sessions.get('claude-code', ref()), 'session-1')
  })

  test('status merges model aliases and reports a missing login', async () => {
    const [claude] = await rig.runtime.status(true)
    assert.equal(claude?.available, true)
    assert.deepEqual(
      claude?.models.map((model) => [model.value, model.label, model.isDefault ?? false]),
      [
        ['opus', 'Opus', true],
        ['haiku', 'Haiku', false],
      ]
    )
    // 探过目录之后知道 opus 能调思考力度
    await run(record(), request('claude-code', 'hello', 'never-ask', 'opus'))
    const args = (await readLog())
      .map((entry) => entry.claude as string[] | undefined)
      .filter((entry): entry is string[] => !!entry?.includes('-p') && entry.includes('--model'))
      .at(-1)!
    assert.equal(args[args.indexOf('--effort') + 1], 'xhigh')

    rig.env.FAKE_CLAUDE_LOGGED_IN = '0'
    const [signedOut] = await rig.runtime.status(true)
    assert.equal(signedOut?.available, false)
    assert.match(signedOut?.reason ?? '', /还没有登录/u)
  })
})

describe('Codex engine', () => {
  test('a goal setup failure rejects the input before starting a turn', async () => {
    rig.env.FAKE_CODEX_GOAL_ERROR = '1'
    const recorded = record()
    const submitted = rig.runtime.submit(recorded.sink, {
      ...request('codex', 'finish the task', 'never-ask'),
      executionModes: ['goal'],
    })
    await assert.rejects(submitted.accepted, /Goal storage unavailable/u)
    await assert.rejects(submitted.completed, /Goal storage unavailable/u)
    assert.equal(
      (await readLog()).some((entry) => entry.codex === 'turn/start'),
      false
    )
    assert.deepEqual(recorded.states.at(-1), { kind: 'error', message: 'Goal storage unavailable' })
  })

  test('runs a turn: plan, command, file change and the answer', async () => {
    const recorded = record(() => assert.fail('standard mode should not ask for npm test'))
    await run(recorded, request('codex', 'fix it', 'standard-open', 'gpt-x'))

    const texts = [...latest<ConversationTextProjection>(recorded, ConversationTextNotice).values()]
    assert.deepEqual(
      texts.map((text) => [text.phase, text.text]),
      [['accepted', 'All done.']]
    )
    assert.ok(recorded.notices.some((notice) => notice.kind === ConversationThinkingNotice))
    const tools = latest<ConversationToolCallProjection>(recorded, ConversationToolCallNotice)
    const toolList = [...tools.values()]
    const plan = toolList.find((tool) => tool.toolName === 'plan:update')
    assert.deepEqual(plan?.result, {
      explanation: undefined,
      plan: [{ step: 'Run tests', status: 'completed' }],
    })
    const command = toolList.find((tool) => tool.toolName === 'project:run')
    assert.equal(command?.title, 'npm test')
    assert.deepEqual(command?.result, { exitCode: 0, output: 'ok\n', durationMs: 5 })
    const edit = toolList.find((tool) => tool.toolName === 'project:edit')
    assert.equal(edit?.title, '编辑 src/a.ts')
    assert.deepEqual(rig.edited, [['src/a.ts']])
    assert.deepEqual(rig.activity, ['begin', 'end', 'begin', 'end'])
    assert.deepEqual(recorded.states.at(-1), { kind: 'done' })

    const log = await readLog()
    assert.deepEqual(log.find((entry) => entry.approval)?.approval, { decision: 'accept' })
    const turn = log.find((entry) => entry.codex === 'turn/start')?.params as Record<
      string,
      unknown
    >
    assert.equal(turn.approvalPolicy, 'on-request')
    assert.equal((turn.sandboxPolicy as Record<string, unknown>).type, 'workspaceWrite')
    assert.equal(turn.model, 'gpt-x')
    assert.equal(await rig.sessions.get('codex', ref()), 'thread-1')
  })

  test('ask-every-time turns command approvals into cards', async () => {
    const recorded = record((card) => {
      assert.match(card.message, /^运行命令：npm test/u)
      return { declined: true }
    })
    await run(recorded, request('codex', 'fix it', 'ask-every-time'))
    assert.deepEqual((await readLog()).find((entry) => entry.approval)?.approval, {
      decision: 'decline',
    })
    const command = [
      ...latest<ConversationToolCallProjection>(recorded, ConversationToolCallNotice).values(),
    ].find((tool) => tool.toolName === 'project:run')
    assert.equal(command?.error, '用户拒绝了这条命令。')
    const turn = (await readLog()).find((entry) => entry.codex === 'turn/start')?.params as Record<
      string,
      unknown
    >
    assert.equal(turn.approvalPolicy, 'untrusted')
  })

  test('status lists models; the reasoning level is clamped to what the model supports', async () => {
    const [, codex] = await rig.runtime.status(true)
    assert.equal(codex?.available, true)
    assert.deepEqual(codex?.models, [
      { value: 'gpt-x', label: 'GPT X', description: 'fast', isDefault: true },
    ])
    await run(record(), request('codex', 'hello', 'never-ask', 'gpt-x'))
    const turn = (await readLog()).filter((entry) => entry.codex === 'turn/start').at(-1)
      ?.params as Record<string, unknown>
    assert.equal(turn.effort, 'high')
    assert.equal(turn.approvalPolicy, 'never')
    assert.deepEqual(turn.sandboxPolicy, { type: 'dangerFullAccess' })
    // 下一轮接着同一条 thread
    await run(record(), request('codex', 'again', 'never-ask', 'gpt-x'))
    const log = await readLog()
    assert.equal(log.filter((entry) => entry.codex === 'thread/start').length, 1)
    const resume = log.find((entry) => entry.codex === 'thread/resume')?.params as Record<
      string,
      unknown
    >
    assert.equal(resume.threadId, 'thread-1')
  })
})

describe('engine session ownership', () => {
  test('a failed identity write cannot publish a new mapping and retry persists that same identity', async () => {
    const directory = join(rig.root, 'agent-engines')
    await mkdir(directory)
    await mkdir(join(directory, 'sessions.json'))
    await assert.rejects(rig.sessions.set('codex', ref(), 'retry-thread'))
    assert.equal(await rig.sessions.get('codex', ref()), null)

    await rm(join(directory, 'sessions.json'), { recursive: true })
    await rig.sessions.set('codex', ref(), 'retry-thread')
    assert.equal(
      await new WorkbenchEngineSessionStore(rig.root).get('codex', ref()),
      'retry-thread'
    )
  })

  test('an engine ending without acceptance rejects both receipts', async () => {
    const runtime = new WorkbenchEngineConversationRuntime({
      sessions: rig.sessions,
      engines: [
        {
          id: 'codex',
          label: 'test engine',
          status: async () => ({ id: 'codex', available: true, models: [] }),
          run: async () => ({ status: 'completed' }),
          close: async () => {},
        },
      ],
    })
    const recorded = record()
    const submitted = runtime.submit(recorded.sink, request('codex', 'hello', 'never-ask'))
    await assert.rejects(submitted.accepted, /未确认接纳/u)
    await assert.rejects(submitted.completed, /未确认接纳/u)
    assert.equal(recorded.states.at(-1)?.kind, 'error')
    await runtime.close()
  })

  test('deleting a chat removes both engine mappings from disk and keeps other chats', async () => {
    const other = { ...ref(), sessionId: 'chat-2' }
    await rig.sessions.set('claude-code', ref(), 'claude-1')
    await rig.sessions.set('codex', ref(), 'codex-1')
    await rig.sessions.set('codex', other, 'codex-2')

    await rig.runtime.deleteSession(ref())

    const reopened = new WorkbenchEngineSessionStore(rig.root)
    assert.equal(await reopened.get('claude-code', ref()), null)
    assert.equal(await reopened.get('codex', ref()), null)
    assert.equal(await reopened.get('codex', other), 'codex-2')
  })

  for (const engine of ['claude-code', 'codex'] as const) {
    test(`${engine} persists its identity before the completed receipt`, async () => {
      await run(record(), request(engine, 'hello', 'never-ask'))

      const reopened = new WorkbenchEngineSessionStore(rig.root)
      assert.equal(
        await reopened.get(engine, ref()),
        engine === 'claude-code' ? 'session-1' : 'thread-1'
      )
    })
  }
})

test('an already cancelled engine wait rejects even when its work has completed', async () => {
  const reason = new Error('cancelled before waiting')
  await assert.rejects(
    withTimeout(Promise.resolve('done'), 1_000, 'timed out', AbortSignal.abort(reason)),
    (error) => error === reason
  )
})

describe('conversation dispatcher', () => {
  test('deleting during peer preparation joins duplicate deletes and drains the cancelled journal', async () => {
    const recovery = new WorkbenchConversationRecovery(join(rig.root, 'dispatcher-events'))
    const target = ref()
    await rig.sessions.set('codex', target, 'old-thread')
    const preparing = gate()
    const releasePreparation = gate()
    const finishing = gate()
    const releaseFinish = gate()
    const completeRun = gate()
    let starts = 0
    let cancelledRuns = 0
    let platformDeletes = 0
    let settled = 0
    let preparationsCancelled = 0
    const platform = {
      isRunning: () => false,
      subscribeRunOutcome: () => () => {},
      submit: () => {
        starts += 1
        return { accepted: Promise.resolve(), completed: completeRun.promise }
      },
      cancel: async () => {
        cancelledRuns += 1
        completeRun.release()
        return { aborted: true }
      },
      deleteSession: async () => {
        platformDeletes += 1
      },
      close: async () => {},
    } as unknown as WorkbenchConversationRuntimeApi
    const dispatcher = createWorkbenchConversationDispatcher(platform, rig.runtime, recovery)
    dispatcher.subscribeRunSettled(() => {
      settled += 1
      assert.equal(dispatcher.isRunning(target), false)
    })
    const sink = record().sink
    const source = { ...target, sessionId: 'source-chat' }
    const peers = new WorkbenchSessionPeers({
      runtime: dispatcher,
      catalog: () => [
        { sessionId: source.sessionId, title: 'source' },
        { sessionId: target.sessionId, title: 'target' },
      ],
      prepare: async (task, signal) => {
        const run = await recovery.begin(target, task.inputId, false)
        preparing.release()
        await releasePreparation.promise
        return {
          sink,
          finish: async ({ started }) => {
            assert.equal(started, false)
            assert.equal(signal.aborted, true)
            const event = await recovery.append(run, {
              type: 'state',
              payload: { kind: 'aborted', message: 'cancelled before execution' },
            })
            assert.equal(event.streamId, run.id)
            assert.equal(event.sequence, 1)
            assert.equal(typeof event.emittedAt, 'number')
            finishing.release()
            await releaseFinish.promise
          },
        }
      },
      prepareGuidance: async () => {},
      acceptGuidance: () => {},
      cancelPreparation: () => {
        preparationsCancelled += 1
      },
    })
    const answer = peers
      .forSession({ ...request('codex', 'hi', 'never-ask'), ...source })
      .ask({ to: target.sessionId, task: 'hi' }, new AbortController().signal)
    void answer.catch(() => undefined)
    await preparing.promise
    assert.equal(dispatcher.isRunning(target), true)
    const deletion = dispatcher.deleteSession(target)
    assert.equal(dispatcher.deleteSession(target), deletion)
    const cancellation = dispatcher.cancel(target)
    let deleted = false
    let cancelled = false
    void deletion.then(() => {
      deleted = true
    })
    void cancellation.then(() => {
      cancelled = true
    })
    assert.throws(() => dispatcher.submit(sink, { ...request('codex', 'hi', 'never-ask'), ...target }))
    releasePreparation.release()
    await finishing.promise
    assert.equal(deleted, false)
    assert.equal(cancelled, false)
    assert.equal(settled, 0)
    assert.equal(dispatcher.isRunning(target), true)
    assert.equal(platformDeletes, 0)
    releaseFinish.release()
    await Promise.all([deletion, cancellation])
    await assert.rejects(answer)
    assert.equal(starts, 0)
    assert.equal(platformDeletes, 1)
    assert.equal(await rig.sessions.get('codex', target), null)
    assert.equal(await recovery.read(target, {}, false), null)
    assert.equal(settled, 1)
    assert.equal(preparationsCancelled, 1)
    const caller = new AbortController()
    const next = dispatcher.submit(
      sink,
      {
        ...request('codex', 'new input', 'never-ask'),
        ...target,
        engine: undefined,
      },
      caller.signal
    )
    await next.accepted
    caller.abort()
    assert.equal(cancelledRuns, 0)
    assert.equal(dispatcher.isRunning(target), true)
    completeRun.release()
    await next.completed
    assert.equal(starts, 1)
    peers.close()
    await dispatcher.close()
  })

  test('a failed backend delete waits for the other backend and journal before deletion and close reject', async () => {
    const recovery = new WorkbenchConversationRecovery(join(rig.root, 'dispatcher-events'))
    const target = ref()
    await recovery.begin(target, 'previous-input', false)
    const deletingEngine = gate()
    const releaseEngine = gate()
    const removingJournal = gate()
    const releaseJournal = gate()
    const failure = new Error('Platform deletion failed')
    let engineDeletes = 0
    let platformDeletes = 0
    let removes = 0
    let closes = 0
    const platform = {
      deleteSession: async () => {
        platformDeletes += 1
        throw failure
      },
      close: async () => {
        closes += 1
      },
    } as unknown as WorkbenchConversationRuntimeApi
    const engines = {
      deleteSession: async () => {
        engineDeletes += 1
        deletingEngine.release()
        await releaseEngine.promise
      },
      close: async () => {
        closes += 1
      },
    } as unknown as WorkbenchEngineConversationRuntime
    const dispatcher = createWorkbenchConversationDispatcher(platform, engines, {
      remove: async (ref) => {
        removes += 1
        removingJournal.release()
        await releaseJournal.promise
        await recovery.remove(ref)
      },
    })
    const deletion = dispatcher.deleteSession(target)
    await deletingEngine.promise
    const closing = dispatcher.close()
    assert.equal(dispatcher.close(), closing)
    assert.equal(dispatcher.deleteSession(target), deletion)
    let deleted = false
    let closed = false
    void deletion.catch(() => {
      deleted = true
    })
    void closing.catch(() => {
      closed = true
    })
    await assert.rejects(dispatcher.deleteSession({ ...target, sessionId: 'new-chat' }))
    assert.throws(() =>
      dispatcher.submit(record().sink, {
        ...request('codex', 'hi', 'never-ask'),
        ...target,
      })
    )
    assert.equal(platformDeletes, 1)
    assert.equal(removes, 0)
    assert.equal(deleted, false)
    assert.equal(closed, false)
    releaseEngine.release()
    await removingJournal.promise
    assert.equal(deleted, false)
    assert.equal(closed, false)
    releaseJournal.release()
    await assert.rejects(deletion, (error) => error === failure)
    await assert.rejects(closing, (error) => error === failure)
    assert.equal(engineDeletes, 1)
    assert.equal(platformDeletes, 1)
    assert.equal(removes, 1)
    assert.equal(closes, 2)
    assert.equal(await recovery.read(target, {}, false), null)
  })

  test('engine requests go to the engine runtime, the rest to Platform; answers follow the running side', async () => {
    const calls: string[] = []
    let engineRunning = false
    const platform = new Proxy(
      {},
      {
        get:
          (_target, name: string) =>
          (...args: unknown[]) => {
            calls.push(`platform.${name}`)
            if (name === 'submit')
              return { accepted: Promise.resolve(), completed: Promise.resolve() }
            return Promise.resolve(args.length ? null : undefined)
          },
      }
    ) as unknown as WorkbenchConversationRuntimeApi
    const engines = {
      has: () => engineRunning,
      submit: () => {
        calls.push('engines.submit')
        return { accepted: Promise.resolve(), completed: Promise.resolve() }
      },
      answer: async () => void calls.push('engines.answer'),
      input: async () => void calls.push('engines.input'),
      cancel: async () => {
        calls.push('engines.cancel')
        return { aborted: true }
      },
      deleteSession: async () => void calls.push('engines.deleteSession'),
      cancelProject: async () => void calls.push('engines.cancelProject'),
      close: async () => void calls.push('engines.close'),
      status: async () => [],
    } as unknown as WorkbenchEngineConversationRuntime
    const dispatcher = createWorkbenchConversationDispatcher(
      platform,
      engines,
      new WorkbenchConversationRecovery(join(rig.root, 'dispatcher-events'))
    )
    const sink = record().sink
    const target = { projectRoot: '/work/app', sessionId: 'chat-1' }

    await dispatcher.submit(sink, {
      ...request('claude-code', 'hi', 'never-ask'),
      ...target,
    }).completed
    await dispatcher.submit(sink, {
      ...request('codex', 'hi', 'never-ask'),
      ...target,
      engine: undefined,
    }).completed
    await dispatcher.answer(target, 'card-1', { approved: true })
    engineRunning = true
    await dispatcher.answer(target, 'card-1', { approved: true })
    await dispatcher.input(target, 'yes')
    await dispatcher.cancel(target)
    await assert.rejects(
      dispatcher.guidance(target, { inputId: 'g', text: 'more' }),
      /不支持运行中引导/u
    )
    await dispatcher.deleteSession(target)
    await dispatcher.close()

    assert.deepEqual(calls, [
      'engines.submit',
      'platform.submit',
      'platform.answer',
      'engines.answer',
      'engines.input',
      'engines.cancel',
      'engines.deleteSession',
      'platform.deleteSession',
      'engines.close',
      'platform.close',
    ])
  })
})

function gate(): { promise: Promise<void>; release(): void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
