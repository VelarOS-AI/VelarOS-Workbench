import { isNumber,isObject, isPresent, isString, toNullable } from '@velaros-ai/core'

import type { AgentDeveloperContext, AgentSurfaceId } from '../../contracts/index'
import {
  createLocalStorageJsonStore,
  type StorageLike,
} from '../../persistence/localStorageJsonStore'

export const WORKBENCH_CHAT_DRAFT_HANDOFF_STORAGE_KEY = 'velaros.workbench.chat-draft-handoff.v1'
const DEFAULT_MAX_AGE_MS = 60_000
const WorkbenchActionAgentSurfaceId = 'workbench-ai' satisfies AgentSurfaceId

export interface WorkbenchChatDraftHandoff {
  id: string
  prompt: string
  actionRunId: Nullable<string>
  agentSurfaceId: Nullable<AgentSurfaceId>
  projectRoot: Nullable<string>
  developerContext: Nullable<AgentDeveloperContext>
  createdAt: number
}

export interface WorkbenchChatDraftHandoffOptions {
  agentSurfaceId?: LooseOptional<AgentSurfaceId>
  projectRoot?: LooseOptional<string>
}

type WorkbenchChatDraftHandoffTarget =
  | Nullable<AgentSurfaceId>
  | WorkbenchChatDraftHandoffOptions

function createHandoffId(): string {
  return `workbench-draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function normalizeWorkbenchChatHandoffProjectRoot(
  projectRoot: LooseOptional<string>
): Nullable<string> {
  const trimmed = projectRoot?.trim() ?? ''
  if (!trimmed) return null

  const withoutTrailingSeparators = trimmed.replace(/[\\/]+$/g, '')
  return withoutTrailingSeparators || trimmed
}

function resolveHandoffTarget(target: WorkbenchChatDraftHandoffTarget): {
  agentSurfaceId: Nullable<AgentSurfaceId>
  projectRoot: Nullable<string>
} {
  if (isObject(target)) {
    const options = target as WorkbenchChatDraftHandoffOptions
    return {
      agentSurfaceId: toNullable(options.agentSurfaceId ?? WorkbenchActionAgentSurfaceId),
      projectRoot: normalizeWorkbenchChatHandoffProjectRoot(options.projectRoot),
    }
  }

  return {
    agentSurfaceId: toNullable(target),
    projectRoot: null,
  }
}

function normalizeHandoff(value: unknown): Nullable<WorkbenchChatDraftHandoff> {
  if (!value || !isObject(value)) return null

  const parsed = value as Partial<WorkbenchChatDraftHandoff>
  if (
    !isString(parsed.id) ||
    !isString(parsed.prompt) ||
    (isPresent(parsed.actionRunId) && !isString(parsed.actionRunId)) ||
    (isPresent(parsed.agentSurfaceId) && parsed.agentSurfaceId !== WorkbenchActionAgentSurfaceId) ||
    (isPresent(parsed.projectRoot) && !isString(parsed.projectRoot)) ||
    isPresent(parsed.developerContext) ||
    !isNumber(parsed.createdAt)
  ) return null

  return {
    id: parsed.id,
    prompt: parsed.prompt,
    actionRunId: isString(parsed.actionRunId) ? parsed.actionRunId : null,
    agentSurfaceId: toNullable(parsed.agentSurfaceId),
    projectRoot: normalizeWorkbenchChatHandoffProjectRoot(parsed.projectRoot),
    developerContext: null,
    createdAt: parsed.createdAt,
  }
}

const workbenchChatDraftHandoffStore = createLocalStorageJsonStore<
  Nullable<WorkbenchChatDraftHandoff>
>({
  key: WORKBENCH_CHAT_DRAFT_HANDOFF_STORAGE_KEY,
  fallback: null,
  normalize: normalizeHandoff,
})

export function writeWorkbenchChatDraftHandoff(
  prompt: string,
  actionRunId: Nullable<string> = null,
  target: WorkbenchChatDraftHandoffTarget = WorkbenchActionAgentSurfaceId,
  storage?: StorageLike
): Nullable<WorkbenchChatDraftHandoff> {
  const normalizedPrompt = prompt.trim()
  if (!normalizedPrompt) return null

  const { agentSurfaceId, projectRoot } = resolveHandoffTarget(target)
  const handoff: WorkbenchChatDraftHandoff = {
    id: createHandoffId(),
    prompt: normalizedPrompt,
    actionRunId,
    agentSurfaceId,
    projectRoot,
    developerContext: null,
    createdAt: Date.now(),
  }
  workbenchChatDraftHandoffStore.write(handoff, storage)
  return handoff
}

export function takeWorkbenchChatDraftHandoff(
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  storage?: StorageLike
): Nullable<WorkbenchChatDraftHandoff> {
  const handoff = workbenchChatDraftHandoffStore.read(storage)
  workbenchChatDraftHandoffStore.remove(storage)

  if (!handoff || now - handoff.createdAt > maxAgeMs) return null

  return handoff
}
