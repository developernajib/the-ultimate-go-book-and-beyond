## 102I.9 Common Pitfalls and Mitigation Strategies

| Mistake | Problem | Fix |
|---------|---------|-----|
| Using TLS 1.0/1.1 | Vulnerable to POODLE, BEAST attacks | Set `MinVersion: tls.VersionTLS13` |
| Not setting socket timeouts | Goroutine/fd leak on slow clients | Always set read/write deadlines |
| HTTP/2 with small window size | HOL stalls for large payloads | Increase `InitialWindowSize` to ≥1MiB |
| Nagle's algorithm for RPC | 40ms delayed send hurts latency | `TCP_NODELAY = true` for interactive traffic |
| Not validating frame sizes | OOM from malicious frames | Enforce `MaxPayloadSize` before allocation |
| Using `net.Dial` without context | No timeout, hangs forever | Always use `DialContext` |
| Ignoring HTTP/2 GOAWAY | Sending requests on a closing connection | Handle GOAWAY in client retry logic |
| Not enabling HTTP/2 on client | Falls back to HTTP/1.1 unnecessarily | Set `ForceAttemptHTTP2: true` in Transport |
| QUIC without connection migration | Mobile clients reconnect on network switch | Use QUIC connection IDs properly |
| TLS certificate not rotating | Long-lived certs increase breach blast radius | Implement cert manager with hot reload |
| Custom protocol without magic bytes | Can't detect protocol mismatch | Always add magic + version to frame header |
| No flow control in custom protocol | Fast sender overwhelms slow receiver | Implement credit-based flow control |

### Junior → FAANG: The Mistake That Appears Most in Code Reviews

The most common networking mistake in Go code reviews is using the default `http.DefaultTransport` or creating `http.Client` objects with default settings for services that make more than a few requests per second. The default `http.Transport` has `MaxIdleConnsPerHost: 2`, which means at 10 concurrent goroutines each making HTTP requests to the same host, 8 of them will create new TCP connections per request. At 100 concurrent goroutines, the service creates 98 new TCP connections per request cycle, each paying the full handshake cost.

The fix is always to create a custom `http.Transport` with `MaxIdleConnsPerHost` set to the expected concurrency level. This is a one-time configuration change that can improve throughput by 10x or more for services with high outbound request rates. Recognizing this pattern in a code review and knowing the fix is an immediately applicable skill.

### Senior @ FAANG: Anti-Patterns as Platform Design Signals

Each anti-pattern in the common mistakes table is a signal that the platform is missing a guardrail. "No custom transport configuration" appears in every Go service that does not use a platform-provided HTTP client. "Not closing response bodies" appears in every service that does not use a platform-provided response handling wrapper. "Ignoring connection pool exhaustion" appears in every service that does not use a platform-provided metrics integration.

The platform engineering response: provide a platform HTTP client library that applies correct default configuration, wraps response body handling to prevent leaks, and emits connection pool metrics automatically. Teams that use the platform library cannot easily make these mistakes because the library makes the correct behavior the default. Teams that bypass the platform library must explicitly opt out, which creates a visible signal for security and platform reviews.

This "pave the pit of success" pattern is one of the most effective contributions a platform team can make: it scales across every service in the fleet simultaneously, without requiring each team to independently learn and apply the best practices.

---
