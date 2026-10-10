## Summary

The full networking stack from TCP internals to production Go configurations:

**TCP** provides the reliable, ordered byte stream that HTTP/gRPC build on. Understanding TCP's three-way handshake, flow control, congestion control, TIME_WAIT, Nagle algorithm, and keepalives enables you to debug latency issues and configure Go servers correctly.

**HTTP/1.1** introduced persistent connections but suffers from HTTP-level head-of-line blocking. Go's `http.Transport` connection pool requires careful configuration - especially `MaxIdleConnsPerHost` - and always requires response bodies to be drained.

**HTTP/2** solves HTTP-level HOL blocking with multiplexed streams over a single TCP connection, HPACK header compression, and binary framing. Go enables HTTP/2 automatically with TLS. HTTP/2 still suffers from TCP-level HOL blocking on lossy networks.

**HTTP/3 and QUIC** eliminate TCP HOL blocking by reimplementing transport over UDP with independent per-stream ordering. They provide faster connection setup (1-RTT, 0-RTT resumption) and connection migration. Use `quic-go` for Go HTTP/3 support.

**TLS** provides confidentiality, integrity, and server authentication. TLS 1.3 is the current standard with forward secrecy, 1-RTT handshake, and a cleaned cipher suite. mTLS adds client authentication for zero-trust service meshes. Configure `tls.Config` carefully, never disable certificate verification, and use `tls.RequireAndVerifyClientCert` for mTLS.

**DNS** is a hierarchical distributed database. Go's resolver does not cache - implement application-level caching or use a local caching resolver for performance. SRV records enable service discovery. Lower TTLs before DNS migrations.

**Load balancing** at L4 is fast but content-blind. L7 enables intelligent routing, retries, and circuit breaking. Consistent hashing with virtual nodes minimizes cache disruption during topology changes. Health checks and connection draining are essential for zero-downtime deployments.

**CDNs** use anycast routing to serve content from the nearest PoP. Correct `Cache-Control` headers (`s-maxage`, `stale-while-revalidate`, `immutable`) unlock CDN effectiveness.

---

### Junior → FAANG: Networking Summary as a Debugging Decision Tree

The content of this summary forms a debugging decision tree for networking issues. When you encounter a latency problem: start with DNS (is resolution taking too long?), then TCP (is connection establishment overhead the issue?), then TLS (is the handshake contributing significant latency?), then HTTP (is connection pooling insufficient, causing new connections for every request?), then application (is the actual request processing slow?). Each layer has specific tools and configuration levers to diagnose and address.

Knowing which layer to investigate first saves significant time during incidents. The most common mistake is jumping to application-level investigation when the problem is at the network layer, or vice versa. The summary's layer-by-layer organization is the mental model for systematic diagnosis.

### Senior @ FAANG: Networking Knowledge as Organizational Infrastructure Leverage

At L6/L7, the networking knowledge in this chapter is the foundation for organizational infrastructure decisions that affect every service. The choice of service mesh (and whether to adopt one), the CDN vendor selection and configuration standards, the internal service communication protocol standard (gRPC versus REST), and the TLS policy (mTLS everywhere versus network-level isolation) are all architectural decisions that benefit from deep networking expertise.

The staff engineer who brings this depth to organizational decisions prevents expensive mistakes: a service mesh adopted without understanding the TLS overhead, a CDN misconfigured to cache user-specific data, an internal API protocol that cannot be efficiently load-balanced, or a TLS configuration that allows insecure cipher suites. Each of these mistakes would require significant remediation work later. The staff engineer's networking expertise is the organizational risk mitigation that prevents them.
