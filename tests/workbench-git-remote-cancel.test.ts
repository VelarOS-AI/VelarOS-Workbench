import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import path, { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { describe, test } from 'bun:test'

import { translateWorkbenchAppMessage } from '../src/renderer/src/i18n/useStandaloneWorkbenchLocalization'
import {
  beginWorkbenchGitRemoteOperation,
  endWorkbenchGitRemoteOperation,
  markWorkbenchGitRemoteOperationCancelling,
  readWorkbenchGitRemoteOperation,
  subscribeWorkbenchGitRemoteOperations,
} from '../src/renderer/src/models/git/workbenchGitRemoteOperation'

import {
  commitAll,
  createGitService,
  git,
  initRepository,
  isAppError,
  withRepository,
  withTempDirectory,
} from './helpers/gitRepository'

const execFileAsync = promisify(execFile)

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

/** 命令行里带着这个记号的进程还有几个（git 起的「ssh」）。 */
async function countProcesses(marker: string): Promise<number> {
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'command='])
  return stdout.split('\n').filter((line) => line.includes(marker)).length
}

/** 一个永远连不上的 SSH 远端：`ssh` 由测试换成别的命令，模拟网络的各种情况。 */
async function withSshRemote(run: (root: string) => Promise<void>): Promise<void> {
  await withRepository(async (root) => {
    await writeFile(join(root, 'a.txt'), 'a\n')
    await commitAll(root, 'base')
    await git(root, ['remote', 'add', 'origin', 'ssh://example.invalid/repo.git'])
    await run(root)
  })
}

void describe.skipIf(process.platform === 'win32')('Workbench Git remote actions: limits and cancel', () => {
  void test('a remote command that goes silent is stopped after the inactivity limit', async () => {
    await withSshRemote(async (root) => {
      // ssh 一直不返回也不出声：网络卡住了。
      const service = createGitService({ GIT_SSH_COMMAND: 'sleep 30 #' }, 500)
      const startedAt = Date.now()
      await assert.rejects(
        service.performRemoteAction(root, 'fetch'),
        isAppError('TIMEOUT', /git fetch 已经 1 秒没有任何进展/)
      )
      assert.ok(Date.now() - startedAt < 10_000)
    })
  })

  void test('a slow remote command that keeps reporting is not stopped by the limit', async () => {
    await withSshRemote(async (root) => {
      // 每 200ms 出一点声，总共比时限长得多：一直有进展，不能被当成卡住。
      // GIT_SSH_VARIANT：不让 git 先拿 `-G` 把这个「ssh」试跑一遍（那一遍的输出是丢掉的）。
      const service = createGitService(
        {
          GIT_SSH_VARIANT: 'ssh',
          GIT_SSH_COMMAND:
            "sh -c 'for i in 1 2 3 4 5 6 7 8; do echo working >&2; sleep 0.2; done; echo \"Permission denied (publickey).\" >&2; exit 255' --",
        },
        600
      )
      const startedAt = Date.now()
      await assert.rejects(
        service.performRemoteAction(root, 'fetch'),
        isAppError('PERMISSION', /远端拒绝了身份验证/)
      )
      assert.ok(Date.now() - startedAt >= 1_500, 'ran past the inactivity limit')
    })
  })

  void test('cancelling stops git together with the ssh it started', async () => {
    await withSshRemote(async (root) => {
      const marker = `sleep 3${randomInt(100_000, 999_999)}`
      const service = createGitService({ GIT_SSH_COMMAND: `${marker} #` })
      const running = service.performRemoteAction(root, 'fetch', { operationId: 'op-1' })
      const settled = assert.rejects(running, isAppError('CANCELLED', /已取消 git fetch/))
      for (let waited = 0; (await countProcesses(marker)) === 0; waited += 50) {
        assert.ok(waited < 5_000, 'the fake ssh never started')
        await delay(50)
      }

      const startedAt = Date.now()
      assert.equal(service.cancelRemoteAction('op-1'), true)
      await settled
      assert.ok(Date.now() - startedAt < 5_000)
      for (let waited = 0; (await countProcesses(marker)) > 0; waited += 50) {
        assert.ok(waited < 5_000, 'the fake ssh outlived the cancelled fetch')
        await delay(50)
      }
      // 已经结束的、没听说过的编号：没有可取消的。
      assert.equal(service.cancelRemoteAction('op-1'), false)
      assert.equal(service.cancelRemoteAction('never-started'), false)
      // 取消不留下锁：同一个仓库接着还能用。
      assert.equal((await service.getSummary(root)).status?.isClean, true)
    })
  })

  void test('a sync cancelled while pulling does not go on to push', async () => {
    await withTempDirectory(async (base) => {
      const origin = join(base, 'origin.git')
      await git(base, ['init', '-q', '--bare', '-b', 'main', origin])
      const local = join(base, 'local')
      await git(base, ['clone', '-q', origin, local])
      await git(local, ['switch', '-q', '-c', 'main'])
      await initRepository(local)
      await writeFile(join(local, 'a.txt'), 'a\n')
      await commitAll(local, 'base')
      await git(local, ['push', '-q', '-u', 'origin', 'main'])
      await writeFile(join(local, 'a.txt'), 'local\n')
      await commitAll(local, 'local change')
      const remoteHead = (await git(origin, ['rev-parse', 'main'])).trim()

      // 拉取走一个不出声的「ssh」，推送本来走得通（本地路径）：取消之后不能接着推。
      await git(local, ['config', 'remote.origin.url', 'ssh://example.invalid/repo.git'])
      await git(local, ['config', 'remote.origin.pushurl', origin])
      const service = createGitService({ GIT_SSH_COMMAND: 'sleep 30 #' })
      const running = service.performRemoteAction(local, 'sync', { operationId: 'sync-1' })
      const settled = assert.rejects(running, isAppError('CANCELLED', /已取消/))
      await delay(300)
      assert.equal(service.cancelRemoteAction('sync-1'), true)
      await settled
      assert.equal((await git(origin, ['rev-parse', 'main'])).trim(), remoteHead)
    })
  })

  void test('progress lines do not crowd the real error out of the message', async () => {
    await withSshRemote(async (root) => {
      // 进度在终端里是原地刷新的一长串（`\r`），加起来远超说明里留给 git 原话的那 500 个字。
      const progress = Array.from(
        { length: 60 },
        (_, index) => `remote: Counting objects:  ${index}%% (${index}/60)\\r`
      ).join('')
      const service = createGitService({
        GIT_SSH_COMMAND: `sh -c 'printf "${progress}remote: Counting objects: 100%% (60/60), done.\\n" >&2; echo "fatal: the remote end hung up in an unusual way" >&2; exit 1' --`,
      })
      await assert.rejects(service.performRemoteAction(root, 'fetch'), (error: unknown) => {
        const message = (error as Error).message
        assert.match(message, /the remote end hung up in an unusual way/)
        assert.doesNotMatch(message, /Counting objects/)
        return true
      })
    })
  })
})

void describe('Workbench Git remote actions: what the interface tracks', () => {
  void test('one running remote action per project, visible to every control and cancellable', () => {
    const seen: Array<string | null> = []
    const unsubscribe = subscribeWorkbenchGitRemoteOperations(() => {
      const operation = readWorkbenchGitRemoteOperation('/project')
      seen.push(operation ? `${operation.action}${operation.cancelling ? ':cancelling' : ''}` : null)
    })

    assert.equal(readWorkbenchGitRemoteOperation('/project'), null)
    const operation = beginWorkbenchGitRemoteOperation('/project', 'pull')
    assert.ok(operation)
    assert.match(operation.id, /\S{8,}/)
    // 同一个项目同一时刻只跑一个远端操作；别的项目不受影响。
    assert.equal(beginWorkbenchGitRemoteOperation('/project', 'upload'), null)
    const other = beginWorkbenchGitRemoteOperation('/other', 'fetch')
    assert.ok(other)
    assert.notEqual(other.id, operation.id)

    markWorkbenchGitRemoteOperationCancelling(operation.id)
    assert.equal(readWorkbenchGitRemoteOperation('/project')?.cancelling, true)
    endWorkbenchGitRemoteOperation(operation.id)
    endWorkbenchGitRemoteOperation(other.id)
    assert.equal(readWorkbenchGitRemoteOperation('/project'), null)
    assert.deepEqual(seen, ['pull', 'pull', 'pull:cancelling', null, null])
    unsubscribe()

    assert.ok(beginWorkbenchGitRemoteOperation('/project', 'fetch'))
    assert.equal(seen.length, 5, 'no notifications after unsubscribing')
    endWorkbenchGitRemoteOperation(readWorkbenchGitRemoteOperation('/project')?.id ?? '')
  })

  void test('every control runs remote actions through the shared runner and offers cancel', () => {
    const hook = readSource('src/renderer/src/hooks/useWorkbenchGitRemoteAction.ts')
    const sync = readSource('src/renderer/src/components/git/WorkbenchGitSyncControl.tsx')
    const commitPanel = readSource('src/renderer/src/components/git/WorkbenchCommitPanel.tsx')
    const branchMenu = readSource('src/renderer/src/components/git/WorkbenchGitCommitControl.tsx')

    assert.match(hook, /performWorkspaceGitAction\(workspaceRoot, action, \{[\s\S]*?operationId: operation\.id/u)
    assert.match(hook, /cancelWorkspaceGitAction\(operation\.id\)/u)
    for (const source of [sync, commitPanel, branchMenu]) {
      assert.match(source, /useWorkbenchGitRemoteAction\(workspaceRoot\)/u)
      assert.doesNotMatch(source, /performWorkspaceGitAction\(/u)
    }
    // 顶栏的同步按钮、提交面板的推送按钮：操作进行中换成取消。
    assert.match(sync, /remoteAction\.cancel\(\)/u)
    assert.match(commitPanel, /remoteAction\.cancel\(\)/u)
    for (const key of [
      'workbench.gitCancelRemoteAction',
      'workbench.gitRemoteActionCancelling',
      'workbench.gitRemoteActionCancelledTitle',
      'workbench.gitRemoteActionBusy',
    ]) {
      const zh = translateWorkbenchAppMessage('zh-CN', key)
      const en = translateWorkbenchAppMessage('en-US', key)
      assert.notEqual(en, key, `en-US is missing ${key}`)
      assert.notEqual(zh, en, `zh-CN is missing ${key}`)
    }
  })
})
