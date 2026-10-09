// 用途：准备并核对本机发布使用的 Platform 固定依赖快照。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const platformSnapshotDirectory = "build/runtime-packages";

export function platformSnapshotSpecification(entry) {
  return `file:${platformSnapshotDirectory}/${entry.fileName}`;
}

export function verifyPlatformSnapshotLock(snapshot, lockfile) {
  for (const entry of snapshot.packages) {
    const specification = platformSnapshotSpecification(entry);
    const locked = lockfile.packages?.[entry.name];
    if (
      locked?.[0] !== `${entry.name}@${specification.slice("file:".length)}` ||
      locked.at(-1) !== entry.integrity ||
      lockfile.overrides?.[entry.name] !== specification
    )
      throw new Error(
        `Platform snapshot lock identity mismatch: ${entry.name}`,
      );
  }
}

async function readPlatformSnapshot(root) {
  const snapshot = JSON.parse(
    await readFile(path.join(root, "resources/runtime-snapshot.json"), "utf8"),
  );
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.repository !== "VelarOS-AI/VelarOS-Platform" ||
    !/^v\d+\.\d+\.\d+$/u.test(snapshot.tag ?? "") ||
    !/^[a-f0-9]{40}$/u.test(snapshot.sourceCommit ?? "") ||
    !Array.isArray(snapshot.packages) ||
    snapshot.packages.length === 0
  )
    throw new Error("Invalid Platform snapshot source identity");
  const names = new Set();
  for (const entry of snapshot.packages) {
    if (
      !/^@velaros-ai\/[a-z][a-z0-9-]*$/u.test(entry.name ?? "") ||
      !/^\d+\.\d+\.\d+$/u.test(entry.version ?? "") ||
      entry.fileName !==
        `${entry.name.replace("@", "").replace("/", "-")}-${entry.version}.tgz` ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? "") ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(entry.integrity ?? "") ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes <= 0 ||
      names.has(entry.name)
    )
      throw new Error(`Invalid Platform snapshot package: ${entry.name}`);
    if (
      Object.hasOwn(entry, "source") &&
      (!entry.source ||
        entry.name !== "@velaros-ai/ui" ||
        entry.source.repository !== "VelarOS-AI/VelarOS-UI" ||
        entry.source.tag !== `v${entry.version}` ||
        !/^[a-f0-9]{40}$/u.test(entry.source.sourceCommit ?? ""))
    )
      throw new Error(`Invalid dependency snapshot source: ${entry.name}`);
    names.add(entry.name);
  }
  return snapshot;
}

async function verifyArchive(file, entry) {
  if (!(await lstat(file)).isFile())
    throw new Error(`Snapshot must be a regular archive: ${entry.name}`);
  const bytes = await readFile(file);
  if (
    bytes.length !== entry.sizeBytes ||
    createHash("sha256").update(bytes).digest("hex") !== entry.sha256 ||
    `sha512-${createHash("sha512").update(bytes).digest("base64")}` !==
      entry.integrity
  )
    throw new Error(`Platform snapshot integrity mismatch: ${entry.name}`);
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOf", path.basename(file), "package/package.json"], {
      cwd: path.dirname(file),
      encoding: "utf8",
    }),
  );
  if (manifest.name !== entry.name || manifest.version !== entry.version) {
    throw new Error(
      `Platform snapshot package identity mismatch: ${entry.name}`,
    );
  }
}

export async function verifyPlatformSnapshot(
  root,
  { downloadMissing = false } = {},
) {
  const snapshot = await readPlatformSnapshot(root);
  for (const entry of snapshot.packages) {
    const archive = path.join(root, platformSnapshotDirectory, entry.fileName);
    try {
      await lstat(archive);
    } catch (error) {
      if (error.code !== "ENOENT" || !downloadMissing) throw error;
      const archiveDirectory = path.dirname(archive);
      await mkdir(archiveDirectory, { recursive: true });
      const staging = await mkdtemp(path.join(archiveDirectory, ".download-"));
      try {
        execFileSync(
          "gh",
          [
            "release",
            "download",
            entry.source?.tag ?? snapshot.tag,
            "--repo",
            entry.source?.repository ?? snapshot.repository,
            "--pattern",
            entry.fileName,
            "--dir",
            staging,
          ],
          { stdio: "inherit" },
        );
        const downloaded = path.join(staging, entry.fileName);
        await verifyArchive(downloaded, entry);
        await rename(downloaded, archive);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    await verifyArchive(archive, entry);
  }
  return snapshot;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const unexpected = process.argv
    .slice(2)
    .filter((value) => value !== "--verify-only");
  if (unexpected.length)
    throw new Error(`Unsupported arguments: ${unexpected.join(", ")}`);
  const snapshot = await verifyPlatformSnapshot(root, {
    downloadMissing: !process.argv.includes("--verify-only"),
  });
  console.info(
    `Verified ${snapshot.packages.length} Platform snapshot packages from ${snapshot.sourceCommit}`,
  );
}
