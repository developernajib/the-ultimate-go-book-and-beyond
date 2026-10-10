## Further Reading

### Foundational
- [Go Data Structures (Russ Cox)](https://research.swtch.com/godata) - how the compiler lays out slices, maps, and interfaces
- [How Slices Work (Go Blog)](https://go.dev/blog/slices) - slice header, sharing, and `append` semantics
- [Go Slices: usage and internals](https://go.dev/blog/slices-intro)
- [Go Maps in Action (Go Blog)](https://go.dev/blog/maps) - map iteration, concurrency, zero-value behavior
- [Strings, bytes, runes and characters in Go](https://go.dev/blog/strings) - UTF-8 and the rune model
- [Go Data Model (Memory Model)](https://go.dev/ref/mem)
- [Uber Go Style Guide: Types](https://github.com/uber-go/guide/blob/master/style.md)

### 2026-Current (Go 1.21 through 1.27)
- [Go 1.24 Release Notes: Swiss Tables map implementation](https://go.dev/doc/go1.24) - what changed and what did not
- [Go 1.23 `unique` package](https://pkg.go.dev/unique) - canonical interning with GC-coordinated reclamation
- [Go 1.24 `weak` package](https://pkg.go.dev/weak) - `weak.Pointer[T]` for caches and memoization that should not retain
- [Go 1.21 `slices` package](https://pkg.go.dev/slices) - stdlib helpers that supplant hand-rolled utilities
- [Go 1.21 `maps` package](https://pkg.go.dev/maps) - `Keys`, `Values`, `Clone`, `Equal`, iterator helpers in 1.23+
- [Go 1.21 `cmp` package](https://pkg.go.dev/cmp) - ordering primitives consumed by `slices.Sort` and friends
- [`hash/maphash`](https://pkg.go.dev/hash/maphash) - `maphash.Comparable` (Go 1.24) hashes any comparable type consistently

### Senior-Track
- [Swiss Tables: Abseil's Flat Hash Map](https://abseil.io/about/design/swisstables) - the design Go 1.24 adapted
- [Dave Cheney: Slices from the Ground Up](https://dave.cheney.net/2018/07/12/slices-from-the-ground-up)
- [Dave Cheney: Padding is hard](https://dave.cheney.net/2015/10/09/padding-is-hard) - struct field alignment and memory layout
- [Faster Go maps with Swiss Tables (Go Blog)](https://go.dev/blog/swisstable) - the Go team's own write-up of the design trade-offs in the Swiss Tables port
- [Austin Clements: runtime and GC talks](https://speakerdeck.com/aclements) - background on how the collector interacts with features like `unique` and `weak.Pointer`
- [100 Go Mistakes: Types, Slices, Maps chapters](https://100go.co/) - companion errata and benchmarks

### Tooling to Wire Into CI
- [`fieldalignment`](https://pkg.go.dev/golang.org/x/tools/go/analysis/passes/fieldalignment) - struct padding analyzer, worth running on services where structs are allocated in hot paths
- [`staticcheck`](https://staticcheck.dev/) - the canonical standalone Go linter, catches most slice and map anti-patterns
- [`errcheck`](https://github.com/kisielk/errcheck) - catches discarded errors from type conversions and library calls
- [`errorlint`](https://github.com/polyfloyd/go-errorlint) - catches `==` comparisons against errors and recommends `errors.Is`
- [`exhaustive`](https://github.com/nishanths/exhaustive) - catches non-exhaustive switches on enum-shaped named types
- [`govulncheck`](https://go.dev/blog/vuln) - checks the dependency tree against the Go vulnerability database

### Performance Investigation
- [pprof documentation](https://pkg.go.dev/net/http/pprof) - the first tool to reach for when a type-related performance question arises
- [runtime/trace](https://pkg.go.dev/runtime/trace) - the second tool, for scheduler and GC interaction questions
- [`benchstat`](https://pkg.go.dev/golang.org/x/perf/cmd/benchstat) - compares Go benchmark runs statistically, essential for "is this change actually faster?" questions
- [Go performance blog](https://go.dev/doc/diagnostics) - the authoritative reference for Go-toolchain-native performance work
