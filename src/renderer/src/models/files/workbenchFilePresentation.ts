import type { Icon } from '@phosphor-icons/react'

import type { LooseOptional } from '@velaros-ai/ui/utility-types'
import {
  type FilePresentationKind,
  getFileExtension,
  getFilePresentationKind,
} from '@velaros-ai/ui/utils/filePresentation'

export type WorkbenchBuiltinFilePresentationVariant =
  | FilePresentationKind
  | 'config'
  | 'css'
  | 'gitignore'
  | 'javascript'
  | 'json'
  | 'jsx'
  | 'less'
  | 'lock'
  | 'patch'
  | 'sass'
  | 'scss'
  | 'tsx'
  | 'typescript'
  | 'velarscript'
  | 'yaml'
  | 'java'
  | 'csharp'
  | 'go'
  | 'rust'
  | 'vue'
  | 'dart'
  | 'swift'
  | 'kotlin'
  | 'webassembly'
  | 'glsl'
  | 'python'
  | 'html'
  | 'sql'

export type WorkbenchFilePresentationVariant =
  WorkbenchBuiltinFilePresentationVariant | (string & {})

export interface WorkbenchFilePresentationInput {
  fileName?: LooseOptional<string>
  mediaType?: LooseOptional<string>
}

export interface WorkbenchFilePresentation {
  variant: WorkbenchFilePresentationVariant
  icon?: Icon
  color?: string
}

export interface WorkbenchFileIconContribution {
  id: string
  resolve: (input: WorkbenchFilePresentationInput) => Nullable<WorkbenchFilePresentation>
}

const FileIconContributions = new Map<string, WorkbenchFileIconContribution>()

const LockFileNames = new Set([
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
])

const ConfigFileNames = new Set([
  '.editorconfig',
  '.npmrc',
  '.nvmrc',
  '.prettierignore',
  '.prettierrc',
  'electron-builder.yml',
  'jsconfig.json',
  'package.json',
  'tsconfig.json',
  'velar.json',
])

function baseName(pathText: string): string {
  return (pathText.split(/[/\\]/u).at(-1) ?? '').toLowerCase()
}

function resolveBuiltinFilePresentation(
  input: WorkbenchFilePresentationInput
): WorkbenchFilePresentation {
  const fileName = input.fileName ?? ''
  const name = baseName(fileName)
  const extension = getFileExtension(fileName)

  if (name === '.gitignore') return { variant: 'gitignore' }
  if (LockFileNames.has(name)) return { variant: 'lock' }
  if (extension === 'yaml' || extension === 'yml') return { variant: 'yaml' }
  if (
    ConfigFileNames.has(name) ||
    name.startsWith('.env') ||
    name.startsWith('.eslintrc') ||
    name.startsWith('.prettierrc')
    // tsconfig.json 这类 JSON 写的配置用 JSON 图标，只有 .editorconfig、.npmrc 这类键值格式的用配置（INI）图标。
  )
    return { variant: extension === 'json' || extension === 'jsonc' ? 'json' : 'config' }

  switch (extension) {
    case 'java':
      return { variant: 'java', color: '#c74634' }
    case 'cs':
    case 'csx':
      return { variant: 'csharp', color: '#8b5cf6' }
    case 'go':
      return { variant: 'go', color: '#0891b2' }
    case 'rs':
      return { variant: 'rust', color: '#b45309' }
    case 'vue':
      return { variant: 'vue', color: '#23966b' }
    case 'dart':
      return { variant: 'dart', color: '#0284c7' }
    case 'swift':
      return { variant: 'swift', color: '#e85d26' }
    case 'kt':
    case 'kts':
      return { variant: 'kotlin', color: '#a855f7' }
    case 'wat':
    case 'wast':
      return { variant: 'webassembly', color: '#654ff0' }
    case 'glsl':
    case 'vert':
    case 'frag':
    case 'geom':
    case 'tesc':
    case 'tese':
    case 'comp':
    case 'vsh':
    case 'fsh':
      return { variant: 'glsl', color: '#ad4d8b' }
    case 'py':
    case 'pyi':
      return { variant: 'python', color: '#3876ab' }
    case 'htm':
    case 'html':
      return { variant: 'html', color: '#e05a32' }
    case 'sql':
      return { variant: 'sql', color: '#3b82b6' }
    case 'css':
      return { variant: 'css' }
    case 'less':
      return { variant: 'less' }
    case 'sass':
      return { variant: 'sass' }
    case 'scss':
      return { variant: 'scss' }
    case 'cjs':
    case 'js':
    case 'mjs':
      return { variant: 'javascript' }
    case 'jsx':
      return { variant: 'jsx' }
    case 'cts':
    case 'mts':
    case 'ts':
      return { variant: 'typescript' }
    case 'tsx':
      return { variant: 'tsx' }
    case 'vel':
      return { variant: 'velarscript' }
    case 'json':
    case 'jsonc':
      return { variant: 'json' }
    case 'diff':
    case 'patch':
      return { variant: 'patch' }
    case 'conf':
    case 'config':
    case 'ini':
    case 'toml':
      return { variant: 'config' }
    case 'xml':
      return { variant: 'code' }
    default:
      return { variant: getFilePresentationKind(input) }
  }
}

/**
 * Renderer contributions may override the built-in file and language icons
 * before the project tree is assembled, and remove their overrides on teardown.
 */
export function registerWorkbenchFileIconContribution(
  contribution: WorkbenchFileIconContribution
): () => void {
  const current = FileIconContributions.get(contribution.id)
  if (current && current !== contribution)
    throw new Error(`Workbench file icon contribution '${contribution.id}' is already registered`)

  FileIconContributions.set(contribution.id, contribution)
  return () => {
    if (FileIconContributions.get(contribution.id) === contribution)
      FileIconContributions.delete(contribution.id)
  }
}

export function resolveWorkbenchFilePresentation(
  input: WorkbenchFilePresentationInput
): WorkbenchFilePresentation {
  for (const contribution of [...FileIconContributions.values()].reverse()) {
    const resolved = contribution.resolve(input)
    if (resolved) return resolved
  }

  return resolveBuiltinFilePresentation(input)
}

export function getWorkbenchFilePresentationVariant(
  input: WorkbenchFilePresentationInput
): WorkbenchFilePresentationVariant {
  return resolveWorkbenchFilePresentation(input).variant
}
