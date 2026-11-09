import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'

import { describe, test } from 'bun:test'

import { ExternalLspProcessHost } from '../src/main/workspace/language/ExternalLspProcessHost'
import { WorkbenchLanguageServices } from '../src/main/workspace/language/LanguageServices'
import {
  WorkbenchLanguageServiceWorkerClient,
  type WorkbenchLanguageServiceWorkerPort,
} from '../src/main/workspace/language/LanguageServiceWorkerClient'
import type {
  WorkbenchLanguageServiceWorkerRequest,
  WorkbenchLanguageServiceWorkerResponse,
} from '../src/main/workspace/language/LanguageServiceWorkerProtocol'
import { ProjectToolWorkerHost } from '../src/main/workspace/language/ProjectToolWorkerHost'
import {
  acquireTypeScriptLanguageService,
  clearTypeScriptProjectCache,
  refreshTypeScriptProjectFilesFromDisk,
} from '../src/main/workspace/language/TypeScriptProjectHost'
import {
  languageSyncOnAgentEdits,
  withLanguageSyncOnUserWrites,
} from '../src/main/workspace/language/WorkbenchLanguageWriteSync'
import { PathResolver } from '../src/main/workspace/PathResolver'
import { mayAffectWorkbenchDiagnostics } from '../src/renderer/src/models/editor/workbenchEditorTabs'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

async function createProject(): Promise<{
  projectRoot: string
  mainPath: string
  dependencyPath: string
}> {
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-language-freshness-')))
  await mkdir(join(projectRoot, 'src'), { recursive: true })
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
  await writeFile(
    join(projectRoot, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', target: 'ESNext', strict: true },
      include: ['src/**/*.ts'],
    }),
    'utf8'
  )
  const mainPath = join(projectRoot, 'src', 'main.ts')
  const dependencyPath = join(projectRoot, 'src', 'dependency.ts')
  await writeFile(mainPath, "import { value } from './dependency'\nexport const copied: number = value\n", 'utf8')
  await writeFile(dependencyPath, 'export const value = "text"\n', 'utf8')
  return { projectRoot, mainPath, dependencyPath }
}

function semanticMessages(projectRoot: string, mainPath: string, overlay: Map<string, string>): string[] {
  const project = acquireTypeScriptLanguageService(projectRoot, mainPath, [mainPath], overlay)
  return project.service
    .getSemanticDiagnostics(mainPath)
    .map((diagnostic) => String(diagnostic.messageText).split('\n')[0] ?? '')
}

void describe('language service freshness after files change on disk', () => {
  void test('a hot package refreshes an imported source outside its tsconfig directory', async () => {
    const { projectRoot, dependencyPath } = await createProject()
    const packageRoot = join(projectRoot, 'packages', 'app')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(
      join(packageRoot, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true }, include: ['main.ts'] }),
      'utf8'
    )
    const mainPath = join(packageRoot, 'main.ts')
    const content =
      "import { value } from '../../src/dependency'\nexport const copied: number = value\n"
    await writeFile(mainPath, content, 'utf8')
    const acquire = () =>
      acquireTypeScriptLanguageService(
        projectRoot,
        mainPath,
        [mainPath],
        new Map([[mainPath, content]])
      )
    const services = new WorkbenchLanguageServices(
      new PathResolver(),
      new ExternalLspProcessHost(),
      new ProjectToolWorkerHost(
        new URL('../src/main/workspace/language/ProjectToolWorker.ts', import.meta.url)
      )
    )
    try {
      const before = acquire()
      assert.equal(before.service.getSemanticDiagnostics(mainPath).length, 1)
      await rm(dependencyPath)
      await services.projectFilesChanged({ projectRoot, paths: ['src/dependency.ts'] })
      const missing = acquire().service.getSemanticDiagnostics(mainPath)
      assert.equal(missing.length, 1)
      assert.match(String(missing[0]!.messageText), /Cannot find module/u)
      await writeFile(dependencyPath, 'export const value = 21\n', 'utf8')
      await services.projectFilesChanged({ projectRoot, paths: ['src/dependency.ts'] })
      const after = acquire()
      assert.equal(after.service, before.service)
      const messages = after.service
        .getSemanticDiagnostics(mainPath)
        .map((diagnostic) => String(diagnostic.messageText).split('\n')[0] ?? '')
      assert.equal(messages.length, 0, messages.join('\n'))
    } finally {
      await services.dispose()
      clearTypeScriptProjectCache(projectRoot)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('a dependency rewritten on disk changes the diagnostics of the file importing it', async () => {
    const { projectRoot, mainPath, dependencyPath } = await createProject()
    const mainSource = readFileSync(mainPath, 'utf8')
    try {
      const before = semanticMessages(projectRoot, mainPath, new Map([[mainPath, mainSource]]))
      assert.equal(before.length, 1, before.join('\n'))
      assert.match(before[0]!, /string/u)

      // Agent 把依赖改对了，但语言服务还没被告知：结论照旧。
      await writeFile(dependencyPath, 'export const value = 21\n', 'utf8')
      assert.equal(
        semanticMessages(projectRoot, mainPath, new Map([[mainPath, mainSource]])).length,
        1
      )

      refreshTypeScriptProjectFilesFromDisk(projectRoot, [dependencyPath])
      assert.deepEqual(semanticMessages(projectRoot, mainPath, new Map([[mainPath, mainSource]])), [])

      // 依赖被删掉：导入解析失败，而不是继续用内存里的旧文本。
      await rm(dependencyPath)
      refreshTypeScriptProjectFilesFromDisk(projectRoot, [dependencyPath])
      const missing = semanticMessages(projectRoot, mainPath, new Map([[mainPath, mainSource]]))
      assert.equal(missing.length, 1, missing.join('\n'))
      assert.match(missing[0]!, /Cannot find module/u)
    } finally {
      clearTypeScriptProjectCache(projectRoot)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('a dirty editor buffer stays authoritative over the disk version of the same file', async () => {
    const { projectRoot, mainPath, dependencyPath } = await createProject()
    const mainSource = readFileSync(mainPath, 'utf8')
    const editedDependency = 'export const value = 21\n'
    try {
      // 依赖在编辑器里改好了（未保存）：诊断按缓冲区算。
      assert.deepEqual(
        semanticMessages(
          projectRoot,
          mainPath,
          new Map([[mainPath, mainSource], [dependencyPath, editedDependency]])
        ),
        []
      )
      // 磁盘上有人把它改成别的：缓冲区仍在覆盖，磁盘版本不能抢过来。
      await writeFile(dependencyPath, 'export const value = false\n', 'utf8')
      refreshTypeScriptProjectFilesFromDisk(projectRoot, [dependencyPath])
      assert.deepEqual(
        semanticMessages(
          projectRoot,
          mainPath,
          new Map([[mainPath, mainSource], [dependencyPath, editedDependency]])
        ),
        []
      )
      // 标签干净了（保存或撤销）：回到此刻的磁盘内容，而不是首次扫描时的旧文本。
      const fromDisk = semanticMessages(projectRoot, mainPath, new Map([[mainPath, mainSource]]))
      assert.equal(fromDisk.length, 1, fromDisk.join('\n'))
      assert.match(fromDisk[0]!, /boolean/u)
    } finally {
      clearTypeScriptProjectCache(projectRoot)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('projectFilesChanged refreshes TypeScript from relative paths and ignores paths outside the project', async () => {
    const { projectRoot, mainPath, dependencyPath } = await createProject()
    const services = new WorkbenchLanguageServices(
      new PathResolver(),
      new ExternalLspProcessHost(),
      new ProjectToolWorkerHost(
        new URL('../src/main/workspace/language/ProjectToolWorker.ts', import.meta.url)
      )
    )
    const request = { projectRoot, path: 'src/main.ts', language: 'typescript' }
    try {
      const before = await services.getDiagnostics({ ...request, content: readFileSync(mainPath, 'utf8') })
      assert.equal(before.diagnostics.filter((item) => item.severity === 'error').length, 1)

      await writeFile(dependencyPath, 'export const value = 21\n', 'utf8')
      await services.projectFilesChanged({
        projectRoot,
        paths: ['src/dependency.ts', '../outside.ts', '/etc/hosts'],
      })
      const after = await services.getDiagnostics({ ...request, content: readFileSync(mainPath, 'utf8') })
      assert.deepEqual(after.diagnostics.filter((item) => item.severity === 'error'), [])
    } finally {
      await services.dispose()
      clearTypeScriptProjectCache(projectRoot)
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

class RecordingLanguageServiceWorker implements WorkbenchLanguageServiceWorkerPort {
  private readonly events = new EventEmitter()
  public readonly messages: WorkbenchLanguageServiceWorkerRequest[] = []
  private readonly pending: WorkbenchLanguageServiceWorkerRequest[] = []

  public postMessage(message: WorkbenchLanguageServiceWorkerRequest): void {
    this.messages.push(message)
    this.pending.push(message)
    // 关闭握手立刻答复；别的请求等测试自己 flush，好观察在飞去重。
    if (message.operation === 'shutdown') this.flush()
  }

  public on(event: 'message' | 'error' | 'exit', listener: (...args: never[]) => void): this {
    this.events.on(event, listener)
    return this
  }

  public async terminate(): Promise<number> {
    return 0
  }

  /** 按到达顺序答复所有挂起请求。 */
  public flush(): void {
    for (const message of this.pending.splice(0)) {
      const response: WorkbenchLanguageServiceWorkerResponse = {
        id: message.id,
        result: message.operation === 'getDiagnostics'
          ? { projectRoot: '/project', path: 'src/main.ts', diagnostics: [] }
          : undefined,
      }
      this.events.emit('message', response)
    }
  }
}

void describe('language worker client after project files change', () => {
  void test('an identical diagnostics request no longer reuses the in-flight one once files changed', async () => {
    const worker = new RecordingLanguageServiceWorker()
    const client = new WorkbenchLanguageServiceWorkerClient(() => worker, () => 5_000)
    const request = {
      projectRoot: '/project',
      path: 'src/main.ts',
      language: 'typescript',
      content: 'export const value = 1\n',
    }

    const first = client.getDiagnostics(request)
    const reused = client.getDiagnostics(request)
    assert.equal(worker.messages.filter((message) => message.operation === 'getDiagnostics').length, 1)

    const changed = client.projectFilesChanged({ projectRoot: '/project', paths: ['src/dependency.ts'] })
    const fresh = client.getDiagnostics(request)
    assert.equal(worker.messages.filter((message) => message.operation === 'getDiagnostics').length, 2)
    assert.deepEqual(
      worker.messages.map((message) => message.operation),
      ['getDiagnostics', 'projectFilesChanged', 'getDiagnostics']
    )

    worker.flush()
    await Promise.all([first, reused, changed, fresh])
    await client.dispose()
  })
})

void describe('user and agent writes reach the language service without waiting for the file watcher', () => {
  void test('user writes reach the attribution ledger first, then the language service', () => {
    const order: string[] = []
    const notified: Array<{ projectRoot: string; paths: string[] }> = []
    const sink = withLanguageSyncOnUserWrites(
      { recordUserWrites: (request) => order.push(`ledger:${request.paths.join(',')}`) },
      {
        projectFilesChanged: async (request) => {
          order.push(`language:${request.paths.join(',')}`)
          notified.push(request)
        },
      }
    )

    sink.recordUserWrites({ workspaceRoot: '/project', paths: ['src/a.ts', 'src/b.ts'] })
    // 没写成任何文件：账本照记，语言服务不必打扰。
    sink.recordUserWrites({ workspaceRoot: '/project', paths: [] })

    assert.deepEqual(order, ['ledger:src/a.ts,src/b.ts', 'language:src/a.ts,src/b.ts', 'ledger:'])
    assert.deepEqual(notified, [{ projectRoot: '/project', paths: ['src/a.ts', 'src/b.ts'] }])
  })

  void test('user writes from the editor and the file tree report the same way, and a failing notification is swallowed', async () => {
    const recorded: string[] = []
    const sink = withLanguageSyncOnUserWrites(
      { recordUserWrites: (request) => recorded.push(request.paths.join(',')) },
      { projectFilesChanged: () => Promise.reject(new Error('worker gone')) }
    )
    sink.recordUserWrites({ workspaceRoot: '/project', paths: ['src/a.ts'] })
    sink.recordUserWrites({ workspaceRoot: '/project', paths: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(recorded, ['src/a.ts', ''])
  })

  void test('agent edits notify the language service by path, skip empty edits, and swallow a failing worker', async () => {
    const notified: Array<{ projectRoot: string; paths: string[] }> = []
    const notify = languageSyncOnAgentEdits({
      projectFilesChanged: async (request) => {
        notified.push(request)
      },
    })
    notify('/project', ['src/a.ts'])
    notify('/project', [])
    assert.deepEqual(notified, [{ projectRoot: '/project', paths: ['src/a.ts'] }])

    const failing = languageSyncOnAgentEdits({
      projectFilesChanged: () => Promise.reject(new Error('worker gone')),
    })
    failing('/project', ['src/a.ts'])
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  void test('the main composition root wires user writes and agent edits into the language service', () => {
    // 用户经 fs IPC 的写入、Agent 在 Platform 里的项目编辑都提前通知；命令的产物由文件监听送到。
    const main = readSource('src/main/index.ts')
    assert.match(main, /registerWorkbenchFsIpc\([\s\S]*?withLanguageSyncOnUserWrites\(providers\.chatRunAttribution, providers\.language\)\s*\)/u)
    assert.match(main, /const syncAgentEdits = languageSyncOnAgentEdits\(providers\.language\)/u)
    assert.match(main, /projectFilesEdited: \(ref, paths\) => syncAgentEdits\(ref\.projectRoot, paths\)/u)
  })
})

void describe('editor re-checks diagnostics when the workspace changes outside the editor', () => {
  void test('git internals alone do not count as a workspace change', () => {
    const event = (paths: string[]) => ({
      kind: 'velaros.systemWorkspaceFilesChanged' as const,
      source: 'filesystem-watch' as const,
      rootPath: '/project',
      paths,
      sessionIds: [],
      changedAt: 0,
    })
    assert.equal(mayAffectWorkbenchDiagnostics(event(['.git/index', '.git/HEAD'])), false)
    assert.equal(mayAffectWorkbenchDiagnostics(event(['.git'])), false)
    assert.equal(mayAffectWorkbenchDiagnostics(event(['.git/index', 'src/dependency.ts'])), true)
    assert.equal(mayAffectWorkbenchDiagnostics(event(['.gitignore'])), true)
    assert.equal(mayAffectWorkbenchDiagnostics(event([])), false)
  })

  void test('the editor controller listens to agent writes and never drops a watch event mid-refresh', () => {
    const controller = readSource('src/renderer/src/hooks/useWorkbenchEditorController.ts')
    assert.match(controller, /subscribeWorkbenchAgentProjectWrites\(activeProjectRootPath, \(\) => \{/u)
    assert.match(controller, /externalFileRefreshQueuedRef\.current = true/u)
    assert.doesNotMatch(controller, /refreshInFlightRef:/u)
    const watchHook = readSource('src/renderer/src/support/useWorkspaceFilesChangedRefresh.ts')
    assert.doesNotMatch(watchHook, /refreshInFlightRef/u)
  })

  void test('the CodeMirror linter re-runs on the external revision instead of only on document edits', () => {
    const editor = readSource('src/renderer/src/components/editor/CodeMirrorEditor.tsx')
    assert.match(editor, /needsRefresh: \(update\) =>/u)
    assert.match(editor, /effect\.is\(externalWorkspaceChange\)/u)
    assert.match(editor, /externalWorkspaceChange\.of\(externalRevision\)/u)
    const insights = readSource('src/renderer/src/hooks/useWorkbenchLanguageServiceInsights.ts')
    // 只是工作区在外面变了：旧诊断留在面板上直到新结果回来，只有内容变了的文件先撤下。
    assert.match(insights, /if \(changedPaths\.size > 0\)\n\s+setDiagnosticsByPath\(\(current\) => omitWorkbenchPendingDiagnostics\(current, changedPaths\)\)/u)
  })
})
