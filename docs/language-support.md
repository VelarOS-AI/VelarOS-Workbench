# Focused Language Support

VelarOS Workbench intentionally supports a small, polished language surface.

## First-class languages

- VelarScript (`.vel`): built-in syntax and project-local `velar lsp`.
- JavaScript / TypeScript (`.js`, `.jsx`, `.ts`, `.tsx`, ESM variants): built-in
  TypeScript semantic service, linting, formatting, navigation, and Web syntax.
- Python (`.py`, `.pyi`): built-in syntax and the Workbench-owned `pyright`
  runtime dependency through the shared stdio LSP client. A project-local
  `pyright-langserver` remains a development fallback.
- Related Web formats: HTML, CSS, SCSS, Less, JSON, and Markdown.

Java, C/C++, Go, and Rust are deliberately outside the product scope. Workbench
does not offer downloads, recommendations, settings, protocols, or build
artifacts for them; unknown files remain plain text.

## Velar built-in contribution contract

Workbench is a general editor host. Its renderer and shared core modules
contain no `.vel` association, Velar tokenizer, Velar command, or Velar protocol
branch. The built-in renderer contribution and shared service descriptor contribute
those capabilities at their composition roots and are bundled by default. This is
an injected built-in contribution, not a package or downloadable grammar system.

The contribution understands Velar keywords, lightweight types including
`WebNode`, f-strings, indentation, JSX tags, and event-modified Web directives.
It detects `velar.json` and contributes generic check/dev/test/build plus
read-only project-upgrade-check command metadata to the host. It contains no
parser, analyzer, emitter, or compiler dependency; semantic behavior comes only
from the independently installed project-local `velar lsp` process.

The shared LSP host carries completion, diagnostics, hover, formatting,
definition, references, rename, document symbols, and signature help. These are
generic standard-LSP capabilities used by Velar, Python, and future injected
languages; the host does not implement Velar symbol or type rules. Semantic
rename is fail-closed: a server rejection or empty edit set never falls back to
textual occurrence replacement.

Workbench expects Velar language-server protocol version `1`, checks it during
LSP initialization, and reports mismatches rather than silently using an
incompatible compiler. The matching language-side contract lives in
`VelarScript/docs/workbench-integration.md`.

Language/compiler/editor changes are shipped together: specification and
examples, compiler, LSP, Workbench adapter, contract tests, then real editor and
browser validation.

The pre-release cross-repository gate accepts a Velar release-rehearsal
directory, installs its compiler and CLI tarballs into a temporary project, and
drives diagnostics and completion through the real generic Workbench host:

```bash
bun run test:velar:installed -- /absolute/path/to/VelarScript/release/rehearsal
```

This command is intentionally separate from the normal Workbench test suite so
the editor repository never acquires a source or package dependency on the
compiler repository.

## Runtime ownership

- Pyright is an application dependency and is included by the normal Workbench
  install/package flow; the packaged-app verifier checks both its manifest and
  language-server entry point. Users do not install a Python plugin.
- The Velar compiler remains the project's toolchain so its compiler and
  language server stay on the same version. Workbench resolves
  `node_modules/.bin/velar` before `PATH` and rejects protocol mismatches.
- The Workbench app and compiler are independently releasable. Joint delivery
  means their versioned protocol and acceptance tests advance together, not
  that either product links the other in-process.
- Missing or incompatible servers fail with an actionable language-service
  error; Workbench never falls back to editor-only Velar semantics.
