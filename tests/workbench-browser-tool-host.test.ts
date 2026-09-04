import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'
import type { Session } from 'electron'

import {
  BrowserResidentToolNames,
  createBrowserBundledModDefinition,
} from '@velaros-ai/browser/composition/mod'
import type { ElectronBrowserRuntime, ElectronBrowserRuntimeOptions } from '@velaros-ai/browser/runtime'

import {
  installWorkbenchBrowserDefaultPermissionPolicy,
  type WorkbenchBrowserPermissionSession,
} from '../src/main/browser/WorkbenchBrowserPermissionPolicy'
import {
  createWorkbenchBrowserSiteContext,
  type WorkbenchBrowserGuestWebContents,
  type WorkbenchBrowserModStatePort,
  WorkbenchBrowserToolHost,
} from '../src/main/browser/WorkbenchBrowserToolHost'

type GuestFailLoadListener = (
  event: unknown,
  errorCode: number,
  errorDescription: string,
  validatedUrl: string,
  isMainFrame: boolean
) => void

class FakeGuestWebContents implements WorkbenchBrowserGuestWebContents {
  private readonly destroyedListeners = new Set<() => void>()
  private readonly failLoadListeners = new Set<GuestFailLoadListener>()
  private destroyed = false

  public readonly hostWebContents: { readonly id: number }

  public constructor(public readonly id: number, hostWebContentsId: number) {
    this.hostWebContents = { id: hostWebContentsId }
  }

  public isDestroyed(): boolean {
    return this.destroyed
  }

  public on(event: 'destroyed', listener: () => void): this
  public on(event: 'did-fail-load', listener: GuestFailLoadListener): this
  public on(
    event: 'destroyed' | 'did-fail-load',
    listener: (() => void) | GuestFailLoadListener
  ): this {
    if (event === 'destroyed') this.destroyedListeners.add(listener as () => void)
    else this.failLoadListeners.add(listener as GuestFailLoadListener)
    return this
  }

  public removeListener(event: 'destroyed', listener: () => void): this
  public removeListener(event: 'did-fail-load', listener: GuestFailLoadListener): this
  public removeListener(
    event: 'destroyed' | 'did-fail-load',
    listener: (() => void) | GuestFailLoadListener
  ): this {
    if (event === 'destroyed') this.destroyedListeners.delete(listener as () => void)
    else this.failLoadListeners.delete(listener as GuestFailLoadListener)
    return this
  }

  public emitDestroyed(): void {
    this.destroyed = true
    for (const listener of this.destroyedListeners) listener()
  }

  public emitMainFrameLoadFailure(errorCode = -105): void {
    for (const listener of this.failLoadListeners) {
      listener({}, errorCode, 'NAME_NOT_RESOLVED', 'https://missing.invalid/', true)
    }
  }
}

class FakeModState implements WorkbenchBrowserModStatePort {
  private readonly listeners = new Set<(event: { generation: number }) => void>()
  private generation = 1

  public constructor(public enabled = true) {}

  public isEnabled(): boolean {
    return this.enabled
  }

  public subscribe(listener: (event: { generation: number }) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.generation += 1
    for (const listener of this.listeners) listener({ generation: this.generation })
  }
}

class FakeBrowserRuntime {
  public options: ElectronBrowserRuntimeOptions = {}
  public closeAllCount = 0
  public closedSessionIds: string[] = []
  public presentCalls: Array<{ sessionId: string; webContentsId: number }> = []
  public navigateCalls: Array<{ action: string; url?: string }> = []
  public inspectPageImplementation: () => Promise<unknown> = async () => ({ ok: true })
  public pageState = {
    url: 'https://example.com/',
    title: 'Example',
    loadState: 'loaded' as const,
    viewport: null,
    lastNavigationError: null,
  }

  public setOptions(options: ElectronBrowserRuntimeOptions): void {
    this.options = options
  }

  public openPage(): Promise<void> {
    return Promise.resolve()
  }

  public inspectPage(): Promise<unknown> {
    return this.inspectPageImplementation()
  }

  public presentPage(
    sessionId: string,
    _context: unknown,
    webContentsId: number
  ): Promise<{
    active: true
    visible: true
    driverKind: 'webview'
    url: string
    title: string
    canGoBack: false
    canGoForward: false
    viewport: null
  }> {
    this.presentCalls.push({ sessionId, webContentsId })
    return Promise.resolve({
      active: true,
      visible: true,
      driverKind: 'webview',
      url: this.pageState.url,
      title: this.pageState.title,
      canGoBack: false,
      canGoForward: false,
      viewport: null,
    })
  }

  public getPageState(): Promise<typeof this.pageState> {
    return Promise.resolve(this.pageState)
  }

  public navigatePage(
    _sessionId: string,
    _context: unknown,
    input: { action: string; url?: string }
  ): Promise<{
    action: string
    navigated: boolean
    url: string
    title: string
    canGoBack: boolean
    canGoForward: boolean
    capturedAt: number
  }> {
    this.navigateCalls.push(input)
    return Promise.resolve({
      action: input.action,
      navigated: true,
      url: input.url ?? this.pageState.url,
      title: this.pageState.title,
      canGoBack: false,
      canGoForward: false,
      capturedAt: Date.now(),
    })
  }

  public closeSession(sessionId: string): Promise<void> {
    this.closedSessionIds.push(sessionId)
    return Promise.resolve()
  }

  public closeAllSessions(): void {
    this.closeAllCount += 1
  }

  public getTurnContextSnapshot(): null {
    return null
  }

  public dispose(): void {}
}

class FakePermissionSession implements WorkbenchBrowserPermissionSession {
  public permissionCheckHandler: Parameters<Session['setPermissionCheckHandler']>[0] = null
  public permissionRequestHandler: Parameters<Session['setPermissionRequestHandler']>[0] = null
  public devicePermissionHandler: Parameters<Session['setDevicePermissionHandler']>[0] = null

  public setPermissionCheckHandler(
    handler: Parameters<Session['setPermissionCheckHandler']>[0]
  ): void {
    this.permissionCheckHandler = handler
  }

  public setPermissionRequestHandler(
    handler: Parameters<Session['setPermissionRequestHandler']>[0]
  ): void {
    this.permissionRequestHandler = handler
  }

  public setDevicePermissionHandler(
    handler: Parameters<Session['setDevicePermissionHandler']>[0]
  ): void {
    this.devicePermissionHandler = handler
  }
}

interface TestRig {
  root: string
  dataRoot: string
  projectRoot: string
  otherProjectRoot: string
  ownedRoots: Set<string>
  modState: FakeModState
  runtime: FakeBrowserRuntime
  host: WorkbenchBrowserToolHost
}

const rigs: TestRig[] = []

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    rig.host.dispose()
    await rm(rig.root, { recursive: true, force: true })
  }
})

async function createRig(
  resolveGuestWebContents: (id: number) => WorkbenchBrowserGuestWebContents | null = () => null,
  ensureSiteWorkspace?: (workspaceRoot: string) => Promise<void>
): Promise<TestRig> {
  const root = await mkdtemp(join(tmpdir(), 'velaros-workbench-browser-host-'))
  const dataRoot = join(root, 'data')
  const projectRoot = join(root, 'projects', 'one')
  const otherProjectRoot = join(root, 'projects', 'two')
  await Promise.all([
    mkdir(dataRoot, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
    mkdir(otherProjectRoot, { recursive: true }),
  ])
  const ownedRoots = new Set([projectRoot, otherProjectRoot])
  const modState = new FakeModState()
  const runtime = new FakeBrowserRuntime()
  const host = new WorkbenchBrowserToolHost({
    dataRootDir: dataRoot,
    modState,
    runtime: runtime as unknown as ElectronBrowserRuntime,
    isProjectRootOwned: (candidate) => ownedRoots.has(candidate),
    resolveGuestWebContents,
    ...(ensureSiteWorkspace ? { ensureSiteWorkspace } : {}),
  })
  const rig = {
    root,
    dataRoot,
    projectRoot,
    otherProjectRoot,
    ownedRoots,
    modState,
    runtime,
    host,
  }
  rigs.push(rig)
  return rig
}

describe('WorkbenchBrowserToolHost', () => {
  test('keeps a stable fail-closed Electron permission gateway around runtime delegation', async () => {
    const rig = await createRig()
    const electronSession = new FakePermissionSession()
    const disposeDefaultPolicy = installWorkbenchBrowserDefaultPermissionPolicy(electronSession)
    const stableGateway = electronSession.permissionRequestHandler

    expect(electronSession.permissionCheckHandler?.(
      null,
      'geolocation',
      'https://example.com',
      {} as never
    )).toBe(false)
    expect(electronSession.devicePermissionHandler?.({} as never)).toBe(false)
    let granted: boolean | null = null
    stableGateway?.(
      {} as never,
      'geolocation',
      (value) => { granted = value },
      {} as never
    )
    expect(granted).toBe(false)

    const unregisterRuntime = rig.runtime.options.registerPermissionRequestHandler?.(
      electronSession as unknown as Session,
      (_webContents, _permission, callback) => callback(true)
    )
    expect(electronSession.permissionRequestHandler).toBe(stableGateway)
    granted = null
    electronSession.permissionRequestHandler?.(
      {} as never,
      'geolocation',
      (value) => { granted = value },
      {} as never
    )
    expect(granted).toBe(true)

    unregisterRuntime?.()
    expect(electronSession.permissionRequestHandler).toBe(stableGateway)
    granted = null
    electronSession.permissionRequestHandler?.(
      {} as never,
      'geolocation',
      (value) => { granted = value },
      {} as never
    )
    expect(granted).toBe(false)
    disposeDefaultPolicy()
    expect(electronSession.permissionRequestHandler).toBe(stableGateway)
  })

  test('projects the complete Browser Mod through manifest-owned categories without Project duplicates', async () => {
    const rig = await createRig()
    const snapshot = rig.host.getModSurfaceSnapshot('chat-1', rig.projectRoot)
    const browserMod = createBrowserBundledModDefinition()

    expect(snapshot.enabled).toBe(true)
    expect(snapshot.tools).toHaveLength(40)
    expect(snapshot.tools.map(({ name }) => name).sort()).toEqual(
      browserMod.manifest.contributes.tools.map(({ name }) => name).sort()
    )
    expect(snapshot.tools.every(({ name }) => name.startsWith('browser:'))).toBe(true)
    expect(snapshot.tools.every((tool) =>
      browserMod.manifest.contributes.tools.some((entry) =>
        entry.name === tool.name && entry.categoryId === tool.categoryId
      ))).toBe(true)
    expect(Object.keys(snapshot.categoryDefinitions).sort()).toEqual(
      browserMod.manifest.contributes.toolCategories.map(({ id }) => id).sort()
    )
    expect([...snapshot.enabledCategoryIds].sort()).toEqual(
      browserMod.manifest.contributes.toolCategories.map(({ id }) => id).sort()
    )
    expect(snapshot.residentCategoryIds).toEqual([])
    expect(snapshot.initialVisibleToolNames).toEqual([
      'browser:enter_site',
      'browser:site_context',
      ...BrowserResidentToolNames,
    ])
  })

  test('enter_site creates a site-private workspace outside the project and file API stays there', async () => {
    const rig = await createRig()
    const api = rig.host.createToolBrowserApi('chat-files', rig.projectRoot)
    const context = await api.enterSite('localhost:4173/demo')

    expect(context.url).toBe('http://localhost:4173/demo')
    expect(context.workspaceRoot.startsWith(join(rig.dataRoot, 'browser', 'sites'))).toBe(true)
    expect(relative(rig.projectRoot, context.workspaceRoot).startsWith('..')).toBe(true)

    await api.writeFile('notes/result.txt', 'browser-only')
    expect(await api.readFile('notes/result.txt')).toMatchObject({ content: 'browser-only' })
    expect(await readFile(join(context.workspaceRoot, 'notes', 'result.txt'), 'utf8'))
      .toBe('browser-only')
  })

  test('normalizes public sites together, separates local ports, and rejects unsafe URLs/project roots', async () => {
    const rig = await createRig()
    const sitesRoot = join(rig.dataRoot, 'browser', 'sites')
    const first = createWorkbenchBrowserSiteContext(
      sitesRoot,
      'https://www.example.com/a?x=1',
      rig.projectRoot
    )
    const second = createWorkbenchBrowserSiteContext(
      sitesRoot,
      'http://docs.example.com/b',
      rig.projectRoot
    )
    const localA = createWorkbenchBrowserSiteContext(
      sitesRoot,
      'localhost:3000',
      rig.projectRoot
    )
    const localB = createWorkbenchBrowserSiteContext(
      sitesRoot,
      'localhost:3001',
      rig.projectRoot
    )

    expect(first.workspaceRoot).toBe(second.workspaceRoot)
    expect(localA.workspaceRoot).not.toBe(localB.workspaceRoot)
    expect(() => createWorkbenchBrowserSiteContext(
      sitesRoot,
      'file:///tmp/private.html',
      rig.projectRoot
    )).toThrow('only accepts credential-free HTTP URLs')
    expect(() => createWorkbenchBrowserSiteContext(
      sitesRoot,
      'https://user:secret@example.com/',
      rig.projectRoot
    )).toThrow('only accepts credential-free HTTP URLs')
    expect(() => createWorkbenchBrowserSiteContext(
      join(rig.projectRoot, '.browser'),
      'https://example.com/',
      rig.projectRoot
    )).toThrow('cannot be stored inside the project root')
  })

  test('disabling the Mod closes all sessions and rejects a result that completes late', async () => {
    const rig = await createRig()
    const api = rig.host.createToolBrowserApi('chat-late', rig.projectRoot)
    await api.enterSite('https://example.com/')

    let finishInspect: (value: unknown) => void = () => undefined
    rig.runtime.inspectPageImplementation = () => new Promise((resolve) => {
      finishInspect = resolve
    })
    const pending = api.inspectPage()
    await Promise.resolve()
    rig.modState.setEnabled(false)

    expect(rig.runtime.closeAllCount).toBe(1)
    finishInspect({ title: 'late' })
    await expect(pending).rejects.toThrow('Mod is disabled')
    expect(api.getContext()).toBeNull()
    expect(rig.host.getModSurfaceSnapshot('chat-late', rig.projectRoot)).toMatchObject({
      enabled: false,
      tools: [],
      categoryDefinitions: {},
      enabledCategoryIds: [],
      residentCategoryIds: [],
      initialVisibleToolNames: [],
    })
  })

  test('rejects a delayed enter_site across a disable-enable lifecycle', async () => {
    let releaseWorkspace: () => void = () => undefined
    const workspaceReady = new Promise<void>((resolve) => {
      releaseWorkspace = resolve
    })
    const rig = await createRig(() => null, () => workspaceReady)
    const api = rig.host.createToolBrowserApi('chat-aba', rig.projectRoot)
    const pending = api.enterSite('https://example.com/')
    await Promise.resolve()

    rig.modState.setEnabled(false)
    rig.modState.setEnabled(true)
    releaseWorkspace()

    await expect(pending).rejects.toThrow('changed while entering the site')
    expect(rig.host.getState('chat-aba', rig.projectRoot).active).toBe(false)
  })

  test('validates goto destinations before invoking the runtime', async () => {
    const rig = await createRig()
    const api = rig.host.createToolBrowserApi('chat-navigation', rig.projectRoot)
    await api.enterSite('https://example.com/')

    await expect(api.navigatePage({ action: 'goto', url: 'file:///tmp/private.html' }))
      .rejects.toThrow('only accepts HTTP, HTTPS, or about:blank')
    expect(rig.runtime.navigateCalls).toEqual([])

    await api.navigatePage({ action: 'goto', url: 'https://example.org/next' })
    expect(rig.runtime.navigateCalls).toEqual([{
      action: 'goto',
      url: 'https://example.org/next',
    }])
  })

  test('presentPage accepts only a live webview owned by the calling host WebContents', async () => {
    const guest = new FakeGuestWebContents(91, 12)
    const rig = await createRig((id) => id === guest.id ? guest : null)
    await rig.host.createToolBrowserApi('chat-view', rig.projectRoot)
      .enterSite('https://example.com/')

    await expect(rig.host.presentPage({
      sessionId: 'chat-view',
      projectRoot: rig.projectRoot,
      webContentsId: guest.id,
      hostWebContentsId: 13,
    })).rejects.toThrow('does not belong to this Workbench window')
    expect(rig.runtime.presentCalls).toHaveLength(0)

    const state = await rig.host.presentPage({
      sessionId: 'chat-view',
      projectRoot: rig.projectRoot,
      webContentsId: guest.id,
      hostWebContentsId: 12,
    })
    expect(rig.runtime.presentCalls).toEqual([{ sessionId: 'chat-view', webContentsId: 91 }])
    expect(state).toMatchObject({
      active: true,
      visible: true,
      url: 'https://example.com/',
      title: 'Example',
      loadState: 'loaded',
    })

    const generationBeforeFailure = state.generation
    guest.emitMainFrameLoadFailure()
    expect(rig.host.getState('chat-view', rig.projectRoot)).toMatchObject({
      active: true,
      loadState: 'error',
      generation: generationBeforeFailure + 1,
    })

    guest.emitDestroyed()
    expect(rig.host.getState('chat-view', rig.projectRoot)).toMatchObject({
      active: false,
      visible: false,
      loadState: 'unknown',
    })
    expect(rig.runtime.closedSessionIds).toContain('chat-view')
  })

  test('releaseSession enforces project ownership before closing a bound browser', async () => {
    const rig = await createRig()
    await rig.host.createToolBrowserApi('chat-owned', rig.projectRoot)
      .enterSite('https://example.com/')

    await expect(rig.host.releaseSession('chat-owned', rig.otherProjectRoot))
      .rejects.toThrow('belongs to another Workbench project')
    expect(rig.host.getState('chat-owned', rig.projectRoot).active).toBe(true)
    expect(rig.runtime.closedSessionIds).toEqual([])

    await rig.host.releaseSession('chat-owned', rig.projectRoot)
    expect(rig.runtime.closedSessionIds).toEqual(['chat-owned'])
    expect(rig.host.getState('chat-owned', rig.projectRoot).active).toBe(false)
  })

  test('runtime callbacks synchronize URL/title/load state and releaseProject closes only its sessions', async () => {
    const rig = await createRig()
    const events: number[] = []
    rig.host.subscribe((event) => events.push(event.generation))
    await rig.host.createToolBrowserApi('chat-one', rig.projectRoot)
      .enterSite('https://example.com/')
    await rig.host.createToolBrowserApi('chat-two', rig.projectRoot)
      .enterSite('https://example.com/')
    await rig.host.createToolBrowserApi('chat-other', rig.otherProjectRoot)
      .enterSite('https://example.org/')
    const surfaceGeneration = rig.host
      .getModSurfaceSnapshot('chat-one', rig.projectRoot).generation

    rig.runtime.pageState = {
      ...rig.runtime.pageState,
      url: 'https://docs.example.net/guide',
      title: 'Guide',
      loadState: 'loaded',
    }
    rig.runtime.options.onSessionSiteChange?.('chat-one', 'https://docs.example.net/guide')
    rig.runtime.options.onSessionPageReady?.('chat-one', 'https://docs.example.net/guide')
    await Promise.resolve()
    await Promise.resolve()
    expect(rig.host.getState('chat-one', rig.projectRoot)).toMatchObject({
      active: true,
      url: 'https://docs.example.net/guide',
      title: 'Guide',
      loadState: 'loaded',
    })
    expect(rig.host.getModSurfaceSnapshot('chat-one', rig.projectRoot).generation)
      .toBe(surfaceGeneration)

    await rig.host.releaseProject(rig.projectRoot)
    expect(rig.runtime.closedSessionIds.sort()).toEqual(['chat-one', 'chat-two'])
    expect(rig.host.getState('chat-one', rig.projectRoot).active).toBe(false)
    expect(rig.host.getState('chat-other', rig.otherProjectRoot).active).toBe(true)
    expect(events.length).toBeGreaterThan(3)
  })

  test('persistent user-script reads are supported but mutations fail closed without approval', async () => {
    const rig = await createRig()
    const api = rig.host.createToolBrowserApi('chat-scripts', rig.projectRoot)
    await api.enterSite('https://example.com/')

    const listed = await api.manageUserScripts({ action: 'list' })
    expect(listed.overview.scripts).toEqual([])
    await expect(api.manageUserScripts({
      action: 'create',
      script: {
        name: 'unsafe without approval',
        code: 'document.body.remove()',
        match: ['https://example.com/*'],
      },
    })).rejects.toThrow('without an explicit approval channel')
  })
})
