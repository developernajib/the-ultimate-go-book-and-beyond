export default `## 16.5 Live Locks

Live locks occur when goroutines are active but make no progress.

In the classic live-lock pattern, two goroutines each detect contention and politely yield, but both yield simultaneously on every iteration, burning CPU without ever completing work. Unlike a deadlock, the goroutines are not blocked. They are spinning in a courteous loop that never resolves. Introducing randomized backoff breaks the symmetry so at least one goroutine proceeds.

\`\`\`go
// LIVELOCK: both yield to each other
func livelock() {
    var mu sync.Mutex
    var trying1, trying2 bool

    go func() {
        for {
            mu.Lock()
            trying1 = true
            if trying2 {
                mu.Unlock()
                time.Sleep(time.Millisecond)
                continue
            }
            // Work
            trying1 = false
            mu.Unlock()
        }
    }()

    go func() {
        for {
            mu.Lock()
            trying2 = true
            if trying1 {
                mu.Unlock()
                time.Sleep(time.Millisecond)
                continue
            }
            // Work
            trying2 = false
            mu.Unlock()
        }
    }()
}
\`\`\`

Adding a random jitter to the backoff duration breaks the symmetry. Each goroutine waits a different amount of time, so they stop yielding in lockstep and one eventually proceeds while the other still waits.

**Fix: Random backoff or priority:**
\`\`\`go
time.Sleep(time.Duration(rand.IntN(10)) * time.Millisecond)
\`\`\`

### Staff Lens: Livelock Is Often Misdiagnosed as Deadlock

Livelock looks like deadlock in pprof (goroutines appear stuck) but differs in that they are actually running, just not making progress. The diagnostic: the goroutines show active (not blocked) in \`debug=2\` goroutine dump, and CPU usage is non-zero. The fix is usually jitter or backoff asymmetry.

Livelock in production usually traces back to optimistic concurrency control schemes under high contention. When CAS retries dominate over progress, the system lives but accomplishes nothing. The staff-level discipline: any CAS retry loop must include backoff, and any optimistic pattern must have a fallback to pessimistic locking when retries exceed a threshold.

---
`;
