import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { stageReleaseArtifacts } from "./releaseArtifacts.mjs";
import {
  artifactDescriptor,
  assertCatalogMatchesCompletion,
  completionManifest,
  publishReleaseTransaction,
  readCompletedRelease,
  readVerifiedStagedArtifacts,
  releaseManifestNames,
  releaseSigningConfig,
  sortCanonicalValue,
  verifyCompletedRelease,
} from "./publishUpdateCatalog.mjs";
import { loadWorkbenchReleaseNote, validateWorkbenchReleaseNote } from "./releaseNotes.mjs";

function releaseNote(version = "1.2.3") {
  return {
    softwareProduct: "workbench",
    version,
    releasedAt: "2026-09-08",
    title: { zh: "版本说明", en: "Release notes" },
    added: { zh: ["新增可信目录"], en: ["Added a trusted catalog"] },
    fixed: { zh: [], en: [] },
  };
}

test("release-note localized fields keep titles as text and changes as lists", () => {
  const valid = releaseNote();
  assert.deepEqual(validateWorkbenchReleaseNote(valid, valid.version), valid);
  assert.throws(
    () => validateWorkbenchReleaseNote({ ...valid, title: { zh: ["标题"], en: ["Title"] } }, valid.version),
    /title.zh contains invalid text/u,
  );
  for (const field of ["added", "fixed"]) {
    assert.throws(
      () => validateWorkbenchReleaseNote({ ...valid, [field]: { zh: "变更", en: "Change" } }, valid.version),
      /has an invalid item count/u,
    );
  }
});

function signedFixtureCatalog(payload, signing) {
  return {
    ...payload,
    attestation: {
      algorithm: "ed25519",
      keyId: signing.keyId,
      signature: sign(
        null,
        Buffer.from(JSON.stringify(sortCanonicalValue(payload))),
        signing.privateKey,
      ).toString("base64url"),
    },
  };
}

function addLegacyCompletedRelease(fixture) {
  const priorBody = Buffer.from("verified legacy macOS package");
  const prior = {
    kind: "software",
    softwareProduct: "workbench",
    platform: "darwin",
    arch: "arm64",
    format: "dmg",
    artifactRole: "installer",
    signatureStatus: "notarized",
    version: fixture.input.identity.version,
    channel: fixture.input.identity.channel,
    assetId: "91",
    fileName: `VelarOS-Workbench-${fixture.input.identity.version}-mac-arm64.dmg`,
    sha256: createHash("sha256").update(priorBody).digest("hex"),
    sizeBytes: priorBody.length,
    githubTag: fixture.input.identity.tag,
    sourceCommit: fixture.input.identity.sourceCommit,
  };
  const payload = { schemaVersion: 1, artifacts: [prior] };
  const catalog = signedFixtureCatalog(payload, fixture.input.signing);
  const completion = completionManifest(
    [prior],
    fixture.input.identity,
    { includeReleaseNotes: false },
  );
  const catalogBytes = Buffer.from(JSON.stringify(catalog));
  fixture.addRemoteAsset(prior.fileName, priorBody, prior.assetId);
  fixture.addRemoteAsset(fixture.names.catalog, catalogBytes);
  fixture.addRemoteAsset(
    fixture.names.completion,
    Buffer.from(JSON.stringify(completion)),
  );
  return { prior, priorBody, catalog, catalogBytes, completion };
}

function addPartialCurrentCatalog(fixture) {
  const priorBody = Buffer.from("verified interrupted macOS package");
  const prior = {
    kind: "software",
    softwareProduct: "workbench",
    platform: "darwin",
    arch: "arm64",
    format: "dmg",
    artifactRole: "installer",
    signatureStatus: "notarized",
    version: fixture.input.identity.version,
    channel: fixture.input.identity.channel,
    assetId: "92",
    fileName: `VelarOS-Workbench-${fixture.input.identity.version}-mac-arm64.dmg`,
    sha256: createHash("sha256").update(priorBody).digest("hex"),
    sizeBytes: priorBody.length,
    githubTag: fixture.input.identity.tag,
    sourceCommit: fixture.input.identity.sourceCommit,
  };
  const payload = {
    schemaVersion: 2,
    releaseNotes: [fixture.input.identity.releaseNote],
    artifacts: [prior],
  };
  const catalog = signedFixtureCatalog(payload, fixture.input.signing);
  const catalogBytes = Buffer.from(JSON.stringify(catalog));
  fixture.addRemoteAsset(prior.fileName, priorBody, prior.assetId);
  fixture.addRemoteAsset(fixture.names.catalog, catalogBytes);
  return { prior, priorBody, catalog, catalogBytes };
}

function stagedRecord(overrides) {
  return {
    fileName: "VelarOS-Workbench-1.2.3-mac-arm64.zip",
    platform: "darwin",
    arch: "arm64",
    format: "zip",
    artifactRole: "update-package",
    signatureStatus: "notarized",
    ...overrides,
  };
}

test("Workbench update catalog consumes the verified staged identity", () => {
  assert.deepEqual(
    artifactDescriptor(
      stagedRecord({
        fileName: "latest-mac.yml",
        format: "yml",
        artifactRole: "update-metadata",
        signatureStatus: "verified",
      }),
    ),
    {
      platform: "darwin",
      arch: "arm64",
      format: "yml",
      artifactRole: "update-metadata",
      signatureStatus: "verified",
    },
  );
  assert.deepEqual(artifactDescriptor(stagedRecord()), {
    platform: "darwin",
    arch: "arm64",
    format: "zip",
    artifactRole: "update-package",
    signatureStatus: "notarized",
  });
  assert.deepEqual(
    artifactDescriptor(
      stagedRecord({
        fileName: "VelarOS-Workbench-1.2.3-win-x64.exe",
        platform: "win32",
        arch: "x64",
        format: "exe",
        artifactRole: "installer",
        signatureStatus: "unsigned",
      }),
    ),
    {
      platform: "win32",
      arch: "x64",
      format: "exe",
      artifactRole: "installer",
      signatureStatus: "unsigned",
    },
  );
  assert.throws(
    () => artifactDescriptor("VelarOS-Workbench-1.2.3-mac-arm64.zip"),
    /staged artifact distribution identity/u,
  );
});

test("Workbench release keeps completion state separate from the signed Cloud catalog", () => {
  assert.deepEqual(releaseManifestNames("0.3.19", "stable"), {
    completion: "candidate-workbench-v0.3.19-stable.json",
    catalog: "catalog-workbench-v0.3.19-stable.json",
  });
});

test("Workbench release notes cover the current product version", async () => {
  const { version } = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const note = await loadWorkbenchReleaseNote(version);
  assert.equal(note.softwareProduct, "workbench");
  assert.equal(note.version, version);
  assert.equal(note.added.zh.length, note.added.en.length);
  assert.equal(note.fixed.zh.length, note.fixed.en.length);
  await assert.rejects(
    loadWorkbenchReleaseNote("0.0.0-missing-note"),
    /must have exactly one release note/u,
  );
});

test("Workbench rejects a signed completion receipt without an artifact scope", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const note = releaseNote();
  const payload = { schemaVersion: 2, releaseNotes: [note], artifacts: [] };
  const catalog = {
    ...payload,
    attestation: {
      algorithm: "ed25519",
      keyId: "fixture-key",
      signature: sign(
        null,
        Buffer.from(JSON.stringify(payload)),
        privateKey,
      ).toString("base64url"),
    },
  };
  assert.throws(
    () => assertCatalogMatchesCompletion(
      catalog,
      {
        schemaVersion: 1,
        state: "candidate",
        kind: "software",
        softwareProduct: "workbench",
        version: "1.2.3",
        channel: "stable",
        releaseNotes: [note],
        platforms: [],
        artifacts: [],
      },
      {
        version: "1.2.3",
        channel: "stable",
        tag: "workbench-v1.2.3",
        sourceCommit: "a".repeat(40),
        releaseNote: note,
      },
      {
        keyId: "fixture-key",
        privateKey,
        trustedKeys: new Map([["fixture-key", publicKey]]),
      },
    ),
    /release catalog is invalid/u,
  );
});

test("Workbench rotation keys cannot replace the public key derived from the current private key", (t) => {
  const current = generateKeyPairSync("ed25519");
  const different = generateKeyPairSync("ed25519");
  const names = [
    "VELAROS_RELEASE_ATTESTATION_KEY_ID",
    "VELAROS_RELEASE_ATTESTATION_PRIVATE_KEY",
    "VELAROS_RELEASE_ATTESTATION_PUBLIC_KEYS",
  ];
  const previous = names.map((name) => process.env[name]);
  t.after(() => names.forEach((name, index) => {
    if (previous[index] === undefined) delete process.env[name];
    else process.env[name] = previous[index];
  }));
  process.env.VELAROS_RELEASE_ATTESTATION_KEY_ID = "current-key";
  process.env.VELAROS_RELEASE_ATTESTATION_PRIVATE_KEY = current.privateKey
    .export({ format: "der", type: "pkcs8" })
    .toString("base64");
  process.env.VELAROS_RELEASE_ATTESTATION_PUBLIC_KEYS = `current-key:${current.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64")}`;

  const signing = releaseSigningConfig();
  assert.deepEqual(
    signing.trustedKeys.get("current-key").export({ format: "der", type: "spki" }),
    current.publicKey.export({ format: "der", type: "spki" }),
  );

  process.env.VELAROS_RELEASE_ATTESTATION_PUBLIC_KEYS = `current-key:${different.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64")}`;
  assert.throws(releaseSigningConfig, /conflicts with the current signing key/u);
});

test("Workbench publishes the signed catalog before the completion receipt and resumes idempotently", async (t) => {
  const fixture = await releaseFixture(t);
  const first = await publishReleaseTransaction(fixture.input);
  assert.equal(first.reused, false);
  assert.equal(first.catalog.schemaVersion, 2);
  assert.deepEqual(first.catalog.releaseNotes, [fixture.input.identity.releaseNote]);
  assert.deepEqual(first.completion.releaseNotes, [fixture.input.identity.releaseNote]);
  assert.deepEqual(fixture.uploads.slice(-2), [fixture.names.catalog, fixture.names.completion]);

  const uploads = fixture.uploads.length;
  const second = await publishReleaseTransaction(fixture.input);
  assert.equal(second.reused, true);
  assert.equal(fixture.uploads.length, uploads);
});

test("Workbench catalog failure leaves no completion receipt and remains retryable", async (t) => {
  const fixture = await releaseFixture(t);
  fixture.client.failUpload = fixture.names.catalog;
  await assert.rejects(publishReleaseTransaction(fixture.input), /catalog upload failed/u);
  assert.equal(fixture.assets.has(fixture.names.completion), false);

  fixture.client.failUpload = null;
  await publishReleaseTransaction(fixture.input);
  assert.equal(fixture.uploads.at(-1), fixture.names.completion);
});

test("Workbench removes an orphaned completion receipt before retrying its catalog", async (t) => {
  const fixture = await releaseFixture(t);
  await publishReleaseTransaction(fixture.input);
  fixture.assets.delete(fixture.names.catalog);
  fixture.input.release.assets = fixture.input.release.assets.filter(
    ({ name }) => name !== fixture.names.catalog,
  );
  fixture.client.failUpload = fixture.names.catalog;

  await assert.rejects(publishReleaseTransaction(fixture.input), /catalog upload failed/u);
  assert.deepEqual(fixture.deletions, [fixture.names.completion]);
  assert.equal(fixture.assets.has(fixture.names.completion), false);

  fixture.client.failUpload = null;
  await publishReleaseTransaction(fixture.input);
  assert.deepEqual(fixture.uploads.slice(-2), [fixture.names.catalog, fixture.names.completion]);
});

test("Workbench publisher rejects an empty staged artifact before writing completion", async (t) => {
  const fixture = await releaseFixture(t, ["windows"]);
  fixture.input.staged = {
    platforms: ["macos"],
    artifacts: [{
      record: stagedRecord({
        sizeBytes: 0,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      }),
      body: Buffer.alloc(0),
    }],
  };

  await assert.rejects(
    publishReleaseTransaction(fixture.input),
    /Invalid staged Workbench artifact bytes/u,
  );
  assert.equal(fixture.assets.has(fixture.names.catalog), false);
  assert.equal(fixture.assets.has(fixture.names.completion), false);
});

test("Workbench release receipt preserves an explicit macOS-only scope", async (t) => {
  const fixture = await releaseFixture(t, ["windows"]);
  const body = Buffer.from("verified macOS package");
  const result = await publishReleaseTransaction({
    ...fixture.input,
    staged: {
      platforms: ["macos"],
      artifacts: [{
        record: stagedRecord({
          sizeBytes: body.length,
          sha256: createHash("sha256").update(body).digest("hex"),
        }),
        body,
      }],
    },
  });
  assert.deepEqual(result.completion.platforms, ["darwin-arm64"]);
  assert.equal(result.catalog.artifacts.every(({ platform }) => platform === "darwin"), true);
});

test("Workbench platform additions preserve an already verified platform", async (t) => {
  const fixture = await releaseFixture(t, ["windows"]);
  const prior = {
    kind: "software",
    softwareProduct: "workbench",
    platform: "darwin",
    arch: "arm64",
    format: "dmg",
    artifactRole: "installer",
    signatureStatus: "notarized",
    version: fixture.input.identity.version,
    channel: fixture.input.identity.channel,
    assetId: "99",
    fileName: `VelarOS-Workbench-${fixture.input.identity.version}-mac-arm64.dmg`,
    sha256: "b".repeat(64),
    sizeBytes: 123,
    githubTag: fixture.input.identity.tag,
    sourceCommit: fixture.input.identity.sourceCommit,
  };
  const result = await publishReleaseTransaction({
    ...fixture.input,
    existingArtifacts: [prior],
  });
  assert.deepEqual(result.completion.platforms, ["darwin-arm64", "win32-x64"]);
  assert.equal(result.catalog.artifacts.some(({ fileName }) => fileName === prior.fileName), true);
});

test("Workbench upgrades a verified legacy catalog while adding a native platform", async (t) => {
  const fixture = await releaseFixture(t, ["windows"]);
  const { prior } = addLegacyCompletedRelease(fixture);

  const completed = await readCompletedRelease({
    client: fixture.client,
    release: fixture.input.release,
    identity: fixture.input.identity,
    signing: fixture.input.signing,
  });
  assert.equal(completed.hasReleaseNotes, false);
  const result = await publishReleaseTransaction({
    ...fixture.input,
    existingArtifacts: completed.catalog.artifacts,
  });
  assert.equal(result.catalog.schemaVersion, 2);
  assert.deepEqual(result.catalog.releaseNotes, [fixture.input.identity.releaseNote]);
  assert.deepEqual(result.completion.platforms, ["darwin-arm64", "win32-x64"]);
  assert.equal(result.catalog.artifacts.some(({ fileName }) => fileName === prior.fileName), true);
});

test("Workbench rejects unknown, unsigned changes, and changed bytes in legacy catalogs", async (t) => {
  const fixture = await releaseFixture(t, ["windows"]);
  const { prior, catalog, catalogBytes } = addLegacyCompletedRelease(fixture);
  const readLegacy = () => readCompletedRelease({
    client: fixture.client,
    release: fixture.input.release,
    identity: fixture.input.identity,
    signing: fixture.input.signing,
  });
  const remoteCatalog = fixture.assets.get(fixture.names.catalog);

  remoteCatalog.bytes = Buffer.from(JSON.stringify({ ...catalog, schemaVersion: 7 }));
  await assert.rejects(readLegacy(), /release catalog is invalid/u);

  const changedSignature = structuredClone(catalog);
  changedSignature.attestation.signature = "A".repeat(86);
  remoteCatalog.bytes = Buffer.from(JSON.stringify(changedSignature));
  await assert.rejects(readLegacy(), /attestation verification failed/u);

  remoteCatalog.bytes = catalogBytes;
  fixture.assets.get(prior.fileName).bytes = Buffer.from("changed legacy package");
  await assert.rejects(readLegacy(), /release asset does not match its signed receipt/u);
});

test("Workbench resumes a verified catalog uploaded before its completion receipt", async (t) => {
  const fixture = await releaseFixture(t, ["windows"]);
  const { prior } = addPartialCurrentCatalog(fixture);

  const partial = await readCompletedRelease({
    client: fixture.client,
    release: fixture.input.release,
    identity: fixture.input.identity,
    signing: fixture.input.signing,
  });
  assert.equal(partial.partial, true);
  assert.equal(partial.completion, null);
  assert.equal(partial.hasReleaseNotes, true);
  assert.equal(await verifyCompletedRelease({
    client: fixture.client,
    release: fixture.input.release,
    identity: fixture.input.identity,
    signing: fixture.input.signing,
  }), false);

  const result = await publishReleaseTransaction({
    ...fixture.input,
    existingArtifacts: partial.catalog.artifacts,
  });
  assert.equal(result.catalog.schemaVersion, 2);
  assert.deepEqual(result.completion.platforms, ["darwin-arm64", "win32-x64"]);
  assert.equal(result.catalog.artifacts.some(({ fileName }) => fileName === prior.fileName), true);
  assert.equal(fixture.assets.has(fixture.names.completion), true);
});

test("Workbench recovers every verified platform after catalog replacement fails across runs", async (t) => {
  const fixture = await releaseFixture(t, ["windows"]);
  const staged = await readVerifiedStagedArtifacts({
    releaseDirectory: fixture.input.releaseDirectory,
    version: fixture.input.identity.version,
    sourceCommit: fixture.input.identity.sourceCommit,
  });
  const { prior, catalog } = addPartialCurrentCatalog(fixture);
  fixture.addRemoteAsset(
    fixture.names.completion,
    Buffer.from(JSON.stringify(completionManifest(catalog.artifacts, fixture.input.identity))),
  );
  const readAsset = fixture.client.readAsset;
  let priorReads = 0;
  fixture.client.readAsset = (release, name) => {
    if (name === prior.fileName) priorReads += 1;
    return readAsset(release, name);
  };
  const readRemoteState = () => readCompletedRelease({
    client: fixture.client,
    release: structuredClone(fixture.input.release),
    identity: fixture.input.identity,
    signing: fixture.input.signing,
  });
  const completed = await readRemoteState();
  assert.equal(completed.partial, false);

  const deleteAsset = fixture.client.delete;
  let sawPendingUnion = false;
  fixture.client.delete = async (release, name) => {
    if (name === fixture.names.completion && !sawPendingUnion) {
      sawPendingUnion = true;
      // The durable union already exists while the old canonical pair still agrees.
      const beforeRead = priorReads;
      const pending = await readRemoteState();
      assert.equal(priorReads - beforeRead, 1);
      assert.equal(pending.partial, true);
      assert.deepEqual(pending.catalog.artifacts, catalog.artifacts);
      assert.deepEqual(
        [...new Set(pending.artifacts.map(({ platform }) => platform))].sort(),
        ["darwin", "win32"],
      );
    }
    return deleteAsset(release, name);
  };
  fixture.client.failUpload = fixture.names.catalog;
  await assert.rejects(publishReleaseTransaction({
    ...fixture.input,
    staged,
    existingArtifacts: completed.artifacts,
  }), /catalog upload failed/u);
  assert.equal(sawPendingUnion, true);
  assert.equal(fixture.assets.has(fixture.names.catalog), false);
  assert.equal(fixture.assets.has(fixture.names.completion), false);

  // A new run reads only remote assets: discard both the prior union and local metadata files.
  await rm(path.join(fixture.input.releaseDirectory, fixture.names.catalog));
  const recovered = await readRemoteState();
  assert.equal(recovered.catalog, null);
  assert.equal(recovered.completion, null);
  assert.equal(recovered.partial, true);
  assert.deepEqual(recovered.artifacts.find(({ fileName }) => fileName === prior.fileName), prior);
  fixture.client.failUpload = null;
  const result = await publishReleaseTransaction({
    ...fixture.input,
    staged,
    existingArtifacts: recovered.artifacts,
  });
  assert.deepEqual(result.completion.platforms, ["darwin-arm64", "win32-x64"]);
  assert.equal(
    result.catalog.artifacts.find(({ fileName }) => fileName === prior.fileName).assetId,
    prior.assetId,
  );
  assert.equal((await readRemoteState()).partial, false);
});

test("Workbench rejects an unknown, modified, or byte-mismatched partial catalog", async (t) => {
  const fixture = await releaseFixture(t, ["windows"]);
  const { prior, priorBody, catalog, catalogBytes } = addPartialCurrentCatalog(fixture);
  const readPartial = () => readCompletedRelease({
    client: fixture.client,
    release: fixture.input.release,
    identity: fixture.input.identity,
    signing: fixture.input.signing,
  });
  const remoteCatalog = fixture.assets.get(fixture.names.catalog);

  remoteCatalog.bytes = Buffer.from(JSON.stringify({ ...catalog, schemaVersion: 7 }));
  await assert.rejects(readPartial(), /release catalog is invalid/u);

  const changedSignature = structuredClone(catalog);
  changedSignature.attestation.signature = "A".repeat(86);
  remoteCatalog.bytes = Buffer.from(JSON.stringify(changedSignature));
  await assert.rejects(readPartial(), /attestation verification failed/u);

  remoteCatalog.bytes = catalogBytes;
  fixture.assets.get(prior.fileName).bytes = Buffer.from("changed interrupted package");
  await assert.rejects(readPartial(), /release asset does not match its signed receipt/u);

  fixture.assets.get(prior.fileName).bytes = priorBody;
  assert.equal((await readPartial()).partial, true);
});

async function releaseFixture(t, selectedPlatforms = ["windows"]) {
  const root = await mkdtemp(path.join(tmpdir(), "workbench-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseDirectory = path.join(root, "stage");
  const version = "1.2.3";
  const sourceCommit = "a".repeat(40);
  const platformFixtures = [
    {
      releasePlatform: "macos",
      distribution: {
        platform: "darwin",
        arch: "arm64",
        signatureStatus: "notarized",
        evidence: ["fixture-proof"],
      },
      files: [
        [`VelarOS-Workbench-${version}-mac-arm64.dmg`, "dmg"],
        [`VelarOS-Workbench-${version}-mac-arm64.zip`, "zip"],
        ["latest-mac.yml", `version: ${version}\n`],
      ],
    },
    {
      releasePlatform: "windows",
      distribution: {
        platform: "win32",
        arch: "x64",
        signatureStatus: "unsigned",
        evidence: ["fixture-proof"],
      },
      files: [
        [`VelarOS-Workbench-${version}-win-x64.exe`, "exe"],
        [`VelarOS-Workbench-${version}-win-x64.zip`, "zip"],
        ["latest.yml", `version: ${version}\n`],
      ],
    },
    {
      releasePlatform: "linux",
      distribution: {
        platform: "linux",
        arch: "x64",
        signatureStatus: "verified",
        evidence: ["fixture-proof"],
      },
      files: [
        [`VelarOS-Workbench-${version}-linux-x86_64.AppImage`, "appimage"],
        [`VelarOS-Workbench-${version}-linux-amd64.deb`, "deb"],
        ["latest-linux.yml", `version: ${version}\n`],
      ],
    },
  ];
  for (const fixture of platformFixtures.filter(({ releasePlatform }) =>
    selectedPlatforms.includes(releasePlatform),
  )) {
    const releaseDir = path.join(root, fixture.releasePlatform);
    await mkdir(releaseDir, { recursive: true });
    await Promise.all(
      fixture.files.map(([name, body]) => writeFile(path.join(releaseDir, name), body)),
    );
    await stageReleaseArtifacts({
      releaseDir,
      stageDir: releaseDirectory,
      platform: fixture.releasePlatform,
      distribution: fixture.distribution,
      version,
      sourceSha: sourceCommit,
      releaseTag: `v${version}`,
    });
  }

  const assets = new Map();
  const uploads = [];
  const deletions = [];
  let nextAssetId = 1;
  const release = { id: 7, tag_name: `workbench-v${version}`, assets: [] };
  const client = {
    failUpload: null,
    readAsset: async (_release, name) => {
      const entry = assets.get(name);
      return entry ? { asset: entry.asset, bytes: entry.bytes } : null;
    },
    upload: async (_release, name, bytes) => {
      if (client.failUpload === name) throw new Error("catalog upload failed");
      const existing = assets.get(name);
      if (existing) {
        assert.equal(existing.bytes.equals(bytes), true);
        return String(existing.asset.id);
      }
      const asset = { id: nextAssetId++, name };
      const entry = { asset, bytes: Buffer.from(bytes) };
      release.assets.push(asset);
      assets.set(name, entry);
      uploads.push(name);
      return String(asset.id);
    },
    delete: async (_release, name) => {
      const current = assets.get(name);
      if (!current) return false;
      assets.delete(name);
      release.assets = release.assets.filter(({ id }) => id !== current.asset.id);
      deletions.push(name);
      return true;
    },
  };
  const { privateKey } = generateKeyPairSync("ed25519");
  const identity = {
    version,
    channel: "stable",
    tag: `workbench-v${version}`,
    sourceCommit,
    releaseNote: releaseNote(version),
  };
  const names = releaseManifestNames(version, identity.channel);
  return {
    assets,
    uploads,
    deletions,
    names,
    client,
    addRemoteAsset(name, bytes, id) {
      const assetId = id ?? nextAssetId++;
      nextAssetId = Math.max(nextAssetId, Number(assetId) + 1);
      const asset = { id: assetId, name };
      release.assets.push(asset);
      assets.set(name, { asset, bytes: Buffer.from(bytes) });
    },
    input: {
      client,
      release,
      releaseDirectory,
      identity,
      signing: { keyId: "fixture-key", privateKey },
    },
  };
}
