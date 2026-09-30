import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

import { describe, test } from 'bun:test'

import type {
  WorkbenchContentSearchTask,
  WorkbenchContentSearchTaskResult,
  WorkbenchContentSearchWorkerRequest,
  WorkbenchContentSearchWorkerResponse,
} from '../src/main/workspace/ContentSearchTask'
import {
  type WorkbenchContentSearchWorkerPort,
  WorkbenchContentSearchWorkerSession,
} from '../src/main/workspace/ContentSearchWorkerHost'

/**
 * 搜索 worker 会话（主进程这边）：久没有动静就结束 worker 并说卡在哪个文件上，心跳说明它还活着；取消时不等
 * worker，立刻返回并结束它；worker 意外退出，请求以错误结束。worker 用假的，时间可控。
 */

class FakeSearchWorker extends EventEmitter implements WorkbenchContentSearchWorkerPort {
  public readonly requests: WorkbenchContentSearchWorkerRequest[] = []
  public terminated = false

  public postMessage(message: WorkbenchContentSearchWorkerRequest): void {
    this.requests.push(message)
  }

  public reply(response: WorkbenchContentSearchWorkerResponse): void {
    this.emit('message', response)
  }

  public terminate(): Promise<number> {
    this.terminated = true
    return Promise.resolve(1)
  }
}

const Task: WorkbenchContentSearchTask = {
  projectRoot: '/project',
  paths: ['a.ts', 'slow.ts'],
  openPaths: [],
  query: { query: 'needle', matchCase: false, wholeWord: false, regex: false },
  limit: 100,
  maxResultsPerFile: 100,
}

const Done: WorkbenchContentSearchTaskResult = {
  files: [],
  openPathsInScope: [],
  truncated: false,
  skippedLargeFileCount: 0,
}

function openSession(stallTimeoutMs: number) {
  const workers: FakeSearchWorker[] = []
  const session = new WorkbenchContentSearchWorkerSession(() => {
    const worker = new FakeSearchWorker()
    workers.push(worker)
    return worker
  }, stallTimeoutMs)
  return { session, workers }
}

function rejectsWith(code: string, message: RegExp) {
  return (error: unknown) => {
    const failure = error as { code?: string; message?: string }
    assert.equal(failure.code, code)
    assert.match(failure.message ?? '', message)
    return true
  }
}

void describe('content search worker session', () => {
  void test('a worker that goes quiet while scanning a file is ended, naming the file', async () => {
    const { session, workers } = openSession(50)
    const searching = session.search(Task)
    const worker = workers[0]!
    const { id } = worker.requests[0]!
    worker.reply({ id, kind: 'file', path: 'a.ts' })
    worker.reply({ id, kind: 'file', path: 'slow.ts' })

    await assert.rejects(searching, rejectsWith('TIMEOUT', /slow\.ts/u))
    assert.equal(worker.terminated, true)
  })

  void test('heartbeats keep a worker that waits on the disk going; a stall after one names no file', async () => {
    const { session, workers } = openSession(80)
    const searching = session.search(Task)
    const worker = workers[0]!
    const { id } = worker.requests[0]!
    worker.reply({ id, kind: 'file', path: 'a.ts' })
    // 比判定卡住的时限长得多，但一直有心跳。
    for (let beat = 0; beat < 6; beat += 1) {
      await delay(40)
      worker.reply({ id, kind: 'heartbeat' })
    }
    worker.reply({ id, kind: 'result', result: Done })
    assert.deepEqual(await searching, Done)
    assert.equal(worker.terminated, false)
    session.close()
    assert.equal(worker.terminated, true)

    // 心跳说明上一个文件已经搜完：之后没了动静，不能怪到那个文件头上。
    const quiet = openSession(50)
    const stalled = quiet.session.search(Task)
    const quietWorker = quiet.workers[0]!
    const quietId = quietWorker.requests[0]!.id
    quietWorker.reply({ id: quietId, kind: 'file', path: 'a.ts' })
    quietWorker.reply({ id: quietId, kind: 'heartbeat' })
    await assert.rejects(stalled, (error: unknown) => {
      const failure = error as { code?: string; message?: string }
      assert.equal(failure.code, 'TIMEOUT')
      assert.doesNotMatch(failure.message ?? '', /a\.ts/u)
      return true
    })
  })

  void test('cancelling returns at once and ends the worker; late messages are ignored', async () => {
    const { session, workers } = openSession(60_000)
    const controller = new AbortController()
    const batches: unknown[] = []
    const searching = session.search(Task, {
      signal: controller.signal,
      onBatch: (batch) => batches.push(batch),
    })
    const worker = workers[0]!
    const { id } = worker.requests[0]!
    assert.equal((worker.requests[0] as { stream?: boolean }).stream, true)
    controller.abort()
    assert.equal(await searching, null)
    assert.equal(worker.terminated, true)

    worker.reply({ id, kind: 'batch', batch: { files: [], openPathsInScope: ['a.ts'] } })
    assert.deepEqual(batches, [])

    // 同一会话的下一个请求开新的 worker。
    const again = session.search(Task)
    const next = workers[1]!
    assert.equal((next.requests[0] as { stream?: boolean }).stream, false)
    next.reply({ id: next.requests[0]!.id, kind: 'result', result: Done })
    assert.deepEqual(await again, Done)
    session.close()
  })

  void test('a replace that hangs names its file; a worker that exits fails the request', async () => {
    const { session, workers } = openSession(50)
    const replacing = session.replace(
      { content: 'aaaa', query: Task.query, replacement: 'b' },
      'src/long.ts'
    )
    // 接下请求以后再没有动静。起 worker 花的时间不算：没接下之前不按这个时限判。
    await delay(120)
    assert.equal(workers[0]!.terminated, false)
    workers[0]!.reply({ id: workers[0]!.requests[0]!.id, kind: 'started' })
    await assert.rejects(replacing, rejectsWith('TIMEOUT', /src\/long\.ts/u))
    assert.equal(workers[0]!.terminated, true)

    const crashed = openSession(60_000)
    const searching = crashed.session.search(Task)
    crashed.workers[0]!.emit('exit', 1)
    await assert.rejects(searching, rejectsWith('CLOSED', /意外退出/u))

    // 撞到堆上限：worker 出错退出，主进程没事，给出能看懂的说明。
    const exhausted = openSession(60_000)
    const heavy = exhausted.session.search(Task)
    exhausted.workers[0]!.emit(
      'error',
      Object.assign(new RangeError('Worker terminated due to reaching memory limit'), {
        code: 'ERR_WORKER_OUT_OF_MEMORY',
      })
    )
    await assert.rejects(heavy, rejectsWith('LIMIT', /内存太多/u))
    assert.equal(exhausted.workers[0]!.terminated, true)
  })
})
