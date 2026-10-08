import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, test } from 'bun:test'
import ts from 'typescript'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

void describe('pre-split Workbench shell parity', () => {
  void test('uses the shared conversation surface instead of the temporary form', () => {
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')

    assert.match(adapter, /@velaros-ai\/ui\/conversation/)
    assert.match(adapter, /<ChatConversationPane/)
    assert.match(adapter, /<ChatSurfaceComposer\b[^>]*\bcontrol=\{composerControl\}/)
    assert.doesNotMatch(adapter, /wb_standaloneChatSurface/)
    assert.doesNotMatch(adapter, /Ask the injected VelarOS Agent/)
  })

  void test('lets the IDE surface fill the window without a duplicate project header', () => {
    const shell = readSource('src/renderer/src/app/WorkbenchWorkspaceShell.tsx')
    const styles = readSource('src/renderer/src/styles/workspaceShell.css')

    assert.doesNotMatch(shell, /workbench-workspace-shell__top-bar/)
    assert.doesNotMatch(shell, />关闭项目</)
    assert.match(styles, /\.workbench-workspace-shell__stage\s*>\s*\*/)
    assert.match(styles, /width:\s*100%/)
  })

  void test('keeps the project view header compact and leaves search in place', () => {
    const panel = readSource('src/renderer/src/components/files/FilePanel.tsx')
    const searchForm = readSource('src/renderer/src/components/files/ProjectSearchForm.tsx')
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
    // 搜索表单就在项目面板里、标题栏下面，不挪进标题栏；表单随搜索面板按需加载。
    const searchView = readSource('src/renderer/src/components/files/ProjectSearchView.tsx')
    assert.match(panel, /<\/div>\n\s*\{projectSearch\.isOpen \? \([\s\S]*<LazyProjectSearchView/)
    assert.match(searchView, /<>\n\s*<ProjectSearchForm/)
    // 查找框是表单自己的一框（开关收在框里），里面一格不画边框的搜索输入；没有另做的清除按钮。
    assert.match(
      searchForm,
      /className=\{styles\.projectSearchField\}[\s\S]*?<Input[\s\S]*?variant="ghost"[\s\S]*?type="search"/
    )
    assert.doesNotMatch(searchForm, /searchInputClearButton|<SearchField/)
  })

  void test('places the project and one Git control together in the title row', () => {
    const presentation = readSource('src/renderer/src/app/StandaloneWorkbenchPagePresentation.tsx')
    const toolbar = readSource('src/renderer/src/components/chrome/TopToolbar.tsx')
    const adapter = readSource(
      'src/renderer/src/components/embedded/workbenchEmbeddedKernelAdapter.ts'
    )
    const control = readSource('src/renderer/src/components/git/WorkbenchGitBranchControl.tsx')
    const menu = readSource('src/renderer/src/components/git/WorkbenchGitBranchMenu.tsx')
    const topStyles = readSource('src/renderer/src/styles/02-chrome-top.module.css')
    const shortcuts = readSource('src/renderer/src/models/layout/workbenchKeyboardShortcuts.ts')

    assert.match(presentation, /<WorkbenchProjectControl/)
    assert.match(presentation, /<WorkbenchTopLeading \{\.\.\.editorChrome\} \/>/)
    assert.match(presentation, /<WorkbenchTopTrailing \{\.\.\.editorChrome\} \/>/)
    assert.doesNotMatch(presentation, /placement="rail"|rightToolActionGroup/)
    // 顶栏上只有一个 Git 控件：分支、拉取、推送、同步、获取远端都在它的面板里，旁边不再另放同步按钮。
    assert.equal(toolbar.match(/<WorkbenchGit\w+Control\b/g)?.length, 1)
    assert.match(toolbar, /<WorkbenchGitBranchControl/)
    const runButton = toolbar.indexOf('<WorkbenchRunAction')
    const settingsButton = toolbar.indexOf('tooltip={settingsLabel}')
    assert.ok(runButton >= 0)
    assert.ok(runButton < settingsButton)
    assert.match(adapter, /gitWorkspaceRoot:\s*workbench\.activeProject\?\.rootPath/)
    assert.match(adapter, /onOpenGitCommitTool:[\s\S]*setActiveLeftTool\('commit'\)/)
    assert.match(adapter, /onOpenGitBottomTool:[\s\S]*openBottomTool\('git'\)/)
    assert.match(control, /switchWorkspaceGitBranch/)
    assert.match(control, /createWorkspaceGitBranch/)
    assert.match(control, /switchWorkspaceGitBranch\([\s\S]*\{ create: true \}/)
    // 远端操作走统一入口（别处发起的这里也看得到、能取消）；列表里点的分支连名字一起交过去。
    assert.match(control, /useWorkbenchGitRemoteAction\(workspaceRoot\)/)
    assert.match(
      control,
      /remoteAction\.run\(action, \{ branch, privateKeyPath: gitSshKeyPath \}\)/
    )
    assert.match(
      control,
      /onPushBranch=\{\(branch\) => void runRemoteAction\('upload', branch\.name\)\}/
    )
    // 外框与面板用共享的顶栏控件，和旁边的项目菜单同一套尺寸；按钮上写分支和落后、领先的提交数。
    assert.match(control, /<TopBarControlFrame[\s\S]*<AnchoredPopover/)
    assert.match(control, /getTopBarControlPanelClassName\(styles\.gitBranchMenuPanel\)/)
    assert.match(control, /data-topbar-panel="picker"/)
    assert.match(
      control,
      /gitBranchControlName[\s\S]*gitBranchControlCounts[\s\S]*↓\{behind\}[\s\S]*↑\{ahead\}/
    )
    assert.doesNotMatch(control, /<FolderIcon/)
    // 搜索右侧获取远端，下方是进度、分支列表和新建分支。
    assert.match(
      menu,
      /gitBranchMenuSearch[\s\S]*<SearchField[\s\S]*gitBranchMenuActions[\s\S]*gitBranchMenuRemote[\s\S]*gitBranchMenuList[\s\S]*gitBranchMenuFooter[\s\S]*onOpenCreateBranch/
    )
    assert.match(menu, /running \? \([\s\S]*gitBranchMenuRunning[\s\S]*onCancelRemoteAction/)
    assert.match(
      menu,
      /gitBranchMenuRowActions[\s\S]*onSwitchBranch\(branch\)[\s\S]*onPushBranch\(branch\)/
    )
    assert.match(menu, /FolderIcon[\s\S]*renderNode\(child, depth \+ 1\)/)
    assert.match(topStyles, /\.gitBranchMenuSearch[\s\S]*var\(--topbar-panel-row-height\)/)
    assert.match(
      topStyles,
      /\.gitBranchMenuList[\s\S]*max-height:\s*var\(--topbar-panel-list-max-height\)/
    )
    assert.match(topStyles, /\.gitBranchCreateDialog[\s\S]*max-width:\s*min\(340px/)
    assert.doesNotMatch(topStyles, /\.gitSync/)
    // Workbench 键位方案里的默认键。
    assert.match(shortcuts, /workbench: \{[\s\S]*?'toggle-changes': 'Mod\+Shift\+G',/)
  })

  void test('opens the branch menu with a Git-only refresh', () => {
    const model = readSource('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx')
    const toolbar = readSource('src/renderer/src/components/chrome/TopToolbar.tsx')

    assert.match(model, /actions:\s*\{[\s\S]*refreshGitPanel:\s*gitState\.refresh\b/)
    assert.doesNotMatch(
      model,
      /actions:\s*\{[\s\S]*refreshGitPanel:\s*refreshGitPanelWithWorkspace/
    )
    assert.match(toolbar, /if \(!gitControlReady\) return null/u)
    assert.doesNotMatch(toolbar, /topGitPlaceholder/u)
  })

  void test('extends macOS content into the title bar and lets the folder button toggle files', () => {
    const main = readSource('src/main/index.ts')
    const presentation = readSource('src/renderer/src/app/StandaloneWorkbenchPagePresentation.tsx')
    const surface = readSource('src/renderer/src/hooks/useWorkbenchSurfaceState.ts')

    assert.match(main, /titleBarStyle:\s*process\.platform === 'darwin' \? 'hiddenInset'/)
    assert.match(presentation, /onClick=\{\(\) => toggleLeftTool\('project'\)\}/)
    assert.match(presentation, /isFilePanelOpen:\s*surface\.isFilePanelOpen/)
    assert.match(surface, /const \[isFilePanelOpen, setIsFilePanelOpen\] = useState\(true\)/)
  })

  void test('gives the built-in Velar structure its own read-only tree view', () => {
    const presentation = readSource('src/renderer/src/app/StandaloneWorkbenchPagePresentation.tsx')
    const model = readSource('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx')
    const velarGraph = readSource(
      'src/renderer/src/components/codeGraph/WorkbenchLogicGraphDialog.tsx'
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
    // 结构图按需加载：打开结构标签时才拉它那一块，不进工作区外壳。
    assert.match(
      presentation,
      /auxiliaryTabs:[\s\S]*<Suspense fallback=\{null\}>\s*<LazyWorkbenchLogicGraphEditor/
    )
    assert.match(
      presentation,
      /const LazyWorkbenchLogicGraphEditor = lazy\(async \(\) => \{\n\s*const module = await import\('\.\.\/components\/codeGraph\/WorkbenchLogicGraphDialog'\)/
    )
    assert.match(presentation, /const VelarStructureOverviewTab[\s\S]*velar-structure:overview/)
    assert.match(presentation, /\[VelarStructureOverviewTab, \.\.\.velarStructureScopeTabs\]/)
    assert.match(
      presentation,
      /onClose: optionalWhen\(\s*structureTab\.id !== VelarStructureOverviewTab\.id/
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
      /const velarLogicGraphAvailable = workbench\.projectContextIndex\.files\.some\(/
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
    assert.match(
      readSource('src/renderer/src/components/editor/CodeInsightPanel.tsx'),
      /diagnosticsByPath:\s*languageServiceInsights\?\.diagnosticsByPath/
    )
  })

  void test('keeps the pre-split commit tool above and Git history tool below', () => {
    const presentation = readSource('src/renderer/src/app/StandaloneWorkbenchPagePresentation.tsx')
    const kernel = readSource('src/renderer/src/components/embedded/WorkbenchEmbeddedKernel.tsx')
    const commitPanel = readSource('src/renderer/src/components/git/WorkbenchCommitPanel.tsx')
    const gitPanel = readSource('src/renderer/src/components/git/WorkbenchGitToolPanel.tsx')

    assert.match(presentation, /<GitCommitIcon size=\{18\} \/>/)
    assert.match(presentation, /onClick=\{\(\) => toggleLeftTool\('commit'\)\}/)
    assert.match(presentation, /<GitBranchIcon size=\{18\}/)
    assert.match(presentation, /surface\.activeLeftTool === 'commit'[\s\S]*\? 'changes'/)
    assert.match(kernel, /<LazyWorkbenchCommitPanel/)
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
    const shell = readSource('src/renderer/src/app/WorkbenchWorkspaceShell.tsx')
    const adapter = readSource('src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx')
    const renderSlots = readSource(
      'src/renderer/src/runtime/conversation/standaloneWorkbenchConversationRenderSlots.tsx'
    )
    const styles = readSource('src/renderer/src/styles/04-insight-chat.module.css')

    // 聊天装配跟着工作台按需加载：共享会话 UI 的各层 Provider 与会话适配器都挂在工作台外壳上。
    assert.match(shell, /ConversationBlockHooksProvider/)
    // 回答里的路径与产物行经消息动作层落到编辑器（Desktop 同一个 blocks hook 职责）。
    assert.match(shell, /value=\{standaloneWorkbenchConversationBlockHooks\}/)
    // 目标卡的读写走主进程（Desktop 同一个动作端口职责）。
    assert.match(shell, /value=\{standaloneWorkbenchConversationActionPort\}/)
    assert.match(shell, /ConversationRenderSlotsProvider/)
    assert.match(shell, /slots=\{standaloneWorkbenchConversationRenderSlots\}/)
    assert.match(shell, /<WorkbenchChatProvider adapter=\{standaloneWorkbenchChatAdapter\}>/)
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
    assert.match(adapter, /onFilesChange:\s*optionalWhen\(!isAwaitingInput, setFiles\)/)
    assert.match(adapter, /workbenchCurrentFilePath:\s*includedCurrentFilePath/)
    assert.match(adapter, /onDismissWorkbenchCurrentFile:/)
    assert.match(adapter, /setIncludedCurrentFilePath\(null\)/)
    assert.match(adapter, /onGoalModeChange:\s*setGoalMode/)
    assert.match(adapter, /onPlanModeChange:\s*setPlanMode/)
    // 运行中的展示由主进程逐条推来的会话通知落到发起那一轮的会话上；停止走会话通道的取消。
    assert.match(
      adapter,
      /window\.velarosWorkbenchConversation\.onEvent\(\s*applyConversationEnvelope\s*\)/
    )
    assert.match(adapter, /applyWorkbenchConversationNotice\(/)
    assert.match(adapter, /canStop:\s*isRunActive/)
    assert.match(adapter, /velarosWorkbenchConversation\.cancel\(/)
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
    const progress = readSource('src/renderer/src/components/WorkbenchUpdateProgress.tsx')
    const progressStyles = readSource(
      'src/renderer/src/styles/WorkbenchUpdateProgress.module.css'
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
    const presentation = readSource('src/renderer/src/app/StandaloneWorkbenchPagePresentation.tsx')
    const tree = readSource(
      'src/renderer/src/components/codeGraph/WorkbenchLogicGraphScopeTree.tsx'
    )
    const tabs = readSource('src/renderer/src/components/editor/EditorTabBar.tsx')

    assert.match(presentation, /velarStructureProjectSnapshots/)
    assert.match(presentation, /mergeWorkbenchVelarProjectSnapshotIndex/)
    assert.match(presentation, /updateWorkbenchVelarProjectSnapshotIndex/)
    assert.match(presentation, /velarStructureExpansionOverrides/)
    assert.match(tree, /expansionOverrides: ReadonlyMap<string, boolean>/)
    assert.match(tree, /expansionOverrides\.get\(node\.key\) \?\? node\.kind === 'directory'/)
    assert.match(tree, /data-active=\{selectedPaths\.has\(node\.selection\)\}/)
    assert.match(tree, /next\.set\(path, !expanded\)/)
    assert.match(tree, /onExpansionOverridesChange\(next\)/)
    assert.doesNotMatch(tree, /useEffect|useState|initializedExpansionRef/)
    assert.match(tabs, /onClose\?: \(\) => void/)
    assert.match(tabs, /\{tab\.onClose && \(/)
  })

  void test('groups related settings into four product-level sections', () => {
    const settings = readSource('src/renderer/src/components/settings/WorkbenchSettingsDialog.tsx')
    const sectionIds = [...settings.matchAll(/id: '([a-z]+)' as const/g)].map((match) => match[1])

    assert.deepEqual(sectionIds, ['general', 'editor', 'ai', 'system'])
    assert.match(settings, /renderGeneralSection\(\)/)
    assert.match(settings, /renderEditorGroup\(\)/)
    assert.match(settings, /renderAiSection\(\)/)
    assert.match(settings, /renderSystemSection\(\)/)
    // AI 一节收模型、权限确认与项目 AI 规则。
    const aiSection = settings.slice(
      settings.indexOf('function renderAiSection'),
      settings.indexOf('function renderSystemSection')
    )
    assert.match(
      aiSection,
      /renderModelSection\(\)[\s\S]*renderPermissionsSection\(\)[\s\S]*renderAiRulesSection\(\)/
    )
  })

  void test('keeps the release channel selector inside the product update settings', () => {
    const settings = readSource('src/renderer/src/components/settings/WorkbenchSettingsDialog.tsx')
    const languageSection = settings.slice(
      settings.indexOf('function renderLanguageSection'),
      settings.indexOf('function renderAdvancedSection')
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
    const hasHeaderAction = (source: string, label: string): boolean => {
      const file = ts.createSourceFile(
        'settings.tsx',
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      )
      const hasLabel = (node: ts.Node): true | undefined =>
        ts.isStringLiteral(node) && node.text === label ? true : ts.forEachChild(node, hasLabel)
      const visit = (node: ts.Node): true | undefined => {
        if (ts.isJsxAttribute(node) && node.name.getText(file) === 'action' && node.initializer) {
          const element = node.parent.parent
          if (
            (ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)) &&
            element.tagName.getText(file) === 'SettingsSubsection' &&
            hasLabel(node.initializer)
          )
            return true
        }
        return ts.forEachChild(node, visit)
      }
      return !!visit(file)
    }
    assert(hasHeaderAction(generalSection, 'workbench.settingsResetAppearance'))
    assert(hasHeaderAction(editorSection, 'workbench.settingsResetKeymap'))
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
    const globalStyles = readSource('src/renderer/src/styles/index.css')

    assert.match(
      globalStyles,
      /\.velar-select-content\[data-state='closed'\][\s\S]*animation:\s*none/
    )
  })

  void test('uses a slim low-contrast scrollbar across the Workbench', () => {
    const globalStyles = readSource('src/renderer/src/styles/index.css')
    const shellStyles = readSource('src/renderer/src/styles/01-shell.module.css')

    assert.match(globalStyles, /\*::-webkit-scrollbar\s*\{[\s\S]*width:\s*6px/)
    assert.match(globalStyles, /\*::-webkit-scrollbar\s*\{[\s\S]*height:\s*6px/)
    assert.match(globalStyles, /scrollbar-color:[\s\S]*transparent/)
    assert.match(shellStyles, /--scrollbar-thumb:[^;]*16%/)
    assert.match(shellStyles, /--scrollbar-thumb-hover:[^;]*28%/)
  })

  void test('keeps the welcome page product-focused without exposing Kernel plumbing', () => {
    const welcome = readSource('src/renderer/src/welcome/WorkbenchWelcomePage.tsx')
    const welcomeCopy = readSource('src/renderer/src/i18n/messages/zh-CN.ts')
    const styles = readSource('src/renderer/src/styles/welcome.css')

    // 文案在语言包里（中英两份），页面按键取。
    assert.match(welcome, /t\('welcome\.tagline'\)/)
    assert.match(welcomeCopy, /tagline: '构建你的下一个项目。'/)
    assert.doesNotMatch(welcome + welcomeCopy, /打开一个项目，开始开发。/)
    assert.doesNotMatch(welcome + welcomeCopy, /Kernel：内置宿主/)
    assert.doesNotMatch(styles, /workbench-welcome__kernel-status/)
    assert.match(styles, /\.workbench-welcome__hero[\s\S]*min-height:\s*211px/)
    // 左侧在竖直方向居中；最近项目有上限，超出的在列表里滚动。
    assert.match(styles, /\.workbench-welcome__panel \{[^}]*align-items: center;/)
    assert.match(
      styles,
      /\.workbench-welcome__recent-list \{[^}]*max-height: min\(440px, calc\(100vh - 220px\)\);[^}]*overflow-y: auto;/
    )
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
    assert.match(tree, /\[revealRevision, selectedPath, treeData, treeSize\.measured\]/)
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
