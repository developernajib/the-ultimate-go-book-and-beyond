## 102B.11 Network Performance in Go

### Complete Production HTTP Client Configuration

A production Go HTTP client requires careful tuning of connection pool settings, timeouts, and TLS configuration to avoid common performance pitfalls like connection exhaustion, slow response tails, and excessive TLS handshake overhead. The `Transport` struct controls the connection pool: `MaxIdleConnsPerHost` should be set to at least the expected concurrency per upstream host, while `IdleConnTimeout` recycles stale connections before the server-side timeout forces a reset. Using `httptrace.ClientTrace` to measure each phase of the request lifecycle (DNS lookup, TCP connect, TLS handshake, first byte) is essential for diagnosing which layer is responsible for latency spikes.

```go
package httpclient

import (
    "bytes"
    "context"
    "crypto/tls"
    "fmt"
    "io"
    "net"
    "net/http"
    "net/http/httptrace"
    "time"
)

// Config holds all configuration for the production HTTP client.
type Config struct {
    // Connection timeouts.
    DialTimeout            time.Duration
    TLSHandshakeTimeout    time.Duration
    ResponseHeaderTimeout  time.Duration
    // Overall request timeout (covers everything from dial to last byte of response body).
    RequestTimeout         time.Duration

    // Connection pool configuration.
    MaxIdleConns        int
    MaxIdleConnsPerHost int
    IdleConnTimeout     time.Duration

    // TLS configuration.
    TLSConfig *tls.Config
}

// DefaultConfig returns production-ready defaults.
func DefaultConfig() Config {
    return Config{
        DialTimeout:           5 * time.Second,
        TLSHandshakeTimeout:   5 * time.Second,
        ResponseHeaderTimeout: 10 * time.Second,
        RequestTimeout:        30 * time.Second,
        MaxIdleConns:          1000,
        MaxIdleConnsPerHost:   100,
        IdleConnTimeout:       90 * time.Second,
    }
}

// NewClient creates a production-grade HTTP client with comprehensive timeout configuration.
func NewClient(cfg Config) *http.Client {
    transport := &http.Transport{
        DialContext: (&net.Dialer{
            Timeout:   cfg.DialTimeout,
            KeepAlive: 30 * time.Second,
        }).DialContext,
        MaxIdleConns:          cfg.MaxIdleConns,
        MaxIdleConnsPerHost:   cfg.MaxIdleConnsPerHost,
        IdleConnTimeout:       cfg.IdleConnTimeout,
        TLSHandshakeTimeout:   cfg.TLSHandshakeTimeout,
        ExpectContinueTimeout: 1 * time.Second,
        ForceAttemptHTTP2:     true,
        TLSClientConfig:       cfg.TLSConfig,
        // ResponseHeaderTimeout is set on the Transport, not the Client.
        // It covers time from sending the request to receiving the first response byte.
        ResponseHeaderTimeout: cfg.ResponseHeaderTimeout,
    }

    return &http.Client{
        Transport: transport,
        Timeout:   cfg.RequestTimeout,
    }
}

// TracedRequest performs an HTTP request with detailed timing instrumentation.
// Use this in development and performance testing to understand where time is spent.
func TracedRequest(ctx context.Context, client *http.Client, req *http.Request) (*http.Response, *Timing, error) {
    timing := &Timing{}
    var dnsStart, connectStart, tlsStart, firstByte time.Time

    trace := &httptrace.ClientTrace{
        DNSStart:          func(i httptrace.DNSStartInfo) { dnsStart = time.Now() },
        DNSDone:           func(i httptrace.DNSDoneInfo) { timing.DNS = time.Since(dnsStart) },
        ConnectStart:      func(network, addr string) { connectStart = time.Now() },
        ConnectDone:       func(network, addr string, err error) { timing.Connect = time.Since(connectStart) },
        TLSHandshakeStart: func() { tlsStart = time.Now() },
        TLSHandshakeDone:  func(tls.ConnectionState, error) { timing.TLS = time.Since(tlsStart) },
        GotFirstResponseByte: func() {
            if firstByte.IsZero() {
                firstByte = time.Now()
            }
        },
    }

    start := time.Now()
    req = req.WithContext(httptrace.WithClientTrace(ctx, trace))
    resp, err := client.Do(req)
    if err != nil {
        return nil, nil, fmt.Errorf("do request: %w", err)
    }

    // Read body to get total time including body transfer.
    body, err := io.ReadAll(resp.Body)
    resp.Body.Close()
    if err != nil {
        return nil, nil, fmt.Errorf("read body: %w", err)
    }

    timing.Total = time.Since(start)
    timing.BodySize = len(body)

    // Replace body so the caller can read it.
    resp.Body = io.NopCloser(bytes.NewReader(body))
    return resp, timing, nil
}

// Timing holds the breakdown of time spent in each phase of an HTTP request.
type Timing struct {
    DNS      time.Duration // DNS resolution
    Connect  time.Duration // TCP connection establishment
    TLS      time.Duration // TLS handshake
    Total    time.Duration // total including body read
    BodySize int           // response body bytes
}

func (t *Timing) String() string {
    return fmt.Sprintf(
        "dns=%.1fms connect=%.1fms tls=%.1fms total=%.1fms body=%dB",
        float64(t.DNS.Nanoseconds())/1e6,
        float64(t.Connect.Nanoseconds())/1e6,
        float64(t.TLS.Nanoseconds())/1e6,
        float64(t.Total.Nanoseconds())/1e6,
        t.BodySize,
    )
}
```

### Buffer Sizes: Optimizing for Throughput vs Latency

The default 4 KB read/write buffers in `http.Transport` are optimized for small, frequent requests, but they become a bottleneck when transferring large payloads because the kernel must be called thousands of times to move data that could fit in a single large buffer. Conversely, low-latency interactive workloads benefit from tighter connection pools and aggressive timeouts to shed slow backends quickly rather than holding goroutines hostage waiting for unresponsive upstreams. The two transports below capture these opposing trade-offs: `LargeTransferTransport` widens the I/O buffers to 128 KB to minimize syscall overhead on bulk transfers, while `LowLatencyTransport` shrinks timeouts and keeps a larger idle pool so individual requests can reuse warm connections without competing for slots.

```go
package httpclient

import (
    "net"
    "net/http"
    "time"
)

// LargeTransferTransport optimizes for bulk data transfer (backups, uploads, streaming).
func LargeTransferTransport() *http.Transport {
    return &http.Transport{
        DialContext: (&net.Dialer{
            Timeout:   30 * time.Second,
            KeepAlive: 60 * time.Second,
        }).DialContext,
        MaxIdleConns:        10, // fewer connections, but they carry more data
        MaxIdleConnsPerHost: 5,
        IdleConnTimeout:     300 * time.Second, // keep alive longer for bulk transfers
        // WriteBufferSize: for large request bodies.
        WriteBufferSize: 128 * 1024, // 128KB write buffer
        // ReadBufferSize: for large response bodies.
        ReadBufferSize: 128 * 1024, // 128KB read buffer
        // Default is 4KB - too small for bulk transfers, causing excessive syscalls.
    }
}

// LowLatencyTransport optimizes for interactive, small-payload requests.
func LowLatencyTransport() *http.Transport {
    return &http.Transport{
        DialContext: (&net.Dialer{
            Timeout:   2 * time.Second, // fail fast on unreachable backends
            KeepAlive: 30 * time.Second,
        }).DialContext,
        MaxIdleConns:        500,
        MaxIdleConnsPerHost: 50,
        IdleConnTimeout:     30 * time.Second, // release idle connections faster
        TLSHandshakeTimeout: 3 * time.Second,
        ResponseHeaderTimeout: 5 * time.Second,
        // DisableCompression: for APIs returning already-compressed data (JSON is often
        // served gzip by CDNs; the Transport handles decompression transparently).
        DisableCompression: false,
    }
}
```

---

### Junior → FAANG: Go HTTP Client Configuration as Production Correctness

The default `http.DefaultClient` and `http.DefaultTransport` are not suitable for production Go services. The default client has no timeout (a slow server will cause the goroutine to hang indefinitely), the default transport has a `MaxIdleConnsPerHost` of 2 (a production service making 100 concurrent requests to the same host will experience significant connection churn and establishment overhead), and there is no DNS caching.

The production HTTP client pattern: create one HTTP client per upstream service (or one per service tier), configure all timeouts explicitly (DialTimeout, TLSHandshakeTimeout, ResponseHeaderTimeout, RequestTimeout), set MaxIdleConnsPerHost to the expected peak concurrency for that upstream, and add OpenTelemetry tracing via a transport wrapper.

First-job habit: never use `http.DefaultClient` in production code. Always create a custom client with explicit configuration. Include a comment explaining the timeout values and connection pool sizing rationale.

### Senior @ FAANG: HTTP Client Architecture and the Shared Client Problem

At staff level, HTTP client configuration is a platform engineering problem. If every service creates its own HTTP client with independently chosen timeout values and connection pool settings, the configuration is inconsistent, hard to audit, and unable to be updated centrally when organizational standards change.

The solution is a shared HTTP client library that encodes the organization's standards: required timeouts (for each tier of service: external APIs, internal services, databases), connection pool sizes tuned for the expected concurrency, standard tracing and metrics instrumentation, and retry policy with the organization-standard backoff parameters. Service teams use this library instead of configuring `http.Transport` directly.

The retry policy design is the most nuanced part of the shared client library. Retrying on connection errors is safe for idempotent operations. Retrying on 503 responses is safe if the upstream has a short retry-after window. Retrying on 500 responses is dangerous (the request may have been partially processed). The library needs to provide explicit guidance on which status codes are retried by default and how to override the default for non-standard upstream behavior. The staff engineer who designs this retry policy, documents it clearly, and gets it adopted as the organizational standard is preventing entire categories of production incidents (retry storms, duplicate processing, cascading failures from aggressive retry).
