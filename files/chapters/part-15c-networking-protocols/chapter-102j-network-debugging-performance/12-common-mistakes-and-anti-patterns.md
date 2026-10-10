## 102J.10 Common Mistakes and Anti-Patterns

| Mistake | Problem | Fix |
|---------|---------|-----|
| `http.Get()` without timeout | Goroutine leaks on slow servers | Use `http.Client{Timeout: 30*time.Second}` |
| Creating new `http.Client` per request | No connection reuse, port exhaustion | Share a single `http.Client` per service |
| Not draining response body | CLOSE_WAIT buildup, pool starvation | `io.Copy(io.Discard, resp.Body); resp.Body.Close()` |
| Ignoring `context.Canceled` in retries | Retries after client gave up | Check `errors.Is(err, context.Canceled)` before retry |
| Retry without jitter | Thundering herd on recovery | Add ±50% jitter to all backoff intervals |
| HTTP/1.1 for internal services | HOL blocking, poor multiplexing | Enable h2c or gRPC for service-to-service |
| Large connection pool with tiny timeout | Wasteful idle connections | Match `MaxIdleConnsPerHost` to actual concurrency |
| DNS lookup per request | Cache stampede, high latency | Cache DNS with TTL, use SingleFlight |
| Ignoring `Alt-Svc` in responses | Misses HTTP/3 upgrade path | Auto-upgrade HTTP client when Alt-Svc header present |
| No retry budget | Cascade amplification | Use token bucket to cap retries per second |
| Missing `ForceAttemptHTTP2: true` | Falls back to HTTP/1.1 unnecessarily | Set in Transport when no custom TLS config |

### Junior → FAANG: Mistakes as Code Review Tripwires

Each row in this table is a code review tripwire: a pattern to look for when reviewing Go HTTP code. The three with the highest priority: using `http.DefaultClient` (means shared global state, uncontrolled connection pool), not closing response bodies (causes connection leak), and using fixed timeouts without considering the 99th percentile of server response time (causes spurious timeouts for slow but legitimate requests).

Practice writing code review comments for each of these. The comment for "using `http.DefaultClient`" is: "This uses the global default HTTP client with default transport settings. For production use, create a custom client with tuned `MaxIdleConnsPerHost` and explicit timeouts. The default client has `MaxIdleConnsPerHost: 2`, which is insufficient for services with more than 2 concurrent requests to the same host."

### Senior @ FAANG: Systematic Elimination of Anti-Patterns Through Platform Design

The `ForceAttemptHTTP2: true` row reveals a subtle API design issue in Go's standard library: creating an `http.Transport` with a custom `TLSClientConfig` disables HTTP/2 unless you explicitly opt back in. This is a footgun that trips experienced engineers, not just beginners.

The platform response: the platform HTTP client library wraps `http.Transport` creation and sets `ForceAttemptHTTP2: true` whenever a custom `TLSClientConfig` is provided. Service teams using the platform library cannot accidentally fall back to HTTP/1.1. The platform library's test suite includes a test that verifies HTTP/2 negotiation for all client configurations.

This pattern generalizes: every footgun in the common mistakes table is an opportunity to improve the platform library's API so that the safe behavior is the default and the unsafe behavior requires explicit acknowledgment. The cumulative effect of closing these footguns at the platform level is a fleet of services that avoids an entire class of production incidents without requiring every engineer to individually learn each footgun.

---
