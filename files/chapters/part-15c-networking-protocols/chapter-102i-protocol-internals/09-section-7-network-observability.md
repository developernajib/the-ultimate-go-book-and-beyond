## 102I.7 Network Observability and Protocol Tracing

### 7.1 Protocol-Level Tracing

Go's `net/http/httptrace` package provides hooks that fire at every phase of an HTTP request, from DNS resolution through TLS handshake to the first response byte. Attaching a `ClientTrace` to the request context adds zero overhead to requests that do not use it and allows pinpointing exactly which phase is slow, whether DNS cache misses, TCP connect latency, or TLS renegotiation. The `TraceHTTPRequest` function below captures timestamps at each hook and computes deltas for a complete waterfall view of the connection lifecycle.

```go
package netobs

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"net/http/httptrace"
	"sync"
	"sync/atomic"
	"time"
)

// TracePoint records timing for a specific network event.
type TracePoint struct {
	Name      string
	Timestamp time.Time
	Duration  time.Duration // from previous event
}

// ConnTrace records the full lifecycle of an HTTP connection.
type ConnTrace struct {
	URL           string
	Points        []TracePoint
	TLSInfo       *tls.ConnectionState
	RemoteAddr    string
	Reused        bool
	Error         error
	Total         time.Duration
}

// AddPoint records a trace event relative to the previous one.
func (ct *ConnTrace) AddPoint(name string) {
	now := time.Now()
	var dur time.Duration
	if len(ct.Points) > 0 {
		dur = now.Sub(ct.Points[len(ct.Points)-1].Timestamp)
	}
	ct.Points = append(ct.Points, TracePoint{
		Name:      name,
		Timestamp: now,
		Duration:  dur,
	})
}

func (ct *ConnTrace) String() string {
	out := fmt.Sprintf("URL: %s (reused=%v, addr=%s)\n", ct.URL, ct.Reused, ct.RemoteAddr)
	for _, p := range ct.Points {
		out += fmt.Sprintf("  %-30s +%v\n", p.Name, p.Duration.Round(time.Microsecond))
	}
	out += fmt.Sprintf("  %-30s = %v\n", "TOTAL", ct.Total)
	return out
}

// TraceHTTPRequest executes an HTTP request with full connection tracing.
func TraceHTTPRequest(ctx context.Context, client *http.Client, method, url string) (*ConnTrace, *http.Response, error) {
	trace := &ConnTrace{URL: url}
	start := time.Now()

	clientTrace := &httptrace.ClientTrace{
		GetConn: func(hostPort string) {
			trace.AddPoint("GetConn")
		},
		GotConn: func(info httptrace.GotConnInfo) {
			trace.Reused = info.Reused
			trace.RemoteAddr = info.Conn.RemoteAddr().String()
			trace.AddPoint(fmt.Sprintf("GotConn(reused=%v)", info.Reused))
		},
		PutIdleConn: func(err error) {
			if err != nil {
				trace.AddPoint(fmt.Sprintf("PutIdleConn(err=%v)", err))
			}
		},
		GotFirstResponseByte: func() {
			trace.AddPoint("FirstByte")
		},
		DNSStart: func(info httptrace.DNSStartInfo) {
			trace.AddPoint("DNSStart")
		},
		DNSDone: func(info httptrace.DNSDoneInfo) {
			trace.AddPoint(fmt.Sprintf("DNSDone(err=%v)", info.Err))
		},
		ConnectStart: func(network, addr string) {
			trace.AddPoint(fmt.Sprintf("ConnectStart(%s %s)", network, addr))
		},
		ConnectDone: func(network, addr string, err error) {
			trace.AddPoint(fmt.Sprintf("ConnectDone(err=%v)", err))
		},
		TLSHandshakeStart: func() {
			trace.AddPoint("TLSHandshakeStart")
		},
		TLSHandshakeDone: func(state tls.ConnectionState, err error) {
			trace.TLSInfo = &state
			version := map[uint16]string{
				tls.VersionTLS12: "1.2",
				tls.VersionTLS13: "1.3",
			}[state.Version]
			trace.AddPoint(fmt.Sprintf("TLSHandshakeDone(v=%s,resumed=%v,err=%v)",
				version, state.DidResume, err))
		},
		WroteHeaderField: nil, // too verbose
		WroteHeaders: func() {
			trace.AddPoint("WroteHeaders")
		},
		WroteRequest: func(info httptrace.WroteRequestInfo) {
			trace.AddPoint(fmt.Sprintf("WroteRequest(err=%v)", info.Err))
		},
	}

	req, err := http.NewRequestWithContext(httptrace.WithClientTrace(ctx, clientTrace), method, url, nil)
	if err != nil {
		return trace, nil, err
	}

	resp, err := client.Do(req)
	trace.Total = time.Since(start)
	trace.Error = err

	return trace, resp, err
}

// NetworkMetrics tracks connection-level statistics.
type NetworkMetrics struct {
	TotalConnections    int64
	ActiveConnections   int64
	ReusedConnections   int64
	DNSHits             int64
	TLSHandshakes       int64
	TLSResumptions      int64
	AvgDNSLatencyMs     float64
	AvgTCPLatencyMs     float64
	AvgTLSLatencyMs     float64
	AvgTTFBMs           float64 // Time To First Byte
}

// InstrumentedTransport wraps http.Transport with metrics collection.
type InstrumentedTransport struct {
	base    http.RoundTripper
	metrics *NetworkMetrics
	mu      sync.Mutex
}

func NewInstrumentedTransport(base http.RoundTripper) *InstrumentedTransport {
	return &InstrumentedTransport{
		base:    base,
		metrics: &NetworkMetrics{},
	}
}

func (t *InstrumentedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	var (
		dnsStart, dnsEnd           time.Time
		connectStart, connectEnd   time.Time
		tlsStart, tlsEnd           time.Time
		ttfb                       time.Time
	)

	ctx := httptrace.WithClientTrace(req.Context(), &httptrace.ClientTrace{
		GotConn: func(info httptrace.GotConnInfo) {
			atomic.AddInt64(&t.metrics.ActiveConnections, 1)
			if info.Reused {
				atomic.AddInt64(&t.metrics.ReusedConnections, 1)
			} else {
				atomic.AddInt64(&t.metrics.TotalConnections, 1)
			}
		},
		DNSStart:  func(_ httptrace.DNSStartInfo) { dnsStart = time.Now() },
		DNSDone:   func(_ httptrace.DNSDoneInfo) { dnsEnd = time.Now() },
		ConnectStart: func(_, _ string) { connectStart = time.Now() },
		ConnectDone:  func(_, _ string, _ error) { connectEnd = time.Now() },
		TLSHandshakeStart: func() {
			tlsStart = time.Now()
			atomic.AddInt64(&t.metrics.TLSHandshakes, 1)
		},
		TLSHandshakeDone: func(state tls.ConnectionState, _ error) {
			tlsEnd = time.Now()
			if state.DidResume {
				atomic.AddInt64(&t.metrics.TLSResumptions, 1)
			}
		},
		GotFirstResponseByte: func() { ttfb = time.Now() },
	})

	resp, err := t.base.RoundTrip(req.WithContext(ctx))
	if err == nil {
		atomic.AddInt64(&t.metrics.ActiveConnections, -1)
	}

	// Update rolling averages (simplified - production would use HDR histogram)
	t.mu.Lock()
	defer t.mu.Unlock()
	if !dnsStart.IsZero() && !dnsEnd.IsZero() {
		t.metrics.AvgDNSLatencyMs = (t.metrics.AvgDNSLatencyMs + float64(dnsEnd.Sub(dnsStart).Milliseconds())) / 2
	}
	if !connectStart.IsZero() && !connectEnd.IsZero() {
		t.metrics.AvgTCPLatencyMs = (t.metrics.AvgTCPLatencyMs + float64(connectEnd.Sub(connectStart).Milliseconds())) / 2
	}
	if !tlsStart.IsZero() && !tlsEnd.IsZero() {
		t.metrics.AvgTLSLatencyMs = (t.metrics.AvgTLSLatencyMs + float64(tlsEnd.Sub(tlsStart).Milliseconds())) / 2
	}
	if !ttfb.IsZero() {
		t.metrics.AvgTTFBMs = (t.metrics.AvgTTFBMs + float64(ttfb.UnixNano()/1e6)) / 2
	}

	return resp, err
}

func (t *InstrumentedTransport) GetMetrics() NetworkMetrics {
	t.mu.Lock()
	defer t.mu.Unlock()
	return *t.metrics
}
```

### Junior → FAANG: httptrace as a Diagnostic Tool

`net/http/httptrace` is one of Go's most useful but underused diagnostic packages. It lets you measure every phase of an HTTP request without modifying the server: DNS lookup duration, TCP connection establishment time, TLS handshake time, and time to first byte of the response body. When a service has high latency but application-level profiling shows no bottleneck, `httptrace` is the next tool to reach for.

The practical approach: add `httptrace` instrumentation to a test or staging environment, run it against the slow endpoint, and look at which phase is long. If DNS is long, investigate DNS caching configuration. If TLS is long, investigate whether session resumption is working. If TTFB (time to first byte) is long after a short connect time, the latency is in the server's request processing, not in the network.

Interview entry point: when asked "how would you diagnose unexplained HTTP client latency?", describe `httptrace` as the tool that decomposes total latency into network protocol phases, enabling targeted diagnosis rather than guessing.

### Senior @ FAANG: Network Observability at the Service Mesh Layer

At FAANG scale, individual service `httptrace` instrumentation is supplemented by mesh-level observability. Envoy sidecar proxies emit Prometheus metrics for every connection and stream: connection establishment latency, TLS handshake duration, request/response latency per upstream cluster, and retry/timeout counts. These metrics are available without code changes to the application services.

The L6 value-add is correlating mesh-level metrics with application-level traces. A request that shows high latency in the mesh (long upstream response time) but normal latency in the application trace (fast handler execution) indicates the latency is between services, not in either service's code. A request that shows normal mesh latency but high application latency indicates the bottleneck is in the application code or its downstream dependencies (database, cache). Without both layers of observability, these two cases look identical in a simple latency histogram.

Platform-level network observability at FAANG includes eBPF-based network monitoring (via tools like Pixie or Cilium's Hubble) that provides per-connection latency, packet loss, and retransmission data at the kernel level without requiring any application instrumentation. This is the observability layer that reveals kernel-level TCP behavior that no application-level tool can see.

---
