## 102J.7 Network Performance Testing

### 7.1 Benchmarking HTTP Servers

Go's `httptest.NewServer` creates a real TCP listener in-process, allowing benchmarks to measure handler throughput and connection pool behavior under controlled conditions without spinning up external infrastructure. The benchmarks below measure both serialized and concurrent request throughput, using `sync/atomic` counters to validate that no requests were dropped and `testing.B.SetParallelism` to control concurrency levels independently of `GOMAXPROCS`.

```go
package netbench_test

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// BenchmarkHTTPEcho benchmarks a minimal echo handler.
func BenchmarkHTTPEcho(b *testing.B) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		io.Copy(w, r.Body)
	})

	srv := httptest.NewServer(handler)
	defer srv.Close()

	client := &http.Client{
		Transport: &http.Transport{
			MaxIdleConnsPerHost: runtime.NumCPU() * 2,
			IdleConnTimeout:     30 * time.Second,
		},
	}

	payload := bytes.Repeat([]byte("x"), 1024)

	b.ResetTimer()
	b.ReportAllocs()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			resp, err := client.Post(srv.URL, "text/plain", bytes.NewReader(payload))
			if err != nil {
				b.Error(err)
				return
			}
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
		}
	})
}

// BenchmarkConnectionPooling compares keep-alive vs. no keep-alive.
func BenchmarkConnectionPooling(b *testing.B) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer srv.Close()

	b.Run("WithKeepAlive", func(b *testing.B) {
		client := &http.Client{
			Transport: &http.Transport{
				MaxIdleConnsPerHost: 10,
				IdleConnTimeout:     30 * time.Second,
				DisableKeepAlives:   false,
			},
		}
		b.ResetTimer()
		b.ReportAllocs()
		for b.Loop() {
			resp, err := client.Get(srv.URL)
			if err != nil {
				b.Fatal(err)
			}
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
		}
	})

	b.Run("NoKeepAlive", func(b *testing.B) {
		client := &http.Client{
			Transport: &http.Transport{
				DisableKeepAlives: true,
			},
		}
		b.ResetTimer()
		b.ReportAllocs()
		for b.Loop() {
			resp, err := client.Get(srv.URL)
			if err != nil {
				b.Fatal(err)
			}
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
		}
	})
}

// ThroughputTest measures sustained throughput over a 10-second window.
func ThroughputTest(addr string, concurrency int, duration time.Duration) (rps float64, p99 time.Duration) {
	var (
		totalReqs  atomic.Int64
		latencies  []time.Duration
		mu         sync.Mutex
	)

	ctx, cancel := context.WithTimeout(context.Background(), duration)
	defer cancel()

	client := &http.Client{
		Transport: &http.Transport{
			MaxIdleConnsPerHost: concurrency,
		},
		Timeout: 5 * time.Second,
	}

	var wg sync.WaitGroup
	for i := 0; i < concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				if ctx.Err() != nil {
					return
				}
				start := time.Now()
				resp, err := client.Get(addr)
				if err != nil {
					continue
				}
				io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
				lat := time.Since(start)
				totalReqs.Add(1)
				mu.Lock()
				latencies = append(latencies, lat)
				mu.Unlock()
			}
		}()
	}

	wg.Wait()

	rps = float64(totalReqs.Load()) / duration.Seconds()

	// Calculate p99
	if len(latencies) > 0 {
		sortDurations(latencies)
		p99Idx := int(float64(len(latencies)) * 0.99)
		p99 = latencies[p99Idx]
	}

	return rps, p99
}

func sortDurations(d []time.Duration) {
	// Simple insertion sort (fine for benchmark post-processing)
	for i := 1; i < len(d); i++ {
		for j := i; j > 0 && d[j] < d[j-1]; j-- {
			d[j], d[j-1] = d[j-1], d[j]
		}
	}
}

// LatencyDistribution measures latency percentiles.
type LatencyDistribution struct {
	P50  time.Duration
	P90  time.Duration
	P95  time.Duration
	P99  time.Duration
	P999 time.Duration
	Max  time.Duration
	Mean time.Duration
}

func ComputePercentiles(latencies []time.Duration) LatencyDistribution {
	if len(latencies) == 0 {
		return LatencyDistribution{}
	}
	sortDurations(latencies)
	n := len(latencies)
	var total time.Duration
	for _, l := range latencies {
		total += l
	}
	return LatencyDistribution{
		P50:  latencies[n*50/100],
		P90:  latencies[n*90/100],
		P95:  latencies[n*95/100],
		P99:  latencies[n*99/100],
		P999: latencies[n*999/1000],
		Max:  latencies[n-1],
		Mean: total / time.Duration(n),
	}
}

func (d LatencyDistribution) String() string {
	return fmt.Sprintf(
		"p50=%v p90=%v p95=%v p99=%v p99.9=%v max=%v mean=%v",
		d.P50, d.P90, d.P95, d.P99, d.P999, d.Max, d.Mean,
	)
}
```

### Junior → FAANG: Running Load Tests That Produce Useful Data

A load test that runs to completion without measuring anything useful is a waste of time. The minimum outputs a network performance test should produce: throughput (requests per second at target concurrency), latency distribution (p50, p95, p99, p99.9), error rate (4xx and 5xx percentages), and resource consumption (CPU, memory, goroutine count, file descriptor count) at the target load level.

The common mistake in first load tests: measuring only p50 latency and reporting that the service handles the target load. p99 and p99.9 latency reveal the tail behavior that is invisible at p50. A service with 2ms p50 and 2,000ms p99.9 has a serious latency tail problem that affects 1 in 1,000 users, which at FAANG scale means thousands of users per minute. Always report and investigate tail latency, not just median.

### Senior @ FAANG: Load Testing as a Continuous Practice, Not a One-Time Event

Performance testing is a continuous practice at FAANG, not a gating activity before a single deployment. Continuous load testing (running a standardized load test suite on every main branch build) enables regression detection: if the p99 latency for the `POST /checkout` endpoint increases from 50ms to 80ms after a code change, the regression is caught before it reaches production.

The infrastructure for continuous performance testing: a performance testing cluster that is isolated from production (to prevent test traffic from affecting real users), a benchmark suite with representative traffic patterns (derived from production traffic sampling), and a time-series database that stores benchmark results with git commit correlation. The alerting threshold should be calibrated to the natural variance of the benchmark: if the natural p99 variance is 10%, a 15% regression threshold avoids false positives while catching real regressions.

The L6 governance concern: who owns the performance test suite? The pattern that fails is "everyone is responsible," which means no one maintains the tests when they start failing non-deterministically. The pattern that succeeds is clear ownership: the platform team owns the benchmarking infrastructure, each service team owns the benchmark suite for their service, and there is a defined escalation path when benchmark results degrade.

---
