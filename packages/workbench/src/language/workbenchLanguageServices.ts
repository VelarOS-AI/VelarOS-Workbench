/**
 * 渲染进程加载按需下载的语法产物前，需把 App 已内置的共享 CodeMirror 运行时挂到此全局名下，
 * 供产物内的转发桩取用（保证 facet 实例身份一致）。必须与 scripts/build/packageLanguageGrammars.mjs
 * 里 RUNTIME_GLOBAL 的字面量保持一致。
 */
import { toNullable } from '@velaros-ai/core'
export const WORKBENCH_GRAMMAR_RUNTIME_GLOBAL = '__VELAROS_CM__'

/**
 * 按需下载的语法产物加载用的特权 scheme（主进程注册协议、渲染进程 import()）。
 * 注册为 standard+secure 以绕开 CSP 对 eval/blob 的封禁。
 */
export const WORKBENCH_GRAMMAR_URL_SCHEME = 'velaros-grammar'

export type WorkbenchLanguageServiceInstallKind = 'builtin' | 'plugin'

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
]

const PluginLanguageServices: WorkbenchLanguageServiceDescriptor[] = [
  {
    id: 'java',
    label: 'Java',
    installKind: 'plugin',
    runtime: 'lsp-server',
    packageName: '@velaros-ai/workbench-language-java',
    command: 'java-language-server',
    extensions: ['java'],
    languages: ['java'],
  },
  {
    id: 'cpp',
    label: 'C/C++',
    installKind: 'plugin',
    runtime: 'lsp-server',
    packageName: '@velaros-ai/workbench-language-cpp',
    command: 'clangd',
    extensions: ['c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx'],
    languages: ['c', 'cpp'],
  },
  {
    id: 'go',
    label: 'Go',
    installKind: 'plugin',
    runtime: 'lsp-server',
    packageName: '@velaros-ai/workbench-language-go',
    command: 'gopls',
    extensions: ['go'],
    languages: ['go'],
  },
  {
    id: 'rust',
    label: 'Rust',
    installKind: 'plugin',
    runtime: 'lsp-server',
    packageName: '@velaros-ai/workbench-language-rust',
    command: 'rust-analyzer',
    extensions: ['rs'],
    languages: ['rust'],
  },
]

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
  return BuiltinLanguageServices
}

export function getPluginWorkbenchLanguageServices(): readonly WorkbenchLanguageServiceDescriptor[] {
  return PluginLanguageServices
}

export function resolveBuiltinWorkbenchLanguageService(
  token: string
): Nullable<WorkbenchLanguageServiceDescriptor> {
  if (!token) return null

  return toNullable(BuiltinLanguageServices.find((service) => matchesLanguageService(service, token)))
}

export function resolvePluginWorkbenchLanguageService(
  token: string
): Nullable<WorkbenchLanguageServiceDescriptor> {
  if (!token) return null

  return toNullable(PluginLanguageServices.find((service) => matchesLanguageService(service, token)))
}
