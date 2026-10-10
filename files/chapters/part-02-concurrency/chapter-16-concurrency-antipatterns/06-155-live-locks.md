## 16.5 Live Locks

Live locks occur when goroutines are active but make no progress.

In the classic textbook live-lock, two parties each detect contention and politely yield, and both yield in perfect lockstep forever, burning CPU without completing work. Unlike a deadlock, nothing is blocked. Everything is running, courteously, and achieving nothing. Randomized backoff breaks the symmetry so one party proceeds.

That is the theory. Be sceptical of the canonical Go illustration of it, which usually looks like this:

```go
// This does NOT livelock. It is the example everyone writes, and it
// completes millions of operations per second.
go func() {
    for {
        mu.Lock()
        trying1 = true
        if trying2 {          // never observed to be true
            mu.Unlock()
            time.Sleep(time.Millisecond)
            continue
        }
        doWork()
        trying1 = false
        mu.Unlock()
    }
}()
// ... a mirror-image goroutine with trying2
```

Trace the mutex and the reason is structural. `trying1` is only ever `true` **while `mu` is held**, and the other goroutine can only read `trying1` while holding `mu` itself. So by the time goroutine 2 gets the lock and looks, goroutine 1 has already set its flag back to `false` and released. The polite branch is unreachable. Run it and you get roughly twenty million completed work units in half a second, which is the opposite of a livelock. The mutex that was supposed to protect the intent flags is what prevents the intent from ever being visible.

The deeper point is worth more than the example: **a livelock needs the contending parties to observe each other's intent while they deliberate**, and holding intent only inside a critical section makes that impossible by construction. If you find yourself unable to reproduce a livelock you designed, this is usually why.

The honest addendum is that symmetric livelock is genuinely rare in Go, and hard to build even on purpose. The runtime scheduler, the OS timer resolution, and cache effects inject so much natural asymmetry that two goroutines will not stay in lockstep for long even with identical `time.Sleep` durations. The polite-yielding scenario is essentially a hazard of tightly synchronized systems, and Go goroutines are not that.

What *does* happen in Go production is the Staff Lens case below: retry storms, where an optimistic CAS loop under heavy contention keeps every goroutine busy retrying while aggregate throughput collapses. Technically progress is made, so it is not livelock in the formal sense. Operationally it is identical: full CPU, no useful work. That is the version to watch for, and its fix is genuinely backoff plus a pessimistic fallback.

**Fix, where the scenario is real: randomized backoff.**
```go
// Jitter breaks symmetry between retrying parties.
time.Sleep(time.Duration(1+rand.IntN(10)) * time.Millisecond)
```

### Staff Lens: Livelock Is Often Misdiagnosed as Deadlock

Livelock and deadlock present the same way from the outside: the service stops serving. They are trivially distinguishable by one number, and it is the first thing to check. **CPU usage.** A deadlocked service is idle, since its goroutines are parked and consuming nothing. A livelocked or retry-storming service is pinned at full CPU. Same symptom, opposite signature, opposite fix.

Confirm with a `debug=2` goroutine dump. Deadlocked goroutines sit in `[sync.Mutex.Lock]` or `[chan receive]` with a wait time in the minutes. Livelocked ones show a running or short-sleep state and their stacks *move* between successive dumps, which is the tell: take two dumps thirty seconds apart and compare.

Livelock in production usually traces back to optimistic concurrency control schemes under high contention. When CAS retries dominate over progress, the system lives but accomplishes nothing. The staff-level discipline: any CAS retry loop must include backoff, and any optimistic pattern must have a fallback to pessimistic locking when retries exceed a threshold.

---
