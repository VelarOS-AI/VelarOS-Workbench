import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { validateStagedRelease } from "./releaseArtifacts.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const FileNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const LocalReleasePlatformByHost = Object.freeze({
  darwin: "macos",
  win32: "windows",
  linux: "linux",
});

function resolveLocalReleaseRequest(
  args = process.argv.slice(2),
  hostPlatform = process.platform,
) {
  const forwarded = args[0] === "--" ? args.slice(1) : [...args];
  if (forwarded.length !== 2) {
    throw new Error(
      "Usage: publishUpdateCatalog.mjs <macos|windows|linux> <platform-stage-directory>",
    );
  }
  const [releasePlatform, releaseDirectory] = forwarded;
  const nativePlatform = LocalReleasePlatformByHost[hostPlatform];
  if (!nativePlatform) {
    throw new Error(`Unsupported local Workbench release host: ${hostPlatform}`);
  }
  if (releasePlatform !== nativePlatform) {
    throw new Error(
      `${releasePlatform} Workbench candidates must be finalized on ${nativePlatform === "macos" ? "macOS" : nativePlatform}; current host publishes ${nativePlatform} only`,
    );
  }
  if (!releaseDirectory?.trim()) {
    throw new Error("Workbench local release stage directory is required");
  }
  return { releasePlatform, releaseDirectory };
}

function assertSingleLocalPlatform(stagedPlatforms, releasePlatform) {
  if (
    stagedPlatforms.length !== 1 ||
    stagedPlatforms[0] !== releasePlatform
  ) {
    throw new Error(
      `Local Workbench finalization requires exactly one ${releasePlatform} stage receipt`,
    );
  }
}

function requireEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required to publish Workbench updates`);
  return value;
}

function sortCanonicalValue(value) {
  if (Array.isArray(value)) return value.map(sortCanonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, sortCanonicalValue(value[key])]),
    );
  }
  return value;
}

function artifactDescriptor(record) {
  if (
    !record ||
    typeof record.fileName !== "string" ||
    path.basename(record.fileName) !== record.fileName ||
    !["darwin", "win32", "linux"].includes(record.platform) ||
    !["arm64", "x64"].includes(record.arch) ||
    !["installer", "update-package", "update-metadata"].includes(
      record.artifactRole,
    ) ||
    !["dmg", "zip", "exe", "msi", "appimage", "deb", "rpm", "snap", "yml", "blockmap"].includes(
      record.format,
    ) ||
    !["unsigned", "signed", "notarized", "verified"].includes(
      record.signatureStatus,
    )
  ) {
    throw new Error("Invalid Workbench staged artifact distribution identity");
  }
  return {
    platform: record.platform,
    arch: record.arch,
    format: record.format,
    artifactRole: record.artifactRole,
    signatureStatus: record.signatureStatus,
  };
}

class ReleaseClient {
  constructor(repository, token) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
      throw new Error("VELAROS_RELEASE_REPOSITORY must be owner/repository");
    }
    this.repository = repository;
    this.token = token;
  }

  async request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "workbench-release",
        ...options.headers,
      },
    });
    if (options.allowNotFound && response.status === 404) return null;
    if (!response.ok)
      throw new Error(`GitHub request failed with HTTP ${response.status}`);
    if (response.status === 204) return null;
    const contentType = response.headers.get("content-type") ?? "";
    return contentType.includes("json")
      ? response.json()
      : response.arrayBuffer();
  }

  async getPublicRelease(tag) {
    const repository = await this.request(
      `https://api.github.com/repos/${this.repository}`,
    );
    if (repository.private !== false || repository.visibility !== "public") {
      throw new Error(`${this.repository} must remain public`);
    }
    const existing = await this.request(
      `https://api.github.com/repos/${this.repository}/releases/tags/${encodeURIComponent(tag)}`,
      { allowNotFound: true },
    );
    if (existing) {
      if (existing.draft || !existing.prerelease) {
        throw new Error(`${tag} must remain a published prerelease candidate`);
      }
    }
    return existing;
  }

  async ensurePublicRelease(tag, version, sourceCommit, existing) {
    existing ??= await this.getPublicRelease(tag);
    if (existing) return existing;
    return this.request(
      `https://api.github.com/repos/${this.repository}/releases`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tag_name: tag,
          name: `Workbench v${version} candidate`,
          body: `Public Workbench update candidate from ${sourceCommit}.`,
          draft: false,
          prerelease: true,
          make_latest: "false",
        }),
      },
    );
  }

  async readAsset(release, fileName) {
    const asset = release.assets.find((entry) => entry.name === fileName);
    if (!asset) return null;
    return {
      asset,
      bytes: Buffer.from(
        await this.request(asset.url, {
          headers: { Accept: "application/octet-stream" },
        }),
      ),
    };
  }

  async upload(release, fileName, bytes) {
    const current = await this.readAsset(release, fileName);
    if (current) {
      const body = current.bytes;
      if (body.length !== bytes.length || !body.equals(bytes)) {
        throw new Error(
          `${release.tag_name} already contains different bytes for ${fileName}`,
        );
      }
      return String(current.asset.id);
    }
    const uploadUrl = release.upload_url.replace(/\{.*$/u, "");
    const asset = await this.request(
      `${uploadUrl}?name=${encodeURIComponent(fileName)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
      },
    );
    release.assets.push(asset);
    return String(asset.id);
  }

  async delete(release, fileName) {
    const asset = release.assets.find((entry) => entry.name === fileName);
    if (!asset) return false;
    await this.request(
      `https://api.github.com/repos/${this.repository}/releases/assets/${asset.id}`,
      { method: "DELETE" },
    );
    release.assets = release.assets.filter((entry) => entry.id !== asset.id);
    return true;
  }
}

function releaseSigningConfig() {
  const keyId = requireEnvironment("VELAROS_RELEASE_ATTESTATION_KEY_ID");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(keyId)) {
    throw new Error("Workbench release attestation key ID is invalid");
  }
  const privateKey = createPrivateKey({
    key: Buffer.from(
      requireEnvironment("VELAROS_RELEASE_ATTESTATION_PRIVATE_KEY"),
      "base64",
    ),
    format: "der",
    type: "pkcs8",
  });
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Workbench release attestation key must be Ed25519");
  }
  const trustedKeys = new Map([[keyId, createPublicKey(privateKey)]]);
  const encodedTrustedKeys =
    process.env.VELAROS_RELEASE_ATTESTATION_PUBLIC_KEYS?.trim() || "";
  for (const entry of encodedTrustedKeys.split(",").map((item) => item.trim()).filter(Boolean)) {
    const separator = entry.indexOf(":");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error("VELAROS_RELEASE_ATTESTATION_PUBLIC_KEYS is invalid");
    }
    const trustedKeyId = entry.slice(0, separator);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(trustedKeyId)) {
      throw new Error(`Workbench trusted release key ID ${trustedKeyId} is invalid`);
    }
    const trustedKey = createPublicKey({
      key: Buffer.from(entry.slice(separator + 1), "base64"),
      format: "der",
      type: "spki",
    });
    if (trustedKey.asymmetricKeyType !== "ed25519") {
      throw new Error(`Workbench trusted release key ${trustedKeyId} must be Ed25519`);
    }
    const existing = trustedKeys.get(trustedKeyId);
    if (
      existing &&
      !existing.export({ format: "der", type: "spki" }).equals(
        trustedKey.export({ format: "der", type: "spki" }),
      )
    ) {
      throw new Error(
        `Workbench trusted release key ${trustedKeyId} conflicts with the current signing key`,
      );
    }
    if (!existing) trustedKeys.set(trustedKeyId, trustedKey);
  }
  return { keyId, privateKey, trustedKeys };
}

function signCatalog(payload, signing = releaseSigningConfig()) {
  return {
    ...payload,
    attestation: {
      algorithm: "ed25519",
      keyId: signing.keyId,
      signature: sign(
        null,
        Buffer.from(JSON.stringify(sortCanonicalValue(payload)), "utf8"),
        signing.privateKey,
      ).toString("base64url"),
    },
  };
}

function releaseManifestNames(version, channel) {
  return {
    completion: `candidate-workbench-v${version}-${channel}.json`,
    catalog: `catalog-workbench-v${version}-${channel}.json`,
  };
}

function completionManifest(artifacts, { version, channel }, { includeScope = true } = {}) {
  const manifest = {
    schemaVersion: 1,
    state: "candidate",
    kind: "software",
    softwareProduct: "workbench",
    version,
    channel,
    ...(includeScope
      ? {
          platforms: [...new Set(artifacts.map(({ platform, arch }) => `${platform}-${arch}`))].sort(),
        }
      : {}),
    artifacts: artifacts.map(
      ({
        assetId: _assetId,
        channel: _channel,
        githubTag: _tag,
        sourceCommit: _sourceCommit,
        ...artifact
      }) => artifact,
    ),
  };
  return manifest;
}

function assertCatalogSignature(catalog, signing) {
  const { attestation, ...payload } = catalog;
  const publicKey = signing.trustedKeys?.get(attestation?.keyId) ??
    (attestation?.keyId === signing.keyId ? createPublicKey(signing.privateKey) : null);
  if (
    attestation?.algorithm !== "ed25519" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(attestation?.keyId ?? "") ||
    !publicKey ||
    !/^[A-Za-z0-9_-]{86}$/u.test(attestation?.signature ?? "") ||
    !verify(
      null,
      Buffer.from(JSON.stringify(sortCanonicalValue(payload)), "utf8"),
      publicKey,
      Buffer.from(attestation.signature, "base64url"),
    )
  ) {
    throw new Error("Workbench release catalog attestation verification failed");
  }
}

function assertCatalogMatchesCompletion(catalog, completion, identity, signing) {
  if (
    catalog?.schemaVersion !== 1 ||
    !Array.isArray(catalog.artifacts) ||
    catalog.artifacts.length === 0 ||
    completion?.schemaVersion !== 1 ||
    completion.state !== "candidate" ||
    completion.kind !== "software" ||
    completion.softwareProduct !== "workbench" ||
    completion.version !== identity.version ||
    completion.channel !== identity.channel ||
    !Array.isArray(completion.artifacts) ||
    completion.artifacts.length === 0
  ) {
    throw new Error("Workbench completion receipt is invalid");
  }
  const rebuilt = completionManifest(catalog.artifacts, identity, {
    includeScope: Array.isArray(completion.platforms),
  });
  if (
    JSON.stringify(sortCanonicalValue(rebuilt)) !==
    JSON.stringify(sortCanonicalValue(completion))
  ) {
    throw new Error("Workbench completion receipt does not match its signed catalog");
  }
  for (const artifact of catalog.artifacts) {
    if (
      artifact.softwareProduct !== "workbench" ||
      artifact.version !== identity.version ||
      artifact.channel !== identity.channel ||
      artifact.githubTag !== identity.tag ||
      artifact.sourceCommit !== identity.sourceCommit ||
      typeof artifact.assetId !== "string" ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.sizeBytes) ||
      artifact.sizeBytes <= 0
    ) {
      throw new Error("Workbench signed catalog contains an invalid release identity");
    }
    artifactDescriptor(artifact);
  }
  assertCatalogSignature(catalog, signing);
}

async function verifyRemoteArtifacts(client, release, artifacts) {
  for (const artifact of artifacts) {
    const current = await client.readAsset(release, artifact.fileName);
    if (
      !current ||
      String(current.asset.id) !== artifact.assetId ||
      current.bytes.length !== artifact.sizeBytes ||
      createHash("sha256").update(current.bytes).digest("hex") !== artifact.sha256
    ) {
      throw new Error(
        `Workbench release asset does not match its signed receipt: ${artifact.fileName}`,
      );
    }
  }
}

async function readCompletedRelease({
  client,
  release,
  identity,
  signing,
}) {
  const names = releaseManifestNames(identity.version, identity.channel);
  const completionAsset = await client.readAsset(release, names.completion);
  if (!completionAsset) return null;
  const catalogAsset = await client.readAsset(release, names.catalog);
  if (!catalogAsset) return null;
  const completion = JSON.parse(completionAsset.bytes.toString("utf8"));
  const catalog = JSON.parse(catalogAsset.bytes.toString("utf8"));
  assertCatalogMatchesCompletion(catalog, completion, identity, signing);
  await verifyRemoteArtifacts(client, release, catalog.artifacts);
  return { catalog, completion };
}

async function verifyCompletedRelease(input) {
  return Boolean(await readCompletedRelease(input));
}

async function readVerifiedStagedArtifacts({
  releaseDirectory,
  version,
  sourceCommit,
}) {
  const artifacts = [];
  const seen = new Set();
  const manifestNames = new Set(await readdir(releaseDirectory));
  const releasePlatforms = ["macos", "windows", "linux"].filter((platformName) =>
    manifestNames.has(`workbench-${platformName}-release.json`),
  );
  if (releasePlatforms.length === 0) {
    throw new Error("No verified Workbench stage receipts were found");
  }
  for (const releasePlatform of releasePlatforms) {
    const manifest = await validateStagedRelease({
      directory: releaseDirectory,
      platform: releasePlatform,
      version,
      sourceSha: sourceCommit,
      releaseTag: `v${version}`,
    });
    for (const record of manifest.artifacts) {
      if (!FileNamePattern.test(record.fileName) || seen.has(record.fileName)) {
        throw new Error(`Invalid or duplicate staged Workbench artifact: ${record.fileName}`);
      }
      seen.add(record.fileName);
      const body = await readFile(path.join(releaseDirectory, record.fileName));
      if (
        body.length !== record.sizeBytes ||
        createHash("sha256").update(body).digest("hex") !== record.sha256
      ) {
        throw new Error(`Staged Workbench artifact changed: ${record.fileName}`);
      }
      artifacts.push({ record, body });
    }
  }
  if (artifacts.length === 0) {
    throw new Error("No Workbench update artifacts were staged");
  }
  return {
    platforms: releasePlatforms,
    artifacts: artifacts.sort((left, right) =>
      left.record.fileName.localeCompare(right.record.fileName),
    ),
  };
}

async function publishReleaseTransaction({
  client,
  release,
  releaseDirectory,
  identity,
  signing,
  staged,
  existingArtifacts = [],
}) {
  if (!staged && await verifyCompletedRelease({ client, release, identity, signing })) {
    console.info(
      `Workbench ${identity.version} ${identity.channel} receipt is already complete and verified.`,
    );
    return { reused: true };
  }
  staged ??= await readVerifiedStagedArtifacts({
    releaseDirectory,
    version: identity.version,
    sourceCommit: identity.sourceCommit,
  });
  const { completion: completionName, catalog: catalogName } =
    releaseManifestNames(identity.version, identity.channel);
  if (await client.readAsset(release, completionName)) {
    await client.delete(release, completionName);
    console.info(
      `Removed incomplete Workbench completion receipt ${completionName} before retrying.`,
    );
  }
  const artifactsByName = new Map(
    existingArtifacts.map((artifact) => [artifact.fileName, artifact]),
  );
  for (const { record, body } of staged.artifacts) {
    if (
      !Number.isSafeInteger(record.sizeBytes) ||
      record.sizeBytes <= 0 ||
      body.length !== record.sizeBytes ||
      createHash("sha256").update(body).digest("hex") !== record.sha256
    ) {
      throw new Error(`Invalid staged Workbench artifact bytes: ${record.fileName}`);
    }
    const descriptor = artifactDescriptor(record);
    const assetId = await client.upload(release, record.fileName, body);
    const artifact = {
      kind: "software",
      softwareProduct: "workbench",
      ...descriptor,
      version: identity.version,
      channel: identity.channel,
      assetId,
      fileName: record.fileName,
      sha256: record.sha256,
      sizeBytes: record.sizeBytes,
      githubTag: identity.tag,
      sourceCommit: identity.sourceCommit,
    };
    const previous = artifactsByName.get(artifact.fileName);
    if (
      previous &&
      JSON.stringify(sortCanonicalValue(previous)) !==
        JSON.stringify(sortCanonicalValue(artifact))
    ) {
      throw new Error(`Workbench platform addition changed ${artifact.fileName}`);
    }
    artifactsByName.set(artifact.fileName, artifact);
  }
  const artifacts = [...artifactsByName.values()].sort((left, right) =>
    left.fileName.localeCompare(right.fileName),
  );
  const catalog = signCatalog({ schemaVersion: 1, artifacts }, signing);
  const completion = completionManifest(artifacts, identity);
  const catalogBytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);
  await writeFile(path.join(releaseDirectory, catalogName), catalogBytes);
  if (await client.readAsset(release, catalogName)) {
    await client.delete(release, catalogName);
    console.info(`Removed prior Workbench catalog ${catalogName} before additive update.`);
  }
  await client.upload(release, catalogName, catalogBytes);
  const completionBytes = Buffer.from(
    `${JSON.stringify(completion, null, 2)}\n`,
  );
  await writeFile(path.join(releaseDirectory, completionName), completionBytes);
  await client.upload(release, completionName, completionBytes);
  console.info(
    `Workbench ${identity.version} ${identity.channel} signed catalog and completion receipt uploaded.`,
  );
  return { reused: false, catalog, completion, artifacts };
}

async function run() {
  const { releasePlatform, releaseDirectory: requestedReleaseDirectory } =
    resolveLocalReleaseRequest();
  const manifest = JSON.parse(
    await readFile(path.join(repoRoot, "package.json"), "utf8"),
  );
  const version = manifest.version;
  const sourceCommit = requireEnvironment(
    process.env.RELEASE_SOURCE_SHA ? "RELEASE_SOURCE_SHA" : "GITHUB_SHA",
  );
  const channel = process.env.VELAROS_UPDATE_CHANNEL?.trim() || "stable";
  if (!["stable", "beta", "canary"].includes(channel)) {
    throw new Error(`Unsupported Workbench update channel: ${channel}`);
  }
  const releaseDirectory = path.resolve(
    repoRoot,
    requestedReleaseDirectory,
  );
  const client = new ReleaseClient(
    requireEnvironment("VELAROS_RELEASE_REPOSITORY"),
    requireEnvironment("VELAROS_RELEASE_REPO_TOKEN"),
  );
  const tag = `workbench-v${version}`;
  const identity = { version, channel, tag, sourceCommit };
  const signing = releaseSigningConfig();
  const existing = await client.getPublicRelease(tag);
  // The stage receipts and every referenced byte must be valid before creating or mutating a release.
  const staged = await readVerifiedStagedArtifacts({
    releaseDirectory,
    version,
    sourceCommit,
  });
  assertSingleLocalPlatform(staged.platforms, releasePlatform);
  const release = await client.ensurePublicRelease(tag, version, sourceCommit, existing);
  const completed = existing
    ? await readCompletedRelease({ client, release, identity, signing })
    : null;
  const stagedPlatforms = new Set(
    staged.artifacts.map(({ record }) => `${record.platform}-${record.arch}`),
  );
  const completedPlatforms = new Set(completed?.completion.platforms ?? []);
  if (
    completed &&
    [...stagedPlatforms].every((platform) => completedPlatforms.has(platform))
  ) {
    console.info(`Workbench ${version} ${channel} requested platforms are already complete.`);
    return { reused: true };
  }
  return publishReleaseTransaction({
    client,
    release,
    releaseDirectory,
    identity,
    signing,
    staged,
    existingArtifacts: completed?.catalog.artifacts ?? [],
  });
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export {
  artifactDescriptor,
  assertSingleLocalPlatform,
  assertCatalogMatchesCompletion,
  completionManifest,
  publishReleaseTransaction,
  readCompletedRelease,
  releaseManifestNames,
  releaseSigningConfig,
  resolveLocalReleaseRequest,
  sortCanonicalValue,
  verifyCompletedRelease,
};
