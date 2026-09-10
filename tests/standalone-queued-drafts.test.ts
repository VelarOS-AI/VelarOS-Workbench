import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import { StandaloneQueuedDraftStore } from '../src/renderer/src/runtime/standaloneQueuedDrafts'

const Scope = 'session-1'

function ids(store: StandaloneQueuedDraftStore): string[] {
  return store.snapshot(Scope).drafts.map((draft) => draft.value)
}

void describe('standalone queued composer drafts', () => {
  void test('keeps drafts per session in order and supports editing, moving and taking back', () => {
    const store = new StandaloneQueuedDraftStore()
    const first = store.enqueue(Scope, { value: 'first', files: [] })
    const second = store.enqueue(Scope, { value: 'second', files: [] })
    store.enqueue('other-session', { value: 'elsewhere', files: [] })

    assert.deepEqual(ids(store), ['first', 'second'])
    store.move(Scope, second, 'up')
    assert.deepEqual(ids(store), ['second', 'first'])
    store.edit(Scope, first, 'first (edited)')
    assert.deepEqual(ids(store), ['second', 'first (edited)'])
    assert.equal(store.take(Scope, second)?.value, 'second')
    assert.deepEqual(ids(store), ['first (edited)'])
    assert.deepEqual(store.snapshot('other-session').drafts.map((draft) => draft.value), ['elsewhere'])
  })

  void test('dequeues only drafts the sender accepted and never sends two at once', async () => {
    const store = new StandaloneQueuedDraftStore()
    const accepted = store.enqueue(Scope, { value: 'accepted', files: [] })
    const rejected = store.enqueue(Scope, { value: 'rejected', files: [] })

    let release!: (value: boolean) => void
    const pending = store.submit(Scope, accepted, () => new Promise((resolve) => { release = resolve }))
    assert.equal(store.snapshot(Scope).drainingId, accepted)
    // 正在出队时不允许并发发出第二项
    await store.submit(Scope, rejected, async () => true)
    assert.deepEqual(ids(store), ['accepted', 'rejected'])

    release(true)
    await pending
    assert.deepEqual(ids(store), ['rejected'])
    assert.equal(store.snapshot(Scope).drainingId, null)

    await store.submit(Scope, rejected, async () => false)
    assert.deepEqual(ids(store), ['rejected'], '未受理的草稿留在队里')

    await store.submit(Scope, rejected, async () => {
      throw new Error('network down')
    })
    assert.deepEqual(ids(store), ['rejected'])
    assert.equal(store.snapshot(Scope).drainingId, null, '发送抛错也要释放出队占用')
    assert.equal(store.snapshot(Scope).errorMessage, 'network down')
  })

  void test('a rejected draft blocks automatic draining instead of being resent in a loop', async () => {
    const store = new StandaloneQueuedDraftStore()
    const first = store.enqueue(Scope, { value: 'first', files: [] })
    store.enqueue(Scope, { value: 'second', files: [] })
    let sends = 0
    const reject = async (): Promise<boolean> => {
      sends += 1
      return false
    }

    await store.drain(Scope, { busy: false, paused: false }, reject)
    await store.drain(Scope, { busy: false, paused: false }, reject)
    assert.equal(sends, 1, '被挡住的队首不能被自动重投')
    assert.equal(store.snapshot(Scope).blockedId, first)

    // 用户显式「立即运行」这一项才会再投；受理后解除阻挡，下一项恢复自动出队。
    await store.submit(Scope, first, async () => true)
    assert.equal(store.snapshot(Scope).blockedId, null)
    await store.drain(Scope, { busy: false, paused: false }, async () => true)
    assert.deepEqual(ids(store), [])
  })

  void test('does not drain while the session is busy or paused after a stop', async () => {
    const store = new StandaloneQueuedDraftStore()
    store.enqueue(Scope, { value: 'queued', files: [] })
    let sends = 0
    const accept = async (): Promise<boolean> => {
      sends += 1
      return true
    }

    await store.drain(Scope, { busy: true, paused: false }, accept)
    await store.drain(Scope, { busy: false, paused: true }, accept)
    assert.equal(sends, 0)
    await store.drain(Scope, { busy: false, paused: false }, accept)
    assert.equal(sends, 1)
    assert.deepEqual(ids(store), [])
  })
})
