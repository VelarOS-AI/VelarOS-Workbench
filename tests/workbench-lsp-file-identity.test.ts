import assert from 'node:assert/strict'

import { test } from 'bun:test'

import { externalLspFileIdentity } from '../src/main/workspace/language/ExternalLspFileIdentity'

test('synthetic ASAR entry metadata does not restart a bundled language server on each request', () => {
  const archive = 'C:/app/resources/app.asar'
  const entry = `${archive}/node_modules/vue/server.js`
  let syntheticInode = 0
  let archiveModified = 100
  const filesystem = {
    realpath: (path: string) => path,
    stat: (path: string) => ({
      dev: 1,
      ino: path === archive ? 7 : ++syntheticInode,
      size: path === archive ? 1000 : 100,
      mtimeMs: path === archive ? archiveModified : Date.now(),
      isFile: () => true,
    }),
  }
  const first = externalLspFileIdentity(entry, filesystem)
  assert.equal(externalLspFileIdentity(entry, filesystem), first)
  assert.equal(syntheticInode, 0)
  archiveModified++
  assert.notEqual(externalLspFileIdentity(entry, filesystem), first)
  assert.notEqual(
    externalLspFileIdentity(`${archive}/other.js`, filesystem),
    externalLspFileIdentity(entry, filesystem)
  )
})

test('real files and directories named .asar retain their own filesystem identity', () => {
  let version = 1
  const filesystem = {
    realpath: (path: string) => path,
    stat: (path: string) => ({
      dev: 1,
      ino: version,
      size: 100,
      mtimeMs: version,
      isFile: () => !path.endsWith('.asar'),
    }),
  }
  const path = 'C:/project/folder.asar/server.js'
  const first = externalLspFileIdentity(path, filesystem)
  version++
  assert.notEqual(externalLspFileIdentity(path, filesystem), first)
})

test('archive identity uses unpatched filesystem metadata when Electron presents the archive as a directory', () => {
  let syntheticInode = 0
  const filesystem = {
    realpath: (path: string) => path,
    stat: () => ({ dev: 1, ino: ++syntheticInode, size: 100, mtimeMs: 1, isFile: () => false }),
    statArchive: () => ({ dev: 2, ino: 9, size: 10000, mtimeMs: 10, isFile: () => true }),
  }
  const path = 'C:/app/resources/app.asar/node_modules/vue/server.js'
  assert.equal(externalLspFileIdentity(path, filesystem), externalLspFileIdentity(path, filesystem))
  assert.equal(syntheticInode, 0)
})
