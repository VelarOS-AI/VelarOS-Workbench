import assert from 'node:assert/strict'
import { EventEmitter, getEventListeners } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { test } from 'bun:test'

import { InstalledToolchainSession } from '../scripts/test/InstalledToolchainSession'

type Dependencies = NonNullable<ConstructorParameters<typeof InstalledToolchainSession>[1]>

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })
  let released = true
  let stops = 0
  const removed: string[] = []
  let stop: Dependencies['stop'] = async (command): Promise<void> => {
    await command.closed
  }
  const session = new InstalledToolchainSession(
    '/owned-installed-toolchain',
    {
      spawn: (() => child) as never,
      released: (command) => command.didClose && released,
      stop: async (command, terminationCommands) => {
        stops += 1
        await stop(command, terminationCommands)
      },
      remove: async (directory) => {
        removed.push(directory)
      },
    },
    200,
    100
  )
  const close = (code = 0): void => {
    child.exitCode = code
    child.stdout.end()
    child.stderr.end()
    child.emit('close', code, null)
  }
  return {
    child,
    session,
    removed,
    close,
    stops: () => stops,
    holdTree: () => {
      released = false
    },
    releaseTree: () => {
      released = true
    },
    stopping: (operation: typeof stop) => {
      stop = operation
    },
  }
}

test('installed commands collect post-exit output and decode UTF8 across chunks until real close', async () => {
  const owned = fixture()
  let settled = false
  const running = owned.session.run('fixture', [], '/owned-installed-toolchain')
  void running.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  owned.child.stdout.write(Buffer.from([0xe4, 0xb8]))
  owned.child.exitCode = 0
  owned.child.emit('exit', 0, null)
  await Promise.resolve()
  assert.equal(settled, false)
  owned.child.stdout.write(Buffer.from([0xad]))
  owned.child.stdout.write(':tail')
  owned.child.stderr.write('diagnostic')
  owned.close()
  assert.deepEqual(await running, { stdout: '中:tail', stderr: 'diagnostic' })
  assert.equal(owned.stops(), 0)
  assert.equal(getEventListeners(owned.session.signal, 'abort').length, 0)
  await owned.session.finish({ failed: false })
  assert.deepEqual(owned.removed, ['/owned-installed-toolchain'])
})

test('installed command abort waits for close and preserves the abort reason', async () => {
  const owned = fixture()
  let stopping!: () => void
  const stopped = new Promise<void>((resolve) => {
    stopping = resolve
  })
  owned.stopping(async (command) => {
    stopping()
    await command.closed
  })
  const reason = new Error('user interrupt')
  const running = owned.session.run('fixture', [], '/owned-installed-toolchain')
  let settled = false
  const rejected = assert.rejects(running, (error: unknown) => {
    assert.equal((error as Error).cause, reason)
    settled = true
    return true
  })
  owned.session.abort(reason)
  await stopped
  assert.equal(settled, false)
  owned.close()
  await rejected
  assert.equal(getEventListeners(owned.session.signal, 'abort').length, 0)
})

test('installed command deadline enters termination within the original budget', async () => {
  const owned = fixture()
  const before = Date.now()
  let deadline = 0
  let terminationStartedAt = 0
  owned.stopping(async (command) => {
    deadline = command.deadlineAt
    terminationStartedAt = Date.now()
    owned.close()
    await command.closed
  })
  await assert.rejects(
    owned.session.run('hung-fixture', [], '/owned-installed-toolchain'),
    (error: unknown) => {
      assert.equal(((error as Error).cause as { code: string }).code, 'TIMEOUT')
      return true
    }
  )
  assert.equal(owned.stops(), 1)
  assert.ok(deadline >= before + 200)
  assert.ok(deadline <= terminationStartedAt + 100)
  await owned.session.finish({ failed: false })
})

test('spawn failure still waits for close and does not release a pending child', async () => {
  const owned = fixture()
  let stopping!: () => void
  const stopped = new Promise<void>((resolve) => {
    stopping = resolve
  })
  owned.stopping(async (command) => {
    stopping()
    await command.closed
  })
  const failure = new Error('spawn unavailable')
  const running = owned.session.run('missing-fixture', [], '/owned-installed-toolchain')
  const rejected = assert.rejects(running, (error: unknown) => (error as Error).cause === failure)
  owned.child.emit('error', failure)
  await stopped
  assert.deepEqual(owned.removed, [])
  owned.close(-1)
  await rejected
})

test('a zero exit with owned descendants fails and drains the tree before removal', async () => {
  const owned = fixture()
  owned.holdTree()
  owned.stopping(async () => {
    owned.releaseTree()
  })
  const running = owned.session.run('leaking-fixture', [], '/owned-installed-toolchain')
  const rejected = assert.rejects(running, /leaking-fixture/u)
  owned.close()
  await rejected
  assert.equal(owned.stops(), 1)
  await owned.session.finish({ failed: false })
  assert.deepEqual(owned.removed, ['/owned-installed-toolchain'])
})

test('unconfirmed process ownership retains the directory and still unregisters the service', async () => {
  const owned = fixture()
  owned.holdTree()
  const terminationFailure = new Error('tree did not close')
  owned.stopping(async () => {
    throw terminationFailure
  })
  const primary = new Error('original assertion')
  let disposed = false
  let unregistered = false
  const running = owned.session.run('leaking-fixture', [], '/owned-installed-toolchain')
  const rejected = assert.rejects(running, AggregateError)
  owned.close()
  await rejected
  await assert.rejects(
    owned.session.finish({
      failed: true,
      failure: primary,
      disposeLanguageServices: async () => {
        disposed = true
      },
      unregister: () => {
        unregistered = true
      },
    }),
    (error: unknown) => {
      const failures = (error as AggregateError).errors
      assert.equal(failures[0], primary)
      assert.ok(failures.some((entry) => String(entry).includes('retained temporary directory')))
      return true
    }
  )
  assert.equal(disposed, true)
  assert.equal(unregistered, true)
  assert.deepEqual(owned.removed, [])
})

test('language disposal rejection keeps the original failure, unregisters and retains the directory', async () => {
  const owned = fixture()
  const primary = new Error('acceptance failed')
  const disposal = new Error('LSP did not close')
  let unregistered = false
  await assert.rejects(
    owned.session.finish({
      failed: true,
      failure: primary,
      disposeLanguageServices: async () => {
        throw disposal
      },
      unregister: () => {
        unregistered = true
      },
    }),
    (error: unknown) => {
      assert.equal((error as AggregateError).errors[0], primary)
      assert.ok((error as AggregateError).errors.includes(disposal))
      return true
    }
  )
  assert.equal(unregistered, true)
  assert.deepEqual(owned.removed, [])
})

test('an unclosed tree termination command also retains the temporary directory', async () => {
  const owned = fixture()
  owned.holdTree()
  owned.stopping(async (command, terminationCommands) => {
    terminationCommands.set(command.child, new Promise<void>(() => {}))
    owned.releaseTree()
  })
  const running = owned.session.run('leaking-fixture', [], '/owned-installed-toolchain')
  const rejected = assert.rejects(running, /leaking-fixture/u)
  owned.close()
  await rejected
  let unregistered = false
  await assert.rejects(
    owned.session.finish({
      failed: false,
      unregister: () => {
        unregistered = true
      },
    }),
    AggregateError
  )
  assert.equal(unregistered, true)
  assert.deepEqual(owned.removed, [])
})

test('successful cleanup rethrows the original assertion object after unregistering and removal', async () => {
  const owned = fixture()
  const primary = new Error('original assertion')
  let unregistered = false
  await assert.rejects(
    owned.session.finish({
      failed: true,
      failure: primary,
      unregister: () => {
        unregistered = true
      },
    }),
    (error: unknown) => error === primary
  )
  assert.equal(unregistered, true)
  assert.deepEqual(owned.removed, ['/owned-installed-toolchain'])
})

test('already cancelled sessions do not spawn a command', async () => {
  const owned = fixture()
  const reason = new Error('already cancelled')
  owned.session.abort(reason)
  await assert.rejects(
    owned.session.run('fixture', [], '/owned-installed-toolchain'),
    (error: unknown) => error === reason
  )
  assert.equal(owned.stops(), 0)
  assert.equal(owned.child.listenerCount('close'), 0)
})

test('excessive output is a command failure rather than a successful truncated report', async () => {
  const owned = fixture()
  owned.stopping(async () => {
    owned.close()
  })
  const running = owned.session.run('noisy-fixture', [], '/owned-installed-toolchain')
  const rejected = assert.rejects(running, (error: unknown) => {
    const failure = error as Error
    assert.match(String(failure.cause), /exceeded 50000 characters/u)
    assert.ok(failure.message.length < 51_000)
    return true
  })
  owned.child.stdout.write('x'.repeat(50_001))
  await rejected
  assert.equal(owned.stops(), 1)
})

test('directory removal failure is reported alongside the primary error after unregistering', async () => {
  const primary = new Error('original assertion')
  const removal = new Error('directory remains')
  const session = new InstalledToolchainSession('/owned-installed-toolchain', {
    spawn: (() => {
      throw new Error('must not spawn')
    }) as never,
    released: () => true,
    stop: async () => {},
    remove: async () => {
      throw removal
    },
  })
  let unregistered = false
  await assert.rejects(
    session.finish({
      failed: true,
      failure: primary,
      unregister: () => {
        unregistered = true
      },
    }),
    (error: unknown) => {
      assert.deepEqual((error as AggregateError).errors, [primary, removal])
      return true
    }
  )
  assert.equal(unregistered, true)
})

test('real installed command helper waits for a native process to close without UI or network', async () => {
  const root = await mkdtemp(join(tmpdir(), 'installed-toolchain-command-'))
  const session = new InstalledToolchainSession(root)
  let failed = false
  let failure: unknown
  try {
    const node =
      process.env.VELAR_WORKBENCH_TEST_NODE ?? (process.platform === 'win32' ? 'node.exe' : 'node')
    const result = await session.run(
      node,
      [
        '-e',
        'process.stdout.write(Buffer.from([0xe4,0xb8]));setImmediate(()=>process.stdout.write(Buffer.from([0xad])))',
      ],
      root
    )
    assert.equal(result.stdout, '中')
  } catch (error) {
    failed = true
    failure = error
  } finally {
    await session.finish({ failed, failure })
  }
})
