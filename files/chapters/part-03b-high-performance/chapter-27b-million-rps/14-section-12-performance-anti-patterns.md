## Section 12: Performance Anti-Patterns

### 12.1 Common Mistakes That Kill Throughput

The most damaging performance anti-patterns are not obvious bottlenecks but subtle design choices: using `fmt.Sprintf` in a hot path, allocating slices without a capacity hint, and holding a mutex while performing I/O.

Before the catalog, do the arithmetic honestly, because this is where hot-path folklore usually starts. One nanosecond of overhead per request, at one million requests per second, costs **one millisecond of CPU per second**. That is one tenth of one percent of a single core. It is nothing. You need roughly **1000 ns** per request of waste before a million-RPS service is burning one full core on it. This matters because it tells you which of the patterns below are worth your time: the ones that allocate, because allocation costs both the malloc and a share of every future GC cycle, and not the ones that cost a handful of nanoseconds. An earlier draft of this very section claimed a single nanosecond per request consumed "a full second of CPU per million requests," which is wrong by a factor of 1000, and that kind of error is exactly what talks teams into optimizations that cannot pay for themselves.

The catalog below pairs each mistake with its measured allocation count and the idiomatic Go alternative. Counts are from `testing.AllocsPerRun` on Go 1.27.1, linux/amd64, and are exact rather than timing-dependent.

```go
package antipatterns

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// ANTI-PATTERN 1: Per-request JSON encoder allocation.
// Builds the map, the encoder, and its buffer for every request, to produce
// bytes that never change. Measured: 5 allocs/op, versus 0 for writing a
// pre-marshaled []byte. This one is worth fixing, because the cost is
// allocation rather than nanoseconds.
func badJSONHandler(w http.ResponseWriter, r *http.Request) {
	data := map[string]string{"status": "ok"}
	json.NewEncoder(w).Encode(data) // BAD: 5 allocs for a constant response
}

// GOOD: Marshal the static payload once at startup - the handler only writes bytes.
// (For dynamic payloads, use an append-based encoder such as sonic or a pooled
// bytes.Buffer with json.NewEncoder, since json.Marshal always allocates a fresh slice.)
var okResponse, _ = json.Marshal(map[string]string{"status": "ok"})

func goodJSONHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write(okResponse) // No per-request allocation.
}

// ANTI-PATTERN 2: fmt.Sprintf in hot paths.
// Every Sprintf allocates its result string, and reaches the formatting engine
// through reflection to do it.
func badRequestID(userID int64, traceID string) string {
	return fmt.Sprintf("user:%d:trace:%s", userID, traceID) // 1 alloc (measured)
}

// GOOD: Pre-allocate and use strconv.
func goodRequestID(userID int64, traceID string, buf []byte) []byte {
	buf = buf[:0]
	buf = append(buf, "user:"...)
	buf = strconv.AppendInt(buf, userID, 10)
	buf = append(buf, ":trace:"...)
	buf = append(buf, traceID...)
	return buf
}

// ANTI-PATTERN 3: Spawning a goroutine per request on top of net/http's own.
//
// Do not file this under "performance". It is a CORRECTNESS bug, and a severe
// one. The outer handler returns the instant it launches the goroutine, and
// net/http treats a returned handler as a finished response: it flushes,
// recycles the ResponseWriter, and closes the request body. The documented
// contract is explicit that a ResponseWriter may not be used after ServeHTTP
// returns. So the goroutine below writes into a response that no longer exists,
// racing the next request that reuses that state. The symptom is responses
// delivered to the wrong client under load, which is a security incident, not a
// latency regression.
//
// The performance framing is also wrong on its own terms: net/http ALREADY runs
// every request on its own goroutine, so this buys nothing even when it does
// not corrupt anything.
func badServer(handler http.Handler) {
	http.ListenAndServe(":8080", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		go func() { // BAD: w is invalid the moment the outer handler returns
			handler.ServeHTTP(w, r)
		}()
	}))
}

// GOOD: Let net/http manage goroutines (it already does).
// Or use a bounded worker pool for CPU-bound work.
func goodServer(handler http.Handler) {
	http.ListenAndServe(":8080", handler) // http already uses goroutine per conn
}

// ANTI-PATTERN 4: Mutex protecting frequently-read, rarely-written data.
//
// A global config map behind a sync.Mutex serialises every reader, so the
// read path cannot scale past one core no matter how many you add. Adding
// cores past that point makes it worse, not better: the contended cache
// line holding the lock now ping-pongs between more cores.
//
// Do not take a percentage on faith here, including one from a book. The
// cost of this depends on core count, on how long the critical section
// is, and on your read rate. Measure it: enable the mutex profile with
// runtime.SetMutexProfileFraction (it records NOTHING by default, so an
// empty profile means you did not turn it on, not that you have no
// contention) and read the wait time directly.
var badConfig = struct {
	mu sync.Mutex
	m  map[string]string
}{}

func badGetConfig(key string) string {
	badConfig.mu.Lock()
	defer badConfig.mu.Unlock()
	return badConfig.m[key] // CONTENTION: 64 cores fight for one lock
}

// GOOD: for config specifically, an immutable map behind an atomic.Pointer.
//
// Readers do one atomic load and then touch a map nobody will ever write to,
// so there is no lock, no contention, and no boxing. Writers build a whole new
// map and swap the pointer, which is cheap when writes are rare, and rare
// writes is the entire premise of a config map.
//
// sync.Map is the other reasonable answer, and it is genuinely good for
// read-mostly keysets (it is a HashTrieMap since Go 1.24). But be aware of what
// it costs you here: its API is Load(any) (any, bool), so every value round
// trips through an interface and every non-pointer-shaped value boxes on Store.
// That is the exact cost anti-pattern 6 below warns about. Reaching for
// sync.Map to fix contention while silently reintroducing boxing is a lateral
// move, not a win. Pick it when the keyset is dynamic, not merely when a map
// is contended.
var goodConfig atomic.Pointer[map[string]string]

func goodGetConfig(key string) string {
	m := goodConfig.Load()
	if m == nil {
		return ""
	}
	return (*m)[key] // No lock, no boxing: the map is never mutated.
}

// SetConfig swaps in a new snapshot. Never mutate the map already published.
func SetConfig(m map[string]string) {
	goodConfig.Store(&m)
}

// ANTI-PATTERN 5: caching time.Now(), which is usually the anti-pattern itself.
//
// This entry is kept as a WARNING against the technique, because the reasoning
// behind it is wrong in a way that is worth seeing.
//
// time.Now() is NOT a syscall. On Linux the runtime resolves clock_gettime
// through the vDSO, a page of kernel code mapped into your address space, so
// there is no ring transition. Confirm it on any Go binary:
//
//	go tool nm ./yourbinary | grep vdso   # runtime.vdsoClockgettimeSym
//
// So the thing being "optimized" is a handful of nanoseconds of user-space
// work. Per the arithmetic at the top of this section, even a full 20 ns per
// request at 1M RPS is 20 ms of CPU per second: two percent of ONE core, on a
// machine that has dozens. Meanwhile the cache below costs you a permanent
// ticker goroutine, an allocation per tick, up to 1 ms of staleness in every
// timestamp, and a time.Time whose monotonic reading is stale, which quietly
// corrupts any duration you compute from it.
//
// Reach for this only when a profile names time.Now(), which realistically
// happens only in something like a per-packet path in a network dataplane.
// For a rate limiter at 1M RPS, just call time.Now().
var cachedNow atomic.Pointer[time.Time]

func startClockCache() (stop func()) {
	t := time.Now()
	cachedNow.Store(&t)
	ticker := time.NewTicker(time.Millisecond)
	done := make(chan struct{})
	go func() {
		for {
			select {
			case t := <-ticker.C:
				t2 := t
				cachedNow.Store(&t2)
			case <-done:
				ticker.Stop() // The original leaked both ticker and goroutine.
				return
			}
		}
	}()
	return func() { close(done) }
}

func cachedTime() time.Time {
	return *cachedNow.Load() // Up to 1ms stale. Never use it to measure elapsed time.
}

// ANTI-PATTERN 6: Using `any` for hot-path data.
//
// Be precise about when boxing actually allocates, because "interfaces always
// allocate" is folklore. Measured with testing.AllocsPerRun:
//
//	box an int in 0..255      -> 0 allocs  (runtime keeps a static table)
//	box a pointer, map, chan  -> 0 allocs  (pointer-shaped: stored directly)
//	box a constant string     -> 0 allocs
//	box an int > 255          -> 1 alloc
//	box a multi-word struct   -> 1 alloc
//
// So the cost is real for values wider than a word, and zero for the
// pointer-shaped cases. A `map[string]any` of small ints allocates nothing.
type badCache struct {
	mu sync.RWMutex
	m  map[string]any // Boxes only for values wider than a word.
}

// GOOD: generics avoid boxing, but ONLY at a concrete instantiation.
// Measured, storing a 3-field struct:
//
//	map[string]any    -> 1 alloc/op
//	goodCache[Val]    -> 0 alloc/op   (generics help)
//	goodCache[any]    -> 1 alloc/op   (generic, and still boxing)
//
// Writing `goodCache[any]` and believing the type parameter removed the boxing
// is the trap. The instantiation is what matters, not the syntax.
type goodCache[V any] struct {
	mu sync.RWMutex
	m  map[string]V // No boxing when V is a concrete type.
}

func (c *goodCache[V]) Get(key string) (V, bool) {
	c.mu.RLock()
	v, ok := c.m[key]
	c.mu.RUnlock()
	return v, ok
}

// Suppress unused import warnings for types used in examples above.
var _ = fmt.Sprintf
var _ = json.Marshal
```

### 12.2 Premature optimization is still the real anti-pattern

The irony of a "performance anti-patterns" section in a 1M RPS chapter is that the biggest anti-pattern of all is applying any of this material to a service that does not need it. Most Go services at most companies run at 100 to 5000 RPS per instance. At those rates, `fmt.Sprintf` is free, `sync.Mutex` is free, `encoding/json` is free, and the code in section 12.1 above is strictly worse than the idiomatic version: harder to read, harder to test, harder to modify. The real rule is the one Knuth actually wrote: "we should forget about small efficiencies, say about 97 percent of the time: premature optimization is the root of all evil. Yet we should not pass up our opportunities in that critical 3 percent." The techniques in this chapter belong to the 3 percent. Applying them outside that 3 percent is not senior engineering, it is cargo-cult performance work, and it actively hurts the codebase. The first question a staff engineer asks when they see these patterns in review is "where is the profile that justifies this." If the answer is "I read a blog post," the answer is "revert and ship the simple version."

### 12.3 Junior → FAANG: the "why" that elevates the code review

When you submit a PR that removes a `fmt.Sprintf` from a hot path, or replaces a mutex with `sync.Map`, or adds a `sync.Pool`, the PR description should include four pieces of evidence: the profile that showed the hot spot (screenshot or pprof link), the benchmark before and after (with `benchstat` output), the production metric you expect to move (p99 by X ms, CPU by Y percent), and the rollback plan if the change regresses. A senior engineer who reads a PR with all four pieces of evidence approves it in minutes. A PR that just says "optimize handler" gets requested-changes and a long debate. This habit is one of the most reliable ways to get promoted out of mid-level engineering. It demonstrates that you understand engineering is about evidence, not cleverness.

### 12.4 Senior @ FAANG: the anti-patterns that only surface in code review

Some anti-patterns are invisible in the code and only show up in the review process. Three recur. First, an engineer builds a lock-free structure for a code path that never had contention, introduces a subtle race, and the race detector does not catch it because the workload that triggers the race happens once a quarter. The reviewer's job is to ask "where is the measurement showing contention was the bottleneck before this change." Second, an engineer adds a `sync.Pool` for objects that are cheap to allocate but hold references that extend lifetimes, creating a memory leak that grows with uptime. The reviewer's job is to ask "what is the expected lifecycle of an object in this pool, and what happens if an error returns without `Put`." Third, an engineer migrates a handler to `fasthttp` for a 2x throughput gain and accidentally drops `context.Context` propagation, breaking tracing, cancellation, and deadline enforcement across the service. The reviewer's job is to ask "what context-dependent behavior does this change touch." A staff engineer's most valuable artifact in code review is the list of questions that force an engineer to justify a performance change beyond the local benchmark. Write down your version of this list, share it with the team, and review it after every post-mortem. It improves faster than any single engineer's intuition.

---
