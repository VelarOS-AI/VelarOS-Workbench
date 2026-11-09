import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, mock, test } from 'bun:test'

import { currentPlatform } from '@velaros-ai/velaros/core/platform'

import { analyzeWorkbenchCommandExecution } from '../src/main/workspace/CommandExecutionPolicy'
import { WorkbenchFsChannels } from '../src/shared/workbenchFs'

/**
 * 命令面板（渲染进程经 IPC 跑命令）是用户自己输入、自己点运行的：用户就是确认者。
 * 这条通道上没有确认卡可弹，危险命令在这里被挡回只会让用户对着「需要确认」却无处确认。
 */

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()

mock.module('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    },
    on: () => undefined,
  },
}))

async function registerCommandPanelIpc(): Promise<(request: unknown) => Promise<unknown>> {
  const { registerWorkbenchFsIpc } = await import('../src/main/workspace/WorkbenchFsIpc')
  const { CommandHelper } = await import('../src/main/workspace/CommandHelper')
  const { CommandRunner } = await import('../src/main/workspace/CommandRunner')
  const { PathResolver } = await import('../src/main/workspace/PathResolver')
  registerWorkbenchFsIpc(
    {} as never,
    { commands: new CommandRunner(new PathResolver(), new CommandHelper()) } as never,
    {} as never
  )
  const handler = ipcHandlers.get(WorkbenchFsChannels.runCommand)
  assert.ok(handler)
  const sender = Object.assign(new EventEmitter(), {
    id: 1, isDestroyed: () => false, send: () => undefined,
  })
  return async (request) => handler({ sender }, request)
}

void describe('Workbench command panel IPC', () => {
  void test('owner release and renderer loss cancel pending commands and wait for cleanup', async () => {
    const { registerWorkbenchFsIpc } = await import('../src/main/workspace/WorkbenchFsIpc')
    for (const reason of ['project', 'render-process-gone'] as const) {
      const work = Promise.withResolvers<unknown>()
      let commandSignal: AbortSignal | undefined
      const owner = registerWorkbenchFsIpc({} as never, {
        commands: { runCommand: (_request: unknown, _output: unknown, signal: AbortSignal) => {
          commandSignal = signal
          return work.promise
        } },
      } as never, {} as never)
      const sender = Object.assign(new EventEmitter(), { id: 22, isDestroyed: () => false, send: () => undefined })
      const pending = ipcHandlers.get(WorkbenchFsChannels.runCommand)!({ sender }, { projectRoot: '/project', command: 'build' })
      if (reason === 'render-process-gone') sender.emit(reason)
      const closing = owner.cancelCommandsForSender(sender.id)
      assert.equal(commandSignal?.aborted, true)
      let closed = false
      void closing.then(() => { closed = true })
      await Promise.resolve()
      assert.equal(closed, false)
      work.resolve({ success: false })
      await closing
      await pending
      assert.equal(sender.listenerCount('destroyed'), 0)
      assert.equal(sender.listenerCount('render-process-gone'), 0)
    }
  })

  void test('runs a dangerous command the user typed without refusing it', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'workbench-command-panel-')))
    try {
      await mkdir(join(root, 'cache', 'nested'), { recursive: true })
      const runCommand = await registerCommandPanelIpc()
      const shellKind = currentPlatform.getShellKind(
        currentPlatform.getPreferredShellPath(process.env)
      )
      const command =
        shellKind === 'cmd'
          ? 'rmdir /s /q cache'
          : shellKind === 'pwsh' || shellKind === 'powershell'
            ? 'Remove-Item -LiteralPath cache -Recurse -Force'
            : 'rm -r cache'
      assert.equal(analyzeWorkbenchCommandExecution(command, root).isDangerous, true)

      const result = (await runCommand({ projectRoot: root, command })) as {
        ok: boolean
        value?: { success: boolean }
      }

      assert.equal(result.ok, true)
      assert.equal(result.value?.success, true)
      assert.equal(
        await stat(join(root, 'cache')).then(
          () => true,
          () => false
        ),
        false
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
