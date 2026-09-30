import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { execa } from 'execa'

import { AppError } from '@velaros-ai/core/error'

import { WorkbenchGitService } from './WorkbenchGitService'

/**
 * 探针给 Git 服务一份固定的环境，与应用注入登录 shell 环境走同一个口子：结果不看这台机器的 shell 配置，
 * 也不受全局 git 配置影响（签名提交、别的默认分支名、别名……）。
 */
const ProbeGitEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
}

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
  const canonicalProjectRoot = await realpath(projectRoot)
  const service = new WorkbenchGitService({ environment: async () => ProbeGitEnvironment })
  try {
    const empty = await service.getSummary(projectRoot)
    check(!empty.repository, '非 Git 目录应返回 repository=false')
    await equalRootIdentity(
      empty.rootPath,
      canonicalProjectRoot,
      '摘要 rootPath 应 canonical'
    )

    const initialized = await service.initialize(projectRoot)
    check(initialized.summary.repository, '初始化后应识别 Git 仓库')
    await configureIdentity(projectRoot)
    const initial = await service.getSummary(projectRoot)
    check(!!initial.status?.branch, '初始仓库应解析 unborn branch')
    check(initial.status?.isClean, '初始仓库应 clean')

    const filePath = join(projectRoot, 'alpha file.txt')
    writeFileSync(filePath, 'alpha\nbeta\n')
    const nestedPath = join(projectRoot, 'nested')
    mkdirSync(nestedPath)
    writeFileSync(join(nestedPath, 'one.txt'), 'one\n')
    writeFileSync(join(nestedPath, 'two.txt'), 'two\n')
    const expandedUntracked = await service.getSummary(projectRoot)
    equal(expandedUntracked.status?.changedFiles, 3, '未跟踪目录应展开为真实文件计数')
    check(
      expandedUntracked.status?.entries.every((entry) => !entry.path.endsWith('/')),
      '未跟踪目录本身不得作为变更项'
    )
    rmSync(nestedPath, { force: true, recursive: true })
    const untracked = await service.getSummary(projectRoot)
    equal(untracked.status?.untrackedFiles, 1, '含空格路径应解析为一个未跟踪文件')
    equal(untracked.status?.entries[0]?.path, 'alpha file.txt', '状态路径不应保留 Git 引号')
    equal(untracked.lineStats.additions, 2, '未跟踪文本应计入新增行')

    const staged = await service.performFileAction(projectRoot, ['alpha file.txt'], 'stage')
    equal(staged.fileAction.status.stagedFiles, 1, 'stage 应进入暂存区')
    const unstaged = await service.performFileAction(projectRoot, ['alpha file.txt'], 'unstage')
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
    equal(historical.content, 'alpha\nbeta\n', '应原样读取提交时文件内容（含末尾换行）')

    writeFileSync(filePath, 'alpha\nbeta\ngamma\n')
    const diff = await service.getDiff(projectRoot, { path: 'alpha file.txt' })
    check(diff.diff.includes('+gamma'), '工作区 diff 应包含新增行')
    equal(diff.scope, 'working', '工作区 diff scope')
    const lineStats = await service.getLineStats(projectRoot)
    equal(lineStats.lineStats.additions, 1, '已跟踪文件修改应计行数')
    equal(lineStats.branch, initial.status?.branch ?? null, '轻量快照应返回当前分支')

    // 贮藏：改动收起来、列得出、按对象名取得回。
    const stashed = await service.stash(projectRoot, { message: 'probe stash' })
    check(stashed.summary.status?.isClean, '贮藏后工作区应 clean')
    equal((await service.listStashes(projectRoot)).stashes[0]?.message, 'probe stash', '贮藏应列得出')
    const popped = await service.performStashAction(projectRoot, stashed.stash.sha, 'pop')
    equal(popped.summary.status?.changedFiles, 1, '弹出贮藏应取回改动')
    equal(popped.stashes.length, 0, '弹出后这条贮藏应删除')

    const feature = await service.createBranch(projectRoot, 'feature/probe')
    equal(feature.branch, 'feature/probe', '创建分支结果')
    // 没提交的改动不预先拦：两个分支指向同一个提交，git 把改动原样带过去。
    const switched = await service.switchBranch(projectRoot, 'feature/probe')
    equal(switched.branch, 'feature/probe', '改动不冲突时应照常切分支')
    equal(switched.previousBranch, initial.status?.branch ?? null, '切分支应返回来源分支')
    equal(switched.summary.status?.changedFiles, 1, '切分支应把没提交的改动带过去')
    await service.performFileAction(projectRoot, ['alpha file.txt'], 'discard')
    check((await service.getSummary(projectRoot)).status?.isClean, '丢弃改动后应 clean')

    await execa('git', ['mv', 'alpha file.txt', 'renamed file.txt'], {
      cwd: projectRoot,
      env: ProbeGitEnvironment,
    })
    const renamed = await service.getSummary(projectRoot)
    equal(renamed.status?.entries[0]?.path, 'renamed file.txt', 'rename 目标路径')
    equal(renamed.status?.entries[0]?.originalPath, 'alpha file.txt', 'rename 来源路径')
    await service.performFileAction(projectRoot, ['renamed file.txt'], 'discard')
    check((await service.getSummary(projectRoot)).status?.isClean, '丢弃 rename 应完整恢复')

    // 分离的 HEAD：状态说清停在哪个提交上，能从它切回分支。
    await execa('git', ['checkout', '--quiet', '--detach'], {
      cwd: projectRoot,
      env: ProbeGitEnvironment,
    })
    const detached = await service.getSummary(projectRoot)
    equal(detached.status?.branch ?? null, null, '分离的 HEAD 上没有当前分支')
    equal(
      detached.status?.detachedHead?.sha,
      committed.commit.commitSha,
      '状态应说明 HEAD 停在哪个提交'
    )
    const reattached = await service.switchBranch(projectRoot, 'feature/probe')
    equal(reattached.summary.status?.detachedHead ?? null, null, '切回分支后不再是分离的 HEAD')

    await expectCode(
      'PERMISSION',
      () => service.performFileAction(projectRoot, ['../escape.txt'], 'stage'),
      'Git pathspec 不得越出项目根'
    )
    await expectCode(
      'VALIDATION',
      () => service.getFileAtCommit(projectRoot, '--help', 'alpha file.txt'),
      'Git revision 不得解释为参数'
    )

    if (process.platform !== 'win32') await probeStuckRemote(projectRoot)

    const second = await service.initialize(secondRoot)
    check(second.summary.repository, '第二个 root 应独立初始化')
    equal(second.summary.status?.changedFiles, 0, '新 root 不得继承前一仓库状态')
    await equalRootIdentity(
      (await service.getSummary(projectRoot)).rootPath,
      canonicalProjectRoot,
      '服务不得缓存串根'
    )
  } finally {
    await removeProbeDirectory(tempRoot)
  }
}

/**
 * 连不上的远端（`ssh` 换成一个一直不返回、不出声的命令）：太久没动静会自己停，跑着的时候能取消。
 * 结束的是整个进程组，探针不会留下那条 `sleep`。
 */
async function probeStuckRemote(projectRoot: string): Promise<void> {
  await execa('git', ['remote', 'add', 'origin', 'ssh://example.invalid/repo.git'], {
    cwd: projectRoot,
    env: ProbeGitEnvironment,
  })
  const stuck = new WorkbenchGitService({
    environment: async () => ({ ...ProbeGitEnvironment, GIT_SSH_COMMAND: 'sleep 30 #' }),
    remoteInactivityTimeoutMs: 1_000,
  })
  await expectCode(
    'TIMEOUT',
    () => stuck.performRemoteAction(projectRoot, 'fetch'),
    '远端命令太久没动静应自己停下'
  )

  const patient = new WorkbenchGitService({
    environment: async () => ({ ...ProbeGitEnvironment, GIT_SSH_COMMAND: 'sleep 30 #' }),
  })
  const running = patient.performRemoteAction(projectRoot, 'fetch', {
    operationId: 'probe-cancel',
  })
  setTimeout(() => patient.cancelRemoteAction('probe-cancel'), 300)
  await expectCode('CANCELLED', () => running, '取消应结束正在跑的远端命令')
}

async function equalRootIdentity(
  actual: string | null,
  expected: string,
  message: string
): Promise<void> {
  check(
    typeof actual === 'string' && actual.length > 0 && isAbsolute(actual),
    `${message}: rootPath 应为非空绝对路径`
  )
  if (process.platform !== 'win32') {
    equal(actual, expected, message)
    return
  }
  const [actualStat, expectedStat] = await Promise.all([stat(actual), stat(expected)])
  equal(
    `${actualStat.dev}:${actualStat.ino}`,
    `${expectedStat.dev}:${expectedStat.ino}`,
    `${message}: Windows 路径应指向同一目录`
  )
}

async function removeProbeDirectory(rootPath: string): Promise<void> {
  const retryableCodes = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM'])
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(rootPath, { force: true, recursive: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!code || !retryableCodes.has(code) || attempt >= 10) throw error
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min((attempt + 1) * 100, 500))
      )
    }
  }
}

async function configureIdentity(rootPath: string): Promise<void> {
  await execa('git', ['config', 'user.email', 'workbench-probe@velaros.local'], {
    cwd: rootPath,
    env: ProbeGitEnvironment,
  })
  await execa('git', ['config', 'user.name', 'VelarOS Workbench Probe'], {
    cwd: rootPath,
    env: ProbeGitEnvironment,
  })
}

await runGitProbe()
// Windows 上没有进程组可结束，不跑「卡住的远端」那一段（4 条断言）。
const expectedAssertions = process.platform === 'win32' ? 48 : 52
assert.equal(assertionCount, expectedAssertions, 'Git 探针断言数变化必须显式复核')
console.info(`workbench git probe: ${assertionCount}/${expectedAssertions} assertions passed`)
