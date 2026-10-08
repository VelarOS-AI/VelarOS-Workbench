import type { WorkbenchLanguageServiceDescriptor } from '@shared/workbenchLanguageServices'

import { VELAR_LANGUAGE_KEYWORDS } from './language'

/**
 * Editor-side connection metadata only. Compiler semantics and compatibility
 * remain in the independently installed project toolchain reached through
 * standard stdio LSP capabilities. The optional ownership graph request is
 * declared here, in the Velar contribution, so the generic Workbench LSP host
 * transports it without learning Velar protocol or graph semantics.
 */
export const VelarWorkbenchLanguageService = {
  id: 'velarscript',
  label: 'VelarScript',
  installKind: 'builtin',
  runtime: 'lsp-server',
  packageName: '@velarscript/cli',
  command: 'velar',
  projectNodePackageBin: 'velar',
  projectRootMarkers: ['velar.json'],
  args: ['lsp'],
  documentLanguageId: 'velar',
  hover: {
    suppressWords: VELAR_LANGUAGE_KEYWORDS,
  },
  extensionRequests: [{
    id: 'ownership-graph',
    method: 'velar/ownershipGraph',
    capabilityPath: ['experimental', 'velar', 'ownershipGraph'],
  }],
  extensions: ['vel'],
  languages: ['velar', 'velarscript'],
} satisfies WorkbenchLanguageServiceDescriptor
