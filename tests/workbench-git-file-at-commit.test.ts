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

  void test('decodes the committed bytes the way the editor decodes the file on disk', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'workbench-git-file-encoding-'))
    try {
      await git(repository, ['init', '-q'])
      // 「中文测试」的 GBK 字节 + CRLF，以及带 BOM 的 UTF-16 LE：编辑器里是解码后的 LF 正文，
      // HEAD 版本也得这样解，Git 改动标记才不会把每一行都算成改过。
      const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0x0d, 0x0a])
      await writeFile(join(repository, 'legacy.txt'), gbk)
      await writeFile(
        join(repository, 'wide.txt'),
        Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\r\nb\r\n', 'utf16le')])
      )
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
      assert.equal((await service.getFileAtCommit(repository, 'HEAD', 'legacy.txt')).content, '中文测试\n')
      assert.equal((await service.getFileAtCommit(repository, 'HEAD', 'wide.txt')).content, 'a\nb\n')
    } finally {
      await rm(repository, { recursive: true, force: true })
    }
  })
})
