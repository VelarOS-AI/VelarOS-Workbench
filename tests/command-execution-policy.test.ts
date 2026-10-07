import assert from 'node:assert/strict'
import { resolve } from 'node:path'

import { describe, test } from 'bun:test'

import { shellCommandPolicy } from '@velaros-ai/velaros/execution'

import { setWorkbenchMainLocale } from '../src/main/i18n/workbenchMainLocale'
import {
  analyzeWorkbenchCommandExecution,
  resolveWorkspaceIntegrityConfirmation,
} from '../src/main/workspace/CommandExecutionPolicy'

/**
 * 锁住命令安全门的行为，而不是它的实现。
 *
 * 通用判定的权威源是 `@velaros-ai/velaros/execution` 的 `shellCommandPolicy`；本仓只叠加「IDE 工作区完整性」一层。
 * 这里分三组断言：平台层不能因归并而丢、补充层必须真的生效、日常开发命令不许误伤。
 * 三组任一破了都说明安全门漂了——这正是当初 1225 行本地分叉与权威源悄悄发散的原因。
 * 「危险」的意思是执行前先问用户（批准就照常跑），所以误伤同样是缺陷：每一条都是一次无谓的打扰。
 */

const projectRoot = resolve('/workspace/demo')

/**
 * 平台权威源负责的破坏性命令；归并后必须原样保留。
 * 平台只收成片毁掉、找不回来的操作：提权（`sudo …`）本身已不算危险，`chown -R` 也不再由平台判，
 * 写到工作区外的那部分由补充层接住（见下方「写到工作区外」）。
 */
const platformDangerous = [
  'rm -rf /',
  'rm -r -f /tmp/x',
  'mkfs.ext4 /dev/sda1',
  'dd if=/dev/zero of=/dev/sda',
  'shutdown -h now',
  'kill -9 -1',
  'find . -name "*.log" -delete',
  'npx rimraf ./dist',
]

/** 平台放行、但 Workbench 作为 IDE 宿主要先问用户的命令。 */
const workbenchDangerous = [
  // 递归删除目录:带不带 -f 目录里的内容都会一起没
  'rm -r node_modules/.cache',
  'rm -R dist',
  'rm --recursive build',
  '/bin/rm -r build',
  'find . -name cache -type d | xargs rm -r',
  'npm run build\nrm -r dist',
  'find . -name cache -exec rm -r {} +',
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
  // 同一段命令文本里的另一条命令：换行、单个 &、shell 关键字、包装命令、反引号都不能让 Git 调用漏网
  'echo hi\ngit reset --hard',
  'git status\ngit checkout -- .',
  'git status\r\ngit checkout -- .',
  'sleep 1 & git reset --hard',
  'timeout 60 git pull',
  'nice -n 5 git reset --hard',
  'nohup git pull',
  'for f in a b; do git checkout -- $f; done',
  'if git pull; then echo ok; fi',
  '{ git reset --hard; }',
  '! git checkout main',
  'git ls-files -z | xargs -0 git checkout --',
  'echo `git checkout main`',
  'git reset \\\n  --hard',
  // here-string 与 heredoc 那一行的其余部分都还是命令
  'cat <<< x; git reset --hard',
  'cat <<EOF && git checkout -- .\nhello\nEOF',
  'cat <<EOF > notes.md\nhello\nEOF\ngit checkout main',
  // 解释器把引号里的脚本当命令跑
  'bash -lc "git reset --hard"',
  'sudo -u me sh -c \'git checkout -- .\'',
  'pwsh -NoProfile -Command git reset --hard',
  'cmd /c "git checkout main"',
  'gh pr checkout 12',
  // 全局可写授权(平台只覆盖 chmod -R)
  'chmod 777 build.sh',
  'chmod a+w build.sh',
  // 写到工作区外（复制类只看目的地；移动会删掉源，两头都算）
  'mv src /usr/local/lib',
  `mv ${resolve(projectRoot, '..', 'shared', 'a.txt')} ./a.txt`,
  'cp a.txt ~/Desktop/a.txt',
  'cp -t /usr/local/lib a.txt',
  'cp --target-directory=/usr/local/lib a.txt',
  'Copy-Item -Path a.txt -Destination /usr/local/lib',
  'touch ~/notes.txt',
  `mkdir ${resolve(projectRoot, '..', 'sibling')}`,
  'timeout 60 cp a.txt /usr/local/lib',
  'xargs -I {} cp {} /usr/local/lib',
  'find . -name "*.ts" -exec cp {} /usr/local/lib \\;',
  'bash -c "touch /usr/local/lib/x"',
  'chown -R me /srv',
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
  // 从项目外读进来不算写到外面：复制类只看目的地
  'cp /etc/hosts .',
  `cp ${resolve(projectRoot, '..', 'shared', 'template.json')} ./config.json`,
  'Copy-Item -Path /etc/hosts -Destination hosts.txt',
  // 重定向的目标不是命令实参；日志写到临时目录不算改动项目外的文件
  'cp a.txt b.txt 2> /tmp/err.log',
  'npm test 2>&1 | tee build.log',
  // cmd.exe 原生命令的 /x 是开关，不是绝对路径
  'xcopy /E /I src dst',
  // 命令位置守卫:文本里出现危险片段不等于真的执行它（Git 除外，见下方单测）
  'echo chmod 777',
  'grep -rn cp /usr/include',
  // 引号里的提交说明不是命令。heredoc 正文里的丢改动 Git 写法由平台保守判定、会问一次，不在此列。
  'git commit -m "undo git reset --hard"',
  // PowerShell 的 -Verbose 不是递归
  'rm -Verbose a.txt',
]

void describe('Workbench command execution policy', () => {
  void test('keeps every destructive command the platform source already flags', () => {
    for (const command of platformDangerous) {
      const plan = analyzeWorkbenchCommandExecution(command, projectRoot)
      assert.equal(plan.isDangerous, true, `平台层应判危险: ${command}`)
      assert.ok(plan.dangerousReason, `危险命令必须带理由: ${command}`)
      // 结论必须真的来自平台、原样交出：平台哪天不再判它，这里要报出来，而不是被补充层悄悄接住。
      assert.deepEqual(plan, shellCommandPolicy.analyze(command), `平台结论应原样保留: ${command}`)
    }
  })

  void test('adds the IDE workspace-integrity rules the platform source does not cover', () => {
    for (const command of workbenchDangerous) {
      const plan = analyzeWorkbenchCommandExecution(command, projectRoot)
      assert.equal(plan.isDangerous, true, `补充层应判危险: ${command}`)
      assert.ok(plan.dangerousReason, `危险命令必须带理由: ${command}`)
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

  void test('counts git wherever it appears in a command', () => {
    // 包装命令列不全，只认命令位置就会漏掉 `watch -n 1 git pull` 这类写法；漏一次就是一次静默丢改动。
    // 代价是命令文本里出现的 git 调用也会问一句——有意接受的误判。
    for (const command of ['echo git reset --hard', 'watch -n 1 git pull']) {
      assert.equal(analyzeWorkbenchCommandExecution(command, projectRoot).isDangerous, true, command)
    }
  })

  void test('takes the recursive rm verdict from the platform', () => {
    // 递归删除只由平台判定：任何形态的 `rm -r` 都问，普通删文件不问。
    for (const command of [
      'rm -r ./directory',
      'rm -R ./directory',
      'rm --recursive ./directory',
      'rm --rec ./directory',
      'rm -r -f ./victim',
      'rm -f -r ./victim',
      'ls | xargs rm -r',
      'git rm -rf ./directory',
      'rm ./directory -Recurse',
    ]) {
      assert.equal(analyzeWorkbenchCommandExecution(command, projectRoot).isDangerous, true, command)
    }
    for (const command of [
      'rm ./file',
      'rm docs/s.md',
      'rm ./file -Force',
      'rm -f ./file',
      'rm -v src',
      'git rm -r --cached ./directory',
      'git rm -r ./directory',
    ]) {
      const plan = analyzeWorkbenchCommandExecution(command, projectRoot)
      assert.equal(plan.isDangerous, false, `${command}（${plan.dangerousReason}）`)
    }
  })

  void test('asks for the workspace layer only where the platform lets the command through', () => {
    // 调用方已确认平台危险项时，补问只管平台放行的工作区层，同一条命令只问一次。
    for (const command of platformDangerous)
      assert.equal(resolveWorkspaceIntegrityConfirmation(command, projectRoot), null, command)
    for (const command of mustStayAllowed)
      assert.equal(resolveWorkspaceIntegrityConfirmation(command, projectRoot), null, command)
    const workspaceOnly = workbenchDangerous.filter(
      (command) => !shellCommandPolicy.analyze(command).isDangerous
    )
    assert.ok(workspaceOnly.length > 10)
    for (const command of workspaceOnly) {
      const confirmation = resolveWorkspaceIntegrityConfirmation(command, projectRoot)
      assert.ok(confirmation, `补充层应补问: ${command}`)
      // 确认卡只摊开一行：短标题说清这条命令要干什么，完整理由回答之后回看。
      assert.ok(confirmation.title.length > 0 && confirmation.title.length <= 20, command)
      assert.equal(confirmation.reason, analyzeWorkbenchCommandExecution(command, projectRoot).dangerousReason)
    }
    assert.equal(resolveWorkspaceIntegrityConfirmation('git reset --hard', projectRoot)?.title, '重置 Git 工作区')
    assert.equal(
      resolveWorkspaceIntegrityConfirmation('mv src /usr/local/lib', projectRoot)?.title,
      '改动项目之外的路径'
    )
  })

  void test('the question and its reason follow the interface language', () => {
    setWorkbenchMainLocale('en-US')
    try {
      const reset = resolveWorkspaceIntegrityConfirmation('git reset --hard', projectRoot)
      assert.equal(reset?.title, 'Reset the Git working tree')
      assert.match(reset?.reason ?? '', /uncommitted changes may be overwritten/u)
      assert.match(
        analyzeWorkbenchCommandExecution('mv src /usr/local/lib', projectRoot).dangerousReason ?? '',
        /outside the current workspace: \/usr\/local\/lib/u
      )
      // 补充层的每一种判定都有英文的标题与理由，不留中文。
      for (const command of workbenchDangerous) {
        const confirmation = resolveWorkspaceIntegrityConfirmation(command, projectRoot)
        if (!confirmation) continue
        assert.doesNotMatch(`${confirmation.title}${confirmation.reason}`, /[\u4e00-\u9fff]/u, command)
      }
    } finally {
      setWorkbenchMainLocale('zh-CN')
    }
  })

  void test('leaves the platform verdict untouched when it already fired', () => {
    // 平台已判危险时补充层不得覆盖它的理由——两层各自的判据要能分辨。
    const plan = analyzeWorkbenchCommandExecution('sudo rm -rf /', projectRoot)
    assert.equal(plan.isDangerous, true)
    assert.equal(plan.dangerousReason, shellCommandPolicy.analyze('sudo rm -rf /').dangerousReason)
  })
})
