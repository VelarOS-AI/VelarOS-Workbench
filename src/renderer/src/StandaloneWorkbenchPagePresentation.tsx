/**
 * 独立工作台主界面拼装：左侧项目与底部工具 rail、文件/编辑器中央装配、右侧产品动作、
 * 运行/终端/问题工具窗、设置、状态栏与 QuickOpen。
 *
 * 文件、Git、终端、运行与语言洞察由独立应用自持；chat/model 走 Kernel 语义路由，
 * 项目索引与事务变更走发布版 Workspace 模块，Browser 走发布版 composition 端口。
 */
import { lazy, type ReactElement, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChatCircleTextIcon,
  FolderIcon,
  GitBranchIcon,
  GitCommitIcon,
  NotePencilIcon,
  PlayIcon,
  TerminalWindowIcon,
  TreeViewIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
import { WorkbenchChatPanel } from '@renderer/components/chat/WorkbenchChatPanel'
import { useWorkbenchHostRuntime } from '@renderer/host'

import { optionalWhen } from '@velaros-ai/core'
import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'

import type { WorkbenchProjectHubState } from '@shared/projectHub'

import { WorkbenchAiChangeDiffPanel } from './components/aiChanges/WorkbenchAiChangeDiffPanel'
import { StatusBar } from './components/chrome/StatusBar'
import { WorkbenchTopLeading, WorkbenchTopTrailing } from './components/chrome/TopToolbar'
import { WorkbenchProjectControl } from './components/chrome/WorkbenchProjectControl'
import { CodeInsightPanel } from './components/editor/CodeInsightPanel'
import { EditorUnsavedChangesDialog } from './components/editor/EditorUnsavedChangesDialog'
import { ReadOnlyWorkbenchCode } from './components/editor/ReadOnlyWorkbenchCode'
import { WorkbenchEmbeddedKernel } from './components/embedded/WorkbenchEmbeddedKernel'
import {
  buildStandaloneWorkbenchEditorChrome,
  buildStandaloneWorkbenchEmbeddedKernelModel,
} from './components/embedded/workbenchEmbeddedKernelAdapter'
import { WorkbenchFileTypeIcon } from './components/files/WorkbenchFileTypeIcon'
import { WorkbenchGitToolPanel } from './components/git/WorkbenchGitToolPanel'
import { WorkbenchSettingsDialog } from './components/settings/WorkbenchSettingsDialog'
import { type BottomTool, CommandPanel } from './components/terminal/CommandPanel'
import { useWorkbenchTerminalFileLinks } from './hooks/useWorkbenchTerminalFileLinks'
import { useWorkbenchWindowFullScreen } from './hooks/useWorkbenchWindowFullScreen'
import {
  discoverWorkbenchVelarProjectRoots,
  mergeWorkbenchVelarProjectSnapshotIndex,
  updateWorkbenchVelarProjectSnapshotIndex,
  type WorkbenchVelarProjectSnapshot,
  type WorkbenchVelarProjectSnapshotIndex,
} from './models/codeGraph/workbenchVelarProjectGraph'
import { buildWorkbenchStatusBarTextFormat } from './models/editor/workbenchEditorTextFormat'
import styles from './styles/workbenchPageStyles'
import { useWorkbenchPageContext } from './WorkbenchPageModelContext'

// VelarScript 结构图只在打开结构标签时才加载，不进工作区外壳。
const LazyWorkbenchLogicGraphEditor = lazy(async () => {
  const module = await import('./components/codeGraph/WorkbenchLogicGraphDialog')
  return { default: module.WorkbenchLogicGraphEditor }
})

type QuickOpenModule = typeof import('./components/project/QuickOpen')

let quickOpenModulePromise: Nullable<Promise<QuickOpenModule>> = null

// 快速打开与命令面板（文件名打分、命令登记表）也不进工作区外壳：空闲时预先加载，第一次打开不用等。
function loadQuickOpenModule(): Promise<QuickOpenModule> {
  quickOpenModulePromise ??= import('./components/project/QuickOpen').catch((error: unknown) => {
    quickOpenModulePromise = null
    throw error
  })
  return quickOpenModulePromise
}

const LazyQuickOpen = lazy(async () => {
  const module = await loadQuickOpenModule()
  return { default: module.QuickOpen }
})

interface StandaloneWorkbenchPagePresentationProps {
  projectHubState: WorkbenchProjectHubState
}

interface VelarStructureViewTab {
  id: string
  scopePaths: readonly string[]
}

const VelarStructureOverviewTab: VelarStructureViewTab = {
  id: 'velar-structure:overview',
  scopePaths: [],
}

function velarStructureTabId(scopePaths: readonly string[]): string {
  return `velar-structure:${[...scopePaths].sort().map(encodeURIComponent).join('|')}`
}

export function StandaloneWorkbenchPagePresentation({
  projectHubState,
}: StandaloneWorkbenchPagePresentationProps): ReactElement {
  const model = useWorkbenchPageContext()
  const runtime = useWorkbenchHostRuntime()
  // 全屏时红绿灯随标题栏一起收起，顶栏不再给它们留左侧空位（见 data-mac-title-inset）。
  const windowFullScreen = useWorkbenchWindowFullScreen()
  const {
    workbench,
    surface,
    layout,
    workbenchPreferences,
    workbenchKeymap,
    editorNavigation,
    chrome,
    dialogs,
  } = model
  const {
    translate,
    locale,
    t,
    shellStyle,
    macTitleInset,
    hostPlatform,
    commandStatusLabel,
  } = chrome

  const pendingFileOpenId = projectHubState.pendingFileOpen?.id
  const pendingFileOpenPath = projectHubState.pendingFileOpen?.path
  const activeProjectId = workbench.activeProject?.id
  const activeProjectRoot = workbench.activeProject?.rootPath
  const resolveTerminalFileLinks = useWorkbenchTerminalFileLinks(activeProjectRoot)
  // 状态栏：当前文本文件的编码与换行符（差异、预览标签不显示）。
  const selectedEditorTab = workbench.openTabs.find(
    (tab) => tab.path === workbench.selectedFilePath
  )
  const selectedTextFormat =
    selectedEditorTab && !editorNavigation.diffItem && !editorNavigation.lightTab
      ? buildWorkbenchStatusBarTextFormat(selectedEditorTab, workbench.selectedFileEditMode)
      : null
  const [velarManifestPaths, setVelarManifestPaths] = useState<readonly string[]>([])
  /** 全项目扫出来的 VelarScript 源文件；结构树的完整性靠它，不靠「你打开过什么」。 */
  const [velarSourcePaths, setVelarSourcePaths] = useState<readonly string[]>([])
  const [velarStructureScopeTabs, setVelarStructureScopeTabs] =
    useState<readonly VelarStructureViewTab[]>([])
  const [activeVelarStructureTabId, setActiveVelarStructureTabId] = useState(
    VelarStructureOverviewTab.id
  )
  // 工作区状态只保存每个 Velar 项目的完整快照和用户展开覆盖；标签页 scope 只投影右侧图，
  // 不能反向替换这两份状态，否则切换局部范围会让侧栏目录随局部快照一起消失。
  const [velarStructureProjectSnapshots, setVelarStructureProjectSnapshots] =
    useState<WorkbenchVelarProjectSnapshotIndex>(() => new Map())
  const [velarStructureExpansionOverrides, setVelarStructureExpansionOverrides] =
    useState<ReadonlyMap<string, boolean>>(() => new Map())
  const [velarStructureActiveTab, setVelarStructureActiveTab] = useState<'structure' | 'source'>(
    'structure'
  )
  const [velarSourcePreview, setVelarSourcePreview] = useState<
    Nullable<{
      path: string
      content: string
      line?: number
      column?: number
    }>
  >(null)
  /*
   * 结构面板要看到项目里**全部**的 VelarScript 源文件，所以这里主动搜一遍磁盘。
   *
   * 下面拼装 velarStructureProjectPaths 的那几个来源都只覆盖一部分：`rootEntries` 只有顶层，
   * `openTabs` 只有你打开过的，两个索引则是懒建的。靠它们拼出来的结构树会随「你今天点过什么」
   * 变化——真机上 apps 与 packages 下十几个 .vel 只显示出一个，就是这么来的。
   * 清单要么完整要么没意义，因此与 velar.json 一样直接问一次文件系统。
   */
  useEffect(() => {
    let cancelled = false
    setVelarManifestPaths([])
    setVelarSourcePaths([])
    if (!activeProjectRoot) return
    const search = (query: string, limit: number) =>
      runtime.kernel.project.searchWorkbenchEntries({
        projectRoot: activeProjectRoot,
        query,
        limit,
        maxDepth: 12,
      })
    void search('velar.json', 200)
      .then((result) => {
        if (cancelled || !result.ok) return
        setVelarManifestPaths(
          result.data.entries
            .filter((entry) => entry.type === 'file' && entry.name === 'velar.json')
            .map((entry) => entry.path)
        )
      })
      .catch(() => undefined)
    void search('.vel', 2000)
      .then((result) => {
        if (cancelled || !result.ok) return
        setVelarSourcePaths(
          result.data.entries
            // 按后缀过滤，别把 `.velar/` 这类目录也收进来。
            .filter((entry) => entry.type === 'file' && entry.name.endsWith('.vel'))
            .map((entry) => entry.path)
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [activeProjectRoot, runtime, workbench.workspaceBindingVersion])
  const velarStructureProjectPaths = useMemo(() => {
    const files = new Map<string, { path: string }>()
    for (const file of [
      ...(workbench.projectIndexResult?.files ?? []),
      ...workbench.projectContextIndex.files,
      ...workbench.openTabs,
      ...workbench.rootEntries,
      ...velarManifestPaths.map((path) => ({ path })),
      ...velarSourcePaths.map((path) => ({ path })),
    ]) {
      const path = file.path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
      files.set(path, { path })
    }
    return [...files.values()]
  }, [
    workbench.openTabs,
    workbench.projectContextIndex.files,
    workbench.projectIndexResult,
    workbench.rootEntries,
    velarManifestPaths,
    velarSourcePaths,
  ])
  const velarStructureProjectFiles = useMemo(
    () => velarStructureProjectPaths.filter((file) => file.path.endsWith('.vel')),
    [velarStructureProjectPaths]
  )
  const velarStructureProjectRoots = useMemo(
    () => discoverWorkbenchVelarProjectRoots(velarStructureProjectPaths.map((file) => file.path)),
    [velarStructureProjectPaths]
  )
  const velarStructureAvailable =
    velarStructureProjectRoots.length > 0 || velarStructureProjectFiles.length > 0
  const velarStructureSnapshot = useMemo(
    () => mergeWorkbenchVelarProjectSnapshotIndex(velarStructureProjectSnapshots),
    [velarStructureProjectSnapshots]
  )
  const handleVelarStructureProjectSnapshotsChange = useCallback(
    (projects: readonly WorkbenchVelarProjectSnapshot[]): void =>
      setVelarStructureProjectSnapshots((current) =>
        updateWorkbenchVelarProjectSnapshotIndex(current, projects)
      ),
    []
  )
  const velarStructureTabs = useMemo(
    () => [VelarStructureOverviewTab, ...velarStructureScopeTabs],
    [velarStructureScopeTabs]
  )
  const velarStructureScopePaths = useMemo(
    () => velarStructureTabs.find((tab) => tab.id === activeVelarStructureTabId)?.scopePaths ?? [],
    [activeVelarStructureTabId, velarStructureTabs]
  )
  const describeVelarStructureTab = useCallback(
    (scopePaths: readonly string[]) => {
      if (scopePaths.length === 0) {
        const label = t('workbench.logicGraphProjectOverview')
        return { label, title: label }
      }
      const selections = scopePaths.map((scope) => {
        const node = velarStructureSnapshot?.nodes.find((candidate) => candidate.id === scope)
        return {
          label: node?.name ?? scope,
          path: node?.path ?? scope,
          title: node?.path ? `${node.path} · ${node.name}` : scope,
        }
      })
      if (selections.length === 1) return { label: selections[0].label, title: selections[0].title }
      const paths = [...new Set(selections.map((selection) => selection.path))]
      if (paths.length > 1)
        return {
          label: `${paths[0]} +${paths.length - 1}`,
          title: paths.join('\n'),
        }
      return {
        label: `${selections[0].label} +${selections.length - 1}`,
        title: selections.map((selection) => selection.title).join('\n'),
      }
    },
    [t, velarStructureSnapshot]
  )
  useEffect(() => {
    if (chrome.velarLogicGraphAvailable) return
    dialogs.setVelarLogicGraphOpen(false)
    dialogs.setVelarLogicGraphActive(false)
  }, [chrome.velarLogicGraphAvailable, dialogs])

  useEffect(() => {
    setVelarStructureScopeTabs([])
    setActiveVelarStructureTabId(VelarStructureOverviewTab.id)
    setVelarStructureProjectSnapshots(new Map())
    setVelarStructureExpansionOverrides(new Map())
    setVelarStructureActiveTab('structure')
    setVelarSourcePreview(null)
  }, [activeProjectId])

  useEffect(() => {
    if (!window.requestIdleCallback) return undefined

    const handle = window.requestIdleCallback(() => {
      void loadQuickOpenModule().catch(() => undefined)
    })
    return () => window.cancelIdleCallback(handle)
  }, [])

  useEffect(() => {
    if (!pendingFileOpenId || !pendingFileOpenPath || !activeProjectId) return

    let active = true
    void model.actions.navigate({ target: 'file', path: pendingFileOpenPath }).finally(() => {
      if (active) {
        void window.velarosWorkbenchProjectHub.acknowledgeFileOpen(pendingFileOpenId)
      }
    })
    return () => {
      active = false
    }
  }, [activeProjectId, model.actions.navigate, pendingFileOpenId, pendingFileOpenPath])

  if (!workbench.activeProject) return <main className={styles.root} />
  const projectRoot = workbench.activeProject.rootPath
  const hasRunningRunSession = workbench.runSessions.some((session) => session.isRunning)

  const bottomToolItems: Array<{
    id: BottomTool
    label: string
    icon: ReactElement
    isRunning?: boolean
  }> = [
    ...(workbench.runSessions.length > 0
      ? [
          {
            id: 'run' as const,
            label: t('workbench.commandTabRuns'),
            icon: <PlayIcon size={18} weight="regular" />,
            isRunning: hasRunningRunSession,
          },
        ]
      : []),
    {
      id: 'git',
      label: t('workbench.gitToolWindow'),
      icon: <GitBranchIcon size={18} />,
    },
    {
      id: 'problems',
      label: t('workbench.editorProblems'),
      icon: <WarningCircleIcon size={18} />,
    },
    {
      id: 'terminal',
      label: t('workbench.commandTabTerminal'),
      icon: <TerminalWindowIcon size={18} />,
    },
  ]
  const editorChrome = buildStandaloneWorkbenchEditorChrome(model)
  const baseEmbeddedKernelModel = buildStandaloneWorkbenchEmbeddedKernelModel(model, editorChrome)
  const { aiChanges } = model
  // 「AI 改动」对比标签：独占标签组，激活时标签栏只显示这一组，与普通文件标签隔开。
  const aiChangeTabs = aiChanges.tabs.map((tab) => {
    const fileName = tab.path.slice(tab.path.lastIndexOf('/') + 1)
    return {
      id: tab.id,
      title: `${tab.path} · ${t('workbench.aiChangesRunLabel', { number: tab.runNumber })}`,
      label: fileName,
      icon: <WorkbenchFileTypeIcon fileName={tab.path} size={13} />,
      active: aiChanges.active && aiChanges.activeTab?.id === tab.id,
      group: 'ai-changes' as const,
      kind: 'ai-change',
      onSelect: () => aiChanges.selectTab(tab.id),
      onClose: () => aiChanges.closeTab(tab.id),
      content: (
        <WorkbenchAiChangeDiffPanel
          projectRoot={projectRoot}
          tab={tab}
          workbenchTheme={workbenchPreferences.preferences.theme}
          onOpenFile={(path, line) => void model.actions.navigate({ target: 'file', path, line })}
        />
      ),
    }
  })
  const embeddedKernelModel = {
    ...baseEmbeddedKernelModel,
    velarStructure: {
      projectFiles: velarStructureProjectFiles,
      snapshot: velarStructureSnapshot,
      scopePaths: velarStructureScopePaths,
      expansionOverrides: velarStructureExpansionOverrides,
      onScopePathsChange: openVelarStructureScope,
      onExpansionOverridesChange: setVelarStructureExpansionOverrides,
    },
    editor: {
      ...baseEmbeddedKernelModel.editor,
      diff: {
        ...baseEmbeddedKernelModel.editor.diff,
        auxiliaryTabs: [
          ...aiChangeTabs,
          ...(dialogs.velarLogicGraphOpen
          ? [
              ...velarStructureTabs.map((structureTab) => {
                const tab = describeVelarStructureTab(structureTab.scopePaths)
                return {
                  id: structureTab.id,
                  title: tab.title,
                  label: tab.label,
                  icon: <TreeViewIcon size={14} weight="bold" />,
                  active:
                    dialogs.velarLogicGraphActive &&
                    velarStructureActiveTab === 'structure' &&
                    activeVelarStructureTabId === structureTab.id,
                  group: 'structure' as const,
                  kind: 'velar-structure',
                  onSelect: () => selectVelarStructureTab(structureTab.id),
                  onClose: optionalWhen(
                    structureTab.id !== VelarStructureOverviewTab.id,
                    () => closeVelarStructureTab(structureTab.id)
                  ),
                  content: (
                    <Suspense fallback={null}>
                      <LazyWorkbenchLogicGraphEditor
                        active={
                          dialogs.velarLogicGraphActive &&
                          velarStructureActiveTab === 'structure' &&
                          activeVelarStructureTabId === structureTab.id
                        }
                        projectRoot={projectRoot}
                        projectRoots={velarStructureProjectRoots}
                        scopePaths={structureTab.scopePaths}
                        selectedFilePath={workbench.selectedFilePath}
                        selectedContent={workbench.editorContent}
                        openTabs={workbench.openTabs}
                        projectFiles={velarStructureProjectFiles}
                        projectSnapshots={velarStructureProjectSnapshots}
                        refreshVersion={workbench.saveRevision + workbench.workspaceBindingVersion}
                        workbenchTheme={workbenchPreferences.preferences.theme}
                        onProjectSnapshotsChange={handleVelarStructureProjectSnapshotsChange}
                        onOpenSource={(source) => {
                          setVelarSourcePreview(source)
                          setVelarStructureActiveTab('source')
                        }}
                      />
                    </Suspense>
                  ),
                }
              }),
              ...(velarSourcePreview
                ? [
                    {
                      id: `velar-source:${velarSourcePreview.path}`,
                      title: velarSourcePreview.path,
                      label: velarSourcePreview.path,
                      icon: <WorkbenchFileTypeIcon fileName={velarSourcePreview.path} size={14} />,
                      active: dialogs.velarLogicGraphActive && velarStructureActiveTab === 'source',
                      group: 'structure' as const,
                      kind: 'velar-source',
                      onSelect: () => {
                        dialogs.setVelarLogicGraphActive(true)
                        setVelarStructureActiveTab('source')
                      },
                      onClose: () => {
                        setVelarSourcePreview(null)
                        setVelarStructureActiveTab('structure')
                        setActiveVelarStructureTabId(VelarStructureOverviewTab.id)
                      },
                      content: (
                        <ReadOnlyWorkbenchCode
                          content={velarSourcePreview.content}
                          path={velarSourcePreview.path}
                          workbenchTheme={workbenchPreferences.preferences.theme}
                          initialLine={velarSourcePreview.line}
                        />
                      ),
                    },
                  ]
                : []),
            ]
          : []),
        ],
      },
    },
  }

  async function switchProject(path: string): Promise<boolean> {
    if (!workbench.ensureNoUnsavedChanges()) return false
    const result = await window.velarosWorkbenchProjectHub.switchProjectPath(path)
    return result.ok
  }

  async function openProjectInNewWindow(path: string): Promise<boolean> {
    const result = await window.velarosWorkbenchProjectHub.openProjectPathInNewWindow(path)
    return result.ok
  }

  async function addLocalProject(): Promise<boolean> {
    const result = await window.velarosWorkbenchProjectHub.openProjectDialogInNewWindow()
    return result.ok
  }
  function toggleLeftTool(tool: 'commit' | 'project'): void {
    model.actions.showEditorSurface()
    if (surface.activeLeftTool === tool) {
      surface.toggleFilePanel()
      return
    }
    surface.setActiveLeftTool(tool)
    if (!surface.isFilePanelOpen) surface.toggleFilePanel()
  }

  /**
   * 左侧「AI 改动」图标：开关面板。打开时编辑区也换成改动——左右说的是同一件事：有打开过的改动标签就
   * 把它们带回来，一个都没有就像改动卡的「审核」那样打开最新一轮改过的文件。
   */
  function toggleAiChanges(): void {
    if (surface.activeLeftTool === 'ai-changes' && surface.isFilePanelOpen) {
      surface.toggleFilePanel()
      return
    }
    surface.setActiveLeftTool('ai-changes')
    if (!surface.isFilePanelOpen) surface.toggleFilePanel()
    const tab = aiChanges.activeTab ?? aiChanges.tabs[0]
    if (tab) {
      aiChanges.selectTab(tab.id)
      return
    }
    const newest = aiChanges.rounds.find((round) => !round.error && round.fileCount > 0)
    if (newest) void aiChanges.openRound(newest, { auto: true })
  }

  function openVelarStructure(): void {
    aiChanges.deactivate()
    if (surface.activeLeftTool === 'velar-structure' && surface.isFilePanelOpen) {
      surface.toggleFilePanel()
      return
    }
    surface.setActiveLeftTool('velar-structure')
    if (!surface.isFilePanelOpen) surface.toggleFilePanel()
    dialogs.setVelarLogicGraphOpen(true)
    dialogs.setVelarLogicGraphActive(true)
    setVelarStructureActiveTab('structure')
    setActiveVelarStructureTabId(VelarStructureOverviewTab.id)
  }

  function openVelarStructureScope(scopePaths: readonly string[]): void {
    aiChanges.deactivate()
    const normalizedPaths = [...new Set(scopePaths)]
    if (normalizedPaths.length === 0) {
      selectVelarStructureTab(VelarStructureOverviewTab.id)
      return
    }
    if (!velarStructureAvailable) return
    const id = velarStructureTabId(normalizedPaths)
    setVelarStructureScopeTabs((current) =>
      current.some((tab) => tab.id === id)
        ? current
        : [...current, { id, scopePaths: normalizedPaths }]
    )
    setActiveVelarStructureTabId(id)
    dialogs.setVelarLogicGraphOpen(true)
    dialogs.setVelarLogicGraphActive(true)
    setVelarStructureActiveTab('structure')
  }

  function selectVelarStructureTab(id: string): void {
    aiChanges.deactivate()
    setActiveVelarStructureTabId(id)
    dialogs.setVelarLogicGraphActive(true)
    setVelarStructureActiveTab('structure')
  }

  function closeVelarStructureTab(id: string): void {
    if (id === VelarStructureOverviewTab.id) return
    const closedIndex = velarStructureScopeTabs.findIndex((tab) => tab.id === id)
    const nextTabs = velarStructureScopeTabs.filter((tab) => tab.id !== id)
    setVelarStructureScopeTabs(nextTabs)
    if (activeVelarStructureTabId !== id) return
    const nextActive = nextTabs[Math.min(Math.max(closedIndex - 1, 0), nextTabs.length - 1)]
    if (nextActive) {
      setActiveVelarStructureTabId(nextActive.id)
      setVelarStructureActiveTab('structure')
      return
    }
    setActiveVelarStructureTabId(VelarStructureOverviewTab.id)
    setVelarStructureActiveTab('structure')
  }

  return (
    <main className={styles.root}>
      <div
        className={styles.workbenchShell}
        data-standalone="true"
        data-mac-title-inset={macTitleInset && !windowFullScreen}
        data-host-platform={hostPlatform}
        data-right-tool-open={surface.isRightToolOpen}
        data-command-panel-open={!surface.isCommandPanelCollapsed}
        data-workbench-theme={workbenchPreferences.preferences.theme}
        data-velar-theme-scope={workbenchPreferences.preferences.theme}
        data-workbench-density={workbenchPreferences.preferences.density}
        data-workbench-accent={workbenchPreferences.preferences.accent}
        data-workbench-viewport={layout.viewportProfile}
        style={shellStyle}
        ref={layout.shellRef}
      >
        <header className={styles.ideUnifiedTopBar}>
          <div className={styles.ideUnifiedTopLeading}>
            <WorkbenchProjectControl
              state={projectHubState}
              onSwitchProject={switchProject}
              onOpenProjectInNewWindow={openProjectInNewWindow}
              onAddLocalProject={addLocalProject}
              onCloneProjectInNewWindow={(remoteUrl) =>
                window.velarosWorkbenchProjectHub.cloneProjectInNewWindow(remoteUrl)
              }
            />
            <WorkbenchTopLeading {...editorChrome} />
          </div>
          <div className={styles.ideUnifiedTopSpacer} />
          <div className={styles.ideUnifiedTopTrailing}>
            <WorkbenchTopTrailing {...editorChrome} />
          </div>
        </header>
        <section className={styles.ideBody} data-right-tool-open={surface.isRightToolOpen}>
          <aside className={styles.leftToolPane}>
            <div
              className={styles.leftToolRailColumn}
              role="navigation"
              aria-label={t('workbench.leftToolWindows')}
            >
              <div className={styles.leftToolRailTop}>
                <IconButton
                  variant="ghost"
                  size="icon-sm"
                  className={styles.leftToolButton}
                  title={t('workbench.projectView')}
                  label={t('workbench.projectView')}
                  data-active={surface.isFilePanelOpen && surface.activeLeftTool === 'project'}
                  onClick={() => toggleLeftTool('project')}
                >
                  <FolderIcon size={18} weight="duotone" />
                </IconButton>
                {chrome.velarLogicGraphAvailable && (
                  <IconButton
                    variant="ghost"
                    size="icon-sm"
                    className={styles.leftToolButton}
                    title={t('workbench.velarLogicGraphOpenTitle')}
                    label={t('workbench.velarLogicGraphOpenTitle')}
                    data-active={
                      surface.isFilePanelOpen && surface.activeLeftTool === 'velar-structure'
                    }
                    onClick={openVelarStructure}
                  >
                    <TreeViewIcon size={20} weight="bold" />
                  </IconButton>
                )}
                <IconButton
                  variant="ghost"
                  size="icon-sm"
                  className={styles.leftToolButton}
                  title={t('workbench.commitToolWindow')}
                  label={t('workbench.commitToolWindow')}
                  data-active={surface.isFilePanelOpen && surface.activeLeftTool === 'commit'}
                  onClick={() => toggleLeftTool('commit')}
                >
                  <GitCommitIcon size={18} />
                </IconButton>
                <IconButton
                  variant="ghost"
                  size="icon-sm"
                  className={styles.leftToolButton}
                  title={t('workbench.aiChangesTitle')}
                  label={t('workbench.aiChangesTitle')}
                  data-active={surface.isFilePanelOpen && surface.activeLeftTool === 'ai-changes'}
                  data-badge={aiChanges.hasUnseenRounds}
                  onClick={toggleAiChanges}
                >
                  <NotePencilIcon size={18} weight="duotone" />
                </IconButton>
              </div>
              <div className={styles.leftToolRailBottom}>
                {bottomToolItems.map((item) => (
                  <IconButton
                    key={item.id}
                    variant="ghost"
                    size="icon-sm"
                    className={styles.leftToolButton}
                    title={item.label}
                    label={
                      item.isRunning
                        ? `${item.label} · ${t('workbench.commandRunning')}`
                        : item.label
                    }
                    data-active={
                      !surface.isCommandPanelCollapsed && surface.activeBottomTool === item.id
                    }
                    data-running={item.isRunning}
                    onClick={() => model.actions.toggleBottomTool(item.id)}
                  >
                    {item.icon}
                  </IconButton>
                ))}
              </div>
            </div>
          </aside>
          <WorkbenchEmbeddedKernel
            model={embeddedKernelModel}
            leftMode={
              surface.activeLeftTool === 'commit'
                ? 'changes'
                : surface.activeLeftTool === 'velar-structure'
                  ? 'velar-structure'
                  : surface.activeLeftTool === 'ai-changes'
                    ? 'ai-changes'
                    : 'files'
            }
            embeddedChrome={{
              density: workbenchPreferences.preferences.density,
              editorStyle: workbenchPreferences.style,
              // 跟外壳上的布局变量走：拖分隔条时外壳逐帧直写这条变量，文件面板随之变宽，不经过 React。
              filePanelWidth: 'var(--workbench-file-pane-width)',
              isFilePanelOpen: surface.isFilePanelOpen,
              isFilePanelInline: true,
              onFilePanelResizePointerDown: (event) => layout.beginResizePane('file', event),
            }}
          />
          <div
            className={`${styles.verticalResizeHandle} ${styles.rightResizeHandle}`}
            role="separator"
            aria-orientation="vertical"
            aria-label={t('workbench.resizeRightPane')}
            onPointerDown={(event) => layout.beginResizePane('right', event)}
            onDoubleClick={() => layout.resetPaneSize('right')}
          />
          <aside
            className={styles.rightToolPanel}
            data-open={surface.isRightToolOpen}
            aria-label="Workbench Agent"
          >
            <div className={styles.rightToolContent}>
              <WorkbenchChatPanel
                projectRoot={workbench.activeProject.rootPath}
                currentFilePath={workbench.selectedFilePath}
                pendingBrowserElementSelections={model.pendingBrowserElementSelections}
                onBrowserElementSelectionsConsumed={
                  model.actions.consumeWorkbenchBrowserElementSelections
                }
                pendingFileReferences={model.pendingChatFileReferences}
                onFileReferencesConsumed={model.actions.consumeWorkbenchChatFileReferences}
                onOpenFileChange={model.actions.handleWorkbenchChatFileChangeOpen}
                onOpenWorkspacePath={model.actions.handleWorkbenchChatWorkspacePathOpen}
                onReviewFileChanges={model.actions.handleWorkbenchChatFileChangesReview}
                onReviewRunChanges={model.actions.handleWorkbenchChatRunChangesReview}
              />
            </div>
          </aside>
          <aside className={styles.rightToolRail} aria-label={t('workbench.rightToolWindows')}>
            <div className={styles.rightToolStrip}>
              <div className={styles.rightToolWindowGroup}>
                <IconButton
                  variant="ghost"
                  size="icon-sm"
                  className={styles.rightToolButton}
                  title="Workbench Agent"
                  label="Workbench Agent"
                  data-active={surface.activeRightTool === 'chat'}
                  onClick={() => surface.toggleRightTool('chat')}
                >
                  <ChatCircleTextIcon size={18} weight="duotone" />
                </IconButton>
              </div>
            </div>
          </aside>
        </section>
        {!surface.isCommandPanelCollapsed && (
          <section className={styles.bottomToolWindowSlot}>
            <div
              className={styles.horizontalResizeHandle}
              role="separator"
              aria-orientation="horizontal"
              aria-label={t('workbench.resizeTerminalPane')}
              onPointerDown={(event) => layout.beginResizePane('command', event)}
              onDoubleClick={() => layout.resetPaneSize('command')}
            />
            <CommandPanel
              activeTool={surface.activeBottomTool}
              workbenchRun={{
                runSessions: workbench.runSessions,
                activeRunSessionId: workbench.activeRunSessionId,
              }}
              workbenchTerminal={{
                terminalSessions: workbench.terminalSessions,
                activeTerminalSessionId: workbench.activeTerminalSessionId,
              }}
              workbenchTheme={workbenchPreferences.preferences.theme}
              isCollapsed={false}
              gitPanel={
                <WorkbenchGitToolPanel
                  workspaceRoot={workbench.activeProject.rootPath}
                  summary={model.gitState.summary}
                  isLoading={model.gitState.isLoading}
                  error={model.gitState.error}
                  onInitialize={model.actions.initializeRepository}
                />
              }
              problemsPanel={
                <CodeInsightPanel
                  hideHeader
                  projectRoot={workbench.activeProject.rootPath}
                  activeProblemId={editorNavigation.activeProblemId}
                  onActiveProblemChange={(problem) =>
                    editorNavigation.setActiveProblemId(problem.id)
                  }
                  workbenchSelection={{
                    selectedEntry: workbench.selectedEntry,
                    selectedFilePath: workbench.selectedFilePath,
                    selectedFile: workbench.selectedFile,
                  }}
                  workbenchEditor={{ openTabs: workbench.openTabs }}
                  workbenchCommand={{ commandResult: workbench.commandResult }}
                  languageServiceInsights={workbench.languageServiceInsights}
                  onGoToLocation={(path, line, column) =>
                    void editorNavigation.goToLocation(path, line, column)
                  }
                />
              }
              onToggleCollapsed={surface.toggleCommandPanelCollapsed}
              onCreateTerminalSession={() => void workbench.createTerminalSession()}
              onActiveTerminalSessionChange={workbench.setActiveTerminalSessionId}
              onCloseTerminalSession={workbench.closeTerminalSession}
              onTerminalData={workbench.writeTerminalData}
              onTerminalResize={workbench.resizeTerminalSession}
              onActiveRunSessionChange={workbench.setActiveRunSessionId}
              onCloseRunSession={workbench.closeRunSession}
              onRestartRunSession={(sessionId) => void workbench.restartRunSession(sessionId)}
              onStopRunSession={(sessionId) => void workbench.stopRunSession(sessionId)}
              onOpenConsoleLink={editorNavigation.debug.openTab}
              onResolveTerminalFileLinks={resolveTerminalFileLinks}
              onOpenTerminalFileLink={(path, line, column) =>
                void model.actions.navigate({ target: 'file', path, line, column })
              }
            />
          </section>
        )}
        <StatusBar
          projectName={workbench.activeProject.name}
          selectedFilePath={
            editorNavigation.diffItem?.path ??
            editorNavigation.lightTab?.path ??
            workbench.selectedFilePath
          }
          cursorPosition={editorNavigation.cursorPosition}
          hasUnsavedChanges={
            editorNavigation.diffItem || editorNavigation.lightTab
              ? false
              : workbench.hasUnsavedChanges
          }
          readOnly={
            !editorNavigation.diffItem
            && !editorNavigation.lightTab
            && !!workbench.selectedFile
            && !workbench.canEditSelectedFile
          }
          isSavingFile={workbench.isSavingFile}
          openFileCount={workbench.openTabs.length}
          commandStatusLabel={commandStatusLabel}
          textFormat={selectedTextFormat}
          indentation={
            editorNavigation.diffItem || editorNavigation.lightTab ? null : editorNavigation.indentation
          }
          onChangeIndentation={editorNavigation.requestIndentationChange}
          onChangeEol={(eol) => {
            if (!selectedTextFormat) return
            void workbench.convertSelectedFileTextFormat({
              encoding: selectedTextFormat.encoding,
              eol,
            })
          }}
        />
        <EditorUnsavedChangesDialog
          request={workbench.closeRequest}
          openTabs={workbench.openTabs}
          autosaveFailures={workbench.autosaveFailures}
          saving={workbench.isResolvingCloseRequest}
          onResolve={(choice) => void workbench.resolveCloseRequest(choice)}
        />
        <WorkbenchSettingsDialog
          open={dialogs.settingsOpen}
          preferences={workbenchPreferences.preferences}
          keymap={workbenchKeymap.keymap}
          conflicts={workbenchKeymap.conflicts}
          locale={locale}
          project={{
            name: workbench.activeProject.name,
            rootPath: workbench.activeProject.rootPath,
          }}
          onExitProject={model.actions.exitCurrentProject}
          onOpenChange={dialogs.setSettingsOpen}
          onPreferencesChange={workbenchPreferences.updatePreferences}
          onResetPreferences={workbenchPreferences.resetPreferences}
          onSetShortcut={workbenchKeymap.setShortcut}
          onResetShortcut={workbenchKeymap.resetShortcut}
          onResetAllShortcuts={workbenchKeymap.resetAllShortcuts}
          onLocaleChange={(nextLocale) => void translate.setLocale(nextLocale)}
        />
      </div>
      {/* 第一次要打开时才挂上（请求序号从 1 起），之后一直挂着：关着时渲染为空，输入与状态留到下次。 */}
      {surface.quickOpenRequest.id > 0 && (
        <Suspense fallback={null}>
          <LazyQuickOpen
            isOpen={surface.isQuickOpenOpen}
            request={surface.quickOpenRequest}
            activeProject={workbench.activeProject}
            openTabs={workbench.openTabs}
            activeFilePath={workbench.selectedFilePath}
            activeFileContent={workbench.editorContent}
            recentFilePaths={model.recentFilePaths}
            projectFiles={model.projectFiles}
            commandPalette={model.commandPalette}
            keymap={workbenchKeymap.keymap}
            onClose={surface.closeQuickOpen}
            onOpenFile={(path, position) => void model.actions.openQuickOpenFile(path, position)}
          />
        </Suspense>
      )}
    </main>
  )
}
