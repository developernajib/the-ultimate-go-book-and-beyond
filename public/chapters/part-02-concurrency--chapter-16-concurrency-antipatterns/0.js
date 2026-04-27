export default `# Chapter 16: Concurrency Anti-Patterns & Debugging

*"The hardest bugs to find are concurrency bugs. The hardest concurrency bugs are race conditions."* - Go Community

Every production Go engineer has a story. The goroutine leak that silently consumed memory for three days before the service OOM-killed. The deadlock that only manifested under a specific load pattern and disappeared the moment anyone attached a debugger. The race condition that corrupted a user's session state exactly once per ten thousand requests, reproducible in theory, invisible in practice. Concurrency bugs are not merely harder to find than ordinary bugs. They are categorically different. They emerge from the interaction of timing, scheduling, and memory visibility in ways that cannot be reproduced by reading the code alone. Understanding them requires knowing not just what the code does but what the Go runtime and CPU are permitted to do with it.

This chapter is a field guide to the concurrency failure modes that real Go services encounter in production. Goroutine leaks, goroutines that are spawned and never exit, are the most common class. They accumulate slowly, each consuming stack memory and any resources it holds (connections, file handles, goroutines it spawned), until the service degrades or crashes. The \`goleak\` package and the goroutine pprof endpoint make them detectable. The patterns in this chapter make them preventable. Deadlocks, where two or more goroutines each wait for a resource the other holds, crash Go programs immediately with a detailed stack trace, but the trace requires careful reading to untangle. Channel misuse, from sending on a closed channel (panic) to receiving from a nil channel (blocks forever), produces failures that are obvious in hindsight but easy to write in a complex concurrent system.

Race conditions deserve their own emphasis. The Go race detector (\`-race\`) is one of the most powerful correctness tools in any language's ecosystem, it instruments every memory access at runtime and reports precisely which goroutines accessed the same memory concurrently without synchronization. But the race detector only catches races that actually execute during the test run. Its absence from an output does not prove race freedom. This chapter covers how to design tests that exercise concurrent code paths thoroughly enough for the race detector to be meaningful, how to read race reports and trace them to their root cause, and how to fix races through the full toolkit: channels, mutexes, atomics, and architectural changes that eliminate sharing entirely. Combined with the anti-pattern catalog, these debugging skills complete your ability to write concurrent Go that is not just fast but provably correct.

**What you'll learn in this chapter:**

- **Goroutine leak patterns** - the common causes (blocked channel operations, forgotten goroutines, panic in spawner), detection with \`goleak\` and pprof, and architectural fixes
- **Deadlock anatomy** - lock ordering violations, channel deadlocks, and reading Go's built-in deadlock detector output
- **Race condition identification** - using \`-race\` effectively, writing race-exercising tests, and interpreting race reports
- **Channel misuse** - sending on closed channels, nil channel semantics, unbounded channel growth, and direction type enforcement
- **Mutex anti-patterns** - lock copying, recursive locking, holding locks across I/O, and the lock-contention profile
- **Premature concurrency** - when adding goroutines makes code slower, harder to test, and more prone to failure
- **Context misuse in concurrency** - leaking goroutines by ignoring cancellation, blocking on context-unaware calls, and value store abuse
- **Debugging concurrent programs in production** - goroutine dumps, pprof mutex/block profiles, and \`GOTRACEBACK\` settings

**Why this matters at scale:**

A goroutine leak at Cloudflare caused their Go-based DNS resolver to exhaust file descriptors during a traffic spike, triggering a partial outage, post-mortem analysis showed a blocked channel receive in an error path that was never tested. A race condition in an early version of Docker's image layer cache corrupted layer metadata intermittently, a bug that took weeks to isolate because it was invisible under single-threaded test execution. GitHub's \`go-gitea\` project documented a deadlock introduced by a seemingly safe refactor that reversed lock acquisition order between two mutexes, caught only because a contributor ran the full integration suite with \`-race\`. Uber's engineering blog details how \`goleak\` became a standard part of their Go test suite after a goroutine leak in their rate limiter caused cascading failures across dozens of dependent services.

**Prerequisites:** Chapters 11-15 (all concurrency chapters). Practical experience writing concurrent Go code is strongly recommended, this chapter is most valuable when you have encountered at least some of these bugs yourself.

> **For readers new to Go concurrency:** these are the bugs you will write. Everyone does. The goal is not to avoid them forever (impossible) but to recognise them quickly when they appear and build discipline that prevents recurrence. The race detector and \`goleak\` are your friends.
>
> **For readers already senior at a FAANG-equivalent:** this chapter is the teaching material for your team. Every mid-level engineer should read it. Every incident review should reference it. Build the review discipline around this catalog.

**Chapter navigation by career stage.**

- **Junior or mid-level:** read sequentially. Each anti-pattern has a fix. Internalise the patterns so you recognise them on sight.
- **Senior:** the code-review ammunition. Flag these in PRs consistently; the team's bug rate drops over months.
- **Staff or Principal:** the incident-prevention machinery. Turn the anti-patterns into linter rules, CI gates, and review checklists.

**Staff and Principal lens: every production concurrency incident is in this chapter.** A team that has this chapter memorised has dramatically fewer concurrency incidents than a team that does not. The staff-level investment is building the culture that makes this catalog common knowledge: reference it in reviews, in postmortems, in onboarding. The principal-level investment is building the tooling that catches each anti-pattern automatically before it ships (\`goleak\` in CI, \`-race\` on every test run, custom linters for team-specific patterns).

---
`;
