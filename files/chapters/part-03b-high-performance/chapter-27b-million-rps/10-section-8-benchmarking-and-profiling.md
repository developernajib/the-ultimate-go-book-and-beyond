## Section 8: Benchmarking and Profiling

### 8.1 Micro-Benchmarking Methodology

Go's `testing.B` framework is powerful and easy to misuse. The failure modes are worth naming individually, because each produces a number that looks authoritative and means nothing.

**Dead-code elimination.** If a benchmark computes a value and discards it, the compiler is entitled to delete the computation. The tell is a suspiciously fast result: any figure below about 1 nanosecond per operation is not a fast function, it is an empty loop, because a single L1 cache hit alone costs roughly a nanosecond. Sink the result into a package-level variable so the work cannot be removed.

**Measuring the harness.** Anything constructed inside the loop is included in the measurement. Build fixtures outside it.

**Trusting one run.** Report a delta only after `-count=10` on both sides, compared with `benchstat`. A single pair of runs on a machine that is doing anything else is noise with a decimal point.

**Trusting `ns/op` over `allocs/op`.** These two numbers do not deserve equal confidence. `allocs/op` is a counter incremented by the runtime, so it is exact and reproducible on a loaded laptop or an idle server alike. `ns/op` is wall-clock and moves with CPU frequency scaling, thermal state, neighbouring processes, and cache contention. When the two disagree, believe `allocs/op`. When you cite a number in a design doc, prefer `allocs/op` and `B/op` for exactly this reason.

The benchmarks below demonstrate the correct idioms, and two of them exist specifically to show a trap.

```go
package bench_test

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// BenchmarkRouterLookup benchmarks zero-allocation router lookup.
// Run with: go test -bench=. -benchmem -count=10
//
// Note the recorder is created ONCE, outside the loop. This is the whole
// point of the benchmark and it is easy to get wrong:
//
//	for b.Loop() {
//	    r.ServeHTTP(httptest.NewRecorder(), req) // WRONG
//	}
//
// httptest.NewRecorder() costs 208 B/op and 4 allocs/op when it is
// actually used (measured on Go 1.27.1, linux/amd64). Construct it inside
// the loop and the benchmark reports at least 4 allocs/op no matter how
// good the router is, so a genuinely zero-allocation router can never
// prove it. You would be benchmarking the test harness.
//
// The general rule: everything the benchmark is NOT measuring belongs
// outside the loop.
func BenchmarkRouterLookup(b *testing.B) {
	r := NewRouter()
	r.GET("/api/v1/users/:id", func(w http.ResponseWriter, req *http.Request, p Params) {})
	r.GET("/api/v1/products/:id/reviews", func(w http.ResponseWriter, req *http.Request, p Params) {})

	req := httptest.NewRequest("GET", "/api/v1/users/12345", nil)
	w := httptest.NewRecorder() // Reused: not what we are measuring.

	b.ReportAllocs()
	for b.Loop() {
		r.ServeHTTP(w, req)
	}
}

// BenchmarkRingBufferThroughput measures lock-free ring buffer throughput.
func BenchmarkRingBufferThroughput(b *testing.B) {
	rb := NewRingBuffer[int](1 << 16) // 65536 capacity

	b.RunParallel(func(pb *testing.PB) {
		i := 0
		for pb.Next() {
			if i%2 == 0 {
				rb.Enqueue(i)
			} else {
				rb.Dequeue()
			}
			i++
		}
	})
}

// BenchmarkAllocations compares allocating with pooling, and demonstrates
// the single most common sync.Pool mistake.
func BenchmarkAllocations(b *testing.B) {
	b.Run("alloc-each", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			sinkBytes = make([]byte, 4096) // Sink it, or it is eliminated.
		}
	})

	// WRONG: Put takes an `any`. A []byte is a 24-byte slice header
	// (pointer, len, cap), which does not fit in an interface's single
	// data word, so boxing it allocates. The pool then costs an
	// allocation per Put, which is what it existed to avoid.
	//
	// Measured, Go 1.27.1 linux/amd64: 24 B/op, 1 allocs/op.
	poolSlice := sync.Pool{New: func() any { return make([]byte, 4096) }}
	b.Run("pool-slice-WRONG", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			buf := poolSlice.Get().([]byte)
			poolSlice.Put(buf[:0]) // Boxes a 24-byte header: allocates.
		}
	})

	// RIGHT: Put a *[]byte. A pointer fits in the interface data word,
	// so there is nothing to box and nothing to allocate.
	//
// Measured, Go 1.27.1 linux/amd64: 0 B/op, 0 allocs/op.
// This is why the stdlib's own pools (fmt, encoding/json) pool
// pointers. (Note: `go vet` does not check this. Nothing will warn
// you. The benchmark is the check, which is why it is written down
// here rather than left as advice.)
	poolPtr := sync.Pool{New: func() any {
		buf := make([]byte, 0, 4096)
		return &buf
	}}
	b.Run("pool-ptr-RIGHT", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			bp := poolPtr.Get().(*[]byte)
			*bp = (*bp)[:0]
			poolPtr.Put(bp)
		}
	})
}

var sinkBytes []byte

// ProfilingGuide provides guidance on profiling 1M RPS systems.
// This function is documentation - not executable.
func ProfilingGuide() {
	/*
	   Step 1: CPU Profile
	   -------------------
	   go tool pprof -http=:8080 cpu.out

	   Look for:
	   - runtime.mallocgc (heap allocations - must be near 0 in hot path)
	   - runtime.gcBgMarkWorker (GC overhead - tune GOGC + GOMEMLIMIT)
	   - runtime.lock (mutex contention - replace with lock-free structures)
	   - syscall.Syscall (system call overhead - batch with io_uring)

	   Step 2: Memory Profile
	   ----------------------
	   go test -memprofile=mem.out -memprofilerate=1
	   go tool pprof -alloc_objects mem.out

	   Target: 0 allocs/op on hot paths (handler, router, pool ops)

	   Step 3: Trace (goroutine scheduling)
	   -------------------------------------
	   go tool trace trace.out

	   Look for:
	   - Goroutine blocking on channels (use lock-free queues)
	   - GC stop-the-world pauses > 1ms
	   - Scheduler delays (goroutine runnable but waiting for P)

	   Step 4: perf (Linux hardware counters)
	   ----------------------------------------
	   perf stat -e cache-misses,cache-references,instructions,cycles ./server

	   Read these as a COMPARISON against your own baseline, not against
	   absolute targets. "IPC above 2.0" and "cache miss rate below 5
	   percent" are numbers people repeat, and they are meaningless
	   without context: a pointer-chasing workload can be perfectly
	   optimized at IPC 0.8, and a busy-spinning loop can hit IPC 3.0
	   while accomplishing nothing. What is diagnostic is IPC dropping
	   or miss rate climbing versus the same binary yesterday.

	   Step 5: Load Test
	   -----------------
	   wrk2 -t 16 -c 1000 -d 60s -R 1000000 http://localhost:8080/health

	   Use a constant-rate tool (see 8.3 on coordinated omission) and
	   compare against YOUR SLO. There is no universal "good" p99: 5ms
	   may be luxurious for a batch API and a catastrophe for an ad
	   auction. Derive the target from the product requirement, then hold
	   the line on it.
	*/
}
```

### 8.2 Load Testing with wrk2 and vegeta

`wrk2` and `vegeta` address the coordinated omission problem that plagues naive load testers, which stop sending new requests while waiting for slow responses, underreporting latency at percentiles above the median. Both tools issue requests at a constant rate regardless of response time, accurately measuring the latency distribution a production service delivers under sustained load. The scripts below configure realistic traffic profiles and capture p50/p95/p99/p999 latency histograms that correlate with user-perceived performance.

```go
package loadtest

import (
	"encoding/json"
	"fmt"
	"time"
)

// LoadTestConfig configures a load test run.
type LoadTestConfig struct {
	TargetURL   string
	RPS         int
	Duration    time.Duration
	Concurrency int
	Timeout     time.Duration
}

// LatencyHistogram captures latency distribution.
type LatencyHistogram struct {
	P50   time.Duration
	P75   time.Duration
	P90   time.Duration
	P95   time.Duration
	P99   time.Duration
	P999  time.Duration
	P9999 time.Duration
	Max   time.Duration
}

// LoadTestResult captures the outcome of a load test.
type LoadTestResult struct {
	TargetRPS    int
	ActualRPS    float64
	Duration     time.Duration
	TotalReqs    uint64
	SuccessReqs  uint64
	ErrorReqs    uint64
	ErrorRate    float64
	Latency      LatencyHistogram
	Throughput   float64 // bytes/sec
}

// String formats the result for display.
func (r LoadTestResult) String() string {
	return fmt.Sprintf(`
Load Test Results
=================
Target RPS:     %d
Actual RPS:     %.0f
Duration:       %v
Total Requests: %d
Success:        %d (%.2f%%)
Errors:         %d (%.4f%%)

Latency Percentiles:
  p50:   %v
  p75:   %v
  p90:   %v
  p95:   %v
  p99:   %v
  p99.9: %v
  p99.99:%v
  Max:   %v

Throughput: %.2f MB/s
`,
		r.TargetRPS, r.ActualRPS, r.Duration,
		r.TotalReqs, r.SuccessReqs, float64(r.SuccessReqs)/float64(r.TotalReqs)*100,
		r.ErrorReqs, r.ErrorRate*100,
		r.Latency.P50, r.Latency.P75, r.Latency.P90,
		r.Latency.P95, r.Latency.P99, r.Latency.P999,
		r.Latency.P9999, r.Latency.Max,
		r.Throughput/1024/1024,
	)
}

// vegeta attack configuration (used with vegeta tool).
type vegetaTarget struct {
	Method string            `json:"method"`
	URL    string            `json:"url"`
	Header map[string]string `json:"header"`
}

func GenerateVegetaTargets(cfg LoadTestConfig) ([]byte, error) {
	targets := []vegetaTarget{
		{
			Method: "GET",
			URL:    cfg.TargetURL,
			Header: map[string]string{
				"Accept":       "application/json",
				"Content-Type": "application/json",
			},
		},
	}
	return json.Marshal(targets)
}

/*
Example load test commands:

# wrk2 (constant rate, latency-accurate):
wrk2 -t 16 -c 500 -d 30s -R 100000 \
  --latency http://localhost:8080/api/v1/health

# vegeta (precise rate control):
echo "GET http://localhost:8080/api/v1/health" | \
  vegeta attack -rate=100000 -duration=30s | \
  vegeta report -type=hdrplot > results.out

# k6 (scriptable, cloud-native):
k6 run --vus 500 --rps 100000 --duration 30s script.js

# hey (simple, good for quick tests, NOT constant-rate: see 8.3):
hey -n 1000000 -c 500 -q 100000 http://localhost:8080/health

A note on "expected results" tables, which this section deliberately does
not provide. A latency figure is only meaningful alongside the handler's
actual work, the payload size, the hardware, the NIC, the kernel version,
and whether the load generator corrects for coordinated omission. A table
claiming "1M RPS gives p50=200µs" is a claim about somebody's /health
endpoint returning a constant on hardware you do not have, and it tells
you nothing about your service.

Two sanity checks are worth more than any such table:

  1. CPU budget. 1M RPS on 8 cores is 8 CPU-microseconds per request,
     total, for parsing, routing, handling, serialising, and syscalls.
     That is achievable for a trivial handler and impossible for one
     doing a database round trip. Do this division before you promise
     anyone a number.

  2. Bandwidth budget. 1M RPS x 1KB response = 8 Gbps of application
     payload, before TCP/IP and TLS overhead. On a 10Gbps NIC you are
     already near the line rate, and the bottleneck is the wire rather
     than anything in your Go code.

Run the arithmetic first. It disqualifies most 1M-RPS-on-one-box plans in
about a minute, and it is the first question a good reviewer will ask.
*/
```

### 8.3 The coordinated-omission problem explained without math

Most naive load testers (`ab`, older `wrk`, many homegrown harnesses) ask one question on each virtual client: "did my last request come back yet? If yes, send the next one." Under that model, if a server pauses for 500 ms, the client pauses too, so the 500 ms event shows up as a single tall spike instead of as 500 ms of missing requests that should have been sent but were not. This drastically underreports tail latency. `wrk2`, `vegeta` in constant-rate mode, and `k6` (since v0.35) all fix this by issuing requests at a target rate regardless of response arrival, so stalls show up as the thousands of late replies they really are. The metric you cite in a design doc, a SLO spec, or a performance-review summary should always come from a coordinated-omission-corrected tool. Producing an impressive p99 number from a coordinated tool is how junior engineers accidentally make their service look better than it is and set themselves up for a production incident the first time real traffic arrives.

### 8.4 Junior → FAANG: the benchstat habit

Install `benchstat`:

```bash
go install golang.org/x/perf/cmd/benchstat@latest
```

Never report a benchmark delta without running the baseline and the change ten times each and piping both through `benchstat`:

```bash
go test -bench=. -count=10 -run='^$' ./... > old.txt
# apply change
go test -bench=. -count=10 -run='^$' ./... > new.txt
benchstat old.txt new.txt
```

The output shows mean, standard deviation, and a `p` value for statistical significance. If `benchstat` reports "~" (no significant change), your optimization did nothing and you are looking at noise. This habit alone will stop you from shipping "optimizations" that are actually regressions masked by variance, which is a common failure mode in engineers who have not yet internalized that a 2 percent improvement is within the noise floor of most benchmarks.

### 8.5 Senior @ FAANG: the production-shadow load test

Micro-benchmarks and synthetic load tests both lie in well-understood ways. Micro-benchmarks miss cache behavior, lock contention, and GC pressure from the rest of the service. Synthetic load tests miss the request shape, header mix, and retry behavior of real traffic. The production-grade artifact is a shadow-traffic harness: a sampled copy of production requests replayed against a candidate deployment at 10 to 50 percent of production rate, with latency and error comparisons surfaced in a dashboard. Tools like `goreplay`, AWS `replay-traffic`, Uber's `shadowreader`, or a custom `tee` proxy in the LB can all produce this. A shadow test that runs continuously against a canary is worth more than any benchmark suite, because it surfaces real regressions from real traffic before they reach production, and it provides a post-incident reference for "what did this look like the day before the change." For any service targeting 1M RPS, insist on shadow traffic in the rollout plan, and treat the absence of it as a launch-blocking risk.

---
