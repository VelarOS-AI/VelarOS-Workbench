# Local Kernel package tarballs

These are packed from the sibling `VelarOS-Kernel` checkout for local development
while `@velaros-ai/kernel-client` / `kernel-sdk` are not yet published at 0.3, and
while the private `velaros-kernel` root (Host/Runtime/Daemon) is never published.

Regenerate after rebuilding Kernel:

```bash
cd ../VelarOS-Kernel && bun run build
bun pm pack --cwd packages/kernel-sdk --destination "$(pwd)/../VelarOS-Desktop/vendor/kernel"
bun pm pack --cwd packages/kernel-client --destination "$(pwd)/../VelarOS-Desktop/vendor/kernel"
bun pm pack --cwd packages/kernel-updater --destination "$(pwd)/../VelarOS-Desktop/vendor/kernel"
# then pack the private root (see VelarOS-Kernel docs / agent scripts)
```

Products:

- Ordinary product code → `@velaros-ai/kernel-client` (+ `kernel-sdk` only for Mod authors)
- Electron composition root that *hosts* the shared daemon → also `velaros-kernel/{host,runtime,daemon,internal}`
