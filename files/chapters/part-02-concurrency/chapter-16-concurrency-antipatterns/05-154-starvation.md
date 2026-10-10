## 16.4 Starvation

Starvation occurs when a goroutine can never make progress because others monopolize resources.

### RWMutex and Writers: Correcting a Popular Myth

"Enough readers will starve an RWMutex writer" is one of the most repeated claims about Go concurrency, and it is false. It is worth dismantling, because believing it leads people to abandon `RWMutex` for problems it does not have.

Go's `sync.RWMutex` blocks **new** readers the moment a writer queues. So a waiting writer never waits for the endless stream of arriving readers, only for the readers already holding the lock when it queued. That set is finite and shrinking. Measure it: 100 goroutines hammering `RLock`, `Sleep(1ms)`, `RUnlock` in a tight loop, with a writer arriving mid-flood:

```
Writer ACQUIRED after 1ms, despite 100 readers looping continuously.
```

One millisecond, which is exactly the time for the in-flight readers to finish their sleep. Nine thousand reader acquisitions happened during the run, and not one of them delayed the writer, because every reader that arrived after the writer queued went to the back of the line. Reader volume cannot starve a writer.

**The real hazard is reader *duration*, not reader count.** A writer waits for the current readers to finish, so a single reader that holds `RLock` across something slow, such as an HTTP call, a database query, or a `json.Marshal` of a huge structure, blocks the writer for that entire duration. Worse, because the writer is queued, every reader arriving behind it is blocked too. One slow reader converts a read-mostly lock into a full stop for everyone:

```go
// The actual anti-pattern: a slow operation under a read lock.
func (c *Cache) GetAndRefresh(key string) Value {
    c.mu.RLock()
    defer c.mu.RUnlock()

    v := c.items[key]
    if v.stale() {
        // DISASTER: 200ms of network I/O with the read lock held.
        // Any writer queued behind this waits 200ms, and every reader
        // arriving after that writer waits too. A one-key refresh
        // stalls the entire cache.
        v = fetchFromOrigin(key)
    }
    return v
}
```

The fix is not to change lock type, it is to shorten the critical section: copy what you need, release the lock, and do the slow work outside it. The rule generalises well beyond `RWMutex`, since holding *any* lock across I/O is a latency bug waiting for traffic.

### Channel Consumer Starvation

When multiple goroutines consume from a shared channel, there is no fairness guarantee across consumers. A fast consumer simply comes back for the next item sooner, so it processes far more of them.

Be precise about who is starved here, because the name misleads. The slow consumer is not the victim: it is working continuously, doing exactly what it was built to do. The victims are the *items* queued behind slow work, and by extension the requests waiting on them. This is a tail-latency problem wearing a starvation costume, which is why the fix is to segregate the work rather than to make the scheduler fairer.

```go
// Slow consumer starved by fast consumers
func starve() {
    ch := make(chan int, 100)

    // Fast consumer
    go func() {
        for v := range ch {
            _ = v
        }
    }()

    // Slow consumer: takes few items, and everything queued behind
    // its current item waits a full second
    go func() {
        for v := range ch {
            time.Sleep(time.Second)
            _ = v
        }
    }()
}
```

Splitting work across dedicated channels by type ensures that slow-processing items get their own pipeline and are not crowded out by faster consumers.

**Fix: Dedicated channels or fair scheduling:**
```go
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
```

### Staff Lens: Starvation Under Load Is Your Tail Latency

Starvation shows up as tail latency: p99 or p999 requests that take dramatically longer than median. In a shared queue, a request unlucky enough to be behind slow work pays the cost. Mitigations:

- **Priority queues.** High-priority work processes first.
- **Work segregation.** Different pools for different workload types.
- **SLO-aware scheduling.** Admit only work that fits within the SLO.

Teams that ignore tail-latency starvation ship services with unreliable latency distributions. Teams that address it explicitly have predictable p99s, which is what SLOs actually measure.

---
