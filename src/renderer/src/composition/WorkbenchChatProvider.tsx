import {
  type ComponentType,
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
} from 'react'

import type {
  BrowserElementSelection,
  ChatMessage,
  SystemFileChangePreviewResult,
  WorkspaceCheckpointFileDiff,
} from '@shared/contracts'

import type { WorkbenchChatSurfaceScope } from './workbenchChatComposition'

export type WorkbenchChatRunStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'aborted'
  | 'failed'
  | 'awaiting-confirmation'
  | 'awaiting-input'

export interface WorkbenchChatMessagePaging {
  loadedFromIndex: number
  totalCount: number
}

export interface WorkbenchChatSessionSnapshot {
  readonly id: string
  readonly folderId: string
  readonly kind: 'chat'
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
    readonly workspaceCheckpointDiff?: {
      readonly changes: readonly WorkspaceCheckpointFileDiff[]
    }
  }>
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

export interface WorkbenchChatProjectRuntime {
  readonly projectRoot: Nullable<string>
  readonly currentSession: WorkbenchChatSessionSnapshot
  readonly sessions: readonly WorkbenchChatSessionSnapshot[]
  readonly conversationVersion: number
  /** Desktop 负责把工具协议翻译成产品只读事件 token。 */
  readonly browserActivationToken: Nullable<string>
  readonly sessionList: {
    readonly activeMemberSessionId: string
    readonly activeSessionId: string
    readonly deletingSessionId: Nullable<string>
    readonly diskSessionHydrated: boolean
    readonly groups: readonly WorkbenchChatSessionGroup[]
    readonly archiveGroups: readonly WorkbenchChatSessionGroup[]
  }
  readonly actions: {
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

export interface WorkbenchChatSessionSurfaceProps {
  projectRoot: string
  currentFilePath: Nullable<string>
  conversationRefreshKey: number
  pendingBrowserElementSelections: readonly WorkbenchBrowserElementSelectionDelivery[]
  onBrowserElementSelectionsConsumed?: (deliveryIds: readonly string[]) => void
  onOpenFileChange?: (entry: WorkbenchChatFileChangeEntry) => void | Promise<void>
  onOpenWorkspacePath?: (path: string) => unknown
  onReviewFileChanges?: (entries: readonly WorkbenchChatFileChangeEntry[]) => void | Promise<void>
}

export interface WorkbenchChatCompositionAdapter {
  /**
   * Provider 安装后保持引用稳定；实现可以调用宿主自己的 hooks，但返回值只能是 Workbench 投影。
   */
  useProjectRuntime: (projectRoot: Nullable<string>) => WorkbenchChatProjectRuntime
  SessionSurface: ComponentType<WorkbenchChatSessionSurfaceProps>
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
