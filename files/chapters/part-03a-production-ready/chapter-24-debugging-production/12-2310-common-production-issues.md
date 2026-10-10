## 24.10 Common Production Issues

### Memory Leak Detection

A memory leak in Go does not always mean a GC bug, it typically means objects are reachable from a root and therefore cannot be collected, often due to unbounded caches, forgotten goroutines holding references, or growing slices never trimmed. A `MemoryLeakDetector` tracks heap allocation samples over a rolling window and flags sustained growth above a configurable percentage threshold, giving operations teams an early warning before the process exhausts container memory limits.

Watch the arithmetic in `analyze` closely, because the obvious version of it is wrong. `MemStats` fields are `uint64`, and `HeapAlloc` sawtooths: it climbs between collections and drops sharply at each one. Any expression that subtracts two of these in unsigned space before converting to float will underflow the moment the heap shrinks, turning a healthy collection into a spectacular false positive. Convert first, subtract second.

Be honest about what this detector is worth, too. Comparing two `HeapAlloc` samples measures where you happened to land in the sawtooth, so a 60-sample window at a 1-second tick can easily report growth that is pure phase. If you want the number that actually tracks retention, sample `/memory/classes/heap/objects:bytes` from `runtime/metrics`, or compare live heap right after two forced collections. And treat the alert as a prompt to go pull a real heap profile, never as a diagnosis: this tells you memory grew, and only the profile tells you which call site grew it.

```go
package debug

import (
    "log/slog"
    "runtime"
    "time"
)

type MemoryLeakDetector struct {
    logger     *slog.Logger
    samples    []uint64
    maxSamples int
    threshold  float64 // Growth rate threshold
}

func NewMemoryLeakDetector(logger *slog.Logger) *MemoryLeakDetector {
    return &MemoryLeakDetector{
        logger:     logger,
        samples:    make([]uint64, 0, 60),
        maxSamples: 60,
        threshold:  0.1, // 10% growth over sample period
    }
}

func (d *MemoryLeakDetector) Start(interval time.Duration, stopCh <-chan struct{}) {
    ticker := time.NewTicker(interval)
    defer ticker.Stop()

    for {
        select {
        case <-stopCh:
            return
        case <-ticker.C:
            d.sample()
        }
    }
}

func (d *MemoryLeakDetector) sample() {
    var m runtime.MemStats
    runtime.ReadMemStats(&m)

    d.samples = append(d.samples, m.HeapAlloc)
    if len(d.samples) > d.maxSamples {
        d.samples = d.samples[1:]
    }

    if len(d.samples) >= d.maxSamples {
        d.analyze()
    }
}

func (d *MemoryLeakDetector) analyze() {
    first := d.samples[0]
    last := d.samples[len(d.samples)-1]

    if first == 0 {
        return
    }

    // Convert to float BEFORE subtracting. These are uint64: if the heap
    // shrank, `last - first` underflows and wraps to a colossal positive
    // number, and every GC that frees memory reports a runaway leak.
    // Going 100MB -> 90MB yields a "growth rate" of 1.76e11 under the
    // naive `float64(last-first)` version.
    growthRate := (float64(last) - float64(first)) / float64(first)

    if growthRate > d.threshold {
        d.logger.Warn("potential memory leak detected",
            "growth_rate", growthRate,
            "start_bytes", first,
            "current_bytes", last,
            "samples", len(d.samples),
        )
    }
}
```

### Deadlock Detection

Go's runtime detects total deadlocks, when every goroutine is blocked, and when it does it throws `fatal error: all goroutines are asleep - deadlock!`. That is a runtime throw, not a panic: no `recover` will catch it and no deferred function runs. This matters less than it sounds, because the check only fires when *every* goroutine is parked. A real service almost always has a timer, a metrics ticker, or an idle HTTP listener still runnable, so the runtime sees a live goroutine and stays quiet forever. In production the built-in detector effectively never fires, which is exactly why partial-deadlock detection has to be built by hand.

The detector below compares goroutine dumps at regular intervals: if the set of goroutines blocked on synchronisation is identical across two consecutive snapshots separated by a configurable timeout, it signals a likely partial deadlock for investigation.

The subtlety is in what "identical" means, and getting it wrong produces a detector that looks right and never fires once. Comparing the two dumps as whole strings does not work. A dump contains the dumping goroutine's own stack, the elapsed-minutes annotation on parked goroutines, and stack addresses, so consecutive dumps differ even when the process is genuinely and permanently deadlocked. Compare a normalised signature instead: the set of goroutine IDs together with their blocking states, with addresses and durations stripped out. That signature is stable across snapshots under a real deadlock, which is the whole property the detector depends on.

```go
package debug

import (
    "bufio"
    "log/slog"
    "regexp"
    "runtime"
    "slices"
    "strings"
    "time"
)

type DeadlockDetector struct {
    logger        *slog.Logger
    checkInterval time.Duration
    stuckTimeout  time.Duration
}

// goroutine 18 [sync.Mutex.Lock]:  or  goroutine 18 [sync.Mutex.Lock, 6 minutes]:
// The minutes group is captured separately so it can be discarded: it changes
// between snapshots and would otherwise defeat the comparison.
var goroutineHeaderRe = regexp.MustCompile(`^goroutine (\d+) \[([^,\]]+)(?:, (\d+) minutes)?\]:$`)

// States that mean "parked on synchronisation and not making progress".
// Deliberately excludes "IO wait" and "syscall", which are normal for a
// healthy idle server, and "runnable"/"running".
var blockedStates = map[string]bool{
    "chan receive":        true,
    "chan send":           true,
    "select":              true,
    "semacquire":          true,
    "sync.Mutex.Lock":     true,
    "sync.RWMutex.Lock":   true,
    "sync.RWMutex.RLock":  true,
    "sync.WaitGroup.Wait": true,
    "sync.Cond.Wait":      true,
}

func NewDeadlockDetector(logger *slog.Logger) *DeadlockDetector {
    return &DeadlockDetector{
        logger:        logger,
        checkInterval: 30 * time.Second,
        stuckTimeout:  5 * time.Minute,
    }
}

func (d *DeadlockDetector) Start(stopCh <-chan struct{}) {
    ticker := time.NewTicker(d.checkInterval)
    defer ticker.Stop()

    var lastSig []string
    var stuckSince time.Time

    for {
        select {
        case <-stopCh:
            return
        case <-ticker.C:
            // The normalised set of blocked goroutines, not the raw dump.
            sig := blockedSignature(d.getGoroutineDump())

            switch {
            case len(sig) == 0:
                // Nothing parked. Reset.
                stuckSince = time.Time{}

            case !slices.Equal(sig, lastSig):
                // The blocked set changed, so goroutines are entering and
                // leaving sync normally. That is not a deadlock. Reset.
                stuckSince = time.Time{}

            case stuckSince.IsZero():
                // First interval where the set held steady. Start the clock.
                stuckSince = time.Now()

            case time.Since(stuckSince) > d.stuckTimeout:
                d.logger.Error("potential deadlock detected",
                    "stuck_goroutines", len(sig),
                    "stuck_duration", time.Since(stuckSince),
                    "blocked", strings.Join(sig, " "),
                )
            }

            lastSig = sig
        }
    }
}

func (d *DeadlockDetector) getGoroutineDump() string {
    // Grow until it fits. A fixed buffer silently truncates on a service
    // with many goroutines, and a truncated dump makes the comparison
    // meaningless. Cap it so a pathological process cannot OOM us.
    for size := 1 << 20; ; size *= 2 {
        buf := make([]byte, size)
        n := runtime.Stack(buf, true)
        if n < len(buf) || size >= 64<<20 {
            return string(buf[:n])
        }
    }
}

// blockedSignature returns a sorted, stable set of "id:state" entries for
// goroutines parked on synchronisation. Stack addresses and the elapsed
// "N minutes" annotation are excluded, because both change between
// snapshots and would make two dumps of the same deadlock compare unequal.
func blockedSignature(dump string) []string {
    var sig []string
    scanner := bufio.NewScanner(strings.NewReader(dump))

    for scanner.Scan() {
        m := goroutineHeaderRe.FindStringSubmatch(scanner.Text())
        if m == nil {
            continue
        }
        // m[1] is the goroutine ID, m[2] the state, m[3] the discarded minutes.
        if blockedStates[m[2]] {
            sig = append(sig, m[1]+":"+m[2])
        }
    }

    slices.Sort(sig)
    return sig
}
```

Run this against a service and the first thing you will notice is that it reports goroutines you do not consider stuck at all. `main` parked in `chan receive` waiting for a shutdown signal is blocked, permanently and correctly, for the entire life of the process. So is a worker waiting on an empty job queue. Both match the signature and neither is a bug.

That is why the timeout exists and why the output is a prompt rather than a verdict. Tune `stuckTimeout` above the longest legitimate block in your service, and expect to maintain an ignore list of known-parked goroutines keyed by their top stack frame. What the detector is genuinely good at is the delta: a blocked set that grows by two goroutines every hour and never shrinks is the signature you cannot get from `runtime.NumGoroutine()` alone. Treat a firing as instruction to go read the dump, and read the dump before you believe anything.

### Staff Lens: Issue Pattern Library

Most production issues repeat. Build a library of patterns with diagnostic signatures and remediation. New on-call engineers learn from the library instead of rediscovering each pattern.

---
