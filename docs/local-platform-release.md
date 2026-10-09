# Local platform release

Workbench releases are built, signed, staged, and finalized on the native platform. A macOS host
publishes only the macOS candidate, a Windows host publishes only the Windows candidate, and a Linux
host publishes only the Linux candidate. Electron Builder publishing stays disabled; the maintained
publisher uploads only a verified platform stage and writes the signed candidate catalog last.

The GitHub Actions release workflow is disabled. Pushing a version tag does not package or publish a
Workbench release, and release operators do not dispatch a release workflow.

## Source identity

Use a clean checkout at the annotated version tag. Set both values to the immutable tagged commit:

```bash
export RELEASE_VERSION="$(node -p "require('./package.json').version")"
export RELEASE_TAG="v${RELEASE_VERSION}"
export RELEASE_SOURCE_SHA="$(git rev-parse "${RELEASE_TAG}^{}")"
test "$(git rev-parse HEAD)" = "$RELEASE_SOURCE_SHA"
test -z "$(git status --porcelain)"
node scripts/release/platformSnapshot.mjs
bun install --frozen-lockfile
bun run check
node scripts/release/releaseArtifacts.mjs validate-source
```

`resources/release-notes/workbench.json` is the machine-readable release-note source. The current
Workbench version must have exactly one entry with aligned `zh` and `en` fields and at least one
change item. The loader adds `softwareProduct: "workbench"` before the note enters a manifest, so
Cloud cannot interpret it as another product. Local staging and finalization stop before publishing
when that entry is missing, has a different version, or fails validation.

Platform dependency archives are pinned by `resources/runtime-snapshot.json`, restored from the private Platform Release, and verified against both archive hashes and `bun.lock`. The app ships their installed runtime files; package-registry publication is independent of the app release.

## macOS

Build and notarize arm64 artifacts into an isolated directory, then create and verify an immutable
macOS-only stage:

```bash
release_output="artifacts/releases/${RELEASE_VERSION}-official-$(git rev-parse --short=7 HEAD)/desktop"
release_stage="artifacts/release-stage/${RELEASE_TAG}-$(git rev-parse --short=7 HEAD)/macos"

bun run package:mac -- --arm64 --publish never \
  -c.directories.output="$release_output"
bun run release:local:stage -- macos "$release_output" "$release_stage"
bun run release:local:verify -- macos "$release_stage"
```

`package:mac` uses the saved `velaros-notary` Keychain profile by default and rejects any attempt to
enable Electron Builder publishing. Its `afterPack` hook runs `verifyPackagedWorkbench.mjs` to check
runtime file integrity before code signing. Signing then updates native binaries' signature metadata.
The stage command verifies the final Developer ID signature, Gatekeeper assessment, Mach-O
architecture, notarization ticket, update metadata, blockmaps, hashes, tag, source SHA, and clean
source tree.

## Windows and Linux

Run the matching package and stage command on that operating system. Cross-platform candidate
finalization is rejected.

```powershell
$releaseVersion = node -p "require('./package.json').version"
$env:RELEASE_TAG = "v$releaseVersion"
$env:RELEASE_SOURCE_SHA = git rev-parse "$env:RELEASE_TAG^{}"
node scripts/release/platformSnapshot.mjs
bun install --frozen-lockfile
bun run check
bun run package:win -- --x64
$releaseStage = "artifacts/release-stage/$($env:RELEASE_TAG)-windows"
bun run release:local:stage -- windows artifacts/desktop $releaseStage
bun run release:local:verify -- windows $releaseStage
```

```bash
release_stage="artifacts/release-stage/${RELEASE_TAG}-linux"
bun run package:linux -- --x64
bun run release:local:stage -- linux artifacts/desktop "$release_stage"
bun run release:local:verify -- linux "$release_stage"
```

### Windows application updates

Starting with 0.4.3, Windows packages include an NSIS installer for initial installation and a ZIP
for in-app updates. The packaging hook adds the update worker and `windows-update-manifest.json`.
The final packaging step adds the ZIP size and SHA-512 to `latest.yml`; the signed release catalog
also binds its SHA-256.

The updater verifies and extracts the ZIP before exit. A standalone Node process outside the
installation directory then replaces the executable and application resources, preserves user data
and the uninstaller, and rolls back failed replacements. Verify both restart-to-update and
install-on-quit on native Windows. Older updaters need one manual installation of the fixed version.

Windows builds use the checked-in `resources/icons/icon.ico`, generated from `icon.png` with
Electron Builder's icon tool. Regenerate the ICO when changing the product icon.

## Finalize the platform candidate

The finalizer requires the release repository token plus the existing Ed25519 catalog attestation
key. Supply them from the release operator's secure environment; never write them into this
repository or an artifact directory. On macOS, finalize the verified macOS stage with:

```bash
export VELAROS_RELEASE_REPOSITORY=VelarOS-AI/VelarOS-Releases
export VELAROS_RELEASE_REPO_TOKEN="$(gh auth token)"
export VELAROS_RELEASE_ATTESTATION_KEY_ID="<provided-key-id>"
export VELAROS_RELEASE_ATTESTATION_PRIVATE_KEY="<provided-base64-pkcs8-ed25519-key>"
export VELAROS_RELEASE_ATTESTATION_PUBLIC_KEYS="<trusted-key-id>:<base64-spki-ed25519-key>"
export VELAROS_UPDATE_CHANNEL=stable

bun run release:local:finalize -- macos \
  "artifacts/release-stage/${RELEASE_TAG}-$(git rev-parse --short=7 "${RELEASE_TAG}^{}")/macos"
```

The finalizer validates the single native-platform receipt before it creates or mutates a public
candidate. It reuses identical assets, rejects conflicting bytes, preserves already verified other
platforms, and writes the current bilingual release note into both manifests. The schema-2
`catalog-workbench-v<version>-stable.json` signs the note together with the artifact identities, then
`candidate-workbench-v<version>-stable.json` is uploaded last as the completion receipt. A pre-notes
schema-1 catalog is accepted only when its signature, release identity, completion receipt, and every
referenced byte verify; the next additive native-platform finalization preserves those artifacts and
upgrades the catalog to schema 2. Unknown schemas and modified catalogs remain rejected. Cloud
promotion remains a separate serialized step after the public candidate has been verified.

If finalization is interrupted after a signed catalog upload but before the completion receipt, the
next local run treats that catalog as partial state. It preserves the referenced platforms only after
the catalog signature, release identity, current release note, and every remote byte verify, then
rebuilds the completion receipt. Partial state is never reported as a completed release.
