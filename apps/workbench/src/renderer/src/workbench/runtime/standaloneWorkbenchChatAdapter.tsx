/**
 * 独立 Workbench 应用的惰性聊天装配适配器。
 *
 * 页面 model 无条件消费 `useWorkbenchChatProjectRuntime`（chat 会话投影）；kernel-protocol
 * 客户端接入前（Phase 3），独立应用安装本 inert 适配器：恒返回空会话快照、所有动作 no-op、
 * 会话面渲染为空。引用全部取模块级常量，保证 hook 返回面跨渲染稳定。
 */
import type { ReactElement } from 'react'

import { WorkspaceSpaceKind } from '@velaros-ai/core/constants/workspaceSpaces'
import type {
  WorkbenchChatCompositionAdapter,
  WorkbenchChatProjectRuntime,
  WorkbenchChatSessionSnapshot,
} from '@velaros-ai/workbench/composition'

const StandaloneInertChatSession: WorkbenchChatSessionSnapshot = {
  id: 'standalone-workbench:no-chat-session',
  folderId: 'standalone-workbench:no-chat-folder',
  kind: 'chat',
  rootPath: null,
  space: WorkspaceSpaceKind.Project,
  workspaceVersion: 0,
  messages: [],
  runtime: {
    status: 'idle',
    lastRunStartedAt: null,
    lastRunFinishedAt: null,
  },
  activeBranchId: 'main',
  messagePaging: null,
  messageRunMarkers: [],
  workerThreads: [],
}

const StandaloneInertChatRuntimeBase: Omit<WorkbenchChatProjectRuntime, 'projectRoot'> = {
  currentSession: StandaloneInertChatSession,
  sessions: [],
  conversationVersion: 0,
  browserActivationToken: null,
  sessionList: {
    activeMemberSessionId: '',
    activeSessionId: '',
    deletingSessionId: null,
    diskSessionHydrated: true,
    groups: [],
    archiveGroups: [],
  },
  actions: {
    addProjectSession: () => Promise.resolve(false),
    archiveSession: () => Promise.resolve(),
    selectSession: () => undefined,
    startProjectChat: () => '',
  },
}

function StandaloneInertChatSessionSurface(): ReactElement {
  return <></>
}

export const standaloneWorkbenchChatAdapter: WorkbenchChatCompositionAdapter = {
  useProjectRuntime: (projectRoot) => ({
    ...StandaloneInertChatRuntimeBase,
    projectRoot,
  }),
  SessionSurface: StandaloneInertChatSessionSurface,
}
