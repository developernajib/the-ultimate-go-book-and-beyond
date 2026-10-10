## 102J.4 Network Performance Optimization

### 4.1 HTTP Client Pool Optimization

Misconfigured HTTP transport settings are a common source of latency and connection exhaustion in Go services. The `OptimalTransportConfig` below applies Little's Law (`N = λ * W`) to derive the number of concurrent connections needed to sustain a target QPS at a given average latency, preventing both under-provisioning (request queuing) and over-provisioning (wasted file descriptors and memory). The computed `MaxIdleConnsPerHost` value ensures the pool can fully absorb burst traffic without re-establishing connections.

```go
package netperf

import (
	"fmt"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// OptimalTransportConfig computes the best transport settings for the runtime.
type OptimalTransportConfig struct {
	TargetQPS        float64
	AvgRequestMs     float64
	NumCPU           int
	P99LatencyTarget time.Duration
}

// Compute derives transport parameters from load expectations.
func (c OptimalTransportConfig) Compute() *http.Transport {
	// Little's Law: N = λ * W
	// N = concurrent connections needed
	// λ = requests per second
	// W = average response time
	littlesN := c.TargetQPS * (c.AvgRequestMs / 1000.0)
	concurrentConns := int(littlesN * 1.5) // 50% headroom

	perHostConns := concurrentConns
	if perHostConns < 10 {
		perHostConns = 10
	}
	if perHostConns > 200 {
		perHostConns = 200
	}

	// Timeout = p99 target + reasonable overhead
	dialTimeout := c.P99LatencyTarget / 3
	headerTimeout := c.P99LatencyTarget

	return &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   dialTimeout,
			KeepAlive: 30 * time.Second,
			DualStack: true,
		}).DialContext,
		TLSHandshakeTimeout:   dialTimeout * 2,
		ResponseHeaderTimeout: headerTimeout,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConns:          concurrentConns * 2,
		MaxIdleConnsPerHost:   perHostConns,
		MaxConnsPerHost:       perHostConns * 2,
		DisableKeepAlives:     false,
		ForceAttemptHTTP2:     true,
	}
}

// PerHostClientPool maintains separate http.Client instances per host.
// This avoids head-of-line blocking at the pool level for diverse workloads.
type PerHostClientPool struct {
	clients sync.Map // host → *http.Client
	cfgFn   func(host string) *http.Transport
}

func NewPerHostClientPool(cfgFn func(host string) *http.Transport) *PerHostClientPool {
	return &PerHostClientPool{cfgFn: cfgFn}
}

func (p *PerHostClientPool) Get(host string) *http.Client {
	if v, ok := p.clients.Load(host); ok {
		return v.(*http.Client)
	}

	transport := p.cfgFn(host)
	client := &http.Client{
		Transport: transport,
		Timeout:   30 * time.Second,
	}

	v, _ := p.clients.LoadOrStore(host, client)
	return v.(*http.Client)
}

// BandwidthMeasurer measures actual throughput for a connection.
type BandwidthMeasurer struct {
	bytesTransferred atomic.Int64
	startTime        time.Time
	mu               sync.Mutex
}

func NewBandwidthMeasurer() *BandwidthMeasurer {
	return &BandwidthMeasurer{startTime: time.Now()}
}

// MeasuredConn wraps a net.Conn to track bytes.
type MeasuredConn struct {
	net.Conn
	measurer *BandwidthMeasurer
}

func (c *MeasuredConn) Read(b []byte) (int, error) {
	n, err := c.Conn.Read(b)
	c.measurer.bytesTransferred.Add(int64(n))
	return n, err
}

func (c *MeasuredConn) Write(b []byte) (int, error) {
	n, err := c.Conn.Write(b)
	c.measurer.bytesTransferred.Add(int64(n))
	return n, err
}

// Throughput returns current throughput in bytes per second.
func (m *BandwidthMeasurer) Throughput() float64 {
	elapsed := time.Since(m.startTime).Seconds()
	if elapsed < 0.001 {
		return 0
	}
	return float64(m.bytesTransferred.Load()) / elapsed
}

// ThroughputStr returns human-readable throughput.
func (m *BandwidthMeasurer) ThroughputStr() string {
	bps := m.Throughput()
	switch {
	case bps >= 1e9:
		return fmt.Sprintf("%.2f GB/s", bps/1e9)
	case bps >= 1e6:
		return fmt.Sprintf("%.2f MB/s", bps/1e6)
	case bps >= 1e3:
		return fmt.Sprintf("%.2f KB/s", bps/1e3)
	default:
		return fmt.Sprintf("%.0f B/s", bps)
	}
}
```

### 4.2 Request Coalescing and Batching

When multiple goroutines concurrently request the same resource, a cache miss, a user profile lookup, or a remote config fetch, sending one network round-trip per caller multiplies load on the upstream service and inflates tail latency across all callers. The generic `SingleFlight` type deduplicates these concurrent identical requests by keying in-flight calls on a comparable key: the first caller executes the actual fetch while all subsequent callers for the same key block on a shared channel, receiving the result once the single in-flight request completes. For workloads where requests are not identical but involve fetching by a set of keys, `BatchFetcher` uses a short coalescing window (`delay`) to accumulate individual key requests and dispatch them as a single bulk call, directly eliminating N+1 network patterns without requiring callers to coordinate manually.

```go
package netperf

import (
	"context"
	"fmt"
	"sync"
	"time"
)

// RequestKey identifies a deduplicatable request.
type RequestKey string

// CoalescedResult is the result of a coalesced request.
type CoalescedResult[T any] struct {
	Value T
	Err   error
}

// SingleFlight deduplicates concurrent identical requests.
// Multiple callers for the same key share a single in-flight request.
type SingleFlight[K comparable, V any] struct {
	mu       sync.Mutex
	inflight map[K]*call[V]
}

type call[V any] struct {
	done chan struct{}
	val  V
	err  error
}

// Do executes fn if no call for key is in flight, else waits for existing call.
func (g *SingleFlight[K, V]) Do(ctx context.Context, key K, fn func(context.Context) (V, error)) (V, error) {
	g.mu.Lock()
	if g.inflight == nil {
		g.inflight = make(map[K]*call[V])
	}

	if c, ok := g.inflight[key]; ok {
		g.mu.Unlock()
		// Wait for existing call or context cancellation
		select {
		case <-c.done:
			return c.val, c.err
		case <-ctx.Done():
			var zero V
			return zero, ctx.Err()
		}
	}

	c := &call[V]{done: make(chan struct{})}
	g.inflight[key] = c
	g.mu.Unlock()

	c.val, c.err = fn(ctx)

	g.mu.Lock()
	delete(g.inflight, key)
	g.mu.Unlock()

	close(c.done)
	return c.val, c.err
}

// BatchFetcher groups multiple individual requests into a single batch call.
// Useful for reducing N+1 query patterns over the network.
type BatchFetcher[K comparable, V any] struct {
	fetchFn    func(ctx context.Context, keys []K) (map[K]V, error)
	pending    map[K][]chan CoalescedResult[V]
	mu         sync.Mutex
	delay      time.Duration
	timer      *time.Timer
	maxBatch   int
}

// NewBatchFetcher creates a fetcher that accumulates keys for delay duration.
func NewBatchFetcher[K comparable, V any](
	fetchFn func(context.Context, []K) (map[K]V, error),
	delay time.Duration,
	maxBatch int,
) *BatchFetcher[K, V] {
	return &BatchFetcher[K, V]{
		fetchFn:  fetchFn,
		pending:  make(map[K][]chan CoalescedResult[V]),
		delay:    delay,
		maxBatch: maxBatch,
	}
}

// Fetch queues a key for batch retrieval.
func (b *BatchFetcher[K, V]) Fetch(ctx context.Context, key K) (V, error) {
	ch := make(chan CoalescedResult[V], 1)

	b.mu.Lock()
	b.pending[key] = append(b.pending[key], ch)
	needsTimer := len(b.pending) == 1

	// Flush immediately if batch size reached
	if len(b.pending) >= b.maxBatch {
		pending := b.pending
		b.pending = make(map[K][]chan CoalescedResult[V])
		if b.timer != nil {
			b.timer.Stop()
			b.timer = nil
		}
		b.mu.Unlock()
		go b.flush(ctx, pending)
	} else {
		if needsTimer {
			b.timer = time.AfterFunc(b.delay, func() {
				b.mu.Lock()
				pending := b.pending
				b.pending = make(map[K][]chan CoalescedResult[V])
				b.timer = nil
				b.mu.Unlock()
				go b.flush(ctx, pending)
			})
		}
		b.mu.Unlock()
	}

	select {
	case result := <-ch:
		return result.Value, result.Err
	case <-ctx.Done():
		var zero V
		return zero, ctx.Err()
	}
}

func (b *BatchFetcher[K, V]) flush(ctx context.Context, pending map[K][]chan CoalescedResult[V]) {
	keys := make([]K, 0, len(pending))
	for k := range pending {
		keys = append(keys, k)
	}

	results, err := b.fetchFn(ctx, keys)

	for key, channels := range pending {
		var result CoalescedResult[V]
		if err != nil {
			result.Err = err
		} else if v, ok := results[key]; ok {
			result.Value = v
		} else {
			result.Err = fmt.Errorf("key not found: %v", key)
		}
		for _, ch := range channels {
			ch <- result
		}
	}
}
```

### Junior → FAANG: The Three Levers That Matter Most

HTTP client performance optimization has three most productive levers. First, `MaxIdleConnsPerHost`: set it to the expected concurrency level. Default is 2, which is almost always too low. For a service making 50 concurrent requests to the same host, set it to 60-80 (with headroom). Second, `IdleConnTimeout`: set it lower than the server's keepalive timeout to avoid sending requests on connections the server has already closed. Third, `DisableKeepAlives`: never set this to true unless you specifically need one-off connections (it disables connection reuse entirely).

The measurement that validates your tuning: watch `httptrace.GotConn.Reused` in your traces. If more than 20% of connections are newly created rather than reused, investigate why. New connections mean repeated DNS lookups and TLS handshakes, which add latency that connection reuse avoids.

### Senior @ FAANG: Transport Configuration as a Data-Driven SLO Activity

Transport configuration is not a one-time setup. It is a continuously monitored and adjusted configuration based on observed traffic patterns. A service that starts at 50 requests per second and grows to 500 requests per second needs a corresponding increase in `MaxIdleConnsPerHost` to maintain the same connection reuse rate.

The platform approach: expose connection pool metrics as Prometheus gauges (`transport_idle_connections`, `transport_in_use_connections`, `transport_total_connections`), set alerts when idle connection utilization drops below 60% (indicating the pool is undersized), and review transport configuration as part of service capacity reviews. Transport misconfiguration is one of the most common and most easily fixable causes of unnecessary latency in Go services, but it is only addressed systematically when the metrics are visible.

The L6 pattern: transport configuration defaults should be adjusted based on the deployment class. A service class for high-throughput internal RPCs should have different transport defaults than a service class for occasional external API calls. Encoding these defaults into deployment manifests or platform SDK configuration reduces the per-service tuning burden.

---
