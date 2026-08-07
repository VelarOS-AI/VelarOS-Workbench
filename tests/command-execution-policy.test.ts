import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { analyzeWorkbenchCommandExecution } from '../src/main/workspace/CommandExecutionPolicy'

/**
 * 锁住命令安全门的行为，而不是它的实现。
 *
 * 通用判定的权威源是 `@velaros-ai/project/execution`；本仓只叠加「IDE 工作区完整性」一层。
 * 这里分三组断言：平台层不能因归并而丢、补充层必须真的生效、日常开发命令不许误伤。
 * 三组任一破了都说明安全门漂了——这正是当初 1225 行本地分叉与权威源悄悄发散的原因。
 */

/** 平台权威源负责的破坏性命令；归并后必须原样保留。 */
const platformDangerous = [
  'rm -rf /',
  'sudo apt install foo',
  'mkfs.ext4 /dev/sda1',
  'dd if=/dev/zero of=/dev/sda',
  'shutdown -h now',
  'kill -9 -1',
  'chown -R me /srv',
]

/** 平台放行、但 Workbench 作为 IDE 宿主必须拦的命令。 */
const workbenchDangerous = [
  // 平台正则要求 r/f 落在同一个 token,分开写会漏网
  'rm -r -f /tmp/x',
  // 改写 Git 工作区或 HEAD:会覆盖未保存缓冲区、把分支从用户脚下换掉
  'git checkout main',
  'git reset --hard',
  'git clean -fd',
  'git pull origin main',
  'git rebase main',
  'git switch feature',
  'git push --force',
  'git push -f origin main',
  'gh pr checkout 12',
  // 全局可写授权(平台只覆盖 chmod -R)
  'chmod 777 build.sh',
  'chmod a+w build.sh',
  // 工作区逃逸:写操作落在绝对路径上
  'cp /etc/hosts .',
  'mv src /usr/local/lib',
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
  'git push',
  'npm run build',
  'bun test',
  'cat package.json',
  'grep -rn foo src/',
  'mkdir dist',
  // 命令位置守卫:文本里出现 chmod 777 不等于真的执行它
  'echo chmod 777',
  // 只有 -r 没有 -f,不构成强制递归删除
  'rm -r node_modules/.cache',
]

void describe('Workbench command execution policy', () => {
  void test('keeps every destructive command the platform source already blocks', () => {
    for (const command of platformDangerous) {
      const plan = analyzeWorkbenchCommandExecution(command)
      assert.equal(plan.isDangerous, true, `平台层应判危险: ${command}`)
      assert.ok(plan.dangerousReason, `危险命令必须带理由: ${command}`)
    }
  })

  void test('adds the IDE workspace-integrity rules the platform source does not cover', () => {
    for (const command of workbenchDangerous) {
      const plan = analyzeWorkbenchCommandExecution(command)
      assert.equal(plan.isDangerous, true, `补充层应判危险: ${command}`)
      assert.ok(plan.dangerousReason, `危险命令必须带理由: ${command}`)
      assert.equal(plan.shouldRequestConfirmation, true, `危险命令必须要求确认: ${command}`)
    }
  })

  void test('does not flag ordinary development commands', () => {
    for (const command of mustStayAllowed) {
      const plan = analyzeWorkbenchCommandExecution(command)
      assert.equal(plan.isDangerous, false, `不应判危险: ${command}`)
    }
  })

  void test('leaves the platform verdict untouched when it already fired', () => {
    // 平台已判危险时补充层不得覆盖它的理由——两层各自的判据要能分辨。
    const plan = analyzeWorkbenchCommandExecution('sudo rm -rf /')
    assert.equal(plan.isDangerous, true)
    assert.ok(plan.dangerousReason?.includes('删除数据') || plan.dangerousReason?.includes('提升权限'))
  })
})
