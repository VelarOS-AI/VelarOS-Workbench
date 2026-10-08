import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { AppError } from '@velaros-ai/core/error'

import { WorkbenchGitService } from '../../src/main/workspace/git/WorkbenchGitService'
import { type SystemWorkspaceGitSummary } from '../../src/shared/contracts/system'

const execFileAsync = promisify(execFile)

/** 测试不受开发机上全局 git 配置影响（签名提交、别的默认分支名……）。 */
export const HermeticGitEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  LC_ALL: 'C',
}

export async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: root, env: HermeticGitEnvironment })
  return stdout
}

export function createGitService(
  environment: NodeJS.ProcessEnv = {},
  remoteInactivityTimeoutMs?: number
): WorkbenchGitService {
  return new WorkbenchGitService({
    environment: async () => ({ ...HermeticGitEnvironment, ...environment }),
    remoteInactivityTimeoutMs,
  })
}

export async function initRepository(root: string): Promise<void> {
  await git(root, ['init', '-q', '-b', 'main'])
  await git(root, ['config', 'user.name', 't'])
  await git(root, ['config', 'user.email', 't@t'])
}

export async function withTempDirectory(run: (base: string) => Promise<void>): Promise<void> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'workbench-git-')))
  try {
    await run(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

export async function withRepository(run: (root: string) => Promise<void>): Promise<void> {
  await withTempDirectory(async (root) => {
    await initRepository(root)
    await run(root)
  })
}

export async function commitAll(root: string, message: string): Promise<void> {
  await git(root, ['add', '-A'])
  await git(root, ['commit', '-q', '-m', message])
}

/** 状态里每个文件的两位状态码加路径，如 `MM src/a.ts`。 */
export function entryCodes(summary: SystemWorkspaceGitSummary): string[] {
  return (summary.status?.entries ?? []).map(
    (entry) => `${entry.indexStatus}${entry.workTreeStatus} ${entry.path}`
  )
}

export async function porcelain(root: string): Promise<string[]> {
  return (await git(root, ['status', '--porcelain=v1'])).split('\n').filter(Boolean)
}

export async function filesInCommit(root: string, revision: string): Promise<string[]> {
  return (
    await git(root, ['-c', 'core.quotePath=false', 'show', '--name-only', '--format=', revision])
  )
    .split('\n')
    .filter(Boolean)
}

export function isAppError(code: string, pattern: RegExp): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof AppError, String(error))
    assert.equal(error.code, code)
    assert.match(error.message, pattern)
    return true
  }
}
