import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, mock, test } from 'bun:test'
import type { BrowserWindow, WebContents } from 'electron'

import { AppError } from '@velaros-ai/velaros/core/error'

import { WorkbenchProjectHub } from '../src/main/projects/ProjectHub'
import { RecentProjectsStore } from '../src/main/projects/RecentProjectsStore'

type CloneGit = (
  file: string,
  args: string[],
  options: { timeout: number; reject: boolean; env: NodeJS.ProcessEnv }
) => Promise<{ failed: boolean; exitCode: number; timedOut: boolean }>

let cloneParent: string | undefined
let cloneGit: CloneGit | undefined

mock.module('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: {
    showOpenDialog: async () => {
      assert.ok(cloneParent, 'Only a clone fixture may select its destination')
      return { canceled: false, filePaths: [cloneParent] }
    },
  },
}))

mock.module('execa', () => ({
  execa: (file: string, args: string[], options: Parameters<CloneGit>[2]) => {
    assert.ok(cloneGit, 'Unexpected Git invocation outside the clone fixture')
    return cloneGit(file, args, options)
  },
}))

class ProjectWindow extends EventEmitter {
  private static nextId = 200
  public readonly webContents = {
    id: ProjectWindow.nextId++,
    isDestroyed: () => false,
    send: () => {},
  }

  public isDestroyed(): boolean { return false }
  public isMinimized(): boolean { return false }
  public isVisible(): boolean { return true }
  public focus(): void {}
}

async function projectTransitionFixture(
  release: (owner: number, root: string) => Promise<void>,
  onLastProjectClosed?: () => void
) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-project-transitions-'))
  const roots = ['first', 'second', 'third'].map((name) => join(dataRoot, name))
  await Promise.all(roots.map((path) => mkdir(path)))
  const { WorkbenchWindowManager } = await import('../src/main/projects/WorkbenchWindowManager')
  const manager = new WorkbenchWindowManager(dataRoot, {
    createBrowserWindow: () => new ProjectWindow() as unknown as BrowserWindow,
    releaseProjectResources: release,
    onLastProjectClosed,
  })
  const window = manager.createWindow(roots[0]) as unknown as ProjectWindow
  const sender = window.webContents as unknown as WebContents
  return { dataRoot, roots, manager, window, sender }
}

void describe('Workbench project window ownership', () => {
  void test('project history survives startup without a window and closing the last project', async () => {
    const fixture = await projectTransitionFixture(async () => {})
    try {
      const expected = fixture.manager.getRecentProjects()
      assert.equal(expected[0]?.name, 'first')
      fixture.window.emit('closed')
      assert.deepEqual(fixture.manager.getRecentProjects(), expected)
      const { WorkbenchWindowManager } = await import('../src/main/projects/WorkbenchWindowManager')
      const restarted = new WorkbenchWindowManager(fixture.dataRoot, {
        createBrowserWindow: () => { throw new Error('History must not need a window') },
      })
      assert.deepEqual(restarted.getRecentProjects(), expected)
    } finally {
      await rm(fixture.dataRoot, { recursive: true, force: true })
    }
  })

  void test('failed clones preserve a concurrently created destination and partial clone files without opening a window', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'workbench-clone-failure-'))
    const activeRoot = join(dataRoot, 'active')
    const foreignRoot = join(dataRoot, 'foreign-project')
    const partialRoot = join(dataRoot, 'partial-project')
    const gitStarted = Promise.withResolvers<void>()
    const gitFailure = Promise.withResolvers<{ failed: boolean; exitCode: number; timedOut: boolean }>()
    const failure = { failed: true, exitCode: 128, timedOut: false }
    let pendingClone: Promise<unknown> | undefined
    try {
      await mkdir(activeRoot)
      const { WorkbenchWindowManager } = await import('../src/main/projects/WorkbenchWindowManager')
      let createdWindows = 0
      const manager = new WorkbenchWindowManager(dataRoot, {
        createBrowserWindow: () => {
          createdWindows += 1
          return new ProjectWindow() as unknown as BrowserWindow
        },
      })
      const window = manager.createWindow(activeRoot) as unknown as ProjectWindow
      const sender = window.webContents as unknown as WebContents
      cloneParent = dataRoot
      cloneGit = async (file, args, options) => {
        assert.equal(file, 'git')
        assert.deepEqual(args, ['clone', '--', 'https://example.test/foreign-project.git', foreignRoot])
        assert.equal(options.timeout, 120_000)
        assert.equal(options.reject, false)
        assert.equal(options.env.GIT_TERMINAL_PROMPT, '0')
        gitStarted.resolve()
        return gitFailure.promise
      }

      const cloning = manager.cloneProjectInNewWindow(sender, 'https://example.test/foreign-project.git')
      pendingClone = cloning
      await Promise.race([
        gitStarted.promise,
        cloning.then(() => { throw new Error('Clone finished before entering the Git boundary') }),
      ])
      // The real preflight has completed. Another actor now owns this real directory.
      await mkdir(foreignRoot)
      await writeFile(join(foreignRoot, 'foreign.txt'), 'created by another actor')
      gitFailure.resolve(failure)
      assert.deepEqual(await cloning, { ok: false, reason: 'clone-failed' })
      assert.equal(await readFile(join(foreignRoot, 'foreign.txt'), 'utf8'), 'created by another actor')
      assert.equal(createdWindows, 1)

      cloneGit = async (file, args) => {
        assert.equal(file, 'git')
        assert.deepEqual(args, ['clone', '--', 'https://example.test/partial-project.git', partialRoot])
        await mkdir(join(partialRoot, '.git'), { recursive: true })
        await writeFile(join(partialRoot, '.git', 'partial'), 'partial clone evidence')
        return failure
      }
      const partialClone = manager.cloneProjectInNewWindow(sender, 'https://example.test/partial-project.git')
      pendingClone = partialClone
      assert.deepEqual(await partialClone, { ok: false, reason: 'clone-failed' })
      assert.equal(await readFile(join(partialRoot, '.git', 'partial'), 'utf8'), 'partial clone evidence')
      assert.equal(createdWindows, 1)
      assert.deepEqual(manager.getOpenProjectPaths(), [activeRoot])
    } finally {
      gitFailure.resolve(failure)
      try { await pendingClone }
      finally {
        cloneGit = undefined
        cloneParent = undefined
        await rm(dataRoot, { recursive: true, force: true })
      }
    }
  })

  void test('project transitions release each actual project before publishing the next root', async () => {
    const firstRelease = Promise.withResolvers<void>()
    const secondRelease = Promise.withResolvers<void>()
    const firstStarted = Promise.withResolvers<void>()
    const secondStarted = Promise.withResolvers<void>()
    const released: string[] = []
    const f = await projectTransitionFixture(async (_owner, root) => {
      released.push(root)
      if (released.length === 1) {
        firstStarted.resolve()
        await firstRelease.promise
      } else {
        secondStarted.resolve()
        await secondRelease.promise
      }
    })
    try {
      const first = f.manager.switchProjectPath(f.sender, f.roots[1])
      const second = f.manager.switchProjectPath(f.sender, f.roots[2])
      await firstStarted.promise
      assert.deepEqual(released, [f.roots[0]])
      assert.equal(f.manager.getHubForWebContents(f.sender)?.getState().currentProject?.path, f.roots[0])
      assert.throws(
        () => f.manager.assertProjectForWebContents(f.sender, f.roots[0]),
        (error) => AppError.from(error).code === 'CANCELLED'
      )
      firstRelease.resolve()
      assert.equal((await first).ok, true)
      await secondStarted.promise
      assert.deepEqual(released, [f.roots[0], f.roots[1]])
      assert.equal(f.manager.getHubForWebContents(f.sender)?.getState().currentProject?.path, f.roots[1])
      secondRelease.resolve()
      assert.equal((await second).ok, true)
      assert.equal(f.manager.getHubForWebContents(f.sender)?.getState().currentProject?.path, f.roots[2])
      f.manager.assertProjectForWebContents(f.sender, f.roots[2])
      assert.throws(
        () => f.manager.assertProjectForWebContents(f.sender, f.roots[0]),
        (error) => AppError.from(error).code === 'PERMISSION'
      )
    } finally {
      firstRelease.resolve()
      secondRelease.resolve()
      await rm(f.dataRoot, { recursive: true, force: true })
    }
  })

  void test('failed project release preserves the active project and a later exit waits for cleanup', async () => {
    const failure = new Error('resource owner did not close')
    const retry = Promise.withResolvers<void>()
    const retryStarted = Promise.withResolvers<void>()
    let calls = 0
    const f = await projectTransitionFixture(async () => {
      if (++calls === 1) throw failure
      retryStarted.resolve()
      await retry.promise
    })
    try {
      const hub = f.manager.getHubForWebContents(f.sender)!
      hub.requestFileOpen('keep.ts')
      const state = hub.getState()
      await assert.rejects(f.manager.returnToEntry(f.sender), (error) => error === failure)
      assert.deepEqual(hub.getState(), state)
      f.manager.assertProjectForWebContents(f.sender, f.roots[0])
      const exiting = f.manager.returnToEntry(f.sender)
      await retryStarted.promise
      assert.deepEqual(hub.getState(), state)
      assert.throws(
        () => f.manager.assertProjectForWebContents(f.sender, f.roots[0]),
        (error) => AppError.from(error).code === 'CANCELLED'
      )
      retry.resolve()
      assert.equal((await exiting).currentProject, null)
      assert.equal(hub.getState().pendingFileOpen, null)
      assert.throws(
        () => f.manager.assertProjectForWebContents(f.sender, f.roots[0]),
        (error) => AppError.from(error).code === 'PERMISSION'
      )
    } finally {
      retry.resolve()
      await rm(f.dataRoot, { recursive: true, force: true })
    }
  })

  void test('switch rechecks target ownership after releasing the old project', async () => {
    const release = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const f = await projectTransitionFixture(async () => {
      started.resolve()
      await release.promise
    })
    try {
      const switching = f.manager.switchProjectPath(f.sender, f.roots[1])
      await started.promise
      assert.equal(f.manager.openProjectPathInNewWindow(f.roots[1]).ok, true)
      release.resolve()
      assert.equal((await switching).ok, true)
      assert.deepEqual(f.manager.getOpenProjectPaths(), [f.roots[0], f.roots[1]])
    } finally {
      release.resolve()
      await rm(f.dataRoot, { recursive: true, force: true })
    }
  })

  void test('a closed project window cannot accept a late switch completion', async () => {
    const release = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    let calls = 0
    const f = await projectTransitionFixture(
      async () => {
        if (++calls !== 1) return
        started.resolve()
        await release.promise
      },
      () => { assert.equal(calls, 2, 'window release is admitted before the application quit request') }
    )
    try {
      const switching = f.manager.switchProjectPath(f.sender, f.roots[1])
      await started.promise
      f.window.emit('closed')
      release.resolve()
      assert.deepEqual(await switching, { ok: false, reason: 'canceled' })
      assert.deepEqual(f.manager.getOpenProjectPaths(), [])
    } finally {
      release.resolve()
      await rm(f.dataRoot, { recursive: true, force: true })
    }
  })

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
