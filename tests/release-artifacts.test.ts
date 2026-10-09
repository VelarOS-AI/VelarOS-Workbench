import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, test } from 'bun:test'

import {
  resolveNativeDistributionIdentity,
  reuseReleaseArtifacts,
  stageReleaseArtifacts,
  validateReleaseTag,
  validateStagedRelease,
} from '../scripts/release/releaseArtifacts.mjs'
import {
  readWindowsExecutableArchitecture,
  verifyWindowsX64Executable,
} from '../scripts/release/verifyPackagedWorkbench.mjs'

const requireFromTest = createRequire(import.meta.url)
const electronBuilderCli = requireFromTest.resolve('electron-builder/cli.js')
const requireFromElectronBuilder = createRequire(electronBuilderCli)
const { buildBlockMap } = requireFromElectronBuilder(
  'app-builder-lib/out/targets/blockmap/blockmap.js'
)
const version = (JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { version: string }).version
const releaseTag = `v${version}`
const sourceSha = 'a'.repeat(40)

function distribution(platform: 'macos' | 'windows' | 'linux') {
  return {
    platform: platform === 'macos' ? 'darwin' : platform === 'windows' ? 'win32' : 'linux',
    arch: platform === 'macos' ? 'arm64' : 'x64',
    signatureStatus: platform === 'macos' ? 'notarized' : platform === 'windows' ? 'unsigned' : 'verified',
    evidence: ['fixture-proof'],
  }
}

async function writeMacRelease(releaseDir: string, artifactVersion = version) {
  await mkdir(releaseDir, { recursive: true })
  const dmgName = `VelarOS-Workbench-${artifactVersion}-mac-arm64.dmg`
  const zipName = `VelarOS-Workbench-${artifactVersion}-mac-arm64.zip`
  await Promise.all([
    writeFile(path.join(releaseDir, dmgName), 'dmg'),
    writeFile(path.join(releaseDir, zipName), 'zip'),
    writeFile(path.join(releaseDir, 'builder-debug.yml'), 'debug'),
  ])
  await writeMacUpdateMetadata(releaseDir, artifactVersion)
}

async function writeMacUpdateMetadata(releaseDir: string, artifactVersion = version) {
  const dmgName = `VelarOS-Workbench-${artifactVersion}-mac-arm64.dmg`
  const zipName = `VelarOS-Workbench-${artifactVersion}-mac-arm64.zip`
  const [dmg, zip] = await Promise.all([
    readFile(path.join(releaseDir, dmgName)),
    readFile(path.join(releaseDir, zipName)),
  ])
  await Promise.all([
    buildBlockMap(
      path.join(releaseDir, dmgName),
      'gzip',
      path.join(releaseDir, `${dmgName}.blockmap`)
    ),
    buildBlockMap(
      path.join(releaseDir, zipName),
      'gzip',
      path.join(releaseDir, `${zipName}.blockmap`)
    ),
  ])
  const sha512 = (value: Buffer) => createHash('sha512').update(value).digest('base64')
  await writeFile(
    path.join(releaseDir, 'latest-mac.yml'),
    [
      `version: ${artifactVersion}`,
      'files:',
      `  - url: ${zipName}`,
      `    sha512: ${sha512(zip)}`,
      `    size: ${zip.byteLength}`,
      `  - url: ${dmgName}`,
      `    sha512: ${sha512(dmg)}`,
      `    size: ${dmg.byteLength}`,
      `path: ${zipName}`,
      `sha512: ${sha512(zip)}`,
      '',
    ].join('\n')
  )
}

async function writeWindowsRelease(releaseDir: string) {
  await mkdir(releaseDir, { recursive: true })
  await Promise.all([
    writeFile(path.join(releaseDir, `VelarOS-Workbench-${version}-win-x64.exe`), 'exe'),
    writeFile(path.join(releaseDir, `VelarOS-Workbench-${version}-win-x64.zip`), 'zip'),
    writeFile(path.join(releaseDir, `VelarOS-Workbench-${version}-win-x64.exe.blockmap`), 'map'),
    writeFile(path.join(releaseDir, 'latest.yml'), `version: ${version}\n`),
  ])
}

async function writeWindowsExecutable(file: string, machine: number) {
  const executable = Buffer.alloc(0x86)
  executable.writeUInt16LE(0x5a4d, 0)
  executable.writeUInt32LE(0x80, 0x3c)
  executable.writeUInt32LE(0x00004550, 0x80)
  executable.writeUInt16LE(machine, 0x84)
  await writeFile(file, executable)
}

async function writeLinuxRelease(releaseDir: string) {
  await mkdir(releaseDir, { recursive: true })
  await Promise.all([
    writeFile(
      path.join(releaseDir, `VelarOS-Workbench-${version}-linux-x86_64.AppImage`),
      'appimage'
    ),
    writeFile(
      path.join(releaseDir, `VelarOS-Workbench-${version}-linux-amd64.deb`),
      'deb'
    ),
    writeFile(path.join(releaseDir, 'latest-linux.yml'), `version: ${version}\n`),
  ])
}

void describe('Workbench release artifacts', () => {
  void test('accepts only an x64 PE executable for the Windows package', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbench-windows-architecture-'))
    const x64Directory = path.join(root, 'x64')
    const arm64Directory = path.join(root, 'arm64')
    try {
      await Promise.all([
        mkdir(x64Directory, { recursive: true }),
        mkdir(arm64Directory, { recursive: true }),
      ])
      const x64Executable = path.join(x64Directory, 'VelarOS Workbench.exe')
      const arm64Executable = path.join(arm64Directory, 'VelarOS Workbench.exe')
      await Promise.all([
        writeWindowsExecutable(x64Executable, 0x8664),
        writeWindowsExecutable(arm64Executable, 0xaa64),
      ])

      assert.equal(await readWindowsExecutableArchitecture(x64Executable), 'x64')
      assert.equal(await readWindowsExecutableArchitecture(arm64Executable), 'arm64')
      await verifyWindowsX64Executable(x64Directory)
      await assert.rejects(
        verifyWindowsX64Executable(arm64Directory),
        /architecture arm64 must equal x64/u
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  void test('rejects empty packaged artifacts before writing a stage receipt', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbench-empty-artifact-'))
    const releaseDir = path.join(root, 'release')
    const stageDir = path.join(root, 'stage')
    try {
      await writeLinuxRelease(releaseDir)
      await writeFile(
        path.join(releaseDir, `VelarOS-Workbench-${version}-linux-amd64.deb`),
        '',
      )
      await assert.rejects(
        stageReleaseArtifacts({
          releaseDir,
          stageDir,
          platform: 'linux',
          distribution: distribution('linux'),
          version,
          sourceSha,
          releaseTag,
        }),
        /non-empty Workbench release artifact/u,
      )
      await assert.rejects(
        readFile(path.join(stageDir, 'workbench-linux-release.json')),
        /ENOENT/u,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  void test('rejects stale macOS update metadata after an artifact changes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbench-stale-update-metadata-'))
    const releaseDir = path.join(root, 'release')
    const stageDir = path.join(root, 'stage')
    try {
      await writeMacRelease(releaseDir)
      await writeFile(
        path.join(releaseDir, `VelarOS-Workbench-${version}-mac-arm64.dmg`),
        'changed-after-metadata'
      )

      await assert.rejects(
        stageReleaseArtifacts({
          releaseDir,
          stageDir,
          platform: 'macos',
          distribution: distribution('macos'),
          version,
          sourceSha,
          releaseTag,
        }),
        /size .* does not match the final artifact/u
      )
      await assert.rejects(readFile(path.join(stageDir, 'latest-mac.yml')), /ENOENT/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  void test('rejects a macOS blockmap that does not match its final package', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbench-stale-blockmap-'))
    const releaseDir = path.join(root, 'release')
    const stageDir = path.join(root, 'stage')
    const blockmapName = `VelarOS-Workbench-${version}-mac-arm64.dmg.blockmap`
    try {
      await writeMacRelease(releaseDir)
      await writeFile(path.join(releaseDir, blockmapName), 'stale-blockmap')

      await assert.rejects(
        stageReleaseArtifacts({
          releaseDir,
          stageDir,
          platform: 'macos',
          distribution: distribution('macos'),
          version,
          sourceSha,
          releaseTag,
        }),
        new RegExp(`${blockmapName.replaceAll('.', '\\.')} does not match the final`)
      )
      await assert.rejects(readFile(path.join(stageDir, blockmapName)), /ENOENT/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  void test('reads macOS architecture from the packaged Mach-O identity', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbench-native-identity-'))
    try {
      await writeMacRelease(root)
      const calls: string[] = []
      const execute = async (command: string, args: string[]) => {
        calls.push(`${command} ${args[0]}`)
        if (command === 'ditto') {
          const app = path.join(args.at(-1)!, 'VelarOS Workbench.app', 'Contents')
          await mkdir(path.join(app, 'MacOS'), { recursive: true })
          await writeFile(path.join(app, 'Info.plist'), 'plist')
          await writeFile(path.join(app, 'MacOS', 'Workbench'), 'binary')
        }
        if (command === 'plutil') return { stdout: 'Workbench\n' }
        if (command === 'lipo') return { stdout: 'x86_64\n' }
        return { stdout: '' }
      }

      const identity = await resolveNativeDistributionIdentity({
        releaseDir: root,
        platform: 'macos',
        version,
        host: { platform: 'darwin', arch: 'arm64' },
        execute,
      })

      assert.equal(identity.arch, 'x64')
      assert.equal(identity.signatureStatus, 'notarized')
      assert.ok(calls.includes('lipo -archs'))
      assert.ok(calls.includes('xcrun stapler'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  void test('requires the release tag to equal the Workbench version', async () => {
    await validateReleaseTag(process.cwd(), releaseTag)
    await assert.rejects(
      validateReleaseTag(process.cwd(), 'main'),
      new RegExp(`must equal Workbench version tag ${releaseTag.replaceAll('.', '\\.')}`)
    )
  })

  void test('records and verifies the complete immutable product identity', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbench-release-'))
    const releaseDir = path.join(root, 'release')
    const stageDir = path.join(root, 'stage')
    await writeMacRelease(releaseDir)

    const staged = await stageReleaseArtifacts({
      releaseDir,
      stageDir,
      platform: 'macos',
      distribution: distribution('macos'),
      version,
      sourceSha,
      releaseTag,
    })

    assert.deepEqual(staged, [
      `VelarOS-Workbench-${version}-mac-arm64.dmg`,
      `VelarOS-Workbench-${version}-mac-arm64.dmg.blockmap`,
      `VelarOS-Workbench-${version}-mac-arm64.zip`,
      `VelarOS-Workbench-${version}-mac-arm64.zip.blockmap`,
      'latest-mac.yml',
      'SHA256SUMS-macos.txt',
      'workbench-macos-release.json',
    ])
    const manifest = await validateStagedRelease({
      directory: stageDir,
      platform: 'macos',
      version,
      sourceSha,
      releaseTag,
    })
    assert.equal(manifest.sourceSha, sourceSha)
    assert.equal(manifest.version, version)
    assert.equal(manifest.platform, 'macos')
    assert.deepEqual(manifest.distribution, distribution('macos'))
    assert.deepEqual(
      Object.keys(manifest.artifacts[0]).sort(),
      [
        'arch',
        'artifactRole',
        'fileName',
        'format',
        'platform',
        'sha256',
        'signatureStatus',
        'sizeBytes',
        'sourceSha',
        'version',
      ].sort()
    )
    const checksums = await readFile(
      path.join(stageDir, 'SHA256SUMS-macos.txt'),
      'utf8'
    )
    assert.ok(checksums.includes(`VelarOS-Workbench-${version}-mac-arm64.dmg`))
    assert.doesNotMatch(checksums, /builder-debug/)
  })

  void test('reuses an existing identical checkpoint without rebuilding', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbench-reuse-'))
    const releaseDir = path.join(root, 'release')
    const existingDir = path.join(root, 'existing')
    const retryStageDir = path.join(root, 'retry')
    await writeMacRelease(releaseDir)
    await stageReleaseArtifacts({
      releaseDir,
      stageDir: existingDir,
      platform: 'macos',
      distribution: distribution('macos'),
      version,
      sourceSha,
      releaseTag,
    })

    const result = await reuseReleaseArtifacts({
      existingDir,
      stageDir: retryStageDir,
      platform: 'macos',
      version,
      sourceSha,
      releaseTag,
    })

    assert.equal(result.reused, true)
    assert.equal(result.adoptedCheckpoint, undefined)
    await validateStagedRelease({
      directory: retryStageDir,
      platform: 'macos',
      version,
      sourceSha,
      releaseTag,
    })
    await assert.rejects(
      reuseReleaseArtifacts({
        existingDir,
        stageDir: path.join(root, 'wrong-source'),
        platform: 'macos',
        version,
        sourceSha: 'c'.repeat(40),
        releaseTag,
      }),
      /manifest sourceSha/
    )
  })

  void test('adopts complete signed files from a retry instead of rebuilding them', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbench-adopt-'))
    const releaseDir = path.join(root, 'release')
    const existingDir = path.join(root, 'existing')
    const retryStageDir = path.join(root, 'retry')
    await writeMacRelease(releaseDir)
    await stageReleaseArtifacts({
      releaseDir,
      stageDir: existingDir,
      platform: 'macos',
      distribution: distribution('macos'),
      version,
      sourceSha,
      releaseTag,
    })
    await rm(path.join(existingDir, 'workbench-macos-release.json'))

    const result = await reuseReleaseArtifacts({
      existingDir,
      stageDir: retryStageDir,
      platform: 'macos',
      distribution: distribution('macos'),
      version,
      sourceSha,
      releaseTag,
    })

    assert.equal(result.reused, true)
    assert.equal(result.adoptedCheckpoint, true)
    await validateStagedRelease({
      directory: retryStageDir,
      platform: 'macos',
      version,
      sourceSha,
      releaseTag,
    })
  })

  void test('upgrades a legacy checkpoint only after native distribution verification', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbench-legacy-checkpoint-'))
    const releaseDir = path.join(root, 'release')
    const existingDir = path.join(root, 'existing')
    const retryStageDir = path.join(root, 'retry')
    await writeMacRelease(releaseDir)
    await stageReleaseArtifacts({
      releaseDir,
      stageDir: existingDir,
      platform: 'macos',
      distribution: distribution('macos'),
      version,
      sourceSha,
      releaseTag,
    })
    const manifestPath = path.join(existingDir, 'workbench-macos-release.json')
    const current = JSON.parse(await readFile(manifestPath, 'utf8'))
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      sourceSha,
      version,
      releaseTag,
      platform: 'macos',
      artifacts: current.artifacts.map(({ fileName, sizeBytes, sha256 }: {
        fileName: string
        sizeBytes: number
        sha256: string
      }) => ({ sourceSha, version, platform: 'macos', fileName, sizeBytes, sha256 })),
    }))

    const result = await reuseReleaseArtifacts({
      existingDir,
      stageDir: retryStageDir,
      platform: 'macos',
      distribution: distribution('macos'),
      version,
      sourceSha,
      releaseTag,
    })

    assert.equal(result.reused, true)
    assert.equal(result.adoptedCheckpoint, true)
    assert.equal(
      JSON.parse(await readFile(path.join(retryStageDir, 'workbench-macos-release.json'), 'utf8'))
        .schemaVersion,
      2
    )
  })

  void test('fails on same-name different bytes and does not overwrite the checkpoint', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbench-conflict-'))
    const releaseDir = path.join(root, 'release')
    const stageDir = path.join(root, 'stage')
    await writeMacRelease(releaseDir)
    await stageReleaseArtifacts({
      releaseDir,
      stageDir,
      platform: 'macos',
      distribution: distribution('macos'),
      version,
      sourceSha,
      releaseTag,
    })
    await writeFile(
      path.join(releaseDir, `VelarOS-Workbench-${version}-mac-arm64.dmg`),
      'different-dmg'
    )
    await writeMacUpdateMetadata(releaseDir)

    await assert.rejects(
      stageReleaseArtifacts({
        releaseDir,
        stageDir,
        platform: 'macos',
        distribution: distribution('macos'),
        version,
        sourceSha,
        releaseTag,
      }),
      /identity conflict/
    )
    assert.equal(
      await readFile(
        path.join(stageDir, `VelarOS-Workbench-${version}-mac-arm64.dmg`),
        'utf8'
      ),
      'dmg'
    )
  })

  void test('fails mixed versions and incomplete retry checkpoints', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbench-mixed-'))
    const releaseDir = path.join(root, 'release')
    await writeMacRelease(releaseDir, '0.2.0')

    await assert.rejects(
      stageReleaseArtifacts({
        releaseDir,
        stageDir: path.join(root, 'stage'),
        platform: 'macos',
        distribution: distribution('macos'),
        version,
        sourceSha,
        releaseTag,
      }),
      /mixed releases fail/
    )

    const incompleteDir = path.join(root, 'incomplete')
    await mkdir(incompleteDir)
    await writeFile(
      path.join(incompleteDir, `VelarOS-Workbench-${version}-mac-arm64.dmg`),
      'signed-dmg'
    )
    await assert.rejects(
      reuseReleaseArtifacts({
        existingDir: incompleteDir,
        stageDir: path.join(root, 'retry'),
        platform: 'macos',
        distribution: distribution('macos'),
        version,
        sourceSha,
        releaseTag,
      }),
      /Incomplete macos release checkpoint/
    )
  })

  void test('keeps platform identities isolated in the merged final release', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'workbench-platforms-'))
    const macDir = path.join(root, 'mac')
    const windowsDir = path.join(root, 'windows')
    const linuxDir = path.join(root, 'linux')
    const finalDir = path.join(root, 'final')
    await Promise.all([
      writeMacRelease(macDir),
      writeWindowsRelease(windowsDir),
      writeLinuxRelease(linuxDir),
    ])
    for (const [platform, releaseDir] of [
      ['macos', macDir],
      ['windows', windowsDir],
      ['linux', linuxDir],
    ] as const) {
      await stageReleaseArtifacts({
        releaseDir,
        stageDir: finalDir,
        platform,
        distribution: distribution(platform),
        version,
        sourceSha,
        releaseTag,
      })
    }
    for (const platform of ['macos', 'windows', 'linux'] as const) {
      await validateStagedRelease({
        directory: finalDir,
        platform,
        version,
        sourceSha,
        releaseTag,
      })
    }
  })
})
