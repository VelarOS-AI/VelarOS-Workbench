import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { execa } from 'execa'

import { AppError } from '@velaros-ai/core/error'

import { WorkbenchGitService } from './WorkbenchGitService'

let assertionCount = 0

function check(value: unknown, message: string): asserts value {
  assert.ok(value, message)
  assertionCount += 1
}

function equal<T>(actual: T, expected: T, message: string): void {
  assert.equal(actual, expected, message)
  assertionCount += 1
}

async function expectCode(
  code: string,
  run: () => Promise<unknown>,
  message: string
): Promise<void> {
  let observed: unknown
  try {
    await run()
  } catch (error) {
    observed = error
  }
  check(observed instanceof AppError, `${message}: 应抛 AppError`)
  equal((observed as AppError).code, code, message)
}

async function runGitProbe(): Promise<void> {
  const tempRoot = mkdtempSync(join(tmpdir(), 'velaros-workbench-git-'))
  const projectRoot = join(tempRoot, 'project')
  const secondRoot = join(tempRoot, 'second')
  mkdirSync(projectRoot)
  mkdirSync(secondRoot)
  const canonicalProjectRoot = realpathSync(projectRoot)
  const service = new WorkbenchGitService()
  try {
    const empty = await service.getSummary(projectRoot)
    check(!empty.repository, '非 Git 目录应返回 repository=false')
    equal(empty.rootPath, canonicalProjectRoot, '摘要 rootPath 应 canonical')

    const initialized = await service.initialize(projectRoot)
    check(initialized.summary.repository, '初始化后应识别 Git 仓库')
    await configureIdentity(projectRoot)
    const initial = await service.getSummary(projectRoot)
    check(!!initial.status?.branch, '初始仓库应解析 unborn branch')
    check(initial.status?.isClean, '初始仓库应 clean')

    const filePath = join(projectRoot, 'alpha file.txt')
    writeFileSync(filePath, 'alpha\nbeta\n')
    const untracked = await service.getSummary(projectRoot)
    equal(untracked.status?.untrackedFiles, 1, '含空格路径应解析为一个未跟踪文件')
    equal(untracked.status?.entries[0]?.path, 'alpha file.txt', '状态路径不应保留 Git 引号')
    equal(untracked.lineStats.additions, 2, '未跟踪文本应计入新增行')

    const staged = await service.performFileAction(projectRoot, 'alpha file.txt', 'stage')
    equal(staged.fileAction.status.stagedFiles, 1, 'stage 应进入暂存区')
    const unstaged = await service.performFileAction(projectRoot, 'alpha file.txt', 'unstage')
    equal(unstaged.fileAction.status.untrackedFiles, 1, 'unborn 仓库 unstage 应恢复未跟踪态')

    const draft = await service.generateCommitMessage(projectRoot, 'en-US', ['alpha file.txt'])
    equal(draft.message, 'Add alpha file.txt', '本地提交标题应稳定')
    const committed = await service.commit(
      projectRoot,
      'en-US',
      undefined,
      ['alpha file.txt']
    )
    check(/^[0-9a-f]{40}$/.test(committed.commit.commitSha), '提交应返回完整 SHA')
    equal(committed.commit.changedFiles, 1, '提交文件数')
    equal(committed.commit.lineStats.additions, 2, '提交行统计')
    check(committed.summary.status?.isClean, '提交后工作区应 clean')

    const log = await service.getLog(projectRoot)
    equal(log.commits.length, 1, '提交历史应返回一条')
    equal(log.commits[0]?.subject, 'Add alpha file.txt', '提交历史主题')
    const historical = await service.getFileAtCommit(
      projectRoot,
      committed.commit.commitSha,
      'alpha file.txt'
    )
    equal(historical.content, 'alpha\nbeta', '应读取提交时文件内容')

    writeFileSync(filePath, 'alpha\nbeta\ngamma\n')
    const diff = await service.getDiff(projectRoot, { path: 'alpha file.txt' })
    check(diff.diff.includes('+gamma'), '工作区 diff 应包含新增行')
    equal(diff.scope, 'working', '工作区 diff scope')
    const lineStats = await service.getLineStats(projectRoot)
    equal(lineStats.lineStats.additions, 1, '已跟踪文件修改应计行数')
    equal(lineStats.branch, initial.status?.branch ?? null, '轻量快照应返回当前分支')

    const feature = await service.createBranch(projectRoot, 'feature/probe')
    equal(feature.branch, 'feature/probe', '创建分支结果')
    await expectCode(
      'VALIDATION',
      () => service.switchBranch(projectRoot, 'feature/probe'),
      '脏工作区切分支必须拒绝'
    )
    await service.performFileAction(projectRoot, 'alpha file.txt', 'discard')
    const switched = await service.switchBranch(projectRoot, 'feature/probe')
    equal(switched.branch, 'feature/probe', 'clean 后应可切分支')
    equal(switched.previousBranch, initial.status?.branch ?? null, '切分支应返回来源分支')
    check(switched.summary.status?.isClean, '切分支后应 clean')

    await execa('git', ['mv', 'alpha file.txt', 'renamed file.txt'], {
      cwd: projectRoot,
    })
    const renamed = await service.getSummary(projectRoot)
    equal(renamed.status?.entries[0]?.path, 'renamed file.txt', 'rename 目标路径')
    equal(renamed.status?.entries[0]?.originalPath, 'alpha file.txt', 'rename 来源路径')
    await service.performFileAction(projectRoot, 'renamed file.txt', 'discard')
    check((await service.getSummary(projectRoot)).status?.isClean, '丢弃 rename 应完整恢复')

    await expectCode(
      'PERMISSION',
      () => service.performFileAction(projectRoot, '../escape.txt', 'stage'),
      'Git pathspec 不得越出项目根'
    )
    await expectCode(
      'VALIDATION',
      () => service.getFileAtCommit(projectRoot, '--help', 'alpha file.txt'),
      'Git revision 不得解释为参数'
    )

    const second = await service.initialize(secondRoot)
    check(second.summary.repository, '第二个 root 应独立初始化')
    equal(second.summary.status?.changedFiles, 0, '新 root 不得继承前一仓库状态')
    equal(
      (await service.getSummary(projectRoot)).rootPath,
      canonicalProjectRoot,
      '服务不得缓存串根'
    )
  } finally {
    rmSync(tempRoot, {
      force: true,
      recursive: true,
      maxRetries: 10,
      retryDelay: 100,
    })
  }
}

async function configureIdentity(rootPath: string): Promise<void> {
  await execa('git', ['config', 'user.email', 'workbench-probe@velaros.local'], {
    cwd: rootPath,
  })
  await execa('git', ['config', 'user.name', 'VelarOS Workbench Probe'], {
    cwd: rootPath,
  })
}

await runGitProbe()
assert.equal(assertionCount, 38, 'Git 探针断言数变化必须显式复核')
console.info(`workbench git probe: ${assertionCount}/38 assertions passed`)
