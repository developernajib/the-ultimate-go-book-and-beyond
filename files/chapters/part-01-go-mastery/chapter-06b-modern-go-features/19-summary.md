## Summary

Modern Go (1.21-1.27) delivers substantial ergonomic and performance improvements:

- **Iterators** (`iter.Seq`, range-over-function) enable lazy, composable data processing without intermediate allocations
- **Swiss Tables** deliver 30-60% faster map operations via SWAR control-word matching and better cache locality
- **Green Tea GC** (default since Go 1.26) cuts GC CPU by 10-40% on allocation-heavy services and trims mark-phase tail latency
- **PGO** provides 2-14% speedup by teaching the compiler about real hot paths from production profiles
- **json/v2** (experimental behind `GOEXPERIMENT=jsonv2` since Go 1.25, generally available in Go 1.27 where it also powers the classic `encoding/json` API) fixes decade-old inconsistencies with proper null handling and a faster codec
- **SIMD** acceleration is achievable through hand-written assembly, SIMD-backed standard library functions, and `golang.org/x/sys/cpu` feature detection
- **testing/synctest** (Go 1.25) eliminates non-deterministic timer-based tests with virtualized time bubbles
- **Container-aware GOMAXPROCS** (Go 1.25) automatically respects cgroup CPU limits in Kubernetes
- **Self-referential generics** (Go 1.26) enable type-safe builder patterns and algebraic type constraints
- **crypto/hpke** (Go 1.26) provides post-quantum hybrid encryption ready for production use
- **Go 1.27 (shipped August 2026, baseline 1.27.1)** adds generic methods, generalized type inference, a size-specialized allocator (up to 30% cheaper small allocations), the GA `goroutineleak` profile, and stdlib `uuid` and `crypto/mldsa` packages
- **`unique` package** (Go 1.23) provides value interning for O(1) string comparison and memory deduplication in string-heavy, high-duplication workloads
- **`os.Root`** (Go 1.24) eliminates path traversal vulnerabilities with traversal-resistant, directory-scoped file access
- **Goroutine leak detection** with `goleak` in tests and runtime tracking in production ensures operational health

These features compound: an iterator-based pipeline with PGO optimization, json/v2 encoding, and Green Tea GC can process several times more data per second with lower tail latency than equivalent Go 1.20 code, with the exact multiple depending on how allocation-heavy and JSON-heavy the workload is.

### What you should be able to do now

- Explain which Go version introduced each feature in this chapter.
- Decide whether to adopt each feature for your team's workload.
- Measure the impact of a Go version upgrade with before-and-after metrics.
- Sequence the team's adoption of new features so the team does not relitigate the same decisions.
- Maintain the team's "modern Go" baseline such that new services start at the current state of the art.

### For the senior-at-FAANG track

The institutional knowledge in this chapter is the artifact worth taking back to your team. The decision to adopt or defer each feature depends on the team's profile. The decision to set the version cadence depends on the org's risk tolerance. The decision to wire lint rules into CI depends on the team's operational maturity. None of these are one-size-fits-all, and the senior-track job is to make each decision thoughtfully and document the reasoning.

The single most effective follow-up: write your team's "what Go version are we on and why, and what does that imply for our code" document, and keep it current. The document is the reference the team reaches for when someone asks "should we use generics here?" or "should we adopt json/v2?". Without the document, each decision is made fresh, and the team loses time to the same arguments every quarter.
