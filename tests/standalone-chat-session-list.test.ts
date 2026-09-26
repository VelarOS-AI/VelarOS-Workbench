import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import type { WorkbenchChatSessionGroup } from '../src/renderer/src/composition'
import {
  getMostRecentlyUpdatedWorkbenchProjectChatGroup,
  isWorkbenchProjectChatGroup,
} from '../src/renderer/src/models/chat/workbenchChatSessionGroups'
import {
  projectStandaloneSessionGroups,
  standaloneProjectFolderId,
  type StandaloneSessionListEntry,
} from '../src/renderer/src/runtime/standaloneChatSessionList'

const Root = '/work/project'
const FolderId = standaloneProjectFolderId(Root)

/** WorkbenchChatPanel 的就绪判定：认项目里最近更新的会话组，它必须就是当前活跃的文件夹。 */
function isPanelReady(groups: readonly WorkbenchChatSessionGroup[], currentFolderId: string): boolean {
  const activeGroup = getMostRecentlyUpdatedWorkbenchProjectChatGroup(
    groups.filter((group) => isWorkbenchProjectChatGroup(group, Root))
  )
  return !!activeGroup && activeGroup.folderId === FolderId && currentFolderId === activeGroup.folderId
}

function entry(overrides: Partial<StandaloneSessionListEntry>): StandaloneSessionListEntry {
  return {
    sessionId: 'session',
    title: '',
    projectRoot: Root,
    updatedAt: 0,
    isEmpty: true,
    isStreaming: false,
    ...overrides,
  }
}

void describe('standalone chat session list', () => {
  void test('gives each project one folder, the id the built-in agent always had', () => {
    // 只剩内置 Agent：不再按服务商分文件夹，身份仍是旧版内置 Agent 的那一份，只随项目根变。
    assert.equal(FolderId, 'workbench-project:workbench:/work/project')
    assert.notEqual(standaloneProjectFolderId('/work/other'), FolderId)
  })

  void test('a freshly created empty session is ready at once and listed with the older ones', () => {
    const older = entry({ sessionId: 'older', title: 'Kernel 设计', updatedAt: 1_757_000_000_000, isEmpty: false })
    const created = entry({ sessionId: 'created' })
    const groups = projectStandaloneSessionGroups({
      folderId: FolderId,
      projectRoot: Root,
      activeSessionId: 'created',
      title: '',
      entries: [created, older],
    })

    // 新建的空会话更新时间是 0：每个会话各自成组时面板会认回旧会话的组，一直停在加载态。
    assert.equal(isPanelReady(groups, FolderId), true)
    assert.equal(groups.length, 1)
    assert.equal(groups[0]?.activeMemberItemId, 'created')
    assert.deepEqual(groups[0]?.members.map((member) => member.memberSessionId), ['created', 'older'])
    assert.equal(groups[0]?.updatedAt, older.updatedAt)
  })

  void test('has no folder without a project root', () => {
    assert.deepEqual(
      projectStandaloneSessionGroups({
        folderId: FolderId,
        projectRoot: '',
        activeSessionId: 'x',
        title: '',
        entries: [entry({ sessionId: 'x' })],
      }),
      []
    )
  })
})
