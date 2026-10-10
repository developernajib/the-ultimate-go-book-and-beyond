## Summary

The context package is the standard mechanism for managing request lifecycles in Go services:

| Feature | Purpose | Key Methods |
|---------|---------|-------------|
| Cancellation | Stop work when no longer needed | `WithCancel`, `WithCancelCause` (1.20), `Done()`, `Err()`, `Cause()` (1.20) |
| Deadlines | Limit operation duration | `WithDeadline`, `WithTimeout`, `WithTimeoutCause` (1.21), `Deadline()` |
| Values | Request-scoped data | `WithValue`, `Value()` |
| Detachment | Outlive the request | `WithoutCancel` (1.21) |
| Callbacks | Run on cancellation | `AfterFunc` (1.21) |

**Key Rules:**
1. Pass context as first parameter named `ctx`
2. Don't store context in structs
3. Always call cancel functions (use `defer`, on the line after `WithX`)
4. Use typed keys from an unexported type for context values
5. Select on `ctx.Done()` in long-running operations, and `return ctx.Err()` rather than a bare `break`
6. Context values for request-scoped data only, never dependencies or mutable state
7. Don't pass nil context, use `context.Background()` or `context.TODO()`
8. Never hand a request context to work that must outlive the request. Use `context.WithoutCancel` plus your own timeout

**Context Flows:**
- Cancellation flows DOWN (parent → children), never up, never sideways
- Values are looked up UP the chain (child → parent)
- Deadlines use the minimum of parent and self, so a child can only ever shorten, never extend

**Measured costs** (8-core laptop CPU, section 14.9): `ctx.Done()` ~3ns, `Value` at depth 1 ~5ns, `WithValue` ~35ns, `WithCancel` ~148ns and **no goroutine**, `WithTimeout` ~436ns plus an armed timer. All negligible against I/O. The only one worth thinking about is `WithTimeout` in a tight loop.

The context package enables proper request lifecycle management, making services more reliable and debuggable.

### For the Senior-at-FAANG Track

Push back on context anti-patterns in review: context stored in structs, context values smuggling dependencies, context not propagated to database or RPC calls, a request context handed to a fire-and-forget goroutine, a bare `break` inside a `select`.

Know which ones the tools already cover so you spend attention where it counts. `go vet`'s `lostcancel` catches a discarded cancel *and* a cancel missed on one path, naming the exact `return`. `staticcheck` catches basic-type keys (SA1029) and nil contexts (SA1012). Everything else on that list is invisible to every linter and passes every test, because context bugs are timing bugs: they need production concurrency to appear. Those are the ones review exists for.

### For the Staff and Principal Track

The org-wide deliverable is end-to-end deadline propagation: every service respects the incoming deadline and propagates it to every downstream call. Without this invariant, slow dependencies burn capacity on work no client is still waiting for. Drive the rollout, enforce it via middleware and integration tests, and monitor it via tracing. This is unglamorous work that pays compound dividends in incident prevention.

### Mental Model to Take Away

Context is the plumbing that makes concurrent Go services debuggable and well-behaved. It is not glamorous, but it is the layer beneath every correct shutdown, every observable cancellation, every propagated deadline. A codebase with disciplined context usage runs cleaner and fails faster. A codebase without it accumulates invisible bugs that surface as mysterious latency, leaked goroutines, and shutdown problems. Invest in context discipline early. It is cheaper than the alternative.

---
