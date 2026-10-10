## 102B.1 Why Senior Engineers Must Know Networking

Most developers learn networking the wrong way: they learn the API first and the protocol never. They know how to call `http.Get` but not why it sometimes silently hangs. They know their service is slow but cannot identify whether the bottleneck is DNS resolution, TCP connection setup, TLS handshake, or application logic. At FAANG companies and high-growth startups, that gap is what separates a mid-level engineer from a senior engineer.

### Debugging Production Issues Requires Network-Level Understanding

Consider the following real-world scenarios that require networking knowledge to debug:

**Scenario 1 - The mysterious 30-second delay.** A Go service intermittently takes 30 seconds to respond. The application logs show normal processing times. The culprit: DNS resolution for an upstream dependency is failing, and Go's default DNS resolver is timing out and falling back to TCP. Solution: configuring a custom `net.Resolver` with explicit timeout.

**Scenario 2 - Memory leak in production.** A service memory grows unbounded under load. The culprit: HTTP clients creating new TCP connections instead of reusing the pool because `Response.Body` is never fully drained before being closed. Go's `http.Transport` cannot return the connection to the pool without reading the full response body.

**Scenario 3 - Cascading failure.** All services in a cluster fail within seconds of each other. The culprit: a downstream service returned HTTP 503 responses, but the HTTP clients had no timeout configured. All goroutines blocked on reads, exhausting the goroutine pool.

**Scenario 4 - Inconsistent latency.** A service has p99 latency 10x the p50 latency. The culprit: TCP Nagle algorithm batching small writes. Solution: setting `TCP_NODELAY`.

### Performance Optimization Starts at the Network

Application-level optimizations are often wasted effort if the network layer is misconfigured. A Go service with perfect algorithmic complexity but poor connection pooling will be outperformed by a less optimized service with proper Transport configuration. At FAANG scale, a 1ms improvement in p99 latency can mean millions of dollars in infrastructure cost savings.

### Security Architecture Requires Protocol Knowledge

Building a zero-trust architecture requires understanding TLS handshakes, certificate chains, SNI, ALPN, and mTLS. A developer who treats TLS as a black box will misconfigure cipher suites, use deprecated TLS versions, skip certificate validation in tests and accidentally ship it to production, or implement mTLS incorrectly - leaving services open to man-in-the-middle attacks.

### FAANG Interviews Expect Networking Depth

Google, Meta, Amazon, Stripe, and Cloudflare routinely ask networking questions in system design and technical interviews:

- "What happens when you type a URL in the browser?"
- "How would you design a global load balancer?"
- "Why does HTTP/2 still have head-of-line blocking?"
- "What is the difference between TLS 1.2 and TLS 1.3?"
- "How would you implement service discovery in Kubernetes?"

These questions are not trivia. They reveal whether you understand the systems you build on top of.

---

### Junior → FAANG: Building Networking Knowledge Incrementally

The networking knowledge gap described in this section is real and addressable with a structured approach. The most effective learning path: start with a concrete problem (why does this Go service have high P99 latency?), trace the request from the application through TCP, TLS, DNS, and HTTP, and understand each layer's contribution to the total latency.

Each concrete debugging session teaches more than hours of abstract reading. Use `curl -v` to see the DNS resolution time, TLS handshake time, and first byte time for an HTTP request. Use `ss -t` to see the state of all TCP connections from your service. Use `go tool trace` with HTTP tracing to see the connection lifecycle from Go's perspective. These tools make the abstract concepts concrete and observable.

The career differentiator described here is real: an engineer who can say "the P99 latency spike is caused by DNS re-resolution after TTL expiry, which is adding 50ms for connections that hit an expired cache entry" is demonstrably more valuable than one who can only say "something is slow."

### Senior @ FAANG: Networking as the Foundation of System Design Credibility

At staff level, networking knowledge is a credibility requirement in system design discussions. When a design proposes using HTTP/2 for a high-throughput data pipeline, the reviewer who understands head-of-line blocking at the TCP layer (and why HTTP/3/QUIC addresses it) can make an informed judgment about whether HTTP/2 is the right choice. When a design proposes a global load balancer with a single DNS record, the reviewer who understands DNS TTL propagation times and GeoDNS consistency can identify the failure mode during region failover.

This level of networking knowledge takes years of practice to develop, and the most efficient path is deliberate practice: when investigating an incident, go one layer deeper than necessary. When the problem is identified, understand why it occurred at the protocol level. This habit of going deeper than required during investigations builds the networking intuition that makes senior-level system design credible.
