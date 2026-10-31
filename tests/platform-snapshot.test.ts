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
      schemaVersion: 1,
      repository: "VelarOS-AI/VelarOS-Platform",
      tag: "v0.6.57",
      sourceCommit: "a".repeat(40),
      packages: [
        {
          name: "@velaros-ai/core",
          version: "0.4.3",
          fileName,
          sizeBytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          integrity,
        },
      ],
    };
    const specification = platformSnapshotSpecification(snapshot.packages[0]);
    const archive = path.join(root, specification.slice("file:".length));
    await mkdir(path.dirname(archive), { recursive: true });
    await rename(packedArchive, archive);
    const snapshotFile = path.join(root, "resources/runtime-snapshot.json");
    await writeFile(snapshotFile, JSON.stringify(snapshot));
    assert.deepEqual(await verifyPlatformSnapshot(root), snapshot);
    Object.assign(snapshot.packages[0], {
      source: {
        repository: "unexpected/source",
        tag: "v0.4.3",
        sourceCommit: "b".repeat(40),
      },
    });
    await writeFile(snapshotFile, JSON.stringify(snapshot));
    await assert.rejects(
      verifyPlatformSnapshot(root),
      /Invalid dependency snapshot source/u,
    );
    Reflect.deleteProperty(snapshot.packages[0], "source");
    await writeFile(snapshotFile, JSON.stringify(snapshot));

    const lock = {
      overrides: { "@velaros-ai/core": specification },
      packages: {
        "@velaros-ai/core": [
          `@velaros-ai/core@${specification.slice(5)}`,
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
          overrides: { "@velaros-ai/core": legacySpecification },
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
        overrides: { "@velaros-ai/core": nextSpecification },
        packages: {
          "@velaros-ai/core": [
            `@velaros-ai/core@${nextSpecification.slice(5)}`,
            {},
            nextEntry.integrity,
          ],
        },
      }),
    );
    await writeFile(snapshotFile, JSON.stringify(snapshot));
    assert.throws(
      () => verifyPlatformSnapshotLock(snapshot, { ...lock, overrides: {} }),
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
