import type { WorkbenchLanguageServiceDescriptor } from '@shared/language/workbenchLanguageServices'

import { VELAR_LANGUAGE_KEYWORDS } from './language'

/**
 * Editor-side connection metadata only. Compiler semantics and compatibility
 * remain in the independently installed project toolchain reached through
 * standard stdio LSP capabilities. Workbench intentionally does not pin the
 * Velar-specific experimental protocol so a language update does not require
 * repackaging the editor.
 */
export const VelarWorkbenchLanguageService = {
  id: 'velarscript',
  label: 'VelarScript',
  installKind: 'builtin',
  runtime: 'lsp-server',
  packageName: '@velarscript/cli',
  command: 'velar',
  projectNodePackageBin: 'velar',
  args: ['lsp'],
  documentLanguageId: 'velar',
  hover: {
    suppressWords: VELAR_LANGUAGE_KEYWORDS,
  },
  extensions: ['vel'],
  languages: ['velar', 'velarscript'],
} satisfies WorkbenchLanguageServiceDescriptor
