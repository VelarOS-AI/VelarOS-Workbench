import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, test } from 'bun:test'

import { InMemoryContextPayloadStore } from '@velaros-ai/agent'
import { type ApprovalPort, fileContextFor } from '@velaros-ai/agent/tool-contract'
import { ProjectError, type ProjectKernel } from '@velaros-ai/project/runtime'

import type { WorkbenchAgentProjectActivityPort } from '../src/main/workspace/git/WorkbenchChatRunAttribution'
import type { WorkbenchVelarLogicGraphService } from '../src/main/workspace/language/WorkbenchVelarLogicGraphService'
import { ProjectCapabilityProvider } from '../src/main/workspace/ProjectCapabilityProvider'

void describe('Project capability provider', () => {
  void test('creates one injected Project kernel per root and invokes it', async () => {
    let created = 0
    const calls: unknown[] = []
    const provider = new ProjectCapabilityProvider({
      createKernel: async () => {
        created += 1
        return {
          // providers 是内核契约的一部分：宿主要往里装审批 provider，桩件不能少这一格。
          providers: {},
          listFiles: async (input: unknown) => {
              calls.push(input)
              return [{ path: 'src/index.ts', type: 'file' }]
          },
        } as unknown as ProjectKernel
      },
    })

    const first = await provider.invoke({
      projectRoot: '/tmp/workbench-project',
      operation: 'project:list',
      input: { recursive: true },
    })
    const second = await provider.invoke({
      projectRoot: '/tmp/workbench-project',
      operation: 'project:list',
      input: { recursive: false },
    })

    assert.deepEqual(first, [{ path: 'src/index.ts', type: 'file' }])
    assert.deepEqual(second, [{ path: 'src/index.ts', type: 'file' }])
    assert.equal(created, 1)
    assert.deepEqual(calls, [{ recursive: true }, { recursive: false }])
    await provider.dispose()
  })

  void test('keeps the six everyday Project tools resident and analysis/change available for discovery', async () => {
    const provider = new ProjectCapabilityProvider({
      createKernel: async () => ({ providers: {} }) as unknown as ProjectKernel,
    })
    const project = await provider.resolveProject('/tmp/workbench-project')

    assert.deepEqual(
      [...project.initialVisibleToolNames].sort(),
      ['project:read', 'project:list', 'project:search', 'project:file', 'project:edit', 'project:run'].sort()
    )
    assert.ok(project.tools.some((tool) => tool.name === 'project:change'))
    assert.ok(project.tools.some((tool) => tool.name === 'project:code'))
    await provider.dispose()
  })

  void test('reports an actionable scope error for a command cwd outside the project', async () => {
    const provider = new ProjectCapabilityProvider({
      createKernel: async () => ({ providers: {} }) as unknown as ProjectKernel,
    })
    try {
      const project = await provider.resolveProject('/tmp/workbench-project')
      const tool = project.tools.find((candidate) => candidate.name === 'project:run')!
      const parsed = tool.schema.safeParse({ command: 'echo must-not-run', cwd: '..' })
      assert(parsed.success)
      await assert.rejects(
        async () => tool.execute(parsed.data, {
          abortSignal: new AbortController().signal,
        }),
        (error: unknown) => {
          assert.ok(error instanceof ProjectError)
          assert.equal(error.reason, 'SCOPE_VIOLATION')
          assert.deepEqual(error.details, {
            projectRoot: '/tmp/workbench-project',
            activeDirectory: '/tmp/workbench-project',
            requestedPath: '..',
            resolvedPath: '/tmp',
          })
          assert.match(error.suggestedNextAction ?? '', /cwd/)
          return true
        },
      )
    } finally {
      await provider.dispose()
    }
  })

  void test('rejects relative roots before constructing a module', async () => {
    const provider = new ProjectCapabilityProvider({
      createKernel: async () => {
        throw new Error('must not construct')
      },
    })
    await assert.rejects(
      provider.invoke({
        projectRoot: 'relative/project',
        operation: 'project:status',
        input: {},
      }),
      /absolute path/
    )
  })

  void test('reads a real project file through the Project owner', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'velaros-workbench-workspace-'))
    const provider = new ProjectCapabilityProvider()
    try {
      await writeFile(
        join(projectRoot, 'kernel-contract.txt'),
        'workspace-owner-read',
        'utf8'
      )

      const result = await provider.invoke({
        projectRoot,
        operation: 'project:read',
        input: { path: 'kernel-contract.txt', maxChars: 1_024 },
      }) as {
        rootPath: string
        count: number
        files: Array<{
          snapshot: { path: string }
          content: string
        }>
      }

      assert.equal(result.rootPath, projectRoot)
      assert.equal(result.count, 1)
      assert.equal(result.files[0]?.snapshot.path, 'kernel-contract.txt')
      assert.equal(result.files[0]?.content, 'workspace-owner-read')
    } finally {
      await provider.dispose()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('routes the canonical AI code query to the Velar compiler graph without a CodeGraph index', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'velaros-workbench-velar-ai-'))
    const calls: unknown[] = []
    const velarLogicGraph = {
      isProject: () => true,
      queryProjectCode: async (_root: string, input: unknown) => {
        calls.push(input)
        return { source: 'velar-compiler', provider: 'velar-compiler', nodes: [{ id: 'app', name: 'App', path: 'app.velar' }] }
      },
      clear: () => undefined,
    } as unknown as WorkbenchVelarLogicGraphService
    const provider = new ProjectCapabilityProvider({
      velarLogicGraph,
      createKernel: async () =>
        ({ root: projectRoot, providers: {}, listFiles: async () => [] }) as unknown as ProjectKernel,
    })
    try {
      const project = await provider.resolveProject(projectRoot)
      const queryCode = project.tools.find((tool) => tool.name === 'project:code')
      assert.ok(queryCode)
      const result = await queryCode.execute({
        action: 'symbols',
        query: 'App',
        limit: 20,
      }, {}) as { source: string; provider: string }

      assert.deepEqual(calls, [{ action: 'search_symbols', query: 'App', limit: 20, kind: undefined }])
      assert.equal(result.source, 'velar-compiler')
      assert.equal(result.provider, 'velar-compiler')
      await assert.rejects(
        provider.invoke({
          projectRoot,
          operation: 'project:codegraph-index',
          input: { force: true },
        }),
        /compiler-owned structure graph, not CodeGraph/
      )
    } finally {
      await provider.dispose()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  void test('reports the agent’s file writes and the time its commands run to the run attribution', async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'velaros-workbench-activity-')))
    const provider = new ProjectCapabilityProvider()
    const reports: unknown[] = []
    const projectActivity: WorkbenchAgentProjectActivityPort = {
      beginFileWrite: () => {
        reports.push('write:start')
        return (paths) => reports.push(['write:end', [...paths]])
      },
      beginCommand: () => {
        reports.push('command:start')
        return () => reports.push('command:end')
      },
    }
    const approval: ApprovalPort = {
      awaitConfirmation: async () => undefined,
      awaitConfirmationDecision: async () => ({ approved: true, message: null }),
    }
    const toolContext = { abortSignal: new AbortController().signal, approval, projectActivity, codingSession: {}, sessionId: 'attribution', contextPayloadStore: new InMemoryContextPayloadStore() }
    try {
      const project = await provider.resolveProject(projectRoot)
      const run = (name: string, input: unknown) => {
        const tool = project.tools.find((candidate) => candidate.name === name)
        assert.ok(tool, name)
        return tool.execute(input, toolContext) as Promise<Record<string, unknown>>
      }

      await run('project:file', { actions: [{ op: 'create', path: 'notes/a.md', text: 'first\n' }] })
      const editTool = project.tools.find((tool) => tool.name === 'project:edit')!
      const edit = async (oldText: string, newText: string) => {
        const read = await run('project:read', { path: 'notes/a.md' })
        const visible = await fileContextFor(toolContext)!.finalizeModelResult(read) as { files: Array<{ fileRef: string }> }
        const input = { files: [{ fileRef: visible.files[0]!.fileRef, edits: [{ op: 'replace', range: 1, match: oldText, text: newText }] }] }
        const parsed = editTool.schema.safeParse(input)
        assert(parsed.success)
        return run('project:edit', parsed.data)
      }
      const edited = await edit('first', 'second')
      await run('project:change', { action: 'undo', changeRef: edited.changeRef })
      await run('project:read', { path: 'notes/a.md' })
      await run('project:run', { command: 'echo built > out.txt' })
      // 失败的写入也要收尾（报空清单），不留一个永远没结束的写入窗。
      await assert.rejects(() => edit('missing', 'x'))

      assert.deepEqual(reports, [
        'write:start', ['write:end', ['notes/a.md']],
        'write:start', ['write:end', ['notes/a.md']],
        'write:start', ['write:end', ['notes/a.md']],
        'command:start', 'command:end',
        'write:start', ['write:end', []],
      ])
      assert.equal(await readFile(join(projectRoot, 'notes', 'a.md'), 'utf8'), 'first\n')
      assert.equal(await readFile(join(projectRoot, 'out.txt'), 'utf8'), 'built\n')
    } finally {
      await provider.dispose()
      await rm(projectRoot, { recursive: true, force: true })
    }
  }, 30_000)
})
