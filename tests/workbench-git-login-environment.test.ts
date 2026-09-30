import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path, { delimiter, join } from 'node:path'

import { describe, test } from 'bun:test'

import { WorkbenchChatCheckpointService } from '../src/main/workspace/git/WorkbenchChatCheckpoints'

import {
  git,
  HermeticGitEnvironment,
  withRepository,
  withTempDirectory,
} from './helpers/gitRepository'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

void describe('Workbench Git runs in the login-shell environment', () => {
  void test.skipIf(process.platform === 'win32')(
    'a chat checkpoint runs a clean filter that only the login-shell PATH can find',
    async () => {
      await withRepository(async (root) => {
        await withTempDirectory(async (scratch) => {
          // 像 Homebrew 装的 git-lfs：只在登录 shell 的 PATH 里，从程序坞启动的应用自己的 PATH 里没有。
          const tools = join(scratch, 'bin')
          const indexes = join(scratch, 'indexes')
          await mkdir(tools)
          const filter = join(tools, 'workbench-test-clean-filter')
          await writeFile(filter, '#!/bin/sh\ncat\n')
          await chmod(filter, 0o755)
          await git(root, ['config', 'filter.workbenchtest.clean', 'workbench-test-clean-filter'])
          await git(root, ['config', 'filter.workbenchtest.required', 'true'])
          await writeFile(join(root, '.gitattributes'), '*.bin filter=workbenchtest\n')
          await writeFile(join(root, 'asset.bin'), 'payload\n')

          const request = { workspaceRoot: root, sessionId: 's', checkpointId: 'c' }
          const appOnly = new WorkbenchChatCheckpointService(
            () => join(indexes, 'app'),
            async () => HermeticGitEnvironment
          )
          assert.equal((await appOnly.capture(request)).commitId, null)

          const login = new WorkbenchChatCheckpointService(
            () => join(indexes, 'login'),
            async () => ({
              ...HermeticGitEnvironment,
              PATH: `${tools}${delimiter}${process.env['PATH'] ?? ''}`,
            })
          )
          const { commitId } = await login.capture(request)
          assert.match(commitId ?? '', /^[0-9a-f]{40,64}$/u)
          assert.deepEqual(
            (await git(root, ['ls-tree', '-r', '--name-only', commitId ?? ''])).trim().split('\n'),
            ['.gitattributes', 'asset.bin']
          )

          // 登录环境读不出来（应用正在退出）时退回应用自己的环境：没有过滤器的仓库照样拍得下来。
          await git(root, ['config', '--unset', 'filter.workbenchtest.required'])
          await git(root, ['config', '--unset', 'filter.workbenchtest.clean'])
          const fallback = new WorkbenchChatCheckpointService(
            () => join(indexes, 'fallback'),
            () => Promise.reject(new Error('shell environment disposed'))
          )
          assert.match((await fallback.capture(request)).commitId ?? '', /^[0-9a-f]{40,64}$/u)
        })
      })
    }
  )

  void test('the app hands one shared login-shell environment to every Git child process', () => {
    const entry = readSource('src/main/index.ts')
    const providers = readSource('src/main/WorkbenchMainCapabilityProviders.ts')
    const probe = readSource('src/main/workspace/git/gitProbe.ts')

    // 登录环境全应用只解析一次、用到才解析（不拖慢启动）：Git 借的是 Agent 命令、外部引擎同一个实例。
    assert.equal(entry.match(/createShellEnvironment\(/gu)?.length, 1)
    assert.match(
      entry,
      /createDefaultWorkbenchMainCapabilityProviders\([\s\S]*?\(\) => shellEnvironment\.getEnvironment\(\)\n\s*\)/u
    )
    assert.match(entry, /new WorkbenchShellHostRegistry\(shellEnvironment,/u)
    assert.match(providers, /new WorkbenchGitService\(\{ environment: loginEnvironment \}\)/u)
    assert.match(
      providers,
      /new WorkbenchChatCheckpointService\(\s*\(\) => parts\.storagePaths\.getChatCheckpointIndexesDir\(\),\s*loginEnvironment\s*\)/u
    )
    // 探针给服务一份固定的环境，不看这台机器的 shell 配置和全局 git 配置。
    assert.match(probe, /new WorkbenchGitService\(\{ environment: [\s\S]*?ProbeGitEnvironment/u)
  })
})
