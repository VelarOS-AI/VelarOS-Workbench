import {
  type ComponentType,
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
} from 'react'

import { type ChatMessage } from '@velaros-ai/ui/conversation/contracts'
import { type BrowserElementSelection } from '@velaros-ai/velaros/browser/contracts'

import { type SystemFileChangePreviewResult } from '@shared/contracts/system'
import type {
  WorkbenchAgentEngineId,
  WorkbenchConversationEngineSelection,
} from '@shared/workbenchConversation'
import type { WorkbenchChatRunChangesSummary } from '@shared/workbenchGit'

import type { WorkbenchChatSurfaceScope } from './workbenchChatComposition'

export type WorkbenchChatRunStatus =
  | 'idle'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'aborted'
  | 'failed'
  | 'awaiting-confirmation'
  | 'awaiting-input'

export interface WorkbenchChatMessagePaging {
  loadedFromIndex: number
  totalCount: number
}

/**
 * 正在跑的这一轮的「本轮改动」：运行中每有写入就实时采集一次，与收尾时的最终采集是同一条记录；
 * 最终摘要挂上运行标记时它就撤下。
 */
export interface WorkbenchChatLiveRunChanges {
  /** 这一轮开跑时会话里已有的消息数：这一轮的消息都排在它之后。 */
  readonly firstMessageIndex: number
  readonly summary: WorkbenchChatRunChangesSummary
}

export interface WorkbenchChatSessionSnapshot {
  readonly id: string
  readonly folderId: string
  readonly kind: 'chat'
  readonly engine: Nullable<WorkbenchConversationEngineSelection>
  readonly rootPath: Nullable<string>
  readonly space: 'project'
  readonly workspaceVersion: number
  readonly messages: readonly ChatMessage[]
  readonly runtime: {
    readonly status: WorkbenchChatRunStatus
    readonly lastRunStartedAt: Nullable<number>
    readonly lastRunFinishedAt: Nullable<number>
  }
  readonly activeBranchId: string
  readonly messagePaging: LooseOptional<WorkbenchChatMessagePaging>
  readonly messageRunMarkers: ReadonlyArray<{
    readonly messageId: string
    readonly timestamp: number
    /** 这一轮的「本轮改动」摘要（补丁全文在主进程的记录文件里，按 recordId 读）。 */
    readonly runChanges?: WorkbenchChatRunChangesSummary
  }>
  /** 这一轮还在跑、已经采到改动时才有。 */
  readonly liveRunChanges: Nullable<WorkbenchChatLiveRunChanges>
  readonly workerThreads: ReadonlyArray<{
    readonly messages: readonly ChatMessage[]
  }>
}

export interface WorkbenchChatSessionMember {
  readonly itemId: string
  readonly memberSessionId: string
  readonly title: string
  readonly workspaceTitle: string
  readonly workspaceRoot: Nullable<string>
  readonly updatedAt: number
  readonly isEmpty: boolean
  readonly isStreaming: boolean
}

export interface WorkbenchChatSessionGroup {
  readonly folderId: string
  readonly title: string
  readonly kind: 'chat'
  readonly surfaceScope: Nullable<WorkbenchChatSurfaceScope>
  readonly archivedAt: Nullable<number>
  readonly updatedAt: number
  readonly memberSessionIds: readonly string[]
  readonly activeMemberItemId: string
  readonly members: readonly WorkbenchChatSessionMember[]
}

/**
 * 项目级聊天运行时：当前会话是谁、会话列表、各会话的运行标记。
 *
 * 它由整个 Workbench 页面模型订阅，**不随流式输出逐 token 更新**——只在会话列表、标题、运行起止、
 * 运行标记这些项目级字段变化时换一份（否则文件树、编辑区会跟着回答整页重渲染）。因此快照里的
 * `messages` 与 `conversationVersion` 停在最近一次项目级变化；要跟着回答实时变的只有会话 Surface，
 * 它自己订阅会话状态。
 */
export interface WorkbenchChatProjectRuntime {
  readonly projectRoot: Nullable<string>
  readonly currentSession: WorkbenchChatSessionSnapshot
  readonly sessions: readonly WorkbenchChatSessionSnapshot[]
  readonly conversationVersion: number
  readonly sessionList: {
    readonly activeMemberSessionId: string
    readonly activeSessionId: string
    readonly deletingSessionId: Nullable<string>
    readonly diskSessionHydrated: boolean
    readonly groups: readonly WorkbenchChatSessionGroup[]
    readonly archiveGroups: readonly WorkbenchChatSessionGroup[]
  }
  readonly actions: {
    openAgentChat: (engineId: Nullable<WorkbenchAgentEngineId>) => void
    addProjectSession: (folderId: string, projectRoot: string) => Promise<boolean>
    archiveSession: (folderId: string) => Promise<void>
    selectSession: (folderId: string, memberSessionId: string) => void
    startProjectChat: (projectRoot: string) => string
  }
}

export interface WorkbenchChatFileChangeEntry {
  readonly key: string
  readonly rootPath?: LooseOptional<string>
  readonly path: string
  readonly changeIds?: readonly string[]
  readonly previews?: readonly SystemFileChangePreviewResult[]
}

export interface WorkbenchBrowserElementSelectionDelivery {
  readonly deliveryId: string
  readonly targetSessionId: string
  readonly selection: BrowserElementSelection
}

/** 编辑器、标签页或文件树里右键「添加到聊天」投递给聊天面板的一个文件（项目内相对路径）。 */
export interface WorkbenchChatFileReferenceDelivery {
  readonly deliveryId: string
  readonly targetSessionId: string
  readonly path: string
}

export interface WorkbenchChatSessionSurfaceProps {
  projectRoot: string
  currentFilePath: Nullable<string>
  /** 只在切换会话代际时变化，流式内容修订不能放进这个 key。 */
  conversationRefreshKey: string | number
  scrollNavigatorHidden?: boolean
  pendingBrowserElementSelections: readonly WorkbenchBrowserElementSelectionDelivery[]
  onBrowserElementSelectionsConsumed?: (deliveryIds: readonly string[]) => void
  /** 挂到输入框上的文件引用；面板收下后回执 deliveryId，宿主据此清掉待投递项。 */
  pendingFileReferences: readonly WorkbenchChatFileReferenceDelivery[]
  onFileReferencesConsumed?: (deliveryIds: readonly string[]) => void
  onOpenFileChange?: (entry: WorkbenchChatFileChangeEntry) => void | Promise<void>
  onOpenWorkspacePath?: (path: string) => unknown
  onReviewFileChanges?: (entries: readonly WorkbenchChatFileChangeEntry[]) => void | Promise<void>
  /** 「本轮改动」卡的「查看」：在编辑区打开这一轮的「AI 改动」对比。 */
  onReviewRunChanges?: (target: WorkbenchChatRunChangesTarget) => void
}

export interface WorkbenchChatSessionActionsProps {
  projectRoot: string
  sessionId: string
}

/** 某个会话里的某一轮改动（记录 id = 这一轮检查点的 id）。 */
export interface WorkbenchChatRunChangesTarget {
  readonly sessionId: string
  readonly recordId: string
}

export interface WorkbenchChatCompositionAdapter {
  /**
   * Provider 安装后保持引用稳定；实现可以调用宿主自己的 hooks，但返回值只能是 Workbench 投影。
   */
  useProjectRuntime: (projectRoot: Nullable<string>) => WorkbenchChatProjectRuntime
  SessionSurface: ComponentType<WorkbenchChatSessionSurfaceProps>
  SessionActions?: ComponentType<WorkbenchChatSessionActionsProps>
}

const WorkbenchChatCompositionContext =
  createContext<Nullable<WorkbenchChatCompositionAdapter>>(null)

export function WorkbenchChatProvider({
  adapter,
  children,
}: {
  adapter: WorkbenchChatCompositionAdapter
  children: ReactNode
}): ReactElement {
  return (
    <WorkbenchChatCompositionContext.Provider value={adapter}>
      {children}
    </WorkbenchChatCompositionContext.Provider>
  )
}

function useWorkbenchChatComposition(): WorkbenchChatCompositionAdapter {
  const adapter = useContext(WorkbenchChatCompositionContext)
  if (!adapter) throw new Error('Workbench chat composition is not installed')
  return adapter
}

export function useWorkbenchChatProjectRuntime(
  projectRoot: Nullable<string>
): WorkbenchChatProjectRuntime {
  const adapter = useWorkbenchChatComposition()
  // Adapter 在应用生命周期内固定，因此这里的宿主 hook 拓扑不会变化。
  return adapter.useProjectRuntime(projectRoot)
}

export function WorkbenchChatSessionSurface(props: WorkbenchChatSessionSurfaceProps): ReactElement {
  const { SessionSurface } = useWorkbenchChatComposition()
  return <SessionSurface {...props} />
}

/** 会话工具由当前宿主提供，放在聊天顶部并跟随当前会话切换。 */
export function WorkbenchChatSessionActions(
  props: WorkbenchChatSessionActionsProps
): Nullable<ReactElement> {
  const { SessionActions } = useWorkbenchChatComposition()
  return SessionActions ? <SessionActions {...props} /> : null
}
