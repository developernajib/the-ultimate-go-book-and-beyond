export default `## 16.4 Starvation

Starvation occurs when a goroutine can never make progress because others monopolize resources.

### Writer Starvation with RWMutex

Go's \`sync.RWMutex\` is writer-preferring, once a writer is waiting, new readers block, but a continuous stream of readers that never all release simultaneously can still prevent a writer from acquiring the lock for extended periods. The practical fix is to limit reader concurrency or to restructure write-heavy paths to avoid holding read locks across slow operations.

\`\`\`go
// Many readers can starve a writer
func starveWriter(rw *sync.RWMutex) {
    // Many readers
    for i := 0; i < 100; i++ {
        go func() {
            for {
                rw.RLock()
                time.Sleep(time.Millisecond)
                rw.RUnlock()
            }
        }()
    }

    // Writer may never acquire lock
    go func() {
        rw.Lock()  // Starved!
        defer rw.Unlock()
        // ...
    }()
}
\`\`\`

### Channel Consumer Starvation

When multiple goroutines consume from a shared channel, the Go scheduler does not guarantee fair distribution, a faster consumer will naturally drain items before a slower one can compete. Segregating work onto separate channels by processing tier ensures each tier receives its intended share regardless of relative consumer speeds.

\`\`\`go
// Slow consumer starved by fast consumers
func starve() {
    ch := make(chan int, 100)

    // Fast consumer
    go func() {
        for v := range ch {
            _ = v
        }
    }()

    // Slow consumer - rarely gets items
    go func() {
        for v := range ch {
            time.Sleep(time.Second)
            _ = v
        }
    }()
}
\`\`\`

Splitting work across dedicated channels by type ensures that slow-processing items get their own pipeline and are not crowded out by faster consumers.

**Fix: Dedicated channels or fair scheduling:**
\`\`\`go
func fair() {
    fastCh := make(chan int, 100)
    slowCh := make(chan int, 10)

    // Producer distributes work
    go func() {
        for item := range items {
            if isSlowWork(item) {
                slowCh <- item
            } else {
                fastCh <- item
            }
        }
    }()
}
\`\`\`

### Staff Lens: Starvation Under Load Is Your Tail Latency

Starvation shows up as tail latency: p99 or p999 requests that take dramatically longer than median. In a shared queue, a request unlucky enough to be behind slow work pays the cost. Mitigations:

- **Priority queues.** High-priority work processes first.
- **Work segregation.** Different pools for different workload types.
- **SLO-aware scheduling.** Admit only work that fits within the SLO.

Teams that ignore tail-latency starvation ship services with unreliable latency distributions. Teams that address it explicitly have predictable p99s, which is what SLOs actually measure.

---
`;
