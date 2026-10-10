# Chapter 102I: Protocol Internals - TCP/IP, HTTP/2, HTTP/3, and TLS 1.3

> *"Every millisecond of latency has a cost measured in dollars, user retention, and competitive advantage. To eliminate that latency you must first understand the protocol machinery your code sits on top of - right down to the TCP handshake and the TLS record layer."*

Most Go developers interact with the network through `net/http` and treat the underlying protocol stack as a black box. That abstraction serves well until performance requirements tighten, until you need to tune connection pool behavior for high-throughput RPC, or until a mysterious latency spike appears that no application-level metric can explain. At that point, understanding what actually happens between `Dial` and the first byte of a response body - the three-way TCP handshake, TLS record framing, HTTP/2 stream multiplexing, HPACK header compression - becomes the difference between guessing and diagnosing with precision.

HTTP/2 changed the economics of browser-to-server communication by multiplexing many logical streams over a single TCP connection, eliminating head-of-line blocking at the HTTP layer and compressing headers with a shared HPACK table. But TCP itself still serializes retransmissions across all streams - a single lost packet stalls every stream until it is recovered. HTTP/3 solves this by replacing TCP with QUIC, a UDP-based transport that bakes in encryption, stream multiplexing, and independent per-stream loss recovery at the transport layer. QUIC also enables 0-RTT connection resumption, cutting round trips for repeat visitors. Go's ecosystem has first-class support for both: the standard library ships with HTTP/2, and `quic-go` provides production-grade HTTP/3. TLS 1.3 underlies both - its redesigned handshake reduces setup to a single round trip, drops obsolete cipher suites, and makes forward secrecy mandatory.

Go's `net` package sits unusually close to the OS kernel. `net.Dial` resolves hostnames, picks a socket type, issues `connect(2)`, and returns a `net.Conn` that maps almost directly to a file descriptor. The `syscall` and `golang.org/x/net` packages let you reach below `net/http` to set `TCP_NODELAY`, configure `SO_REUSEPORT` for multi-core listener distribution, enable `TCP_FASTOPEN` for zero-RTT TCP, or read `getsockopt` statistics. This chapter walks through each layer of the stack with working Go code, showing how protocol decisions made at the RFC level translate into observable behavior in production services.

**What you'll learn in this chapter:**

- How Go's `net` package maps to OS kernel syscalls and what happens inside `Dial`, `Listen`, and `Accept`
- TCP socket options that matter in production: `TCP_NODELAY`, `SO_KEEPALIVE`, `SO_REUSEPORT`, `TCP_FASTOPEN`
- HTTP/2 internals: stream multiplexing, flow control windows, HPACK header compression, and server push mechanics
- HTTP/3 and QUIC: why QUIC replaces TCP, 0-RTT session resumption, and using `quic-go` in Go services
- TLS 1.3 handshake mechanics, certificate chain validation, OCSP stapling, and 0-RTT trade-offs
- Designing custom binary application-layer protocols with efficient framing, length-prefix encoding, and versioning
- Reading and interpreting raw protocol behavior with `strace`, `ss`, and Go's `net/http/httptrace` package
- Profiling and optimizing network code at the syscall level to eliminate hidden latency

**Why this matters at scale:**

Google's gRPC protocol is built directly on HTTP/2 semantics - understanding multiplexing and flow control is essential for tuning gRPC connection pools in microservice meshes. Cloudflare was among the first to deploy HTTP/3 at global scale, reporting significant tail-latency improvements on high-loss mobile networks. Fastly and Akamai use custom binary framing protocols for their edge-to-origin traffic because HTTP overhead becomes measurable at their request volumes. Netflix's open-source Zuul gateway exposes direct socket-level knobs that are only meaningful if you understand the TCP layer underneath.

**Prerequisites:** Solid understanding of Go's `net/http` package, basic familiarity with TCP/IP networking concepts (sockets, ports, three-way handshake), and comfort reading Go code that uses interfaces. No kernel programming experience is required.

### Junior → FAANG: Why Protocol Internals Are an Interview Differentiator

Most backend engineers know that TCP has a three-way handshake and that HTTPS uses TLS. Very few can explain what happens between `http.Client.Do()` and the first byte of a response at the TCP and TLS layer. That gap is exactly what FAANG protocol and infrastructure interviews probe. Understanding what DNS resolution, TCP connection establishment, TLS handshake, HTTP/2 stream creation, and HPACK header compression each contribute to total request latency is the foundation for any serious latency optimization conversation.

The entry-level goal from this chapter: be able to narrate the full lifecycle of a single HTTPS/2 request from `Dial` to the last byte received, naming each phase, the protocol machinery involved, and the dominant latency contributor. Practice this narration until it takes under 90 seconds. That narration answers "how would you diagnose a latency spike in an HTTP client?" and "what does `net/http/httptrace` measure?"

### Senior @ FAANG: Protocol Knowledge as the Foundation for Infrastructure Decision-Making

At L6, protocol internals knowledge is not just for debugging. It is for making correct infrastructure decisions. Choosing between HTTP/2 and HTTP/3 for an edge service requires understanding that HTTP/3's QUIC transport eliminates head-of-line blocking at the transport layer, and that this improvement is most significant for clients on high-loss mobile networks. Choosing between gRPC and a custom binary protocol requires understanding the overhead of HTTP/2 framing and HPACK compression compared to a length-prefixed binary frame. Choosing TLS session resumption strategies requires understanding the security tradeoffs of 0-RTT data replay attacks.

Protocol decisions made without internals knowledge tend to be cargo-culted from reference architectures without understanding why those architectures made those choices. Staff-level engineers at FAANG are expected to be able to justify protocol decisions from first principles when architectural assumptions change.

---
