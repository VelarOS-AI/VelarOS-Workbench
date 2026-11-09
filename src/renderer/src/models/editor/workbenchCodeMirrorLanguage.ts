import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { Language, LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import type { Extension } from '@codemirror/state'

import { getWorkbenchPathExtension, normalizeWorkbenchLanguage } from '@shared/workbenchLanguageServices'

import { resolveWorkbenchEditorLanguage } from './workbenchEditorLanguageContributions'
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

// 同一种语言共用一份实例：换回一个看过的文件时，它的语法树还能接着用（语言没变就不必重新解析）。
const MarkdownSupport = markdown({ codeLanguages: MarkdownCodeLanguages })
const TomlLanguage = StreamLanguage.define(toml)
const ShellLanguage = StreamLanguage.define(shell)
const DockerfileLanguage = StreamLanguage.define(dockerFile)
const PropertiesLanguage = StreamLanguage.define(properties)

function getSpecialFileLanguageToken(path: Nullable<string>): string {
  const fileName = path?.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''
  if (fileName === 'dockerfile' || fileName === 'containerfile') return 'dockerfile'
  if (fileName === 'cargo.lock') return 'toml'
  if (fileName === '.bashrc' || fileName === '.profile' || fileName === '.zshrc') return 'shell'
  if (fileName === '.env' || fileName.startsWith('.env.')) return 'properties'
  if (fileName === '.gitignore') return 'gitignore'
  return ''
}

/** 语言选择与缓存共用的身份：特殊文件名优先，其次扩展名，最后是声明的语言。 */
export function resolveWorkbenchCodeMirrorLanguageToken(
  path: Nullable<string>,
  language: string
): string {
  return (
    getSpecialFileLanguageToken(path) ||
    getWorkbenchPathExtension(path) ||
    normalizeWorkbenchLanguage(language)
  )
}

export function resolveWorkbenchCodeMirrorLanguage(
  path: Nullable<string>,
  language: string
): WorkbenchCodeMirrorLanguageSupport {
  const token = resolveWorkbenchCodeMirrorLanguageToken(path, language)
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
      extension: MarkdownSupport,
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
      extension: TomlLanguage,
      languageId: 'toml',
      mode: 'builtin',
    }

  if (ShellTokens.has(token))
    return {
      extension: ShellLanguage,
      languageId: 'shell',
      mode: 'builtin',
    }

  if (token === 'dockerfile')
    return {
      extension: DockerfileLanguage,
      languageId: 'dockerfile',
      mode: 'builtin',
    }

  if (PropertiesTokens.has(token))
    return {
      extension: PropertiesLanguage,
      languageId: 'properties',
      mode: 'builtin',
    }

  return { extension: [], languageId: token || 'text', mode: 'plain-text' }
}

/** 语言扩展里的语言本身（`LanguageSupport` 或 `Language`，可能包在数组里）；纯文本没有。 */
export function findWorkbenchCodeMirrorLanguage(extension: Extension): Nullable<Language> {
  if (extension instanceof LanguageSupport) return extension.language
  if (extension instanceof Language) return extension
  if (Array.isArray(extension))
    for (const item of extension) {
      const found = findWorkbenchCodeMirrorLanguage(item as Extension)
      if (found) return found
    }
  return null
}
