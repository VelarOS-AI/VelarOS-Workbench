import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'

import MarkdownIt from 'markdown-it'
import { TextDocument } from 'vscode-languageserver-textdocument'
import {
  createLanguageService,
  githubSlugifier,
  type IMdLanguageService,
  type IMdParser,
  type ITextDocument,
  type IWorkspace,
  LogLevel,
  type Token,
} from 'vscode-markdown-languageservice'
import { URI } from 'vscode-uri'

import { AppError } from '@velaros-ai/velaros/core/error'

import { workbenchMainText } from '../../i18n/workbenchMainMessages'
import { isRelativePathInsideRoot } from '../PathContainmentHelper'

const MarkdownExtensions = new Set(['.md', '.markdown', '.mdown'])
const IgnoredWorkspaceDirectories = new Set([
  '.data',
  '.git',
  'build',
  'dist',
  'node_modules',
  'out',
  'release',
])

type MarkdownCancellationToken = Parameters<IMdLanguageService['getDocumentSymbols']>[2]

function noOpWorkspaceEvent<T>(): (listener: (event: T) => unknown) => { dispose(): void } {
  return () => ({ dispose() {} })
}

function isMarkdownPath(path: string): boolean {
  return MarkdownExtensions.has(extname(path).toLowerCase())
}

function isInsideRoot(root: string, path: string): boolean {
  return isRelativePathInsideRoot(relative(root, path))
}

class WorkbenchMarkdownWorkspace implements IWorkspace {
  public readonly workspaceFolders: readonly URI[]
  public readonly onDidChangeMarkdownDocument = noOpWorkspaceEvent<ITextDocument>()
  public readonly onDidCreateMarkdownDocument = noOpWorkspaceEvent<ITextDocument>()
  public readonly onDidDeleteMarkdownDocument = noOpWorkspaceEvent<URI>()

  private readonly overlays = new Map<string, TextDocument>()

  public constructor(
    private readonly projectRoot: string,
    private readonly signal?: AbortSignal
  ) {
    this.workspaceFolders = [URI.file(projectRoot)]
  }

  private get cancelled(): boolean {
    return this.signal?.aborted ?? false
  }

  public setOverlay(absolutePath: string, content: string): TextDocument {
    const uri = URI.file(absolutePath).toString()
    const current = this.overlays.get(uri)
    const document = TextDocument.create(uri, 'markdown', (current?.version ?? 0) + 1, content)
    this.overlays.set(uri, document)
    return document
  }

  public async getAllMarkdownDocuments(): Promise<Iterable<ITextDocument>> {
    if (this.cancelled) return []
    const documents = new Map<string, ITextDocument>(this.overlays)
    const files = await this.collectMarkdownFiles(this.projectRoot)
    if (this.cancelled) return []
    for (const absolutePath of files) {
      if (this.cancelled) return []
      const uri = URI.file(absolutePath).toString()
      if (documents.has(uri)) continue
      const document = await this.openMarkdownDocument(URI.file(absolutePath))
      if (this.cancelled) return []
      if (document) documents.set(uri, document)
    }
    return documents.values()
  }

  public hasMarkdownDocument(resource: URI): boolean {
    if (this.cancelled) return false
    const absolutePath = this.absolutePath(resource)
    return !!absolutePath && isMarkdownPath(absolutePath) && (this.overlays.has(resource.toString()) || existsSync(absolutePath))
  }

  public async openMarkdownDocument(resource: URI): Promise<ITextDocument | undefined> {
    // SDK caches attach a detached finally to this promise; cancellation must resolve as missing.
    if (this.cancelled) return undefined
    const absolutePath = this.absolutePath(resource)
    if (!absolutePath || !isMarkdownPath(absolutePath)) return undefined

    const uri = URI.file(absolutePath).toString()
    const overlay = this.overlays.get(uri)
    if (overlay) return overlay

    try {
      const content = await readFile(absolutePath, { encoding: 'utf8', signal: this.signal })
      if (this.cancelled) return undefined
      const document = TextDocument.create(uri, 'markdown', 0, content)
      this.overlays.set(uri, document)
      return document
    } catch {
      return undefined
    }
  }

  public async stat(resource: URI): Promise<{ isDirectory: boolean } | undefined> {
    if (this.cancelled) return undefined
    const absolutePath = this.absolutePath(resource)
    if (!absolutePath) return undefined
    try {
      const metadata = await stat(absolutePath)
      if (this.cancelled) return undefined
      return { isDirectory: metadata.isDirectory() }
    } catch {
      return undefined
    }
  }

  public async readDirectory(
    resource: URI
  ): Promise<Iterable<readonly [string, { isDirectory: boolean }]>> {
    if (this.cancelled) return []
    const absolutePath = this.absolutePath(resource)
    if (!absolutePath) return []
    try {
      const entries = await readdir(absolutePath, { withFileTypes: true })
      if (this.cancelled) return []
      return entries.map((entry) => [entry.name, { isDirectory: entry.isDirectory() }] as const)
    } catch {
      return []
    }
  }

  private absolutePath(resource: URI): string | null {
    if (resource.scheme !== 'file') return null
    const absolutePath = resolve(resource.fsPath)
    return isInsideRoot(this.projectRoot, absolutePath) ? absolutePath : null
  }

  private async collectMarkdownFiles(directory: string): Promise<string[]> {
    if (this.cancelled) return []
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return []
    }
    if (this.cancelled) return []

    const files: string[] = []
    for (const entry of entries) {
      if (this.cancelled) return []
      const absolutePath = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        if (!IgnoredWorkspaceDirectories.has(entry.name)) {
          files.push(...(await this.collectMarkdownFiles(absolutePath)))
          if (this.cancelled) return []
        }
      } else if (entry.isFile() && isMarkdownPath(entry.name)) {
        files.push(absolutePath)
      }
    }
    return files
  }
}

export interface WorkbenchMarkdownLanguageServiceContext {
  document: TextDocument
  service: IMdLanguageService
  token: MarkdownCancellationToken
  toProjectRelativePath: (resource: URI) => string | null
}

interface WorkbenchMarkdownLanguageServiceOptions {
  projectRoot: string
  absolutePath: string
  content: string
  openFiles?: ReadonlyArray<{ absolutePath: string; content: string }>
  signal?: AbortSignal
}

/**
 * Runs one request through Microsoft's reusable Markdown language service.
 * The workspace is request-scoped so unsaved buffers are authoritative and no
 * language-service cache can outlive a Workbench project window.
 */
export async function withWorkbenchMarkdownLanguageService<T>(
  options: WorkbenchMarkdownLanguageServiceOptions,
  run: (context: WorkbenchMarkdownLanguageServiceContext) => Promise<T>
): Promise<T> {
  const { signal } = options
  const throwIfCancelled = (): void => {
    if (signal?.aborted)
      throw new AppError('CANCELLED', workbenchMainText('language.requestCancelledPlain'))
  }
  throwIfCancelled()
  const workspace = new WorkbenchMarkdownWorkspace(options.projectRoot, signal)
  for (const file of options.openFiles ?? []) {
    if (isInsideRoot(options.projectRoot, file.absolutePath) && isMarkdownPath(file.absolutePath)) {
      workspace.setOverlay(file.absolutePath, file.content)
    }
  }
  const document = workspace.setOverlay(options.absolutePath, options.content)
  const markdown = new MarkdownIt('commonmark', { html: false, linkify: true })
  const parser: IMdParser = {
    slugifier: githubSlugifier,
    async tokenize(source): Promise<Token[]> {
      if (signal?.aborted) return []
      const tokens = markdown.parse(source.getText(), {}) as unknown as Token[]
      return signal?.aborted ? [] : tokens
    },
  }
  const service = createLanguageService({
    workspace,
    parser,
    logger: {
      level: LogLevel.Off,
      log() {},
    },
    markdownFileExtensions: ['md', 'markdown', 'mdown'],
  })
  const subscriptions = new Set<() => void>()
  const token: MarkdownCancellationToken = {
    get isCancellationRequested() {
      return signal?.aborted ?? false
    },
    onCancellationRequested(listener, thisArgs, disposables) {
      const onAbort = (): void => {
        listener.call(thisArgs, undefined)
      }
      const dispose = (): void => {
        signal?.removeEventListener('abort', onAbort)
        subscriptions.delete(dispose)
      }
      const subscription = { dispose }
      subscriptions.add(dispose)
      if (signal?.aborted)
        queueMicrotask(() => {
          if (subscriptions.has(dispose)) onAbort()
        })
      else signal?.addEventListener('abort', onAbort, { once: true })
      disposables?.push(subscription)
      return subscription
    },
  }

  try {
    const result = await run({
      document,
      service,
      token,
      toProjectRelativePath: (resource) => {
        if (resource.scheme !== 'file') return null
        const absolutePath = resolve(resource.fsPath)
        return isInsideRoot(options.projectRoot, absolutePath)
          ? relative(options.projectRoot, absolutePath).replaceAll('\\', '/')
          : null
      },
    })
    throwIfCancelled()
    return result
  } catch (error) {
    throwIfCancelled()
    throw error
  } finally {
    try {
      service.dispose()
    } finally {
      for (const dispose of subscriptions) dispose()
    }
  }
}
