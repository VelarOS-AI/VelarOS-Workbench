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
export RELEASE_TAG=v0.3.34
export RELEASE_SOURCE_SHA="$(git rev-parse "${RELEASE_TAG}^{}")"
test "$(git rev-parse HEAD)" = "$RELEASE_SOURCE_SHA"
test -z "$(git status --porcelain)"
bun install --frozen-lockfile
bun run check
node scripts/release/releaseArtifacts.mjs validate-source
```

## macOS

Build and notarize arm64 artifacts into an isolated directory, then create and verify an immutable
macOS-only stage:

```bash
release_output="artifacts/releases/0.3.34-official-$(git rev-parse --short=7 HEAD)/desktop"
release_stage="artifacts/release-stage/v0.3.34-$(git rev-parse --short=7 HEAD)/macos"

bun run package:mac -- --arm64 --publish never \
  -c.directories.output="$release_output"
node scripts/release/verifyPackagedWorkbench.mjs "$release_output" darwin
bun run release:local:stage -- macos "$release_output" "$release_stage"
bun run release:local:verify -- macos "$release_stage"
```

`package:mac` uses the saved `velaros-notary` Keychain profile by default and rejects any attempt to
enable Electron Builder publishing. The stage command verifies the Developer ID signature,
Gatekeeper assessment, Mach-O architecture, notarization ticket, update metadata, blockmaps, hashes,
tag, source SHA, and clean source tree.

## Windows and Linux

Run the matching package and stage command on that operating system. Cross-platform candidate
finalization is rejected.

```powershell
$env:RELEASE_TAG = "v0.3.34"
$env:RELEASE_SOURCE_SHA = git rev-parse "$env:RELEASE_TAG^{}"
bun install --frozen-lockfile
bun run check
bun run package:win -- --x64
bun run release:local:stage -- windows artifacts/desktop artifacts/release-stage/v0.3.34-windows
bun run release:local:verify -- windows artifacts/release-stage/v0.3.34-windows
```

```bash
bun run package:linux -- --x64
bun run release:local:stage -- linux artifacts/desktop artifacts/release-stage/v0.3.34-linux
bun run release:local:verify -- linux artifacts/release-stage/v0.3.34-linux
```

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
  artifacts/release-stage/v0.3.34-$(git rev-parse --short=7 "${RELEASE_TAG}^{}")/macos
```

The finalizer validates the single native-platform receipt before it creates or mutates a public
candidate. It reuses identical assets, rejects conflicting bytes, preserves already verified other
platforms, uploads the signed `catalog-workbench-v0.3.34-stable.json`, and uploads
`candidate-workbench-v0.3.34-stable.json` last as the completion receipt. Cloud promotion remains a
separate serialized step after the public candidate has been verified.
