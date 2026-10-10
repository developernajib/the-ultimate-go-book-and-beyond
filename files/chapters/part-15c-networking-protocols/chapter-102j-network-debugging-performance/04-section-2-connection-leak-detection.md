## 102J.2 Connection Leak Detection

### 2.1 Goroutine and File Descriptor Leak Detection

Connection leaks manifest as a steadily growing goroutine count paired with rising file descriptor usage, eventually causing `too many open files` errors. The `ConnLeakDetector` below takes a baseline goroutine count at startup, then periodically compares the live count against that baseline, when the delta exceeds a configurable threshold, it captures a full goroutine profile stack so the exact origin of the leaked goroutines can be identified without attaching a debugger to the running process.

```go
package netdebug

import (
	"context"
	"io"
	"net/http"
	"os"
	"runtime"
	"runtime/pprof"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ConnLeakDetector monitors for connection leaks using goroutine tracking.
type ConnLeakDetector struct {
	baseline        int
	goroutineSnap   []byte
	interval        time.Duration
	threshold       int
	onLeak          func(delta int, details string)
}

// NewConnLeakDetector creates a detector that alerts when goroutine count
// exceeds baseline by threshold.
func NewConnLeakDetector(threshold int, interval time.Duration, onLeak func(int, string)) *ConnLeakDetector {
	d := &ConnLeakDetector{
		baseline:  runtime.NumGoroutine(),
		interval:  interval,
		threshold: threshold,
		onLeak:    onLeak,
	}
	d.snapshotGoroutines()
	return d
}

func (d *ConnLeakDetector) snapshotGoroutines() {
	var buf strings.Builder
	p := pprof.Lookup("goroutine")
	p.WriteTo(&buf, 1)
	d.goroutineSnap = []byte(buf.String())
}

// Start begins periodic leak checking.
func (d *ConnLeakDetector) Start(ctx context.Context) {
	ticker := time.NewTicker(d.interval)
	go func() {
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				current := runtime.NumGoroutine()
				delta := current - d.baseline
				if delta > d.threshold {
					var details strings.Builder
					p := pprof.Lookup("goroutine")
					p.WriteTo(&details, 1)
					d.onLeak(delta, details.String())
				}
			case <-ctx.Done():
				return
			}
		}
	}()
}

// FDCount returns the number of open file descriptors for this process.
// Linux-only - returns -1 on other platforms.
func FDCount() int {
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		return -1
	}
	return len(entries)
}

// FDLeakMonitor tracks fd count and alerts on growth.
type FDLeakMonitor struct {
	baseline int
	limit    int
	onLeak   func(current, baseline int)
}

func NewFDLeakMonitor(limit int, onLeak func(int, int)) *FDLeakMonitor {
	return &FDLeakMonitor{
		baseline: FDCount(),
		limit:    limit,
		onLeak:   onLeak,
	}
}

func (m *FDLeakMonitor) Check() {
	current := FDCount()
	if current > m.limit {
		m.onLeak(current, m.baseline)
	}
}

// TrackedTransport is an http.RoundTripper that counts active connections.
type TrackedTransport struct {
	base           http.RoundTripper
	active         atomic.Int64
	total          atomic.Int64
	leaked         atomic.Int64
	maxConcurrent  atomic.Int64
}

func NewTrackedTransport(base http.RoundTripper) *TrackedTransport {
	return &TrackedTransport{base: base}
}

func (t *TrackedTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.active.Add(1)
	t.total.Add(1)

	current := t.active.Load()
	for {
		max := t.maxConcurrent.Load()
		if current <= max {
			break
		}
		if t.maxConcurrent.CompareAndSwap(max, current) {
			break
		}
	}

	resp, err := t.base.RoundTrip(req)
	if err != nil {
		t.active.Add(-1)
		return nil, err
	}

	// Wrap body to detect whether caller drains it
	resp.Body = &trackedBody{
		ReadCloser: resp.Body,
		onClose: func(drained bool) {
			t.active.Add(-1)
			if !drained {
				t.leaked.Add(1)
			}
		},
	}

	return resp, nil
}

func (t *TrackedTransport) Stats() map[string]int64 {
	return map[string]int64{
		"active":         t.active.Load(),
		"total":          t.total.Load(),
		"leaked_bodies":  t.leaked.Load(),
		"max_concurrent": t.maxConcurrent.Load(),
	}
}

type trackedBody struct {
	io.ReadCloser
	onClose  func(bool)
	drained  bool
	once     sync.Once
}

func (b *trackedBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if err == io.EOF {
		b.drained = true
	}
	return n, err
}

func (b *trackedBody) Close() error {
	err := b.ReadCloser.Close()
	b.once.Do(func() {
		b.onClose(b.drained)
	})
	return err
}
```

### 2.2 Timeout Misconfiguration Detector

Go's `http.Transport` exposes at least five independent timeout knobs, dial, TLS handshake, response header, idle connection, and the top-level `http.Client.Timeout`, and leaving any of them at their zero values allows a single misbehaving server to hold a goroutine permanently. The `AuditHTTPClientTimeouts` function inspects a live `*http.Client` and compares each timeout field against a `TimeoutConfig` appropriate for the service tier, reporting severity-graded issues so teams can triage CRITICAL goroutine-leak risks separately from MEDIUM resource-waste concerns. Three pre-built `TimeoutConfig` presets cover the most common deployment contexts: user-facing endpoints where latency budgets are tight, internal service calls where infrastructure is trusted, and batch processors where large bodies and slow upstreams are expected.

```go
package netdebug

import (
	"fmt"
	"net"
	"net/http"
	"time"
)

// TimeoutConfig holds recommended timeout ranges for different use cases.
type TimeoutConfig struct {
	DialTimeout         time.Duration
	TLSHandshake        time.Duration
	ResponseHeader      time.Duration
	IdleConn            time.Duration
	RequestTimeout      time.Duration // end-to-end
	ReadBody            time.Duration
}

// RecommendedTimeouts for different service tiers.
var (
	UserFacingTimeouts = TimeoutConfig{
		DialTimeout:    5 * time.Second,
		TLSHandshake:   10 * time.Second,
		ResponseHeader: 10 * time.Second,
		IdleConn:       90 * time.Second,
		RequestTimeout: 30 * time.Second,
		ReadBody:       30 * time.Second,
	}

	InternalServiceTimeouts = TimeoutConfig{
		DialTimeout:    1 * time.Second,
		TLSHandshake:   3 * time.Second,
		ResponseHeader: 5 * time.Second,
		IdleConn:       60 * time.Second,
		RequestTimeout: 10 * time.Second,
		ReadBody:       10 * time.Second,
	}

	BatchProcessingTimeouts = TimeoutConfig{
		DialTimeout:    10 * time.Second,
		TLSHandshake:   10 * time.Second,
		ResponseHeader: 60 * time.Second,
		IdleConn:       5 * time.Minute,
		RequestTimeout: 10 * time.Minute,
		ReadBody:       10 * time.Minute,
	}
)

// TimeoutIssue describes a misconfigured timeout.
type TimeoutIssue struct {
	Field       string
	Current     time.Duration
	Recommended time.Duration
	Severity    string
	Reason      string
}

// AuditHTTPClientTimeouts checks an http.Transport for timeout problems.
func AuditHTTPClientTimeouts(client *http.Client, rec TimeoutConfig) []TimeoutIssue {
	var issues []TimeoutIssue

	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		return []TimeoutIssue{{
			Field:    "Transport",
			Severity: "WARNING",
			Reason:   "Cannot inspect non-*http.Transport; ensure timeouts are set",
		}}
	}

	// Check DialTimeout
	if transport.DialContext == nil {
		issues = append(issues, TimeoutIssue{
			Field:    "DialTimeout",
			Severity: "CRITICAL",
			Reason:   "No dial timeout - connections can hang indefinitely on unreachable hosts",
		})
	}

	// Check TLSHandshakeTimeout
	if transport.TLSHandshakeTimeout == 0 {
		issues = append(issues, TimeoutIssue{
			Field:       "TLSHandshakeTimeout",
			Current:     0,
			Recommended: rec.TLSHandshake,
			Severity:    "CRITICAL",
			Reason:      "No TLS handshake timeout - goroutine can leak on TLS stall",
		})
	} else if transport.TLSHandshakeTimeout > 30*time.Second {
		issues = append(issues, TimeoutIssue{
			Field:       "TLSHandshakeTimeout",
			Current:     transport.TLSHandshakeTimeout,
			Recommended: rec.TLSHandshake,
			Severity:    "WARNING",
			Reason:      "TLS handshake timeout too generous - use shorter value for user-facing paths",
		})
	}

	// Check ResponseHeaderTimeout
	if transport.ResponseHeaderTimeout == 0 {
		issues = append(issues, TimeoutIssue{
			Field:       "ResponseHeaderTimeout",
			Current:     0,
			Recommended: rec.ResponseHeader,
			Severity:    "HIGH",
			Reason:      "No response header timeout - slow servers can hold connections forever",
		})
	}

	// Check IdleConnTimeout
	if transport.IdleConnTimeout == 0 {
		issues = append(issues, TimeoutIssue{
			Field:       "IdleConnTimeout",
			Current:     0,
			Recommended: rec.IdleConn,
			Severity:    "MEDIUM",
			Reason:      "No idle timeout - idle connections consume file descriptors",
		})
	}

	// Check top-level client timeout
	if client.Timeout == 0 {
		issues = append(issues, TimeoutIssue{
			Field:       "client.Timeout",
			Current:     0,
			Recommended: rec.RequestTimeout,
			Severity:    "CRITICAL",
			Reason:      "No request timeout - slow servers cause goroutine leaks indefinitely",
		})
	}

	return issues
}

// PrintTimeoutAudit formats and prints timeout audit results.
func PrintTimeoutAudit(issues []TimeoutIssue) {
	if len(issues) == 0 {
		fmt.Println("✓ No timeout issues found")
		return
	}
	for _, issue := range issues {
		icon := "⚠"
		if issue.Severity == "CRITICAL" {
			icon = "🚨"
		}
		fmt.Printf("%s [%s] %s", icon, issue.Severity, issue.Field)
		if issue.Current > 0 {
			fmt.Printf(" (current: %v, recommended: %v)", issue.Current, issue.Recommended)
		}
		fmt.Printf("\n   → %s\n", issue.Reason)
	}
}

// ConfigureHTTPClient creates a properly-configured http.Client for the given tier.
func ConfigureHTTPClient(cfg TimeoutConfig) *http.Client {
	transport := &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   cfg.DialTimeout,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSHandshakeTimeout:   cfg.TLSHandshake,
		ResponseHeaderTimeout: cfg.ResponseHeader,
		IdleConnTimeout:       cfg.IdleConn,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   10,
		DisableCompression:    false,
		ForceAttemptHTTP2:     true,
	}
	return &http.Client{
		Transport: transport,
		Timeout:   cfg.RequestTimeout,
	}
}
```

### Junior → FAANG: Detecting and Preventing Response Body Leaks

The most common connection leak in Go is not reading the response body before closing it. `http.Client.Do()` returns a response where the body is connected to the underlying TCP connection. If you close the body without draining it, or forget to close it entirely, the connection cannot be returned to the pool and is eventually garbage collected, leaving a `CLOSE_WAIT` socket in the OS.

The correct pattern is always: `defer resp.Body.Close()` plus `io.Copy(io.Discard, resp.Body)` before the close if you need to drain. The `defer` ensures the body is closed even if the function returns early. The drain ensures the connection is returned to the pool cleanly. Skipping the drain is fine only when you do not need connection reuse (one-off clients).

Interview entry point: "why do you call `io.Copy(io.Discard, resp.Body)` before closing a response body?" The answer is: "so the underlying TCP connection is returned to the pool for reuse. If the body is not fully read, the connection is closed rather than pooled, and the next request creates a new TCP connection."

### Senior @ FAANG: Connection Leak Monitoring as a Production Reliability Signal

Connection leaks are one of the few bug categories that are invisible at low load and catastrophic at high load. A service that leaks one connection per 1,000 requests is fine at 100 requests per second (0.1 leaked connections per second). At 10,000 requests per second, it leaks 10 connections per second, exhausting the OS file descriptor limit within minutes under load spikes.

The platform monitoring requirement: every service should emit file descriptor count (`process_open_fds`) and monitor it against the system limit (`process_max_fds`). An alert at 80% of the limit gives time to diagnose and fix before the service fails. Combined with goroutine count monitoring (goroutine leaks often accompany connection leaks), this provides early warning.

The testing discipline: any code path that opens a connection should have a leak test: run the code path in a loop, check goroutine count before and after, and fail the test if count grows unboundedly. `goleak` provides exactly this assertion. Making connection leak tests part of the CI suite prevents leaks from reaching production. This is a platform engineering contribution that prevents an entire class of production incidents.

---
