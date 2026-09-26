import type { WorkbenchChatSessionGroup } from '@renderer/composition'

/**
 * 独立 Workbench 的会话列表投影。
 *
 * 会话面板（WorkbenchChatPanel）与组合契约的形状是「一个项目一个会话文件夹，会话是它的成员」
 * （与 Desktop 同形）：面板认项目的文件夹，在它的成员里切换、新建、归档当前会话。
 * 每个会话各自当一个组时，新建的空会话更新时间是 0，面板仍认上一个会话的组、活跃文件夹对不上，
 * 就一直停在加载态；会话菜单也只列得出一个会话。
 */
export interface StandaloneSessionListEntry {
  readonly sessionId: string
  readonly title: string
  readonly projectRoot: string
  readonly updatedAt: number
  readonly isEmpty: boolean
  readonly isStreaming: boolean
}

export function standaloneProjectFolderId(projectRoot: string): string {
  return `workbench-project:workbench:${projectRoot}`
}

/** `entries` 按面板要列的顺序给（当前会话在前，其余按最近使用）；没有项目根时没有文件夹。 */
export function projectStandaloneSessionGroups(input: {
  folderId: string
  projectRoot: string
  activeSessionId: string
  title: string
  entries: readonly StandaloneSessionListEntry[]
}): WorkbenchChatSessionGroup[] {
  if (!input.projectRoot) return []
  const members = input.entries.map((entry) => ({
    itemId: entry.sessionId,
    memberSessionId: entry.sessionId,
    title: entry.title,
    workspaceTitle: '',
    workspaceRoot: entry.projectRoot,
    updatedAt: entry.updatedAt,
    isEmpty: entry.isEmpty,
    isStreaming: entry.isStreaming,
  }))
  return [{
    folderId: input.folderId,
    title: input.title,
    kind: 'chat',
    surfaceScope: { surface: 'workbench', projectRoot: input.projectRoot },
    archivedAt: null,
    updatedAt: Math.max(0, ...members.map((member) => member.updatedAt)),
    memberSessionIds: members.map((member) => member.memberSessionId),
    activeMemberItemId: input.activeSessionId,
    members,
  }]
}
