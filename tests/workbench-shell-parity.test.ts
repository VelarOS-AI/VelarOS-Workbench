import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

void describe('pre-split Workbench shell parity', () => {
  void test('uses the shared conversation surface instead of the temporary form', () => {
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')

    assert.match(adapter, /@velaros-ai\/ui\/conversation/)
    assert.match(adapter, /<ChatConversationPane/)
    assert.match(adapter, /<ChatComposer/)
    assert.doesNotMatch(adapter, /wb_standaloneChatSurface/)
    assert.doesNotMatch(adapter, /Ask the injected VelarOS Agent/)
  })

  void test('lets the IDE surface fill the window without a duplicate project header', () => {
    const shell = readSource('src/renderer/src/workspace/WorkbenchWorkspaceShell.tsx')
    const styles = readSource('src/renderer/src/workspace/workspaceShell.css')

    assert.doesNotMatch(shell, /workbench-workspace-shell__top-bar/)
    assert.doesNotMatch(shell, />关闭项目</)
    assert.match(styles, /\.workbench-workspace-shell__stage\s*>\s*\*/)
    assert.match(styles, /width:\s*100%/)
  })

  void test('keeps the project view header compact and leaves search in place', () => {
    const panel = readSource('src/renderer/src/components/files/FilePanel.tsx')
    const row = readSource('src/renderer/src/components/files/FileTreeRow.tsx')
    const styles = readSource('src/renderer/src/styles/08-files.module.css')
    const shellStyles = readSource('src/renderer/src/styles/01-shell.module.css')

    assert.doesNotMatch(panel, /<div className=\{styles\.panelHeader\}>/)
    assert.match(panel, /className=\{styles\.filePanelProjectHeader\}/)
    assert.match(panel, /className=\{styles\.filePanelViewTitle\}/)
    assert.match(panel, /workbench\.projectView/)
    assert.match(panel, /entries=\{rootEntries\}/)
    assert.match(panel, /childrenByPath=\{childrenByPath\}/)
    assert.doesNotMatch(panel, /treeRootEntries/)
    assert.doesNotMatch(row, /treeRootActionButton/)
    assert.match(styles, /\.filePanelProjectHeader[\s\S]*flex:\s*0 0 35px[\s\S]*height:\s*35px/)
    assert.match(shellStyles, /--workbench-tab-height:\s*35px/)
    assert.equal(shellStyles.match(/--workbench-tab-height:/g)?.length, 1)
    assert.match(panel, /<SearchField/)
    assert.match(panel, /className=\{styles\.searchInputShell\}[\s\S]*<SearchField/)
    assert.doesNotMatch(panel, /searchInputClearButton/)
  })

  void test('places the project and compact Git controls together in the title row', () => {
    const presentation = readSource('src/renderer/src/StandaloneWorkbenchPagePresentation.tsx')
    const toolbar = readSource('src/renderer/src/components/chrome/TopToolbar.tsx')
    const adapter = readSource(
      'src/renderer/src/components/embedded/workbenchEmbeddedKernelAdapter.ts'
    )
    const control = readSource('src/renderer/src/components/git/WorkbenchGitCommitControl.tsx')
    const sharedControl = readSource(
      'node_modules/@velaros-ai/ui/dist/product/git/WorkspaceGitCommitControl.js'
    )
    const sharedGitStyles = readSource(
      'node_modules/@velaros-ai/ui/dist/product/git/WorkspaceGitCommitControl.module.css'
    )
    const shortcuts = readSource('src/renderer/src/models/layout/workbenchKeyboardShortcuts.ts')

    assert.match(presentation, /<WorkbenchProjectControl/)
    assert.match(presentation, /<WorkbenchTopLeading \{\.\.\.editorChrome\} \/>/)
    assert.match(presentation, /<WorkbenchTopTrailing \{\.\.\.editorChrome\} \/>/)
    assert.doesNotMatch(presentation, /placement="rail"|rightToolActionGroup/)
    assert.match(toolbar, /<WorkbenchGitCommitControl/)
    const runButton = toolbar.indexOf('<WorkbenchRunAction')
    const codeGraphButton = toolbar.indexOf('{codeGraphAvailable && (')
    const settingsButton = toolbar.indexOf('tooltip={settingsLabel}')
    assert.ok(runButton >= 0)
    assert.ok(runButton < codeGraphButton)
    assert.ok(codeGraphButton < settingsButton)
    assert.match(adapter, /gitWorkspaceRoot:\s*workbench\.activeProject\?\.rootPath/)
    assert.match(adapter, /onOpenGitCommitTool:[\s\S]*setActiveLeftTool\('commit'\)/)
    assert.match(adapter, /onOpenGitBottomTool:[\s\S]*openBottomTool\('git'\)/)
    assert.match(control, /switchWorkspaceGitBranch/)
    assert.match(control, /createWorkspaceGitBranch/)
    assert.match(control, /performWorkspaceGitAction/)
    assert.match(control, /workbench\.gitCommitAction/)
    assert.match(control, /<WorkspaceGitCommitControl/)
    assert.doesNotMatch(control, /<Dialog|<FolderIcon/)
    assert.match(sharedGitStyles, /\.gitCompactMenu[\s\S]*background-color:[^;]+!important/)
    assert.match(
      sharedGitStyles,
      /\.gitCompactMenuHeader[\s\S]*padding:\s*var\(--topbar-panel-padding\)/,
    )
    assert.match(
      sharedGitStyles,
      /(?:\.gitCompactInput:focus-visible[\s\S]*background-color:\s*transparent|\.gitCompactSearchSlot :global\(\.velar-search-field-input\)[\s\S]*font-size:\s*11px)/
    )
    assert.match(
      sharedGitStyles,
      /\.gitCreateBranchInput:focus-visible[\s\S]*git-create-branch-input-bg/
    )
    assert.match(sharedControl, /FolderIcon[\s\S]*gitCompactBranchTreeFolder/)
    assert.match(sharedControl, /buildBranchTrie\(branches, namespace\)/)
    assert.match(sharedGitStyles, /\.gitCreateBranchDialog[\s\S]*max-width:\s*min\(320px/)
    assert.match(sharedControl, /Dialog[\s\S]*createDialogTitle/)
    assert.match(sharedControl, /DialogFooter[\s\S]*gitCreateBranchDialogFooter/)
    assert.match(sharedControl, /checked(?:=\{|:\s*)checkoutCreatedBranch/)
    assert.match(
      sharedControl,
      /(?:gitCompactSearchField|gitCompactSearchSlot)[\s\S]*gitCompactFetchButton/
    )
    assert.match(
      sharedControl,
      /gitCompactBranchList[\s\S]*gitCompactFooter[\s\S]*openCreateBranchDialog/
    )
    assert.match(
      sharedControl,
      /gitCompactBranchHoverActions[\s\S]*checkoutAction[\s\S]*uploadAction/
    )
    assert.match(control, /themeColor="var\(--workbench-theme-color\)"/)
    assert.match(control, /switchWorkspaceGitBranch\([\s\S]*\{ create: true \}/)
    assert.match(shortcuts, /toggle-changes', defaultShortcut: 'Mod\+Shift\+G'/)
  })

  void test('opens the branch menu with a Git-only refresh', () => {
    const model = readSource('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx')
    const toolbar = readSource('src/renderer/src/components/chrome/TopToolbar.tsx')

    assert.match(model, /actions:\s*\{[\s\S]*refreshGitPanel:\s*gitState\.refreshGitPanel/)
    assert.doesNotMatch(
      model,
      /actions:\s*\{[\s\S]*refreshGitPanel:\s*refreshGitPanelWithWorkspace/
    )
    assert.match(toolbar, /if \(!gitControlReady\) return null/u)
    assert.doesNotMatch(toolbar, /topGitPlaceholder/u)
  })

  void test('extends macOS content into the title bar and lets the folder button toggle files', () => {
    const main = readSource('src/main/index.ts')
    const presentation = readSource('src/renderer/src/StandaloneWorkbenchPagePresentation.tsx')
    const surface = readSource('src/renderer/src/hooks/useWorkbenchSurfaceState.ts')

    assert.match(main, /titleBarStyle:\s*'hiddenInset'/)
    assert.match(presentation, /onClick=\{\(\) => toggleLeftTool\('project'\)\}/)
    assert.match(presentation, /isFilePanelOpen:\s*surface\.isFilePanelOpen/)
    assert.match(surface, /const \[isFilePanelOpen, setIsFilePanelOpen\] = useState\(true\)/)
  })

  void test('gives the built-in Velar structure its own read-only tree view', () => {
    const presentation = readSource('src/renderer/src/StandaloneWorkbenchPagePresentation.tsx')
    const model = readSource('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx')
    const velarGraph = readSource(
      'src/renderer/src/components/codeGraph/WorkbenchLogicGraphDialog.tsx'
    )
    const codeGraph = readSource(
      'src/renderer/src/components/codeGraph/WorkbenchCodeGraphDialog.tsx'
    )
    const scopeTree = readSource(
      'src/renderer/src/components/codeGraph/WorkbenchLogicGraphScopeTree.tsx'
    )

    const folderButton = presentation.indexOf('<FolderIcon')
    const velarStructureButton = presentation.indexOf('<TreeViewIcon size={20}')
    const commitButton = presentation.indexOf('<GitCommitIcon')
    assert.ok(folderButton >= 0)
    assert.ok(folderButton < velarStructureButton)
    assert.ok(velarStructureButton < commitButton)
    assert.match(presentation, /chrome\.velarLogicGraphAvailable[\s\S]*openVelarStructure/)
    assert.match(presentation, /<WorkbenchCodeGraphDialog[\s\S]*open=\{dialogs\.codeGraphOpen\}/)
    assert.match(presentation, /auxiliaryTabs:[\s\S]*<WorkbenchLogicGraphEditor/)
    assert.match(presentation, /const VelarStructureOverviewTab[\s\S]*velar-structure:overview/)
    assert.match(
      presentation,
      /\[VelarStructureOverviewTab, \.\.\.velarStructureScopeTabs\]/
    )
    assert.match(
      presentation,
      /structureTab\.id === VelarStructureOverviewTab\.id[\s\S]*\? \{\}[\s\S]*onClose/
    )
    assert.doesNotMatch(presentation, /defaultVelarStructureRoot/)
    assert.match(presentation, /velarStructureTabs\.map/)
    assert.match(presentation, /openVelarStructureScope/)
    assert.match(presentation, /scopePaths=\{structureTab\.scopePaths\}/)
    assert.match(presentation, /group: 'structure'/)
    assert.match(presentation, /id: `velar-source:\$\{velarSourcePreview\.path\}`/)
    assert.match(presentation, /<ReadOnlyWorkbenchCode/)
    assert.match(
      presentation,
      /leftMode=\{\s*surface\.activeLeftTool === 'commit'[\s\S]*'velar-structure'[\s\S]*'files'[\s\S]*\}/
    )
    assert.match(
      model,
      /const codeGraphAvailable = codeGraphResourceAvailable && !velarLogicGraphAvailable/
    )
    assert.match(model, /const \[velarLogicGraphOpen, setVelarLogicGraphOpen\] = useState\(false\)/)
    assert.match(
      model,
      /const \[velarLogicGraphActive, setVelarLogicGraphActive\] = useState\(false\)/
    )
    assert.doesNotMatch(velarGraph, /getWorkbenchCodeGraph|codeGraphAvailable/)
    assert.doesNotMatch(velarGraph, /<Dialog|DialogContent|DialogHeader/)
    assert.match(velarGraph, /function WorkbenchLogicGraphEditor/)
    assert.match(velarGraph, /WorkbenchVelarStructureView = 'overview' \| 'selection'/)
    assert.doesNotMatch(presentation, /logicGraphLayerBusiness|logicGraphLayerModules/)
    assert.match(velarGraph, /selectScopeNeighborhood/)
    assert.match(velarGraph, /selectModuleScope/)
    assert.match(velarGraph, /const useModuleProjection = !useSymbolProjection/)
    assert.match(velarGraph, /scopePaths\.length > 0/)
    assert.match(velarGraph, /projectOverviewSelection/)
    assert.match(velarGraph, /deduplicateEdges/)
    assert.match(velarGraph, /analyzeLogicGraphTopology/)
    assert.match(velarGraph, /positionDependencyTree/)
    assert.match(velarGraph, /setLayoutDirection] = useState<LogicGraphDirection>\('vertical'\)/)
    assert.match(velarGraph, /LogicGraphRelationFilter/)
    assert.match(velarGraph, /size="xs"/)
    assert.match(velarGraph, /<ReadOnlyWorkbenchCode[\s\S]*showLineNumbers=\{false\}[\s\S]*compact/)
    assert.match(velarGraph, /onPointerDown=\{handleGraphPointerDown\}/)
    assert.match(velarGraph, /onPointerDown=\{\(event\) => handleNodePointerDown\(event, node\)\}/)
    assert.match(velarGraph, /markerEnd="url\(#logic-graph-arrow\)"/)
    assert.match(velarGraph, /data-cycle=\{topology\.cycleEdgeKeys/)
    assert.match(velarGraph, /data-cycle=\{topology\.cycleNodeIds/)
    assert.match(velarGraph, /logicGraphCircularDependencyCount/)
    assert.doesNotMatch(velarGraph, /logicGraphEditorHeader/)
    assert.doesNotMatch(scopeTree, /logicGraphScopeProject/)
    assert.match(scopeTree, /\(\?:test\|tests\|__tests__\)/)
    assert.match(scopeTree, /\(\?:\\\.test\|\\\.spec\|_test\|-test\)\\\.vel/)
    assert.doesNotMatch(
      scopeTree.match(/const StructuralKinds = new Set\(\[[\s\S]*?\]\)/)?.[0] ?? '',
      /'member'|'variable'/
    )
    assert.match(
      readSource('src/renderer/src/components/codeGraph/WorkbenchLogicGraphSidebar.tsx'),
      /<WorkbenchLogicGraphScopeTree/
    )
    assert.match(codeGraph, /getWorkbenchCodeGraph/)
    assert.doesNotMatch(codeGraph, /VelarOwnershipGraphRequestId/)
    assert.match(
      readSource('src/renderer/src/components/editor/CodeInsightPanel.tsx'),
      /diagnosticsByPath:\s*languageServiceInsights\?\.diagnosticsByPath/
    )
  })

  void test('keeps the pre-split commit tool above and Git history tool below', () => {
    const presentation = readSource('src/renderer/src/StandaloneWorkbenchPagePresentation.tsx')
    const kernel = readSource('src/renderer/src/components/embedded/WorkbenchEmbeddedKernel.tsx')
    const commitPanel = readSource('src/renderer/src/components/git/WorkbenchCommitPanel.tsx')
    const gitPanel = readSource('src/renderer/src/components/git/WorkbenchGitToolPanel.tsx')

    assert.match(presentation, /<GitCommitIcon size=\{18\} \/>/)
    assert.match(presentation, /onClick=\{\(\) => toggleLeftTool\('commit'\)\}/)
    assert.match(presentation, /<GitBranchIcon size=\{18\}/)
    assert.match(presentation, /surface\.activeLeftTool === 'commit'[\s\S]*\? 'changes'/)
    assert.match(kernel, /<WorkbenchCommitPanel/)
    assert.match(commitPanel, /commitWorkspaceGitChanges/)
    assert.doesNotMatch(commitPanel, /commitPanelCountBadge/)
    assert.match(gitPanel, /查看分支与提交历史，不承担提交操作/)
    assert.doesNotMatch(gitPanel, /commitWorkspaceGitChanges/)
  })

  void test('keeps the Git tool header free of a duplicate log tab', () => {
    const commandPanel = readSource('src/renderer/src/components/terminal/CommandPanel.tsx')

    assert.doesNotMatch(commandPanel, /GitBranchIcon/)
    assert.doesNotMatch(commandPanel, /bottomToolSessionTabs/)
    assert.doesNotMatch(commandPanel, /workbench\.gitLog/)
  })

  void test('restores the Workbench chat landing and composer controls', () => {
    const app = readSource('src/renderer/src/StandaloneWorkbenchApp.tsx')
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')
    const renderSlots = readSource(
      'src/renderer/src/runtime/conversation/standaloneWorkbenchConversationRenderSlots.tsx',
    )
    const styles = readSource('src/renderer/src/styles/04-insight-chat.module.css')

    assert.match(app, /ConversationBlockHooksProvider/)
    // 回答里的路径与产物行经消息动作层落到编辑器（Desktop 同一个 blocks hook 职责）。
    assert.match(app, /value=\{standaloneWorkbenchConversationBlockHooks\}/)
    // 目标卡的读写走主进程（Desktop 同一个动作端口职责）。
    assert.match(app, /value=\{standaloneWorkbenchConversationActionPort\}/)
    assert.match(app, /ConversationRenderSlotsProvider/)
    assert.match(app, /slots=\{standaloneWorkbenchConversationRenderSlots\}/)
    assert.match(renderSlots, /createConversationRenderSlots/)
    assert.match(renderSlots, /runningRuntimeMark:/)
    assert.doesNotMatch(renderSlots, /capabilityAutoApprovalNotice:/)
    assert.match(adapter, /data-workbench-chat-empty="true"/)
    assert.match(adapter, /workbenchAppIconUrl/)
    assert.match(adapter, /<img/)
    assert.match(adapter, /src=\{workbenchAppIconUrl\}/)
    assert.doesNotMatch(adapter, /VelarSailMark/)
    assert.doesNotMatch(adapter, /ChatCircleDotsIcon/)
    assert.doesNotMatch(adapter, /chatEmptyTitle/)
    assert.doesNotMatch(adapter, /wb_chatComposerError/)
    assert.match(adapter, /starterSuggestions\.map/)
    assert.match(adapter, /onFilesChange:\s*setFiles/)
    assert.match(adapter, /workbenchCurrentFilePath:\s*includedCurrentFilePath/)
    assert.match(adapter, /onDismissWorkbenchCurrentFile:/)
    assert.match(adapter, /setIncludedCurrentFilePath\(null\)/)
    assert.match(adapter, /onGoalModeChange:\s*setGoalMode/)
    assert.match(adapter, /onPlanModeChange:\s*setPlanMode/)
    assert.match(adapter, /reasoning-delta/)
    assert.match(adapter, /tool-start/)
    assert.match(adapter, /tool-progress/)
    assert.match(adapter, /tool-done/)
    assert.match(adapter, /canStop:\s*true/)
    assert.match(adapter, /abortAgentExecution/)
    assert.doesNotMatch(adapter, /workbenchEditorControlAvailable/)
    assert.match(
      styles,
      /\.workbenchChatTopBar \.workbenchChatSessionMenuButton[\s\S]*justify-content:\s*flex-start/
    )
    assert.doesNotMatch(styles, /workbenchChatCurrentFileChip/)
  })

  void test('keeps update download progress inside the status bar as a compact control', () => {
    const statusBar = readSource('src/renderer/src/components/chrome/StatusBar.tsx')
    const messageHost = readSource('src/renderer/src/runtime/workbenchMessageHost.tsx')
    const progress = readSource(
      'src/renderer/src/components/updates/WorkbenchUpdateProgress.tsx'
    )
    const progressStyles = readSource(
      'src/renderer/src/components/updates/WorkbenchUpdateProgress.module.css'
    )

    assert.match(statusBar, /<WorkbenchUpdateProgress \/>/)
    assert.doesNotMatch(messageHost, /WorkbenchUpdateProgress/)
    // 定宽小条，不再是随视口伸缩的横幅：260px/34vw 在宽屏上占掉状态栏一大截，
    // 而更新进度与旁边的「已打开 N」同量级。
    assert.match(progressStyles, /\.host\s*\{[\s\S]*?width:\s*150px/)
    assert.match(progressStyles, /\.progressButton\s*\{[\s\S]*?height:\s*15px/)
    // 配色归主题：原来写死近黑底 + 近白字，浅色主题下是一块与周围无关的黑。
    assert.doesNotMatch(progressStyles, /background:\s*rgb\(14 15 18/)
    assert.match(progressStyles, /background:\s*var\(--workbench-control-bg\)/)
    assert.match(progressStyles, /\.progressButton\s*\{[\s\S]*?border-radius:\s*999px/)
    assert.doesNotMatch(progressStyles, /position:\s*fixed/)
    assert.match(progress, /velarosWorkbenchUpdate\.pause\(\)/)
    assert.match(progress, /velarosWorkbenchUpdate\.resume\(\)/)
    assert.match(progress, /onClick=\{toggle\}/)
    assert.match(progress, /updateLabel\(state\.phase, percent, targetVersion, t\)/)
  })

  void test('separates workspace snapshots, fixed overview, tab scopes, and folder state', () => {
    const presentation = readSource('src/renderer/src/StandaloneWorkbenchPagePresentation.tsx')
    const tree = readSource(
      'src/renderer/src/components/codeGraph/WorkbenchLogicGraphScopeTree.tsx'
    )
    const tabs = readSource('src/renderer/src/components/editor/EditorTabBar.tsx')

    assert.match(presentation, /velarStructureProjectSnapshots/)
    assert.match(presentation, /mergeWorkbenchVelarProjectSnapshotIndex/)
    assert.match(presentation, /updateWorkbenchVelarProjectSnapshotIndex/)
    assert.match(presentation, /velarStructureExpansionOverrides/)
    assert.match(tree, /expansionOverrides: ReadonlyMap<string, boolean>/)
    assert.match(
      tree,
      /expansionOverrides\.get\(node\.key\) \?\? node\.kind === 'directory'/
    )
    assert.match(tree, /data-active=\{selectedPaths\.has\(node\.selection\)\}/)
    assert.match(tree, /next\.set\(path, !expanded\)/)
    assert.match(tree, /onExpansionOverridesChange\(next\)/)
    assert.doesNotMatch(tree, /useEffect|useState|initializedExpansionRef/)
    assert.match(tabs, /onClose\?: \(\) => void/)
    assert.match(tabs, /\{tab\.onClose && \(/)
  })

  void test('keeps external Agent engines opt-in and exposes shared resource plugins', () => {
    const settings = readSource('src/renderer/src/components/settings/WorkbenchSettingsDialog.tsx')
    const preload = readSource('src/preload/index.ts')
    const main = readSource('src/main/index.ts')
    const readme = readSource('README.md')

    assert.match(settings, /id: 'extensions'/)
    assert.match(settings, /velarosWorkbenchResourcePlugins/)
    assert.match(settings, /settingsPluginSharedHint/)
    assert.match(settings, /renderPluginsSection\(\)/)
    assert.match(settings, /renderModsSection\(\)/)
    assert.match(preload, /WorkbenchResourcePluginChannels\.listAgentEngineModels/)
    assert.match(main, /WorkbenchResourcePluginIpc/)
    assert.match(readme, /Claude Agent and ChatGPT\/Codex are external engine plugins/)
    assert.match(readme, /Desktop\s+and Workbench discover the same physical installation/)
  })

  void test('groups related settings into five product-level sections', () => {
    const settings = readSource('src/renderer/src/components/settings/WorkbenchSettingsDialog.tsx')
    const sectionIds = [...settings.matchAll(/id: '(general|editor|ai|extensions|system)' as const/g)]
      .map((match) => match[1])

    assert.deepEqual(sectionIds, ['general', 'editor', 'ai', 'extensions', 'system'])
    assert.match(settings, /renderGeneralSection\(\)/)
    assert.match(settings, /renderEditorGroup\(\)/)
    assert.match(settings, /renderAiSection\(\)/)
    assert.match(settings, /renderExtensionsSection\(\)/)
    assert.match(settings, /renderSystemSection\(\)/)
  })

  void test('keeps the release channel selector inside the product update settings', () => {
    const settings = readSource('src/renderer/src/components/settings/WorkbenchSettingsDialog.tsx')
    const languageSection = settings.slice(
      settings.indexOf('function renderLanguageSection'),
      settings.indexOf('function pluginStatusLabel')
    )
    const updatesSection = settings.slice(
      settings.indexOf('function renderUpdatesSection'),
      settings.indexOf('function renderGeneralSection')
    )

    assert.doesNotMatch(languageSection, /settingsUpdateChannel/)
    assert.match(updatesSection, /settingsUpdateChannel/)
    assert.match(updatesSection, /value: 'stable'/)
    assert.match(updatesSection, /value: 'beta'/)
    assert.match(updatesSection, /value: 'canary'/)
  })

  void test('keeps compact settings actions on their subsection headers', () => {
    const settings = readSource('src/renderer/src/components/settings/WorkbenchSettingsDialog.tsx')
    const projectSection = settings.slice(
      settings.indexOf('function renderProjectSection'),
      settings.indexOf('async function changeAccount')
    )
    const accountSection = settings.slice(
      settings.indexOf('function renderAccountSection'),
      settings.indexOf('function renderEditorSection')
    )
    const appearanceSection = settings.slice(
      settings.indexOf('function renderAppearanceSection'),
      settings.indexOf('function renderProjectSection')
    )
    const keymapSection = settings.slice(
      settings.indexOf('function renderKeymapSection'),
      settings.indexOf('function renderLanguageSection')
    )
    const generalSection = settings.slice(
      settings.indexOf('function renderGeneralSection'),
      settings.indexOf('function renderEditorGroup')
    )
    const editorSection = settings.slice(
      settings.indexOf('function renderEditorGroup'),
      settings.indexOf('function renderAiSection')
    )

    assert.equal(projectSection.match(/<SettingRow/g)?.length, 1)
    assert.equal(accountSection.match(/<SettingRow/g)?.length, 1)
    assert.doesNotMatch(accountSection, /settingsAccountSignedIn/)
    assert.doesNotMatch(appearanceSection, /settingsResetAppearance/)
    assert.doesNotMatch(keymapSection, /settingsResetKeymap/)
    assert.match(generalSection, /action=\{\([\s\S]*settingsResetAppearance/)
    assert.match(editorSection, /action=\{\([\s\S]*settingsResetKeymap/)
  })

  void test('localizes language options and confirms rollback in the product dialog', () => {
    const zh = readSource('src/renderer/src/i18n/messages/zh-CN.ts')
    const en = readSource('src/renderer/src/i18n/messages/en-US.ts')
    const commitPanel = readSource('src/renderer/src/components/git/WorkbenchCommitPanel.tsx')
    const rollbackImplementation = commitPanel.slice(
      commitPanel.indexOf('async function rollbackItems'),
      commitPanel.indexOf('async function generateCommitMessage')
    )

    assert.match(zh, /chinese:\s*'简体中文'/)
    assert.match(zh, /english:\s*'English'/)
    assert.match(en, /chinese:\s*'Simplified Chinese'/)
    assert.match(commitPanel, /<Dialog[\s\S]*open=\{!!rollbackRequest\}/)
    assert.match(commitPanel, /gitRollbackConfirmAction/)
    assert.doesNotMatch(rollbackImplementation, /window\.confirm/)
    assert.doesNotMatch(commitPanel, /GearSixIcon/)
  })

  void test('keeps the commit input inside its panel and expands untracked directories', () => {
    const styles = readSource('src/renderer/src/styles/05-git.module.css')
    const gitService = readSource('src/main/workspace/git/WorkbenchGitService.ts')

    assert.match(styles, /\.gitCommitInput[\s\S]*max-width:\s*calc\(100% - 20px\)/)
    assert.match(gitService, /--untracked-files=all/)
  })

  void test('releases the shared Select pointer lock as soon as a settings menu closes', () => {
    const globalStyles = readSource('src/renderer/src/index.css')

    assert.match(
      globalStyles,
      /\.velar-select-content\[data-state='closed'\][\s\S]*animation:\s*none/
    )
  })

  void test('uses a slim low-contrast scrollbar across the Workbench', () => {
    const globalStyles = readSource('src/renderer/src/index.css')
    const shellStyles = readSource('src/renderer/src/styles/01-shell.module.css')

    assert.match(globalStyles, /\*::-webkit-scrollbar\s*\{[\s\S]*width:\s*6px/)
    assert.match(globalStyles, /\*::-webkit-scrollbar\s*\{[\s\S]*height:\s*6px/)
    assert.match(globalStyles, /scrollbar-color:[\s\S]*transparent/)
    assert.match(shellStyles, /--scrollbar-thumb:[^;]*16%/)
    assert.match(shellStyles, /--scrollbar-thumb-hover:[^;]*28%/)
  })

  void test('keeps the welcome page product-focused without exposing Kernel plumbing', () => {
    const welcome = readSource('src/renderer/src/welcome/WorkbenchWelcomePage.tsx')
    const styles = readSource('src/renderer/src/welcome/welcome.css')

    assert.match(welcome, /构建你的下一个项目。/)
    assert.doesNotMatch(welcome, /打开一个项目，开始开发。/)
    assert.doesNotMatch(welcome, /Kernel：内置宿主/)
    assert.doesNotMatch(styles, /workbench-welcome__kernel-status/)
    assert.match(styles, /\.workbench-welcome__hero[\s\S]*min-height:\s*211px/)
  })

  void test('projects every active editor file into the tree without alternating sync state', () => {
    const controller = readSource('src/renderer/src/hooks/useWorkbenchController.ts')
    const editor = readSource('src/renderer/src/hooks/useWorkbenchEditorController.ts')
    const tree = readSource('src/renderer/src/components/files/FileTree.tsx')
    const treeActions = readSource('src/renderer/src/hooks/useFileTreeActions.ts')

    assert.match(controller, /editor\.selectedFilePath[\s\S]*tree\.revealEntryPath/)
    assert.doesNotMatch(editor, /onSelectEntryPath/)
    assert.doesNotMatch(tree, /selectionOriginRef/)
    assert.doesNotMatch(treeActions, /selectionOriginRef/)
    assert.match(tree, /\[selectedPath, treeData, treeSize\.measured\]/)
    assert.match(tree, /selectionAlreadyMatches/)
  })

  void test('mounts the virtual tree only after the shell has a measured size', () => {
    const tree = readSource('src/renderer/src/components/files/FileTree.tsx')
    const treeActions = readSource('src/renderer/src/hooks/useFileTreeActions.ts')

    // 1px 占位视口里「滚到选中项」会让 react-window 记住越界偏移，切回文件面板时顶部空白。
    assert.match(tree, /\{treeSize\.measured && \(\s*<Tree<FileTreeNodeData>/)
    assert.match(treeActions, /height: 1,\s*measured: false/)
  })
})
