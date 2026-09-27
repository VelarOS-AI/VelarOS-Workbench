import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, test } from 'bun:test'

import { AppError } from '@velaros-ai/core/error'

import { WorkbenchGitService } from '../src/main/workspace/git/WorkbenchGitService'
import { parseWorkbenchGitCommitDiff } from '../src/renderer/src/models/git/changesPanel.model'
import type { SystemWorkspaceGitSummary } from '../src/shared/contracts'

const execFileAsync = promisify(execFile)

/** 测试不受开发机上全局 git 配置影响（签名提交、别的默认分支名……）。 */
const HermeticEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  LC_ALL: 'C',
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: root, env: HermeticEnvironment })
  return stdout
}

function createService(
  environment: NodeJS.ProcessEnv = {},
  remoteActionTimeoutMs?: number
): WorkbenchGitService {
  return new WorkbenchGitService({
    environment: async () => ({ ...HermeticEnvironment, ...environment }),
    remoteActionTimeoutMs,
  })
}

async function initRepository(root: string): Promise<void> {
  await git(root, ['init', '-q', '-b', 'main'])
  await git(root, ['config', 'user.name', 't'])
  await git(root, ['config', 'user.email', 't@t'])
}

async function withTempDirectory(run: (base: string) => Promise<void>): Promise<void> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'workbench-git-service-')))
  try {
    await run(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function withRepository(run: (root: string) => Promise<void>): Promise<void> {
  await withTempDirectory(async (root) => {
    await initRepository(root)
    await run(root)
  })
}

async function commitAll(root: string, message: string): Promise<void> {
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-q', '-m', message])
}

function entryCodes(summary: SystemWorkspaceGitSummary): string[] {
  return (summary.status?.entries ?? []).map(
    (entry) => `${entry.indexStatus}${entry.workTreeStatus} ${entry.path}`
  )
}

function isAppError(code: string, pattern: RegExp): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof AppError, String(error))
    assert.equal(error.code, code)
    assert.match(error.message, pattern)
    return true
  }
}

void describe('Workbench Git service', () => {
  void test('git and its hooks run in the injected login-shell environment', async () => {
    await withRepository(async (root) => {
      const output = join(root, '.git', 'hook-environment.txt')
      const hook = join(root, '.git', 'hooks', 'pre-commit')
      await writeFile(
        hook,
        '#!/bin/sh\nprintf "%s|%s" "$WORKBENCH_LOGIN_MARKER" "$GIT_TERMINAL_PROMPT" > "$WORKBENCH_HOOK_OUTPUT"\n'
      )
      await chmod(hook, 0o755)
      await writeFile(join(root, 'a.txt'), 'a\n')

      const service = createService({
        WORKBENCH_LOGIN_MARKER: 'login-shell',
        WORKBENCH_HOOK_OUTPUT: output,
      })
      await service.commit(root, 'en-US', 'with hook')
      assert.equal(await readFile(output, 'utf8'), 'login-shell|0')

      // 登录环境读不出来（应用正在退出）时退回应用自己的环境，照样能用。
      const fallback = new WorkbenchGitService({
        environment: () => Promise.reject(new Error('shell environment disposed')),
      })
      assert.equal((await fallback.getSummary(root)).repository, true)
    })
  })

  void test('user git config cannot change the output the service parses', async () => {
    await withRepository(async (root) => {
      await mkdir(join(root, 'docs'))
      await writeFile(join(root, 'docs', '说明.md'), '旧\n')
      await commitAll(root, 'base')
      for (const [key, value] of [
        ['diff.noprefix', 'true'],
        ['diff.mnemonicPrefix', 'true'],
        ['diff.external', 'false'],
        ['color.ui', 'always'],
        ['core.quotePath', 'true'],
      ])
        await git(root, ['config', key, value])
      await writeFile(join(root, 'docs', '说明.md'), '新\n')

      const service = createService()
      assert.deepEqual(entryCodes(await service.getSummary(root)), [' M docs/说明.md'])
      const working = await service.getDiff(root, { path: 'docs/说明.md' })
      assert.match(working.diff, /^diff --git a\/docs\/说明\.md b\/docs\/说明\.md$/m)
      assert.equal(working.diff.includes('\u001b['), false, 'diff 里不能夹着颜色控制符')

      const committed = await service.commit(root, 'en-US', 'edit')
      const shown = await service.getDiff(root, { commitSha: committed.commit.commitSha })
      assert.match(shown.diff, /^\+\+\+ b\/docs\/说明\.md$/m)
      assert.deepEqual(
        parseWorkbenchGitCommitDiff(shown.diff).map((file) => file.path),
        ['docs/说明.md']
      )
      assert.equal((await service.getLog(root)).commits[0]?.subject, 'edit')
    })
  })

  void test.skipIf(process.platform === 'win32')(
    'a fetch that hangs is stopped at the time limit with a clear error',
    async () => {
      await withRepository(async (root) => {
        await git(root, ['remote', 'add', 'origin', 'ssh://example.invalid/repo.git'])
        // ssh 一直不返回：模拟网络卡住。
        const service = createService({ GIT_SSH_COMMAND: 'sleep 30 #' }, 500)
        const startedAt = Date.now()
        await assert.rejects(
          service.performRemoteAction(root, 'fetch'),
          isAppError('TIMEOUT', /git fetch 超过 1 秒没有完成/)
        )
        assert.ok(Date.now() - startedAt < 10_000)
      })
    }
  )

  void test('an un-ignored dependency directory is listed as one entry instead of breaking the status', async () => {
    await withRepository(async (root) => {
      await writeFile(join(root, 'a.txt'), 'a\n')
      await commitAll(root, 'base')
      const packageDirectory = join(root, 'node_modules', 'pkg')
      await mkdir(packageDirectory, { recursive: true })
      await Promise.all(
        Array.from({ length: 5_001 }, (_, index) =>
          writeFile(join(packageDirectory, `file-${index}.js`), 'x\n')
        )
      )
      await writeFile(join(root, 'a.txt'), 'a\nb\n')

      const service = createService()
      const summary = await service.getSummary(root)
      assert.deepEqual(entryCodes(summary), [' M a.txt', '?? node_modules/'])
      assert.equal(summary.lineStats.changedFiles, 2)

      await service.performFileAction(root, 'node_modules/', 'discard')
      assert.equal(existsSync(join(root, 'node_modules')), false)
    })
  })
})
