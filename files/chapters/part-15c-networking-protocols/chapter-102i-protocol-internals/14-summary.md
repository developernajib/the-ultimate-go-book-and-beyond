## Summary

The network stack from the kernel up to application protocols:

- **TCP internals**: Go's netpoll model parks goroutines on unready fds using epoll/kqueue, enabling millions of concurrent connections without proportional threads. Socket options (TCP_NODELAY, SO_REUSEPORT, buffer sizes) dramatically affect throughput and latency.

- **HTTP/2**: Binary framing with 9-byte frame headers enables multiplexing, flow control, HPACK header compression (60-90% savings on repeated requests), and server push. ConfigureServer/ConfigureTransport makes HTTP/2 production-ready in Go with one function call.

- **HTTP/3 over QUIC**: Eliminates TCP HOL blocking with independent reliable streams, built-in TLS 1.3, and 0-RTT resumption. `quic-go` provides both raw QUIC streams and an HTTP/3 server. The Alt-Svc header enables gradual migration.

- **TLS 1.3**: Reduced handshake from 2-RTT (TLS 1.2) to 1-RTT (full) and 0-RTT (resumed). X25519 key exchange + AES-GCM or ChaCha20 ciphers. Certificate hot-reload with atomic pointer swap eliminates restart downtime. mTLS with `RequireAndVerifyClientCert` secures service mesh communication.

- **Custom binary protocols**: 22-byte fixed headers vs. HTTP/2's variable overhead. Magic bytes + version enable protocol detection. Length prefixing prevents OOM. Compression flags enable transparent gzip. RPC multiplexing with per-request response channels enables pipelining over a single connection.

- **Connection multiplexing**: yamux/smux-style MuxConn enables multiple logical streams over one TCP connection - useful when TLS handshake cost is significant or when the number of connections is limited (e.g., traversing NAT).

The fundamental insight: network performance comes from reducing round trips (0-RTT, pipelining, multiplexing), reducing per-byte overhead (binary framing, HPACK, compression), and reducing blocking (QUIC, async I/O, connection reuse).

### Junior → FAANG: The Three-Sentence Summary to Carry Forward

Network performance improvement comes from three sources. First, reduce round trips: 0-RTT TLS, HTTP/2 multiplexing, connection reuse, and pipelining all reduce the number of network trips required to complete a request. Second, reduce per-byte overhead: binary framing (over JSON), HPACK compression (for headers), and Protobuf (over XML/JSON) reduce the bytes on the wire. Third, reduce blocking: QUIC eliminates TCP head-of-line blocking, async I/O avoids thread blocking on network waits, and connection reuse avoids repeated handshake overhead.

This three-part framework answers "how would you improve the performance of a Go HTTP service?" in a structured way that shows systems understanding, not just individual tricks.

### Senior @ FAANG: Protocol Layer as a Platform Decision Domain

At FAANG, the protocol stack is a platform decision, not a service decision. Individual teams choose application-layer protocols (REST vs. gRPC vs. Thrift) within constraints set by the platform. The platform decides: which TLS version is supported (enforce TLS 1.3 minimum), which HTTP versions are deployed at edge (HTTP/3 at CDN, HTTP/2 for internal), which connection management defaults are applied (platform HTTP client), and which observability is mandated (httptrace instrumentation in platform client, mesh-level metrics from sidecar proxy).

The staff-level concern: protocol layer changes (upgrading from TLS 1.2 to TLS 1.3 fleet-wide, deploying HTTP/3 at edge) require coordinated changes across CDN configuration, load balancer configuration, application client configuration, and monitoring configuration. These are platform migrations with multi-quarter timelines, not individual service changes. Planning and executing them requires the organizational authority that comes with platform team ownership, not individual service team ownership.

The maturity model for protocol platform ownership: level 1, teams make independent protocol decisions. Level 2, platform provides recommended defaults and documentation. Level 3, platform provides enforced defaults through SDK and policy. Level 4, platform owns the full protocol stack from TLS termination to application-layer protocol negotiation, with observability and SLOs for each layer.

---

### Navigation

- **Previous Chapter**: [Chapter 102H - WebSocket, SSE, and Real-Time Communication](../chapter-102h-websocket-sse-realtime/00-introduction.md)
- **Next Chapter**: [Chapter 102J - Network Debugging and Performance Optimization](../chapter-102j-network-debugging-performance/00-introduction.md)

