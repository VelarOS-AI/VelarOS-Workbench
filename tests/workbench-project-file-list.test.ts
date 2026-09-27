import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, test } from 'bun:test'

import { createWorkbenchAppParts } from '../src/main/workspace/Parts'

import { refuseTrash } from './helpers/fakeTrash'

/**
 * 快速打开的整份文件清单：跳过规则与文件搜索相同，点号开头的文件照列；链接只列指向工程里文件的那些；
 * 一层一层读，超出上限时留下离根近的文件。
 */

async function withProject(
  files: Record<string, string>,
  run: (projectRoot: string, parts: ReturnType<typeof createWorkbenchAppParts>) => Promise<void>
) {
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-file-list-')))
  const parts = createWorkbenchAppParts(`${projectRoot}-data`, { moveToTrash: refuseTrash })
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(projectRoot, path)), { recursive: true })
      await writeFile(join(projectRoot, path), content, 'utf8')
    }
    await run(projectRoot, parts)
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
    await rm(`${projectRoot}-data`, { recursive: true, force: true })
  }
}

void describe('Workbench project file list', () => {
  void test('lists every project file with the search skip rules, nearest the root first', async () => {
    await withProject(
      {
        'README.md': '',
        '.env': '',
        '.github/workflows/ci.yml': '',
        'src/math.ts': '',
        'src/build/compile.ts': '',
        'src/deep/nested/leaf.ts': '',
        'dist/bundle.js': '',
        'build/out.js': '',
        'out/report.txt': '',
        'node_modules/lib/index.js': '',
        'packages/app/node_modules/lib/index.js': '',
        'packages/app/dist/index.js': '',
        '.git/HEAD': '',
        '.codegraph/index.db': '',
      },
      async (projectRoot, parts) => {
        const result = await parts.search.listProjectFiles({ projectRoot })
        assert.equal(result.projectRoot, projectRoot)
        assert.equal(result.truncated, false)
        // 一层一层列：根目录下的文件、第一层目录里的、第二层的……同一层里按名字排。
        assert.deepEqual(result.files, [
          '.env',
          'README.md',
          'src/math.ts',
          '.github/workflows/ci.yml',
          'src/build/compile.ts',
          'packages/app/dist/index.js',
          'src/deep/nested/leaf.ts',
        ])
      }
    )
  })

  void test('lists links to project files but never follows linked folders', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'workbench-file-list-outside-')))
    try {
      await writeFile(join(outside, 'secret.txt'), '', 'utf8')
      await withProject({ 'AGENTS.md': '', 'src/a.ts': '' }, async (projectRoot, parts) => {
        await symlink(join(projectRoot, 'AGENTS.md'), join(projectRoot, 'CLAUDE.md'))
        await symlink(join(outside, 'secret.txt'), join(projectRoot, 'outside.txt'))
        await symlink(join(projectRoot, 'missing.ts'), join(projectRoot, 'dangling.ts'))
        await symlink(join(projectRoot, 'src'), join(projectRoot, 'src-link'), 'dir')
        await symlink(outside, join(projectRoot, 'outside-dir'), 'dir')

        const result = await parts.search.listProjectFiles({ projectRoot })
        assert.deepEqual(result.files, ['AGENTS.md', 'CLAUDE.md', 'src/a.ts'])
      })
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  void test('stops at the limit, keeping the files nearest the root', async () => {
    await withProject(
      {
        'a.ts': '',
        'b.ts': '',
        'src/c.ts': '',
        'src/d.ts': '',
        'src/deep/e.ts': '',
      },
      async (projectRoot, parts) => {
        const limited = await parts.search.listProjectFiles({ projectRoot, limit: 3 })
        assert.deepEqual(limited, { projectRoot, files: ['a.ts', 'b.ts', 'src/c.ts'], truncated: true })

        // 刚好装下不算截断。
        const exact = await parts.search.listProjectFiles({ projectRoot, limit: 5 })
        assert.equal(exact.truncated, false)
        assert.equal(exact.files.length, 5)
      }
    )
  })

  void test('refuses a project root that is not a folder', async () => {
    await withProject({ 'file.txt': '' }, async (projectRoot, parts) => {
      await assert.rejects(parts.search.listProjectFiles({ projectRoot: join(projectRoot, 'file.txt') }))
      await assert.rejects(parts.search.listProjectFiles({ projectRoot: '  ' }))
    })
  })
})
