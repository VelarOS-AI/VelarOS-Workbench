import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import type { Extension } from '@codemirror/state'

import { getWorkbenchPathExtension, normalizeWorkbenchLanguage } from '@shared/language/workbenchLanguageServices'

import { resolveWorkbenchEditorLanguage } from '../../language/workbenchEditorLanguageContributions'

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

export function resolveWorkbenchCodeMirrorLanguage(
  path: Nullable<string>,
  language: string
): WorkbenchCodeMirrorLanguageSupport {
  const extension = getWorkbenchPathExtension(path)
  const normalizedLanguage = normalizeWorkbenchLanguage(language)
  const token = extension || normalizedLanguage
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

  if (token === 'markdown' || token === 'md' || token === 'mdx')
    return { extension: markdown(), languageId: 'markdown', mode: 'builtin' }

  return { extension: [], languageId: token || 'text', mode: 'plain-text' }
}
