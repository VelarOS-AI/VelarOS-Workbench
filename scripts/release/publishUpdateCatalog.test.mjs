import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { stageReleaseArtifacts } from "./releaseArtifacts.mjs";
import {
  artifactDescriptor,
  assertCatalogMatchesCompletion,
  publishReleaseTransaction,
  releaseManifestNames,
  releaseSigningConfig,
} from "./publishUpdateCatalog.mjs";

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

test("Workbench rejects a signed completion receipt without an artifact scope", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = { schemaVersion: 1, artifacts: [] };
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
        platforms: [],
        artifacts: [],
      },
      {
        version: "1.2.3",
        channel: "stable",
        tag: "workbench-v1.2.3",
        sourceCommit: "a".repeat(40),
      },
      {
        keyId: "fixture-key",
        privateKey,
        trustedKeys: new Map([["fixture-key", publicKey]]),
      },
    ),
    /completion receipt is invalid/u,
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
  const fixture = await releaseFixture(t, ["macos"]);
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
  const fixture = await releaseFixture(t, ["macos"]);
  const result = await publishReleaseTransaction(fixture.input);
  assert.deepEqual(result.completion.platforms, ["darwin-arm64"]);
  assert.equal(result.catalog.artifacts.every(({ platform }) => platform === "darwin"), true);
});

async function releaseFixture(t, selectedPlatforms = ["macos", "windows", "linux"]) {
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
      const asset = { id: release.assets.length + 1, name };
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
  };
  const names = releaseManifestNames(version, identity.channel);
  return {
    assets,
    uploads,
    deletions,
    names,
    client,
    input: {
      client,
      release,
      releaseDirectory,
      identity,
      signing: { keyId: "fixture-key", privateKey },
    },
  };
}
