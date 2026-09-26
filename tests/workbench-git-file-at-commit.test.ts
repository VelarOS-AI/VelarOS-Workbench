import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, test } from 'bun:test'

import { WorkbenchGitService } from '../src/main/workspace/git/WorkbenchGitService'

const execFileAsync = promisify(execFile)

async function git(root: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: root })
}

void describe('Workbench Git file at commit', () => {
  void test('reads the file of a project nested in the repository exactly as committed', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'workbench-git-file-at-commit-'))
    try {
      await git(repository, ['init', '-q'])
      const projectRoot = join(repository, 'packages', 'app')
      await mkdir(projectRoot, { recursive: true })
      // 仓库根下同名文件：路径必须按项目根解析，不能读成它。
      await writeFile(join(repository, 'index.ts'), 'export const root = true\n', 'utf8')
      await writeFile(join(projectRoot, 'index.ts'), 'export const app = 1\n\n', 'utf8')
      await git(repository, ['add', '-A'])
      await git(repository, [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        'commit',
        '-q',
        '-m',
        'base',
      ])

      const service = new WorkbenchGitService()
      const result = await service.getFileAtCommit(projectRoot, 'HEAD', 'index.ts')
      assert.equal(result.content, 'export const app = 1\n\n')

      await assert.rejects(
        () => service.getFileAtCommit(projectRoot, 'HEAD', 'not-committed.ts'),
        'a file missing from the commit is an error the editor treats as "no HEAD version"'
      )
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })
})
