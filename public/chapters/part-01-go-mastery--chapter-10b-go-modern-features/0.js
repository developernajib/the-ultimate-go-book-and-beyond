export default `# Chapter 10B: Go 1.23-1.26 Modern Features

*"The goal of the Go project is to make Go the best language for scalable systems software. Every release brings us closer."* - Rob Pike

Go's release cadence has always been deliberate and conservative. The language team prioritizes stability and simplicity over chasing feature trends. That restraint makes the window from Go 1.23 through 1.26 all the more remarkable. These releases collectively deliver the most transformative set of improvements since generics arrived in 1.18. Iterators via range-over-func reshape how Go developers write lazy sequences and custom collection traversals. Swiss Table maps replace the runtime's internal hash map implementation with a modern open-addressing design that meaningfully improves throughput in allocation-sensitive hot paths. Profile-Guided Optimization matures from experimental to production-ready, enabling the compiler to reshape inlining and branch prediction based on real workload data. Each of these features rewards developers who take the time to understand not just the API but the underlying rationale.

The improvements do not stop at language features. The \`slog\` structured logging package, stabilized and extended across these releases, finally gives Go a first-class answer to the structured logging problem that the ecosystem had previously solved through a fragmented mix of \`zerolog\`, \`zap\`, and \`logrus\`. The \`slices\` and \`maps\` packages in the standard library bring type-safe, generic collection utilities that eliminate entire categories of hand-rolled helper functions. The \`math/rand/v2\` package corrects long-standing API decisions, dropping the global source that made testing non-deterministic, providing \`N\` and \`IntN\` with cleaner semantics, and using a higher-quality default PRNG. For experienced Go developers, upgrading to these packages is not optional polish. It is the correct default for any new code.

Understanding Go 1.23-1.26 is increasingly a prerequisite for contributing to modern Go codebases. Companies that adopted Go early (Cloudflare, Datadog, PlanetScale) are already migrating internal tooling to use PGO and the new GC's improved tail-latency characteristics. Open-source projects like \`kubernetes/kubernetes\` and \`etcd\` track Go releases closely, and their changelogs explicitly reference stdlib upgrades to \`slog\`, \`slices\`, and the new iterator model. This chapter gives you a thorough grounding in each major feature, the mental model to use it correctly, and the judgment to know when a new capability genuinely improves your code versus when the older idiom is still the right tool.

**What you will learn in this chapter:**

- **Range-over-func iterators** - understanding \`iter.Seq\`/\`iter.Seq2\`, push vs. pull iterator models, and writing custom collection iterators
- **Swiss Table map internals** - what changed in Go 1.24's map runtime, when it matters, and how to measure the difference
- **Profile-Guided Optimization** - setting up PGO in CI/CD, reading CPU profiles, and validating gains in real services
- **\`slog\` structured logging** - using handlers, attributes, groups, and log levels idiomatically in production services
- **\`slices\` and \`maps\` packages** - replacing hand-written helpers with type-safe stdlib functions for sorting, searching, and transforming collections
- **\`math/rand/v2\` migration** - understanding the new API, its PRNG choices, and how to migrate existing code safely
- **Green Tea GC (Go 1.26)** - what changed in the garbage collector, how to measure latency impact, and relevant tuning knobs
- **Goroutine leak detection** - using the new \`goroutineleak\` pprof profile to find and fix blocked goroutines in production

**Why this matters at scale:**

Cloudflare runs Go at the edge handling millions of HTTP requests per second. Their engineering blog documents measurable p99 latency improvements after adopting PGO in their DNS resolver. Datadog's agent, written in Go, migrated logging to \`slog\` and eliminated a custom logging abstraction layer that had accumulated years of technical debt. PlanetScale's MySQL-compatible serverless database uses Swiss Table map performance improvements in its query planner's internal caches. For any team running Go services under load, these features collectively translate to fewer CPU cores, lower memory pressure, and more observable, debuggable production systems.

**Prerequisites:** Chapters 1-9 (Go fundamentals through composition and idioms). Go 1.23 or later installed. Familiarity with benchmarking via \`go test -bench\` is helpful.

---
`;
