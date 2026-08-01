import { toNullable } from '@velaros-ai/core'

export type WorkbenchLanguageServiceInstallKind = 'builtin'

export type WorkbenchLanguageServiceRuntime =
  | 'typescript-language-service'
  | 'html-language-service'
  | 'css-language-service'
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
  args?: string[]
  documentLanguageId?: string
  protocol?: WorkbenchLanguageServerProtocolContract
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
    extensions: ['css', 'less', 'sass', 'scss'],
    languages: ['css', 'less', 'sass', 'scss'],
  },
]

const InjectedLanguageServices = new Map<string, WorkbenchLanguageServiceDescriptor>()

function normalizeToken(token: string): string {
  return token.trim().toLowerCase()
}

function extensionFromPath(path: Nullable<string>): string {
  return path?.split('.').at(-1)?.toLowerCase() ?? ''
}

export { extensionFromPath as getWorkbenchPathExtension, normalizeToken as normalizeWorkbenchLanguage }

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
