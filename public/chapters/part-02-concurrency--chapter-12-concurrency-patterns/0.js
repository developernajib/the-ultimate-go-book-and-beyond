export default `# Chapter 12: Concurrency Patterns

*"Go's concurrency primitives make it easy to express complex operations. Build on simple patterns to create powerful concurrent systems."* - Go Community

Raw goroutines and channels are vocabulary. Concurrency patterns are grammar. Knowing that you can send values over a channel does not tell you how to structure a multi-stage image processing pipeline, how to scatter a database query across ten shards and merge the results, or how to bound the parallelism of an outbound HTTP fan-out so it doesn't overwhelm a downstream service. Patterns answer these questions with proven, named solutions that encode hard-won lessons from production systems. The fan-out/fan-in pattern distributes work across a dynamic pool of goroutines and collects results through a merge channel. The pipeline pattern chains stages so that each processes items concurrently with the stages before and after it, improving throughput for multi-step transformations. Done channels and \`errgroup\` add cancellation and error propagation to these structures so they fail cleanly rather than leaking goroutines when something goes wrong.

Two patterns deserve special attention because they appear constantly in production Go. The \`singleflight\` package solves the thundering herd problem: when a cache entry expires and dozens of goroutines simultaneously attempt to recompute it, \`singleflight\` collapses them into a single in-flight computation and fans the result out to all waiters. This single pattern eliminates entire categories of database overload incidents. Worker pools solve the complementary problem of bounding concurrency: instead of spawning a goroutine per task (which works fine at 1,000 tasks and fails at 1,000,000), a fixed pool of workers drains a buffered channel of work items, providing predictable memory and CPU utilization regardless of input volume.

The patterns in this chapter are deliberately ordered by composability. You will learn generators first, the simplest form of lazy concurrent production, then pipelines that chain generators and transformers, then fan-out/fan-in that parallelizes pipeline stages, and finally the cancellation, error propagation, and backpressure mechanisms that make these structures production-safe. By the end of the chapter you will be able to look at a data-processing, API-aggregation, or job-execution problem and identify which pattern or combination of patterns to apply.

**What you'll learn in this chapter:**

- **Generator pattern** - producing values lazily over channels for infinite sequences and on-demand data sources
- **Pipeline pattern** - chaining concurrent stages with proper channel plumbing, error propagation, and cancellation
- **Fan-out / fan-in** - distributing work across parallel workers and merging results with bounded concurrency
- **Done channel pattern** - propagating cancellation signals through pipeline stages before the \`context\` package existed
- **\`errgroup\` package** - running goroutine groups with automatic error collection and cancellation on first failure
- **\`singleflight\` package** - collapsing duplicate concurrent requests to prevent thundering herd on shared resources
- **Worker pool pattern** - bounding parallelism with fixed goroutine pools draining a buffered work channel
- **Backpressure and rate limiting** - designing pipelines that slow producers when consumers can't keep up

**Why this matters at scale:**

Open-source tools like \`golangci-lint\` parallelize linting passes across CPU cores using fan-out pipelines. Uber's \`peloton\` resource manager uses worker pools to bound the concurrency of task scheduling decisions, preventing scheduler storms under sudden load spikes. Cloudflare uses \`singleflight\` in their cache layer to protect origin servers from cache stampedes during high-traffic events. These same patterns appear repeatedly across production Go codebases of all sizes.

**Prerequisites:** Chapter 11 (Concurrency Fundamentals), goroutines, channels, \`select\`, \`WaitGroup\`, and the race detector. Knowledge of \`context.Context\` is helpful but will be covered where needed.

> **For readers new to concurrent design:** the patterns in this chapter look similar at first glance. Study the differences in intent (generator produces, pipeline transforms, fan-out parallelises, worker pool bounds). The patterns are composable, which means real code usually combines two or three into a specific shape. Come back to this chapter after building something concrete.
>
> **For readers already senior at a FAANG-equivalent:** the patterns here are well-known. The leverage is in the pitfalls and production-wisdom sections (11.15), the case studies, and the exercises. Use them as training material for the team rather than personal study.

**Chapter navigation by career stage.**

- **Junior:** read 11.1 through 11.5 sequentially. The generator and pipeline patterns are gateway drugs to concurrent thinking. Build a small ETL tool using these patterns before moving on.
- **Mid-level:** the leverage is in rate limiting (11.7), circuit breaker (11.8), retry (11.9). These are the resilience patterns that separate "works in happy path" from "survives downstream failure".
- **Senior:** the pitfalls section and the broadcast/sharding patterns. These are where the non-obvious bugs live and where the team's mature senior engineers need the shared vocabulary.
- **Staff or Principal:** the architectural question is "what patterns does the org's service catalog depend on, and are they implemented consistently?" Drive consolidation toward shared primitives rather than per-service reinvention.

**Staff and Principal lens: patterns as the platform's concurrent-code substrate.** At org scale, the concurrency patterns in this chapter are not things each service implements. They are things the platform team implements once, battle-tests at load, and exposes as shared libraries. The staff-level investment is the shared implementation. The principal-level investment is the discipline that keeps every new service using the shared shapes rather than writing its own. A Go org with one canonical circuit breaker is a Go org where every service degrades the same way during downstream failures, incident playbooks work across services, and senior engineers rotate across teams without learning new abstractions each time. A Go org with fifteen different circuit breakers is the opposite. The patterns are not the deliverable. The consistency is.

**Go 1.26 note.** Several patterns in this chapter have canonical stdlib or \`x/sync\` implementations: \`errgroup\` for fan-out with error propagation, \`singleflight\` for request coalescing, \`semaphore.Weighted\` for bounded concurrency, \`golang.org/x/time/rate\` for rate limiting. Prefer these over hand-rolled versions. The hand-rolled implementations shown in the chapter are teaching material. Production code uses the library versions.

---
`;
