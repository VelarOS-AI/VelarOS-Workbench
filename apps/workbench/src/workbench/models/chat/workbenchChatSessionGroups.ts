import { toNullable } from '@velaros-ai/core'
export interface WorkbenchProjectChatGroupCandidate {
  kind: string
  surfaceScope?: LooseOptional<{
    surface?: LooseOptional<string>
    projectRoot?: LooseOptional<string>
  }>
  members: readonly WorkbenchProjectChatMemberCandidate[]
  updatedAt?: LooseOptional<number>
}

export interface WorkbenchProjectChatMemberCandidate {
  updatedAt?: LooseOptional<number>
  workspaceRoot?: LooseOptional<string>
}

function normalizeWorkbenchProjectRoot(projectRoot: string): string {
  return projectRoot.trim()
}

function readUpdatedAt(value: LooseOptional<number>): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function getWorkbenchProjectChatGroupUpdatedAt(
  group: WorkbenchProjectChatGroupCandidate
): number {
  return Math.max(
    readUpdatedAt(group.updatedAt),
    ...group.members.map((member) => readUpdatedAt(member.updatedAt))
  )
}

export function getMostRecentlyUpdatedWorkbenchProjectChatGroup<
  T extends WorkbenchProjectChatGroupCandidate,
>(groups: readonly T[]): T | undefined {
  let latestGroup: T | undefined
  let latestUpdatedAt = Number.NEGATIVE_INFINITY

  for (const group of groups) {
    const updatedAt = getWorkbenchProjectChatGroupUpdatedAt(group)
    if (latestGroup && updatedAt <= latestUpdatedAt) continue

    latestGroup = group
    latestUpdatedAt = updatedAt
  }

  return latestGroup
}

export function isWorkbenchProjectChatGroup(
  group: WorkbenchProjectChatGroupCandidate,
  projectRoot: string
): boolean {
  const normalizedProjectRoot = normalizeWorkbenchProjectRoot(projectRoot)
  if (!normalizedProjectRoot || group.kind !== 'chat') return false

  const surfaceScope = toNullable(group.surfaceScope)
  if (!surfaceScope) return false

  return (
    surfaceScope.surface === 'workbench' &&
    surfaceScope.projectRoot === normalizedProjectRoot
  )
}
