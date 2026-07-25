import { isArray, isBoolean, isNumber, isObject, isPlainObject, isPresent, isString, Log, toNullable } from '@velaros/core'

import { createLocalStorageJsonStore, type StorageLike } from '../../persistence/localStorageJsonStore'

import type { WorkbenchActionPromptId } from './workbenchActionPrompts'
import type { WorkbenchActionRunVerificationEvidence } from './workbenchActionResultEvidence'

export const WORKBENCH_ACTION_RUNS_STORAGE_KEY = 'velaros.workbench.action-runs.v1'
const MAX_RUNS_PER_PROJECT = 20
const MAX_CHANGED_FILES_PER_RUN = 8
const log = Log.tag('workbench-action-runs')

export type WorkbenchActionRunStatus = 'drafted' | 'dispatched' | 'completed' | 'failed'

export interface WorkbenchActionRunRecord {
  id: string
  projectId: string
  actionId: WorkbenchActionPromptId
  targetPath: Nullable<string>
  command: Nullable<string>
  sessionId: Nullable<string>
  promptPreview: string
  status: WorkbenchActionRunStatus
  createdAt: number
  updatedAt: number
  dispatchedAt: Nullable<number>
  completedAt: Nullable<number>
  resultStatus: Nullable<string>
  resultSummary: Nullable<string>
  resultDetails: Nullable<string>
  changedFiles: string[]
  verificationEvidence: Nullable<WorkbenchActionRunVerificationEvidence>
}

interface WorkbenchActionRunStore {
  [projectId: string]: WorkbenchActionRunRecord[]
}

const workbenchActionRunsStore = createLocalStorageJsonStore<WorkbenchActionRunStore>({
  key: WORKBENCH_ACTION_RUNS_STORAGE_KEY,
  fallback: () => ({}),
  normalize: (value) => (isPlainObject(value) ? (value as WorkbenchActionRunStore) : {}),
  log,
  readErrorMessage: '读取 workbench action 运行记录失败，使用空记录',
  writeErrorMessage: '写入 workbench action 运行记录失败',
})

interface CreateWorkbenchActionRunInput {
  projectId: string
  actionId: WorkbenchActionPromptId
  targetPath: Nullable<string>
  command?: LooseOptional<string>
  prompt: string
}

function createRunId(): string {
  return `workbench-action-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizePromptPreview(prompt: string): string {
  return prompt.trim().replace(/\s+/g, ' ').slice(0, 160)
}

function normalizeChangedFiles(value: any): string[] {
  if (!isArray(value)) return []

  return [
    ...new Set(
      value
        .filter((path): path is string => isString(path))
        .map((path) => path.trim())
        .filter((path) => path.length > 0)
    ),
  ].slice(0, MAX_CHANGED_FILES_PER_RUN)
}

function isVerificationEvidence(value: any): value is WorkbenchActionRunVerificationEvidence {
  if (!isPlainObject(value)) return false

  const candidate = value as Partial<WorkbenchActionRunVerificationEvidence>
  return (
    (!isPresent(candidate.command) || isString(candidate.command)) &&
    (!isPresent(candidate.success) || isBoolean(candidate.success)) &&
    (!isPresent(candidate.exitCode) || isNumber(candidate.exitCode)) &&
    (!isPresent(candidate.summary) || isString(candidate.summary))
  )
}

function readWorkbenchActionRunStore(storage?: StorageLike): WorkbenchActionRunStore {
  return workbenchActionRunsStore.read(storage)
}

function isActionRunRecord(value: any): value is WorkbenchActionRunRecord {
  if (!value || !isObject(value)) return false

  const candidate = value as Partial<WorkbenchActionRunRecord>
  return (
    isString(candidate.id) &&
    isString(candidate.projectId) &&
    isString(candidate.actionId) &&
    (!isPresent(candidate.targetPath) || isString(candidate.targetPath)) &&
    (!isPresent(candidate.command) || isString(candidate.command)) &&
    (!isPresent(candidate.sessionId) || isString(candidate.sessionId)) &&
    isString(candidate.promptPreview) &&
    (candidate.status === 'drafted' ||
      candidate.status === 'dispatched' ||
      candidate.status === 'completed' ||
      candidate.status === 'failed') &&
    isNumber(candidate.createdAt) &&
    isNumber(candidate.updatedAt) &&
    (!isPresent(candidate.dispatchedAt) || isNumber(candidate.dispatchedAt)) &&
    (!isPresent(candidate.completedAt) || isNumber(candidate.completedAt)) &&
    (!isPresent(candidate.resultStatus) || isString(candidate.resultStatus)) &&
    (!isPresent(candidate.resultSummary) || isString(candidate.resultSummary)) &&
    (!isPresent(candidate.resultDetails) || isString(candidate.resultDetails)) &&
    (!isPresent(candidate.changedFiles) ||
      (isArray(candidate.changedFiles) &&
        candidate.changedFiles.every((path) => isString(path)))) &&
    (!isPresent(candidate.verificationEvidence) ||
      isVerificationEvidence(candidate.verificationEvidence))
  )
}

function normalizeActionRunRecord(run: WorkbenchActionRunRecord): WorkbenchActionRunRecord {
  return {
    ...run,
    sessionId: toNullable(run.sessionId),
    dispatchedAt: toNullable(run.dispatchedAt),
    completedAt: toNullable(run.completedAt),
    resultStatus: toNullable(run.resultStatus),
    resultSummary: toNullable(run.resultSummary),
    resultDetails: toNullable(run.resultDetails),
    changedFiles: normalizeChangedFiles(run.changedFiles),
    verificationEvidence: isVerificationEvidence(run.verificationEvidence)
      ? run.verificationEvidence
      : null,
  }
}

function writeWorkbenchActionRunStore(store: WorkbenchActionRunStore, storage?: StorageLike): void {
  workbenchActionRunsStore.write(store, storage)
}

export function readWorkbenchActionRuns(
  projectId: string,
  storage?: StorageLike
): WorkbenchActionRunRecord[] {
  const store = readWorkbenchActionRunStore(storage)
  const runs = isArray(store[projectId]) ? store[projectId] : []

  return runs
    .filter(isActionRunRecord)
    .map(normalizeActionRunRecord)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_RUNS_PER_PROJECT)
}

export function createWorkbenchActionRun(
  input: CreateWorkbenchActionRunInput,
  storage?: StorageLike
): WorkbenchActionRunRecord {
  const now = Date.now()
  const run: WorkbenchActionRunRecord = {
    id: createRunId(),
    projectId: input.projectId,
    actionId: input.actionId,
    targetPath: input.targetPath,
    command: input.command?.trim() || null,
    sessionId: null,
    promptPreview: normalizePromptPreview(input.prompt),
    status: 'drafted',
    createdAt: now,
    updatedAt: now,
    dispatchedAt: null,
    completedAt: null,
    resultStatus: null,
    resultSummary: null,
    resultDetails: null,
    changedFiles: [],
    verificationEvidence: null,
  }
  const store = readWorkbenchActionRunStore(storage)
  const projectRuns = [run, ...readWorkbenchActionRuns(input.projectId, storage)].slice(
    0,
    MAX_RUNS_PER_PROJECT
  )

  writeWorkbenchActionRunStore(
    {
      ...store,
      [input.projectId]: projectRuns,
    },
    storage
  )

  return run
}

export function markWorkbenchActionRunDispatched(
  runId: string,
  sessionId: Nullable<string> = null,
  storage?: StorageLike
): Nullable<WorkbenchActionRunRecord> {
  const store = readWorkbenchActionRunStore(storage)
  const now = Date.now()
  let updatedRun: Nullable<WorkbenchActionRunRecord> = null
  const nextStore = Object.fromEntries(
    Object.entries(store).map(([projectId, runs]) => [
      projectId,
      isArray(runs)
        ? runs.map((run) => {
            if (!isActionRunRecord(run) || run.id !== runId) return run

            updatedRun = {
              ...normalizeActionRunRecord(run),
              sessionId,
              status: 'dispatched',
              updatedAt: now,
              dispatchedAt: now,
            }
            return updatedRun
          })
        : runs,
    ])
  )

  if (updatedRun) {
    writeWorkbenchActionRunStore(nextStore, storage)
  }

  return updatedRun
}

export function markWorkbenchActionRunFinished(
  runId: string,
  result: {
    status: 'completed' | 'failed'
    resultStatus: string
    resultSummary?: LooseOptional<string>
    resultDetails?: LooseOptional<string>
    changedFiles?: string[]
    verificationEvidence?: LooseOptional<WorkbenchActionRunVerificationEvidence>
  },
  storage?: StorageLike
): Nullable<WorkbenchActionRunRecord> {
  const store = readWorkbenchActionRunStore(storage)
  const now = Date.now()
  let updatedRun: Nullable<WorkbenchActionRunRecord> = null
  const resultSummary = result.resultSummary?.trim() || null
  const resultDetails = result.resultDetails?.trim() || null
  const changedFiles = normalizeChangedFiles(result.changedFiles)
  const verificationEvidence = isVerificationEvidence(result.verificationEvidence)
    ? result.verificationEvidence
    : null
  const nextStore = Object.fromEntries(
    Object.entries(store).map(([projectId, runs]) => [
      projectId,
      isArray(runs)
        ? runs.map((run) => {
            if (!isActionRunRecord(run) || run.id !== runId) return run

            updatedRun = {
              ...normalizeActionRunRecord(run),
              status: result.status,
              updatedAt: now,
              completedAt: now,
              resultStatus: result.resultStatus,
              resultSummary,
              resultDetails,
              changedFiles,
              verificationEvidence,
            }
            return updatedRun
          })
        : runs,
    ])
  )

  if (updatedRun) {
    writeWorkbenchActionRunStore(nextStore, storage)
  }

  return updatedRun
}
