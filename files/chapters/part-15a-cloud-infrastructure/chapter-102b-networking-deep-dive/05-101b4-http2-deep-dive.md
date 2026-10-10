## 102B.4 HTTP/2 Deep Dive

### What HTTP/2 Solves: Multiplexing

HTTP/2's core innovation is **multiplexing**: multiple logical request/response pairs (streams) share a single TCP connection, and they can be interleaved. A slow response does not block a fast response.

```
HTTP/1.1 (6 connections, sequential per connection):
Conn1: [Request1 ────────────────────][Request4 ───]
Conn2: [Request2 ──────][Request5 ──────────────────]
Conn3: [Request3 ─────────────────][Request6 ──────]

HTTP/2 (1 connection, multiplexed streams):
Conn:  [Stream1 ─][Stream4 ──][Stream2 ────][Stream5 ─][Stream3 ──][Stream6 ─]
       All on ONE TCP connection, interleaved
```

### Frames: The Building Blocks of HTTP/2

HTTP/2 is a binary framing layer. Every message is divided into frames:

```
┌──────────────────────────────────────────────────────────────┐
│                    HTTP/2 Frame Format                       │
├─────────────────┬──────────────────┬─────────────────────────┤
│  Length (24 bits)│ Type (8 bits)   │ Flags (8 bits)          │
├─────────────────┴──────────────────┴─────────────────────────┤
│               Stream ID (31 bits)                            │
├──────────────────────────────────────────────────────────────┤
│                  Frame Payload (variable)                    │
└──────────────────────────────────────────────────────────────┘
```

Frame types:

| Type | Purpose |
|------|---------|
| `DATA` | Request/response body bytes |
| `HEADERS` | Request/response headers (HPACK compressed) |
| `SETTINGS` | Connection parameters (window sizes, max streams) |
| `PING` | Keepalive and RTT measurement |
| `GOAWAY` | Graceful connection shutdown with last stream ID |
| `RST_STREAM` | Abruptly terminate a single stream |
| `WINDOW_UPDATE` | Flow control: increase connection or stream window |
| `PUSH_PROMISE` | Server push: server proactively sends resources |
| `PRIORITY` | Stream priority hints (deprecated in HTTP/3) |

### Streams and Stream IDs

Each HTTP/2 stream has a 31-bit identifier. Client-initiated streams use odd IDs (1, 3, 5, ...). Server-initiated streams (push) use even IDs. Stream ID 0 is reserved for connection-level control frames.

When a stream ID space is exhausted (~1 billion streams), the connection must be replaced with `GOAWAY` and a new connection established. For long-lived gRPC connections, this is an operational consideration.

### Flow Control per Stream and per Connection

HTTP/2 has two levels of flow control:

1. **Stream-level**: each stream has its own receive window
2. **Connection-level**: the entire connection has a receive window

The receiver sends `WINDOW_UPDATE` frames to increase windows. The default initial window is 65,535 bytes. For high-throughput streaming APIs, this is insufficient and must be increased:

```go
package httputil

import (
	"net/http"

	"golang.org/x/net/http2"
)

// ConfigureHTTP2Server sets larger flow control windows for high-throughput streaming.
func ConfigureHTTP2Server(s *http.Server) error {
    return http2.ConfigureServer(s, &http2.Server{
        // MaxConcurrentStreams: maximum concurrent streams per connection.
        // Default: 250. Increase for services with many concurrent lightweight requests.
        MaxConcurrentStreams: 1000,

        // MaxUploadBufferPerStream: initial flow control window per stream.
        // Default: 65535 (64KB). For streaming large bodies, increase to 1MB+.
        MaxUploadBufferPerStream: 1 << 20, // 1MB

        // MaxReadFrameSize: maximum size of a DATA frame.
        // Default: 16384 (16KB). Larger frames reduce overhead for big transfers.
        MaxReadFrameSize: 1 << 20, // 1MB
    })
}
```

### Header Compression (HPACK)

HTTP/1.1 headers are repeated in full with every request. On a page with 100 requests, headers like `Authorization`, `Accept`, `User-Agent` are sent 100 times each.

HPACK compresses headers using two techniques:
1. **Static table**: 61 pre-defined header name/value pairs (e.g., `:method: GET` is index 2)
2. **Dynamic table**: headers seen in previous frames on the connection are indexed and referenced by index

This reduces header overhead by 80-90% for typical web traffic.

### HTTP/2 in Go: Automatic with TLS

Go's `net/http` package automatically uses HTTP/2 when:
1. The server is configured with TLS (`ListenAndServeTLS`)
2. The client connects with TLS

```go
// HTTP/2 is automatic. Just use TLS.
package main

import (
    "log"
    "net/http"
    "golang.org/x/net/http2"
    "golang.org/x/net/http2/h2c"
)

// TLS server - HTTP/2 via ALPN negotiation (production).
func tlsServer() {
    mux := http.NewServeMux()
    mux.HandleFunc("/", handler)

    srv := &http.Server{
        Addr:    ":443",
        Handler: mux,
    }
    // HTTP/2 is automatically configured when using TLS.
    log.Fatal(srv.ListenAndServeTLS("cert.pem", "key.pem"))
}

// h2c server - HTTP/2 without TLS (for internal services, behind a TLS proxy).
// h2c is the "HTTP/2 cleartext" upgrade path.
func h2cServer() {
    h2s := &http2.Server{
        MaxConcurrentStreams: 250,
    }
    handler := h2c.NewHandler(http.DefaultServeMux, h2s)
    srv := &http.Server{
        Addr:    ":8080",
        Handler: handler,
    }
    log.Fatal(srv.ListenAndServe())
}

func handler(w http.ResponseWriter, r *http.Request) {
    // Check which protocol was negotiated.
    if r.ProtoMajor == 2 {
        w.Header().Set("X-Protocol", "HTTP/2")
    }
    w.Write([]byte("OK"))
}
```

### HTTP/2 Debugging

Diagnosing HTTP/2 issues requires tools that understand the binary framing layer. Unlike HTTP/1.1, you cannot simply `telnet` to a server and type requests, you need clients that speak the ALPN negotiation protocol and can decode frames. The commands below cover the most common scenarios: verifying protocol negotiation, inspecting frame-level traffic, and confirming that your Go server is actually serving HTTP/2 rather than silently falling back to HTTP/1.1.

```bash
# Test HTTP/2 with curl (requires TLS by default):
curl --http2 -v https://api.example.com/health

# Test h2c (cleartext HTTP/2):
curl --http2-prior-knowledge http://localhost:8080/health

# Check ALPN negotiation:
openssl s_client -connect api.example.com:443 -alpn h2 2>/dev/null | head -20

# nghttp2 provides detailed HTTP/2 frame inspection:
nghttp -v https://api.example.com/

# Go pprof over HTTP/2:
go tool pprof http://localhost:6060/debug/pprof/heap
```

### HTTP/2 Remaining Limitation: TCP Head-of-Line Blocking

HTTP/2 solves HTTP-level head-of-line blocking (multiple streams share one connection without ordering constraints at the HTTP layer). However, it still has **TCP-level head-of-line blocking**: if a single TCP packet is lost, all HTTP/2 streams on that connection stall until the packet is retransmitted and delivered in order. This is TCP's ordering guarantee working against HTTP/2's multiplexing.

On a connection with 100 streams, a 1% packet loss rate means on average one lost packet per 100 packets, stalling all 100 streams. HTTP/3 (QUIC) solves this.

---

### Junior → FAANG: HTTP/2 in Go and When to Enable It

Go's standard library supports HTTP/2 for TLS connections automatically: if you use `http.ListenAndServeTLS`, the server negotiates HTTP/2 by default via ALPN. If you are serving plain HTTP (no TLS), you need to explicitly enable HTTP/2 with `h2c`. For clients, Go's `http.Transport` upgrades to HTTP/2 automatically when connecting to an HTTP/2 server over TLS.

The practical implication: for services that communicate over TLS (which should be all services in production), you get HTTP/2 multiplexing automatically. The performance benefit is significant for services that make many concurrent requests to the same host: instead of opening many parallel TCP connections (each with its own handshake and congestion window), all requests share one connection's multiplexed streams.

The head-of-line blocking limitation at the TCP layer is a concrete problem for high-packet-loss networks. For services deployed in a cloud data center where packet loss is near 0%, this is not a meaningful constraint. For services serving mobile clients or users on high-loss connections, HTTP/3 provides a meaningful improvement.

### Senior @ FAANG: HTTP/2 Server Push, Priority, and Flow Control

At staff level, HTTP/2's advanced features (server push, stream priority, flow control) are rarely used correctly and often misused. Server push allows the server to proactively send resources the client will need, but the client can reject pushed resources, and most CDNs do not support pass-through of server push. The correct use of server push is very limited in practice.

Stream priority is the HTTP/2 mechanism for controlling which streams get bandwidth when the connection is congested. Implementing priority-based scheduling in a Go HTTP/2 server requires understanding the dependency tree and weight system, which is complex and rarely worth the investment unless you are building a browser-grade HTTP/2 implementation.

The HTTP/2 flow control mechanism (per-stream and per-connection windows) can be a source of latency if the window is too small for the requested data. The `golang.org/x/net/http2` package provides configuration knobs for initial window size, which may need tuning for high-throughput gRPC or HTTP/2 streaming services. Understanding the default window size (65535 bytes) and when it becomes a bottleneck (when sending responses larger than the window size without window updates) is the kind of low-level HTTP/2 knowledge that distinguishes staff-level networking expertise.
