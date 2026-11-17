import { expect, test } from 'bun:test'

import { type TimerHost, TimerScope } from '@velaros-ai/velaros/core/utils/TimerScope'

import { WorkbenchUpdatePolling } from '../src/main/updates/WorkbenchUpdatePolling'

test('automatic checks retry failures, repeat, throttle focus and stop after disposal', async () => {
  let now = 0
  let calls = 0
  let errors = 0
  let pending: (() => void) | undefined
  const tasks = new Map<number, { callback: () => void; at: number }>()
  let sequence = 0
  const host: Partial<TimerHost> = {
    setTimeout: (callback, delay) => {
      const id = ++sequence
      tasks.set(id, { callback, at: now + delay })
      return id
    },
    clearTimeout: (id) => {
      tasks.delete(id as number)
    },
  }
  const polling = new WorkbenchUpdatePolling(
    async () => {
      calls++
      if (calls === 1) throw new Error('offline')
      if (calls === 3)
        await new Promise<void>((resolve) => {
          pending = resolve
        })
    },
    () => {
      errors++
    },
    new TimerScope({ host }),
    () => now
  )
  const settle = async (): Promise<void> => {
    await Promise.resolve()
    await Promise.resolve()
  }
  const advance = async (ms: number): Promise<void> => {
    now += ms
    for (const [id, task] of tasks)
      if (task.at <= now) {
        tasks.delete(id)
        task.callback()
      }
    await settle()
  }
  polling.start()
  polling.start()
  polling.wake()
  await settle()
  expect(calls).toBe(1)
  expect(errors).toBe(1)
  await advance(59_999)
  polling.wake()
  expect(calls).toBe(1)
  await advance(1)
  expect(calls).toBe(2)
  await advance(15 * 60_000)
  expect(calls).toBe(3)
  polling.wake()
  expect(calls).toBe(3)
  polling.dispose()
  pending?.()
  await settle()
  await advance(60 * 60_000)
  polling.wake()
  polling.start()
  expect(calls).toBe(3)
  expect(tasks.size).toBe(0)
})
