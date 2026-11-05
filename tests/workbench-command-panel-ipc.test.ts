import assert from 'node:assert/strict'
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
  const sender = { isDestroyed: () => false, send: () => undefined }
  return async (request) => handler({ sender }, request)
}

void describe('Workbench command panel IPC', () => {
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
