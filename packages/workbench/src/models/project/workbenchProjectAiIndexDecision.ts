import { isPlainObject, Log, toNullable } from '@velaros/core'

import {
  createLocalStorageJsonStore,
  type StorageLike,
} from '../../persistence/localStorageJsonStore'

import { resolveWorkbenchProjectForRootPath } from './workbenchProjectResolution'
import { readWorkbenchProjects } from './workbenchProjects'

export type WorkbenchProjectAiIndexDecision = 'skipped'

const STORAGE_KEY = 'velaros.workbench.project-ai-index-decisions.v1'
const log = Log.tag('workbench-project-ai-index-decision')

function normalizeDecisionMap(value: unknown): Record<string, WorkbenchProjectAiIndexDecision> {
  if (!isPlainObject(value)) return {}

  const decisions: Record<string, WorkbenchProjectAiIndexDecision> = {}
  for (const [projectId, decision] of Object.entries(value)) {
    if (decision === 'skipped') {
      decisions[projectId] = decision
    }
  }
  return decisions
}

const workbenchProjectAiIndexDecisionStore = createLocalStorageJsonStore<
  Record<string, WorkbenchProjectAiIndexDecision>
>({
  key: STORAGE_KEY,
  fallback: () => ({}),
  normalize: normalizeDecisionMap,
  log,
  readErrorMessage: '读取项目 AI 索引决策失败，使用空决策表',
  writeErrorMessage: '写入项目 AI 索引决策失败',
})

function readDecisionMap(storage?: StorageLike): Record<string, WorkbenchProjectAiIndexDecision> {
  return workbenchProjectAiIndexDecisionStore.read(storage)
}

function writeDecisionMap(
  decisions: Record<string, WorkbenchProjectAiIndexDecision>,
  storage?: StorageLike
): void {
  workbenchProjectAiIndexDecisionStore.write(decisions, storage)
}

export function getWorkbenchProjectAiIndexDecision(
  projectId: string,
  storage?: Storage
): Nullable<WorkbenchProjectAiIndexDecision> {
  return toNullable(readDecisionMap(storage)[projectId])
}

export function setWorkbenchProjectAiIndexDecision(
  projectId: string,
  decision: WorkbenchProjectAiIndexDecision,
  storage?: Storage
): void {
  writeDecisionMap(
    {
      ...readDecisionMap(storage),
      [projectId]: decision,
    },
    storage
  )
}

export function clearWorkbenchProjectAiIndexDecision(projectId: string, storage?: Storage): void {
  const decisions = readDecisionMap(storage)
  delete decisions[projectId]
  writeDecisionMap(decisions, storage)
}

/** 新建空项目没有可立即分析的代码；按根目录对应的项目 ID 抑制首次自动提示。 */
export function suppressWorkbenchProjectAiIndexPromptForRootPath(
  projectRoot: string,
  storage?: Storage
): string {
  const resolution = resolveWorkbenchProjectForRootPath(projectRoot, readWorkbenchProjects(storage))
  setWorkbenchProjectAiIndexDecision(resolution.project.id, 'skipped', storage)
  return resolution.project.id
}
