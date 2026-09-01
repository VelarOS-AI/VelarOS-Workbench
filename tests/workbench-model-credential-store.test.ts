import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { WorkbenchModelCredentialStore } from '../src/main/model/WorkbenchModelCredentialStore'

describe('Workbench model credential store', () => {
  test('persists API keys as app-local authenticated ciphertext', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'velaros-workbench-model-credentials-'))
    try {
      const store = new WorkbenchModelCredentialStore(rootDir)
      await store.setApiKey('openai', 'sk-model-secret')

      expect(await store.getApiKey('openai')).toBe('sk-model-secret')
      expect(await new WorkbenchModelCredentialStore(rootDir).getApiKey('openai'))
        .toBe('sk-model-secret')

      const encryptedPath = join(rootDir, 'model-credentials.local-v1.bin')
      const encrypted = await readFile(encryptedPath)
      expect(encrypted.includes(Buffer.from('sk-model-secret'))).toBe(false)
      if (process.platform !== 'win32') {
        expect((await stat(encryptedPath)).mode & 0o777).toBe(0o600)
        expect((await stat(join(rootDir, 'model-credentials.local-v1.key'))).mode & 0o777)
          .toBe(0o600)
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test('isolates legacy credentials and supports clearing an API key', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'velaros-workbench-model-credentials-'))
    try {
      await writeFile(
        join(rootDir, 'model-credentials.json'),
        JSON.stringify({ version: 1, apiKeys: { openai: 'legacy-electron-ciphertext' } })
      )
      const store = new WorkbenchModelCredentialStore(rootDir)
      expect(await store.getApiKey('openai')).toBe('')

      await store.setApiKey('openai', 'replacement-secret')
      await store.setApiKey('openai', '')
      expect(await new WorkbenchModelCredentialStore(rootDir).getApiKey('openai')).toBe('')
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
