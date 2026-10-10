## Section 5: Memory Profiling

### 5.1 Allocation Attribution

Heap profiles attribute allocations to the call site rather than the type, making it easy to see that a particular handler allocates 2 MB per request even if the allocations are spread across dozens of small objects. The allocation profiler captures both the number of allocations and their total bytes, sampling at a rate controlled by `runtime.MemProfileRate`. Lower values capture more samples at higher overhead. Higher values are suitable for production.

`pprof` exposes four allocation views, and choosing the right one is half the battle:

- `alloc_objects`: cumulative count of allocations at a site. Best for finding allocation hot spots that churn the GC.
- `alloc_space`: cumulative bytes allocated. Best for finding fat allocations (big slices, big maps).
- `inuse_objects`: live allocations that survived the last GC. Best for finding retention leaks by count.
- `inuse_space`: live bytes currently retained. Best for diagnosing RSS growth.

Rule of thumb: `alloc_*` tells you where the GC spends its time. `inuse_*` tells you what is leaking. A handler can dominate `alloc_objects` without appearing in `inuse_*` (ephemeral work), and vice versa (a global cache that only grows). Run both.

```bash
# Capture and analyze allocation hot spots.
go tool pprof -alloc_objects http://localhost:6060/debug/pprof/heap
go tool pprof -inuse_space   http://localhost:6060/debug/pprof/heap
```

**`GOMEMLIMIT` interacts with what you see.** Setting a soft memory limit (for example `GOMEMLIMIT=8GiB`) tells the runtime to GC more aggressively as the live heap approaches that ceiling. The effect on profiles: `inuse_*` stabilizes near the limit while `alloc_*` is unchanged, because your code allocates exactly as much as it did before. What changes is that the same allocation volume is now collected more often.

A word of caution on the `GOGC=off` plus `GOMEMLIMIT` combination, which gets repeated as folklore without its warning label attached. The Go team's guide does describe it, but it is a sharp tool: with `GOGC` off, the memory limit becomes the *only* thing triggering a GC, so a program whose live heap legitimately approaches the limit will GC continuously and burn most of its CPU on collection while never actually running out of memory. That is the death spiral the guide warns about, and it is worse than an OOM kill, since a crash-looping pod is at least obvious while a pod at 95 percent GC CPU just looks slow. The combination is defensible only when you can bound the live heap well below the limit and nothing else in the container competes for memory. If you cannot state that bound with a number, leave `GOGC` at its default and let `GOMEMLIMIT` act purely as a backstop.

The tracker below records allocation sites for code you explicitly instrument. It is a teaching aid for understanding what the heap profiler does for you automatically, not a replacement for it.

```go
package alloc_analysis

import (
	"runtime"
	"sort"
	"sync"
	"time"
)

// AllocationTracker records allocations that you explicitly report to it.
// Note what it does NOT do: it cannot intercept allocations, because Go has no
// allocation hook. Every call site you care about must call RecordAllocation
// by hand, which is exactly why the heap profiler is the real tool and this is
// a debugging aid. Do not put it in a production hot path: it takes a mutex and
// walks the stack on every recorded allocation.
type AllocationTracker struct {
	mu       sync.Mutex
	sites    map[uintptr]*AllocSite
	baseline runtime.MemStats
	start    time.Time
}

type AllocSite struct {
	PC    uintptr
	Func  string
	File  string
	Line  int
	Count uint64
	Bytes uint64
}

func NewAllocationTracker() *AllocationTracker {
	t := &AllocationTracker{
		sites: make(map[uintptr]*AllocSite),
		start: time.Now(),
	}
	// ReadMemStats stops the world. Fine once at startup, not on a hot path.
	runtime.ReadMemStats(&t.baseline)
	return t
}

// RecordAllocation records an allocation from the calling site.
// Use with defer or explicit calls in code you want to track.
func (t *AllocationTracker) RecordAllocation(size uint64) {
	// Get caller PC.
	var pcs [1]uintptr
	n := runtime.Callers(2, pcs[:])
	if n == 0 {
		return
	}

	pc := pcs[0]
	t.mu.Lock()
	site, ok := t.sites[pc]
	if !ok {
		site = &AllocSite{PC: pc}
		// Resolve symbol.
		frames := runtime.CallersFrames(pcs[:n])
		frame, _ := frames.Next()
		site.Func = frame.Function
		site.File = frame.File
		site.Line = frame.Line
		t.sites[pc] = site
	}
	site.Count++
	site.Bytes += size
	t.mu.Unlock()
}

// TopSites returns the top N allocation sites by bytes.
func (t *AllocationTracker) TopSites(n int) []*AllocSite {
	t.mu.Lock()
	sites := make([]*AllocSite, 0, len(t.sites))
	for _, s := range t.sites {
		sites = append(sites, s)
	}
	t.mu.Unlock()

	sort.Slice(sites, func(i, j int) bool {
		return sites[i].Bytes > sites[j].Bytes
	})
	if n > len(sites) {
		n = len(sites)
	}
	return sites[:n]
}

// HeapGrowth returns bytes added to the live heap since tracker creation.
// HeapInuse is a snapshot of what is live right now, so this is retention, not
// churn. A program can allocate gigabytes and report zero growth here.
func (t *AllocationTracker) HeapGrowth() uint64 {
	var current runtime.MemStats
	runtime.ReadMemStats(&current)
	if current.HeapInuse > t.baseline.HeapInuse {
		return current.HeapInuse - t.baseline.HeapInuse
	}
	return 0
}

// AllocRate returns bytes/second allocated since tracker creation.
// TotalAlloc is cumulative and never decreases, so it measures churn: the
// counterpart to HeapGrowth above. Dividing by elapsed time is what makes this
// a rate. Returning the raw delta and calling it a rate, as is easy to do here,
// gives a number that only ever climbs and means nothing.
// This is an average over the tracker's whole lifetime. A real monitor samples
// TotalAlloc on an interval and reports the delta per interval, so that a burst
// is visible instead of being smeared across an ever-growing denominator.
func (t *AllocationTracker) AllocRate() float64 {
	var current runtime.MemStats
	runtime.ReadMemStats(&current)
	elapsed := time.Since(t.start).Seconds()
	if elapsed <= 0 {
		return 0
	}
	return float64(current.TotalAlloc-t.baseline.TotalAlloc) / elapsed
}
```

### 5.2 Reducing Allocations in JSON Decoding

JSON decoding is one of the highest-allocation operations in a typical API server. Decoding into `map[string]any` allocates a map plus a box per value. Decoding into a struct is much better but still allocates for every string field, every map, and every slice, because `encoding/json` has to put the decoded bytes somewhere.

Pooling the target struct helps, and the reason it helps is worth understanding rather than memorizing: `json.Unmarshal` reuses a non-nil map and reuses a slice's existing backing array when capacity allows. So handing it a recycled `Request` whose `Payload` map and `Tags` slice are already allocated removes exactly those allocations, and nothing else.

Measured on an Intel i7-10510U (Go 1.27.1, linux/amd64) over the payload in the benchmark, decoding into a plain `Request` versus a pooled one:

| | B/op | allocs/op |
|---|---|---|
| `json.Unmarshal` into a fresh struct | 840 | 17 |
| Pooled struct (map and slice recycled) | 312 | 11 |

Six allocations and roughly 60 percent of the bytes, gone. Note what pooling did **not** do: it did not get to zero, and it never will. The eleven that remain are the decoded strings themselves, and `encoding/json` must allocate those regardless of what you hand it. Timings are omitted deliberately. The allocation counts above are stable to the byte across runs, while the ns/op on a laptop with frequency scaling is noise. Chase the deterministic number.

```go
package json_opt

import (
	"encoding/json"
	"sync"
)

// Request is a typical API request type.
type Request struct {
	UserID   string            `json:"user_id"`
	Action   string            `json:"action"`
	Payload  map[string]string `json:"payload"`
	Tags     []string          `json:"tags"`
	Priority int               `json:"priority"`
}

// requestPool recycles Request objects for high-frequency JSON decoding.
// The map and the slice are pre-allocated in New and then survive reuse:
// json.Unmarshal writes into a non-nil map rather than making a new one, and
// appends into Tags[:0] until it outgrows the capacity.
// Measured effect (i7-10510U, Go 1.27.1): 17 allocs/840 B → 11 allocs/312 B.
var requestPool = sync.Pool{
	New: func() any {
		return &Request{
			Payload: make(map[string]string, 8),
			Tags:    make([]string, 0, 8),
		}
	},
}

func AcquireRequest() *Request {
	r := requestPool.Get().(*Request)
	r.reset()
	return r
}

func ReleaseRequest(r *Request) {
	requestPool.Put(r)
}

func (r *Request) reset() {
	r.UserID = ""
	r.Action = ""
	r.Priority = 0
	// Clear map without reallocating.
	for k := range r.Payload {
		delete(r.Payload, k)
	}
	// Reset slice without reallocating backing array.
	r.Tags = r.Tags[:0]
}

// DecodeRequest decodes JSON into a pooled Request.
// The caller MUST call ReleaseRequest when done, and must not retain r (or any
// string or slice reached through it) afterwards. This is the tax on pooling:
// you have traded the garbage collector's correctness guarantee for six
// allocations, and a use-after-release here is a real data race that will
// present as one request seeing another request's fields.
func DecodeRequest(data []byte) (*Request, error) {
	r := AcquireRequest()
	if err := json.Unmarshal(data, r); err != nil {
		ReleaseRequest(r)
		return nil, err
	}
	return r, nil
}
```

And the benchmark that produced the table above. Run it yourself with
`go test -bench=. -benchmem`. Read the `allocs/op` column and ignore `ns/op`
unless your machine is quiet.

```go
package json_opt

import (
	"encoding/json"
	"testing"
)

var payload = []byte(`{"user_id":"u-12345","action":"create",` +
	`"payload":{"a":"1","b":"2","c":"3"},"tags":["x","y","z"],"priority":7}`)

func BenchmarkDecodePlain(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		var r Request
		if err := json.Unmarshal(payload, &r); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkDecodePooled(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		r, err := DecodeRequest(payload)
		if err != nil {
			b.Fatal(err)
		}
		ReleaseRequest(r)
	}
}
```

`b.Loop()` (Go 1.24 and later) is doing load-bearing work here. It keeps the
decoded value alive from the compiler's point of view, so the loop body cannot
be optimized away. The older `for i := 0; i < b.N; i++` form gives the compiler
room to delete work whose result is unused, and a benchmark reporting a
suspiciously good number is usually one that has been optimized into nothing.

### 5.3 The profile-read cheat sheet

For any heap profile, work through this checklist before forming a hypothesis. Open `alloc_space` view and read the top five call sites. If the top site is library code (`encoding/json`, `net/http`, `database/sql`), the next question is whose user code is calling it. Use `go tool pprof -focus=yourPkg -ignore=runtime` to narrow. Open `inuse_space` view. If the top sites match `alloc_space`, you have allocation churn, and the fix is pooling or avoiding the allocation. If the top sites are different, you have a retention leak, and the fix is understanding what keeps the memory alive. Open `alloc_objects` view. If object count is orders of magnitude higher than bytes, you have a many-small-objects pattern, typically GC-unfriendly, and flattening or pooling is usually the fix. Open `inuse_objects` view. If a type appears with many live instances that should not exist, trace lifetime. This five-minute checklist resolves most allocation investigations without ever touching a source file.

### 5.4 Junior → FAANG: the "remove one allocation at a time" drill

Take any HTTP handler you have written. Write a `testing.B` that hits it with a realistic request. Run with `-benchmem`. Record `allocs/op`. Now remove one allocation. Common candidates, in order: a `fmt.Sprintf` (replace with `strconv.AppendInt` on a pooled buffer). A `make([]byte, ...)` without capacity hint (add the hint or pool the buffer). An interface boxing (`map[string]any` into a typed map). A `json.Marshal` of a small struct (hand-write the serialization). A `strings.Split` in a hot path (use byte scanning). Rerun the benchmark. Record the new `allocs/op`. Repeat until you hit zero. This drill takes an afternoon and is the single most effective teacher of Go allocation patterns. After one round, you will start spotting these allocations in production code at a glance.

Two honest caveats, because the drill teaches a bad lesson without them. First, zero is a target for the exercise, not for production. The last few allocations are usually removed by pooling, and pooling buys speed with a manual-lifetime bug you did not previously have. Second, fewer allocs/op does not automatically mean more throughput. It means less GC pressure, and whether that shows up at the service level depends on whether GC was your bottleneck. The story an interviewer actually wants is not "I got it to zero", it is "I got it from 12 to 3, GC CPU dropped from X to Y, and here is how I knew GC was worth attacking in the first place." Bring the measurement and the reasoning, not a round number.

### 5.5 Senior @ FAANG: the allocation budget as a governance tool

Once a service has been through its first optimization pass, the staff-engineer move is to prevent regression. The most effective tool is a per-handler allocation budget enforced in CI. Pick a representative benchmark per endpoint, assert `allocs/op <= N` and `bytes/op <= M`, and fail the build on regression. The thresholds do not need to be tight, even "do not regress by more than 20 percent" catches most unintended allocations before they land. Teams that adopt this practice see allocation-related incidents drop almost to zero, and new engineers onboard with an automatic education about what each PR costs. The governance value exceeds the direct performance value. You are making allocation cost visible at the PR stage, which reshapes how the team thinks about every change. This is the compounding advantage of encoding operational knowledge into automation rather than into individual engineers' heads.

---
