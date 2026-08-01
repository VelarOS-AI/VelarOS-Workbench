/**
 * 独立工作台主界面拼装：左侧项目与底部工具 rail、文件/编辑器中央装配、右侧产品动作、
 * 运行/终端/问题工具窗、设置、状态栏与 QuickOpen。
 *
 * 文件、Git、终端、运行与语言洞察由独立应用自持；chat/model 走 Kernel 语义路由，
 * 项目索引与事务变更走发布版 Workspace 模块，Browser 走发布版 composition 端口。
 */
import { type ReactElement } from 'react'
import {
  ChatCircleTextIcon,
  FolderIcon,
  GitBranchIcon,
  PlayIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react'
import { WorkbenchChatPanel } from '@renderer/components/chat/WorkbenchChatPanel'

import { IconButton } from '@velaros-ai/ui/primitives/buttons/IconButton'

import { StatusBar } from './components/chrome/StatusBar'
import { WorkbenchTopTrailing } from './components/chrome/TopToolbar'
import { CodeInsightPanel } from './components/editor/CodeInsightPanel'
import { WorkbenchEmbeddedKernel } from './components/embedded/WorkbenchEmbeddedKernel'
import {
  buildStandaloneWorkbenchEditorChrome,
  buildStandaloneWorkbenchEmbeddedKernelModel,
} from './components/embedded/workbenchEmbeddedKernelAdapter'
import { WorkbenchGitToolPanel } from './components/git/WorkbenchGitToolPanel'
import { QuickOpen } from './components/project/QuickOpen'
import { WorkbenchSettingsDialog } from './components/settings/WorkbenchSettingsDialog'
import { type BottomTool, CommandPanel } from './components/terminal/CommandPanel'
import styles from './styles/workbenchPageStyles'
import { useWorkbenchPageContext } from './WorkbenchPageModelContext'

export function StandaloneWorkbenchPagePresentation(): ReactElement {
  const model = useWorkbenchPageContext()
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

  if (!workbench.activeProject) return <main className={styles.root} />

  const bottomToolItems: Array<{
    id: BottomTool
    label: string
    icon: ReactElement
  }> = [
    {
      id: 'run',
      label: t('workbench.commandTabRuns'),
      icon: <PlayIcon size={18} weight="regular" />,
    },
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
  const embeddedKernelModel = buildStandaloneWorkbenchEmbeddedKernelModel(model, editorChrome)

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
                  data-active={surface.activeLeftTool === 'project'}
                  onClick={() => surface.setActiveLeftTool('project')}
                >
                  <FolderIcon size={18} weight="duotone" />
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
            leftMode="files"
            embeddedChrome={{
              filePanelWidth: layout.filePaneWidth,
              isFilePanelOpen: true,
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
            data-open={surface.activeRightTool === 'chat'}
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
                onOpenFileChange={model.actions.handleWorkbenchChatFileChangeOpen}
                onOpenWorkspacePath={model.actions.handleWorkbenchChatWorkspacePathOpen}
                onReviewFileChanges={model.actions.handleWorkbenchChatFileChangesReview}
              />
            </div>
          </aside>
          <aside className={styles.rightToolRail} aria-label={t('workbench.rightToolWindows')}>
            <div className={styles.rightToolStrip}>
              <div className={styles.rightToolActionGroup}>
                <WorkbenchTopTrailing {...editorChrome} placement="rail" />
              </div>
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
                  changeItems={model.gitState.changeItems}
                  isLoading={model.gitState.isLoading}
                  error={model.gitState.error}
                  hasUnsavedOpenTabs={workbench.hasUnsavedOpenTabs}
                  onRefresh={model.actions.refreshGitPanel}
                  onInitialize={model.actions.initializeRepository}
                  onOpenDiff={editorNavigation.openDiff}
                  onRepositoryChanged={model.actions.handleRepositoryChanged}
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
      </div>
      <QuickOpen
        isOpen={surface.isQuickOpenOpen}
        activeProject={workbench.activeProject}
        openTabs={workbench.openTabs}
        onClose={surface.closeQuickOpen}
        onOpenLocation={(path, line, column) =>
          void editorNavigation.goToLocation(path, line, column)
        }
      />
    </main>
  )
}
