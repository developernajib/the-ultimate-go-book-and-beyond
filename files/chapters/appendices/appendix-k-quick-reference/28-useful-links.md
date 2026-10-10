## Official Specifications, Architecture Proposals, and Tooling Index

This section indexes the primary sources, official specifications, language design proposals, and runtime diagnostic tools that define modern production Go engineering.

---

### Official Language Specifications & Design
- **The Go Programming Language Specification**: https://go.dev/ref/spec
  - The authoritative grammar, lexical elements, and type system rules of the Go language.
- **The Go Memory Model**: https://go.dev/ref/mem
  - Formal specification of data races, synchronized memory events, channel communication happens-before guarantees, and atomic operations.
- **Effective Go**: https://go.dev/doc/effective_go
  - Seminal guide to writing clear, idiomatic Go code.
- **Go Diagnostics & Profiling Guide**: https://go.dev/doc/diagnostics
  - Official manual for pprof CPU/memory profiling, execution tracing, and race detection.
- **Go Garbage Collector Guide**: https://go.dev/doc/gc-guide
  - In-depth guide to GC pacing, `GOGC`, soft memory ceilings (`GOMEMLIMIT`), and memory latency tuning.

---

### Seminal Language Design Proposals
- **Type Parameters (Generics)**: https://go.dev/design/43651-type-parameters
  - Complete architectural design of Go's type parameter system, constraints, and interface sets.
- **Range-Over-Func Iterators**: https://go.dev/issue/61405
  - Design document establishing language-level iterators (`iter.Seq`, `iter.Seq2`) and yield mechanics.
- **Structured Logging (log/slog)**: https://go.dev/design/59339-slog
  - Architecture of the standard structured logging package and Handler interface.
- **Next-Generation JSON (encoding/json/v2)**: https://github.com/golang/go/issues/63397
  - The active proposal for zero-allocation streaming, strict mode, and struct embedding improvements.
- **Swiss Table Hash Maps**: https://go.dev/issue/54766
  - Architecture and benchmarks for the SwissMap SIMD group-probing hash table rewrite.

---

### Production Diagnostics & Engineering Tools
- **Delve Debugger (dlv)**: https://github.com/go-delve/delve
  - The standard source-level interactive debugger for Go applications.
- **GolangCI-Lint**: https://golangci-lint.run/
  - Blazing-fast linter runner aggregating over 50 static analysis linters in parallel.
- **Go Vulnerability Scanner (govulncheck)**: https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck
  - Official vulnerability detection tool that analyzes call graphs to identify actively invoked CVEs.
- **SQLC (Compile-Time SQL Generator)**: https://sqlc.dev/
  - Generates type-safe, zero-allocation Go database code from raw, validated SQL queries.
- **Uber Go Style Guide**: https://github.com/uber-go/guide/blob/master/style.md
  - Battle-tested enterprise style standards for concurrency, error handling, and struct design.

---

### Open-Source Reference Architectures
- **Go Standard Library Source**: https://github.com/golang/go/tree/master/src
  - The finest collection of idiomatic, high-performance Go code in existence.
- **Kubernetes Repository**: https://github.com/kubernetes/kubernetes
  - Planetary-scale container orchestration written entirely in Go.
- **CockroachDB**: https://github.com/cockroachdb/cockroach
  - Distributed, ACID-compliant SQL database leveraging Go's concurrency primitives.
- **Prometheus**: https://github.com/prometheus/prometheus
  - Leading cloud-native metrics and time-series monitoring system.

---
