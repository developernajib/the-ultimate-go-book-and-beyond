export default `## Learning Objectives

By the end of this chapter, you will be able to:

1. **Distinguish concurrency from parallelism** and understand when each applies to your problems
2. **Master goroutine creation and lifecycle management** including proper synchronization and cleanup
3. **Design channel-based communication** using both buffered and unbuffered channels appropriately
4. **Implement the select statement** for multiplexing, timeouts, and non-blocking operations
5. **Apply fundamental concurrency patterns** including fan-out/fan-in, pipelines, and worker pools
6. **Use sync.WaitGroup correctly** avoiding common mistakes that lead to race conditions
7. **Handle errors in concurrent code** using established patterns like errgroup
8. **Prevent and detect goroutine leaks** using contexts, done channels, and runtime inspection
9. **Control runtime behavior** with GOMAXPROCS and understand the Go scheduler's impact
10. **Write concurrent programs** that are correct, efficient, and maintainable

These skills form the foundation for all advanced concurrency topics covered in subsequent chapters.

### Detailed Outcomes

**Junior to FAANG-entry track**

- Produce a worker-pool pattern from a blank file in ten minutes.
- Diagnose a data race from a code snippet and name the fix.
- Explain the semantic difference between buffered and unbuffered channels without hedging.
- Use \`go test -race\` locally and in CI and interpret its output.
- Recognise the most common concurrency mistake (spawning a goroutine without knowing how it exits) on sight.

**Mid-level engineer**

- Replace unbounded \`go\` statements with bounded worker pools or semaphores.
- Propagate \`context.Context\` through every function that might block or do I/O.
- Use \`errgroup.Group\` for concurrent-with-error-propagation patterns.
- Instrument a concurrent service with goroutine-count metrics and stuck-goroutine alerts.
- Reason about goroutine lifetime in terms of "who cancels whom" rather than ad-hoc done channels.

**Senior engineer**

- Push back in review on goroutine-per-request patterns that lack context cancellation.
- Design bounded-concurrency boundaries at every service edge (downstream RPC fan-out, DB pool, disk I/O).
- Diagnose a goroutine leak from a pprof snapshot in production.
- Own the team's concurrent-code review checklist and wire the patterns into CI via the race detector, \`govulncheck\`, and custom linters.
- Know when to reach for \`sync/atomic\`, when for \`sync.Mutex\`, and when for channels, with profile evidence.

**Staff or Principal**

- Set the org-wide discipline around context propagation, goroutine lifetime, and backpressure.
- Architect services that degrade gracefully under concurrent load via rate limiting, circuit breaking, and bounded queues.
- Lead the incident review when a concurrency bug reaches production, and drive the systemic fix (tooling, review discipline, metric) to prevent recurrence.
- Decide when the service has outgrown in-process concurrency and needs process boundaries, distributed queues, or a different architecture entirely.
- Maintain a written concurrency design guide for the org, refreshed as Go evolves (the Go 1.22 loop-var fix, Go 1.25 \`testing/synctest\`, Go 1.21 PGO).

---
`;
