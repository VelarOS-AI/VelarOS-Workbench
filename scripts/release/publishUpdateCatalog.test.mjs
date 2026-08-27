import assert from 'node:assert/strict'
import test from 'node:test'

import { artifactDescriptor } from './publishUpdateCatalog.mjs'

test('Workbench update catalog maps each supported release artifact to its product platform role', () => {
  assert.deepEqual(artifactDescriptor('latest-mac.yml'), {
    platform: 'darwin',
    arch: 'arm64',
    format: 'yml',
    artifactRole: 'update-metadata',
    signatureStatus: 'verified',
  })
  assert.deepEqual(artifactDescriptor('VelarOS-Workbench-1.2.3-mac-arm64.zip'), {
    platform: 'darwin',
    arch: 'arm64',
    format: 'zip',
    artifactRole: 'update-package',
    signatureStatus: 'notarized',
  })
  assert.deepEqual(artifactDescriptor('VelarOS-Workbench-1.2.3-win-x64.exe'), {
    platform: 'win32',
    arch: 'x64',
    format: 'exe',
    artifactRole: 'installer',
    signatureStatus: 'signed',
  })
  assert.deepEqual(artifactDescriptor('VelarOS-Workbench-1.2.3-linux-x64.AppImage'), {
    platform: 'linux',
    arch: 'x64',
    format: 'appimage',
    artifactRole: 'installer',
    signatureStatus: 'verified',
  })
  assert.equal(artifactDescriptor('SHA256SUMS-linux.txt'), null)
})
