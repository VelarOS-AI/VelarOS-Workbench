import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { test } from "bun:test";

import {
  importPlatformCandidate,
  platformSnapshotDependencySpecification,
  platformSnapshotSpecification,
  verifyPlatformSnapshot,
  verifyPlatformSnapshotLock,
} from "../scripts/release/platformSnapshot.mjs";

test("local release snapshots verify archive bytes, package identity and the complete dependency lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "velaros-snapshot-test-"));
  try {
    const fileName = "velaros-ai-core-0.4.3.tgz";
    const packedArchive = path.join(root, fileName);
    await mkdir(path.join(root, "package"));
    await mkdir(path.join(root, "resources"));
    await writeFile(
      path.join(root, "package/package.json"),
      JSON.stringify({ name: "@velaros-ai/core", version: "0.4.3" }),
    );
    execFileSync("tar", ["-czf", fileName, "-C", root, "package"], {
      cwd: root,
    });
    const bytes = await readFile(packedArchive);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const snapshot = {
      schemaVersion: 2,
      sources: {
        platform: {
          kind: "github-release",
          repository: "VelarOS-AI/VelarOS-Platform",
          tag: "v0.6.57",
          sourceCommit: "a".repeat(40),
        },
      },
      packages: [
        {
          name: "@velaros-ai/core",
          version: "0.4.3",
          fileName,
          sizeBytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          integrity,
          source: "platform",
        },
      ],
    };
    const specification = platformSnapshotSpecification(snapshot.packages[0]);
    const dependencySpecification = platformSnapshotDependencySpecification(snapshot, snapshot.packages[0]);
    assert.equal(dependencySpecification, `https://github.com/VelarOS-AI/VelarOS-Platform/releases/download/v0.6.57/${fileName}`);
    const archive = path.join(root, specification.slice("file:".length));
    await mkdir(path.dirname(archive), { recursive: true });
    await rename(packedArchive, archive);
    const snapshotFile = path.join(root, "resources/runtime-snapshot.json");
    await writeFile(snapshotFile, JSON.stringify(snapshot));
    assert.deepEqual(await verifyPlatformSnapshot(root), snapshot);
    snapshot.sources.platform.repository = "unexpected/source";
    await writeFile(snapshotFile, JSON.stringify(snapshot));
    await assert.rejects(
      verifyPlatformSnapshot(root),
      /Invalid dependency snapshot source/u,
    );
    snapshot.sources.platform.repository = "VelarOS-AI/VelarOS-Platform";
    await writeFile(snapshotFile, JSON.stringify(snapshot));

    const lock = {
      packages: {
        "@velaros-ai/core": [
          `@velaros-ai/core@${dependencySpecification}`,
          {},
          integrity,
        ],
      },
    };
    assert.doesNotThrow(() => verifyPlatformSnapshotLock(snapshot, lock));
    const legacySpecification = `file:build/runtime-packages/${fileName}`;
    assert.throws(
      () =>
        verifyPlatformSnapshotLock(snapshot, {
          packages: {
            "@velaros-ai/core": [
              `@velaros-ai/core@${legacySpecification.slice(5)}`,
              {},
              integrity,
            ],
          },
        }),
      /lock identity mismatch/u,
    );
    // The archive name and package version can remain the same across release trains.
    // Different verified content must use a different local path and reject the old lock.
    await writeFile(
      path.join(root, "package/release-marker.txt"),
      "second release contents",
    );
    execFileSync("tar", ["-czf", fileName, "-C", root, "package"], {
      cwd: root,
    });
    const nextBytes = await readFile(packedArchive);
    const nextEntry = {
      ...snapshot.packages[0],
      sizeBytes: nextBytes.length,
      sha256: createHash("sha256").update(nextBytes).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(nextBytes).digest("base64")}`,
    };
    const nextSpecification = platformSnapshotSpecification(nextEntry);
    assert.notEqual(nextSpecification, specification);
    assert.equal(nextEntry.fileName, snapshot.packages[0].fileName);
    assert.equal(nextEntry.version, snapshot.packages[0].version);
    const nextSnapshot = { ...snapshot, packages: [nextEntry] };
    assert.throws(
      () => verifyPlatformSnapshotLock(nextSnapshot, lock),
      /lock identity mismatch/u,
    );
    const nextArchive = path.join(
      root,
      nextSpecification.slice("file:".length),
    );
    await mkdir(path.dirname(nextArchive), { recursive: true });
    await rename(packedArchive, nextArchive);
    await writeFile(snapshotFile, JSON.stringify(nextSnapshot));
    assert.deepEqual(await verifyPlatformSnapshot(root), nextSnapshot);
    assert.deepEqual(await readFile(archive), bytes);
    assert.doesNotThrow(() =>
      verifyPlatformSnapshotLock(nextSnapshot, {
        packages: {
          "@velaros-ai/core": [
            `@velaros-ai/core@${platformSnapshotDependencySpecification(nextSnapshot, nextEntry)}`,
            {},
            nextEntry.integrity,
          ],
        },
      }),
    );
    await writeFile(snapshotFile, JSON.stringify(snapshot));
    assert.throws(
      () => verifyPlatformSnapshotLock(snapshot, { ...lock, overrides: { "@velaros-ai/core": specification } }),
      /lock identity mismatch/u,
    );
    assert.throws(
      () => verifyPlatformSnapshotLock(snapshot, {
        ...lock,
        packages: { ...lock.packages, "nested/@velaros-ai/core": lock.packages["@velaros-ai/core"] },
      }),
      /lock identity mismatch/u,
    );
    assert.throws(
      () =>
        verifyPlatformSnapshotLock(snapshot, {
          ...lock,
          packages: {
            "@velaros-ai/core": [
              lock.packages["@velaros-ai/core"][0],
              {},
              "sha512-tampered",
            ],
          },
        }),
      /lock identity mismatch/u,
    );
    await writeFile(archive, "tampered archive");
    await assert.rejects(verifyPlatformSnapshot(root), /integrity mismatch/u);
    await writeFile(archive, bytes);
    for (const field of ["overrides", "resolutions"]) {
      await writeFile(path.join(root, "package/package.json"), JSON.stringify({
        name: "@velaros-ai/core", version: "0.4.3", [field]: { react: "19.2.5" },
      }));
      execFileSync("tar", ["-czf", fileName, "-C", root, "package"], { cwd: root });
      const mappedBytes = await readFile(packedArchive);
      const mappedEntry = {
        ...snapshot.packages[0], sizeBytes: mappedBytes.length,
        sha256: createHash("sha256").update(mappedBytes).digest("hex"),
        integrity: `sha512-${createHash("sha512").update(mappedBytes).digest("base64")}`,
      };
      const mappedArchive = path.join(root, platformSnapshotSpecification(mappedEntry).slice(5));
      await mkdir(path.dirname(mappedArchive), { recursive: true });
      await rename(packedArchive, mappedArchive);
      await writeFile(snapshotFile, JSON.stringify({ ...snapshot, packages: [mappedEntry] }));
      await assert.rejects(verifyPlatformSnapshot(root), /must not contain development dependency mappings/u);
    }
    snapshot.packages[0].fileName = "../outside.tgz";
    await writeFile(snapshotFile, JSON.stringify(snapshot));
    await assert.rejects(
      verifyPlatformSnapshot(root),
      /Invalid Platform snapshot package/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capability locks require the canonical mandatory base dependency without a registry peer', () => {
  const packages = [
    { name: '@velaros-ai/velaros', version: '0.9.7', fileName: 'velaros-ai-velaros-0.9.7.tgz', source: 'platform', integrity: 'sha512-base' },
    { name: '@velaros-ai/capabilities', version: '0.9.7', fileName: 'velaros-ai-capabilities-0.9.7.tgz', source: 'platform', integrity: 'sha512-capabilities' },
  ]
  const snapshot = { sources: { platform: { kind: 'github-release', repository: 'VelarOS-AI/VelarOS-Platform', tag: 'v0.7.8' } }, packages }
  const baseUrl = platformSnapshotDependencySpecification(snapshot, packages[0])
  const dependency = { '@velaros-ai/velaros': baseUrl }
  const locked = (metadata: object) => ({ packages: Object.fromEntries(packages.map((entry) => [entry.name, [
    `${entry.name}@${platformSnapshotDependencySpecification(snapshot, entry)}`,
    entry.name === '@velaros-ai/capabilities' ? metadata : {}, entry.integrity,
  ]])) })
  assert.doesNotThrow(() => verifyPlatformSnapshotLock(snapshot, locked({ dependencies: dependency })))
  for (const metadata of [{}, { peerDependencies: { '@velaros-ai/velaros': '0.9.7' } }, { dependencies: dependency, peerDependencies: { '@velaros-ai/velaros': '0.9.7' } }])
    assert.throws(() => verifyPlatformSnapshotLock(snapshot, locked(metadata)), /canonical mandatory base archive dependency/u)
})

test('frozen candidates import unchanged bytes and commit proof without becoming published releases', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'velaros-candidate-test-'))
  try {
    const incoming = path.join(root, 'incoming')
    await mkdir(path.join(incoming, 'package'), { recursive: true })
    await mkdir(path.join(root, 'resources'))
    await writeFile(path.join(incoming, 'package/package.json'), JSON.stringify({
      name: '@velaros-ai/velaros', version: '0.9.1', velaros: { platform: '0.7' },
    }))
    execFileSync('tar', ['-czf', 'velaros.tgz', 'package'], { cwd: incoming })
    const bytes = await readFile(path.join(incoming, 'velaros.tgz'))
    const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')
    const entry = {
      name: '@velaros-ai/velaros', version: '0.9.1', source: 'platform',
      fileName: 'velaros.tgz', sizeBytes: bytes.length, sha256: digest(bytes),
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    }
    const archive = {
      name: entry.fileName, package: entry.name, version: entry.version, bytes: entry.sizeBytes,
      sha256: entry.sha256, integrity: entry.integrity,
    }
    const proof = {
      sourceCommit: 'a'.repeat(40), tree: 'b'.repeat(40),
      rawCandidateFingerprint: 'c'.repeat(64), committedInputFingerprint: 'd'.repeat(64),
      inputFiles: 1, inputs: [{ file: 'package.json', sha256: 'e'.repeat(64), committedBlob: 'f'.repeat(40) }],
    }
    const receipt = {
      kind: 'verified-local-candidate', version: entry.version, platformGeneration: '0.7', frozen: true,
      sourceCommit: proof.sourceCommit,
      source: {
        dirty: true, fingerprint: proof.rawCandidateFingerprint,
        commitTree: proof.tree, committedInputFingerprint: proof.committedInputFingerprint,
        committedInputsMatch: true, inputFiles: proof.inputFiles, commitProof: 'source-proof.json',
      },
      archives: [archive],
    }
    const receiptBytes = Buffer.from(JSON.stringify(receipt))
    const proofBytes = Buffer.from(JSON.stringify(proof))
    const snapshot = {
      schemaVersion: 2,
      sources: {
        platform: {
          kind: 'frozen-local-candidate', repository: 'VelarOS-AI/VelarOS-Platform',
          sourceCommit: proof.sourceCommit, sourceTree: proof.tree,
          rawInputFingerprint: proof.rawCandidateFingerprint,
          committedInputFingerprint: proof.committedInputFingerprint,
          receipt: { path: 'resources/runtime-sources/fixture/candidate.json', sha256: digest(receiptBytes) },
          commitProof: { path: 'resources/runtime-sources/fixture/source-proof.json', sha256: digest(proofBytes) },
        },
      },
      packages: [entry],
    }
    await writeFile(path.join(root, 'resources/runtime-snapshot.json'), JSON.stringify(snapshot))
    const receiptFile = path.join(incoming, 'candidate.json')
    await writeFile(receiptFile, receiptBytes)
    await writeFile(path.join(incoming, 'source-proof.json'), proofBytes)

    await assert.rejects(
      verifyPlatformSnapshot(root, { requirePublished: true }),
      /require published dependency sources; frozen local candidate/u
    )
    assert.deepEqual(await importPlatformCandidate(root, receiptFile), snapshot)
    const cached = path.join(root, platformSnapshotSpecification(entry).slice('file:'.length))
    assert.deepEqual(await readFile(cached), bytes)
    assert.deepEqual(await readFile(path.join(root, snapshot.sources.platform.receipt.path)), receiptBytes)
    await rm(cached)
    await assert.rejects(verifyPlatformSnapshot(root, { downloadMissing: true }), /--import-candidate explicitly/u)
    await importPlatformCandidate(root, receiptFile)
    await writeFile(path.join(root, snapshot.sources.platform.commitProof.path), '{}')
    await assert.rejects(verifyPlatformSnapshot(root), /metadata integrity mismatch/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
