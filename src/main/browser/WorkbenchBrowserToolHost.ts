import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import {
  AgentModLoader,
  type AgentModSurfaceSnapshot,
  createAgentModSurfaceSnapshot,
} from '@velaros-ai/agent/mods'
import type { ToolCategoryDefinition } from '@velaros-ai/agent/protocol'
import {
  BrowserModId,
  BrowserResidentToolNames,
  type BrowserToolCategoryId,
  createBrowserBundledModDefinition,
} from '@velaros-ai/browser/composition/mod'
import {
  type BrowserPageNavigationOptions,
  type BrowserPageWindowState,
  type BrowserSiteContext,
  BrowserUserScriptManager,
  type BrowserUserScriptManageRequest,
  type BrowserUserScriptMutationResult,
  createBrowserSiteWorkspaceFileAccess,
  getBrowserSiteHost,
  isLocalBrowserUrl,
  resolveBrowserSearchOrNavigationInput,
} from '@velaros-ai/browser/core'
import type {
  ElectronBrowserRuntime,
  ElectronBrowserRuntimeOptions,
} from '@velaros-ai/browser/runtime'
import {
  type BrowserToolContext,
  type ToolBrowserApi,
  type VelaTool,
} from '@velaros-ai/browser/tools'
import { AppError } from '@velaros-ai/core/error'
import { createProjectBundledModDefinition } from '@velaros-ai/project/composition'

import type {
  WorkbenchBrowserChangedEvent,
  WorkbenchBrowserLoadState,
  WorkbenchBrowserState,
} from '../../shared/workbenchBrowser'
import { normalizeWorkbenchBrowserPageUrl } from '../../shared/workbenchBrowser'
import type {
  WorkbenchAgentToolDefinition,
  WorkbenchAgentToolSurfaceDefinition,
} from '../agent/WorkbenchAgentToolRegistry'

import { registerWorkbenchBrowserRuntimePermissionHandler } from './WorkbenchBrowserPermissionPolicy'

const MaximumSessionIdLength = 512
const DefaultAbortSignal = new AbortController().signal
const BrowserModDefinition = createBrowserBundledModDefinition()
const ProjectModDefinition = createProjectBundledModDefinition()
const ValidatedModSurface = createValidatedModSurface()
const ValidatedBrowserCategoryDefinitions = projectValidatedBrowserCategories(ValidatedModSurface)
const ValidatedBrowserCategoryIds = Object.freeze(
  BrowserModDefinition.manifest.contributes.toolCategories.map(({ id }) => id)
)
const InitialVisibleBrowserToolNames = Object.freeze([
  'browser:enter_site',
  'browser:site_context',
  ...BrowserResidentToolNames,
])

interface WorkbenchBrowserModStatePort {
  isEnabled(id: typeof BrowserModId): boolean
  subscribe(listener: (event: { generation: number }) => void): () => void
}

interface WorkbenchBrowserGuestWebContents {
  readonly id: number
  readonly hostWebContents?: { readonly id: number } | null
  isDestroyed(): boolean
  on(event: 'destroyed', listener: () => void): unknown
  on(
    event: 'did-fail-load',
    listener: (
      event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean
    ) => void
  ): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
  removeListener(
    event: 'did-fail-load',
    listener: (
      event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean
    ) => void
  ): unknown
}

interface WorkbenchBrowserToolHostOptions {
  dataRootDir: string
  modState: WorkbenchBrowserModStatePort
  runtime: ElectronBrowserRuntime
  /** 当前 Workbench 窗口仍实际持有该工程根时才允许 Agent/IPC 操作。 */
  isProjectRootOwned: (projectRoot: string) => boolean
  /** main 装配根传入 `webContents.fromId`，测试可注入无 Electron 的窄替身。 */
  resolveGuestWebContents: (webContentsId: number) => WorkbenchBrowserGuestWebContents | null
  /** 测试可注入可控 barrier，生产默认创建站点私有目录。 */
  ensureSiteWorkspace?: (workspaceRoot: string) => Promise<void>
}

interface BrowserGuestLifecycle {
  readonly webContentsId: number
  committed: boolean
  destroyed: boolean
  loadFailed: boolean
  dispose(): void
}

interface BrowserSessionBinding {
  readonly sessionId: string
  readonly projectRoot: string
  context: BrowserSiteContext | null
  title: string | null
  loadState: WorkbenchBrowserLoadState
  visible: boolean
  lifecycle: number
  guestLifecycle: BrowserGuestLifecycle | null
}

type WorkbenchBrowserModToolDefinition = WorkbenchAgentToolDefinition

interface WorkbenchBrowserModSurfaceSnapshot {
  readonly generation: number
  readonly enabled: boolean
  readonly tools: readonly WorkbenchBrowserModToolDefinition[]
  readonly categoryDefinitions: Readonly<Record<BrowserToolCategoryId, ToolCategoryDefinition>>
  readonly enabledCategoryIds: readonly BrowserToolCategoryId[]
  /** Browser 是 project space 客居 Mod，不把完整类别常驻；精确启动盘见下一字段。 */
  readonly residentCategoryIds: readonly BrowserToolCategoryId[]
  /** Project 会话的启动盘：自举入口 + 状态查询 + Browser 核心闭环。 */
  readonly initialVisibleToolNames: readonly string[]
}

type BrowserHostListener = (event: WorkbenchBrowserChangedEvent) => void

/**
 * Workbench 主进程中唯一的 Browser Runtime 宿主。
 *
 * Mod 只控制全局启停；`browser:enter_site` 才建立聊天会话的站点上下文。所有动作在
 * runtime 调用前后都重新校验 Mod、工程所有权与 lifecycle，关闭 Mod 后迟到结果也会失败。
 */
export class WorkbenchBrowserToolHost {
  public readonly runtime: ElectronBrowserRuntime

  private readonly browserSitesRoot: string
  private readonly bindings = new Map<string, BrowserSessionBinding>()
  private readonly listeners = new Set<BrowserHostListener>()
  private readonly unsubscribeModState: () => void
  private stateRevision = 1
  private surfaceGeneration = 1
  private lifecycleSequence = 0
  private browserModEnabled: boolean
  private disposed = false

  public constructor(private readonly options: WorkbenchBrowserToolHostOptions) {
    if (!isAbsolute(options.dataRootDir)) {
      throw new AppError('VALIDATION', 'Workbench Browser data root must be absolute.')
    }
    this.browserSitesRoot = join(resolve(options.dataRootDir), 'browser', 'sites')
    this.runtime = options.runtime
    this.browserModEnabled = options.modState.isEnabled(BrowserModId)
    this.runtime.setOptions(this.createRuntimeOptions())
    this.unsubscribeModState = options.modState.subscribe(() => {
      const enabled = options.modState.isEnabled(BrowserModId)
      if (enabled === this.browserModEnabled) return
      this.browserModEnabled = enabled
      this.surfaceGeneration += 1
      if (!enabled) this.revokeAllSessions()
      else this.advanceStateRevision()
    })
  }

  public subscribe(listener: BrowserHostListener): () => void {
    this.assertNotDisposed()
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  public getStateRevision(): number {
    return this.stateRevision
  }

  /** 给 Agent 每轮冻结的 Mod surface；40 个工具只在 Browser Mod 启用时出现。 */
  public getModSurfaceSnapshot(
    sessionId: string,
    projectRoot: string
  ): WorkbenchBrowserModSurfaceSnapshot {
    const normalizedSessionId = normalizeSessionId(sessionId)
    const normalizedProjectRoot = normalizeProjectRoot(projectRoot)
    this.assertProjectOwned(normalizedProjectRoot)
    if (!this.isModEnabled()) return emptyModSurfaceSnapshot(this.surfaceGeneration)

    this.ensureBinding(normalizedSessionId, normalizedProjectRoot)
    return Object.freeze({
      generation: this.surfaceGeneration,
      enabled: true,
      tools: Object.freeze(this.bindBrowserTools(normalizedSessionId, normalizedProjectRoot)),
      categoryDefinitions: ValidatedBrowserCategoryDefinitions,
      enabledCategoryIds: ValidatedBrowserCategoryIds,
      residentCategoryIds: Object.freeze([]),
      initialVisibleToolNames: InitialVisibleBrowserToolNames,
    })
  }

  /** 工具执行上下文使用的完整 Browser API。 */
  public createToolBrowserApi(
    sessionId: string,
    projectRoot: string,
    abortSignal: AbortSignal = DefaultAbortSignal
  ): ToolBrowserApi {
    const normalizedSessionId = normalizeSessionId(sessionId)
    const normalizedProjectRoot = normalizeProjectRoot(projectRoot)
    this.assertExecutionAllowed(normalizedProjectRoot, abortSignal)
    this.ensureBinding(normalizedSessionId, normalizedProjectRoot)

    const run = <T>(
      action: (context: BrowserSiteContext) => Promise<T>,
      options: { openPage?: boolean } = { openPage: true }
    ): Promise<T> => this.runRuntimeAction(
      normalizedSessionId,
      normalizedProjectRoot,
      abortSignal,
      action,
      options.openPage !== false
    )
    const runFile = <T>(action: (context: BrowserSiteContext) => Promise<T>): Promise<T> =>
      this.runFileAction(normalizedSessionId, normalizedProjectRoot, abortSignal, action)

    return {
      isActive: () => this.isActive(normalizedSessionId, normalizedProjectRoot),
      getContext: () => this.readActiveContext(normalizedSessionId, normalizedProjectRoot),
      enterSite: (url) => this.enterSite(
        normalizedSessionId,
        normalizedProjectRoot,
        url,
        abortSignal
      ),
      leaveSite: () => this.leaveSite(
        normalizedSessionId,
        normalizedProjectRoot,
        abortSignal
      ),
      showPage: () => run((context) =>
        this.runtime.showPage(normalizedSessionId, context, abortSignal)),
      inspectPage: (input) => run((context) =>
        this.runtime.inspectPage(normalizedSessionId, context, input, abortSignal)),
      captureScreenshot: (input) => run((context) =>
        this.runtime.captureScreenshot(normalizedSessionId, context, input, abortSignal)),
      performTargetAction: (input) => run((context) =>
        this.runtime.performTargetAction(normalizedSessionId, context, input, abortSignal)),
      navigatePage: (input) => run((context) =>
        this.runtime.navigatePage(
          normalizedSessionId,
          context,
          normalizeBrowserNavigationOptions(input),
          abortSignal
        )),
      scrollPage: (input) => run((context) =>
        this.runtime.scrollPage(normalizedSessionId, context, input, abortSignal)),
      queryElements: (input) => run((context) =>
        this.runtime.queryElements(normalizedSessionId, context, input, abortSignal)),
      getPageDiagnostics: (input) => run((context) =>
        this.runtime.getPageDiagnostics(normalizedSessionId, context, input, abortSignal)),
      typeText: (input) => run((context) =>
        this.runtime.typeText(normalizedSessionId, context, input, abortSignal)),
      pressKey: (input) => run((context) =>
        this.runtime.pressKey(normalizedSessionId, context, input, abortSignal)),
      moveMouse: (input) => run((context) =>
        this.runtime.moveMouse(normalizedSessionId, context, input, abortSignal)),
      clickCoordinates: (input) => run((context) =>
        this.runtime.clickCoordinates(normalizedSessionId, context, input, abortSignal)),
      dragTargets: (input) => run((context) =>
        this.runtime.dragTargets(normalizedSessionId, context, input, abortSignal)),
      waitForSelector: (input) => run((context) =>
        this.runtime.waitForSelector(normalizedSessionId, context, input, abortSignal)),
      waitForPage: (input) => run((context) =>
        this.runtime.waitForPage(normalizedSessionId, context, input, abortSignal)),
      setViewport: (input) => run((context) =>
        this.runtime.setViewport(normalizedSessionId, context, input, abortSignal)),
      setPageZoom: (input) => run((context) =>
        this.runtime.setPageZoom(normalizedSessionId, context, input, abortSignal)),
      configureNetwork: (input) => run((context) =>
        this.runtime.configureNetwork(normalizedSessionId, context, input, abortSignal)),
      readNetworkResponseBody: (input) => run((context) =>
        this.runtime.readNetworkResponseBody(normalizedSessionId, context, input, abortSignal)),
      readNetworkRequestDetails: (input) => run((context) =>
        this.runtime.readNetworkRequestDetails(normalizedSessionId, context, input, abortSignal)),
      configureEmulation: (input) => run((context) =>
        this.runtime.configureEmulation(normalizedSessionId, context, input, abortSignal)),
      startPerformanceTrace: (input) => run((context) =>
        this.runtime.startPerformanceTrace(normalizedSessionId, context, input, abortSignal)),
      stopPerformanceTrace: () => run((context) =>
        this.runtime.stopPerformanceTrace(normalizedSessionId, context, abortSignal)),
      analyzePerformanceInsight: (input) => run((context) =>
        this.runtime.analyzePerformanceInsight(normalizedSessionId, context, input, abortSignal)),
      captureHeapSnapshot: (input) => run((context) =>
        this.runtime.captureHeapSnapshot(normalizedSessionId, context, input, abortSignal)),
      startScreencast: (input) => run((context) =>
        this.runtime.startScreencast(normalizedSessionId, context, input, abortSignal)),
      stopScreencast: (input) => run((context) =>
        this.runtime.stopScreencast(normalizedSessionId, context, input, abortSignal)),
      listPendingEvents: () => run((context) =>
        this.runtime.listPendingEvents(normalizedSessionId, context, abortSignal)),
      listPageTargets: () => run((context) =>
        this.runtime.listPageTargets(normalizedSessionId, context, abortSignal)),
      switchPageTarget: (input) => run((context) =>
        this.runtime.switchPageTarget(normalizedSessionId, context, input, abortSignal)),
      handleDialog: (input) => run((context) =>
        this.runtime.handleDialog(normalizedSessionId, context, input, abortSignal)),
      handleDownload: (input) => run((context) =>
        this.runtime.handleDownload(normalizedSessionId, context, input, abortSignal)),
      handlePermission: (input) => run((context) =>
        this.runtime.handlePermission(normalizedSessionId, context, input, abortSignal)),
      uploadFile: (input) => run((context) =>
        this.runtime.uploadFile(normalizedSessionId, context, input, abortSignal)),
      fetchResource: (input) => run((context) =>
        this.runtime.fetchResource(normalizedSessionId, context, input, abortSignal)),
      listMediaSources: (input) => run((context) =>
        this.runtime.listMediaSources(normalizedSessionId, context, input, abortSignal)),
      listPageResources: (input) => run((context) =>
        this.runtime.listPageResources(normalizedSessionId, context, input, abortSignal)),
      exportPagePdf: (input) => run((context) =>
        this.runtime.exportPagePdf(normalizedSessionId, context, input, abortSignal)),
      readPageStorage: (input) => run((context) =>
        this.runtime.readPageStorage(normalizedSessionId, context, input, abortSignal)),
      evaluateScript: (input) => run((context) =>
        this.runtime.evaluateScript(normalizedSessionId, context, input, abortSignal)),
      getPageState: () => run((context) =>
        this.runtime.getPageState(normalizedSessionId, context, abortSignal)),
      getTurnContextSnapshot: () => {
        if (!this.isActive(normalizedSessionId, normalizedProjectRoot)) return null
        return this.runtime.getTurnContextSnapshot(normalizedSessionId)
      },
      listFiles: (input) => runFile((context) =>
        createBrowserSiteWorkspaceFileAccess(context).listFiles(input)),
      readFile: (path, startLine, endLine, maxChars) => runFile((context) =>
        createBrowserSiteWorkspaceFileAccess(context)
          .readFile(path, startLine, endLine, maxChars)),
      writeFile: (path, content, input) => runFile((context) =>
        createBrowserSiteWorkspaceFileAccess(context).writeFile(path, content, input)),
      manageUserScripts: (request) => this.manageUserScripts(
        normalizedSessionId,
        normalizedProjectRoot,
        request,
        abortSignal
      ),
    }
  }

  /** renderer 把自己的 webview guest 交给 runtime；跨窗口 id 会被拒绝。 */
  public async presentPage(input: {
    sessionId: string
    projectRoot: string
    webContentsId: number
    hostWebContentsId: number
    abortSignal?: AbortSignal
  }): Promise<WorkbenchBrowserState> {
    const sessionId = normalizeSessionId(input.sessionId)
    const projectRoot = normalizeProjectRoot(input.projectRoot)
    const abortSignal = input.abortSignal ?? DefaultAbortSignal
    const binding = this.requireActiveBinding(sessionId, projectRoot, abortSignal)
    const guest = this.resolveOwnedGuestWebContents(input.webContentsId, input.hostWebContentsId)
    const lifecycle = binding.lifecycle
    const candidateGuestLifecycle = this.createGuestLifecycle(binding, guest)

    try {
      const windowState = await this.runtime.presentPage(
        sessionId,
        binding.context,
        guest.id,
        undefined,
        abortSignal
      )
      this.assertBindingLease(binding, lifecycle, abortSignal)
      if (candidateGuestLifecycle.destroyed || guest.isDestroyed()) {
        throw new AppError('PERMISSION', 'Browser webview was destroyed while being presented.')
      }

      this.disposeGuestLifecycle(binding)
      binding.guestLifecycle = candidateGuestLifecycle
      candidateGuestLifecycle.committed = true
      this.applyWindowState(binding, windowState)
      if (candidateGuestLifecycle.loadFailed) {
        this.handleGuestLoadFailure(binding, candidateGuestLifecycle)
      }
      return this.getState(sessionId, projectRoot)
    } catch (error) {
      if (binding.guestLifecycle === candidateGuestLifecycle) {
        this.revokeBinding(binding)
        void this.runtime.closeSession(sessionId).catch(() => undefined)
      } else {
        candidateGuestLifecycle.dispose()
      }
      throw error
    }
  }

  public getState(sessionId: string, projectRoot: string): WorkbenchBrowserState {
    const normalizedSessionId = normalizeSessionId(sessionId)
    const normalizedProjectRoot = normalizeProjectRoot(projectRoot)
    this.assertProjectOwned(normalizedProjectRoot)
    const binding = this.bindings.get(normalizedSessionId)
    if (binding && binding.projectRoot !== normalizedProjectRoot) {
      throw new AppError('PERMISSION', 'Browser session belongs to another Workbench project.')
    }
    const active = this.isModEnabled() && !!binding?.context
    return Object.freeze({
      generation: this.stateRevision,
      sessionId: normalizedSessionId,
      active,
      url: active ? binding.context?.url ?? null : null,
      title: active ? binding.title : null,
      loadState: active ? binding.loadState : 'unknown',
      visible: active ? binding.visible : false,
    })
  }

  public async releaseSession(sessionId: string, projectRoot: string): Promise<void> {
    const normalizedSessionId = normalizeSessionId(sessionId)
    const normalizedProjectRoot = normalizeProjectRoot(projectRoot)
    this.assertProjectOwned(normalizedProjectRoot)
    const binding = this.bindings.get(normalizedSessionId)
    if (!binding) return
    if (binding.projectRoot !== normalizedProjectRoot) {
      throw new AppError('PERMISSION', 'Browser session belongs to another Workbench project.')
    }
    this.revokeBinding(binding)
    await this.runtime.closeSession(normalizedSessionId)
  }

  /** 窗口切换/关闭工程时释放该工程下的全部 Browser 页面和上下文。 */
  public async releaseProject(projectRoot: string): Promise<void> {
    const normalizedProjectRoot = normalizeProjectRoot(projectRoot)
    const bindings = [...this.bindings.values()]
      .filter((binding) => binding.projectRoot === normalizedProjectRoot)
    for (const binding of bindings) this.revokeBinding(binding)
    await Promise.all(bindings.map((binding) => this.runtime.closeSession(binding.sessionId)))
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeModState()
    for (const binding of this.bindings.values()) this.disposeGuestLifecycle(binding)
    this.bindings.clear()
    this.listeners.clear()
    this.runtime.dispose()
  }

  private createRuntimeOptions(): ElectronBrowserRuntimeOptions {
    return {
      onSessionSiteChange: (sessionId, url) => this.handleRuntimeSiteChange(sessionId, url),
      onSessionPageReady: (sessionId, url) => this.handleRuntimePageReady(sessionId, url),
      onSessionViewportChange: (sessionId) => this.handleRuntimeStateChanged(sessionId),
      onSessionClosed: (sessionId) => this.handleRuntimeClosed(sessionId),
      registerPermissionRequestHandler: (electronSession, handler) =>
        registerWorkbenchBrowserRuntimePermissionHandler(electronSession, handler),
      // 页面权限只有 pending-event 的显式处理路径可放行；所有无人管理的请求默认拒绝。
      resolvePermissionRequest: () => false,
      resolveUnmanagedPermissionRequest: () => false,
      selectWebAuthnAccount: async () => null,
    }
  }

  private bindBrowserTools(
    sessionId: string,
    projectRoot: string
  ): WorkbenchBrowserModToolDefinition[] {
    const categoryByToolName = validateBrowserManifestCoverage(ValidatedModSurface)
    return BrowserModDefinition.manifest.contributes.tools.map((contribution) => {
      const name = contribution.name
      const rawTool = ValidatedModSurface.tools[name]
      if (!rawTool) throw new AppError('INVARIANT', `Browser Mod tool payload missing: ${name}`)
      const source = rawTool as unknown as VelaTool<Record<string, unknown>>
      const categoryId = categoryByToolName.get(name)
      if (!categoryId) throw new AppError('INVARIANT', `Browser tool category missing: ${name}`)

      const createContext = (toolContext: unknown): BrowserToolContext => {
        const abortSignal = readAbortSignal(toolContext)
        return {
          abortSignal,
          browser: this.createToolBrowserApi(sessionId, projectRoot, abortSignal),
        }
      }

      const definition = {
        descriptorId: `${BrowserModId}:${source.name}`,
        registrationSignature: `${this.surfaceGeneration}:${BrowserModId}:${source.name}`,
        name: source.name,
        categoryId,
        role: source.role,
        description: source.description,
        providerId: BrowserModId,
        providerKind: 'mod',
        ...(source.usageSkillId ? { usageSkillId: source.usageSkillId } : {}),
        schema: source.schema,
        ...(source.surfaces ? { surfaces: bindToolSurfaces(source, createContext) } : {}),
        permissions: Object.freeze([...source.permissions]),
        ...(source.capabilities ? { capabilities: source.capabilities } : {}),
        ...(source.requiredModelInputModalities
          ? { requiredModelInputModalities: source.requiredModelInputModalities }
          : {}),
        ...(source.exposure ? { exposure: source.exposure } : {}),
        ...(source.outputInline === undefined ? {} : { outputInline: source.outputInline }),
        ...(source.hideWhenUnavailable === undefined
          ? {}
          : { hideWhenUnavailable: source.hideWhenUnavailable }),
        ...(source.isConcurrencySafe
          ? { isConcurrencySafe: source.isConcurrencySafe as (input: Record<string, unknown>) => boolean }
          : {}),
        ...(source.isAvailable
          ? {
              isAvailable: (toolContext: unknown) => {
                try {
                  return source.isAvailable?.(createContext(toolContext)) ?? true
                } catch {
                  return false
                }
              },
            }
          : {}),
        ...(source.unavailableReason
          ? {
              unavailableReason: (toolContext: unknown) => {
                try {
                  return source.unavailableReason?.(createContext(toolContext)) ?? null
                } catch {
                  return 'Browser Mod is disabled or the Workbench project is no longer open.'
                }
              },
            }
          : {}),
        execute: (input: unknown, toolContext: unknown) => {
          const context = createContext(toolContext)
          return source.execute(input as Record<string, unknown>, context)
        },
      } satisfies WorkbenchAgentToolDefinition
      return Object.freeze(definition)
    })
  }

  private async enterSite(
    sessionId: string,
    projectRoot: string,
    url: string,
    abortSignal: AbortSignal
  ): Promise<BrowserSiteContext> {
    this.assertExecutionAllowed(projectRoot, abortSignal)
    const binding = this.ensureBinding(sessionId, projectRoot)
    const lifecycle = binding.lifecycle = ++this.lifecycleSequence
    const surfaceGeneration = this.surfaceGeneration
    const context = createWorkbenchBrowserSiteContext(this.browserSitesRoot, url, projectRoot)
    if (this.options.ensureSiteWorkspace) {
      await this.options.ensureSiteWorkspace(context.workspaceRoot)
    } else {
      await mkdir(context.workspaceRoot, { recursive: true, mode: 0o700 })
    }
    this.assertExecutionAllowed(projectRoot, abortSignal)
    if (
      this.bindings.get(sessionId) !== binding
      || binding.lifecycle !== lifecycle
      || this.surfaceGeneration !== surfaceGeneration
    ) {
      throw new AppError('PERMISSION', 'Browser session changed while entering the site.')
    }

    this.disposeGuestLifecycle(binding)
    binding.context = context
    binding.title = null
    binding.loadState = 'unknown'
    binding.visible = false
    this.advanceStateRevision()
    return context
  }

  private async leaveSite(
    sessionId: string,
    projectRoot: string,
    abortSignal: AbortSignal
  ): Promise<void> {
    const binding: BrowserSessionBinding = this.requireActiveBinding(
      sessionId,
      projectRoot,
      abortSignal
    )
    binding.lifecycle = ++this.lifecycleSequence
    binding.context = null
    binding.title = null
    binding.loadState = 'unknown'
    binding.visible = false
    this.disposeGuestLifecycle(binding)
    this.advanceStateRevision()
    await this.runtime.closeSession(sessionId)
    this.assertExecutionAllowed(projectRoot, abortSignal)
  }

  private async runRuntimeAction<T>(
    sessionId: string,
    projectRoot: string,
    abortSignal: AbortSignal,
    action: (context: BrowserSiteContext) => Promise<T>,
    openPage: boolean
  ): Promise<T> {
    const binding = this.requireActiveBinding(sessionId, projectRoot, abortSignal)
    const lifecycle = binding.lifecycle
    const context = binding.context
    if (openPage) {
      await this.runtime.openPage(sessionId, context, abortSignal)
      this.assertBindingLease(binding, lifecycle, abortSignal)
    }
    const result = await action(context)
    this.assertBindingLease(binding, lifecycle, abortSignal)
    return result
  }

  private async runFileAction<T>(
    sessionId: string,
    projectRoot: string,
    abortSignal: AbortSignal,
    action: (context: BrowserSiteContext) => Promise<T>
  ): Promise<T> {
    const binding = this.requireActiveBinding(sessionId, projectRoot, abortSignal)
    const lifecycle = binding.lifecycle
    const result = await action(binding.context)
    this.assertBindingLease(binding, lifecycle, abortSignal)
    return result
  }

  private manageUserScripts(
    sessionId: string,
    projectRoot: string,
    request: BrowserUserScriptManageRequest,
    abortSignal: AbortSignal
  ): Promise<BrowserUserScriptMutationResult> {
    return this.runFileAction(sessionId, projectRoot, abortSignal, async (context) => {
      const manager = new BrowserUserScriptManager(createBrowserSiteWorkspaceFileAccess(context))
      if (request.action === 'list') return { overview: await manager.getOverview(context) }
      if (request.action === 'read') return manager.readScript(context, request.id)

      // Workbench 尚无持久脚本的逐项人工审批通道；所有会写入、启用或执行脚本的动作关闭失败。
      throw new AppError(
        'PERMISSION',
        'Workbench Browser does not allow persistent user-script mutations without an explicit approval channel.'
      )
    })
  }

  private requireActiveBinding(
    sessionId: string,
    projectRoot: string,
    abortSignal: AbortSignal
  ): BrowserSessionBinding & { context: BrowserSiteContext } {
    this.assertExecutionAllowed(projectRoot, abortSignal)
    const binding = this.bindings.get(sessionId)
    if (!binding) {
      throw new AppError('NOT_FOUND', 'Browser session has not entered a site.')
    }
    if (binding.projectRoot !== projectRoot) {
      throw new AppError('PERMISSION', 'Browser session belongs to another Workbench project.')
    }
    if (!binding.context) {
      throw new AppError('VALIDATION', 'Browser session has not entered a site.')
    }
    return binding as BrowserSessionBinding & { context: BrowserSiteContext }
  }

  private assertBindingLease(
    binding: BrowserSessionBinding,
    lifecycle: number,
    abortSignal: AbortSignal
  ): void {
    this.assertExecutionAllowed(binding.projectRoot, abortSignal)
    if (
      this.bindings.get(binding.sessionId) !== binding
      || binding.lifecycle !== lifecycle
      || !binding.context
    ) {
      throw new AppError('PERMISSION', 'Browser session changed while the action was running.')
    }
  }

  private assertExecutionAllowed(projectRoot: string, abortSignal: AbortSignal): void {
    this.assertNotDisposed()
    abortSignal.throwIfAborted()
    if (!this.isModEnabled()) {
      throw new AppError('PERMISSION', 'Workbench Browser Mod is disabled.')
    }
    this.assertProjectOwned(projectRoot)
  }

  private assertProjectOwned(projectRoot: string): void {
    if (!this.options.isProjectRootOwned(projectRoot)) {
      throw new AppError('PERMISSION', 'Workbench Browser project is no longer open.')
    }
  }

  private ensureBinding(sessionId: string, projectRoot: string): BrowserSessionBinding {
    const current = this.bindings.get(sessionId)
    if (current) {
      if (current.projectRoot !== projectRoot) {
        throw new AppError('PERMISSION', 'Browser session belongs to another Workbench project.')
      }
      return current
    }
    const binding: BrowserSessionBinding = {
      sessionId,
      projectRoot,
      context: null,
      title: null,
      loadState: 'unknown',
      visible: false,
      lifecycle: ++this.lifecycleSequence,
      guestLifecycle: null,
    }
    this.bindings.set(sessionId, binding)
    return binding
  }

  private isActive(sessionId: string, projectRoot: string): boolean {
    if (!this.isModEnabled() || !this.options.isProjectRootOwned(projectRoot)) return false
    const binding = this.bindings.get(sessionId)
    return binding?.projectRoot === projectRoot && !!binding.context
  }

  private readActiveContext(sessionId: string, projectRoot: string): BrowserSiteContext | null {
    if (!this.isActive(sessionId, projectRoot)) return null
    return this.bindings.get(sessionId)?.context ?? null
  }

  private resolveOwnedGuestWebContents(
    webContentsId: number,
    hostWebContentsId: number
  ): WorkbenchBrowserGuestWebContents {
    if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) {
      throw new AppError('VALIDATION', 'Browser webContents id is invalid.')
    }
    const guest = this.options.resolveGuestWebContents(webContentsId)
    if (
      !guest
      || guest.isDestroyed()
      || guest.hostWebContents?.id !== hostWebContentsId
    ) {
      throw new AppError('PERMISSION', 'Browser webview does not belong to this Workbench window.')
    }
    return guest
  }

  private createGuestLifecycle(
    binding: BrowserSessionBinding,
    guest: WorkbenchBrowserGuestWebContents
  ): BrowserGuestLifecycle {
    let disposed = false
    const handleDestroyed = (): void => {
      lifecycle.destroyed = true
      if (lifecycle.committed) this.handleGuestDestroyed(binding, lifecycle)
    }
    const handleLoadFailure = (
      _event: unknown,
      errorCode: number,
      _errorDescription: string,
      _validatedUrl: string,
      isMainFrame: boolean
    ): void => {
      if (!isMainFrame || errorCode === -3) return
      lifecycle.loadFailed = true
      if (lifecycle.committed) this.handleGuestLoadFailure(binding, lifecycle)
    }
    const lifecycle: BrowserGuestLifecycle = {
      webContentsId: guest.id,
      committed: false,
      destroyed: false,
      loadFailed: false,
      dispose: () => {
        if (disposed) return
        disposed = true
        guest.removeListener('destroyed', handleDestroyed)
        guest.removeListener('did-fail-load', handleLoadFailure)
      },
    }

    guest.on('destroyed', handleDestroyed)
    try {
      guest.on('did-fail-load', handleLoadFailure)
    } catch (error) {
      guest.removeListener('destroyed', handleDestroyed)
      throw error
    }
    return lifecycle
  }

  private handleGuestDestroyed(
    binding: BrowserSessionBinding,
    guestLifecycle: BrowserGuestLifecycle
  ): void {
    if (binding.guestLifecycle !== guestLifecycle) return
    this.disposeGuestLifecycle(binding)
    binding.lifecycle = ++this.lifecycleSequence
    binding.context = null
    binding.title = null
    binding.loadState = 'unknown'
    binding.visible = false
    this.advanceStateRevision()
    void this.runtime.closeSession(binding.sessionId).catch(() => undefined)
  }

  private handleGuestLoadFailure(
    binding: BrowserSessionBinding,
    guestLifecycle: BrowserGuestLifecycle
  ): void {
    if (binding.guestLifecycle !== guestLifecycle || !binding.context) return
    if (binding.loadState === 'error') return
    binding.loadState = 'error'
    this.advanceStateRevision()
  }

  private disposeGuestLifecycle(binding: BrowserSessionBinding): void {
    const guestLifecycle = binding.guestLifecycle
    if (!guestLifecycle) return
    binding.guestLifecycle = null
    guestLifecycle.dispose()
  }

  private handleRuntimeSiteChange(sessionId: string, url: string): void {
    const binding = this.bindings.get(sessionId)
    if (!binding?.context || !this.isModEnabled()) return
    try {
      const context = createWorkbenchBrowserSiteContext(
        this.browserSitesRoot,
        url,
        binding.projectRoot
      )
      const previous = `${binding.context.url}\0${binding.context.workspaceRoot}\0${binding.title ?? ''}\0${binding.loadState}`
      const siteChanged = binding.context.url !== context.url
        || binding.context.workspaceRoot !== context.workspaceRoot
      binding.context = context
      binding.loadState = 'unknown'
      if (siteChanged) binding.title = null
      const next = `${context.url}\0${context.workspaceRoot}\0${binding.title ?? ''}\0${binding.loadState}`
      if (previous !== next) this.advanceStateRevision()
    } catch {
      this.revokeBinding(binding)
      void this.runtime.closeSession(sessionId).catch(() => undefined)
    }
  }

  private handleRuntimePageReady(sessionId: string, url: string): void {
    this.handleRuntimeSiteChange(sessionId, url)
    void this.refreshRuntimePageState(sessionId)
  }

  private handleRuntimeStateChanged(sessionId: string): void {
    void this.refreshRuntimePageState(sessionId)
  }

  private handleRuntimeClosed(sessionId: string): void {
    const binding = this.bindings.get(sessionId)
    if (!binding || !binding.context) return
    binding.lifecycle = ++this.lifecycleSequence
    binding.context = null
    binding.title = null
    binding.loadState = 'unknown'
    binding.visible = false
    this.disposeGuestLifecycle(binding)
    this.advanceStateRevision()
  }

  private async refreshRuntimePageState(sessionId: string): Promise<void> {
    const binding = this.bindings.get(sessionId)
    if (!binding?.context || !this.isModEnabled()) return
    const lifecycle = binding.lifecycle
    let state
    try {
      state = await this.runtime.getPageState(sessionId, binding.context)
    } catch {
      // WebContents 可能在回调与查询之间被关闭；close 回调或下一次状态变更会完成收敛。
      return
    }
    if (
      this.bindings.get(sessionId) !== binding
      || binding.lifecycle !== lifecycle
      || !binding.context
      || !this.isModEnabled()
    ) return

    const previous = `${binding.context.url}\0${binding.title ?? ''}\0${binding.loadState}`
    try {
      const nextContext = createWorkbenchBrowserSiteContext(
        this.browserSitesRoot,
        state.url || binding.context.url,
        binding.projectRoot
      )
      binding.context = nextContext
      binding.title = state.title || null
      binding.loadState = state.loadState
      const next = `${nextContext.url}\0${binding.title ?? ''}\0${binding.loadState}`
      if (previous !== next) this.advanceStateRevision()
    } catch {
      this.revokeBinding(binding)
      void this.runtime.closeSession(sessionId).catch(() => undefined)
    }
  }

  private applyWindowState(binding: BrowserSessionBinding, state: BrowserPageWindowState): void {
    if (!binding.context) return
    const previous = `${binding.context.url}\0${binding.title ?? ''}\0${binding.loadState}\0${binding.visible}`
    if (state.url) {
      binding.context = createWorkbenchBrowserSiteContext(
        this.browserSitesRoot,
        state.url,
        binding.projectRoot
      )
    }
    binding.title = state.title
    binding.loadState = state.active && state.url ? 'loaded' : 'unknown'
    binding.visible = state.visible
    const next = `${binding.context.url}\0${binding.title ?? ''}\0${binding.loadState}\0${binding.visible}`
    if (previous !== next) this.advanceStateRevision()
  }

  private revokeBinding(binding: BrowserSessionBinding): void {
    if (this.bindings.get(binding.sessionId) !== binding) return
    binding.lifecycle = ++this.lifecycleSequence
    this.disposeGuestLifecycle(binding)
    this.bindings.delete(binding.sessionId)
    this.advanceStateRevision()
  }

  private revokeAllSessions(): void {
    if (this.bindings.size === 0) {
      this.runtime.closeAllSessions()
      this.advanceStateRevision()
      return
    }
    for (const binding of this.bindings.values()) {
      binding.lifecycle = ++this.lifecycleSequence
      this.disposeGuestLifecycle(binding)
    }
    this.bindings.clear()
    this.runtime.closeAllSessions()
    this.advanceStateRevision()
  }

  private isModEnabled(): boolean {
    return !this.disposed && this.browserModEnabled
  }

  private advanceStateRevision(): void {
    this.stateRevision += 1
    const event = Object.freeze({ generation: this.stateRevision })
    for (const listener of this.listeners) listener(event)
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new AppError('VALIDATION', 'Workbench Browser host is disposed.')
  }
}

function validateBrowserManifestCoverage(
  surface: AgentModSurfaceSnapshot
): Map<string, BrowserToolCategoryId> {
  const actualNames = BrowserModDefinition.manifest.contributes.tools.map(({ name }) => name)
  const categoryByToolName = new Map<string, BrowserToolCategoryId>()
  for (const name of actualNames) {
    const categoryId = surface.toolCategoryByName[name]
    if (!isBrowserToolCategoryId(categoryId)) {
      throw new AppError('INVARIANT', `Browser Mod category projection missing: ${name}`)
    }
    if (categoryByToolName.has(name)) {
      throw new AppError('INVARIANT', `Duplicate Browser Mod tool: ${name}`)
    }
    categoryByToolName.set(name, categoryId)
  }
  if (
    categoryByToolName.size !== actualNames.length
    || actualNames.some((name) => !surface.tools[name])
  ) {
    throw new AppError('INVARIANT', 'Browser Mod surface does not cover its manifest tools.')
  }
  return categoryByToolName
}

/**
 * Project + Browser 一起进标准 Loader，Browser 的 project-space 客居声明才能被完整解析。
 * 返回面随后只投影 Browser-owned 工具，Project 工具仍由 Workbench Project provider 注入，
 * 因而不会重复注册。
 */
function createValidatedModSurface(): AgentModSurfaceSnapshot {
  const loader = new AgentModLoader({
    host: {
      hostId: 'workbench',
      velarosVersion: '0.6.0',
      agentApiVersion: '0.6.8',
      supportedAxes: ['tools', 'toolCategories', 'spaces'],
      allowedTrustLevels: ['bundled-official'],
    },
  })
  const report = loader.load([
    {
      source: 'bundled',
      origin: ProjectModDefinition.specifier,
      manifest: ProjectModDefinition.manifest,
      bindings: ProjectModDefinition.bindings,
    },
    {
      source: 'bundled',
      origin: BrowserModDefinition.specifier,
      manifest: BrowserModDefinition.manifest,
      bindings: BrowserModDefinition.bindings,
    },
  ])
  if (report.rejected.length > 0) {
    const diagnostics = report.rejected
      .flatMap((rejection) => rejection.diagnostics.map((diagnostic) => diagnostic.message))
      .join('; ')
    throw new AppError('INVARIANT', `Workbench Browser Mod failed validation: ${diagnostics}`)
  }

  const surface = createAgentModSurfaceSnapshot(loader.snapshot())
  const projectSpace = surface.spaces.find((space) => space.id === 'project')
  const browserCategoryIds = new Set(
    BrowserModDefinition.manifest.contributes.toolCategories.map(({ id }) => id)
  )
  if (
    !projectSpace
    || [...browserCategoryIds].some((categoryId) =>
      !projectSpace.toolCategoryIds?.includes(categoryId))
  ) {
    throw new AppError('INVARIANT', 'Browser Mod is not projected into the project space.')
  }
  validateBrowserManifestCoverage(surface)
  return surface
}

function isBrowserToolCategoryId(value: string | undefined): value is BrowserToolCategoryId {
  return value !== undefined
    && Object.prototype.hasOwnProperty.call(BrowserModDefinition.bindings.toolCategories, value)
}

function projectValidatedBrowserCategories(
  surface: AgentModSurfaceSnapshot
): Readonly<Record<BrowserToolCategoryId, ToolCategoryDefinition>> {
  return Object.freeze(Object.fromEntries(
    BrowserModDefinition.manifest.contributes.toolCategories.map(({ id }) => {
      const category = surface.toolCategories[id]
      if (!category) throw new AppError('INVARIANT', `Browser Mod category payload missing: ${id}`)
      return [id, category]
    })
  )) as Readonly<Record<BrowserToolCategoryId, ToolCategoryDefinition>>
}

function bindToolSurfaces(
  source: VelaTool<Record<string, unknown>>,
  createContext: (toolContext: unknown) => BrowserToolContext
): WorkbenchAgentToolDefinition['surfaces'] {
  const result: Record<string, WorkbenchAgentToolSurfaceDefinition> = {}
  for (const [profileId, surface] of Object.entries(source.surfaces ?? {})) {
    if (!surface) continue
    result[profileId] = {
      description: surface.description,
      schema: surface.schema,
      ...(surface.normalize
        ? {
            normalize: (input, toolContext) =>
              surface.normalize?.(input, createContext(toolContext)) ?? input,
          }
        : {}),
    }
  }
  return result
}

/** 按站点（公网主域名；本机 host+port）在 dataRoot 下生成稳定、不可越界的私有根。 */
export function createWorkbenchBrowserSiteContext(
  browserSitesRoot: string,
  rawUrl: string,
  projectRoot: string
): BrowserSiteContext {
  const resolvedUrl = rawUrl.trim() === 'about:blank'
    ? 'about:blank'
    : resolveBrowserSearchOrNavigationInput(rawUrl)
  const normalizedUrl = resolvedUrl
    ? normalizeWorkbenchBrowserPageUrl(resolvedUrl, { allowAboutBlank: false })
    : null
  if (!normalizedUrl || hasControlCharacter(normalizedUrl)) {
    throw new AppError(
      'VALIDATION',
      'Workbench Browser only accepts credential-free HTTP URLs.'
    )
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(normalizedUrl)
  } catch (error) {
    throw new AppError('VALIDATION', 'Browser URL is invalid.', error)
  }
  if (
    (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:')
    || !parsedUrl.hostname
    || parsedUrl.username
    || parsedUrl.password
  ) {
    throw new AppError('VALIDATION', 'Workbench Browser only accepts credential-free HTTP URLs.')
  }

  const siteKey = createBrowserSiteKey(parsedUrl)
  const digest = createHash('sha256').update(siteKey).digest('hex').slice(0, 12)
  const readable = siteKey
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 48) || 'site'
  const workspaceRoot = resolve(browserSitesRoot, `${readable}-${digest}`)
  const normalizedProjectRoot = normalizeProjectRoot(projectRoot)
  if (isSameOrChildPath(normalizedProjectRoot, workspaceRoot)) {
    throw new AppError('PERMISSION', 'Browser workspace cannot be stored inside the project root.')
  }

  return Object.freeze({ url: parsedUrl.toString(), workspaceRoot })
}

function normalizeBrowserNavigationOptions(
  options: BrowserPageNavigationOptions
): BrowserPageNavigationOptions {
  if (options.action !== 'goto') return options
  if (typeof options.url !== 'string') {
    throw new AppError('VALIDATION', 'Browser goto navigation requires a URL.')
  }
  const resolvedUrl = options.url.trim() === 'about:blank'
    ? 'about:blank'
    : resolveBrowserSearchOrNavigationInput(options.url)
  const normalizedUrl = resolvedUrl ? normalizeWorkbenchBrowserPageUrl(resolvedUrl) : null
  if (!normalizedUrl) {
    throw new AppError(
      'VALIDATION',
      'Workbench Browser navigation only accepts HTTP, HTTPS, or about:blank URLs.'
    )
  }
  return { ...options, url: normalizedUrl }
}

function createBrowserSiteKey(url: URL): string {
  if (isLocalBrowserUrl(url)) return `local://${url.host.toLowerCase()}`
  const siteHost = getBrowserSiteHost(url.hostname)
  if (!siteHost) throw new AppError('VALIDATION', 'Browser URL does not identify a site.')
  return `site://${siteHost}${url.port ? `:${url.port}` : ''}`
}

function isSameOrChildPath(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

function normalizeSessionId(sessionId: string): string {
  if (
    typeof sessionId !== 'string'
    || !sessionId
    || sessionId.length > MaximumSessionIdLength
    || sessionId.trim() !== sessionId
    || hasControlCharacter(sessionId)
  ) {
    throw new AppError('VALIDATION', 'Workbench Browser session id is invalid.')
  }
  return sessionId
}

function normalizeProjectRoot(projectRoot: string): string {
  if (
    typeof projectRoot !== 'string'
    || !projectRoot
    || projectRoot.trim() !== projectRoot
    || !isAbsolute(projectRoot)
    || hasControlCharacter(projectRoot)
  ) {
    throw new AppError('VALIDATION', 'Workbench Browser project root is invalid.')
  }
  return resolve(projectRoot)
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0
    return point <= 0x1f || point === 0x7f
  })
}

function readAbortSignal(toolContext: unknown): AbortSignal {
  if (!toolContext || typeof toolContext !== 'object') return DefaultAbortSignal
  const value = (toolContext as { abortSignal?: unknown }).abortSignal
  if (
    value
    && typeof value === 'object'
    && typeof (value as AbortSignal).aborted === 'boolean'
    && typeof (value as AbortSignal).throwIfAborted === 'function'
  ) return value as AbortSignal
  return DefaultAbortSignal
}

function emptyModSurfaceSnapshot(generation: number): WorkbenchBrowserModSurfaceSnapshot {
  return Object.freeze({
    generation,
    enabled: false,
    tools: Object.freeze([]),
    categoryDefinitions: Object.freeze({}) as Readonly<
      Record<BrowserToolCategoryId, ToolCategoryDefinition>
    >,
    enabledCategoryIds: Object.freeze([]),
    residentCategoryIds: Object.freeze([]),
    initialVisibleToolNames: Object.freeze([]),
  })
}

export type {
  WorkbenchBrowserGuestWebContents,
  WorkbenchBrowserModStatePort,
  WorkbenchBrowserModSurfaceSnapshot,
  WorkbenchBrowserModToolDefinition,
  WorkbenchBrowserToolHostOptions,
}
