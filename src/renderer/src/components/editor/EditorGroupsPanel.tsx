/**
 * 编辑区：一组，或左右并排的两组（各自的标签栏、当前标签、编辑器），中间一条可以拖的分隔条。
 *
 * - 每一组是一个 `EditorPanel`。两组的编辑器共用一份按文件记的编辑器状态，标签从一组挪到另一组，撤销历史、
 *   光标、滚动位置、折叠跟着走。
 * - 点进哪一组、焦点落进哪一组，那一组就是当前组：保存、查找、跳行、状态栏、问题面板、聊天的「当前文件」都
 *   看它。各组报上来的光标、缩进、当前问题只转发当前组的；换了当前组，把新一组最近报的那份补发一次。
 * - Git 对比、只读预览、网页调试与 Agent 浏览器这些盖在编辑器上的标签只在左边那组里。结构图、AI 改动这两个
 *   独占标签组激活时占整个编辑区，右边那组先收起来，离开之后回来。
 */
import {
  type DragEvent as ReactDragEvent,
  Fragment,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useWorkbenchI18n } from '@renderer/i18n'
import {
  workbenchEditorFileStateKey,
  WorkbenchEditorFileStates,
} from '@renderer/models/editor/workbenchEditorFileStates'
import {
  DefaultWorkbenchEditorSplitRatio,
  MinWorkbenchEditorGroupShare,
} from '@renderer/models/editor/workbenchEditorGroups'
import {
  canDropWorkbenchEditorTabOnGroup,
  endWorkbenchEditorTabDrag,
  readWorkbenchEditorTabDrag,
  type WorkbenchEditorTabDrag,
} from '@renderer/models/editor/workbenchEditorTabDrag'
import type { WorkbenchIndentationRequest } from '@renderer/models/editor/workbenchIndentation'
import type { WorkbenchGitDecorationMap } from '@renderer/models/git/workbenchGitModel'
import type { WorkbenchThemeId } from '@renderer/models/settings/workbenchPreferences'

import type { WorkbenchLanguageServiceDiagnostic } from '@shared/contracts'

import styles from '../../styles/workbenchPageStyles'
import { useLatest } from '../../support/genericHooks'
import type {
  WorkbenchEditorProjectBundle,
  WorkbenchEditorSurfaceBundle,
} from '../../types/workbenchSurfaceBundles'
import type { TopToolbarProps } from '../chrome/TopToolbar'
import { WorkbenchTopBar } from '../chrome/WorkbenchTopBar'

import {
  EditorPanel,
  resolveIsolatedWorkbenchEditorTabGroup,
  type WorkbenchEditorPanelDiffProps,
  type WorkbenchEditorPanelTabsProps,
  type WorkbenchEditorPanelWorkspaceProps,
} from './EditorPanel'

/** 编辑区里一组的面板输入：这一组正在显示的文件、标签栏与动作。 */
export interface WorkbenchEditorGroupPanelModel {
  workbenchEditor: WorkbenchEditorSurfaceBundle
  selectedFileDiagnostics: readonly WorkbenchLanguageServiceDiagnostic[]
  isSelectedFileDiagnosticsPending: boolean
  tabs: WorkbenchEditorPanelTabsProps
  workspace: WorkbenchEditorPanelWorkspaceProps
}

export interface WorkbenchEditorGroupsLayoutProps {
  /** 全局动作作用在哪一组上（0 左，1 右）。 */
  focusedGroup: number
  /** 并排时左边那组占编辑区宽度的比例。 */
  splitRatio: number
  /** 要求把键盘焦点放进某一组的编辑器：每要求一次 id 加一（⌘1 / ⌘2、拆分之后）。 */
  focusRequest: { id: number; groupIndex: number }
  onFocusGroup: (groupIndex: number) => void
  onSplitRatioChange: (ratio: number) => void
  /** 把标签挪到另一组并切过去；`beforePath` 是拖放时落在哪个标签前面。 */
  onMoveTabToGroup: (path: string, groupIndex: number, beforePath?: Nullable<string>) => void
}

interface EditorGroupsPanelProps {
  chrome: TopToolbarProps
  showTopBar?: boolean
  workbenchTheme: WorkbenchThemeId
  workbenchProject: WorkbenchEditorProjectBundle
  gitDecorations: WorkbenchGitDecorationMap
  gitStateRevision?: Nullable<number>
  /** 从左到右的组：一组，或并排的两组。 */
  groups: WorkbenchEditorGroupPanelModel[]
  layout: WorkbenchEditorGroupsLayoutProps
  /** 盖在左边那组编辑器上的标签：Git 对比、只读预览、网页调试、结构图、AI 改动。 */
  diff: WorkbenchEditorPanelDiffProps
}

type CursorPosition = Parameters<
  NonNullable<WorkbenchEditorPanelWorkspaceProps['onCursorPositionChange']>
>[0]
type Indentation = Parameters<
  NonNullable<WorkbenchEditorPanelWorkspaceProps['onIndentationChange']>
>[0]

/** 每一组最近报上来的光标与缩进：换当前组时把新一组的补发给页面（状态栏跟着换）。 */
interface GroupReports {
  cursor?: CursorPosition
  indentation?: Indentation
}

export function EditorGroupsPanel({
  chrome,
  showTopBar = true,
  workbenchTheme,
  workbenchProject,
  gitDecorations,
  gitStateRevision = null,
  groups,
  layout,
  diff,
}: EditorGroupsPanelProps): ReactElement {
  const { t } = useWorkbenchI18n()
  const { focusedGroup, splitRatio, focusRequest, onFocusGroup, onSplitRatioChange, onMoveTabToGroup } =
    layout
  const containerRef = useRef<HTMLDivElement>(null)
  // 各打开文件的编辑器状态（撤销历史、光标、折叠、滚动位置）放在这里，两组的编辑器共用：编辑器切到预览、
  // 对比视图时会卸载，挂回来接着用；标签挪到另一组，那边的编辑器接着用；标签关掉就丢。
  const [fileStates] = useState(() => new WorkbenchEditorFileStates())
  const projectRoot = workbenchProject.rootPath
  const openTabs = groups[0]?.workbenchEditor.openTabs
  useEffect(() => {
    fileStates.retain(
      (openTabs ?? []).map((tab) => workbenchEditorFileStateKey(projectRoot, tab.path))
    )
  }, [fileStates, openTabs, projectRoot])

  const appliedNavigationRequestIdRef = useRef<Nullable<number>>(null)
  const handledFocusRequestIdRef = useRef(focusRequest.id)

  // 结构图、AI 改动占着整个编辑区时只留左边那组（它们的标签在那里），右边那组先收起来。
  const isolatedTabGroup = resolveIsolatedWorkbenchEditorTabGroup(diff.auxiliaryTabs ?? [])
  const visibleGroups = isolatedTabGroup ? groups.slice(0, 1) : groups
  const isSplit = visibleGroups.length > 1

  // 各组报上来的光标、缩进、光标所在的问题：只有当前组的交给页面（状态栏、问题面板、后退 / 前进）。
  const reportsRef = useRef<GroupReports[]>([])
  const focusedGroupLatest = useLatest(focusedGroup)
  const globalWorkspace = groups[focusedGroup]?.workspace ?? groups[0]?.workspace
  const globalWorkspaceLatest = useLatest(globalWorkspace)
  const reportFromGroup = useMemo(
    () =>
      [0, 1].map((index) => ({
        onCursorPositionChange: (position: CursorPosition): void => {
          ;(reportsRef.current[index] ??= {}).cursor = position
          if (index === focusedGroupLatest.current)
            globalWorkspaceLatest.current?.onCursorPositionChange?.(position)
        },
        onIndentationChange: (indentation: Indentation): void => {
          ;(reportsRef.current[index] ??= {}).indentation = indentation
          if (index === focusedGroupLatest.current)
            globalWorkspaceLatest.current?.onIndentationChange?.(indentation)
        },
        onActiveProblemIdChange: (problemId: Nullable<string>): void => {
          if (index === focusedGroupLatest.current)
            globalWorkspaceLatest.current?.onActiveProblemIdChange?.(problemId)
        },
      })),
    [focusedGroupLatest, globalWorkspaceLatest]
  )
  // 换了当前组：状态栏换成这一组最近报的光标与缩进。（问题面板里的高亮随当前文件变了先清掉，光标再动时
  // 跟上，与切文件时一样。）
  const reportedFocusedGroupRef = useRef(focusedGroup)
  useEffect(() => {
    if (reportedFocusedGroupRef.current === focusedGroup) return
    reportedFocusedGroupRef.current = focusedGroup
    const reports = reportsRef.current[focusedGroup]
    const workspace = globalWorkspaceLatest.current
    if (!reports || !workspace) return
    if (reports.cursor) workspace.onCursorPositionChange?.(reports.cursor)
    if (reports.indentation !== undefined) workspace.onIndentationChange?.(reports.indentation)
  }, [focusedGroup, globalWorkspaceLatest])

  // 状态栏缩进菜单的操作只交给当时的当前组，并且只交一次：编辑器按请求的 id 去重，但它卸载重挂（对比视图
  // 关掉、右边那组新开出来）之后不记得做过，留着这个请求就会在别的文件上再做一遍。
  const indentationRequest = globalWorkspace?.indentationRequest ?? null
  const [indentationDelivery, setIndentationDelivery] = useState<
    Nullable<{ request: WorkbenchIndentationRequest; groupIndex: number }>
  >(null)
  const seenIndentationRequestIdRef = useRef(indentationRequest?.id ?? null)
  useEffect(() => {
    if (!indentationRequest || seenIndentationRequestIdRef.current === indentationRequest.id) return
    seenIndentationRequestIdRef.current = indentationRequest.id
    setIndentationDelivery({ request: indentationRequest, groupIndex: focusedGroupLatest.current })
  }, [focusedGroupLatest, indentationRequest])
  useEffect(() => {
    // 走到这里时那一组的编辑器已经在这一轮提交里拿到请求并做完了（子组件的副作用先跑）。
    if (indentationDelivery) setIndentationDelivery(null)
  }, [indentationDelivery])

  function focusGroup(index: number): void {
    // 结构图、AI 改动占着整个编辑区时，点的、敲的都是它们，不是左边那组的文件：当前组不动，离开之后还是
    // 原来那一组。
    if (isolatedTabGroup) return
    if (index !== focusedGroup) onFocusGroup(index)
  }

  /** 拖分隔条：拖的时候直接改两组的宽度份额，不逐帧过 React；松手再把比例记下来（随会话存盘）。 */
  function beginResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const container = containerRef.current
    if (!container || event.button !== 0) return
    event.preventDefault()

    const handle = event.currentTarget
    const panes = [...container.querySelectorAll<HTMLElement>(':scope > [data-editor-group]')]
    const width = container.clientWidth
    const startX = event.clientX
    let nextRatio = splitRatio
    handle.setPointerCapture(event.pointerId)
    // 拖拽期间网页调试的 webview 不吃指针，拖过去不会断。
    container.setAttribute('data-resizing', 'true')

    const move = (moveEvent: PointerEvent): void => {
      if (width <= 0) return
      nextRatio = Math.min(
        1 - MinWorkbenchEditorGroupShare,
        Math.max(MinWorkbenchEditorGroupShare, splitRatio + (moveEvent.clientX - startX) / width)
      )
      panes[0]?.style.setProperty('flex-grow', String(nextRatio))
      panes[1]?.style.setProperty('flex-grow', String(1 - nextRatio))
    }
    const end = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      container.removeAttribute('data-resizing')
      onSplitRatioChange(nextRatio)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  // 另一组拖过来的标签正停在哪一组标签栏以外的地方（编辑器、预览）：那一组亮起来，松手挪进去。
  const [tabDropGroup, setTabDropGroup] = useState<Nullable<number>>(null)

  // 拖到一半右边那组没了（它的最后一个标签被别处关掉）：分隔条连同上面的指针事件一起消失，收尾没机会跑，
  // 在这里把「正在拖分隔条」的标记撤掉——留着的话网页调试的 webview 一直不吃指针；标签的落点提示也收起。
  useEffect(() => {
    if (isSplit) return
    containerRef.current?.removeAttribute('data-resizing')
    setTabDropGroup(null)
  }, [isSplit])

  /**
   * 标签拖到了这一组标签栏以外的地方（编辑器、预览）：拖的是谁；拖的不是标签、或者还在标签栏上（落在哪个
   * 标签前面、空白处由标签栏自己接）为 null。
   */
  function readTabDragOverGroupBody(
    event: ReactDragEvent<HTMLDivElement>
  ): Nullable<WorkbenchEditorTabDrag> {
    const drag = readWorkbenchEditorTabDrag(event.dataTransfer.types)
    if (!drag) return null
    const { target } = event
    const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
    return element?.closest('[role="tablist"]') ? null : drag
  }

  // 这两个在捕获阶段接、不再往里传：编辑器收不到这次拖放——否则它会把标签带着的路径当文字插进正文里。
  // 另一组拖来的标签松手挪进这一组；自己这一组的标签落在这里什么都不做（换位置只在标签栏上做）。
  function handleGroupDragOver(index: number, event: ReactDragEvent<HTMLDivElement>): void {
    const drag = readTabDragOverGroupBody(event)
    if (!drag) {
      if (tabDropGroup === index) setTabDropGroup(null)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    const accepts = canDropWorkbenchEditorTabOnGroup(drag, index)
    event.dataTransfer.dropEffect = accepts ? 'move' : 'none'
    if (accepts && tabDropGroup !== index) setTabDropGroup(index)
  }

  function handleGroupDrop(index: number, event: ReactDragEvent<HTMLDivElement>): void {
    const drag = readTabDragOverGroupBody(event)
    if (!drag) return
    event.preventDefault()
    event.stopPropagation()
    setTabDropGroup(null)
    endWorkbenchEditorTabDrag()
    if (canDropWorkbenchEditorTabOnGroup(drag, index)) onMoveTabToGroup(drag.path, index)
  }

  function handleGroupDragLeave(index: number, event: ReactDragEvent<HTMLDivElement>): void {
    if (tabDropGroup !== index) return
    if (event.currentTarget.contains(event.relatedTarget as Nullable<Node>)) return
    setTabDropGroup(null)
  }

  return (
    <div className={styles.editorGroupsPanel}>
      {showTopBar && <WorkbenchTopBar {...chrome} />}
      <div ref={containerRef} className={styles.editorGroups} data-split={isSplit}>
        {visibleGroups.map((group, index) => (
          <Fragment key={index}>
            {index > 0 && (
              <div
                className={`${styles.verticalResizeHandle} ${styles.editorGroupResizeHandle}`}
                role="separator"
                aria-orientation="vertical"
                aria-label={t('workbench.resizeEditorGroups')}
                onPointerDown={beginResize}
                onDoubleClick={() => onSplitRatioChange(DefaultWorkbenchEditorSplitRatio)}
              />
            )}
            <div
              className={styles.editorGroup}
              data-editor-group={index}
              data-focused={isSplit ? index === focusedGroup : undefined}
              data-drop-target={tabDropGroup === index ? true : undefined}
              aria-label={
                isSplit
                  ? t(index === 0 ? 'workbench.editorGroupLeft' : 'workbench.editorGroupRight')
                  : undefined
              }
              role={isSplit ? 'group' : undefined}
              style={
                isSplit ? { flexGrow: index === 0 ? splitRatio : 1 - splitRatio } : undefined
              }
              // 点进这一组、焦点落进这一组、在这一组里按键：全局动作交给它。（按键也算：别处把当前组换走了
              // 而键盘焦点还留在这一组的编辑器里时，接着打字它就又是当前组。）
              onMouseDownCapture={() => focusGroup(index)}
              onFocusCapture={() => focusGroup(index)}
              onKeyDownCapture={() => focusGroup(index)}
              onDragOverCapture={(event) => handleGroupDragOver(index, event)}
              onDropCapture={(event) => handleGroupDrop(index, event)}
              onDragLeave={(event) => handleGroupDragLeave(index, event)}
            >
              <EditorPanel
                chrome={chrome}
                showTopBar={showTopBar}
                group={{
                  index,
                  count: visibleGroups.length,
                  focused: index === focusedGroup || !isSplit,
                  fileStates,
                  appliedNavigationRequestIdRef,
                  focusRequest,
                  handledFocusRequestIdRef,
                  onMoveTabToGroup,
                }}
                workbenchTheme={workbenchTheme}
                workbenchProject={workbenchProject}
                workbenchEditor={group.workbenchEditor}
                gitDecorations={gitDecorations}
                gitStateRevision={gitStateRevision}
                selectedFileDiagnostics={group.selectedFileDiagnostics}
                isSelectedFileDiagnosticsPending={group.isSelectedFileDiagnosticsPending}
                tabs={group.tabs}
                diff={index === 0 ? diff : { diffWorkspaceRoot: diff.diffWorkspaceRoot }}
                workspace={{
                  ...group.workspace,
                  ...reportFromGroup[index],
                  indentationRequest:
                    indentationDelivery?.groupIndex === index ? indentationDelivery.request : null,
                }}
              />
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  )
}
