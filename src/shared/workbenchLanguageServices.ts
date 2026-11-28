import { toNullable } from '@velaros-ai/velaros/core'

export type WorkbenchLanguageServiceInstallKind = 'builtin'

const LspCompletionKinds: Partial<Record<number, string>> = {
  1: 'text', 2: 'method', 3: 'function', 4: 'constructor', 5: 'property',
  6: 'variable', 7: 'class', 8: 'interface', 9: 'namespace', 10: 'property',
  11: 'type', 12: 'value', 13: 'enum', 14: 'keyword', 15: 'snippet',
  16: 'color', 17: 'file', 18: 'file', 19: 'folder', 20: 'enum-member',
  21: 'constant', 22: 'class', 23: 'event', 24: 'operator', 25: 'type',
}

export function workbenchLspCompletionKind(kind: number | undefined): string | undefined {
  return kind === undefined ? undefined : LspCompletionKinds[kind]
}

export type WorkbenchLanguageServiceRuntime =
  | 'typescript-language-service'
  | 'html-language-service'
  | 'css-language-service'
  | 'markdown-language-service'
  | 'python-language-server'
  | 'lsp-server'

export interface WorkbenchLanguageServiceDescriptor {
  id: string
  label: string
  installKind: WorkbenchLanguageServiceInstallKind
  runtime: WorkbenchLanguageServiceRuntime
  extensions: string[]
  languages: string[]
  packageName?: string
  command?: string
  commandAlternatives?: readonly string[]
  /** App-owned Node entry; project/PATH lookup remains the development fallback. */
  bundledNodeModule?: string
  initializationOptions?: Record<string, unknown>
  /** Supply the app-owned TypeScript SDK to standalone TypeScript-based servers. */
  initializationTypeScriptSdk?: boolean
  initializeTimeoutMs?: number
  diagnosticMode?: 'pull' | 'push'
  /** Project-local package bin executed with Workbench's own Node-compatible runtime. */
  projectNodePackageBin?: string
  /** Files that establish the nearest runtime root for a document inside a workspace. */
  projectRootMarkers?: readonly string[]
  args?: string[]
  documentLanguageId?: string
  documentLanguageIds?: Readonly<Record<string, string>>
  protocol?: WorkbenchLanguageServerProtocolContract
  extensionRequests?: readonly WorkbenchLanguageServiceExtensionRequestDescriptor[]
  hover?: {
    /** Words whose language-server documentation is intentionally not shown as editor hover. */
    suppressWords: readonly string[]
  }
}

/**
 * Optional compatibility gate owned by a language contribution. The generic
 * LSP host only follows the declared initialize-result path; it never knows a
 * language-specific capability name.
 */
export interface WorkbenchLanguageServerProtocolContract {
  capabilityPath: string[]
  version: number
}

export interface WorkbenchLanguageServiceExtensionRequestDescriptor {
  /** Stable contribution-owned request id exposed to Workbench clients. */
  id: string
  /** LSP method sent only after the declared capability is present. */
  method: string
  /** Path below initializeResult.capabilities that enables the request. */
  capabilityPath: string[]
}

export const WorkbenchCppFileExtensions: readonly string[] = [
  'h', 'cc', 'cpp', 'cxx', 'c++', 'hh', 'hpp', 'hxx', 'h++', 'inl', 'ipp', 'tpp',
  'ixx', 'cppm', 'ccm', 'cxxm', 'c++m', 'mpp',
]

const BuiltinLanguageServices: WorkbenchLanguageServiceDescriptor[] = [
  {
    id: 'typescript-javascript',
    label: 'TypeScript / JavaScript',
    installKind: 'builtin',
    runtime: 'typescript-language-service',
    extensions: ['cjs', 'cts', 'js', 'jsx', 'mjs', 'mts', 'ts', 'tsx'],
    languages: ['javascript', 'jsx', 'typescript', 'tsx'],
  },
  {
    id: 'python',
    label: 'Python',
    installKind: 'builtin',
    runtime: 'python-language-server',
    packageName: 'pyright',
    command: 'pyright-langserver',
    bundledNodeModule: 'pyright/langserver.index.js',
    args: ['--stdio'],
    extensions: ['py', 'pyi'],
    languages: ['python'],
  },
  {
    id: 'web-html',
    label: 'HTML',
    installKind: 'builtin',
    runtime: 'html-language-service',
    extensions: ['htm', 'html'],
    languages: ['html'],
  },
  {
    id: 'web-css',
    label: 'CSS',
    installKind: 'builtin',
    runtime: 'css-language-service',
    // 缩进语法的 `.sass` 不是 SCSS：交给 SCSS 服务只会满屏误报，它只做语法着色。
    extensions: ['css', 'less', 'scss'],
    languages: ['css', 'less', 'scss'],
  },
  {
    id: 'markdown',
    label: 'Markdown',
    installKind: 'builtin',
    runtime: 'markdown-language-service',
    extensions: ['md', 'markdown', 'mdown'],
    languages: ['markdown'],
  },
  {
    id: 'java',
    label: 'Java',
    installKind: 'builtin',
    runtime: 'lsp-server',
    extensions: ['java'],
    languages: ['java'],
    command: 'jdtls',
    projectRootMarkers: [
      'pom.xml',
      'build.gradle',
      'build.gradle.kts',
      'settings.gradle',
      'settings.gradle.kts',
    ],
    initializeTimeoutMs: 90_000,
  },
  {
    id: 'csharp',
    label: 'C#',
    installKind: 'builtin',
    runtime: 'lsp-server',
    extensions: ['cs', 'csx'],
    languages: ['csharp', 'c#'],
    command: 'csharp-ls',
    documentLanguageId: 'csharp',
    initializeTimeoutMs: 90_000,
  },
  {
    id: 'c-cpp',
    label: 'C / C++',
    installKind: 'builtin',
    runtime: 'lsp-server',
    extensions: ['c', ...WorkbenchCppFileExtensions],
    languages: ['c', 'cpp', 'c++'],
    command: 'clangd',
    args: ['--background-index', '--log=error'],
    documentLanguageId: 'cpp',
    documentLanguageIds: { c: 'c' },
    projectRootMarkers: ['compile_commands.json', 'compile_flags.txt', '.clangd'],
  },
  {
    id: 'go',
    label: 'Go',
    installKind: 'builtin',
    runtime: 'lsp-server',
    extensions: ['go'],
    languages: ['go', 'golang'],
    command: 'gopls',
    projectRootMarkers: ['go.work', 'go.mod'],
  },
  {
    id: 'rust',
    label: 'Rust',
    installKind: 'builtin',
    runtime: 'lsp-server',
    extensions: ['rs'],
    languages: ['rust'],
    command: 'rust-analyzer',
    projectRootMarkers: ['Cargo.toml', 'rust-project.json'],
    initializeTimeoutMs: 90_000,
  },
  {
    id: 'vue',
    label: 'Vue',
    installKind: 'builtin',
    runtime: 'lsp-server',
    extensions: ['vue'],
    languages: ['vue'],
    command: 'vue-language-server',
    bundledNodeModule: '@vue/language-server/bin/vue-language-server.js',
    args: ['--stdio'],
    initializationOptions: { vue: { hybridMode: false } },
    initializationTypeScriptSdk: true,
    diagnosticMode: 'pull',
    projectRootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
  },
  {
    id: 'dart',
    label: 'Dart',
    installKind: 'builtin',
    runtime: 'lsp-server',
    extensions: ['dart'],
    languages: ['dart'],
    command: 'dart',
    args: ['language-server', '--protocol=lsp'],
    projectRootMarkers: ['pubspec.yaml'],
  },
  {
    id: 'swift',
    label: 'Swift',
    installKind: 'builtin',
    runtime: 'lsp-server',
    extensions: ['swift'],
    languages: ['swift'],
    command: 'sourcekit-lsp',
    projectRootMarkers: ['Package.swift'],
    initializeTimeoutMs: 90_000,
  },
  {
    id: 'kotlin',
    label: 'Kotlin',
    installKind: 'builtin',
    runtime: 'lsp-server',
    extensions: ['kt', 'kts'],
    languages: ['kotlin'],
    command: 'intellij-server',
    commandAlternatives: ['kotlin-lsp'],
    args: ['--stdio'],
    projectRootMarkers: [
      'settings.gradle.kts',
      'settings.gradle',
      'build.gradle.kts',
      'build.gradle',
      'pom.xml',
    ],
    initializeTimeoutMs: 90_000,
  },
  {
    id: 'webassembly',
    label: 'WebAssembly',
    installKind: 'builtin',
    runtime: 'lsp-server',
    extensions: ['wat', 'wast'],
    languages: ['wat', 'wast', 'webassembly'],
    documentLanguageId: 'wat',
    command: 'wat_server',
  },
  {
    id: 'glsl',
    label: 'GLSL',
    installKind: 'builtin',
    runtime: 'lsp-server',
    extensions: ['glsl', 'vert', 'frag', 'geom', 'tesc', 'tese', 'comp', 'vsh', 'fsh'],
    languages: ['glsl'],
    documentLanguageId: 'glsl',
    command: 'glsl_analyzer',
  },
]

const InjectedLanguageServices = new Map<string, WorkbenchLanguageServiceDescriptor>()

function normalizeToken(token: string): string {
  return token.trim().toLowerCase()
}

function extensionFromPath(path: Nullable<string>): string {
  return path?.split('.').at(-1)?.toLowerCase() ?? ''
}

export function getWorkbenchLanguageServiceDocumentId(
  descriptor: WorkbenchLanguageServiceDescriptor,
  path: string
): string {
  const ids = descriptor.documentLanguageIds
  const extension = extensionFromPath(path)
  return (ids && Object.hasOwn(ids, extension) ? ids[extension] : undefined) ??
    descriptor.documentLanguageId ?? descriptor.languages[0] ?? descriptor.id
}

export {
  extensionFromPath as getWorkbenchPathExtension,
  normalizeToken as normalizeWorkbenchLanguage,
}

function matchesLanguageService(
  descriptor: WorkbenchLanguageServiceDescriptor,
  token: string
): boolean {
  const normalized = normalizeToken(token)
  return descriptor.extensions.includes(normalized) || descriptor.languages.includes(normalized)
}

export function getBuiltinWorkbenchLanguageServices(): readonly WorkbenchLanguageServiceDescriptor[] {
  return [...BuiltinLanguageServices, ...InjectedLanguageServices.values()]
}

/**
 * Installs app-owned language support without teaching the reusable Workbench
 * package about that language. Registration is idempotent for the same object
 * so composition roots and tests can safely install their built-ins once.
 */
export function registerWorkbenchLanguageService(
  descriptor: WorkbenchLanguageServiceDescriptor
): () => void {
  const current = InjectedLanguageServices.get(descriptor.id)
  if (current && current !== descriptor)
    throw new Error(`Workbench language service '${descriptor.id}' is already registered`)
  InjectedLanguageServices.set(descriptor.id, descriptor)
  return () => {
    if (InjectedLanguageServices.get(descriptor.id) === descriptor)
      InjectedLanguageServices.delete(descriptor.id)
  }
}

export function resolveBuiltinWorkbenchLanguageService(
  token: string
): Nullable<WorkbenchLanguageServiceDescriptor> {
  if (!token) return null

  return toNullable(
    getBuiltinWorkbenchLanguageServices().find((service) => matchesLanguageService(service, token))
  )
}
