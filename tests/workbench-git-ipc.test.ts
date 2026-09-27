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
        performFileAction: async (workspaceRoot: string, path: string, action: string) => {
          fileActions.push({ workspaceRoot, path, action })
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
          path: 'conflicted.ts',
          action: 'resolve',
        })
      ).ok,
      true
    )
    assert.deepEqual(fileActions, [
      { workspaceRoot: '/project', path: 'conflicted.ts', action: 'resolve' },
    ])
  })
})
