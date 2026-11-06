import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test } from 'bun:test'

import type { WorkbenchReleaseArtifact } from '../src/main/updates/WorkbenchReleaseSource'
import { WorkbenchUpdateDownloadCache } from '../src/main/updates/WorkbenchUpdateDownloadCache'

const body = Buffer.alloc(128 * 1024, 42)
const artifact: WorkbenchReleaseArtifact = {
  id: 'package',
  softwareProduct: 'workbench',
  artifactRole: 'update-package',
  format: 'zip',
  version: '1.0.0',
  channel: 'stable',
  platform: 'win32',
  arch: 'x64',
  fileName: 'update.zip',
  sha256: createHash('sha256').update(body).digest('hex'),
  sizeBytes: body.length,
  signatureStatus: 'verified',
  attestationVerified: true,
  isCurrent: true,
  downloadPath: '/package',
}

for (const mode of ['pause', 'disconnect', 'ignore-range', 'bad-range', 'bad-hash'] as const) {
  void test(`HTTP cache preserves partials and validates ${mode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'update-resume-'))
    const ranges: Array<string | undefined> = []
    const controller = new AbortController()
    let first = true
    const server = createServer((request, response) => {
      ranges.push(request.headers.range)
      const start = Number(request.headers.range?.match(/bytes=(\d+)-/u)?.[1] ?? 0)
      if (first) {
        first = false
        response.writeHead(200, { 'Content-Length': body.length })
        response.write(body.subarray(0, 32768))
        if (mode === 'disconnect') setTimeout(() => response.destroy(), 40)
        return
      }
      if (mode === 'ignore-range') {
        response.writeHead(200)
        response.end(body)
        return
      }
      response.writeHead(206, {
        'Content-Range': `bytes ${mode === 'bad-range' ? start + 1 : start}-${body.length - 1}/${body.length}`,
      })
      response.end(
        mode === 'bad-hash' ? Buffer.alloc(body.length - start, 0) : body.subarray(start)
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const url = `http://127.0.0.1:${address.port}/package`
    try {
      await assert.rejects(
        new WorkbenchUpdateDownloadCache(directory).download(
          artifact,
          (init) => fetch(url, init),
          controller.signal,
          (bytes) => {
            if (bytes > 0 && mode !== 'disconnect') controller.abort()
          }
        )
      )
      const restarted = new WorkbenchUpdateDownloadCache(directory)
      const operation = restarted.download(
        artifact,
        (init) => fetch(url, init),
        new AbortController().signal,
        () => {}
      )
      if (mode === 'bad-range' || mode === 'bad-hash')
        await assert.rejects(operation, /Content-Range|SHA-256/u)
      else assert.deepEqual(await readFile(await operation), body)
      assert.equal(ranges[1], 'bytes=32768-')
    } finally {
      controller.abort()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  })
}
