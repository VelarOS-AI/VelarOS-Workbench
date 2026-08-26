import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

function readSource(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

void describe('pre-split Workbench shell parity', () => {
  void test('uses the shared conversation surface instead of the temporary form', () => {
    const adapter = readSource(
      'src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx'
    )

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

    assert.doesNotMatch(panel, /<div className=\{styles\.panelHeader\}>/)
    assert.match(panel, /className=\{styles\.filePanelProjectHeader\}/)
    assert.match(panel, /className=\{styles\.filePanelViewTitle\}/)
    assert.match(panel, /workbench\.projectView/)
    assert.match(panel, /entries=\{rootEntries\}/)
    assert.match(panel, /childrenByPath=\{childrenByPath\}/)
    assert.doesNotMatch(panel, /treeRootEntries/)
    assert.doesNotMatch(row, /treeRootActionButton/)
    assert.match(styles, /\.filePanelProjectHeader[\s\S]*height:\s*35px/)
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
    const control = readSource(
      'src/renderer/src/components/git/WorkbenchGitCommitControl.tsx'
    )
    const sharedControl = readSource(
      'node_modules/@velaros-ai/ui/src/product/git/WorkspaceGitCommitControl.tsx'
    )
    const sharedGitStyles = readSource(
      'node_modules/@velaros-ai/ui/src/product/git/WorkspaceGitCommitControl.module.css'
    )
    const shortcuts = readSource(
      'src/renderer/src/models/layout/workbenchKeyboardShortcuts.ts'
    )

    assert.match(presentation, /<WorkbenchProjectControl/)
    assert.match(presentation, /<WorkbenchTopLeading \{\.\.\.editorChrome\} \/>/)
    assert.match(
      presentation,
      /<WorkbenchTopTrailing \{\.\.\.editorChrome\} placement="top" controls="primary" \/>/
    )
    assert.match(
      presentation,
      /placement="rail"[\s\S]*controls="code-graph"/
    )
    assert.match(toolbar, /<WorkbenchGitCommitControl/)
    assert.match(toolbar, /showPrimaryControls = controls !== 'code-graph'/)
    assert.match(toolbar, /showCodeGraph = controls !== 'primary' && codeGraphAvailable/)
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
    assert.match(sharedGitStyles, /\.gitCompactMenuHeader[\s\S]*padding:\s*3\.5px 4px/)
    assert.match(sharedGitStyles, /\.gitCompactInput:focus-visible[\s\S]*background-color:\s*transparent/)
    assert.match(sharedGitStyles, /\.gitCreateBranchInput:focus-visible[\s\S]*git-create-branch-input-bg/)
    assert.doesNotMatch(sharedGitStyles, /\.gitCompactMenu :global\(\.velar-input/)
    assert.match(sharedControl, /<FolderIcon[\s\S]*gitCompactBranchTreeFolder/)
    assert.match(sharedControl, /buildBranchTrie\(branches, namespace\)/)
    assert.match(sharedGitStyles, /\.gitCreateBranchDialog[\s\S]*max-width:\s*min\(320px/)
    assert.match(sharedControl, /<Dialog[\s\S]*createDialogTitle/)
    assert.match(sharedControl, /<DialogFooter className=\{styles\.gitCreateBranchDialogFooter\}>/)
    assert.match(sharedControl, /checked=\{checkoutCreatedBranch\}/)
    assert.match(sharedControl, /gitCompactSearchField[\s\S]*gitCompactFetchButton/)
    assert.match(sharedControl, /gitCompactBranchList[\s\S]*gitCompactFooter[\s\S]*openCreateBranchDialog/)
    assert.match(sharedControl, /gitCompactBranchHoverActions[\s\S]*checkoutAction[\s\S]*uploadAction/)
    assert.match(control, /themeColor="var\(--workbench-theme-color\)"/)
    assert.match(control, /switchWorkspaceGitBranch\([\s\S]*\{ create: true \}/)
    assert.match(shortcuts, /toggle-changes', defaultShortcut: 'Mod\+Shift\+G'/)
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

  void test('keeps the pre-split commit tool above and Git history tool below', () => {
    const presentation = readSource('src/renderer/src/StandaloneWorkbenchPagePresentation.tsx')
    const kernel = readSource('src/renderer/src/components/embedded/WorkbenchEmbeddedKernel.tsx')
    const commitPanel = readSource('src/renderer/src/components/git/WorkbenchCommitPanel.tsx')
    const gitPanel = readSource('src/renderer/src/components/git/WorkbenchGitToolPanel.tsx')

    assert.match(presentation, /<GitCommitIcon size=\{18\} \/>/)
    assert.match(presentation, /onClick=\{\(\) => toggleLeftTool\('commit'\)\}/)
    assert.match(presentation, /<GitBranchIcon size=\{18\}/)
    assert.match(presentation, /leftMode=\{surface\.activeLeftTool === 'commit' \? 'changes' : 'files'\}/)
    assert.match(kernel, /<WorkbenchCommitPanel/)
    assert.match(commitPanel, /commitWorkspaceGitChanges/)
    assert.doesNotMatch(commitPanel, /commitPanelCountBadge/)
    assert.match(gitPanel, /查看分支与提交历史，不承担提交操作/)
    assert.doesNotMatch(gitPanel, /commitWorkspaceGitChanges/)
  })

  void test('keeps the Git tool header free of a duplicate log tab', () => {
    const commandPanel = readSource(
      'src/renderer/src/components/terminal/CommandPanel.tsx'
    )

    assert.doesNotMatch(commandPanel, /GitBranchIcon/)
    assert.doesNotMatch(commandPanel, /bottomToolSessionTabs/)
    assert.doesNotMatch(commandPanel, /workbench\.gitLog/)
  })

  void test('restores the Workbench chat landing and composer controls', () => {
    const adapter = readSource(
      'src/renderer/src/runtime/standaloneWorkbenchChatAdapter.tsx'
    )
    const styles = readSource('src/renderer/src/styles/04-insight-chat.module.css')

    assert.match(adapter, /data-workbench-chat-empty="true"/)
    assert.match(adapter, /<VelarSailMark/)
    assert.match(adapter, /motion="steady"/)
    assert.match(adapter, /showWindLines=\{false\}/)
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
    assert.match(styles, /\.workbenchChatTopBar \.workbenchChatSessionMenuButton[\s\S]*justify-content:\s*flex-start/)
    assert.doesNotMatch(styles, /workbenchChatCurrentFileChip/)
  })

  void test('keeps external Agent engines opt-in and exposes shared resource plugins', () => {
    const settings = readSource(
      'src/renderer/src/components/settings/WorkbenchSettingsDialog.tsx'
    )
    const preload = readSource('src/preload/index.ts')
    const main = readSource('src/main/index.ts')
    const readme = readSource('README.md')

    assert.match(settings, /id: 'plugins'/)
    assert.match(settings, /velarosWorkbenchResourcePlugins/)
    assert.match(settings, /settingsPluginSharedHint/)
    assert.match(settings, /id: 'mods'/)
    assert.match(preload, /velarosWorkbenchAgentMods/)
    assert.match(main, /WorkbenchModIpc/)
    assert.match(readme, /product-owned built-ins/)
    assert.match(readme, /Desktop\s+and Workbench discover the same physical installation/)
  })

  void test('localizes language options and confirms rollback in the product dialog', () => {
    const zh = readSource('src/renderer/src/i18n/messages/zh-CN.ts')
    const en = readSource('src/renderer/src/i18n/messages/en-US.ts')
    const commitPanel = readSource(
      'src/renderer/src/components/git/WorkbenchCommitPanel.tsx'
    )
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
    assert.match(tree, /\[selectedPath, treeData\]/)
    assert.match(tree, /selectionAlreadyMatches/)
  })
})
