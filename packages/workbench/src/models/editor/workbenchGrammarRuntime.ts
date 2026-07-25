import * as cmAutocomplete from '@codemirror/autocomplete'
import * as cmLanguage from '@codemirror/language'
import * as cmState from '@codemirror/state'
import * as cmView from '@codemirror/view'
import * as lezerCommon from '@lezer/common'
import * as lezerHighlight from '@lezer/highlight'
import * as lezerLr from '@lezer/lr'

import { WORKBENCH_GRAMMAR_RUNTIME_GLOBAL } from '../../language/workbenchLanguageServices'

/**
 * 共享 CodeMirror 运行时桥：把 App 已内置的这几个模块挂到全局，供按需下载的语法产物取用。
 *
 * 语法产物在构建时把 @codemirror/*、@lezer/{common,highlight,lr} 的裸导入改写成从此全局取值
 * （见 scripts/build/packageLanguageGrammars.mjs），这样产物用的是 App 的同一份实例，
 * CodeMirror 的 facet 身份一致，高亮才能生效。加载任何语法前必须先调用 ensureWorkbenchGrammarRuntime。
 */
const sharedRuntime: Record<string, unknown> = {
  '@codemirror/autocomplete': cmAutocomplete,
  '@codemirror/language': cmLanguage,
  '@codemirror/state': cmState,
  '@codemirror/view': cmView,
  '@lezer/common': lezerCommon,
  '@lezer/highlight': lezerHighlight,
  '@lezer/lr': lezerLr,
}

let installed = false

export function ensureWorkbenchGrammarRuntime(): void {
  if (installed) return
  ;(globalThis as Record<string, unknown>)[WORKBENCH_GRAMMAR_RUNTIME_GLOBAL] = sharedRuntime
  installed = true
}
