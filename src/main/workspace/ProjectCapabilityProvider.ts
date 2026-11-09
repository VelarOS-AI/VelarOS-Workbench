import { isAbsolute, resolve } from 'node:path'

import { createProjectKernel, type ProjectKernel } from '@velaros-ai/capabilities/project'
import { isFiniteNumber, optionalWhen } from '@velaros-ai/velaros/core'

import {
  type WorkbenchProjectAiRuleFile,
  type WorkbenchProjectAiRuleSource,
  type WorkbenchProjectAiRulesResult,
} from '../../shared/contracts/workbench'
import type { WorkbenchWorkspaceInvokeRequest } from '../../shared/workbenchWorkspace'

/** 项目 AI 规则文件：与主流编码助手同一套约定，按这些模式在项目里找。 */
const ProjectRulePatterns = [
  '.velar/rules.md',
  'AGENTS.md',
  '**/AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  '.cursor/rules/**',
  '.github/copilot-instructions.md',
]
/** 找规则文件时最深看几层、最多列多少个。 */
const ProjectRuleListLimits = { maxDepth: 4, maxFiles: 500 }
/** 每个规则文件最多读这么多字符。 */
const ProjectRuleFileMaxChars = 64_000

interface WorkbenchProjectCapabilityProvider {
  invoke(request: WorkbenchWorkspaceInvokeRequest): Promise<unknown>
  /** 项目里的 AI 规则文件（设置页展示、每轮交给 Agent 的都是这一份）。 */
  projectRules(projectRoot: string): Promise<WorkbenchProjectAiRulesResult>
  dispose(): Promise<void>
}

interface ProjectCapabilityProviderOptions {
  createKernel?: (projectRoot: string) => Promise<ProjectKernel>
}

/** 一次读多个文件的结果（渲染层按这个形状读）。 */
interface WorkbenchProjectReadManyResult {
  files: Array<{
    snapshot: { path: string; size: number; mtimeMs: number }
    content?: string
    totalLines?: number
    truncated?: boolean
  }>
}

/**
 * IDE 面的项目读取：按项目根缓存一个 Platform 项目内核，给渲染层列文件、读文件与读项目 AI 规则。
 *
 * Agent 的项目操作不走这里——它们在 Platform 运行时自己的项目内核上跑（见 conversation/）。
 */
class ProjectCapabilityProvider implements WorkbenchProjectCapabilityProvider {
  private readonly kernels = new Map<string, Promise<ProjectKernel>>()
  private readonly createKernel: (projectRoot: string) => Promise<ProjectKernel>

  public constructor(options: ProjectCapabilityProviderOptions = {}) {
    this.createKernel =
      options.createKernel ?? ((projectRoot) => createProjectKernel({ root: projectRoot }))
  }

  public async invoke(request: WorkbenchWorkspaceInvokeRequest): Promise<unknown> {
    switch (request.operation) {
      case 'project:list':
        return (await this.kernel(request.projectRoot)).listFiles(
          readObject(request.input) as Parameters<ProjectKernel['listFiles']>[0]
        )
      case 'project:read':
        return this.readMany(request.projectRoot, request.input)
      case 'project:rules':
        return this.projectRules(request.projectRoot)
    }
  }

  public async projectRules(projectRoot: string): Promise<WorkbenchProjectAiRulesResult> {
    const kernel = await this.kernel(projectRoot)
    const listed = await kernel.listFiles({
      path: '.',
      recursive: true,
      include: ProjectRulePatterns,
      ...ProjectRuleListLimits,
    })
    const paths = listed.filter((entry) => entry.type === 'file').map((entry) => entry.path)
    const files: WorkbenchProjectAiRuleFile[] = []
    for (const path of paths) {
      const read = await kernel.read({ path, maxChars: ProjectRuleFileMaxChars }).catch(() => null)
      if (typeof read?.content !== 'string') continue
      const source = ruleSource(path)
      files.push({
        source,
        sourceLabel: source,
        relativePath: read.snapshot.path,
        content: read.content,
        truncated: read.truncated ?? false,
      })
    }
    return {
      projectRoot,
      files,
      totalChars: files.reduce((total, file) => total + file.content.length, 0),
      truncatedFiles: files.filter((file) => file.truncated).length,
      omittedFiles: paths.length - files.length,
    }
  }

  public async dispose(): Promise<void> {
    this.kernels.clear()
  }

  private async readMany(
    projectRoot: string,
    input: unknown
  ): Promise<WorkbenchProjectReadManyResult> {
    const kernel = await this.kernel(projectRoot)
    const { path, maxChars, maxBytes } = readObject(input)
    const paths = Array.isArray(path) ? path : [path]
    const files: WorkbenchProjectReadManyResult['files'] = []
    for (const candidate of paths) {
      if (typeof candidate !== 'string' || !candidate.trim()) continue
      const read = await kernel.read({
        path: candidate,
        maxChars: optionalWhen(isFiniteNumber, maxChars),
        maxBytes: optionalWhen(isFiniteNumber, maxBytes),
      })
      files.push({
        snapshot: {
          path: read.snapshot.path,
          size: read.snapshot.size,
          mtimeMs: read.snapshot.mtimeMs,
        },
        content: read.content,
        totalLines: read.totalLines,
        truncated: read.truncated,
      })
    }
    return { files }
  }

  private kernel(projectRoot: string): Promise<ProjectKernel> {
    const root = normalizeProjectRoot(projectRoot)
    const existing = this.kernels.get(root)
    if (existing) return existing
    const created = this.createKernel(root).catch((error: unknown) => {
      this.kernels.delete(root)
      throw error
    })
    this.kernels.set(root, created)
    return created
  }
}

function ruleSource(path: string): WorkbenchProjectAiRuleSource {
  if (path.startsWith('.velar/')) return 'velar'
  if (path.includes('CLAUDE')) return 'claude'
  if (path.includes('.cursor')) return 'cursor'
  if (path.includes('copilot')) return 'copilot'
  return 'codex'
}

function normalizeProjectRoot(projectRoot: string): string {
  const trimmed = projectRoot.trim()
  if (!trimmed || !isAbsolute(trimmed))
    throw new Error('Project projectRoot must be an absolute path.')
  return resolve(trimmed)
}

function readObject(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {}
}

export { ProjectCapabilityProvider }
export type { ProjectCapabilityProviderOptions, WorkbenchProjectCapabilityProvider }
