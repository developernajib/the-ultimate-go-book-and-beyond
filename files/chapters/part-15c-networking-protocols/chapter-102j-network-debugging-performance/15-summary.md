## Summary

This chapter built a systematic framework for diagnosing and optimizing Go network code:

- **DNS debugging**: Custom resolvers, latency measurement, negative caching, SingleFlight for stampede prevention. High DNS latency (>50ms) usually indicates missing application-level caching.

- **TCP state analysis**: `/proc/net/tcp` parsing reveals TIME_WAIT storms (fix: keep-alive, port range, `tcp_tw_reuse`) and CLOSE_WAIT buildup (fix: drain and close response bodies).

- **Request tracing**: `httptrace.ClientTrace` breaks every HTTP request into DNS, TCP, TLS, server, and response phases with microsecond precision. The waterfall visualization immediately shows which phase dominates.

- **Connection leak detection**: `TrackedTransport` wraps `RoundTripper` to detect undrained bodies. `ConnLeakDetector` tracks goroutine count drift. FD monitoring catches file descriptor exhaustion before it becomes fatal.

- **Timeout configuration**: Five distinct timeout knobs - DialTimeout, TLSHandshakeTimeout, ResponseHeaderTimeout, IdleConnTimeout, client.Timeout - each prevent a different class of goroutine leak. All five should be set in production.

- **Retry storms**: Exponential backoff + jitter reduces retry amplification from N×maxAttempts to near N. Token bucket retry budgets prevent cascading failures when a downstream is recovering.

- **Packet capture**: `gopacket` enables flow-level analysis including retransmit detection, SYN scanning identification, and bandwidth attribution without kernel module changes.

- **GODEBUG flags**: `http2debug=2` provides frame-level visibility into HTTP/2 multiplexing. `netdns=go+1` shows DNS resolution decisions. These are invaluable for production incidents.

The overarching pattern: network problems are observable (metrics + tracing), isolatable (by protocol layer), and fixable (timeout + pooling + retry configuration). Most production network bugs fall into six categories - the playbook in Section 9 provides the decision tree.

### Junior → FAANG: The Decision Tree as a Mental Model

The "observable, isolatable, fixable" framing is the mental model to carry forward. When a network problem appears, the first question is always "what is the observable signal?" (metric, error message, latency distribution). The second is "which layer is responsible?" (application, HTTP client, TCP, network path). The third is "what is the specific misconfiguration or bug?" (timeout too low, pool too small, missing backoff). The fourth is "what is the fix, and how do I verify it?"

Practice this four-step framework on every network problem you encounter, even small ones. The habit of applying it systematically, rather than going directly to a fix based on intuition, builds the debugging muscle that distinguishes engineers who solve problems quickly from those who take random guesses until something works.

### Senior @ FAANG: Network Reliability as an Engineering Discipline

At FAANG, network debugging is not an ad-hoc skill. It is an engineering discipline with documented practices, shared tooling, and organizational ownership. The discipline includes: a runbook library for common incident types, a performance testing infrastructure for regression detection, a platform diagnostic CLI for field investigation, automated monitoring for connection pool health, and a capacity planning process that anticipates connection count growth.

The maturity model for network reliability engineering: level 1, reactive (teams debug incidents when they occur). Level 2, proactive (teams have dashboards and alerts that surface problems before users report them). Level 3, predictive (teams run capacity models and load tests that predict failure modes before they occur in production). Level 4, systematic (platform team eliminates classes of problems through API design, enforced configuration defaults, and automated runbooks). Most FAANG engineering organizations are at level 2-3. Level 4 is where staff and principal engineers focus their platform investments.

---

### Navigation

- **Previous Chapter**: [Chapter 102I - Protocol Internals: HTTP/2, HTTP/3, and TLS 1.3](../chapter-102i-protocol-internals/00-introduction.md)
- **Next Chapter**: [Chapter 102P - Real-Time Systems & WebRTC with Go](../chapter-102p-realtime-webrtc/00-introduction.md)
