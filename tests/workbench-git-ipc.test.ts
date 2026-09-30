import assert from 'node:assert/strict'

import { describe, mock, test } from 'bun:test'

import { WorkbenchGitChannels } from '../src/shared/workbenchGit'

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()

mock.module('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    },
  },
}))

async function invoke(channel: string, request: unknown): Promise<{ ok: boolean }> {
  const handler = ipcHandlers.get(channel)
  assert.ok(handler, channel)
  return (await handler({}, request)) as { ok: boolean }
}

void describe('Workbench Git IPC requests', () => {
  void test('pushing a branch from the branch menu reaches the service with that branch', async () => {
    const remoteActions: unknown[] = []
    const fileActions: unknown[] = []
    const { registerWorkbenchGitIpc } = await import('../src/main/workspace/git/WorkbenchGitIpc')
    registerWorkbenchGitIpc(
      {
        performRemoteAction: async (workspaceRoot: string, action: string, options: unknown) => {
          remoteActions.push({ workspaceRoot, action, options })
          return {}
        },
        performFileAction: async (workspaceRoot: string, paths: string[], action: string) => {
          fileActions.push({ workspaceRoot, paths, action })
          return {}
        },
      } as never,
      {} as never,
      {} as never
    )

    assert.equal(
      (
        await invoke(WorkbenchGitChannels.remoteAction, {
          workspaceRoot: '/project',
          action: 'upload',
          branch: 'feature/menu',
          privateKeyPath: '~/.ssh/id_ed25519',
        })
      ).ok,
      true
    )
    assert.deepEqual(remoteActions, [
      {
        workspaceRoot: '/project',
        action: 'upload',
        options: {
          workspaceRoot: '/project',
          action: 'upload',
          branch: 'feature/menu',
          githubToken: undefined,
          privateKeyPath: '~/.ssh/id_ed25519',
          sshKeyPath: undefined,
          operationId: undefined,
        },
      },
    ])
    assert.equal(
      (
        await invoke(WorkbenchGitChannels.remoteAction, {
          workspaceRoot: '/project',
          action: 'upload',
          branch: 42,
        })
      ).ok,
      false
    )

    assert.equal(
      (
        await invoke(WorkbenchGitChannels.fileAction, {
          workspaceRoot: '/project',
          paths: ['conflicted.ts', 'other.ts'],
          action: 'resolve',
        })
      ).ok,
      true
    )
    assert.deepEqual(fileActions, [
      { workspaceRoot: '/project', paths: ['conflicted.ts', 'other.ts'], action: 'resolve' },
    ])
    for (const paths of [[], 'conflicted.ts', [42]])
      assert.equal(
        (
          await invoke(WorkbenchGitChannels.fileAction, {
            workspaceRoot: '/project',
            paths,
            action: 'stage',
          })
        ).ok,
        false
      )
  })

  void test('a remote action carries its operation id, and cancelling asks the service by that id', async () => {
    const started: unknown[] = []
    const cancelRequests: string[] = []
    const { registerWorkbenchGitIpc } = await import('../src/main/workspace/git/WorkbenchGitIpc')
    registerWorkbenchGitIpc(
      {
        performRemoteAction: async (
          _workspaceRoot: string,
          _action: string,
          options: { operationId?: string }
        ) => {
          started.push(options.operationId)
          return {}
        },
        cancelRemoteAction: (operationId: string) => {
          cancelRequests.push(operationId)
          return operationId === 'op-1'
        },
      } as never,
      {} as never,
      {} as never
    )

    const fetch = { workspaceRoot: '/project', action: 'fetch' }
    assert.equal(
      (await invoke(WorkbenchGitChannels.remoteAction, { ...fetch, operationId: 'op-1' })).ok,
      true
    )
    for (const operationId of ['', 7, 'x'.repeat(129)])
      assert.equal(
        (await invoke(WorkbenchGitChannels.remoteAction, { ...fetch, operationId })).ok,
        false
      )
    assert.deepEqual(started, ['op-1'])

    assert.deepEqual(await invoke(WorkbenchGitChannels.cancelRemoteAction, { operationId: 'op-1' }), {
      ok: true,
      value: { cancelled: true },
    })
    // 已经结束的操作：没有可取消的，不算出错。
    assert.deepEqual(await invoke(WorkbenchGitChannels.cancelRemoteAction, { operationId: 'gone' }), {
      ok: true,
      value: { cancelled: false },
    })
    for (const request of [{}, { operationId: 3 }, { operationId: '' }, null])
      assert.equal((await invoke(WorkbenchGitChannels.cancelRemoteAction, request)).ok, false)
    assert.deepEqual(cancelRequests, ['op-1', 'gone'])
  })

  void test('stash requests reach the service with their options, and a stash is named by its object name', async () => {
    const calls: unknown[] = []
    const { registerWorkbenchGitIpc } = await import('../src/main/workspace/git/WorkbenchGitIpc')
    registerWorkbenchGitIpc(
      {
        listStashes: async (workspaceRoot: string) => {
          calls.push(['list', workspaceRoot])
          return {}
        },
        stash: async (workspaceRoot: string, options: unknown) => {
          calls.push(['stash', workspaceRoot, options])
          return {}
        },
        performStashAction: async (workspaceRoot: string, sha: string, action: string) => {
          calls.push(['action', workspaceRoot, sha, action])
          return {}
        },
        getDiff: async (workspaceRoot: string, options: unknown) => {
          calls.push(['diff', workspaceRoot, options])
          return {}
        },
      } as never,
      {} as never,
      {} as never
    )
    const sha = 'a'.repeat(40)

    assert.equal((await invoke(WorkbenchGitChannels.stashList, { workspaceRoot: '/p' })).ok, true)
    assert.equal(
      (
        await invoke(WorkbenchGitChannels.stash, {
          workspaceRoot: '/p',
          message: 'wip',
          includeUntracked: true,
        })
      ).ok,
      true
    )
    assert.equal((await invoke(WorkbenchGitChannels.stash, { workspaceRoot: '/p' })).ok, true)
    assert.equal(
      (await invoke(WorkbenchGitChannels.stashAction, { workspaceRoot: '/p', sha, action: 'pop' }))
        .ok,
      true
    )
    assert.equal(
      (await invoke(WorkbenchGitChannels.diff, { workspaceRoot: '/p', stashSha: sha })).ok,
      true
    )
    assert.deepEqual(calls, [
      ['list', '/p'],
      ['stash', '/p', { message: 'wip', includeUntracked: true }],
      ['stash', '/p', { message: undefined, includeUntracked: undefined }],
      ['action', '/p', sha, 'pop'],
      [
        'diff',
        '/p',
        {
          commitSha: undefined,
          stashSha: sha,
          side: undefined,
          path: undefined,
          originalPath: undefined,
          maxChars: undefined,
        },
      ],
    ])

    for (const request of [
      { workspaceRoot: '/p', message: 7 },
      { workspaceRoot: '/p', includeUntracked: 'yes' },
      { message: 'no root' },
    ])
      assert.equal((await invoke(WorkbenchGitChannels.stash, request)).ok, false)
    for (const request of [
      { workspaceRoot: '/p', sha, action: 'clear' },
      { workspaceRoot: '/p', action: 'drop' },
      { workspaceRoot: '/p', sha: 3, action: 'drop' },
    ])
      assert.equal((await invoke(WorkbenchGitChannels.stashAction, request)).ok, false)
    // 差异看的是一个提交，或者一条贮藏，不能两样都给。
    assert.equal(
      (await invoke(WorkbenchGitChannels.diff, { workspaceRoot: '/p', stashSha: sha, commitSha: sha }))
        .ok,
      false
    )
  })

  void test('a blame request carries the editor text and the file format to the service', async () => {
    const blames: unknown[] = []
    const { registerWorkbenchGitIpc } = await import('../src/main/workspace/git/WorkbenchGitIpc')
    registerWorkbenchGitIpc(
      {
        getBlame: async (workspaceRoot: string, options: unknown) => {
          blames.push({ workspaceRoot, options })
          return { rootPath: workspaceRoot, commits: [], lines: [] }
        },
      } as never,
      {} as never,
      {} as never
    )

    assert.equal(
      (
        await invoke(WorkbenchGitChannels.blame, {
          workspaceRoot: '/project',
          path: 'src/a.ts',
          content: 'one\n',
          encoding: 'gb18030',
          eol: 'crlf',
        })
      ).ok,
      true
    )
    // 认不出的编码、换行符不往下传（按磁盘上的默认格式处理）；没给正文就按磁盘上的文件查。
    assert.equal(
      (
        await invoke(WorkbenchGitChannels.blame, {
          workspaceRoot: '/project',
          path: 'src/b.ts',
          encoding: 'klingon',
          eol: 7,
        })
      ).ok,
      true
    )
    assert.deepEqual(blames, [
      {
        workspaceRoot: '/project',
        options: { path: 'src/a.ts', content: 'one\n', encoding: 'gb18030', eol: 'crlf' },
      },
      {
        workspaceRoot: '/project',
        options: { path: 'src/b.ts', content: undefined, encoding: undefined, eol: undefined },
      },
    ])
    assert.equal((await invoke(WorkbenchGitChannels.blame, { workspaceRoot: '/project' })).ok, false)
  })

  void test('passes hunk actions through with the hunks as they were shown', async () => {
    const hunkActions: unknown[] = []
    const { registerWorkbenchGitIpc } = await import('../src/main/workspace/git/WorkbenchGitIpc')
    registerWorkbenchGitIpc(
      {
        applyHunks: async (workspaceRoot: string, options: unknown) => {
          hunkActions.push({ workspaceRoot, options })
          return {}
        },
      } as never,
      {} as never,
      {} as never
    )

    const hunk = { header: '@@ -1 +1 @@', lines: ['-a', '+b'] }
    assert.equal(
      (
        await invoke(WorkbenchGitChannels.hunkAction, {
          workspaceRoot: '/p',
          action: 'unstage',
          path: 'new.ts',
          originalPath: 'old.ts',
          hunks: [hunk],
        })
      ).ok,
      true
    )
    assert.deepEqual(hunkActions, [
      {
        workspaceRoot: '/p',
        options: { path: 'new.ts', originalPath: 'old.ts', action: 'unstage', hunks: [hunk] },
      },
    ])
    for (const request of [
      { action: 'commit', path: 'a.ts', hunks: [hunk] },
      { action: 'stage', path: 'a.ts', hunks: [] },
      { action: 'stage', path: 'a.ts', hunks: [{ header: '@@', lines: [1] }] },
      { action: 'stage', path: 'a.ts', originalPath: 7, hunks: [hunk] },
    ])
      assert.equal(
        (await invoke(WorkbenchGitChannels.hunkAction, { workspaceRoot: '/p', ...request })).ok,
        false
      )
  })

  void test('commits the index only when asked, and never together with chosen paths', async () => {
    const commits: unknown[] = []
    const { registerWorkbenchGitIpc } = await import('../src/main/workspace/git/WorkbenchGitIpc')
    registerWorkbenchGitIpc(
      {
        commit: async (...args: unknown[]) => {
          commits.push(['commit', ...args])
          return {}
        },
        commitStaged: async (...args: unknown[]) => {
          commits.push(['commitStaged', ...args])
          return {}
        },
      } as never,
      {} as never,
      {} as never
    )

    assert.equal(
      (await invoke(WorkbenchGitChannels.commit, { workspaceRoot: '/p', staged: true, message: 'm' }))
        .ok,
      true
    )
    assert.equal(
      (await invoke(WorkbenchGitChannels.commit, { workspaceRoot: '/p', paths: ['a.ts'] })).ok,
      true
    )
    assert.deepEqual(commits, [
      ['commitStaged', '/p', undefined, 'm'],
      ['commit', '/p', undefined, undefined, ['a.ts']],
    ])
    assert.equal(
      (
        await invoke(WorkbenchGitChannels.commit, {
          workspaceRoot: '/p',
          staged: true,
          paths: ['a.ts'],
        })
      ).ok,
      false
    )
  })
})
