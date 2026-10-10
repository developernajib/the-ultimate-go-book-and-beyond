## 25B.6 Interview Questions

### Q1: When would you use `go generate` instead of reflection, and what are the tradeoffs?
**What FAANG expects**: Candidate distinguishes compile-time code generation from runtime reflection, cites performance and type-safety gains, and names realistic use cases (stringers, mocks, protobuf, ORM bindings).
**Answer**: Use `go generate` when the inputs are known at build time and you want zero runtime cost, full type safety, and readable generated code. Reflection stays flexible for truly dynamic inputs (arbitrary JSON, plugin-defined schemas) but pays a cost in allocations, missed inlining, and weaker compile-time checks. A common rule is to generate when the schema is stable and the code runs on a hot path, and reflect when the schema is user-supplied or changes rarely. Generated code is also easier to review and debug because it lives in the repo as ordinary Go.
**Follow-ups**:
- How do you keep generated files from drifting out of sync with their sources in CI?
- What are the pitfalls of committing generated code versus regenerating on build?
- How does `go generate` interact with build tags and module boundaries?

### Q2: Explain Go's `plugin` package. Why is it rarely used in production at large scale?
**What FAANG expects**: Candidate knows the mechanics (`.so` loading, symbol lookup), the platform restrictions (Linux, macOS, and FreeBSD, but not Windows), and the operational risks (version coupling, no unloading, toolchain lockstep).
**Answer**: The `plugin` package loads a shared object at runtime and resolves exported symbols by name. It is rarely used in production because plugins must be built with the exact same Go toolchain version, the same module graph, and the same build flags as the host, which makes deployments brittle. Plugins cannot be unloaded, and Windows is unsupported. Be precise about the failure mode if asked: an ABI or version mismatch makes `plugin.Open` return an *error*, not panic, so a host can detect a bad plugin and refuse it gracefully. The panics people associate with plugins come from the type assertion after `Lookup`, which is also where the deeper problem shows: `Lookup` returns a pointer for a variable but the function value itself for a function, and a plugin-local struct type is unusable by the host, so the interface has to live in a package both sides import, which is precisely the toolchain coupling that makes the whole approach brittle. Most large-scale systems prefer out-of-process extensibility (gRPC, WebAssembly with wazero, or subprocess plugins using hashicorp/go-plugin) because those isolate crashes and decouple toolchain versions.
**Follow-ups**:
- How would you design a plugin system for a service that must stay up across plugin updates?
- Why is WebAssembly becoming the preferred plugin substrate for Go hosts?
- What are the security implications of loading untrusted `.so` files?

### Q3: Walk through `//go:embed`. What are the limits you need to know for a FAANG code review?
**What FAANG expects**: Candidate explains directive syntax, supported target types (`string`, `[]byte`, `embed.FS`), build-time constraints, and common mistakes.
**Answer**: `//go:embed` is a compiler directive that bundles files from the module tree into the binary at build time. The directive must sit directly above a package-level variable of type `string`, `[]byte`, or `embed.FS`. Paths are relative to the source file, cannot escape the module with `..`, and cannot be absolute. Symlinks are not followed. Embedded files increase binary size linearly, so large assets belong on a CDN or object store. The filesystem is read-only, which is fine for templates, migrations, and static web assets.

The detail worth raising unprompted in a review is the dot-file asymmetry: naming a directory (`//go:embed static`) skips entries beginning with `.` or `_`, but `//go:embed static/*` is a glob, and globs match dotfiles, so it silently behaves like `all:static`. That is how a stray `.env` ends up compiled into a binary and recoverable with `strings`. `all:` exists to make that inclusion deliberate.
**Follow-ups**:
- How do you serve an embedded directory over HTTP with correct content types?
- What happens to build reproducibility if embedded assets change?
- How would you support hot-reload in development while keeping `embed` in production?

### Q4: Compare Wire, Fx, and manual constructor injection. When do you pick each?
**What FAANG expects**: Candidate articulates the reflection-versus-codegen axis, startup cost, testability, and team ergonomics.
**Answer**: Manual constructor injection is the default for small and medium services. It is explicit, trivial to debug, and requires no dependencies, at the cost of boilerplate as the graph grows. Wire (Google) generates the wiring code at build time from a provider set, which keeps runtime behavior identical to hand-written code and gives compile-time errors for missing dependencies. Fx (Uber) uses reflection to assemble the graph at runtime, which adds lifecycle hooks and modular extensions but moves errors to startup. Pick manual for under roughly ten components, Wire when you want the ergonomics of a container without reflection, and Fx when you need lifecycle management across many modules and can accept the startup cost and reflection indirection.
**Follow-ups**:
- How do you write unit tests against a Wire-generated graph?
- What failure modes does Fx surface only at `app.Start` that Wire catches at compile time?
- How would you migrate a service from Fx to Wire incrementally?

### Q5: A service serializes millions of messages per second. How do you choose between `encoding/json`, `encoding/gob`, protobuf, and a zero-copy format like FlatBuffers?
**What FAANG expects**: Candidate reasons about CPU, allocations, schema evolution, interop, and benchmarking discipline.
**Answer**: Start with the interop requirement. If the wire format must be consumable by non-Go clients, `encoding/gob` is out. `encoding/json` from the standard library is fine for control-plane traffic but allocates heavily on hot paths. Protobuf with `google.golang.org/protobuf` gives compact binary encoding, schema evolution, and strong cross-language support, and it is the common baseline at FAANG scale. For extreme throughput where deserialization dominates, FlatBuffers or Cap'n Proto skip the parse step entirely by letting readers access fields directly in the buffer, at the cost of larger payloads and a stricter schema. Always benchmark with representative payloads using `testing.B` and `-benchmem`, and profile allocations before switching formats, because network and compression often dominate the decode cost.
**Follow-ups**:
- How does `encoding/json/v2` (GA in Go 1.27) change the calculus for JSON-heavy services, and when is it worth migrating?
- When is `sonic` or `go-json` worth the non-standard dependency?
- How do you evolve a protobuf schema without breaking old readers?

### Q6: You need an extensible Go service where third parties can ship custom data transforms. How do you design it in 2026?
**What FAANG expects**: Candidate rejects the `plugin` package for anything cross-platform or independently deployable, presents subprocess-RPC and WebAssembly as the two serious options, and reasons about isolation, versioning, and supply chain risk.
**Answer**: The `plugin` package is off the table for any service that targets Windows, rolls plugins independently, or accepts third-party code, it requires lockstep toolchains and offers no sandboxing. The two defensible designs are subprocess-RPC (hashicorp/go-plugin over gRPC) and WebAssembly (wazero or wasmtime-go). Subprocess-RPC gives you crash isolation, independent language choice, and simple versioning via the handshake protocol, at the cost of IPC latency and operational complexity around child process lifecycles. WebAssembly runs in-process with sandboxed memory, near-zero syscall surface, and deterministic resource limits, making it the strongest choice for untrusted code, the tradeoffs are a constrained ABI (today mostly numbers and bytes across the boundary) and a language ecosystem still maturing for complex plugins. Pick subprocess-RPC for trusted internal plugins that need full OS access, pick WebAssembly for untrusted or multi-tenant plugin scenarios.
**Follow-ups**:
- How do you bound a WebAssembly plugin's CPU and memory budget?
- What does the versioning contract look like between the host and a hashicorp/go-plugin binary?
- How would you hot-reload plugins without dropping in-flight requests?

### Q7: Walk through how you would build a migration runner backed by `embed.FS`, and what you would review for in a code review.
**What FAANG expects**: Candidate knows `embed` constraints, talks about ordering, idempotency, and the migration table, and calls out operational concerns (transactions, timeouts, production rollbacks).
**Answer**: The embed side is simple: `//go:embed migrations/*.sql` with a package-level `embed.FS`, then `fs.ReadDir` to enumerate entries and a lexical sort so filenames like `001_init.sql`, `002_users.sql` run in order. The review bar sits elsewhere: each migration must be wrapped in a transaction where the engine supports it (PostgreSQL does, MySQL DDL does not), the runner must track applied migrations in a `schema_migrations` table so re-runs are idempotent, file checksums guard against someone editing an applied migration, and long-running migrations need a statement timeout plus a documented rollback procedure. For code review I also look for: migrations gated behind a feature flag or run as a separate Kubernetes Job (not on every pod start), explicit handling of partial failures, and zero reliance on runtime filesystem access, `embed.FS` is the single source of truth shipped with the binary.
**Follow-ups**:
- Why embed migrations rather than mount them from a ConfigMap or image layer?
- How do you handle a migration that must run before application startup across a fleet of replicas?
- What is your rollback strategy for a migration that completed on some shards but not others?

### Q (Staff track): How do you set org-wide serialization standards?

**Answer**: Document the choices: JSON for external API, Protobuf for internal RPC, MessagePack for internal caching. Publish schema guidelines. Version schemas. Maintain compatibility across service boundaries. Without standards, every team picks differently and interop becomes painful.

Be specific about gob rather than listing it as a general "internal" option, because the obvious reading of "fast, Go-native, no schema" leads teams to the one place it does not belong. gob amortizes its type definitions across a single `Encoder`, so it is a good fit for a long-lived Go-to-Go stream and a bad fit for caching individual values in Redis, where each value gets a fresh encoder, pays the full type-definition cost, and ends up both slower and larger than the JSON it replaced.
