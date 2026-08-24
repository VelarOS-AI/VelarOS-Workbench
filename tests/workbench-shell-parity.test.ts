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

  void test('uses an aligned project chrome row without duplicating the project in the tree', () => {
    const panel = readSource('src/renderer/src/components/files/FilePanel.tsx')
    const row = readSource('src/renderer/src/components/files/FileTreeRow.tsx')
    const styles = readSource('src/renderer/src/styles/08-files.module.css')

    assert.doesNotMatch(panel, /<div className=\{styles\.panelHeader\}>/)
    assert.match(panel, /className=\{styles\.filePanelProjectHeader\}/)
    assert.match(panel, /<span>\{project\.name\}<\/span>/)
    assert.match(panel, /entries=\{rootEntries\}/)
    assert.match(panel, /childrenByPath=\{childrenByPath\}/)
    assert.doesNotMatch(panel, /treeRootEntries/)
    assert.doesNotMatch(row, /treeRootActionButton/)
    assert.match(styles, /\.filePanelProjectHeader[\s\S]*height:\s*35px/)
    assert.match(styles, /\.searchInputShell:focus-within[\s\S]*box-shadow:\s*none/)
    assert.match(styles, /\.searchInputShell:focus-within[\s\S]*border-color:\s*transparent/)
    assert.doesNotMatch(panel, /searchInputClearButton/)
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
    assert.doesNotMatch(adapter, /workbenchEditorControlAvailable/)
    assert.match(styles, /\.workbenchChatTopBar \.workbenchChatSessionMenuButton[\s\S]*justify-content:\s*flex-start/)
    assert.doesNotMatch(styles, /workbenchChatCurrentFileChip/)
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
})
