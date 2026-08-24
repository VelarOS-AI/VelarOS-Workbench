import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'

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

const NeverCancelledToken: MarkdownCancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: (() => ({ dispose() {} })) as MarkdownCancellationToken['onCancellationRequested'],
}

function noOpWorkspaceEvent<T>(): (listener: (event: T) => unknown) => { dispose(): void } {
  return () => ({ dispose() {} })
}

function isMarkdownPath(path: string): boolean {
  return MarkdownExtensions.has(extname(path).toLowerCase())
}

function isInsideRoot(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === '' || (!child.startsWith('..') && !isAbsolute(child))
}

class WorkbenchMarkdownWorkspace implements IWorkspace {
  public readonly workspaceFolders: readonly URI[]
  public readonly onDidChangeMarkdownDocument = noOpWorkspaceEvent<ITextDocument>()
  public readonly onDidCreateMarkdownDocument = noOpWorkspaceEvent<ITextDocument>()
  public readonly onDidDeleteMarkdownDocument = noOpWorkspaceEvent<URI>()

  private readonly overlays = new Map<string, TextDocument>()

  public constructor(private readonly projectRoot: string) {
    this.workspaceFolders = [URI.file(projectRoot)]
  }

  public setOverlay(absolutePath: string, content: string): TextDocument {
    const uri = URI.file(absolutePath).toString()
    const current = this.overlays.get(uri)
    const document = TextDocument.create(uri, 'markdown', (current?.version ?? 0) + 1, content)
    this.overlays.set(uri, document)
    return document
  }

  public async getAllMarkdownDocuments(): Promise<Iterable<ITextDocument>> {
    const documents = new Map<string, ITextDocument>(this.overlays)
    for (const absolutePath of await this.collectMarkdownFiles(this.projectRoot)) {
      const uri = URI.file(absolutePath).toString()
      if (documents.has(uri)) continue
      const document = await this.openMarkdownDocument(URI.file(absolutePath))
      if (document) documents.set(uri, document)
    }
    return documents.values()
  }

  public hasMarkdownDocument(resource: URI): boolean {
    const absolutePath = this.absolutePath(resource)
    return !!absolutePath && isMarkdownPath(absolutePath) && (this.overlays.has(resource.toString()) || existsSync(absolutePath))
  }

  public async openMarkdownDocument(resource: URI): Promise<ITextDocument | undefined> {
    const absolutePath = this.absolutePath(resource)
    if (!absolutePath || !isMarkdownPath(absolutePath)) return undefined

    const uri = URI.file(absolutePath).toString()
    const overlay = this.overlays.get(uri)
    if (overlay) return overlay

    try {
      const document = TextDocument.create(uri, 'markdown', 0, await readFile(absolutePath, 'utf8'))
      this.overlays.set(uri, document)
      return document
    } catch {
      return undefined
    }
  }

  public async stat(resource: URI): Promise<{ isDirectory: boolean } | undefined> {
    const absolutePath = this.absolutePath(resource)
    if (!absolutePath) return undefined
    try {
      const metadata = await stat(absolutePath)
      return { isDirectory: metadata.isDirectory() }
    } catch {
      return undefined
    }
  }

  public async readDirectory(
    resource: URI
  ): Promise<Iterable<readonly [string, { isDirectory: boolean }]>> {
    const absolutePath = this.absolutePath(resource)
    if (!absolutePath) return []
    try {
      const entries = await readdir(absolutePath, { withFileTypes: true })
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
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return []
    }

    const files: string[] = []
    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        if (!IgnoredWorkspaceDirectories.has(entry.name)) {
          files.push(...(await this.collectMarkdownFiles(absolutePath)))
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
  const workspace = new WorkbenchMarkdownWorkspace(options.projectRoot)
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
      return markdown.parse(source.getText(), {}) as unknown as Token[]
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

  try {
    return await run({
      document,
      service,
      token: NeverCancelledToken,
      toProjectRelativePath: (resource) => {
        if (resource.scheme !== 'file') return null
        const absolutePath = resolve(resource.fsPath)
        return isInsideRoot(options.projectRoot, absolutePath)
          ? relative(options.projectRoot, absolutePath).replaceAll('\\', '/')
          : null
      },
    })
  } finally {
    service.dispose()
  }
}
