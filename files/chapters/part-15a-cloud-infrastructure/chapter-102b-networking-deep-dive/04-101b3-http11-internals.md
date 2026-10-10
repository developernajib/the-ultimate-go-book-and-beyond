## 102B.3 HTTP/1.1 Internals

### Request/Response Format

HTTP/1.1 is a text protocol. A request looks like:

```
GET /api/users?page=1 HTTP/1.1\r\n
Host: api.example.com\r\n
Accept: application/json\r\n
Authorization: Bearer eyJ...\r\n
\r\n
```

A response:

```
HTTP/1.1 200 OK\r\n
Content-Type: application/json\r\n
Content-Length: 342\r\n
Connection: keep-alive\r\n
\r\n
{"users": [...]}
```

The double CRLF (`\r\n\r\n`) separates headers from body. Parsers must handle partial reads, chunked transfer encoding, and headers that arrive across multiple TCP segments.

### Persistent Connections vs Connection Per Request

**HTTP/1.0** created a new TCP connection for every request. On a page with 30 resources, this meant 30 TCP handshakes (30 × 1 RTT each) plus 30 TLS handshakes on HTTPS.

**HTTP/1.1** made persistent connections the default via `Connection: keep-alive`. After a response is delivered, the TCP connection remains open for the next request. This amortizes the handshake cost across many requests.

**HTTP pipelining** allowed sending multiple requests without waiting for responses - theoretically. In practice, intermediate proxies mishandled it, and the server must still respond in order, which leads to head-of-line blocking. It was never widely deployed and is effectively abandoned.

### Head-of-Line Blocking

With HTTP/1.1, requests on a single connection must be responded to in order. If a slow request is ahead in the pipeline, all subsequent requests wait - even if their responses are ready. This is **HTTP/1.1 head-of-line blocking**.

The common workaround: browsers open 6 parallel TCP connections per hostname. Websites used domain sharding (serving assets from multiple subdomains) to get more parallel connections. Both workarounds are hacks.

### Connection Pooling in Go's http.Transport

`http.Transport` maintains a pool of idle TCP/TLS connections per host. When a request is made, it either reuses an idle connection or creates a new one. After the response is read, the connection is returned to the pool.

**Critical requirement for connection reuse:** you MUST drain and close the response body, even if you do not need the data.

```go
package httputil

import (
	"io"
	"net/http"
)

// WRONG: connection cannot be reused - leaks a connection.
func badRequest(url string) error {
    resp, err := http.Get(url)
    if err != nil {
        return err
    }
    _ = resp // resp.Body is never read or closed.
    // The Transport cannot return the connection to the pool.
    return nil
}

// CORRECT: always drain and close response body.
func goodRequest(url string) ([]byte, error) {
    resp, err := http.Get(url)
    if err != nil {
        return nil, err
    }
    defer resp.Body.Close()

    // io.ReadAll drains the body - Transport can then return the connection to pool.
    body, err := io.ReadAll(resp.Body)
    if err != nil {
        return nil, err
    }
    return body, nil
}

// ALSO CORRECT: when you don't need the body, explicitly discard it.
func checkStatus(url string) (int, error) {
    resp, err := http.Get(url)
    if err != nil {
        return 0, err
    }
    defer resp.Body.Close()
    io.Copy(io.Discard, resp.Body) // drain before close
    return resp.StatusCode, nil
}
```

### Go http.Transport Configuration

```go
package httputil

import (
	"net"
	"net/http"
	"time"
)

// OptimalTransport returns a transport tuned for a high-throughput microservice.
func OptimalTransport() *http.Transport {
    return &http.Transport{
        // DialContext controls new connection establishment.
        DialContext: (&net.Dialer{
            Timeout:   5 * time.Second,  // max time to establish TCP connection
            KeepAlive: 30 * time.Second, // TCP keepalive interval
        }).DialContext,

        // Connection pool size.
        // MaxIdleConns: total across all hosts (default: 100)
        // MaxIdleConnsPerHost: per-host limit (default: 2 - dangerously low!)
        // Under high concurrency, default MaxIdleConnsPerHost=2 causes frequent
        // connection creation and TIME_WAIT exhaustion.
        MaxIdleConns:        1000,
        MaxIdleConnsPerHost: 100,

        // IdleConnTimeout: how long an idle connection stays in the pool.
        // Should be less than the server's idle timeout to avoid "use after server closed" errors.
        IdleConnTimeout: 90 * time.Second,

        // TLSHandshakeTimeout: max time for TLS handshake.
        TLSHandshakeTimeout: 10 * time.Second,

        // ResponseHeaderTimeout: max time waiting for response headers after sending request.
        // A separate timeout prevents slow servers from holding connections forever.
        ResponseHeaderTimeout: 10 * time.Second,

        // ExpectContinueTimeout: for "Expect: 100-continue" requests.
        ExpectContinueTimeout: 1 * time.Second,

        // ForceAttemptHTTP2: attempt HTTP/2 even on custom DialContext.
        ForceAttemptHTTP2: true,
    }
}
```

---

### Junior → FAANG: HTTP/1.1 Mechanics Every Go Developer Must Know

HTTP/1.1 is the protocol that most Go services speak, even when they think they are speaking HTTP/2 (clients that do not negotiate HTTP/2 fall back to HTTP/1.1 automatically). Understanding its mechanics prevents subtle bugs.

The most important HTTP/1.1 concept for Go developers: every `http.Response` body must be fully read and closed, even if you do not need the body. If you do not drain the body, the underlying TCP connection cannot be returned to the connection pool and is instead closed. This produces an extra TCP connection establishment for the next request and, at scale, exhausts connection pool capacity. The pattern `defer resp.Body.Close()` is not sufficient if you also need to ensure the body is drained: use `io.Copy(io.Discard, resp.Body)` before closing.

The keep-alive connection behavior means that a slow upstream response ties up a connection in the pool for the duration of the request. Setting appropriate `ResponseHeaderTimeout` and `DisableKeepAlives` for specific client configurations (a client talking to an API with highly variable response times) prevents connection pool exhaustion from slow responses.

### Senior @ FAANG: HTTP/1.1 at Scale and the Protocol Upgrade Path

At staff level, HTTP/1.1 is a legacy protocol that most new services should not be using for internal communication. The upgrade path is: HTTP/1.1 to HTTP/2 (multiplexing, header compression, server push) to HTTP/3/QUIC (eliminates TCP head-of-line blocking). The deployment complexity increases at each step, and the benefit is proportional to the traffic patterns.

For internal service-to-service communication, gRPC over HTTP/2 is the standard at FAANG companies: it provides binary framing (smaller payloads than JSON over HTTP/1.1), multiplexing (many concurrent RPCs over one connection), bidirectional streaming (push-based communication without polling), and code-generated clients and servers from protobuf definitions. The organizational investment required is protobuf tooling, code generation in CI, and HTTP/2 load balancer support. For most high-traffic internal APIs, this investment pays off quickly in reduced bandwidth and connection overhead.

The architectural decision for external-facing APIs is more nuanced: clients may not support HTTP/2, CDNs may not pass HTTP/2 through to the origin, and browser security requirements add additional constraints. The staff engineer's role is to evaluate these constraints for each API surface and choose the right protocol version, not to apply a single standard across all traffic types.
