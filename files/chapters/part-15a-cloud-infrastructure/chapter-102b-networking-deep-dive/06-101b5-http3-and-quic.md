## 102B.5 HTTP/3 and QUIC

### QUIC: UDP-Based Transport

QUIC replaces TCP as the transport layer for HTTP/3. It is built on UDP but reimplements (and improves on) TCP's reliability, ordering, and congestion control features at the application layer.

```
HTTP/3 Stack:          HTTP/2 Stack:
┌────────────┐         ┌────────────┐
│   HTTP/3   │         │   HTTP/2   │
├────────────┤         ├────────────┤
│    QUIC    │         │    TLS     │
├────────────┤         ├────────────┤
│    UDP     │         │    TCP     │
├────────────┤         ├────────────┤
│     IP     │         │     IP     │
└────────────┘         └────────────┘
```

### Why QUIC

**1. Eliminates TCP head-of-line blocking.** QUIC streams are independent at the transport layer. A lost packet only affects the stream whose data was in that packet, not all streams on the connection.

**2. Faster connection setup.** QUIC combines transport and TLS handshake in one round-trip (1-RTT), compared to TCP (1 RTT) + TLS (1-2 RTT) = 2-3 RTTs total. With 0-RTT resumption, repeat connections can send data with zero round-trips.

```
HTTP/2 (TCP + TLS 1.3):              HTTP/3 (QUIC):
Client          Server               Client          Server
  │──SYN──────────►│                   │──Initial──────►│
  │◄──SYN-ACK──────│  (1 RTT)          │◄──Handshake────│  (1 RTT, combined)
  │──ACK───────────►│                  │──Request───────►│
  │──ClientHello───►│                  │◄──Response──────│
  │◄──ServerHello───│  (1 RTT TLS 1.3) │
  │──Request───────►│
  │◄──Response──────│

0-RTT HTTP/3 (known server):
  │──Initial+Request►│  (0 RTT for request!)
  │◄──Response───────│
```

**3. Connection migration.** A QUIC connection is identified by a 64-bit Connection ID, not by the 4-tuple (src IP, src port, dst IP, dst port). When a mobile device switches from Wi-Fi to LTE, the IP address changes, but the QUIC connection continues using the same Connection ID - no reconnection, no re-authentication.

### QUIC Streams

QUIC has four stream types:
- **Bidirectional client-initiated** (IDs 0, 4, 8, ...)
- **Bidirectional server-initiated** (IDs 1, 5, 9, ...)
- **Unidirectional client-initiated** (IDs 2, 6, 10, ...)
- **Unidirectional server-initiated** (IDs 3, 7, 11, ...)

Each stream is independently ordered (bytes within a stream arrive in order) but streams are independent of each other (packet loss on stream 1 does not delay stream 2).

### HTTP/3 in Go with quic-go

The standard library does not include a QUIC implementation, QUIC's rapid evolution and the complexity of UDP socket management make it impractical to stabilize in the standard library at this stage. The `quic-go` library is the canonical Go implementation, used in production by Caddy, Cloudflare's Go services, and others. Because browsers only upgrade to HTTP/3 after receiving an `Alt-Svc` response header on an existing HTTP/1.1 or HTTP/2 connection, real deployments must run both TCP and UDP listeners in parallel, as shown below.

```go
// go get github.com/quic-go/quic-go

package main

import (
    "crypto/tls"
    "net/http"
    "log"

    "github.com/quic-go/quic-go/http3"
)

// HTTP3Server starts an HTTP/3 server.
// In production, you typically also run HTTP/1.1 and HTTP/2 in parallel
// and advertise HTTP/3 via Alt-Svc header.
func HTTP3Server(certFile, keyFile string) error {
    mux := http.NewServeMux()
    mux.HandleFunc("/api/", apiHandler)

    srv := http3.Server{
        Addr:    ":443",
        Handler: mux,
        TLSConfig: &tls.Config{
            MinVersion: tls.VersionTLS13, // QUIC requires TLS 1.3
        },
        // QUICConfig: &quic.Config{
        //     MaxIncomingStreams: 1000,
        //     MaxStreamReceiveWindow: 1 << 20,
        // },
    }

    // Start HTTP/1.1 + HTTP/2 on TCP in parallel, advertising HTTP/3 via Alt-Svc.
    go func() {
        httpSrv := &http.Server{
            Addr: ":443",
            Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
                // Alt-Svc tells the client that HTTP/3 is available on UDP port 443.
                w.Header().Set("Alt-Svc", `h3=":443"; ma=86400`)
                mux.ServeHTTP(w, r)
            }),
        }
        log.Fatal(httpSrv.ListenAndServeTLS(certFile, keyFile))
    }()

    return srv.ListenAndServeTLS(certFile, keyFile)
}

func apiHandler(w http.ResponseWriter, r *http.Request) {
    // Protocol negotiation is transparent to the handler.
    w.Write([]byte("OK"))
}

func main() {
    log.Fatal(HTTP3Server("cert.pem", "key.pem"))
}
```

### When HTTP/3 Matters

HTTP/3 provides the most benefit in:
- **Mobile clients** on cellular networks with frequent packet loss and IP address changes
- **Lossy networks** (satellite internet, congested Wi-Fi)
- **Global CDNs** where connections span multiple networks with different reliability
- **High-concurrency APIs** where individual stream prioritization matters

HTTP/3 provides less benefit for:
- Services in the same data center (near-zero packet loss, low RTT)
- Simple request/response patterns with few concurrent requests

---

### Junior → FAANG: HTTP/3 and QUIC as Emerging Infrastructure

HTTP/3 is not yet the standard for most internal services, but it is increasingly relevant for external-facing services with mobile or global user bases. Understanding the core problems QUIC solves (TCP head-of-line blocking, slow connection establishment) helps you evaluate whether HTTP/3 adoption is worthwhile for your specific service.

The Go ecosystem for HTTP/3 is maturing: `quic-go` is the most widely used library. CDNs (Cloudflare, Fastly, Google Cloud CDN) support HTTP/3 at the edge, meaning your origin service can still speak HTTP/2 or HTTP/1.1 while users benefit from HTTP/3 to the CDN. This is the most common deployment pattern and the one that requires the least application-level change.

For internal services in a cloud data center with sub-1% packet loss rates, HTTP/3 provides no meaningful benefit over HTTP/2. The complexity of deploying QUIC (UDP firewall rules, load balancer support) is not justified. For external APIs or services with mobile clients, HTTP/3 provides meaningful latency improvements that are worth the deployment complexity.

### Senior @ FAANG: QUIC Adoption Decision and Infrastructure Requirements

At staff level, adopting HTTP/3 for a service requires infrastructure assessment before writing code. The checklist: do the load balancers support UDP and QUIC? (L4 load balancers handle UDP without modification, L7 load balancers require explicit HTTP/3 support). Are the firewall rules permitting UDP on the service's port? (UDP is often blocked by default in enterprise and cloud security groups). Is there monitoring for QUIC connection establishment success rates and fallback frequency? (Devices that block UDP will fall back to TCP, and the fallback rate tells you the actual benefit of HTTP/3 adoption).

The QUIC encryption model requires explicit consideration: all QUIC connections are encrypted (TLS 1.3 is mandatory), which is the correct default for any external traffic. The TLS certificate management for QUIC is the same as for HTTP/2, but the ALPN protocol identifier is different (`h3` instead of `h2`). Ensuring that certificate management, rotation, and pinning procedures are updated to cover QUIC connections is an operational detail that is easily overlooked.

QUIC's 0-RTT connection resumption is a performance feature with a security consideration: 0-RTT data can be replayed by a network attacker. For GET requests and other idempotent operations, 0-RTT is safe. For POST or state-changing operations, 0-RTT must be disabled or the endpoint must be designed to handle replay safely. The staff engineer designing a QUIC-enabled service must explicitly evaluate 0-RTT replay risk for each endpoint type.
