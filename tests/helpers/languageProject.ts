import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { WorkbenchLanguageServices } from '../../src/main/workspace/language/LanguageServices'
import { clearTypeScriptProjectCache } from '../../src/main/workspace/language/TypeScriptProjectHost'
import { PathResolver } from '../../src/main/workspace/PathResolver'
import { applyWorkbenchLanguageServiceEditsToContent } from '../../src/renderer/src/models/editor/workbenchCodeMirrorLanguageService'
import type {
  WorkbenchLanguageServiceCodeAction,
  WorkbenchLanguageServiceFileEdit,
  WorkbenchLanguageServicePosition,
  WorkbenchLanguageServiceRange,
} from '../../src/shared/contracts'

/** 标题对得上的那个动作；没有就报出都有哪些。 */
export function findCodeAction(
  actions: readonly WorkbenchLanguageServiceCodeAction[],
  title: RegExp
): WorkbenchLanguageServiceCodeAction {
  const found = actions.find((candidate) => title.test(candidate.title))
  if (!found)
    throw new Error(`no action matches ${title}: ${actions.map((action) => action.title).join(' | ')}`)
  return found
}

/** 把一组改动里落在 `path` 上的那部分套到正文上（与编辑器套没打开的文件同一个算法）。 */
export function applyFileEdits(
  content: string,
  path: string,
  changes: readonly WorkbenchLanguageServiceFileEdit[]
): string {
  const change = changes.find((candidate) => candidate.path === path)
  if (!change) throw new Error(`no edit for ${path}: ${changes.map((item) => item.path).join(', ')}`)
  return applyWorkbenchLanguageServiceEditsToContent(content, change.edits)
}

export const StrictTsconfig = JSON.stringify({
  compilerOptions: {
    module: 'ESNext',
    moduleResolution: 'bundler',
    target: 'ESNext',
    strict: true,
    noUnusedLocals: true,
  },
  include: ['src'],
})

export interface LanguageProjectFixture {
  projectRoot: string
  services: WorkbenchLanguageServices
  read: (path: string) => Promise<string>
  write: (path: string, content: string) => Promise<void>
  dispose: () => Promise<void>
}

/** 临时目录里的一个真实项目（文件按给的内容落盘）与一套真实的语言服务；用完 dispose。 */
export async function createLanguageProject(
  files: Readonly<Record<string, string>>
): Promise<LanguageProjectFixture> {
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'workbench-language-project-')))
  const write = async (path: string, content: string): Promise<void> => {
    await mkdir(dirname(join(projectRoot, path)), { recursive: true })
    await writeFile(join(projectRoot, path), content, 'utf8')
  }
  for (const [path, content] of Object.entries(files)) await write(path, content)
  const services = new WorkbenchLanguageServices(new PathResolver())

  return {
    projectRoot,
    services,
    read: (path) => readFile(join(projectRoot, path), 'utf8'),
    write,
    dispose: async () => {
      await services.dispose()
      clearTypeScriptProjectCache(projectRoot)
      await rm(projectRoot, { recursive: true, force: true })
    },
  }
}

/** `needle` 在正文里第 `occurrence` 次出现处的位置（行列从 1 起，连同偏移）。 */
export function positionOf(
  content: string,
  needle: string,
  occurrence = 1
): Required<WorkbenchLanguageServicePosition> {
  let offset = -1
  for (let index = 0; index < occurrence; index += 1) {
    offset = content.indexOf(needle, offset + 1)
    if (offset < 0) throw new Error(`"${needle}" (#${occurrence}) is not in the content`)
  }
  const before = content.slice(0, offset)
  const line = before.split('\n').length
  return { line, column: offset - (before.lastIndexOf('\n') + 1) + 1, offset }
}

/** 盖住 `needle`（第 `occurrence` 次出现）的范围。 */
export function rangeOf(
  content: string,
  needle: string,
  occurrence = 1
): WorkbenchLanguageServiceRange {
  const start = positionOf(content, needle, occurrence)
  const stop = start.offset + needle.length
  const beforeStop = content.slice(0, stop)
  return {
    startLine: start.line,
    startColumn: start.column,
    endLine: beforeStop.split('\n').length,
    endColumn: stop - (beforeStop.lastIndexOf('\n') + 1) + 1,
  }
}
