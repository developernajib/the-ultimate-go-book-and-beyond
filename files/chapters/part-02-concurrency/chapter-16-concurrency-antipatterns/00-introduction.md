# Chapter 16: Concurrency Anti-Patterns & Debugging

*"The hardest bugs to find are concurrency bugs. The hardest concurrency bugs are race conditions."* - Go Community

Every production Go engineer has a story. The goroutine leak that silently consumed memory for three days before the service OOM-killed. The deadlock that only manifested under a specific load pattern and disappeared the moment anyone attached a debugger. The race condition that corrupted a user's session state exactly once per ten thousand requests, reproducible in theory, invisible in practice. Concurrency bugs are not merely harder to find than ordinary bugs. They are categorically different. They emerge from the interaction of timing, scheduling, and memory visibility in ways that cannot be reproduced by reading the code alone. Understanding them requires knowing not just what the code does but what the Go runtime and CPU are permitted to do with it.

This chapter is a field guide to the concurrency failure modes that real Go services encounter in production. Goroutine leaks, goroutines that are spawned and never exit, are the most common class. They accumulate slowly, each consuming stack memory and any resources it holds (connections, file handles, goroutines it spawned), until the service degrades or crashes. The `goleak` package and the goroutine pprof endpoint make them detectable. The patterns in this chapter make them preventable. Channel misuse, from sending on a closed channel (panic) to receiving from a nil channel (blocks forever), produces failures that are obvious in hindsight but easy to write in a complex concurrent system.

Deadlocks deserve an immediate correction, because the reassuring version of this story is false and the false version is why deadlocks reach production. Go does have a built-in deadlock detector, and it does print `all goroutines are asleep - deadlock!` and crash. Read that message carefully: **all** goroutines. The detector fires only when the runtime has literally nothing left to schedule. A server always has something left to schedule, whether an HTTP listener, a ticker, a metrics loop, or a signal handler, so in any real service the condition is never met. Two goroutines can be locked in a perfect AB-BA deadlock while one unrelated goroutine sleeps in a loop, and the runtime says nothing at all: no panic, no trace, no exit. The process hangs, holding the requests those goroutines were serving, until something external kills it.

That is the actual failure mode, and it is why the detector is a helpful tutorial aid and close to worthless in production. Deadlocks in real services are found with goroutine dumps and block profiles, which is what this chapter teaches.

Race conditions deserve their own emphasis. The Go race detector (`-race`) is one of the most powerful correctness tools in any language's ecosystem. It instruments memory accesses at runtime and reports precisely which goroutines touched the same memory concurrently without synchronization, with stack traces for both.

Know its limits as precisely as its strengths, because both matter. The detector only reports races it **actually observes executing**: a race on a code path your test never runs is a race it never sees, so a clean `-race` run is evidence, not proof. It costs real resources, roughly 2-20x CPU and 5-10x memory, which is why it belongs in CI rather than in production. And it finds *data races*, meaning unsynchronized access to the same memory, not *race conditions* in the general sense. Code built entirely from atomics has no data races by construction and can still be hopelessly wrong, as a check-then-act sequence over two atomics demonstrates. `-race` will pass it every time. This chapter covers how to design tests that exercise concurrent code paths thoroughly enough for the race detector to be meaningful, how to read race reports and trace them to their root cause, and how to fix races through the full toolkit: channels, mutexes, atomics, and architectural changes that eliminate sharing entirely. Combined with the anti-pattern catalog, these debugging skills complete your ability to write concurrent Go that is not just fast but provably correct.

**What you'll learn in this chapter:**

- **Goroutine leak patterns** - the common causes (blocked channel operations, forgotten goroutines, panic in spawner), detection with `goleak` and pprof, and architectural fixes
- **Deadlock anatomy** - lock ordering violations, channel deadlocks, and reading Go's built-in deadlock detector output
- **Race condition identification** - using `-race` effectively, writing race-exercising tests, and interpreting race reports
- **Channel misuse** - sending on closed channels, nil channel semantics, unbounded channel growth, and direction type enforcement
- **Mutex anti-patterns** - lock copying, recursive locking, holding locks across I/O, and the lock-contention profile
- **Premature concurrency** - when adding goroutines makes code slower, harder to test, and more prone to failure
- **Context misuse in concurrency** - leaking goroutines by ignoring cancellation, blocking on context-unaware calls, and value store abuse
- **Debugging concurrent programs in production** - goroutine dumps, pprof mutex/block profiles, and `GOTRACEBACK` settings

**Why this matters at scale:**

The shapes below recur across the industry, and they are worth recognizing as shapes rather than as anecdotes about particular companies.

A goroutine leak in a network service exhausts file descriptors under a traffic spike, because each leaked goroutine holds a connection. The root cause is almost always a blocked channel operation on an error path that no test exercised: the happy path returns, the error path parks forever. Leaks live in the paths you did not test.

A race in a cache corrupts entries intermittently and takes weeks to isolate, because it is invisible to a test suite that runs each test single-threaded. Sequential tests cannot find races. Only concurrent tests under `-race` can.

A refactor that looks entirely safe reverses the order in which two mutexes are acquired somewhere down a call chain, and introduces an AB-BA deadlock that appears only under production interleavings. This is why lock ordering has to be a documented, global invariant rather than something each function decides locally.

A goroutine leak in a shared library propagates into every service that depends on it, which is the reasoning behind Uber's `goleak` (`go.uber.org/goleak`) and the practice of failing tests that leave goroutines behind. Leak detection belongs in CI, not in incident review.

**Prerequisites:** Chapters 11-15 (all concurrency chapters). Practical experience writing concurrent Go code is strongly recommended. This chapter is most valuable when you have encountered at least some of these bugs yourself.

> **For readers new to Go concurrency:** these are the bugs you will write. Everyone does. The goal is not to avoid them forever (impossible) but to recognize them quickly when they appear and build discipline that prevents recurrence. The race detector and `goleak` are your friends.
>
> **For readers already senior at a FAANG-equivalent:** this chapter is the teaching material for your team. Every mid-level engineer should read it. Every incident review should reference it. Build the review discipline around this catalog.

**Chapter navigation by career stage.**

- **Junior or mid-level:** read sequentially. Each anti-pattern has a fix. Internalize the patterns so you recognize them on sight.
- **Senior:** the code-review ammunition. Flag these in PRs consistently. The team's bug rate drops over months.
- **Staff or Principal:** the incident-prevention machinery. Turn the anti-patterns into linter rules, CI gates, and review checklists.

**Staff and Principal lens: every production concurrency incident is in this chapter.** A team that has this chapter memorized has dramatically fewer concurrency incidents than a team that does not. The staff-level investment is building the culture that makes this catalog common knowledge: reference it in reviews, in postmortems, in onboarding. The principal-level investment is building the tooling that catches each anti-pattern automatically before it ships (`goleak` in CI, `-race` on every test run, custom linters for team-specific patterns).

---
