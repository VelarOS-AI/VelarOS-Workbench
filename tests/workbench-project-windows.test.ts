import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { WorkbenchProjectHub } from '../src/main/projects/ProjectHub'
import { RecentProjectsStore } from '../src/main/projects/RecentProjectsStore'

void describe('Workbench project window ownership', () => {
  void test('routes OS and renderer folder opens through the multi-window owner', async () => {
    const [main, manager, menu, preload, app, presentation, settings, host, control, styles] = await Promise.all([
      readFile('src/main/index.ts', 'utf8'),
      readFile('src/main/projects/WorkbenchWindowManager.ts', 'utf8'),
      readFile('src/main/projects/ProjectHubMenu.ts', 'utf8'),
      readFile('src/preload/index.ts', 'utf8'),
      readFile('src/renderer/src/StandaloneWorkbenchApp.tsx', 'utf8'),
      readFile('src/renderer/src/StandaloneWorkbenchPagePresentation.tsx', 'utf8'),
      readFile('src/renderer/src/components/settings/WorkbenchSettingsDialog.tsx', 'utf8'),
      readFile('src/renderer/src/host/standaloneWorkbenchHost.ts', 'utf8'),
      readFile('src/renderer/src/components/chrome/WorkbenchProjectControl.tsx', 'utf8'),
      readFile('src/renderer/src/styles/02-chrome-top.module.css', 'utf8'),
    ])

    assert.match(main, /requestSingleInstanceLock\(instanceLaunchData\)/u)
    assert.match(main, /app\.on\('open-file'/u)
    assert.match(main, /app\.on\('second-instance'/u)
    assert.match(main, /app\.relaunch\(\{ execPath: requestedExecutablePath, args: paths \}\)/u)
    assert.match(manager, /getOpenProjectPaths\(\)/u)
    assert.match(manager, /findProjectRecord\(projectPath\)/u)
    assert.match(manager, /this\.focusWindow\(existing\.window\)/u)
    assert.match(manager, /this\.createWindow\(projectPath\)/u)
    assert.match(manager, /switchProjectPath[\s\S]*releaseProjectResources/u)
    assert.match(manager, /openProjectPathInNewWindow[\s\S]*openProjectPath\(null, path\)/u)
    assert.match(manager, /cloneProjectInNewWindow[\s\S]*'git',[\s\S]*'clone'[\s\S]*openProjectPathInNewWindow/u)
    assert.match(menu, /app\.dock\?\.setMenu\(buildDockMenu\(windows\)\)/u)
    assert.match(menu, /buildRecentProjectItems\(windows, recentProjects, 'new-window'\)/u)
    assert.match(preload, /webUtils\.getPathForFile\(file\)/u)
    assert.match(preload, /WorkbenchProjectHubChannels\.switchProjectPath/u)
    assert.match(preload, /WorkbenchProjectHubChannels\.openProjectPathInNewWindow/u)
    assert.match(preload, /WorkbenchProjectHubChannels\.cloneProjectInNewWindow/u)
    assert.match(app, /openDroppedProjectPaths\(paths\)/u)
    assert.match(presentation, /ensureNoUnsavedChanges\(\)[\s\S]*switchProjectPath\(path\)/u)
    assert.match(presentation, /openProjectPathInNewWindow\(path\)/u)
    assert.match(presentation, /cloneProjectInNewWindow\(remoteUrl\)/u)
    assert.match(settings, /settingsExitProjectAction/u)
    assert.match(host, /addWorkspaceRoot:[\s\S]*validateProjectPath\(path\)/u)
    assert.doesNotMatch(host, /addWorkspaceRoot:[\s\S]*openProjectPath\(path\)/u)
    assert.match(control, /projectControlRecentMain[\s\S]*onSwitchProject\(project\.path\)/u)
    assert.match(control, /projectControlNewWindowButton[\s\S]*onOpenProjectInNewWindow/u)
    assert.match(control, /projectAddLocal[\s\S]*projectCloneRemote/u)
    assert.doesNotMatch(control, /projectSwitch|projectOpenNewWindow/u)
    assert.match(styles, /\.projectControlRecentRow:hover,[\s\S]*\.projectControlRecentRow:focus-within/u)
    assert.match(styles, /\.projectControlActions[\s\S]*flex-direction:\s*column/u)
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
})
