import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import type { Extension } from '@codemirror/state'

import { isFunction, Log, toNullable } from '@velaros-ai/core'

import {
  getWorkbenchPathExtension,
  normalizeWorkbenchLanguage,
  resolveBuiltinWorkbenchLanguageService,
  WORKBENCH_GRAMMAR_URL_SCHEME,
} from '../../language/workbenchLanguageServices'

import { ensureWorkbenchGrammarRuntime } from './workbenchGrammarRuntime'
import {
  resolveDownloadableWorkbenchLanguagePlugin,
  type WorkbenchLanguagePluginDescriptor,
} from './workbenchLanguagePluginModel'
export {
  getDownloadableWorkbenchLanguagePlugins,
  recommendWorkbenchLanguagePlugins,
  type WorkbenchLanguagePluginRecommendation,
} from './workbenchLanguagePluginModel'

export type WorkbenchCodeMirrorLanguageSupportMode =
  | 'builtin'
  | 'plain-text'
  | 'plugin-required'
  | 'plugin-installed'

export interface WorkbenchCodeMirrorLanguageSupport {
  extension: Extension
  languageId: string
  mode: WorkbenchCodeMirrorLanguageSupportMode
  plugin: Nullable<WorkbenchLanguagePluginDescriptor>
}

const log = Log.tag('workbench-codemirror-language')

const NoDownloadedLanguagePlugins = new Set<string>()
const TypeScriptTokens = new Set(['cts', 'mts', 'ts', 'tsx', 'typescript'])
const JavaScriptTokens = new Set(['cjs', 'js', 'javascript', 'jsx', 'mjs'])
const JsxTokens = new Set(['jsx', 'tsx'])
const CssTokens = new Set(['css', 'less', 'sass', 'scss'])
const HtmlTokens = new Set(['htm', 'html'])
const PythonTokens = new Set(['py', 'pyi', 'python'])

// 非常用语法（Java/C++/Go/Rust）不内置：用户在设置页下载后，产物落在 userData，
// 经 velaros-grammar:// 特权协议按需 import 加载（见 LanguageGrammarInstaller / languageGrammarProtocol）。
const loadedPluginExtensions = new Map<string, Extension>()
const pluginExtensionLoaders = new Map<string, Promise<Nullable<Extension>>>()

interface DownloadedGrammarModule {
  create: () => Extension
}

async function importDownloadedLanguagePluginExtension(
  pluginId: string
): Promise<Nullable<Extension>> {
  // 产物内的共享运行时桩从此全局取实例，加载前必须先建桥。
  ensureWorkbenchGrammarRuntime()
  const url = `${WORKBENCH_GRAMMAR_URL_SCHEME}://${pluginId}/index.js`
  const grammarModule = (await import(/* @vite-ignore */ url)) as DownloadedGrammarModule
  if (!isFunction(grammarModule.create)) return null
  return grammarModule.create()
}

export function getLoadedWorkbenchLanguagePluginExtension(pluginId: string): Nullable<Extension> {
  return toNullable(loadedPluginExtensions.get(pluginId))
}

export function loadWorkbenchLanguagePluginExtension(
  pluginId: string
): Promise<Nullable<Extension>> {
  const cached = loadedPluginExtensions.get(pluginId)
  if (cached) return Promise.resolve(cached)

  const inflight = pluginExtensionLoaders.get(pluginId)
  if (inflight) return inflight

  const loader = importDownloadedLanguagePluginExtension(pluginId)
    .then((extension) => {
      if (extension) loadedPluginExtensions.set(pluginId, extension)
      return extension
    })
    .catch((error) => {
      log.warn(`加载语言插件语法失败：${pluginId}`, error)
      return null
    })
    .finally(() => {
      pluginExtensionLoaders.delete(pluginId)
    })

  pluginExtensionLoaders.set(pluginId, loader)
  return loader
}

function createBuiltinLanguageExtension(token: string): Nullable<Extension> {
  if (
    TypeScriptTokens.has(token) ||
    JavaScriptTokens.has(token)
  ) return javascript({
      jsx: JsxTokens.has(token),
      typescript: TypeScriptTokens.has(token),
    })

  if (CssTokens.has(token)) return css()

  if (HtmlTokens.has(token)) return html()

  if (PythonTokens.has(token)) return python()

  return null
}

export function resolveWorkbenchCodeMirrorLanguage(
  path: Nullable<string>,
  language: string,
  downloadedPluginIds: ReadonlySet<string> = NoDownloadedLanguagePlugins
): WorkbenchCodeMirrorLanguageSupport {
  const extension = getWorkbenchPathExtension(path)
  const normalizedLanguage = normalizeWorkbenchLanguage(language)
  const token = extension || normalizedLanguage

  switch (token) {
    case 'json':
    case 'jsonc':
      return {
        extension: json(),
        languageId: 'json',
        mode: 'builtin',
        plugin: null,
      }
    case 'markdown':
    case 'md':
    case 'mdx':
      return {
        extension: markdown(),
        languageId: 'markdown',
        mode: 'builtin',
        plugin: null,
      }
    default: {
      const builtinService = resolveBuiltinWorkbenchLanguageService(token)
      const builtinExtension = builtinService ? createBuiltinLanguageExtension(token) : null
      if (builtinService && builtinExtension) return {
          extension: builtinExtension,
          languageId: (token || builtinService.languages[0]) ?? 'text',
          mode: 'builtin',
          plugin: null,
        }

      const plugin = resolveDownloadableWorkbenchLanguagePlugin(token)
      if (plugin && downloadedPluginIds.has(plugin.id)) {
        // 已“下载”：语法按需异步加载。加载完成前 extension 为空（纯文本），
        // 编辑器在拿到 plugin-installed 后触发 loadWorkbenchLanguagePluginExtension，
        // 加载好再重新配置 language compartment。
        const loadedExtension = getLoadedWorkbenchLanguagePluginExtension(plugin.id)
        return {
          extension: loadedExtension ?? [],
          languageId: token || 'text',
          mode: 'plugin-installed',
          plugin,
        }
      }

      return {
        extension: [],
        languageId: token || 'text',
        mode: plugin ? 'plugin-required' : 'plain-text',
        plugin,
      }
    }
  }
}
