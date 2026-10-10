## 102I.10 Protocol Internals Interview Questions and Answers

**Q: What is Head-of-Line (HOL) blocking in HTTP/1.1 and HTTP/2, and how does HTTP/3 solve it?**

A: In HTTP/1.1, requests on a connection are pipelined sequentially - if request 1 is slow, requests 2-N wait. HTTP/2 solves this at the HTTP layer with multiplexed streams, but all streams share a single TCP connection: if a packet is lost, TCP retransmission blocks ALL streams until the lost packet arrives (TCP-level HOL blocking). HTTP/3 runs over QUIC (UDP), which implements independent reliable streams - a lost packet only stalls the one stream that contained it, never others.

**Q: Explain TLS 1.3 0-RTT and its security trade-offs.**

A: In TLS 1.3, when resuming a session, the client can send application data (0-RTT data) in the first flight alongside ClientHello using a Pre-Shared Key (PSK) from the previous session. This eliminates one round-trip. The trade-off: 0-RTT data lacks forward secrecy for that first flight (if the PSK is compromised, the 0-RTT data can be decrypted), and it's vulnerable to replay attacks - a malicious network node can re-send the 0-RTT data to replay the request. Servers should only allow idempotent operations (GET) as 0-RTT, never state-changing operations (POST with payment).

**Q: How does Go's netpoll work internally?**

A: Go's network poller (in `runtime/netpoll*.go`) registers all network file descriptors with the OS-level I/O notification mechanism: `epoll` on Linux, `kqueue` on macOS/BSD, `IOCP` on Windows. When a goroutine calls `conn.Read()` and no data is available, the runtime parks the goroutine (not the OS thread) using `gopark()` and marks the fd as waiting in the pollable set. The scheduler's sysmon goroutine, or any goroutine that finishes system work, calls `netpoll()` to retrieve ready fds and unparks the waiting goroutines. This is how Go achieves M:N threading - thousands of goroutines blocked on I/O without consuming OS threads.

**Q: What are the implications of HTTP/2 MaxConcurrentStreams?**

A: This SETTINGS parameter tells clients how many concurrent streams (in-flight requests) are allowed per connection. If a client opens more streams than allowed, the server sends RST_STREAM with REFUSED_STREAM. In practice: too low (< 50) creates contention for high-traffic services. Too high creates resource exhaustion risk. The optimal value depends on request duration, server CPU, and memory per request. Go's `net/http` server defaults to 250, which is a reasonable starting point.

**Q: When would you use a custom binary protocol over HTTP/2?**

A: Use a custom protocol when: (1) you control both client and server and need sub-millisecond protocol overhead. (2) you need custom framing semantics (e.g., streaming audio with custom ordering). (3) you need to support a hardware device with limited stack. (4) you're building a database wire protocol with batching semantics different from request/response. HTTP/2 or gRPC covers 95% of service-to-service communication - the engineering cost of a custom protocol is high.

### Junior → FAANG: The HOL Blocking Explanation That Works in Interviews

Head-of-line blocking is one of the most common network interview topics, and many candidates confuse the HTTP/1.1, HTTP/2, and TCP layers. Here is the clean version to practice:

HTTP/1.1 HOL blocking: one request must complete before the next can start on the same connection. Fix: use multiple connections (browsers open 6-8 per origin). HTTP/2 HOL blocking: multiple requests share one TCP connection as streams. HTTP-level blocking is solved. But a single lost TCP packet pauses all streams while TCP retransmits it. This is TCP-level HOL blocking. HTTP/3 fix: QUIC handles loss recovery per stream at the transport layer. A lost packet only pauses the stream it belongs to. Other streams continue.

Practice explaining each layer separately. Interviewers who ask about HOL blocking often use follow-up questions to probe which layer you are describing. Keeping the layers distinct is what separates a clear answer from a confused one.

### Senior @ FAANG: Protocol Choice in the Context of Traffic Shaping and QoS

At FAANG scale, protocol choice intersects with traffic engineering. TCP congestion control algorithms (CUBIC, BBR) and QUIC's congestion control (also BBR-based) interact with network traffic shaping policies in ways that affect large-scale deployments. BBR (Bottleneck Bandwidth and Round-trip propagation time) achieves higher throughput on high-bandwidth-delay-product paths (inter-datacenter links) compared to CUBIC but can cause fairness issues when mixed with CUBIC flows on a shared link.

The decision to deploy HTTP/3 with QUIC+BBR in a fleet affects every other TCP flow on the same network links. Traffic engineering teams at large cloud providers and CDNs run simulations of congestion control algorithm interactions before large-scale protocol deployments. This is a coordination problem that is invisible to individual service teams but critical for the network infrastructure team.

For the custom protocol question: the L6 answer includes the maintenance lifecycle. A custom protocol adds an internal dependency with no external maintainer, no community documentation, and no ecosystem tooling. The engineering team that built it must maintain it, debug client compatibility issues, and evolve it as requirements change. The total cost of ownership over five years must be compared against the ongoing cost of gRPC overhead to justify the investment.

---
