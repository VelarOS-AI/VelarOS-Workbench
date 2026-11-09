import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, test } from 'bun:test'

import { WorkbenchProjectHub } from '../src/main/projects/ProjectHub'
import { RecentProjectsStore } from '../src/main/projects/RecentProjectsStore'

void describe('Workbench project window ownership', () => {
  void test('routes OS and renderer folder opens through the multi-window owner', async () => {
    const [
      main,
      manager,
      menu,
      preload,
      app,
      presentation,
      settings,
      workspaceShell,
      control,
      styles,
      builder,
    ] = await Promise.all([
      readFile('src/main/index.ts', 'utf8'),
      readFile('src/main/projects/WorkbenchWindowManager.ts', 'utf8'),
      readFile('src/main/projects/ProjectHubMenu.ts', 'utf8'),
      readFile('src/preload/index.ts', 'utf8'),
      readFile('src/renderer/src/app/StandaloneWorkbenchApp.tsx', 'utf8'),
      readFile('src/renderer/src/app/StandaloneWorkbenchPagePresentation.tsx', 'utf8'),
      readFile('src/renderer/src/components/settings/WorkbenchSettingsDialog.tsx', 'utf8'),
      readFile('src/renderer/src/app/WorkbenchWorkspaceShell.tsx', 'utf8'),
      readFile('src/renderer/src/components/chrome/WorkbenchProjectControl.tsx', 'utf8'),
      readFile('src/renderer/src/styles/02-chrome-top.module.css', 'utf8'),
      readFile('electron-builder.yml', 'utf8'),
    ])

    assert.match(main, /requestSingleInstanceLock\(instanceLaunchData\)/u)
    assert.match(main, /app\.on\('open-file'/u)
    assert.match(main, /app\.on\('second-instance'/u)
    assert.match(main, /collectExternalPathArguments/u)
    assert.match(main, /app\.relaunch\(\{ execPath: requestedExecutablePath, args: paths \}\)/u)
    assert.match(manager, /getOpenProjectPaths\(\)/u)
    assert.match(manager, /findProjectRecord\(projectPath\)/u)
    assert.match(manager, /this\.focusWindow\(existing\.window\)/u)
    assert.match(manager, /this\.createWindow\(projectPath\)/u)
    assert.match(manager, /switchProjectPath[\s\S]*releaseProjectResources/u)
    assert.match(manager, /openProjectPathInNewWindow[\s\S]*openProjectPath\(null, path\)/u)
    assert.match(
      manager,
      /cloneProjectInNewWindow[\s\S]*'git',[\s\S]*'clone'[\s\S]*openProjectPathInNewWindow/u
    )
    assert.match(menu, /app\.dock\?\.setMenu\(buildDockMenu\(windows\)\)/u)
    assert.match(menu, /buildRecentProjectItems\(windows, recentProjects, 'new-window'\)/u)
    assert.match(preload, /webUtils\.getPathForFile\(file\)/u)
    assert.match(preload, /WorkbenchProjectHubChannels\.switchProjectPath/u)
    assert.match(preload, /WorkbenchProjectHubChannels\.openProjectPathInNewWindow/u)
    assert.match(preload, /WorkbenchProjectHubChannels\.cloneProjectInNewWindow/u)
    assert.match(preload, /WorkbenchProjectHubChannels\.acknowledgeFileOpen/u)
    assert.match(app, /openDroppedPaths\(paths\)/u)
    assert.match(app, /item\.kind === 'file'/u)
    assert.match(builder, /public\.folder/u)
    assert.match(builder, /public\.source-code/u)
    assert.match(builder, /executableArgs:[\s\S]*'%F'/u)
    assert.match(presentation, /ensureNoUnsavedChanges\(\)[\s\S]*switchProjectPath\(path\)/u)
    assert.match(presentation, /openProjectPathInNewWindow\(path\)/u)
    assert.match(presentation, /cloneProjectInNewWindow\(remoteUrl\)/u)
    assert.match(settings, /settingsExitProjectAction/u)
    assert.match(presentation, /onExitProject=\{model\.actions\.exitCurrentProject\}/u)
    assert.match(
      await readFile('src/renderer/src/hooks/useStandaloneWorkbenchPageModel.tsx', 'utf8'),
      /exitCurrentProject[\s\S]*velarosWorkbenchProjectHub\.returnToEntry\(\)/u
    )
    assert.match(preload, /WorkbenchProjectHubChannels\.resolveRegistration/u)
    assert.match(workspaceShell, /resolveRegistration\(legacyProjects\)/u)
    assert.match(control, /projectControlRecentMain[\s\S]*onSwitchProject\(project\.path\)/u)
    assert.match(control, /projectControlNewWindowButton[\s\S]*onOpenProjectInNewWindow/u)
    assert.match(control, /projectAddLocal[\s\S]*projectCloneRemote/u)
    assert.doesNotMatch(control, /projectSwitch|projectOpenNewWindow/u)
    assert.match(control, /data-velar-theme-scope=\{themeTokens\?\.scope/u)
    // 键盘走到行上才跟着高亮；鼠标点过的按钮留着焦点，用 :focus-within 会一直亮着。
    assert.match(
      styles,
      /\.projectControlRecentRow:hover,\s*\.projectControlRecentRow:is\(:focus-visible, :has\(:focus-visible\)\)/u
    )
    assert.match(styles, /\.projectControlActions[\s\S]*flex-direction:\s*column/u)
    assert.match(
      styles,
      /\.projectCloneDialog[\s\S]*--primary:\s*var\(--project-control-theme-color\)/u
    )
    assert.match(styles, /\.projectCloneDialog[\s\S]*background:\s*var\(--workbench-surface\)/u)
  })

  void test('keeps active projects isolated while sharing recent projects', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-project-windows-'))
    const firstRoot = join(dataRoot, 'first')
    const secondRoot = join(dataRoot, 'second')
    await mkdir(firstRoot)
    await mkdir(secondRoot)

    try {
      const store = new RecentProjectsStore(dataRoot)
      const firstWindow = new WorkbenchProjectHub(store)
      const secondWindow = new WorkbenchProjectHub(store)

      assert.equal(firstWindow.openProjectPath(firstRoot).ok, true)
      assert.equal(secondWindow.openProjectPath(secondRoot).ok, true)
      assert.equal(firstWindow.getState().currentProject?.path, firstRoot)
      assert.equal(secondWindow.getState().currentProject?.path, secondRoot)
      assert.deepEqual(
        firstWindow.getState().recentProjects.map((project) => project.path),
        [secondRoot, firstRoot]
      )

      firstWindow.closeProject()
      assert.equal(firstWindow.getState().currentProject, null)
      assert.equal(secondWindow.getState().currentProject?.path, secondRoot)
    } finally {
      await rm(dataRoot, { recursive: true, force: true })
    }
  })

  void test('creates a project directory without replacing the window project', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-create-window-'))
    const activeRoot = join(dataRoot, 'active')
    await mkdir(activeRoot)

    try {
      const hub = new WorkbenchProjectHub(new RecentProjectsStore(dataRoot))
      assert.equal(hub.openProjectPath(activeRoot).ok, true)

      const created = hub.createProject(dataRoot, 'next-project')
      assert.equal(created.ok, true)
      assert.equal(hub.getState().currentProject?.path, activeRoot)
      if (created.ok) {
        assert.equal(created.project.path, join(dataRoot, 'next-project'))
      }

      const recentFile = await readFile(join(dataRoot, 'storage', 'recent-projects.json'), 'utf8')
      assert.doesNotMatch(recentFile, /next-project/u)
    } finally {
      await rm(dataRoot, { recursive: true, force: true })
    }
  })

  void test('queues external files until the renderer acknowledges each open', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-file-open-'))
    const projectRoot = join(dataRoot, 'project')
    await mkdir(projectRoot)

    try {
      const hub = new WorkbenchProjectHub(new RecentProjectsStore(dataRoot))
      assert.equal(hub.openProjectPath(projectRoot).ok, true)

      hub.requestFileOpen('src/first.vel')
      const first = hub.getState().pendingFileOpen
      assert.equal(first?.path, 'src/first.vel')

      hub.requestFileOpen('src/second.vel')
      assert.equal(hub.getState().pendingFileOpen?.path, 'src/first.vel')

      hub.acknowledgeFileOpen(first?.id ?? 0)
      const second = hub.getState().pendingFileOpen
      assert.equal(second?.path, 'src/second.vel')

      hub.acknowledgeFileOpen(second?.id ?? 0)
      assert.equal(hub.getState().pendingFileOpen, null)
    } finally {
      await rm(dataRoot, { recursive: true, force: true })
    }
  })

  void test('switching projects discards old file requests and ignores their acknowledgements', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-file-open-switch-'))
    const firstRoot = join(dataRoot, 'first')
    const secondRoot = join(dataRoot, 'second')
    await mkdir(firstRoot)
    await mkdir(secondRoot)

    try {
      const hub = new WorkbenchProjectHub(new RecentProjectsStore(dataRoot))
      hub.openProjectPath(firstRoot)
      hub.requestFileOpen('src/first.ts')
      const firstRequest = hub.getState().pendingFileOpen!
      hub.requestFileOpen('src/queued.ts')

      hub.openProjectPath(secondRoot)
      assert.equal(hub.getState().pendingFileOpen, null)
      hub.requestFileOpen('src/second.ts')
      hub.acknowledgeFileOpen(firstRequest.id)
      assert.equal(hub.getState().pendingFileOpen?.path, 'src/second.ts')
      hub.acknowledgeFileOpen(hub.getState().pendingFileOpen!.id)
      assert.equal(hub.getState().pendingFileOpen, null)
    } finally {
      await rm(dataRoot, { recursive: true, force: true })
    }
  })

  void test('loads the current recent-project schema and rejects unsupported versions', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-recent-project-schema-'))
    const storageRoot = join(dataRoot, 'storage')
    await mkdir(storageRoot)
    const filePath = join(storageRoot, 'recent-projects.json')
    const entry = { path: join(dataRoot, 'project'), name: 'project', lastOpenedAt: 123 }

    try {
      await writeFile(filePath, JSON.stringify({ version: 1, entries: [null, entry] }))
      assert.deepEqual(new RecentProjectsStore(dataRoot).list(), [entry])

      await writeFile(filePath, JSON.stringify({ version: 2, entries: [entry] }))
      assert.deepEqual(new RecentProjectsStore(dataRoot).list(), [])
    } finally {
      await rm(dataRoot, { recursive: true, force: true })
    }
  })
})
