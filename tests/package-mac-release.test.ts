import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { describe, test } from 'bun:test'

import {
  buildElectronBuilderArgs,
  hasCompleteNotarizationCredentials,
  resolveMacPackagingEnvironment,
} from '../scripts/release/packageMac.mjs'

void describe('Workbench macOS release packaging', () => {
  void test('uses the saved local notarization profile without reading Keychain contents', () => {
    const environment = resolveMacPackagingEnvironment({ PATH: '/usr/bin' })

    assert.equal(environment.APPLE_KEYCHAIN_PROFILE, 'velaros-notary')
    assert.equal(environment.PATH, '/usr/bin')
  })

  void test('preserves configured CI and custom notarization credentials', () => {
    const ciCredentials = {
      APPLE_ID: 'release@example.com',
      APPLE_APP_SPECIFIC_PASSWORD: 'secret',
      APPLE_TEAM_ID: 'TEAM',
    }
    const customProfile = { APPLE_KEYCHAIN_PROFILE: ' custom-profile ' }

    assert.equal(hasCompleteNotarizationCredentials(ciCredentials), true)
    assert.deepEqual(resolveMacPackagingEnvironment(ciCredentials), ciCredentials)
    assert.deepEqual(resolveMacPackagingEnvironment(customProfile), {
      APPLE_KEYCHAIN_PROFILE: 'custom-profile',
    })
  })

  void test('contains no credential-reading preflight', () => {
    const source = readFileSync(new URL('../scripts/release/packageMac.mjs', import.meta.url), 'utf8')

    assert.doesNotMatch(source, /find-generic-password|notarytool[\s\S]+history/u)
  })

  void test('always disables electron-builder implicit publishing', () => {
    assert.deepEqual(buildElectronBuilderArgs([]), [
      '--config',
      'electron-builder.yml',
      '--mac',
      '--publish',
      'never',
    ])
    assert.deepEqual(buildElectronBuilderArgs(['--', '--publish', 'never']), [
      '--config',
      'electron-builder.yml',
      '--mac',
      '--publish',
      'never',
    ])
    assert.throws(
      () => buildElectronBuilderArgs(['--publish', 'always']),
      /publishing disabled/u
    )
  })
})
