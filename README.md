# VelarOS-Workbench

VelarOS Workbench is the independently releasable IDE product in the VelarOS ecosystem. It owns
project navigation, editing, language intelligence, Git, terminals, run surfaces and local project
history while consuming the shared VelarOS Kernel contracts and `@velaros-ai/ui`.

This repository contains two workspace units:

- `apps/workbench`: the Electron application and its main/preload/renderer adapters.
- `packages/workbench`: renderer-neutral product contracts, models, hooks and composition ports.

The repository intentionally has no dependency on VelarOS Desktop internals. Shared VelarOS packages
come from the `VelarOS-Platform` single repository (`bun run link:local` for local checkouts); the app
owns the Electron implementation behind the semantic Workbench host.

Workbench is a **complete host**: it composes the Kernel module host *in its own process*
(kernel-contract §15) instead of connecting to a daemon. It registers exactly one capability,
`velaros.agent`, backed by an in-process `@velaros-ai/agent-runtime` execution stack. `velaros.model`
and `velaros.browser` have no implementation here, so those capabilities are simply absent and the
consumers degrade. Agent mod packs are discovered, enabled and installed by Workbench itself from
its own data root — a single owner, no cross-process mod registry.

See [docs/agent-mod-trunk.md](docs/agent-mod-trunk.md) for the mod registration trunk and the list of
capabilities this host deliberately does not have yet.

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
