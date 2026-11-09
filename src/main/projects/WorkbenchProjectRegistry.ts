import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { isFiniteNumber, isNonBlankString, isPlainObject } from '@velaros-ai/velaros/core'
import { AppError } from '@velaros-ai/velaros/core/error'
import { writeFileAtomically } from '@velaros-ai/velaros/core/utils/FilePersistence'

import type { WorkbenchProject } from '../../shared/projectHub'

/** 独立于最近项目裁剪的 IDE 身份登记；所有窗口共享唯一主进程写入队列。 */
export class WorkbenchProjectRegistry {
  private readonly path: string
  private projects?: readonly WorkbenchProject[]
  private tail: Promise<void> = Promise.resolve()

  public constructor(dataRoot: string) {
    this.path = join(dataRoot, 'storage', 'project-registry.json')
  }

  public resolve(rootPath: string, legacyProjects: unknown): Promise<WorkbenchProject> {
    const pending = this.tail.then(async () => {
      const projects = this.projects ?? (await this.read(legacyProjects))
      const root = resolve(rootPath)
      const existing = projects.find((project) => resolve(project.rootPath) === root)
      const now = Date.now()
      const project: WorkbenchProject = existing
        ? { ...existing, rootPath: root, lastOpenedAt: now }
        : {
            id: `project-${randomUUID()}`,
            rootPath: root,
            name: basename(root) || root,
            createdAt: now,
            lastOpenedAt: now,
            pinned: false,
          }
      const next = existing
        ? projects.map((entry) => (entry.id === existing.id ? project : entry))
        : [...projects, project]
      await mkdir(dirname(this.path), { recursive: true })
      await writeFileAtomically(
        this.path,
        JSON.stringify({ version: 1, sourceKey: 'velaros.workbench.projects.v1', projects: next }),
        { mode: 0o600 }
      )
      this.projects = next
      return project
    })
    this.tail = pending.then(
      () => {},
      () => {}
    )
    return pending
  }

  private async read(legacyProjects: unknown): Promise<WorkbenchProject[]> {
    let source: string
    try {
      source = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return readProjects(legacyProjects)
    }
    const document: unknown = JSON.parse(source)
    if (!isPlainObject(document) || document.version !== 1 || !Array.isArray(document.projects))
      throw new AppError('VALIDATION', 'Workbench project registry is invalid')
    const projects = readProjects(document.projects)
    if (projects.length !== document.projects.length)
      throw new AppError('VALIDATION', 'Workbench project registry contains invalid identities')
    return projects
  }
}

function readProjects(value: unknown): WorkbenchProject[] {
  if (!Array.isArray(value)) return []
  const roots = new Set<string>()
  const ids = new Set<string>()
  const projects: WorkbenchProject[] = []
  for (const entry of value) {
    if (
      !isPlainObject(entry) ||
      !isNonBlankString(entry.id) ||
      !isNonBlankString(entry.name) ||
      !isNonBlankString(entry.rootPath) ||
      !isAbsolute(entry.rootPath) ||
      !isFiniteNumber(entry.createdAt) ||
      !(entry.lastOpenedAt === null || isFiniteNumber(entry.lastOpenedAt)) ||
      typeof entry.pinned !== 'boolean'
    )
      continue
    const rootPath = resolve(entry.rootPath)
    if (roots.has(rootPath) || ids.has(entry.id)) continue
    roots.add(rootPath)
    ids.add(entry.id)
    projects.push({
      id: entry.id,
      name: entry.name,
      rootPath,
      createdAt: entry.createdAt,
      lastOpenedAt: entry.lastOpenedAt,
      pinned: entry.pinned,
    })
  }
  return projects
}
