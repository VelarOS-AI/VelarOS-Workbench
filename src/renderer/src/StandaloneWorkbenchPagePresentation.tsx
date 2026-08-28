/**
 * 独立工作台主界面拼装：左侧项目与底部工具 rail、文件/编辑器中央装配、右侧产品动作、
 * 运行/终端/问题工具窗、设置、状态栏与 QuickOpen。
 *
 * 文件、Git、终端、运行与语言洞察由独立应用自持；chat/model 走 Kernel 语义路由，
 * 项目索引与事务变更走发布版 Workspace 模块，Browser 走发布版 composition 端口。
 */
import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChatCircleTextIcon,
  FolderIcon,
  GitBranchIcon,
  GitCommitIcon,
  PlayIcon,
  TerminalWindowIcon,
  TreeViewIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
import { WorkbenchChatPanel } from '@renderer/components/chat/WorkbenchChatPanel'
import { useWorkbenchHostRuntime } from '@renderer/host'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'

import type { VelarLogicGraphSnapshot } from '@shared/contributions/velar/logicGraph'
import type { WorkbenchProjectHubState } from '@shared/projectHub'

import { resolveWorkbenchChatProviderId } from '../../plugins/agent-engines/identity'
import {
  useWorkbenchAgentEnginesContributionEnabled,
  WorkbenchAgentEnginesRendererContribution,
} from '../../plugins/agent-engines/renderer/contribution'

import { StatusBar } from './components/chrome/StatusBar'
import { WorkbenchTopLeading, WorkbenchTopTrailing } from './components/chrome/TopToolbar'
import { WorkbenchProjectControl } from './components/chrome/WorkbenchProjectControl'
import { WorkbenchCodeGraphDialog } from './components/codeGraph/WorkbenchCodeGraphDialog'
import { WorkbenchLogicGraphEditor } from './components/codeGraph/WorkbenchLogicGraphDialog'
import { CodeInsightPanel } from './components/editor/CodeInsightPanel'
import { ReadOnlyWorkbenchCode } from './components/editor/ReadOnlyWorkbenchCode'
import { WorkbenchEmbeddedKernel } from './components/embedded/WorkbenchEmbeddedKernel'
import {
  buildStandaloneWorkbenchEditorChrome,
  buildStandaloneWorkbenchEmbeddedKernelModel,
} from './components/embedded/workbenchEmbeddedKernelAdapter'
import { WorkbenchFileTypeIcon } from './components/files/WorkbenchFileTypeIcon'
import { WorkbenchGitToolPanel } from './components/git/WorkbenchGitToolPanel'
import { QuickOpen } from './components/project/QuickOpen'
import { WorkbenchSettingsDialog } from './components/settings/WorkbenchSettingsDialog'
import { type BottomTool, CommandPanel } from './components/terminal/CommandPanel'
import { discoverWorkbenchVelarProjectRoots } from './models/codeGraph/workbenchVelarProjectGraph'
import styles from './styles/workbenchPageStyles'
import { useWorkbenchPageContext } from './WorkbenchPageModelContext'

interface StandaloneWorkbenchPagePresentationProps {
  projectHubState: WorkbenchProjectHubState
}

interface VelarStructureViewTab {
  id: string
  scopePaths: readonly string[]
}

function velarStructureTabId(scopePaths: readonly string[]): string {
  return `velar-structure:${[...scopePaths].sort().map(encodeURIComponent).join('|')}`
}

function defaultVelarStructureRoot(
  files: ReadonlyArray<{ path: string }>,
  rootEntries: ReadonlyArray<{ path: string; type: string }>,
  projectRoots: readonly string[]
): Nullable<string> {
  const nestedProjectRoot = projectRoots.find((root) => root !== '')
  if (!projectRoots.includes('') && nestedProjectRoot) return nestedProjectRoot
  const roots = new Set<string>()
  for (const file of files) {
    const normalized = file.path.trim().replace(/\\/g, '/').replace(/^\.\//, '')
    const separator = normalized.indexOf('/')
    if (separator > 0) roots.add(normalized.slice(0, separator))
  }
  if (roots.has('src')) return 'src'
  const fileRoot = [...roots].sort((left, right) => left.localeCompare(right))[0]
  if (fileRoot) return fileRoot
  const directories = rootEntries
    .filter((entry) => entry.type === 'directory')
    .map((entry) => entry.path.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
  if (directories.includes('src')) return 'src'
  return directories.sort((left, right) => left.localeCompare(right))[0] ?? null
}

export function StandaloneWorkbenchPagePresentation({
  projectHubState,
}: StandaloneWorkbenchPagePresentationProps): ReactElement {
  const model = useWorkbenchPageContext()
  const runtime = useWorkbenchHostRuntime()
  const agentEnginesEnabled = useWorkbenchAgentEnginesContributionEnabled()
  const {
    workbench,
    surface,
    layout,
    projectGitSettings,
    workbenchPreferences,
    workbenchKeymap,
    editorNavigation,
    automation,
    chrome,
    dialogs,
  } = model
  const {
    translate,
    locale,
    t,
    globalGitConfig,
    shellStyle,
    projectAiIndexSkipped,
    codeGraphAvailable,
    macTitleInset,
    commandStatusLabel,
  } = chrome

  const activeRightTool = surface.activeRightTool ?? 'chat'
  const activeChatProviderId = resolveWorkbenchChatProviderId(activeRightTool)
  const pendingFileOpenId = projectHubState.pendingFileOpen?.id
  const pendingFileOpenPath = projectHubState.pendingFileOpen?.path
  const activeProjectId = workbench.activeProject?.id
  const activeProjectRoot = workbench.activeProject?.rootPath
  const [velarManifestPaths, setVelarManifestPaths] = useState<readonly string[]>([])
  const [velarManifestDiscoveryComplete, setVelarManifestDiscoveryComplete] = useState(false)
  const [velarStructureTabs, setVelarStructureTabs] =
    useState<readonly VelarStructureViewTab[]>([])
  const [activeVelarStructureTabId, setActiveVelarStructureTabId] = useState('')
  const [velarStructureSnapshot, setVelarStructureSnapshot] =
    useState<Nullable<VelarLogicGraphSnapshot>>(null)
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
  useEffect(() => {
    let cancelled = false
    setVelarManifestPaths([])
    setVelarManifestDiscoveryComplete(false)
    if (!activeProjectRoot) {
      setVelarManifestDiscoveryComplete(true)
      return
    }
    void runtime.kernel.project
      .searchWorkbenchEntries({
        projectRoot: activeProjectRoot,
        query: 'velar.json',
        limit: 200,
        maxDepth: 12,
      })
      .then((result) => {
        if (cancelled || !result.ok) return
        setVelarManifestPaths(
          result.data.entries
            .filter((entry) => entry.type === 'file' && entry.name === 'velar.json')
            .map((entry) => entry.path)
        )
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setVelarManifestDiscoveryComplete(true)
      })
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
  ])
  const velarStructureProjectFiles = useMemo(
    () => velarStructureProjectPaths.filter((file) => file.path.endsWith('.vel')),
    [velarStructureProjectPaths]
  )
  const velarStructureProjectRoots = useMemo(
    () => discoverWorkbenchVelarProjectRoots(velarStructureProjectPaths.map((file) => file.path)),
    [velarStructureProjectPaths]
  )
  const velarStructureDefaultRoot = useMemo(
    () =>
      defaultVelarStructureRoot(
        velarStructureProjectFiles,
        workbench.rootEntries,
        velarStructureProjectRoots
      ),
    [velarStructureProjectFiles, velarStructureProjectRoots, workbench.rootEntries]
  )
  const handleVelarStructureSnapshotChange = useCallback(
    (snapshot: VelarLogicGraphSnapshot): void => setVelarStructureSnapshot(snapshot),
    []
  )
  const velarStructureScopePaths = useMemo(
    () => velarStructureTabs.find((tab) => tab.id === activeVelarStructureTabId)?.scopePaths ?? [],
    [activeVelarStructureTabId, velarStructureTabs]
  )
  const describeVelarStructureTab = useCallback(
    (scopePaths: readonly string[]) => {
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
    [velarStructureSnapshot]
  )
  useEffect(() => {
    if (!agentEnginesEnabled && surface.activeRightTool !== 'chat') surface.closeRightTool()
  }, [agentEnginesEnabled, surface.activeRightTool])

  useEffect(() => {
    if (chrome.velarLogicGraphAvailable) return
    dialogs.setVelarLogicGraphOpen(false)
    dialogs.setVelarLogicGraphActive(false)
  }, [chrome.velarLogicGraphAvailable, dialogs])

  useEffect(() => {
    setVelarStructureTabs([])
    setActiveVelarStructureTabId('')
    setVelarStructureSnapshot(null)
    setVelarStructureActiveTab('structure')
    setVelarSourcePreview(null)
  }, [activeProjectId])

  useEffect(() => {
    if (
      !dialogs.velarLogicGraphOpen
      || velarStructureTabs.length > 0
      || !velarStructureDefaultRoot
      || (!velarManifestDiscoveryComplete && velarStructureProjectRoots.length === 0)
    ) return
    const scopePaths = [velarStructureDefaultRoot]
    const id = velarStructureTabId(scopePaths)
    setVelarStructureTabs([{ id, scopePaths }])
    setActiveVelarStructureTabId(id)
  }, [
    dialogs.velarLogicGraphOpen,
    velarManifestDiscoveryComplete,
    velarStructureDefaultRoot,
    velarStructureProjectRoots.length,
    velarStructureTabs.length,
  ])

  useEffect(() => {
    if (!pendingFileOpenId || !pendingFileOpenPath || !activeProjectId) return

    let active = true
    void workbench.selectFile(pendingFileOpenPath).finally(() => {
      if (active) {
        void window.velarosWorkbenchProjectHub.acknowledgeFileOpen(pendingFileOpenId)
      }
    })
    return () => {
      active = false
    }
  }, [activeProjectId, pendingFileOpenId, pendingFileOpenPath, workbench.selectFile])

  if (!workbench.activeProject) return <main className={styles.root} />
  const projectRoot = workbench.activeProject.rootPath

  const bottomToolItems: Array<{
    id: BottomTool
    label: string
    icon: ReactElement
  }> = [
    ...(workbench.runSessions.length > 0
      ? [
          {
            id: 'run' as const,
            label: t('workbench.commandTabRuns'),
            icon: <PlayIcon size={18} weight="regular" />,
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
  const embeddedKernelModel = {
    ...baseEmbeddedKernelModel,
    velarStructure: {
      projectFiles: velarStructureProjectFiles,
      snapshot: velarStructureSnapshot,
      scopePaths: velarStructureScopePaths,
      onScopePathsChange: openVelarStructureScope,
    },
    editor: {
      ...baseEmbeddedKernelModel.editor,
      diff: {
        ...baseEmbeddedKernelModel.editor.diff,
        auxiliaryTabs: dialogs.velarLogicGraphOpen
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
                  onClose: () => closeVelarStructureTab(structureTab.id),
                  content: (
                    <WorkbenchLogicGraphEditor
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
                      refreshVersion={workbench.saveRevision + workbench.workspaceBindingVersion}
                      workbenchTheme={workbenchPreferences.preferences.theme}
                      onSnapshotChange={handleVelarStructureSnapshotChange}
                      onOpenSource={(source) => {
                        setVelarSourcePreview(source)
                        setVelarStructureActiveTab('source')
                      }}
                    />
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
                        if (velarStructureTabs.length > 0) {
                          setVelarStructureActiveTab('structure')
                        } else {
                          dialogs.setVelarLogicGraphOpen(false)
                          dialogs.setVelarLogicGraphActive(false)
                        }
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
          : [],
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
    dialogs.setVelarLogicGraphActive(false)
    if (surface.activeLeftTool === tool) {
      surface.toggleFilePanel()
      return
    }
    surface.setActiveLeftTool(tool)
    if (!surface.isFilePanelOpen) surface.toggleFilePanel()
  }

  function openVelarStructure(): void {
    if (surface.activeLeftTool === 'velar-structure' && surface.isFilePanelOpen) {
      surface.toggleFilePanel()
      return
    }
    surface.setActiveLeftTool('velar-structure')
    if (!surface.isFilePanelOpen) surface.toggleFilePanel()
    dialogs.setVelarLogicGraphOpen(true)
    dialogs.setVelarLogicGraphActive(true)
    setVelarStructureActiveTab('structure')
    if (velarStructureDefaultRoot) {
      const scopePaths = [velarStructureDefaultRoot]
      const id = velarStructureTabId(scopePaths)
      setVelarStructureTabs((current) =>
        current.some((tab) => tab.id === id) ? current : [...current, { id, scopePaths }]
      )
      setActiveVelarStructureTabId(id)
    }
  }

  function openVelarStructureScope(scopePaths: readonly string[]): void {
    const normalizedPaths = [...new Set(scopePaths)]
    if (normalizedPaths.length === 0 && velarStructureDefaultRoot) {
      normalizedPaths.push(velarStructureDefaultRoot)
    }
    if (normalizedPaths.length === 0) return
    const id = velarStructureTabId(normalizedPaths)
    setVelarStructureTabs((current) =>
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
    setActiveVelarStructureTabId(id)
    dialogs.setVelarLogicGraphActive(true)
    setVelarStructureActiveTab('structure')
  }

  function closeVelarStructureTab(id: string): void {
    const closedIndex = velarStructureTabs.findIndex((tab) => tab.id === id)
    const nextTabs = velarStructureTabs.filter((tab) => tab.id !== id)
    setVelarStructureTabs(nextTabs)
    if (activeVelarStructureTabId !== id) return
    const nextActive = nextTabs[Math.min(Math.max(closedIndex, 0), nextTabs.length - 1)]
    if (nextActive) {
      setActiveVelarStructureTabId(nextActive.id)
      setVelarStructureActiveTab('structure')
      return
    }
    if (velarSourcePreview) {
      setVelarStructureActiveTab('source')
      return
    }
    dialogs.setVelarLogicGraphOpen(false)
    dialogs.setVelarLogicGraphActive(false)
  }

  return (
    <main className={styles.root}>
      <div
        className={styles.workbenchShell}
        data-standalone="true"
        data-mac-title-inset={macTitleInset}
        data-right-tool-open={surface.isRightToolOpen}
        data-command-panel-open={!surface.isCommandPanelCollapsed}
        data-workbench-theme={workbenchPreferences.preferences.theme}
        data-velar-theme-scope={workbenchPreferences.preferences.theme}
        data-workbench-density={workbenchPreferences.preferences.density}
        data-workbench-accent={workbenchPreferences.preferences.accent}
        data-workbench-viewport={layout.viewportProfile}
        data-ai-automation-active={!!automation.state}
        style={shellStyle}
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
              </div>
              <div className={styles.leftToolRailBottom}>
                {bottomToolItems.map((item) => (
                  <IconButton
                    key={item.id}
                    variant="ghost"
                    size="icon-sm"
                    className={styles.leftToolButton}
                    title={item.label}
                    label={item.label}
                    data-active={
                      !surface.isCommandPanelCollapsed && surface.activeBottomTool === item.id
                    }
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
                  : 'files'
            }
            embeddedChrome={{
              editorStyle: workbenchPreferences.style,
              filePanelWidth: layout.filePaneWidth,
              isFilePanelOpen: surface.isFilePanelOpen,
              isFilePanelInline: true,
              onFilePanelResizePointerDown: (event) => layout.beginResizePane('file', event),
            }}
          />
          <div
            className={styles.rightResizeHandle}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chat panel"
            onPointerDown={(event) => layout.beginResizePane('right', event)}
            onDoubleClick={() => layout.resetPaneSize('right')}
          />
          <aside
            className={styles.rightToolPanel}
            data-open={surface.isRightToolOpen}
            aria-label={
              activeRightTool === 'claude'
                ? 'Claude'
                : activeRightTool === 'chatgpt'
                  ? 'ChatGPT'
                  : 'Workbench Agent'
            }
          >
            <div className={styles.rightToolContent}>
              <WorkbenchChatPanel
                key={activeChatProviderId}
                providerId={activeChatProviderId}
                projectRoot={workbench.activeProject.rootPath}
                currentFilePath={workbench.selectedFilePath}
                pendingBrowserElementSelections={model.pendingBrowserElementSelections}
                onBrowserElementSelectionsConsumed={
                  model.actions.consumeWorkbenchBrowserElementSelections
                }
                onOpenFileChange={model.actions.handleWorkbenchChatFileChangeOpen}
                onOpenWorkspacePath={model.actions.handleWorkbenchChatWorkspacePathOpen}
                onReviewFileChanges={model.actions.handleWorkbenchChatFileChangesReview}
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
                {(agentEnginesEnabled ? WorkbenchAgentEnginesRendererContribution : []).map(
                  (item) => (
                    <IconButton
                      key={item.id}
                      variant="ghost"
                      size="icon-sm"
                      className={styles.rightToolButton}
                      title={item.label}
                      label={item.label}
                      data-active={surface.activeRightTool === item.id}
                      onClick={() => surface.toggleRightTool(item.id)}
                    >
                      {item.icon}
                    </IconButton>
                  )
                )}
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
                commandHistory: workbench.commandHistory,
                runConfigurations: workbench.runConfigurations,
                projectFiles: workbench.projectContextIndex.files,
              }}
              workbenchTerminal={{
                terminalSessions: workbench.terminalSessions,
                activeTerminalSessionId: workbench.activeTerminalSessionId,
              }}
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
              onTerminalInputChange={workbench.setTerminalInput}
              onRunTerminalInput={(sessionId) => void workbench.runTerminalInput(sessionId)}
              onCloseTerminalSession={workbench.closeTerminalSession}
              onActiveRunSessionChange={workbench.setActiveRunSessionId}
              onCloseRunSession={workbench.closeRunSession}
              onRestartRunSession={(sessionId) => void workbench.restartRunSession(sessionId)}
              onStopRunSession={(sessionId) => void workbench.stopRunSession(sessionId)}
              onRunInputChange={workbench.setRunSessionInput}
              onSubmitRunInput={(sessionId) => void workbench.writeRunSessionInput(sessionId)}
              onInterruptRunSession={(sessionId) =>
                void workbench.sendRunSessionInterrupt(sessionId)
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
          isSavingFile={workbench.isSavingFile}
          openFileCount={workbench.openTabs.length}
          commandStatusLabel={commandStatusLabel}
          isIndexingProject={workbench.isIndexingProject}
          projectAiIndexStatus={workbench.projectAiIndexStatus}
          projectAiIndexSkipped={projectAiIndexSkipped}
          codeGraphAvailable={codeGraphAvailable}
          onOpenProjectAiIndexDetails={() => model.dialogs.setAiIndexDetailsOpen(true)}
        />
        <WorkbenchSettingsDialog
          open={dialogs.settingsOpen}
          preferences={workbenchPreferences.preferences}
          globalGitSshKeyPath={globalGitConfig.privateKeyPath || globalGitConfig.sshKeyPath}
          projectGitSshKeyPath={projectGitSettings.settings.gitSshKeyPath}
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
          onProjectGitSshKeyPathChange={(gitSshKeyPath) =>
            projectGitSettings.updateSettings({ gitSshKeyPath })
          }
          onResetPreferences={workbenchPreferences.resetPreferences}
          onSetShortcut={workbenchKeymap.setShortcut}
          onResetShortcut={workbenchKeymap.resetShortcut}
          onResetAllShortcuts={workbenchKeymap.resetAllShortcuts}
          onLocaleChange={(nextLocale) => void translate.setLocale(nextLocale)}
        />
        <WorkbenchCodeGraphDialog
          open={dialogs.codeGraphOpen}
          onOpenChange={dialogs.setCodeGraphOpen}
          projectRoot={workbench.activeProject.rootPath}
          onOpenLocation={(path, line, column) =>
            void editorNavigation.goToLocation(path, line ?? 1, column ?? 1)
          }
        />
      </div>
      <QuickOpen
        isOpen={surface.isQuickOpenOpen}
        activeProject={workbench.activeProject}
        openTabs={workbench.openTabs}
        onClose={surface.closeQuickOpen}
        onOpenLocation={(path, line, column) => {
          dialogs.setVelarLogicGraphActive(false)
          void editorNavigation.goToLocation(path, line, column)
        }}
      />
    </main>
  )
}
