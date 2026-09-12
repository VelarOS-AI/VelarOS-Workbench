import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { describe, test } from 'bun:test'

import { WorkbenchGitService } from '../src/main/workspace/git/WorkbenchGitService'

const execFileAsync = promisify(execFile)

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: root })
  return stdout
}

/** .git/index 的「有没有被重写过」：修改时间加内容。 */
async function readIndexFingerprint(root: string): Promise<string> {
  const indexPath = join(root, '.git', 'index')
  const [info, content] = await Promise.all([stat(indexPath), readFile(indexPath)])
  return `${info.mtimeMs}:${content.toString('base64')}`
}

void describe('Workbench Git read-only status', () => {
  void test('reading the Git summary leaves .git/index alone, so the file watcher hears no echo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-git-read-only-'))
    try {
      await git(root, ['init', '-q'])
      await writeFile(join(root, 'tracked.ts'), 'export const a = 1\n', 'utf8')
      await git(root, ['add', '-A'])
      await git(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'base'])
      await git(root, ['status', '--porcelain'])
      // 让工作区文件的修改时间晚于 index：这正是 status 会顺手刷新并重写 index 的情形。
      await delay(1_100)
      await writeFile(join(root, 'tracked.ts'), 'export const a = 2\n', 'utf8')
      await writeFile(join(root, 'added.ts'), 'export const b = 1\n', 'utf8')

      const service = new WorkbenchGitService()
      const before = await readIndexFingerprint(root)
      const summary = await service.getSummary(root)
      await service.getLineStats(root)
      assert.equal(await readIndexFingerprint(root), before)

      // 读到的状态照样是对的。
      assert.deepEqual(
        summary.status?.entries.map((entry) => `${entry.indexStatus}${entry.workTreeStatus} ${entry.path}`),
        [' M tracked.ts', '?? added.ts']
      )

      // 用户在终端里 git add：index 照常被改写，监听照常报给面板。
      await git(root, ['add', 'tracked.ts'])
      assert.notEqual(await readIndexFingerprint(root), before)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
