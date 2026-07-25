import { readFile, realpath } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

import { protocol } from 'electron'

import {
  getPluginWorkbenchLanguageServices,
  WORKBENCH_GRAMMAR_URL_SCHEME,
} from '@velaros/workbench/language/workbenchLanguageServices'

import type { LanguageGrammarInstaller } from './LanguageGrammarInstaller'

const GrammarEntryFile = 'index.js'
const KnownGrammarIds = new Set(
  getPluginWorkbenchLanguageServices().map((service) => service.id)
)

export function registerLanguageGrammarScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: WORKBENCH_GRAMMAR_URL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ])
}

export function registerLanguageGrammarProtocol(installer: LanguageGrammarInstaller): void {
  protocol.handle(WORKBENCH_GRAMMAR_URL_SCHEME, async (request) => {
    const url = new URL(request.url)
    const id = url.hostname
    const relativePath = url.pathname.replace(/^\/+/, '')
    if (!KnownGrammarIds.has(id) || relativePath !== GrammarEntryFile)
      return new Response('not found', { status: 404 })

    const root = await realpath(resolve(installer.getInstallRoot()))
    const expectedPath = join(root, id, GrammarEntryFile)
    const filePath = await realpath(expectedPath).catch(() => null)
    if (!filePath) return new Response('not found', { status: 404 })
    if (filePath !== expectedPath || !filePath.startsWith(`${root}${sep}`))
      return new Response('forbidden', { status: 403 })

    try {
      return new Response(await readFile(filePath), {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}
