import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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
      expect(await new WorkbenchModelCredentialStore(rootDir).getApiKey('openai')).toBe(
        'sk-model-secret'
      )

      const encryptedPath = join(rootDir, 'model-credentials.local-v1.bin')
      const encrypted = await readFile(encryptedPath)
      expect(encrypted.includes(Buffer.from('sk-model-secret'))).toBe(false)
      if (process.platform !== 'win32') {
        expect((await stat(encryptedPath)).mode & 0o777).toBe(0o600)
        expect((await stat(join(rootDir, 'model-credentials.local-v1.key'))).mode & 0o777).toBe(
          0o600
        )
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

  test('refuses to overwrite damaged ciphertext and can recover after the original is restored', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'velaros-workbench-model-credentials-'))
    try {
      const original = new WorkbenchModelCredentialStore(rootDir)
      await original.setApiKey('openai', 'keep-this-key')
      const path = join(rootDir, 'model-credentials.local-v1.bin')
      const encrypted = await readFile(path)
      const damaged = Buffer.from(encrypted)
      damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1
      await writeFile(path, damaged)

      const reopened = new WorkbenchModelCredentialStore(rootDir)
      await expect(reopened.getApiKey('openai')).rejects.toThrow()
      await expect(reopened.setApiKey('anthropic', 'replacement')).rejects.toThrow()
      expect(await readFile(path)).toEqual(damaged)

      await writeFile(path, encrypted)
      expect(await reopened.getApiKey('openai')).toBe('keep-this-key')
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })

  test('a failed disk replacement leaves the last saved API key in memory and on disk', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'velaros-workbench-model-credentials-'))
    try {
      const store = new WorkbenchModelCredentialStore(rootDir)
      await store.setApiKey('openai', 'saved-key')
      const path = join(rootDir, 'model-credentials.local-v1.bin')
      const backup = `${path}.backup`
      await rename(path, backup)
      await mkdir(path)

      await expect(store.setApiKey('openai', 'unsaved-key')).rejects.toThrow()
      expect(await store.getApiKey('openai')).toBe('saved-key')

      await rm(path, { recursive: true })
      await rename(backup, path)
      expect(await new WorkbenchModelCredentialStore(rootDir).getApiKey('openai')).toBe('saved-key')
    } finally {
      await rm(rootDir, { recursive: true, force: true })
    }
  })
})
