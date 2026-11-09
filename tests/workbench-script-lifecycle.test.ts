import { expect, test } from 'bun:test'

import type { ActTurnTrace } from '@velaros-ai/velaros/contracts'

import { ConversationScriptBoard } from '../src/main/conversation/ConversationScripts'
import {
  applyWorkbenchConversationNotice,
  withSettledScripts,
} from '../src/renderer/src/runtime/conversation/workbenchConversationNotices'
import type { ConversationScriptProjection } from '../src/shared/workbenchConversation'

test('queued scripts survive IPC, complete across turns and retain output', () => {
  const events: ConversationScriptProjection[] = []
  const board = new ConversationScriptBoard((event) => events.push(event))
  const program = {
    type: 'program' as const,
    runId: 'run',
    kind: 'execute' as const,
    index: 0,
    text: '',
  }
  board.program('turn', { ...program, phase: 'start' })
  board.program('turn', {
    ...program,
    phase: 'delta',
    text: '// Check files\nconsole.log(42)',
  })
  board.program('turn', { ...program, phase: 'end' })
  expect(events.at(-1)?.status).toBe('queued')
  expect(events.at(-1)?.startedAt).toBeUndefined()
  expect(board.pendingTurns()).toEqual(['turn'])
  let state = applyWorkbenchConversationNotice(
    { messages: [], workerThreads: [] },
    'conversation-script',
    events.at(-1)
  )
  expect(state.messages[0].blocks[0]).toMatchObject({ status: 'queued' })
  expect(withSettledScripts(state.messages)[0].blocks[0]).toMatchObject({
    status: 'cancelled',
  })
  const trace = (status: 'running' | 'succeeded') =>
    ({
      runId: 'run',
      turnId: 'turn',
      request: { sequence: 1 },
      executions: [
        {
          executionId: 'exec',
          position: 0,
          status,
          source: '',
          failure: null,
          durationMs: status === 'running' ? null : 25,
          processOutput: '42',
        },
      ],
      invocations: [],
      observation: {},
    }) as unknown as ActTurnTrace
  board.trace(trace('running'))
  expect(events.at(-1)?.startedAt).toBeNumber()
  board.trace(trace('succeeded'))
  state = applyWorkbenchConversationNotice(state, 'conversation-script', events.at(-1))
  expect(state.messages[0].blocks[0]).toMatchObject({
    status: 'succeeded',
    calls: [{ output: '42' }],
  })
  expect(board.pendingTurns()).toEqual([])
})

test('blob cards settle only after acceptance, rejected cards are discarded', () => {
  const events: ConversationScriptProjection[] = []
  const board = new ConversationScriptBoard((event) => events.push(event))
  const event = {
    type: 'program' as const,
    runId: 'run',
    kind: 'blobs' as const,
    index: 0,
    text: 'contents',
  }
  board.program('turn', { ...event, phase: 'start' })
  board.program('turn', { ...event, phase: 'delta' })
  board.program('turn', { ...event, phase: 'end' })
  expect(events.at(-1)?.status).toBe('queued')
  board.accept('turn')
  expect(events.at(-1)).toMatchObject({
    kind: 'blobs',
    status: 'succeeded',
    source: 'contents',
  })
  const state = applyWorkbenchConversationNotice(
    { messages: [], workerThreads: [] },
    'conversation-script',
    events.at(-1)
  )
  expect(state.messages[0].blocks[0]).toMatchObject({
    kind: 'blobs',
    status: 'succeeded',
  })
  board.reject('turn')
  expect(events.at(-1)?.status).toBe('discarded')
})

test('late native program events reuse adopted cards without phantom cancellation or losing output', () => {
  for (const initialStatus of ['running', 'succeeded'] as const) {
    const events: ConversationScriptProjection[] = []
    const board = new ConversationScriptBoard((event) => events.push(event))
    const trace = (status: 'running' | 'succeeded') =>
      ({
        runId: 'run',
        turnId: 'turn',
        request: { sequence: 1 },
        executions: [
          {
            executionId: 'early',
            position: 0,
            status,
            source: 'console.log(42)',
            failure: null,
            durationMs: status === 'running' ? null : 25,
            processOutput: '42',
          },
        ],
        invocations: [],
        observation: {},
      }) as unknown as ActTurnTrace
    board.trace(trace(initialStatus))
    const id = board.cardOf('early')
    for (const [index, kind, text] of [
      [0, 'blobs', 'literal'],
      [1, 'execute', 'console.log(42)'],
    ] as const) {
      const program = {
        type: 'program' as const,
        runId: 'run',
        index,
        kind,
        text,
      }
      board.program('turn', { ...program, phase: 'start', text: '' })
      board.program('turn', { ...program, phase: 'delta' })
      board.program('turn', { ...program, phase: 'end', text: '' })
    }
    expect(events.filter((event) => event.kind === 'execute').at(-1)).toMatchObject({
      id,
      status: initialStatus,
      processOutput: '42',
    })
    board.accept('turn')
    if (initialStatus === 'running') board.trace(trace('succeeded'))
    board.settle()
    expect(
      new Set(events.filter((event) => event.kind === 'execute').map((event) => event.id)).size
    ).toBe(1)
    expect(events.some((event) => event.status === 'cancelled')).toBe(false)
    expect(board.cardOf('early')).toBe(id)
    expect(board.pendingTurns()).toEqual([])
  }
})

test('old pending turns cannot replace the latest observation registration', () => {
  const events: ConversationScriptProjection[] = []
  const board = new ConversationScriptBoard((event) => events.push(event))
  const trace = (
    turnId: string,
    sequence: number,
    registration: ActTurnTrace['observation']['registration'] = null,
    output?: string
  ) =>
    ({
      sessionId: 'session',
      runId: 'run',
      turnId,
      request: { sequence },
      executions: [],
      observation: {
        registration,
        run: output
          ? {
              executionId: `observation:${turnId}`,
              status: 'succeeded',
              failure: null,
              durationMs: 1,
              source: 'observe()',
              sourceTruncated: false,
            }
          : null,
      },
      invocations: output
        ? [
            {
              id: `call:${turnId}`,
              executionId: `observation:${turnId}`,
              chars: output.length,
              body: output,
              truncated: false,
              summary: {
                moduleId: 'project',
                operation: 'read',
                status: 'succeeded',
                effect: 'none',
                input: '',
                output,
                inputTruncated: false,
                outputTruncated: false,
              },
            },
          ]
        : [],
    }) as unknown as ActTurnTrace
  const first: ActTurnTrace = {
    ...trace('turn-z', 10, {
      status: 'updated',
      failure: null,
      source: 'observe A',
      sourceTruncated: false,
    }),
    executions: [
      {
        executionId: 'pending-execute',
        position: 0,
        status: 'queued',
        failure: null,
        durationMs: null,
        source: 'await pending()',
        sourceTruncated: false,
      },
    ],
  }
  board.trace(first)
  board.trace(
    trace(
      'turn-a',
      20,
      {
        status: 'updated',
        failure: null,
        source: 'observe B',
        sourceTruncated: false,
      },
      'A@B'
    )
  )
  const third = trace('turn-c', 30, null, 'B@C')
  board.trace(third)
  board.trace({
    ...first,
    executions: [{ ...first.executions[0]!, status: 'running' }],
  })
  board.trace(third)
  board.trace(trace('turn-d', 40, null, 'B@D'))
  const latestObservation = (turnId: string) =>
    events.findLast((event) => event.kind === 'observe' && event.turnId === turnId)
  expect(latestObservation('turn-z')?.calls[0]?.output).toBe('A@B')
  expect(latestObservation('turn-a')?.calls[0]?.output).toBe('B@D')
  expect(
    events.findLast((event) => event.id === board.cardOf('pending-execute'))?.status
  ).toBe('running')
  expect(board.pendingTurns()).toContain('turn-z')
})

test('observe invocations are bounded before publishing and preserve trace data', () => {
  const events: ConversationScriptProjection[] = []
  const board = new ConversationScriptBoard((event) => events.push(event))
  const trace = {
    runId: 'run',
    turnId: 'registered',
    request: { sequence: 1 },
    executions: [],
    invocations: [],
    observation: {
      registration: { status: 'updated', source: 'observe()', failure: null },
    },
  } as unknown as ActTurnTrace
  board.trace(trace)
  const summary = Object.freeze({
    moduleId: 'project',
    operation: 'read',
    status: 'succeeded' as const,
    effect: 'none' as const,
    input: 'i'.repeat(2001),
    output: 'o'.repeat(6001),
    inputTruncated: false,
    outputTruncated: false,
  })
  const run = {
    ...trace,
    turnId: 'observed',
    request: { ...trace.request, sequence: 2 },
    observation: {
      run: { executionId: 'observe-run', status: 'succeeded', failure: null, durationMs: 3 },
    },
    invocations: [{ executionId: 'observe-run', summary }],
  } as unknown as ActTurnTrace
  const originalTrace = JSON.stringify(run)
  const request = run.request
  board.trace(run)
  expect(events.at(-1)).toMatchObject({
    turnId: 'registered',
    status: 'succeeded',
    durationMs: 3,
    calls: [
      {
        ...summary,
        input: 'i'.repeat(2000),
        output: 'o'.repeat(6000),
        inputTruncated: true,
        outputTruncated: true,
      },
    ],
  })
  expect(summary.input).toHaveLength(2001)
  expect(summary.output).toHaveLength(6001)
  expect(run.invocations[0]?.summary).toBe(summary)
  expect(events.at(-1)?.calls[0]).not.toBe(summary)
  expect(run.request).toBe(request)
  expect(JSON.stringify(run)).toBe(originalTrace)
  board.trace({
    ...run,
    invocations: [
      {
        ...run.invocations[0]!,
        summary: { ...summary, input: '', output: '', inputTruncated: true, outputTruncated: true },
      },
    ],
  })
  expect(events.at(-1)?.calls[0]).toMatchObject({
    input: '',
    output: '',
    inputTruncated: true,
    outputTruncated: true,
  })
})

test('full trace output is shortened for display without discarding completion', () => {
  const payload: ConversationScriptProjection = {
    id: 'conversation:script:long',
    runId: 'run',
    turnId: 'turn',
    kind: 'execute',
    status: 'succeeded',
    source: 'console.log(data)',
    sourceTruncated: false,
    calls: [
      {
        moduleId: 'project',
        operation: 'read',
        status: 'succeeded',
        effect: 'none',
        input: 'i'.repeat(3000),
        output: 'o'.repeat(9000),
        inputTruncated: false,
        outputTruncated: false,
      },
    ],
    error: null,
    durationMs: 30,
    processOutput: 'x'.repeat(25000),
  }
  const state = applyWorkbenchConversationNotice(
    { messages: [], workerThreads: [] },
    'conversation-script',
    payload
  )
  expect(state.messages[0].blocks[0]).toMatchObject({
    status: 'succeeded',
    calls: [
      { output: 'x'.repeat(6000), outputTruncated: true },
      {
        input: 'i'.repeat(2000),
        output: 'o'.repeat(6000),
        inputTruncated: true,
        outputTruncated: true,
      },
    ],
  })
})
