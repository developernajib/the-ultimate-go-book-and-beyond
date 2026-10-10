## Interview Questions

**Q: What is the difference between `iter.Seq` and `iter.Seq2`?**

A: `iter.Seq[V]` yields single values via `yield func(V) bool`, while `iter.Seq2[K, V]` yields key-value pairs via `yield func(K, V) bool`. `Seq2` is used for map-like iteration. The `bool` return from `yield` indicates whether to continue, returning `false` means the consumer called `break`.

**Q: How does Swiss Tables improve map performance?**

A: Go's Swiss Tables implementation stores 8 entries per group with a control byte per slot that encodes empty, deleted, or the low 7 bits of the hash (H2, the fingerprint). Lookup hashes once, splits the hash into a group index plus fingerprint, and tests all 8 control bytes at once with SWAR bit tricks on a single 64-bit word. Only fingerprint matches trigger a full key compare. This removes the bucket-plus-overflow chaining the older Go map used, improves cache behavior, and typically delivers 30 to 60 percent faster lookups on microbenchmarks.

**Q: What is the difference between GOGC and GOMEMLIMIT for GC tuning?**

A: `GOGC` controls frequency: how much the heap can grow before triggering GC (default 100% = double). `GOMEMLIMIT` controls the maximum: a soft limit that causes the GC to run more aggressively to stay under it. For containerized services, `GOMEMLIMIT` at 90% of container limit is essential to prevent OOM kills. Use both together: GOGC for normal operation, GOMEMLIMIT as a safety net.

**Q: When should you use PGO and what's the typical speedup?**

A: Use PGO when: (1) you have a stable, representative production workload, (2) you can collect CPU profiles without impacting users, and (3) you have a CI/CD pipeline that can rebuild with profiles. The Go team documents 2 to 14 percent improvements, with the high end on workloads dominated by a few hot paths. PGO benefits come from hot-function inlining and interface devirtualization (when one concrete type dominates the call site). Collect 30-second CPU profiles during peak traffic, then rebuild with `-pgo=default.pgo`.

**Q: Why does `iter.Pull` exist when we have `iter.Seq`?**

A: Push iterators (`iter.Seq`) are simple to implement but require the consumer to work inside the `yield` callback. Pull iterators (created by `iter.Pull`) allow manual `next()` stepping, enabling: (1) merging multiple iterators (like merge-sort), (2) pausing iteration to do other work, (3) consuming two iterators in lockstep. The tradeoff is that `Pull` runs the sequence on a coroutine (a specialized goroutine switch in the runtime), so you must call `stop()` to avoid leaks.

**Q: What changed in Go 1.26's Green Tea garbage collector?**

A: Green Tea (default in 1.26, experimental in 1.25) restructures the mark phase around spans: marks accumulate per span, and the collector scans all of a span's marked small objects in one contiguous pass, with vectorized scan kernels on AVX-512 hardware. The typical payoff is 10 to 40 percent lower GC CPU on allocation-heavy services with no source change. Escape analysis, write barriers, and the tri-color invariant are unchanged. The advice "prevent unnecessary escapes" is unchanged. The collector is just faster.

**Q: When should you use `unique.Make` vs a hand-rolled string pool?**

A: Always prefer `unique.Make`. The standard library's implementation uses weak references so canonical values are released when no handle refers to them, which hand-rolled pools typically get wrong. The exception is when you need deterministic eviction semantics that the weak-reference model does not provide, in which case a hand-rolled pool with explicit eviction is the right answer.

**Q: What is `os.Root` and what attack does it prevent?**

A: `os.Root` (Go 1.24) is a sandboxed file-system access API that confines file operations to a specific directory. It resolves paths relative to an open directory descriptor with `openat`-family syscalls, one component at a time, rejecting paths that escape the root, including via symlinks. It prevents path-traversal attacks that string-based defences (checking for `..` in the path, canonicalizing with `filepath.Clean`) miss because symlink resolution races between the check and the open. If your code combines a base directory with untrusted input, `os.Root` is the idiomatic answer post-1.24.

**Q (Senior track): How would you decide whether to adopt `encoding/json/v2` today?**

A: The decision depends on three factors. First, whether your service has measurable JSON encoding/decoding CPU in pprof. If it does, the 2-3x speedup is real. If it does not, the urgency is lower. Second, whether your service has external JSON consumers that depend on the v1 serialization behavior. v2 changes some edge cases (case sensitivity, `omitempty` with explicit zero, ordering). Third, how to sequence the rollout now that v2 is GA in 1.27.1: the engine swap is free, so prioritize the v2-API migration for JSON-heavy services with round-trip tests. Migrate one internal service first to harden the playbook, then roll out fleet-wide, reserving `GOEXPERIMENT=nojsonv2` for rollback only.

**Q (Senior track): What is the operational payoff of running continuous profiling on a Go fleet?**

A: Three payoffs. First, incident diagnosis is faster: when a service starts misbehaving, the profile history tells you when the regression started, which lets you bisect deploys and commits with real data. Second, regression detection is proactive: a 5 percent CPU regression that would not trigger any alert still shows up in the profile comparison, and the team can fix it before it becomes a capacity problem. Third, optimization work is data-driven: instead of "let's optimize the thing we guess is slow", the team asks "which function shows up most in the aggregate profile across our fleet?". The infrastructure cost is small (tens to hundreds of GB of profile storage per year) compared to the diagnostic value.

---
