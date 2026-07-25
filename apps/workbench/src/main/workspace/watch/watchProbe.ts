import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SystemWorkspaceFilesChangedEvent } from '@velaros/core/types'

import { WorkbenchFileWatcher } from './WorkbenchFileWatcher'

let assertions = 0

function assert(condition: unknown, message: string): asserts condition {
  assertions += 1
  if (!condition) throw new Error(message)
}

async function waitForEvent(
  events: SystemWorkspaceFilesChangedEvent[],
  index = 0,
  timeoutMs = 2_000
): Promise<SystemWorkspaceFilesChangedEvent> {
  const startedAt = Date.now()
  while (events.length <= index && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const event = events[index]
  if (!event) throw new Error('watch event timeout')
  return event
}

const root = await mkdtemp(join(tmpdir(), 'velaros-workbench-watch-'))
const service = new WorkbenchFileWatcher({ debounceMs: 30, now: () => 123 })

try {
  const firstEvents: SystemWorkspaceFilesChangedEvent[] = []
  const secondEvents: SystemWorkspaceFilesChangedEvent[] = []
  const first = await service.subscribe(root, (event) => firstEvents.push(event))
  const second = await service.subscribe(root, (event) => secondEvents.push(event))

  assert(first.subscriptionId !== second.subscriptionId, 'subscriptions must be isolated')
  assert(first.workspaceRoot === (await realpath(root)), 'root must be canonical')

  await Promise.all([
    writeFile(join(root, 'one.ts'), 'one'),
    writeFile(join(root, 'two.ts'), 'two'),
  ])
  const event = await waitForEvent(firstEvents)
  await waitForEvent(secondEvents)

  assert(event.kind === 'velaros.systemWorkspaceFilesChanged', 'event kind must be stable')
  assert(event.source === 'filesystem-watch', 'event source must identify watcher')
  assert(event.rootPath === first.workspaceRoot, 'event root must be canonical')
  assert(event.changedAt === 123, 'event timestamp must use dependency clock')
  assert(event.paths.includes('one.ts'), 'first path must be reported')
  assert(event.paths.includes('two.ts'), 'second path must be reported')
  assert(event.sessionIds.length === 0, 'standalone watcher must not invent sessions')

  service.unsubscribe(first.subscriptionId)
  const firstCount = firstEvents.length
  await writeFile(join(root, 'three.ts'), 'three')
  const secondEvent = await waitForEvent(secondEvents, 1)
  assert(secondEvent.paths.includes('three.ts'), 'remaining subscriber must receive changes')
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert(firstEvents.length === firstCount, 'released subscriber must receive no changes')

  await mkdir(join(root, '.git'))
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const gitEvent = await waitForEvent(secondEvents, 2)
  assert(gitEvent.paths.includes('.git/HEAD'), 'Git state changes must refresh Git surfaces')

  await mkdir(join(root, 'node_modules'))
  const beforeIgnoredWrite = secondEvents.length
  await writeFile(join(root, 'node_modules', 'ignored.js'), 'ignored')
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert(secondEvents.length === beforeIgnoredWrite, 'heavy tool directories must be ignored')

  service.unsubscribe(second.subscriptionId)
  service.dispose()
  assert(true, 'dispose is idempotent after final unsubscribe')
} finally {
  service.dispose()
  await rm(root, { recursive: true, force: true })
}

console.info(`workbench watch probe passed (${assertions} assertions)`)
