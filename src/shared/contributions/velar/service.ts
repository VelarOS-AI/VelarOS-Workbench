import type { WorkbenchLanguageServiceDescriptor } from '@shared/language/workbenchLanguageServices'

export const VELAR_LANGUAGE_SERVER_PROTOCOL_VERSION = 1

/**
 * Editor-side connection metadata only. Compiler semantics remain in the
 * independently installed Velar toolchain reached through stdio LSP.
 */
export const VelarWorkbenchLanguageService = {
  id: 'velarscript',
  label: 'VelarScript',
  installKind: 'builtin',
  runtime: 'lsp-server',
  packageName: '@velarscript/cli',
  command: 'velar',
  args: ['lsp'],
  documentLanguageId: 'velar',
  protocol: {
    capabilityPath: ['capabilities', 'experimental', 'velar', 'protocolVersion'],
    version: VELAR_LANGUAGE_SERVER_PROTOCOL_VERSION,
  },
  extensions: ['vel'],
  languages: ['velar', 'velarscript'],
} satisfies WorkbenchLanguageServiceDescriptor
