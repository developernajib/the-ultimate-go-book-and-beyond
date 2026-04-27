export default `## 16.14 Interview Questions

Antipattern questions are diagnostic in FAANG interviews. The interviewer shows flawed code and expects you to spot the bug, explain why it fires only sometimes, and give the fix with the right primitive. These questions are the final filter separating candidates who "can write Go" from those who can "debug Go in production."

> **What FAANG actually tests here**: whether you can recognize the five core antipatterns (races, deadlocks, leaks, starvation, closure capture) on sight, reach for the correct tooling (race detector, goleak, testing/synctest, goroutineleak profile) without hesitation, and explain tradeoffs rather than dogma.

### Question 1: What is a race condition and how do you detect them in Go?

**What FAANG expects**: a precise definition (unsynchronized concurrent access where at least one is a write), awareness that the race detector only flags races triggered during execution (not static analysis), and discipline to enable \`-race\` in CI.

**Answer:**
A race condition occurs when two or more goroutines access shared memory concurrently, and at least one of the accesses is a write, without proper synchronization.

**Detection methods:**
1. **Race detector**: \`go run -race\` or \`go test -race\`
2. **Code review**: Look for shared variables accessed from multiple goroutines
3. **Testing**: Stress tests with high concurrency

The race detector pinpoints the exact goroutines and source lines involved, as this minimal example demonstrates:

\`\`\`go
// Example with race detector output
var count int

func increment() {
    count++  // DATA RACE
}

// Run with: go run -race main.go
// Output shows exact lines and goroutines involved
\`\`\`

**Follow-ups**:
- What does the race detector cost in CPU and memory, and when should you still run \`-race\` in production canaries?
- Why does the race detector miss races that never trigger during a test run? How do you address that?

### Question 2: Explain the difference between deadlock and livelock

**What FAANG expects**: correct definitions plus observable differences (deadlock is silent and idle, livelock burns CPU without progress), and knowledge that Go's runtime can detect only the trivial "all goroutines asleep" deadlock, not arbitrary cyclic waits.

**Answer:**

| Aspect | Deadlock | Livelock |
|--------|----------|----------|
| State | Goroutines blocked | Goroutines active |
| Progress | None | None (but busy) |
| CPU | Idle | High (wasted) |
| Detection | Runtime can detect simple cases | Harder to detect |
| Example | Circular lock wait | Two goroutines yielding to each other |

The pseudocode below contrasts the two failure modes side by side:

\`\`\`go
// Deadlock: Both goroutines wait for each other
mu1.Lock(); mu2.Lock()  // G1
mu2.Lock(); mu1.Lock()  // G2 - deadlock

// Livelock: Both goroutines keep retrying
for !canProceed {
    yield()  // Both keep yielding, neither makes progress
}
\`\`\`

**Follow-ups**:
- What triggers Go's "fatal error: all goroutines are asleep, deadlock!" message, and why does it fire in a test but often not in a long-running service?
- What tool or technique detects livelock? (hint: CPU profile plus goroutine trace showing tight retry loops)

### Question 3: How do you prevent goroutine leaks?

**What FAANG expects**: the \`context\`-first discipline (take ctx as first param, honor \`<-ctx.Done()\`), awareness of \`go.uber.org/goleak\` for tests, \`testing/synctest\` (experiment in 1.24, stable in 1.25), and Go 1.26's opt-in \`/debug/pprof/goroutineleak\` endpoint (enabled via \`GOEXPERIMENT=goroutineleakprofile\`, planned on-by-default in 1.27).

**Answer:**
1. **Always provide an exit path** using context or done channels
2. **Use \`goleak\` in tests** to detect leaks
3. **Monitor goroutine count** in production
4. **Set timeouts** on all blocking operations

A goroutine that checks \`ctx.Done()\` in its select loop will exit cleanly when the parent cancels:

\`\`\`go
func noLeak(ctx context.Context) {
    go func() {
        for {
            select {
            case <-ctx.Done():
                return  // Exit path!
            case work := <-workCh:
                process(work)
            }
        }
    }()
}
\`\`\`

**Follow-ups**:
- How would you instrument a live service to alert when goroutine count climbs without bound? What's a reasonable threshold?
- Why can't \`go.uber.org/goleak\` catch every leak, and when do you need to fall back to the runtime profile?

### Question 4: When should you use channels vs mutexes?

**What FAANG expects**: the "channels for ownership transfer, mutex for shared state" rule, honest acknowledgement that mutex is often simpler when you only need to protect a counter, and knowledge that the Go FAQ explicitly rejects channel-only dogma.

**Answer:**

| Use Channels | Use Mutex |
|--------------|-----------|
| Passing ownership of data | Protecting shared state |
| Coordinating goroutines | Simple read/write protection |
| Pipeline patterns | Fine-grained locking |
| Worker pools | When you need conditional variables |

The distinction is about data flow versus data protection:

\`\`\`go
// Channel: Passing work between goroutines
workCh <- task  // Transfer ownership

// Mutex: Protecting shared counter
mu.Lock()
count++
mu.Unlock()
\`\`\`

Rule of thumb from the Go team: "share memory by communicating, but also, don't over-engineer." A \`sync.Mutex\` protecting three fields is clearer than a channel-based coordination scheme for the same job. Channels shine when the data genuinely flows between goroutines.

**Follow-ups**:
- Give a case where a channel-based design hides a bug that a mutex would expose.
- Why does \`sync.Mutex\` outperform a buffered channel for uncontended single-counter increments?

### Question 5: How does Go's race detector work?

**What FAANG expects**: the ThreadSanitizer lineage, the happens-before graph model, the fact that it only finds races that actually fire during execution, and the 2-20x CPU / 5-10x memory overhead that makes it a CI tool, not an always-on production tool.

**Answer:**
The race detector uses ThreadSanitizer (TSan) which instruments memory accesses:

1. **Records** every memory read and write
2. **Tracks** which goroutine performed the access
3. **Maintains** a "happens-before" graph
4. **Detects** when two accesses to the same memory location are not ordered by happens-before

\`\`\`bash
# Enable race detector
go build -race ./...
go test -race ./...

# Overhead: 2-20x slower, 5-10x more memory
# Use in CI, during load tests, and in canary builds before rollout.
# Too expensive to run always-on in production, but worth running
# against a percentage of traffic or during integration suites.
\`\`\`

**Follow-ups**:
- Can the race detector produce false positives? What is a race versus a data race in the Go memory model?
- How did Go 1.25 and 1.26 change the race detector's cost or accuracy, if at all?

### Q (Senior track): Walk through diagnosing a goroutine leak in a live service.

**Answer**: Five steps.

1. **Confirm the leak.** \`runtime.NumGoroutine()\` metric trends upward monotonically.
2. **Capture two goroutine dumps 60 seconds apart.** Diff them to find growing populations.
3. **Bucket by stack.** The dominant stack in the growing bucket is the leak site.
4. **Read the stack to find the blocked line.** Usually a channel operation or mutex.
5. **Fix the lifetime.** Add context cancellation, close the sender, or redesign the interaction.

Mention \`/debug/pprof/goroutineleak\` (Go 1.26 experiment) for automated leak-only output.

### Q (Staff track): Your org has shipped concurrency bugs to production three times this quarter. What do you do?

**Answer**: Root-cause pattern analysis.

1. Read the postmortems. Identify common patterns.
2. Map each pattern to a prevention mechanism (linter rule, CI check, review discipline, training).
3. Implement the missing prevention mechanisms.
4. Track the rate of concurrency incidents over the next two quarters.
5. Share findings with the engineering leadership as an investment report.

The specific answers depend on the patterns. Common finds: missing \`goleak\` in CI, inconsistent \`-race\` enforcement, tribal lock-order knowledge. The staff-level response is systemic, not per-incident.

---
`;
