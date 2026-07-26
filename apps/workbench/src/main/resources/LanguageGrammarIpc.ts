import { BrowserWindow, ipcMain } from 'electron'

import type { WorkbenchInstallLanguageGrammarRequest } from '@velaros-ai/workbench/contracts'

import { WorkbenchLanguageChannels } from '../../shared/workbenchLanguage'
import { callWithEnvelope, hasStringFields, invalidRequest } from '../workspace/ipcBoundary'

import type { LanguageGrammarInstaller } from './LanguageGrammarInstaller'

export function registerLanguageGrammarIpc(installer: LanguageGrammarInstaller): () => void {
  ipcMain.handle(WorkbenchLanguageChannels.listGrammars, () =>
    callWithEnvelope(() => installer.listCatalog())
  )
  ipcMain.handle(WorkbenchLanguageChannels.installGrammar, (_event, request: unknown) =>
    callWithEnvelope(async () => {
      const parsed = parseInstallRequest(request)
      if (!parsed) return invalidRequest()
      await installer.install(parsed.id)
      return installer.listCatalog()
    })
  )

  const unsubscribe = installer.subscribe(() => {
    void installer.listCatalog().then((catalog) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(WorkbenchLanguageChannels.grammarsChanged, catalog)
        }
      }
    })
  })

  return () => {
    unsubscribe()
    ipcMain.removeHandler(WorkbenchLanguageChannels.listGrammars)
    ipcMain.removeHandler(WorkbenchLanguageChannels.installGrammar)
  }
}

function parseInstallRequest(input: unknown): Nullable<WorkbenchInstallLanguageGrammarRequest> {
  if (!hasStringFields(input, ['id'])) return null
  return { id: input['id'] as string }
}
