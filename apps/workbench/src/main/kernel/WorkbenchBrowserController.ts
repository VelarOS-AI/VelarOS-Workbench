import { randomUUID } from 'node:crypto'

import type {
  BrowserElementSelection,
  BrowserSiteContext,
} from '@velaros-ai/browser/core'
import type { ElectronBrowserRuntime } from '@velaros-ai/browser/runtime'
import { AppError } from '@velaros-ai/core/error'

interface BrowserSessionBinding {
  agentSessionId: string
  context: BrowserSiteContext
}

/**
 * Product-owned semantic adapter around the injected Browser Runtime.
 *
 * The controller only owns Agent/session bindings and typed selection parsing;
 * page lifecycle and interaction remain inside the published Browser owner.
 */
export class WorkbenchBrowserController {
  private readonly bindings = new Map<string, BrowserSessionBinding>()

  public constructor(
    public readonly runtime: ElectronBrowserRuntime,
    private readonly isWorkspaceRootAllowed: (projectRoot: string) => boolean
  ) {}

  public async create(input: unknown, signal?: AbortSignal): Promise<unknown> {
    const parsed = parseBrowserSessionInput(input)
    this.assertWorkspaceRootAllowed(parsed.projectRoot)
    const context = { url: parsed.url, workspaceRoot: parsed.projectRoot }
    const state = await this.runtime.launchBackgroundBrowserPage(
      parsed.browserSessionId,
      context,
      { url: parsed.url },
      signal
    )
    this.bindings.set(parsed.browserSessionId, {
      agentSessionId: parsed.agentSessionId,
      context,
    })
    return {
      browserSessionId: parsed.browserSessionId,
      agentSessionId: parsed.agentSessionId,
      state,
    }
  }

  public async open(input: unknown, signal?: AbortSignal): Promise<unknown> {
    const parsed = parseBrowserSessionInput(input)
    this.assertWorkspaceRootAllowed(parsed.projectRoot)
    const existing = this.bindings.get(parsed.browserSessionId)
    if (!existing) return this.create(parsed, signal)
    if (
      existing.agentSessionId !== parsed.agentSessionId
      || existing.context.workspaceRoot !== parsed.projectRoot
    ) {
      throw new AppError(
        'PERMISSION',
        `Browser session "${parsed.browserSessionId}" belongs to a different Agent session.`
      )
    }
    const context = { ...existing.context, url: parsed.url }
    await this.runtime.openPage(parsed.browserSessionId, context, signal)
    this.bindings.set(parsed.browserSessionId, { ...existing, context })
    return {
      browserSessionId: parsed.browserSessionId,
      agentSessionId: existing.agentSessionId,
      state: await this.runtime.getPageState(parsed.browserSessionId, context, signal),
    }
  }

  public async navigate(input: unknown, signal?: AbortSignal): Promise<unknown> {
    const record = requireRecord(input, 'Browser navigate input must be an object.')
    const browserSessionId = requireNonBlankString(
      record.browserSessionId,
      'browserSessionId is required.'
    )
    const binding = this.requireBinding(browserSessionId, record.agentSessionId)
    const action =
      record.action === 'back'
      || record.action === 'forward'
      || record.action === 'reload'
      || record.action === 'goto'
        ? record.action
        : 'goto'
    const url = typeof record.url === 'string' ? record.url.trim() : undefined
    const result = await this.runtime.navigatePage(
      browserSessionId,
      binding.context,
      { action, ...(url ? { url } : {}) },
      signal
    )
    binding.context = { ...binding.context, url: result.url }
    return result
  }

  public inspect(input: unknown, signal?: AbortSignal): Promise<unknown> {
    const record = requireRecord(input, 'Browser inspect input must be an object.')
    const browserSessionId = requireNonBlankString(
      record.browserSessionId,
      'browserSessionId is required.'
    )
    const binding = this.requireBinding(browserSessionId, record.agentSessionId)
    return this.runtime.inspectPage(
      browserSessionId,
      binding.context,
      { includeHtml: false },
      signal
    )
  }

  public input(input: unknown, signal?: AbortSignal): Promise<unknown> {
    const record = requireRecord(input, 'Browser input must be an object.')
    const browserSessionId = requireNonBlankString(
      record.browserSessionId,
      'browserSessionId is required.'
    )
    const text = requireString(record.text, 'text must be a string.')
    const binding = this.requireBinding(browserSessionId, record.agentSessionId)
    return this.runtime.typeText(browserSessionId, binding.context, { text }, signal)
  }

  public async selection(
    input: unknown,
    signal?: AbortSignal
  ): Promise<BrowserElementSelection> {
    const record = requireRecord(input, 'Browser selection input must be an object.')
    const browserSessionId = requireNonBlankString(
      record.browserSessionId,
      'browserSessionId is required.'
    )
    const selector = requireNonBlankString(record.selector, 'selector is required.')
    const binding = this.requireBinding(browserSessionId, record.agentSessionId)
    const result = await this.runtime.evaluateScript(
      browserSessionId,
      binding.context,
      {
        mode: 'expression',
        script: createElementSelectionScript(selector),
        maxResultChars: 50_000,
      },
      signal
    )
    return parseBrowserElementSelection(result.result)
  }

  public async close(input: unknown): Promise<unknown> {
    const browserSessionId = readBrowserSessionId(input)
    await this.runtime.closeSession(browserSessionId)
    this.bindings.delete(browserSessionId)
    return { browserSessionId, closed: true }
  }

  public closeAll(): { closed: true } {
    this.runtime.closeAllSessions()
    this.bindings.clear()
    return { closed: true }
  }

  private requireBinding(
    browserSessionId: string,
    agentSessionId: unknown = undefined
  ): BrowserSessionBinding {
    const binding = this.bindings.get(browserSessionId)
    if (!binding) {
      throw new AppError(
        'NOT_FOUND',
        `Browser session "${browserSessionId}" is not attached to a Workbench Agent session.`
      )
    }
    if (
      agentSessionId !== undefined
      && (
        typeof agentSessionId !== 'string'
        || agentSessionId.trim() !== binding.agentSessionId
      )
    ) {
      throw new AppError(
        'PERMISSION',
        `Browser session "${browserSessionId}" belongs to a different Agent session.`
      )
    }
    return binding
  }

  private assertWorkspaceRootAllowed(projectRoot: string): void {
    if (!this.isWorkspaceRootAllowed(projectRoot)) {
      throw new AppError(
        'PERMISSION',
        `Workspace root "${projectRoot}" is not active in Workbench.`
      )
    }
  }
}

function parseBrowserSessionInput(input: unknown): {
  agentSessionId: string
  browserSessionId: string
  projectRoot: string
  url: string
} {
  const record = requireRecord(input, 'Browser session input must be an object.')
  return {
    agentSessionId: requireNonBlankString(record.agentSessionId, 'agentSessionId is required.'),
    browserSessionId: requireNonBlankString(
      record.browserSessionId,
      'browserSessionId is required.'
    ),
    projectRoot: requireNonBlankString(record.projectRoot, 'projectRoot is required.'),
    url: requireNonBlankString(record.url, 'url is required.'),
  }
}

function readBrowserSessionId(input: unknown): string {
  const record = requireRecord(input, 'Browser session input must be an object.')
  return requireNonBlankString(record.browserSessionId, 'browserSessionId is required.')
}

function createElementSelectionScript(selector: string): string {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('Element not found');
    const rect = element.getBoundingClientRect();
    const attributes = Object.fromEntries(Array.from(element.attributes).map((item) => [item.name, item.value]));
    const text = (element.textContent || '').trim().slice(0, 4000);
    return {
      id: ${JSON.stringify(`workbench-selection-${randomUUID()}`)},
      url: location.href,
      title: document.title,
      label: element.getAttribute('aria-label') || text || element.tagName.toLowerCase(),
      tagName: element.tagName.toLowerCase(),
      role: element.getAttribute('role'),
      text,
      selector: ${JSON.stringify(selector)},
      attributes,
      rect: {
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        centerX: rect.x + rect.width / 2, centerY: rect.y + rect.height / 2
      },
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      target: null,
      capturedAt: Date.now()
    };
  })()`
}

function parseBrowserElementSelection(input: unknown): BrowserElementSelection {
  const record = requireRecord(input, 'Browser selection result is invalid.')
  const rect = requireRecord(record.rect, 'Browser selection rect is invalid.')
  return {
    id: requireNonBlankString(record.id, 'Browser selection id is invalid.'),
    url: requireNonBlankString(record.url, 'Browser selection URL is invalid.'),
    title: requireString(record.title, 'Browser selection title is invalid.'),
    label: requireString(record.label, 'Browser selection label is invalid.'),
    tagName: requireNonBlankString(record.tagName, 'Browser selection tag is invalid.'),
    role: typeof record.role === 'string' ? record.role : null,
    text: requireString(record.text, 'Browser selection text is invalid.'),
    selector: typeof record.selector === 'string' ? record.selector : null,
    attributes: requireRecord(record.attributes, 'Browser selection attributes are invalid.') as
      Record<string, string>,
    rect: {
      x: requireNumber(rect.x),
      y: requireNumber(rect.y),
      width: requireNumber(rect.width),
      height: requireNumber(rect.height),
      centerX: requireNumber(rect.centerX),
      centerY: requireNumber(rect.centerY),
    },
    viewportWidth: requireNumber(record.viewportWidth),
    viewportHeight: requireNumber(record.viewportHeight),
    target: null,
    capturedAt: requireNumber(record.capturedAt),
  }
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('VALIDATION', message)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string') throw new AppError('VALIDATION', message)
  return value
}

function requireNonBlankString(value: unknown, message: string): string {
  const result = requireString(value, message).trim()
  if (!result) throw new AppError('VALIDATION', message)
  return result
}

function requireNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AppError('VALIDATION', 'Browser selection number is invalid.')
  }
  return value
}
