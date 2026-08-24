import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { LanguageDescription, StreamLanguage } from '@codemirror/language'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import type { Extension } from '@codemirror/state'

import { getWorkbenchPathExtension, normalizeWorkbenchLanguage } from '@shared/language/workbenchLanguageServices'

import { resolveWorkbenchEditorLanguage } from '../../language/workbenchEditorLanguageContributions'

import { workbenchGitIgnoreLanguage } from './workbenchGitIgnoreLanguage'

export type WorkbenchCodeMirrorLanguageSupportMode = 'builtin' | 'plain-text'

export interface WorkbenchCodeMirrorLanguageSupport {
  extension: Extension
  languageId: string
  mode: WorkbenchCodeMirrorLanguageSupportMode
}

const TypeScriptTokens = new Set(['cts', 'mts', 'ts', 'tsx', 'typescript'])
const JavaScriptTokens = new Set(['cjs', 'js', 'javascript', 'jsx', 'mjs'])
const JsxTokens = new Set(['jsx', 'tsx'])
const CssTokens = new Set(['css', 'less', 'sass', 'scss'])
const HtmlTokens = new Set(['htm', 'html'])
const PythonTokens = new Set(['py', 'pyi', 'python'])
const YamlTokens = new Set(['yaml', 'yml'])
const XmlTokens = new Set(['atom', 'plist', 'rss', 'svg', 'xml', 'xsd', 'xsl', 'xslt'])
const ShellTokens = new Set(['bash', 'sh', 'shell', 'zsh'])
const PropertiesTokens = new Set(['cfg', 'env', 'ini', 'properties'])

const MarkdownCodeLanguages = [
  LanguageDescription.of({
    name: 'JavaScript',
    alias: ['js', 'jsx', 'mjs', 'cjs'],
    extensions: ['js', 'jsx', 'mjs', 'cjs'],
    support: javascript({ jsx: true }),
  }),
  LanguageDescription.of({
    name: 'TypeScript',
    alias: ['ts', 'tsx', 'mts', 'cts'],
    extensions: ['ts', 'tsx', 'mts', 'cts'],
    support: javascript({ jsx: true, typescript: true }),
  }),
  LanguageDescription.of({ name: 'CSS', extensions: ['css'], support: css() }),
  LanguageDescription.of({ name: 'HTML', alias: ['html'], extensions: ['html'], support: html() }),
  LanguageDescription.of({ name: 'JSON', extensions: ['json', 'jsonc'], support: json() }),
  LanguageDescription.of({ name: 'Python', alias: ['py'], extensions: ['py'], support: python() }),
  LanguageDescription.of({ name: 'SQL', extensions: ['sql'], support: sql() }),
  LanguageDescription.of({ name: 'XML', extensions: ['xml'], support: xml() }),
  LanguageDescription.of({ name: 'YAML', alias: ['yml'], extensions: ['yaml', 'yml'], support: yaml() }),
]

function getSpecialFileLanguageToken(path: Nullable<string>): string {
  const fileName = path?.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''
  if (fileName === 'dockerfile' || fileName === 'containerfile') return 'dockerfile'
  if (fileName === 'cargo.lock') return 'toml'
  if (fileName === '.bashrc' || fileName === '.profile' || fileName === '.zshrc') return 'shell'
  if (fileName === '.env' || fileName.startsWith('.env.')) return 'properties'
  if (fileName === '.gitignore') return 'gitignore'
  return ''
}

export function resolveWorkbenchCodeMirrorLanguage(
  path: Nullable<string>,
  language: string
): WorkbenchCodeMirrorLanguageSupport {
  const extension = getWorkbenchPathExtension(path)
  const normalizedLanguage = normalizeWorkbenchLanguage(language)
  const token = getSpecialFileLanguageToken(path) || extension || normalizedLanguage
  const injected = resolveWorkbenchEditorLanguage(token)

  if (injected)
    return {
      extension: injected.createExtension(),
      languageId: injected.languageId,
      mode: 'builtin',
    }

  if (TypeScriptTokens.has(token) || JavaScriptTokens.has(token))
    return {
      extension: javascript({
        jsx: JsxTokens.has(token),
        typescript: TypeScriptTokens.has(token),
      }),
      languageId: token,
      mode: 'builtin',
    }

  if (PythonTokens.has(token))
    return { extension: python(), languageId: 'python', mode: 'builtin' }

  if (CssTokens.has(token))
    return { extension: css(), languageId: token, mode: 'builtin' }

  if (HtmlTokens.has(token))
    return { extension: html(), languageId: 'html', mode: 'builtin' }

  if (token === 'json' || token === 'jsonc')
    return { extension: json(), languageId: 'json', mode: 'builtin' }

  if (token === 'markdown' || token === 'md' || token === 'mdown' || token === 'mdx')
    return {
      extension: markdown({ codeLanguages: MarkdownCodeLanguages }),
      languageId: 'markdown',
      mode: 'builtin',
    }

  if (token === 'gitignore')
    return { extension: workbenchGitIgnoreLanguage, languageId: 'gitignore', mode: 'builtin' }

  if (YamlTokens.has(token))
    return { extension: yaml(), languageId: 'yaml', mode: 'builtin' }

  if (XmlTokens.has(token))
    return { extension: xml(), languageId: 'xml', mode: 'builtin' }

  if (token === 'sql')
    return { extension: sql(), languageId: 'sql', mode: 'builtin' }

  if (token === 'toml')
    return {
      extension: StreamLanguage.define(toml),
      languageId: 'toml',
      mode: 'builtin',
    }

  if (ShellTokens.has(token))
    return {
      extension: StreamLanguage.define(shell),
      languageId: 'shell',
      mode: 'builtin',
    }

  if (token === 'dockerfile')
    return {
      extension: StreamLanguage.define(dockerFile),
      languageId: 'dockerfile',
      mode: 'builtin',
    }

  if (PropertiesTokens.has(token))
    return {
      extension: StreamLanguage.define(properties),
      languageId: 'properties',
      mode: 'builtin',
    }

  return { extension: [], languageId: token || 'text', mode: 'plain-text' }
}
