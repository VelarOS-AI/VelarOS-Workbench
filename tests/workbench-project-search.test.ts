import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { devNull, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { describe, mock, test } from 'bun:test'

import { runWorkbenchContentSearchTask } from '../src/main/workspace/ContentSearchTask'
import type { WorkbenchContentSearchWorkerOptions } from '../src/main/workspace/ContentSearchWorkerHost'
import type {
  WorkbenchContentSearchFileResult,
  WorkbenchSearchContentBatch,
  WorkbenchSearchContentProgressEvent,
  WorkbenchSearchContentRequest,
  WorkbenchSearchContentResult,
} from '../src/shared/contracts'
import type { WorkbenchFsCallResult } from '../src/shared/workbenchFs'
import { WorkbenchFsChannels } from '../src/shared/workbenchFs'

import { refuseTrash } from './helpers/fakeTrash'
import { RunawayRegex, RunawayText, sourceSearchWorker } from './helpers/searchWorker'

/**
 * 项目内容搜索（main 侧）：Git 仓库按 .gitignore 列文件，其它工程遍历目录；点号开头的文件照样搜；认文件编码，
 * 行列号与编辑器一致；列到上限就停并说明；边搜边推送、能取消；编辑器里开着的文件只报在不在范围里；
 * 正则在 worker 里跑，跑不完的被停下，主进程不卡。
 */

// 不受开发机上全局 git 配置（全局忽略文件、默认分支名……）影响。
process.env['GIT_CONFIG_GLOBAL'] = devNull
process.env['GIT_CONFIG_NOSYSTEM'] = '1'

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()

mock.module('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    },
    on: () => undefined,
  },
}))

const { createWorkbenchAppParts } = await import('../src/main/workspace/Parts')
const { registerWorkbenchFsIpc } = await import('../src/main/workspace/WorkbenchFsIpc')

const execFileAsync = promisify(execFile)

type ProjectFiles = Record<string, string | Uint8Array>

async function writeProjectFiles(root: string, files: ProjectFiles): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
}

async function git(root: string, args: string[]): Promise<void> {
  await execFileAsync(
    'git',
    ['-c', 'user.email=search@velaros.local', '-c', 'user.name=Search Test', ...args],
    { cwd: root }
  )
}

async function withProject(
  files: ProjectFiles,
  run: (context: {
    root: string
    search: (
      request: Omit<WorkbenchSearchContentRequest, 'projectRoot'>,
      options?: Parameters<ReturnType<typeof createWorkbenchAppParts>['search']['searchContent']>[1]
    ) => Promise<WorkbenchSearchContentResult>
  }) => Promise<void>,
  searchWorker: WorkbenchContentSearchWorkerOptions = {}
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workbench-project-search-')))
  const data = await mkdtemp(join(tmpdir(), 'workbench-project-search-data-'))
  try {
    await writeProjectFiles(root, files)
    const parts = createWorkbenchAppParts(data, {
      moveToTrash: refuseTrash,
      searchWorker: { ...sourceSearchWorker, ...searchWorker },
    })
    await run({
      root,
      search: (request, options) => parts.search.searchContent({ projectRoot: root, ...request }, options),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(data, { recursive: true, force: true })
  }
}

function pathsOf(result: WorkbenchSearchContentBatch): string[] {
  return result.files.map((file) => file.path)
}


void describe('project content search: which files', () => {
  void test('a Git project is listed by Git: ignored files are skipped, untracked ones searched', async () => {
    await withProject(
      {
        '.gitignore': 'dist/\n*.log\nsecret.env\n',
        'src/app.ts': 'const needle = 1\n',
        'src/removed.ts': 'const needle = 2\n',
        'dist/bundle.js': 'const needle = 3\n',
        'debug.log': 'needle\n',
        '.env': 'NEEDLE=1\n',
        'secret.env': 'NEEDLE=2\n',
        '.github/workflows/ci.yml': 'run: needle\n',
        'build/icon.svg': '<svg><title>needle</title></svg>\n',
        'node_modules/lib/index.js': 'needle\n',
        '.codegraph/index.txt': 'needle\n',
      },
      async ({ root, search }) => {
        await git(root, ['init', '-q'])
        await git(root, ['add', '.gitignore', 'src', 'build'])
        await git(root, ['add', '-f', 'node_modules/lib/index.js'])
        await git(root, ['commit', '-qm', 'init'])
        await rm(join(root, 'src/removed.ts'))
        await writeProjectFiles(root, { 'src/untracked.ts': 'export const needle = 4\n' })

        const result = await search({ query: 'needle' })
        // 构建产物在 Git 仓库里听 .gitignore 的：被跟踪的 build/ 照样搜；依赖目录与内部目录被跟踪了也不搜。
        assert.deepEqual(pathsOf(result), [
          '.env',
          '.github/workflows/ci.yml',
          'build/icon.svg',
          'src/app.ts',
          'src/untracked.ts',
        ])
        assert.equal(result.truncated, false)
      }
    )
  })

  void test('a project inside a larger repository gets its own files, with the repository’s ignore rules', async () => {
    await withProject(
      {
        '.gitignore': '*.gen.ts\n',
        'app/a.ts': 'needle\n',
        'app/b.gen.ts': 'needle\n',
        'other/c.ts': 'needle\n',
      },
      async ({ root }) => {
        await git(root, ['init', '-q'])
        await git(root, ['add', '.gitignore', 'app/a.ts'])
        await git(root, ['commit', '-qm', 'init'])
        await writeProjectFiles(root, { 'app/new.ts': 'needle\n' })

        const data = await mkdtemp(join(tmpdir(), 'workbench-project-search-nested-'))
        try {
          const parts = createWorkbenchAppParts(data, {
            moveToTrash: refuseTrash,
            searchWorker: sourceSearchWorker,
          })
          const result = await parts.search.searchContent({ projectRoot: join(root, 'app'), query: 'needle' })
          assert.deepEqual(pathsOf(result), ['a.ts', 'new.ts'])
        } finally {
          await rm(data, { recursive: true, force: true })
        }
      }
    )
  })

  void test('nested repositories are listed with their own ignore rules; symlinks are not followed', async () => {
    await withProject(
      {
        'main.ts': 'needle\n',
        'vendor/lib/.gitignore': 'generated.ts\n',
        'vendor/lib/lib.ts': 'needle\n',
        'vendor/lib/generated.ts': 'needle\n',
      },
      async ({ root, search }) => {
        await git(root, ['init', '-q'])
        await git(join(root, 'vendor/lib'), ['init', '-q'])
        await symlink(join(root, 'main.ts'), join(root, 'alias.ts'))
        await symlink(join(root, 'vendor'), join(root, 'vendor-link'))

        const result = await search({ query: 'needle' })
        assert.deepEqual(pathsOf(result), ['main.ts', 'vendor/lib/lib.ts'])
      }
    )
  })

  void test('without Git the folders are walked: dotfiles searched, dot folders and build output skipped', async () => {
    await withProject(
      {
        '.env': 'NEEDLE=1\n',
        '.venv/lib/site.py': 'needle\n',
        'dist/bundle.js': 'needle\n',
        'src/dist/keep.ts': 'needle\n',
        'node_modules/a/index.js': 'needle\n',
        'src/app.ts': 'needle\n',
      },
      async ({ search }) => {
        const result = await search({ query: 'needle' })
        assert.deepEqual(pathsOf(result), ['.env', 'src/app.ts', 'src/dist/keep.ts'])
      }
    )
  })

  void test('include and exclude patterns narrow the search', async () => {
    await withProject(
      {
        'src/app.ts': 'needle\n',
        'src/app.test.ts': 'needle\n',
        'src/view.tsx': 'needle\n',
        'docs/guide.md': 'needle\n',
        'scripts/build.ts': 'needle\n',
      },
      async ({ search }) => {
        assert.deepEqual(pathsOf(await search({ query: 'needle', include: 'src/**, *.md' })), [
          'docs/guide.md',
          'src/app.test.ts',
          'src/app.ts',
          'src/view.tsx',
        ])
        assert.deepEqual(
          pathsOf(await search({ query: 'needle', include: '*.ts', exclude: '**/*.test.ts' })),
          ['scripts/build.ts', 'src/app.ts']
        )
        // 替换后刷新几个文件：只搜点名的文件，范围照样生效，工程外的路径不认。
        assert.deepEqual(
          pathsOf(
            await search({
              query: 'needle',
              exclude: 'docs',
              paths: ['src/view.tsx', 'docs/guide.md', '../outside.ts', 'missing.ts'],
            })
          ),
          ['src/view.tsx']
        )
      }
    )
  })

  void test('binary and very large files are not searched; large ones are counted', async () => {
    await withProject(
      {
        'image.bin': Uint8Array.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]),
        'huge.txt': `${'needle '.repeat(150_000)}\n`,
        'small.txt': 'needle\n',
      },
      async ({ search }) => {
        const result = await search({ query: 'needle' })
        assert.deepEqual(pathsOf(result), ['small.txt'])
        assert.equal(result.skippedLargeFileCount, 1)
      }
    )
  })
})

void describe('project content search: matches', () => {
  void test('options work as in the editor and an invalid regex is refused', async () => {
    await withProject(
      { 'a.ts': 'const Calc = calc(recalc)\n' },
      async ({ search }) => {
        const count = async (request: Omit<WorkbenchSearchContentRequest, 'projectRoot'>): Promise<number> =>
          (await search(request)).files[0]?.matchCount ?? 0
        assert.equal(await count({ query: 'calc' }), 3)
        assert.equal(await count({ query: 'calc', matchCase: true }), 2)
        assert.equal(await count({ query: 'calc', wholeWord: true }), 2)
        assert.equal(await count({ query: 'c[a-z]+c\\b', regex: true, matchCase: true }), 2)
        await assert.rejects(search({ query: 'calc(', regex: true }), /正则表达式有误/u)
      }
    )
  })

  void test('GB18030 and UTF-16 files match with the line and column numbers the editor shows', async () => {
    await withProject(
      {
        // 「第一行\r\n中文测试」的 GBK 字节，CRLF 换行。
        'gbk.txt': Uint8Array.from([
          0xb5, 0xda, 0xd2, 0xbb, 0xd0, 0xd0, 0x0d, 0x0a, 0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4,
        ]),
        'utf16.txt': Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from('first\r\n  second 中文测试\r\n', 'utf16le'),
        ]),
      },
      async ({ search }) => {
        const result = await search({ query: '测试' })
        const byPath = new Map(result.files.map((file) => [file.path, file]))
        assert.deepEqual(pick(byPath.get('gbk.txt')), [
          { line: 2, column: 3, endLine: 2, endColumn: 5, excerpt: '中文测试', start: 2, end: 4 },
        ])
        assert.deepEqual(pick(byPath.get('utf16.txt')), [
          { line: 2, column: 12, endLine: 2, endColumn: 14, excerpt: 'second 中文测试', start: 9, end: 11 },
        ])
      }
    )
  })

  void test('stops at the limit with a truncation flag and still counts every match of a listed file', async () => {
    const files: ProjectFiles = {}
    for (let index = 0; index < 6; index += 1) files[`file-${index}.txt`] = 'needle\n'.repeat(4)
    await withProject(files, async ({ search }) => {
      const full = await search({ query: 'needle' })
      assert.equal(full.files.length, 6)
      assert.equal(full.truncated, false)

      const limited = await search({ query: 'needle', limit: 10 })
      assert.equal(limited.truncated, true)
      assert.deepEqual(
        limited.files.map((file) => [file.path, file.matchCount, file.matches.length]),
        [
          ['file-0.txt', 4, 4],
          ['file-1.txt', 4, 4],
          ['file-2.txt', 4, 2],
        ]
      )

      // 每个文件的上限只少列，不算截断。
      const perFile = await search({ query: 'needle', maxResultsPerFile: 1 })
      assert.equal(perFile.truncated, false)
      assert.deepEqual(new Set(perFile.files.map((file) => `${file.matchCount}/${file.matches.length}`)), new Set(['4/1']))

      // 上限正好用在最后一个文件上：没有漏下的，不算截断。
      const exact = await search({ query: 'needle', limit: 24 })
      assert.equal(exact.truncated, false)
    })
  })
})

void describe('project content search: streaming, cancelling and open files', () => {
  void test('batches arrive while searching and the result carries the rest', async () => {
    const files: ProjectFiles = {}
    for (let index = 0; index < 40; index += 1) files[`src/file-${String(index).padStart(2, '0')}.ts`] = 'needle\n'
    await withProject(files, async ({ search }) => {
      const batches: WorkbenchSearchContentBatch[] = []
      const result = await search({ query: 'needle' }, { onBatch: (batch) => batches.push(batch) })
      // 第一批一有结果就交出。
      assert.deepEqual(pathsOf(batches[0]!), ['src/file-00.ts'])
      const all = [...batches.flatMap(pathsOf), ...pathsOf(result)]
      assert.equal(all.length, 40)
      assert.deepEqual(all, [...all].sort())
    })
  })

  void test('after the first batch, one batch goes out per interval', async () => {
    // worker 里跑的就是这段；在本线程跑，好拨时钟。
    const files: ProjectFiles = {}
    for (let index = 0; index < 5; index += 1) files[`f-${index}.ts`] = 'needle\n'
    await withProject(files, async ({ root }) => {
      const run = async (step: number) => {
        const batches: string[][] = []
        const originalNow = Date.now
        let clock = originalNow()
        Date.now = () => (clock += step)
        try {
          const result = await runWorkbenchContentSearchTask(
            {
              projectRoot: root,
              paths: Object.keys(files),
              openPaths: [],
              query: { query: 'needle', matchCase: false, wholeWord: false, regex: false },
              limit: 100,
              maxResultsPerFile: 100,
            },
            { onBatch: (batch) => batches.push(pathsOf(batch)) }
          )
          return { batches, rest: pathsOf(result) }
        } finally {
          Date.now = originalNow
        }
      }
      // 时间不走：只有第一批，其余留在结果里。
      assert.deepEqual(await run(0), {
        batches: [['f-0.ts']],
        rest: ['f-1.ts', 'f-2.ts', 'f-3.ts', 'f-4.ts'],
      })
      // 每次问时间都过去 100 ms：每个文件后都交一批。
      assert.deepEqual(await run(100), {
        batches: [['f-0.ts'], ['f-1.ts'], ['f-2.ts'], ['f-3.ts'], ['f-4.ts']],
        rest: [],
      })
    })
  })

  void test('an aborted search stops and says so', async () => {
    await withProject({ 'a.ts': 'needle\n', 'b.ts': 'needle\n' }, async ({ search }) => {
      const controller = new AbortController()
      controller.abort()
      const result = await search({ query: 'needle' }, { signal: controller.signal })
      assert.equal(result.cancelled, true)
      assert.deepEqual(result.files, [])
    })
  })

  void test('open files are left to the caller: only reported when they are in scope', async () => {
    await withProject(
      { 'src/open.ts': 'needle\n', 'src/closed.ts': 'needle\n', 'docs/open.md': 'needle\n' },
      async ({ root, search }) => {
        const result = await search({
          query: 'needle',
          exclude: 'docs',
          openPaths: ['src/open.ts', 'docs/open.md', 'src/unsaved-new.ts'],
        })
        assert.deepEqual(pathsOf(result), ['src/closed.ts'])
        assert.deepEqual(result.openPathsInScope, ['src/open.ts'])

        // 字面查找不读开着的文件；用正则时先在磁盘版本上试跑一遍（结果照样不出），再报它在范围里。
        const scanned = async (regex: boolean): Promise<string[]> => {
          const files: string[] = []
          const outcome = await runWorkbenchContentSearchTask(
            {
              projectRoot: root,
              paths: ['src/closed.ts', 'src/open.ts'],
              openPaths: ['src/open.ts'],
              query: { query: 'needle', matchCase: false, wholeWord: false, regex },
              limit: 100,
              maxResultsPerFile: 100,
            },
            { onFile: (path) => files.push(path) }
          )
          assert.deepEqual(pathsOf(outcome), ['src/closed.ts'])
          assert.deepEqual(outcome.openPathsInScope, ['src/open.ts'])
          return files
        }
        assert.deepEqual(await scanned(false), ['src/closed.ts'])
        assert.deepEqual(await scanned(true), ['src/closed.ts', 'src/open.ts'])
      }
    )
  })
})

void describe('project content search IPC', () => {
  void test('streams batches to the window that asked, can be cancelled, and validates requests', async () => {
    const files: ProjectFiles = {}
    for (let index = 0; index < 30; index += 1) files[`f-${String(index).padStart(2, '0')}.ts`] = 'needle\n'
    await withProject(files, async ({ root }) => {
      const data = await mkdtemp(join(tmpdir(), 'workbench-project-search-ipc-'))
      try {
        registerWorkbenchFsIpc(
          {} as never,
          createWorkbenchAppParts(data, { moveToTrash: refuseTrash, searchWorker: sourceSearchWorker }),
          {} as never
        )
        const searchHandler = ipcHandlers.get(WorkbenchFsChannels.searchContent)!
        const cancelHandler = ipcHandlers.get(WorkbenchFsChannels.cancelSearchContent)!
        const sent: WorkbenchSearchContentProgressEvent[] = []
        const destroyedListeners: Array<() => void> = []
        const sender = {
          id: 7,
          isDestroyed: () => false,
          send: (channel: string, event: WorkbenchSearchContentProgressEvent) => {
            assert.equal(channel, WorkbenchFsChannels.searchContentProgress)
            sent.push(event)
          },
          once: (event: string, listener: () => void) => {
            if (event === 'destroyed') destroyedListeners.push(listener)
          },
        }

        const envelope = (await searchHandler(
          { sender },
          { projectRoot: root, query: 'needle', searchId: 's1' }
        )) as WorkbenchFsCallResult<WorkbenchSearchContentResult>
        assert.ok(envelope.ok)
        assert.ok(sent.length > 0)
        assert.ok(sent.every((event) => event.searchId === 's1'))
        assert.equal(sent.flatMap(pathsOf).length + envelope.value.files.length, 30)

        // 取消：搜索中途收到取消就停下，结果标成 cancelled。
        let cancelled: Promise<unknown> = Promise.resolve()
        const slowSender = {
          ...sender,
          send: () => {
            cancelled = cancelHandler({ sender: slowSender }, { searchId: 's2' }) as Promise<unknown>
          },
        }
        const second = (await searchHandler(
          { sender: slowSender },
          { projectRoot: root, query: 'needle', searchId: 's2' }
        )) as WorkbenchFsCallResult<WorkbenchSearchContentResult>
        await cancelled
        assert.ok(second.ok)
        assert.equal(second.value.cancelled, true)

        const invalid = (await searchHandler({ sender }, { projectRoot: root, query: 'x', paths: 'a.ts' })) as WorkbenchFsCallResult<unknown>
        assert.equal(invalid.ok, false)
        assert.equal(invalid.ok ? undefined : invalid.code, 'VALIDATION')
        assert.equal(destroyedListeners.length, 1)
      } finally {
        await rm(data, { recursive: true, force: true })
      }
    })
  })
})

void describe('project content search IPC: closing the window', () => {
  void test('a window closed mid-search stops its searches; the destroyed window is not touched', async () => {
    const files: ProjectFiles = {}
    for (let index = 0; index < 30; index += 1) files[`f-${String(index).padStart(2, '0')}.ts`] = 'needle\n'
    await withProject(files, async ({ root }) => {
      const data = await mkdtemp(join(tmpdir(), 'workbench-project-search-ipc-'))
      try {
        registerWorkbenchFsIpc(
          {} as never,
          createWorkbenchAppParts(data, { moveToTrash: refuseTrash, searchWorker: sourceSearchWorker }),
          {} as never
        )
        const searchHandler = ipcHandlers.get(WorkbenchFsChannels.searchContent)!
        let destroyed = false
        let sentAfterDestroyed = 0
        const destroyedListeners: Array<() => void> = []
        const sender = {
          // 与 Electron 一样：WebContents 销毁以后（`destroyed` 触发时已经是）再读 id 会抛错。
          get id(): number {
            if (destroyed) throw new TypeError('Object has been destroyed')
            return 11
          },
          isDestroyed: () => destroyed,
          send: () => {
            if (destroyed) {
              sentAfterDestroyed += 1
              return
            }
            // 第一批送到时窗口关了。
            destroyed = true
            for (const listener of destroyedListeners) listener()
          },
          once: (event: string, listener: () => void) => {
            if (event === 'destroyed') destroyedListeners.push(listener)
          },
        }

        const envelope = (await searchHandler(
          { sender },
          { projectRoot: root, query: 'needle', searchId: 's1' }
        )) as WorkbenchFsCallResult<WorkbenchSearchContentResult>
        assert.ok(envelope.ok, envelope.ok ? '' : envelope.message)
        assert.equal(envelope.value.cancelled, true)
        assert.equal(sentAfterDestroyed, 0)
      } finally {
        await rm(data, { recursive: true, force: true })
      }
    })
  })
})

void describe('project content search: runaway regexes', () => {
  void test('a regex that runs away is stopped in the worker, naming the file; the main process keeps running', async () => {
    await withProject(
      { 'fine.ts': 'let x = 1;\n', 'slow.ts': RunawayText },
      async ({ search }) => {
        let ticks = 0
        const ticker = setInterval(() => (ticks += 1), 20)
        // slow.ts 在编辑器里开着：worker 先在磁盘版本上试跑、卡住，调用方就不会在自己的线程里再跑它。
        const searching = search({ query: RunawayRegex, regex: true, openPaths: ['slow.ts'] })
        try {
          await assert.rejects(searching, (error: unknown) => {
            const { code, message } = error as { code?: string; message?: string }
            assert.equal(code, 'TIMEOUT')
            assert.match(message ?? '', /slow\.ts/u)
            return true
          })
        } finally {
          clearInterval(ticker)
        }
        // 等 worker 被判定卡住的这段时间里，主进程的定时器照常走。
        assert.ok(ticks >= 5, `ticks: ${ticks}`)
      },
      { stallTimeoutMs: 250 }
    )
  })
})

function pick(file: LooseOptional<WorkbenchContentSearchFileResult>) {
  return (file?.matches ?? []).map((match) => ({
    line: match.line,
    column: match.column,
    endLine: match.endLine,
    endColumn: match.endColumn,
    excerpt: match.excerpt,
    start: match.excerptMatchStart,
    end: match.excerptMatchEnd,
  }))
}
