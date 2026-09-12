import assert from 'node:assert/strict'
import { resolve } from 'node:path'

import { describe, test } from 'bun:test'

import { analyzeWorkbenchCommandExecution } from '../src/main/workspace/CommandExecutionPolicy'

/**
 * 锁住命令安全门的行为，而不是它的实现。
 *
 * 通用判定的权威源是 `@velaros-ai/project/execution`；本仓只叠加「IDE 工作区完整性」一层。
 * 这里分三组断言：平台层不能因归并而丢、补充层必须真的生效、日常开发命令不许误伤。
 * 三组任一破了都说明安全门漂了——这正是当初 1225 行本地分叉与权威源悄悄发散的原因。
 * 「危险」的意思是执行前先问用户（批准就照常跑），所以误伤同样是缺陷：每一条都是一次无谓的打扰。
 */

const projectRoot = resolve('/workspace/demo')

/** 平台权威源负责的破坏性命令；归并后必须原样保留。 */
const platformDangerous = [
  'rm -rf /',
  'rm -r -f /tmp/x',
  'sudo apt install foo',
  'mkfs.ext4 /dev/sda1',
  'dd if=/dev/zero of=/dev/sda',
  'shutdown -h now',
  'kill -9 -1',
  'chown -R me /srv',
]

/** 平台放行、但 Workbench 作为 IDE 宿主要先问用户的命令。 */
const workbenchDangerous = [
  // 递归删除目录:带不带 -f 目录里的内容都会一起没
  'rm -r node_modules/.cache',
  'rm -R dist',
  'rm --recursive build',
  '/bin/rm -r build',
  // 丢工作区改动 / 切换分支 / 改写 HEAD 的 Git 调用
  'git checkout main',
  'git checkout -- src/a.ts',
  'git checkout -b feature',
  'git reset --hard',
  'git reset --keep HEAD~1',
  'git reset --merge',
  'git -C packages/app reset --hard',
  'git restore src/a.ts',
  'git restore --staged --worktree src/a.ts',
  'git restore -SW src/a.ts',
  'git rm -f src/a.ts',
  'git clean -fd',
  'git pull origin main',
  'git merge dev',
  'git rebase main',
  'git revert HEAD',
  'git switch feature',
  'git push --force',
  'git push -f origin main',
  'git push --force-with-lease',
  'git push origin +main',
  'git stash drop',
  'git stash clear',
  'npm run build && git reset --hard',
  'gh pr checkout 12',
  // 全局可写授权(平台只覆盖 chmod -R)
  'chmod 777 build.sh',
  'chmod a+w build.sh',
  // 写到工作区外
  'cp /etc/hosts .',
  'mv src /usr/local/lib',
  'touch ~/notes.txt',
  `mkdir ${resolve(projectRoot, '..', 'sibling')}`,
  // 平台未覆盖的关机/磁盘形态
  'halt',
  'diskutil eraseDisk JHFS+ X disk2',
  'Clear-Disk -Number 1',
]

/** 日常开发命令:一条都不许被拦。 */
const mustStayAllowed = [
  'ls -la',
  'git status',
  'git log --oneline -5',
  'git diff',
  'git add -A',
  'git commit -m "wip"',
  'git push',
  'git push origin main',
  // 只动索引或只挪分支指针、工作区文件不动的 Git 形态(真机里被一刀切拒掉的正是这类)
  'git reset',
  'git reset -q HEAD -- src/a.ts tmp/out.log',
  'git reset HEAD~1',
  'git reset --soft HEAD~1',
  'git restore --staged src/a.ts',
  'git restore -S src/a.ts',
  'git restore --staged --source=HEAD~1 src/a.ts',
  'git rm --cached tmp.log',
  'git rm -r --cached dist',
  'git rm src/a.ts',
  // 叫 -f 的文件不是 --force
  'git rm -- -f',
  'git clean -n',
  'git clean -nd',
  'git stash',
  'git stash pop',
  'npm run build',
  'npm run dev',
  'bun test',
  'cat package.json',
  'grep -rn foo src/',
  'mkdir dist',
  'rm -f build.log',
  'rm notes.txt',
  // 工作区内的绝对路径不算越界
  `mkdir -p ${resolve(projectRoot, 'src', 'components')}`,
  `cp README.md ${resolve(projectRoot, 'docs', 'README.md')}`,
  // 命令位置守卫:文本里出现危险片段不等于真的执行它
  'echo chmod 777',
  'echo git reset --hard',
]

void describe('Workbench command execution policy', () => {
  void test('keeps every destructive command the platform source already flags', () => {
    for (const command of platformDangerous) {
      const plan = analyzeWorkbenchCommandExecution(command, projectRoot)
      assert.equal(plan.isDangerous, true, `平台层应判危险: ${command}`)
      assert.ok(plan.dangerousReason, `危险命令必须带理由: ${command}`)
    }
  })

  void test('adds the IDE workspace-integrity rules the platform source does not cover', () => {
    for (const command of workbenchDangerous) {
      const plan = analyzeWorkbenchCommandExecution(command, projectRoot)
      assert.equal(plan.isDangerous, true, `补充层应判危险: ${command}`)
      assert.ok(plan.dangerousReason, `危险命令必须带理由: ${command}`)
      assert.equal(plan.shouldRequestConfirmation, true, `危险命令必须要求确认: ${command}`)
    }
  })

  void test('does not flag ordinary development commands', () => {
    for (const command of mustStayAllowed) {
      const plan = analyzeWorkbenchCommandExecution(command, projectRoot)
      assert.equal(plan.isDangerous, false, `不应判危险: ${command}（${plan.dangerousReason}）`)
    }
  })

  void test('explains the danger from the workspace point of view', () => {
    assert.match(
      analyzeWorkbenchCommandExecution('git reset --hard', projectRoot).dangerousReason ?? '',
      /未提交的改动/u
    )
    assert.match(
      analyzeWorkbenchCommandExecution('rm -r dist', projectRoot).dangerousReason ?? '',
      /递归删除/u
    )
    // 越界的理由点名是哪个路径，用户在确认卡上一眼能看出要动项目外的什么。
    assert.match(
      analyzeWorkbenchCommandExecution('mv src /usr/local/lib', projectRoot).dangerousReason ?? '',
      /\/usr\/local\/lib/u
    )
  })

  void test('leaves the platform verdict untouched when it already fired', () => {
    // 平台已判危险时补充层不得覆盖它的理由——两层各自的判据要能分辨。
    const plan = analyzeWorkbenchCommandExecution('sudo rm -rf /', projectRoot)
    assert.equal(plan.isDangerous, true)
    assert.ok(plan.dangerousReason?.includes('删除数据') || plan.dangerousReason?.includes('提升权限'))
  })
})
