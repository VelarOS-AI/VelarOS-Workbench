# Language Support

VelarOS Workbench bundles editor syntax independently of optional local compiler toolchains.

## First-class languages

- VelarScript (`.vel`): built-in syntax and project-local `velar lsp`.
- JavaScript / TypeScript (`.js`, `.jsx`, `.ts`, `.tsx`, ESM variants): built-in
  TypeScript semantic service, linting, formatting, navigation, and Web syntax.
- Python (`.py`, `.pyi`): built-in syntax and the Workbench-owned `pyright`
  runtime dependency through the shared stdio LSP client. A project-local
  `pyright-langserver` remains a development fallback.
- Vue (`.vue`): SFC template directives/interpolations, TypeScript/JavaScript script blocks,
  and CSS/Less/SCSS/Sass style blocks. The bundled `@vue/language-server` is pinned to
  2.2.12 and runs in standalone mode with Workbench's TypeScript SDK, so script and
  template semantics work without a separate tsserver plugin or project-installed server.
  Keep this pin until a replacement supports standalone operation or the host implements
  the newer server's companion TypeScript protocol.
- Java, C#, Go, Rust, Dart, Swift, Kotlin, WebAssembly text and GLSL: built-in syntax,
  language labels, comments/indentation and file identification; semantic requests use
  the shared stdio LSP client and locally installed servers listed below.
- Related Web formats: HTML, CSS, SCSS, Less, Sass, JSON, and Markdown. Less and SCSS
  use their own parsers plus the bundled CSS language service. Indented `.sass` uses
  the Sass parser; it is intentionally excluded from the CSS/SCSS semantic service
  to avoid false diagnostics. Vue style blocks use the corresponding parser too.
- Common project formats: YAML, XML/SVG, SQL, TOML, shell scripts,
  Dockerfile/Containerfile, INI/Properties, and `.env` variants. These use
  bundled editor parsers for syntax, indentation, and bracket structure; they
  do not pretend to provide a schema-aware language server when none is
  configured by the project.

C/C++ support is outside this language expansion. `.wasm` files remain binary;
editable WebAssembly source uses `.wat` / `.wast`. Markdown code fences recognize
the new language names, including `wasm` as a WebAssembly text alias.

## Local language services

Syntax works immediately. Completion, diagnostics, navigation, rename and formatting
are forwarded according to the server's advertised LSP capabilities. Install the
language's SDK and put the server command on `PATH`; missing servers produce the
existing actionable language-service message. Opening a file does not download tools.

| Language | Files | Language server |
| --- | --- | --- |
| Java | `.java` | [`jdtls`](https://github.com/eclipse-jdtls/eclipse.jdt.ls), with a compatible JDK |
| C# | `.cs`, `.csx` | [`csharp-ls`](https://github.com/razzmatazz/csharp-language-server), with .NET SDK |
| Go | `.go` | [`gopls`](https://go.dev/gopls/) |
| Rust | `.rs` | [`rust-analyzer`](https://rust-analyzer.github.io/book/installation.html) |
| Dart / Flutter | `.dart` | Dart SDK's `dart language-server --protocol=lsp` |
| Swift | `.swift` | [`sourcekit-lsp`](https://github.com/swiftlang/sourcekit-lsp), with Swift toolchain |
| Kotlin | `.kt`, `.kts` | [`intellij-server --stdio`](https://github.com/Kotlin/kotlin-lsp); `kotlin-lsp --stdio` is a launcher fallback |
| WebAssembly text | `.wat`, `.wast` | [`wat_server`](https://github.com/g-plane/wasm-language-tools) |
| GLSL | `.glsl`, `.vert`, `.frag`, `.geom`, `.tesc`, `.tese`, `.comp`, `.vsh`, `.fsh` | [`glsl_analyzer`](https://github.com/nolanderc/glsl_analyzer) |

Runtime roots follow project markers such as `pom.xml`, Gradle settings, `go.mod`,
`Cargo.toml`, `pubspec.yaml`, and `Package.swift`, within the opened workspace.
Java, C#, Rust, Swift and Kotlin allow extra time for initial indexing. Windows
executable resolution includes native binaries and `.cmd` / `.bat` SDK launchers.

## Velar built-in contribution contract

Workbench is a general editor host. Its renderer and shared core modules
contain no `.vel` association, Velar tokenizer, Velar command, or Velar protocol
branch. The built-in renderer contribution and shared service descriptor contribute
those capabilities at their composition roots and are bundled by default. This is
an injected built-in contribution, not a package or downloadable grammar system.

The built-in contribution understands only Velar Core hard and contextual
keywords, lightweight Core types, double-quoted/backtick strings, radix and
decimal numbers, bitwise operators, and indentation. It does not carry Web keywords, Web
types, JSX tags, directives, lifecycle rules, or a Web module catalog.
This includes lightweight highlighting for current contextual forms such as
`constructor`, `get`, `readonly`, `test`, and `using`, while their recognition,
ordering, diagnostics, and behavior remain wholly owned by the project-local
compiler/LSP. The editor's lightweight token list does not make those words
globally reserved source names.
It detects `velar.json` and contributes install/update plus generic
check/format/dev/test/build command metadata to the host. Dependency commands
remain Velar contribution data and do not add npm or Velar branches to the
generic Workbench command surface. It contains no
parser, analyzer, emitter, or compiler dependency; semantic behavior comes only
from the independently installed project-local `velar lsp` process. When a
format-v2 project declares `@velarscript/web`, that package contributes Web
keywords, types, modules, JSX, lifecycle semantics, completion, and semantic
tokens through the project-local compiler/LSP rather than through Workbench.

The shared LSP host carries completion, diagnostics, hover, formatting,
definition, references, rename, document symbols, signature help, type inlay
hints, same-document symbol highlights, full semantic tokens, and code actions. These are generic standard-LSP
capabilities used by Velar, Python, and future injected languages; the host does
not implement Velar symbol or type rules. It only maps standard inlay labels and
highlight ranges into language-neutral editor contracts. Semantic rename is
fail-closed: a server rejection or empty edit set never falls back to textual
occurrence replacement.
The CodeMirror layer now requests inlay hints for every semantic language
service, rather than gating the UI to TypeScript files. Its occurrence
highlight keeps a lightweight same-word fallback for plain text and Web formats,
but replaces that fallback with exact language-server document highlights for
JS/TS, Python, and injected Velar documents, so shadowed names are not merged.

Completion is equally server-owned. The installed Velar analyzer supplies
visible lexical symbols with shadowing and declaration-order rules, plus exact
member signatures for records, classes, collections, resources, actions,
enums, and runtime Types. Workbench maps ordinary standard completion items; it
has no Velar scope walker, expression resolver, Core member list, or Web-state
model. The compiler selectively indexes checked callable/member-bearing
intermediate expressions, so collection literals and chains such as
`route.params.get(...)` keep exact completion and active-parameter signatures
through the same standard requests. Member hover uses those expression facts,
and source-backed record/class members navigate by owner identity through import
aliases and inheritance. Compiler-owned references and rename include typed
record keys/destructuring and complete inherited class contracts, preserving
shorthand local bindings and rejecting hierarchy collisions atomically;
Workbench still performs only generic LSP mapping.
The same server-owned context filter distinguishes prefix-matched JSX tag names, checked
component props, native Web attributes/directives, and contextually typed object
keys. It removes ordinary keyword noise at those structural positions, offers
only missing record fields, and restores visible lexical symbols as soon as the
cursor enters a value. Workbench keeps no tag, prop, or record-field catalog.

The shared stdio transport accepts at most an 8 KiB response header and a
16 MiB request or response body. Malformed JSON, a missing length, or oversized
server output terminates that owned language-server connection and rejects its
pending requests rather than retaining an unbounded editor buffer. Individual
requests have a 15-second deadline; a stalled request is removed, receives the
standard `$/cancelRequest` notification, and fails without permanently blocking
the editor action or language-server shutdown.

Workbench negotiates the standard LSP capabilities advertised by the
project-local Velar language server instead of pinning a Velar-specific
protocol number. A normal compiler, language-server, or companion-library
update therefore does not require a Workbench rebuild. Workbench restarts the
owned server automatically when its resolved executable, `velar.json`, package
manifest, or dependency lock changes. The language-side integration contract
lives in `VelarScript/docs/contributing/workbench-integration.md`.

Language/compiler/editor changes are shipped together: specification and
examples, compiler, LSP, Workbench adapter, contract tests, then real editor and
browser validation.

The pre-release cross-repository gate accepts a Velar release-rehearsal
directory, installs every declared tarball into a temporary project, and
drives diagnostics, completion, inferred-type hints, and same-document symbol
highlights through the real generic Workbench host:

```bash
bun run test:velar:installed -- /absolute/path/to/VelarScript/release/rehearsal

# Also prove project-local companion packages without linking their source
# into Workbench.
bun run test:velar:installed -- \
  /absolute/path/to/VelarScript/release/rehearsal \
  /absolute/path/to/VelarScript-Libraries
```

The gate validates the release format, exact seven-package toolchain set (CLI,
compiler, Core, Desktop, Node, Web, and creator),
canonical tarball names, byte sizes, and SHA-256 values before npm installation.
This validation is Workbench-owned and does not import Velar compiler source.
It verifies that an inferred `List<number>` hint reaches the editor and that an
explicit `TreeNode` annotation is not duplicated; both decisions originate in
the installed compiler LSP. It also verifies that the resource handle shape is
not presented as a source annotation and that all uses of one local record
binding are highlighted without a Workbench-side symbol search.
The same packed-toolchain run completes a narrowed local and component-owned
resource/action/prop names, then completes checked List members such as
`size`, `slice`, and `map` through the generic host. It also verifies the
second active parameter of `[1, 2, 3].slice(...)`, and both Map member
completion and `get(string) -> string?` signature help for
`route.params.get(...)`. It hovers the nested `params` member and navigates
`tree.children` to the actual `TreeNode` field declaration without a host-side
field-name search, then verifies one four-site recursive-record rename through
the ordinary generic workspace-edit path. The same installed run resolves,
hovers, references, and renames `Choice.show` across its component declaration,
body use, and JSX call site. It also completes `<Ch` with the visible `Choice`
component, `</bu` with the native `button`, the `Choice` start tag with checked props, and a
typed `FormDraft` object with its missing fields, without ordinary keyword
noise. Component-prop identity remains compiler-owned;
native attributes and the protected implicit `children` contract do not create
a Workbench JSX model.
The installed `ScoreCard` sample also uses a real `constructor()` member. The
gate proves that the packed parser accepts it and compiler completion returns
`constructor`; Workbench adds no constructor or class-initialization rule.
Its ordered history is now `private`: outside instance completion omits it,
while completion on `self` inside `ScoreCard` includes the checked
`List<number>` field. Workbench only injects `private` highlighting and maps the
compiler's ordinary LSP result; it owns no class visibility or inheritance
rule.
The sample also exposes a documented `get summary() -> string` property. The
installed compiler owns its read-only type and native getter lowering, while
Workbench contributes `get` highlighting and displays the ordinary property
completion, documentation, and definition target without implementing an
accessor model.
The same packed sample uses a strict comparison chain and verifies its inferred
`bool` through generic hover and inlay hints. Parsing, single-evaluation
lowering, short-circuiting, and ordered-type rejection remain compiler-owned.
It also verifies `///` declaration documentation in completion and hover. The
generic LSP mapper already carries standard documentation fields; Workbench
does not parse, associate, persist, or type-check Velar comments.
The gate supplies only the generic language host's project-root/containment/
relative-path contract; it does not instantiate the wider Workbench workspace
runtime, so compiler-editor compatibility remains independently testable during
unrelated Platform package migrations.

The packed-toolchain run also checks a Core/Node binary sample using `Bytes`, a
fixed numeric buffer, radix literals, shifts, and bitwise operators through the
same project-local language server. Application-specific analysis and text
storage remain owned by the application instead of the VelarScript toolchain.

The installed Velar LSP now also advertises standard full semantic tokens and
narrow semantics-preserving quick fixes. The generic host maps both methods:
CodeMirror overlays semantic symbol classes on the injected syntax tokenizer,
and diagnostics expose only non-overlapping current-file edits that still match
the unchanged document. The installed gate proves declaration/property tokens
and the preferred `===`-to-`==` edit without a Velar-specific host branch.

This command is intentionally separate from the normal Workbench test suite so
the editor repository never acquires a source or package dependency on the
compiler repository.

The same installed run creates a one-source-project Desktop application and
resolves `velar/desktop`, permission-scoped `velar/fs`, and the Desktop
environment snapshot through the ordinary project-local LSP. On macOS it also
builds the installed thin WKWebView package, checks its external Node >=24 and
size-budget metadata, and runs the native bundle smoke. Workbench does not
embed a Desktop adapter or reinterpret Desktop as Electron; it consumes the
language extension contract exactly like any other Vel project.

## Runtime ownership

- Pyright is an application dependency and is included by the normal Workbench
  install/package flow; the packaged-app verifier checks both its manifest and
  language-server entry point. Users do not install a Python plugin.
- The Velar compiler remains the project's toolchain so its compiler and
  language server stay on the same version. Workbench resolves
  `node_modules/.bin/velar` before `PATH` and consumes the capabilities that
  server advertises.
- VelarScript companion packages remain ordinary project dependencies. They
  are discovered by the project-local compiler/LSP and are never bundled into
  Workbench.
- The Workbench app, compiler, and companion packages are independently
  releasable. The installed acceptance gate checks their public boundary; none
  is linked into another product in-process.
- Missing or invalid servers fail with an actionable language-service error;
  syntax color remains available while semantic features recover.
