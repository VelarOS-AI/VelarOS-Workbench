# VelarOS-Workbench

VelarOS Workbench is the independently releasable IDE product in the VelarOS ecosystem. It owns
project navigation, editing, language intelligence, Git, terminals, run surfaces and local project
history while consuming the shared VelarOS Kernel contracts and `@velaros-ai/ui`.

This repository contains two workspace units:

- `apps/workbench`: the Electron application and its main/preload/renderer adapters.
- `packages/workbench`: renderer-neutral product contracts, models, hooks and composition ports.

The repository intentionally has no dependency on VelarOS Desktop internals. During sibling-repo
development, `@velaros-ai/core` and `@velaros-ai/ui` resolve from `../VelarOS-Kernel` and
`../VelarOS-UI`; the app owns the Electron implementation behind the semantic Workbench host.

The standalone app discovers the authenticated local `@velaros-ai/kernel-service` daemon and
projects handshake, health and capability-catalog state through a typed preload bridge. If the
daemon is unavailable, Workbench stays usable in an explicit retryable degraded state; it never
starts a hidden fallback Kernel or embeds Desktop.

## Development

```bash
bun install --frozen-lockfile
bun run check
bun run dev
```

Downloadable CodeMirror grammar artifacts are produced with `bun run package:grammars`. Set
`VELAROS_WORKBENCH_ARTIFACT_BASE=file:///absolute/path/to/dist-plugins/` to exercise installation
without a remote release.

## Packaging

`bun run package:mac`, `bun run package:win`, and `bun run package:linux` create application
artifacts under `release/`. Signing and notarization credentials are supplied by the release
environment; they are never stored in this repository.
