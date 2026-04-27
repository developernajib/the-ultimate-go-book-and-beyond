export default `# Chapter 11: Concurrency Fundamentals

*"Concurrency is about dealing with lots of things at once. Parallelism is about doing lots of things at once."* - Rob Pike

When Rob Pike and Ken Thompson designed Go, they embedded a concurrency model at the language's core rather than bolting it on as a library afterthought. The result, goroutines, channels, and the \`select\` statement, represents one of the most influential concurrency designs in modern systems programming. Goroutines are not threads. A fresh goroutine starts with a 2KB stack that grows and shrinks dynamically. You can spawn a million of them on a single machine in a way you simply cannot with OS threads. Channels are typed conduits that enforce communication discipline: instead of sharing memory and protecting it with locks, you communicate through the channel and let ownership transfer with the message. This inversion of the traditional model, "share memory by communicating" rather than "communicate by sharing memory", eliminates entire classes of bugs before they can be written.

Understanding the distinction between concurrency and parallelism is not merely academic. It shapes every architectural decision you make in a concurrent Go program. Concurrency is a design property: structuring a program as independently executing components. Parallelism is an execution property: running those components simultaneously on multiple cores. A program can be concurrent without being parallel (a single-threaded event loop), and a program can appear parallel without being well-structured concurrent code. Go's scheduler, the M:N scheduler that multiplexes goroutines onto OS threads, handles the parallelism transparently, but it is the programmer's job to express the concurrency correctly. Getting this wrong means data races, deadlocks, and goroutine leaks that are among the most difficult bugs to diagnose in production.

The foundations covered in this chapter underpin everything that follows in Part II. \`sync.WaitGroup\` for coordinating goroutine lifetimes, buffered vs. unbuffered channels and their semantic differences, the \`select\` statement for multiplexing across multiple channel operations, and the Go race detector as a first-class development tool, these are not advanced topics, they are the load-bearing vocabulary of concurrent Go. Engineers at Google, Uber, Netflix, and Cloudflare write concurrent Go every day. The patterns they rely on all trace back to the primitives introduced here. Building a correct mental model now will prevent hours of debugging later.

**What you'll learn in this chapter:**

- **Goroutine creation and the Go scheduler** - how goroutines differ from threads, how the M:N scheduler works, and what \`GOMAXPROCS\` controls
- **Goroutine lifecycle management** - starting, stopping, and cleaning up goroutines without leaks
- **Unbuffered vs. buffered channels** - the semantic difference, when to choose each, and common misuse patterns
- **The \`select\` statement** - multiplexing channel operations, handling timeouts, and implementing non-blocking sends and receives
- **\`sync.WaitGroup\`** - coordinating groups of goroutines and the \`Add\`/\`Done\`/\`Wait\` lifecycle
- **Data races** - what they are, why they cause undefined behavior, and how to write code that is provably race-free
- **The race detector (\`go test -race\`)** - integrating race detection into development and CI workflows
- **Goroutine dumps and debugging** - reading goroutine stack traces and diagnosing concurrency failures in production

**Why this matters at scale:**

Google's gRPC-Go library spawns a goroutine per RPC call and relies on channel-based cancellation to clean them up when clients disconnect, correct \`WaitGroup\` and channel discipline is what keeps their servers from leaking memory under load. Uber's Cadence workflow engine (and its Temporal descendant, now the default choice for most new adopters) coordinates thousands of concurrent activities using exactly the channel and \`select\` patterns introduced here. The canonical 2026 Go primitive for concurrency-limiting downstream calls is \`golang.org/x/sync/semaphore.Weighted\`, which implements the bounded-semaphore pattern once so every service does not have to rewrite it with buffered channels. Cloudflare's \`1.1.1.1\` DNS resolver handles millions of concurrent queries with goroutines that must be provably race-free, the race detector runs in their CI pipeline on every commit.

**Prerequisites:** Chapters 1-9 (Go fundamentals, interfaces, error handling, idioms). Comfort with functions as values and basic struct usage is assumed.

> **For readers new to concurrent programming:** concurrency is hard because the code runs in one order during testing and a different order in production. The bugs that result (data races, deadlocks, goroutine leaks) are notorious for being timing-dependent and hard to reproduce. Read sections 10.1 through 10.4 slowly. Use the race detector. Assume any concurrent code is wrong until the race detector and a production-load test both agree it is right.
>
> **For readers already senior at a FAANG-equivalent:** the material you use in review most is sections 10.8 (error handling) and 10.9 (goroutine leaks). These are where most production concurrency bugs originate, and the team's discipline around these two topics is the difference between a service that runs for months and one that needs quarterly restarts to shake loose leaked goroutines and accumulated memory.

**Chapter navigation by career stage.**

- **Junior or self-taught engineer (targeting FAANG-entry):** your goal is a correct mental model of the primitives. Goroutines, channels, select, WaitGroup, and the race detector. Sections 10.1 through 10.5 are the core. Interview bar expectations: produce a worker-pool pattern on a whiteboard in ten minutes, diagnose a data race from a code snippet, explain why buffered and unbuffered channels behave differently.
- **Mid-level engineer:** the trap is over-goroutining. Spawning a goroutine per item in a large slice without a bounded pool is the most common performance mistake. Sections 10.6 (patterns) and 10.9 (leaks) are the most leveraged reading for this stage.
- **Senior engineer:** the code-review ammunition is in sections 10.8 (error propagation under concurrency), 10.9 (lifetime management via context), and 10.14 (anti-patterns). A senior who applies these consistently saves the team weeks of on-call firefighting per year.
- **Staff or Principal:** the architectural question is "how does the organization handle concurrent workload across services", not "how does this one goroutine work". Rate limiting, backpressure, circuit breaking, and the interaction between goroutine lifetime and request cancellation across RPC boundaries are your topics. Sections 10.11 (production patterns), 10.12 (case studies), and 10.17 (real-world pitfalls) are the reference material for the design reviews you run.

**Staff and Principal lens: concurrency is where correctness meets scale.** At small scale, concurrency bugs are frustrating. At scale, they are career-defining incidents. A goroutine leak that loses one goroutine per request is invisible for the first hour and catastrophic by day three. A missing context cancellation propagates through the request graph and eventually ties up every worker in the system. A sync.Mutex on the wrong field creates a hot contention point that looks fine in load tests but melts under production traffic. The staff-level work is less about writing correct concurrent code (the team should do that) and more about building the detection mechanisms: metrics on goroutine counts, alerts on blocked-goroutine durations, the race detector in CI, and cultural norms around lifetime management. Principal engineers who have run a large Go service through a goroutine-leak incident once never let the team ship concurrent code without context-propagation review again.

**Go 1.26 note.** Several pieces of the concurrency story have evolved since the original goroutines-and-channels writing. \`context.Context\` is now table stakes for any goroutine that might outlive a single function call. \`errgroup.Group\` (from \`golang.org/x/sync/errgroup\`) is the canonical shape for concurrent-with-error-propagation. \`testing/synctest\` (Go 1.25) tests time-dependent concurrent code deterministically. PGO in Go 1.21+ benefits concurrent code differently than sequential code. Each section of this chapter notes the modern shape where it matters. The staff-track reading: the 2013 "here is a goroutine, here is a channel" material is necessary but not sufficient. The material that matters at scale is context propagation, bounded concurrency, and observability.

---
`;
