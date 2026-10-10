## Part 15: Performance Optimization and Best Practices

An API gateway sits in the critical path of every request, so even small inefficiencies get multiplied thousands of times per second. In this section, we focus on two key optimizations. First, connection pooling: instead of opening a new TCP connection to backend servers for every request, we reuse existing connections through Go's `http.Transport`, which dramatically reduces latency and resource usage. Second, request buffering: when the gateway needs to retry a failed request on a different backend, it must be able to replay the original request body, so we buffer it in memory before the first attempt.

### Connection Pooling

The connection pool configures Go's `http.Transport` to reuse TCP connections across requests, limiting the maximum number of idle connections per host and setting keep-alive timeouts.

```go
// internal/upstream/pool.go
package upstream

import (
    "net"
    "net/http"
    "time"
)

// CreateOptimizedTransport creates an optimized HTTP transport
func CreateOptimizedTransport() *http.Transport {
    return &http.Transport{
        Proxy: http.ProxyFromEnvironment,
        DialContext: (&net.Dialer{
            Timeout:   30 * time.Second,
            KeepAlive: 30 * time.Second,
        }).DialContext,
        ForceAttemptHTTP2:     true,
        MaxIdleConns:          100,
        MaxIdleConnsPerHost:   10,
        IdleConnTimeout:       90 * time.Second,
        TLSHandshakeTimeout:   10 * time.Second,
        ExpectContinueTimeout: 1 * time.Second,
        ResponseHeaderTimeout: 30 * time.Second,
    }
}
```

### Request Buffering

Request buffering reads the full request body into memory before forwarding, enabling retries against a different backend without losing the original body.

```go
// internal/gateway/buffer.go
package gateway

import (
    "bytes"
    "io"
    "net/http"
)

// BufferedRequest buffers request body for retry logic
type BufferedRequest struct {
    *http.Request
    body []byte
}

// NewBufferedRequest creates a buffered request
func NewBufferedRequest(r *http.Request) (*BufferedRequest, error) {
    var body []byte
    if r.Body != nil {
        var err error
        body, err = io.ReadAll(r.Body)
        if err != nil {
            return nil, err
        }
        r.Body.Close()
    }

    return &BufferedRequest{
        Request: r,
        body:    body,
    }, nil
}

// Reset resets the request body for retry
func (br *BufferedRequest) Reset() {
    br.Body = io.NopCloser(bytes.NewReader(br.body))
}
```

---
