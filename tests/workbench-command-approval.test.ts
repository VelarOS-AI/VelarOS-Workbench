import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, test } from 'bun:test'

import type { PermissionConfirmationMode, ToolConfirmationDecisionOptions } from '@velaros-ai/agent/protocol'
import { createTaskApprovalPort } from '@velaros-ai/agent/tool-contract'
import type { ProjectKernel } from '@velaros-ai/project/runtime'

import { WorkbenchAgentUiToolSpecs } from '../src/main/agent/WorkbenchAgentUiTools'
import { shouldAutoApproveWorkbenchToolConfirmation } from '../src/main/agent/WorkbenchToolConfirmationPolicy'
import { CommandHelper } from '../src/main/workspace/CommandHelper'
import { CommandRunner } from '../src/main/workspace/CommandRunner'
import { PathResolver } from '../src/main/workspace/PathResolver'
import { ProjectCapabilityProvider } from '../src/main/workspace/ProjectCapabilityProvider'
import type { WorkbenchAgentUiCommand } from '../src/shared/workbenchAgentUi'

/**
 * 命令审批的端到端体验：普通命令零打扰，危险命令问一次、批准就真的执行。
 *
 * 审批端口用的是生产里同一套装配——任务审批端口（createTaskApprovalPort）+ Workbench 权限策略，
 * 只把「弹卡问人」换成记账的假委托。这样断言的是用户真实会看到几张卡，而不是工具传了什么参数。
 */

interface Prompt {
  message: string
  options?: ToolConfirmationDecisionOptions
}

function createApprovalHarness(mode: PermissionConfirmationMode, answer: boolean) {
  const prompts: Prompt[] = []
  const decisions = new Map<string, boolean>()
  const port = createTaskApprovalPort(
    {
      awaitConfirmation: async () => undefined,
      awaitConfirmationDecision: async (message, _signal, options) => {
        prompts.push({ message, options })
        return { approved: answer, message: answer ? null : '先别动' }
      },
    },
    {
      recordTaskApproval: (key, approved) => void decisions.set(key, approved),
      getTaskApprovalDenial: (key) => (decisions.get(key) === false ? '本任务里拒绝过这条命令' : null),
    },
    {
      shouldAutoApprove: (options) =>
        shouldAutoApproveWorkbenchToolConfirmation({
          permissionConfirmationMode: mode,
          hasConfirmedRiskScope: (riskScope) => decisions.get(riskScope) === true,
          options,
        }),
    }
  )
  return { port, prompts }
}

async function withProject(run: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workbench-command-approval-')))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=Workbench', '-c', 'user.email=workbench@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd: root, encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

/** 一个有一次提交的仓库：a.txt、b.txt 已提交。 */
async function initRepository(root: string): Promise<void> {
  git(root, 'init', '-q')
  await writeFile(join(root, 'a.txt'), 'committed\n', 'utf8')
  await writeFile(join(root, 'b.txt'), 'tracked\n', 'utf8')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
}

async function createRunTool(root: string) {
  const provider = new ProjectCapabilityProvider({
    createKernel: async () => ({ root, providers: {} }) as unknown as ProjectKernel,
  })
  const project = await provider.resolveProject(root)
  const tool = project.tools.find((candidate) => candidate.name === 'project:run')
  assert.ok(tool)
  return {
    provider,
    run: async (command: string, harness: ReturnType<typeof createApprovalHarness>) =>
      (await tool.execute(
        { command, timeoutMs: 20_000 },
        { abortSignal: new AbortController().signal, approval: harness.port }
      )) as { success?: boolean; skipped?: boolean; approved?: boolean; message?: string },
  }
}

void describe('project:run command approval on the Workbench host', () => {
  void test('ordinary commands and index-only Git cleanups run without a single prompt', async () => {
    await withProject(async (root) => {
      await initRepository(root)
      await writeFile(join(root, 'a.txt'), 'edited\n', 'utf8')
      git(root, 'add', 'a.txt')
      const { provider, run } = await createRunTool(root)
      const harness = createApprovalHarness('standard-open', false)

      try {
        assert.equal((await run('mkdir out', harness)).success, true)
        assert.ok(await exists(join(root, 'out')))

        // 真机里被一刀切拒掉的两条：只动索引，工作区内容原样保留。
        assert.equal((await run('git reset -q HEAD -- a.txt', harness)).success, true)
        assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'edited\n')
        assert.equal((await run('git rm -q --cached b.txt', harness)).success, true)
        assert.ok(await exists(join(root, 'b.txt')))
        assert.match(git(root, 'status', '--porcelain'), /^D {2}b\.txt$/mu)

        assert.deepEqual(harness.prompts, [])
      } finally {
        await provider.dispose()
      }
    })
  }, 30_000)

  void test('a Workbench-only dangerous command asks every time and really runs once approved', async () => {
    await withProject(async (root) => {
      await initRepository(root)
      const { provider, run } = await createRunTool(root)
      const harness = createApprovalHarness('standard-open', true)

      try {
        for (const edit of ['first edit\n', 'second edit\n']) {
          await writeFile(join(root, 'a.txt'), edit, 'utf8')
          assert.equal((await run('git checkout -- a.txt', harness)).success, true)
          assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'committed\n')
        }

        // 同一条危险命令批准过也照样再问：用户点头的是那一次，不是这一类。
        assert.equal(harness.prompts.length, 2)
        for (const prompt of harness.prompts) {
          assert.match(prompt.message, /高风险命令：git checkout -- a\.txt/u)
          assert.equal(prompt.options?.requireManualApproval, true)
          assert.equal(prompt.options?.approvalRisk, 'high')
        }
      } finally {
        await provider.dispose()
      }
    })
  }, 30_000)

  void test('declining returns the skipped result instead of throwing and leaves the files alone', async () => {
    await withProject(async (root) => {
      await initRepository(root)
      await writeFile(join(root, 'a.txt'), 'unsaved work\n', 'utf8')
      const outside = await realpath(await mkdtemp(join(tmpdir(), 'workbench-command-outside-')))
      const { provider, run } = await createRunTool(root)
      const harness = createApprovalHarness('standard-open', false)

      try {
        const declined = await run('git checkout -- a.txt', harness)
        assert.equal(declined.approved, false)
        assert.equal(declined.skipped, true)
        assert.equal(declined.message, '先别动')
        assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'unsaved work\n')

        // 写到工作区外：先问，拒绝就不动。
        const outsideFile = join(outside, 'escaped.txt')
        assert.equal((await run(`touch ${outsideFile}`, harness)).skipped, true)
        assert.equal(await exists(outsideFile), false)
        assert.equal(harness.prompts.length, 2)
      } finally {
        await provider.dispose()
        await rm(outside, { recursive: true, force: true })
      }
    })
  }, 30_000)

  void test('a command the platform already asked about is not asked again and really runs', async () => {
    await withProject(async (root) => {
      await mkdir(join(root, 'build', 'nested'), { recursive: true })
      await writeFile(join(root, 'build', 'nested', 'out.js'), 'x', 'utf8')
      await mkdir(join(root, 'cache'), { recursive: true })
      await writeFile(join(root, 'cache', 'entry'), 'x', 'utf8')
      const { provider, run } = await createRunTool(root)
      const harness = createApprovalHarness('standard-open', true)

      try {
        // 平台判危险：平台问一次，批准后带 allowDangerous 进宿主——此前宿主照样拒绝，批准了也跑不了。
        assert.equal((await run('rm -rf build', harness)).success, true)
        assert.equal(await exists(join(root, 'build')), false)
        // 递归删除不带 -f：平台或宿主，谁判危险谁问，合起来只问一次。
        assert.equal((await run('rm -r cache', harness)).success, true)
        assert.equal(await exists(join(root, 'cache')), false)
        assert.equal(harness.prompts.length, 2)
      } finally {
        await provider.dispose()
      }
    })
  }, 30_000)

  void test('execution paths that asked nobody still stop dangerous commands', async () => {
    await withProject(async (root) => {
      await mkdir(join(root, 'cache'), { recursive: true })
      const runner = new CommandRunner(new PathResolver(), new CommandHelper())

      await assert.rejects(
        runner.runCommand({ projectRoot: root, command: 'rm -r cache' }),
        /需要用户确认/u
      )
      assert.ok(await exists(join(root, 'cache')))

      const approved = await runner.runCommand(
        { projectRoot: root, command: 'rm -r cache' },
        undefined,
        undefined,
        true
      )
      assert.equal(approved.success, true)
      assert.equal(await exists(join(root, 'cache')), false)
    })
  })
})

void describe('workbench:start_run approval across permission modes', () => {
  async function promptsFor(mode: PermissionConfirmationMode, commands: readonly string[]) {
    const startRun = WorkbenchAgentUiToolSpecs.find((tool) => tool.name === 'workbench:start_run')
    assert.ok(startRun)
    const harness = createApprovalHarness(mode, true)
    const started: string[] = []
    const ui = {
      request: async (command: WorkbenchAgentUiCommand) => {
        if (command.type === 'start-run') started.push(command.command)
        return { sessionId: 'run-1' }
      },
    }
    for (const command of commands) {
      await startRun.execute(
        { command },
        {
          resourceId: '/workspace/demo',
          abortSignal: new AbortController().signal,
          approval: harness.port,
          workbenchUi: ui,
        } as never
      )
    }
    return { prompted: harness.prompts.map((prompt) => prompt.options?.operation?.label), started }
  }

  void test('standard mode starts ordinary commands silently and asks before each dangerous one', async () => {
    const { prompted, started } = await promptsFor('standard-open', [
      'git status',
      'npm run dev',
      'npm install',
      'git reset --hard',
      'git reset --hard',
    ])
    assert.deepEqual(prompted, ['git reset --hard', 'git reset --hard'])
    assert.deepEqual(started, ['git status', 'npm run dev', 'npm install', 'git reset --hard', 'git reset --hard'])
  })

  void test('ask-every-time mode also asks before ordinary commands that may change the project', async () => {
    const { prompted } = await promptsFor('ask-every-time', ['git status', 'npm run dev', 'git reset --hard'])
    assert.deepEqual(prompted, ['npm run dev', 'git reset --hard'])
  })

  void test('full-access mode runs ordinary commands but still asks before dangerous ones', async () => {
    const { prompted, started } = await promptsFor('never-ask', ['npm run dev', 'npm install', 'git reset --hard'])
    assert.deepEqual(prompted, ['git reset --hard'])
    assert.deepEqual(started, ['npm run dev', 'npm install', 'git reset --hard'])
  })
})
