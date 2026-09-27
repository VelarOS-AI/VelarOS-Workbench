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

async function porcelain(root: string): Promise<string[]> {
  return (await git(root, ['status', '--porcelain=v1'])).split('\n').filter(Boolean)
}

async function filesInCommit(root: string, revision: string): Promise<string[]> {
  return (await git(root, ['-c', 'core.quotePath=false', 'show', '--name-only', '--format=', revision]))
    .split('\n')
    .filter(Boolean)
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
  void test('a project nested in a repository only sees, rolls back and commits its own files', async () => {
    await withRepository(async (repository) => {
      const project = join(repository, 'packages', 'app')
      await mkdir(join(project, 'src'), { recursive: true })
      await mkdir(join(repository, 'other'))
      await writeFile(join(project, 'src', 'a.ts'), 'a\n')
      await writeFile(join(project, 'src', 'b.ts'), 'b\n')
      await writeFile(join(repository, 'other', 'o.ts'), 'o\n')
      await writeFile(join(repository, 'root.ts'), 'root\n')
      await commitAll(repository, 'base')

      await writeFile(join(project, 'src', 'a.ts'), 'a\nchanged\n')
      await writeFile(join(project, 'src', 'b.ts'), 'b\nchanged\n')
      await writeFile(join(project, 'new.ts'), 'new\n')
      await writeFile(join(repository, 'other', 'o.ts'), 'o\nchanged\n')
      // 项目外面已经暂存的改动：「提交全部」也不能把它带走。
      await writeFile(join(repository, 'root.ts'), 'root\nstaged\n')
      await git(repository, ['add', 'root.ts'])

      const service = createService()
      const summary = await service.getSummary(project)
      assert.deepEqual(entryCodes(summary), [' M src/a.ts', ' M src/b.ts', '?? new.ts'])
      assert.equal(summary.lineStats.changedFiles, 3)
      assert.equal(summary.lineStats.additions, 3)

      const diff = await service.getDiff(project, { path: 'src/a.ts' })
      assert.match(diff.diff, /^\+\+\+ b\/src\/a\.ts$/m)
      assert.match(diff.diff, /^\+changed$/m)

      await service.performFileAction(project, 'src/b.ts', 'discard')
      assert.equal(await readFile(join(project, 'src', 'b.ts'), 'utf8'), 'b\n')

      const committed = await service.commit(project, 'en-US', 'project only')
      assert.equal(committed.commit.changedFiles, 2)
      assert.deepEqual(await filesInCommit(repository, 'HEAD'), [
        'packages/app/new.ts',
        'packages/app/src/a.ts',
      ])
      assert.deepEqual(await porcelain(repository), [' M other/o.ts', 'M  root.ts'])
      assert.equal(committed.summary.status?.isClean, true)
    })
  })

  void test('commits exactly the chosen files as they are in the working tree', async () => {
    await withRepository(async (root) => {
      await mkdir(join(root, 'app'))
      await writeFile(join(root, 'app', '[id].tsx'), 'one\n')
      await writeFile(join(root, 'app', 'i.tsx'), 'one\n')
      await writeFile(join(root, 'partly.ts'), 'head\n')
      await writeFile(join(root, 'other.ts'), 'head\n')
      await writeFile(join(root, 'gone.ts'), 'gone\n')
      await writeFile(join(root, 'removed.ts'), 'removed\n')
      await commitAll(root, 'base')

      await writeFile(join(root, 'app', '[id].tsx'), 'two\n')
      // `[id]` 当通配符时会匹配上 i.tsx：没选它，不能被顺带提交。
      await writeFile(join(root, 'app', 'i.tsx'), 'two\n')
      await writeFile(join(root, 'partly.ts'), 'staged\n')
      await git(root, ['add', 'partly.ts'])
      await writeFile(join(root, 'partly.ts'), 'working\n')
      await writeFile(join(root, 'other.ts'), 'staged\n')
      await git(root, ['add', 'other.ts'])
      // 已暂存的删除，和只在工作区里删掉、没暂存的删除。
      await git(root, ['rm', '-q', 'gone.ts'])
      await rm(join(root, 'removed.ts'))
      await writeFile(join(root, 'added.ts'), 'added\n')

      const service = createService()
      const committed = await service.commit(root, 'en-US', 'chosen', [
        'app/[id].tsx',
        'partly.ts',
        'gone.ts',
        'removed.ts',
        'added.ts',
      ])
      assert.equal(committed.commit.changedFiles, 5)
      assert.deepEqual(await filesInCommit(root, 'HEAD'), [
        'added.ts',
        'app/[id].tsx',
        'gone.ts',
        'partly.ts',
        'removed.ts',
      ])
      assert.equal(await git(root, ['show', 'HEAD:partly.ts']), 'working\n')
      // 没选的：暂存的仍是暂存，没暂存的仍没暂存。
      assert.deepEqual(await porcelain(root), [' M app/i.tsx', 'M  other.ts'])
    })
  })

  void test('rolls back only the file it names, even when the name looks like a wildcard', async () => {
    await withRepository(async (root) => {
      await writeFile(join(root, 'base.txt'), 'base\n')
      await commitAll(root, 'base')
      await writeFile(join(root, '[id].ts'), 'new\n')
      await writeFile(join(root, 'i.ts'), 'keep me\n')

      await createService().performFileAction(root, '[id].ts', 'discard')
      assert.equal(existsSync(join(root, '[id].ts')), false)
      assert.equal(await readFile(join(root, 'i.ts'), 'utf8'), 'keep me\n')
    })
  })

  void test('the diff of a partly staged file is what the commit will contain', async () => {
    await withRepository(async (root) => {
      await writeFile(join(root, 'a.txt'), 'head\n')
      await commitAll(root, 'base')
      await writeFile(join(root, 'a.txt'), 'staged\n')
      await git(root, ['add', 'a.txt'])
      await writeFile(join(root, 'a.txt'), 'working\n')

      const diff = await createService().getDiff(root, { path: 'a.txt' })
      assert.equal(diff.scope, 'working')
      assert.match(diff.diff, /^-head$/m)
      assert.match(diff.diff, /^\+working$/m)
      assert.doesNotMatch(diff.diff, /staged/)
    })
  })

  void test('before the first commit the diff and line counts start from an empty tree', async () => {
    await withRepository(async (root) => {
      await writeFile(join(root, 'a.txt'), 'one\n')
      await git(root, ['add', 'a.txt'])
      await writeFile(join(root, 'a.txt'), 'one\ntwo\n')

      const service = createService()
      const diff = await service.getDiff(root, { path: 'a.txt' })
      assert.match(diff.diff, /^new file mode/m)
      assert.match(diff.diff, /^\+one$/m)
      assert.match(diff.diff, /^\+two$/m)
      assert.equal((await service.getLineStats(root)).lineStats.additions, 2)
    })
  })

  void test('merge conflicts block the commit until each file is resolved, then the merge completes', async () => {
    await withRepository(async (root) => {
      await writeFile(join(root, 'both.txt'), 'base\n')
      await writeFile(join(root, 'clean.txt'), 'base\n')
      await commitAll(root, 'base')
      await git(root, ['switch', '-q', '-c', 'feature'])
      await writeFile(join(root, 'both.txt'), 'feature\n')
      await commitAll(root, 'feature')
      await git(root, ['switch', '-q', 'main'])
      await writeFile(join(root, 'both.txt'), 'main\n')
      await commitAll(root, 'main')
      await assert.rejects(git(root, ['merge', 'feature']))

      const service = createService()
      const summary = await service.getSummary(root)
      assert.deepEqual(entryCodes(summary), ['UU both.txt'])
      assert.equal(summary.status?.conflictedFiles, 1)
      assert.equal(summary.status?.stagedFiles, 0)
      // 冲突文件的差异：HEAD 那一版对照工作区里带冲突标记的那一版。
      const conflictDiff = await service.getDiff(root, { path: 'both.txt' })
      assert.match(conflictDiff.diff, /^\+<<<<<<< HEAD$/m)
      assert.match(conflictDiff.diff, /^\+feature$/m)

      await assert.rejects(
        service.commit(root, 'en-US', 'merge'),
        isAppError('VALIDATION', /“both\.txt”还有未解决的合并冲突/)
      )
      await assert.rejects(
        service.performFileAction(root, 'both.txt', 'discard'),
        isAppError('VALIDATION', /合并冲突，不能回滚/)
      )
      await assert.rejects(
        service.performFileAction(root, 'both.txt', 'resolve'),
        isAppError('VALIDATION', /还有冲突标记/)
      )
      await assert.rejects(
        service.performFileAction(root, 'clean.txt', 'resolve'),
        isAppError('VALIDATION', /没有待解决的合并冲突/)
      )

      await writeFile(join(root, 'both.txt'), 'resolved\n')
      const resolved = await service.performFileAction(root, 'both.txt', 'resolve')
      assert.equal(resolved.fileAction.status.conflictedFiles, 0)
      assert.deepEqual(entryCodes(resolved.summary), ['M  both.txt'])

      // 合并提交要收下全部改动：只提交一部分文件时拒绝，而不是让 git 报「不能部分提交」。
      await writeFile(join(root, 'clean.txt'), 'edited while merging\n')
      await assert.rejects(
        service.commit(root, 'en-US', undefined, ['clean.txt']),
        isAppError('VALIDATION', /正在合并/)
      )
      const merged = await service.commit(root, 'en-US')
      assert.equal(merged.commit.message, "Merge branch 'feature'")
      assert.equal((await git(root, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ').length, 3)
      assert.equal(await git(root, ['show', 'HEAD:clean.txt']), 'edited while merging\n')
      assert.equal(merged.summary.status?.isClean, true)
    })
  })

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
        ['diff.relative', 'true'],
        ['diff.external', 'false'],
        ['color.ui', 'always'],
        ['core.quotePath', 'true'],
      ])
        await git(root, ['config', key, value])
      await writeFile(join(root, 'docs', '说明.md'), '新\n')

      const service = createService()
      const project = join(root, 'docs')
      assert.deepEqual(entryCodes(await service.getSummary(project)), [' M 说明.md'])
      const working = await service.getDiff(project, { path: '说明.md' })
      assert.match(working.diff, /^diff --git a\/说明\.md b\/说明\.md$/m)
      assert.equal(working.diff.includes('\u001b['), false, 'diff 里不能夹着颜色控制符')

      const committed = await service.commit(project, 'en-US', 'edit')
      const shown = await service.getDiff(project, { commitSha: committed.commit.commitSha })
      assert.match(shown.diff, /^\+\+\+ b\/docs\/说明\.md$/m)
      assert.deepEqual(
        parseWorkbenchGitCommitDiff(shown.diff).map((file) => file.path),
        ['docs/说明.md']
      )
      assert.equal((await service.getLog(project)).commits[0]?.subject, 'edit')
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
