## 102J.11 Interview Questions and Answers

**Q: How would you debug a production service with unexpectedly high tail latency (p99 >> p50)?**

A: Systematically: (1) Check if p99 correlates with GC pauses using `GODEBUG=gctrace=1` or runtime/metrics. (2) Use `httptrace.ClientTrace` to break down latency into DNS, TCP, TLS, server process, and response read phases. (3) If server-side, profile with `pprof`: CPU profile for CPU-bound, block/mutex profile for contention. (4) Check connection pool saturation: if requests queue for a connection, MaxIdleConnsPerHost needs increasing. (5) Look for retry amplification: one slow response triggering retry cascades. (6) Enable `GODEBUG=http2debug=1` if HTTP/2 - check for flow control stalls.

**Q: A Go service under load starts getting "dial tcp: connection refused" errors. What's happening and how do you fix it?**

A: Likely causes: (a) Ephemeral port exhaustion - check `ss -s` for TIME_WAIT count and `/proc/sys/net/ipv4/ip_local_port_range`. Fix: enable keep-alive, increase port range, set `tcp_tw_reuse=1`. (b) File descriptor limit - check `ulimit -n` and FDCount(). Fix: `ulimit -n 1048576` in systemd unit. (c) OS listen backlog full - check `net.core.somaxconn`. Fix: increase to 65535. (d) Too many short-lived clients creating connections without pooling. Fix: share a single `http.Client`.

**Q: Explain the difference between `IdleConnTimeout`, `ResponseHeaderTimeout`, and `client.Timeout` in Go's HTTP transport.**

A: `IdleConnTimeout` closes idle (pooled, unused) connections after this duration - prevents stale connections and saves file descriptors. `ResponseHeaderTimeout` starts counting after the request is sent - if the server doesn't return the response headers within this time, the request fails. Prevents slow server attacks. `client.Timeout` is the end-to-end deadline for the entire operation from dial through body read complete. It's the safety net for everything. Missing any of these can cause goroutine leaks: missing TLSHandshakeTimeout allows TLS stalls. Missing ResponseHeaderTimeout allows slow-loris. Missing client.Timeout allows infinite hangs.

**Q: How does SingleFlight prevent DNS cache stampedes?**

A: When multiple goroutines simultaneously request the same key (e.g., DNS lookup for "api.example.com" when the cache expires), SingleFlight lets only one goroutine execute the actual lookup while all others wait for that result. Without it, N goroutines each make a separate DNS query, overwhelming the resolver. With SingleFlight, N goroutines share one query result. The implementation uses a map of in-flight calls protected by a mutex. Each call has a channel that all waiters block on. When the first caller returns, it closes the channel waking all waiters.

**Q: What causes CLOSE_WAIT accumulation and how do you detect and fix it?**

A: CLOSE_WAIT means the remote peer sent FIN (they closed their end) but our process hasn't called Close() on the socket. In Go HTTP clients, this typically means response bodies aren't being fully read before `Close()` is called - or never closed at all. Detection: `ss -tan state close-wait | wc -l` or check `/proc/net/tcp` for state 8. Fix: always use `defer resp.Body.Close()` AND `io.Copy(io.Discard, resp.Body)` before closing - the underlying connection is only returned to the pool after the body is fully consumed. A `TrackedBody` wrapper can detect undrained bodies in testing.

### Junior → FAANG: Structuring Debugging Answers for Interview Delivery

The debugging questions in this section have a common structure: describe the diagnostic signal, identify the root cause, and explain the fix. Practice delivering answers in this three-part structure rather than as a stream of consciousness. The structure makes your thinking legible to the interviewer and shows that you have a systematic approach.

For the tail latency question: the diagnostic signal is p99 much larger than p50 (indicating a slow tail, not a uniformly slow service). Diagnostic steps: check GC pause times, check timeout distribution, check mutex contention with `pprof`. Root cause examples: a mutex protecting a shared resource that is occasionally held for long periods, GC pauses from a large heap, or a single slow downstream request that happens to correlate with p99 requests. Fix: reduce lock scope, tune GC, add circuit breaking with a p99-aware timeout.

### Senior @ FAANG: Tail Latency as a Platform-Level Concern

At FAANG scale, tail latency is a product metric, not just an engineering metric. A checkout service with 2ms p50 and 500ms p99 delivers a poor experience to 1 in 100 users. At 1 million requests per day, that is 10,000 users per day experiencing 500ms checkout delays. The business impact is measurable in conversion rate.

Tail latency optimization at L6 requires understanding the sources of tail: request queuing (requests that wait behind a slow one), resource contention (GC pauses, lock contention), network variability (TCP retransmissions, router queue spikes), and downstream tail amplification (if your service fans out to 10 downstream services and each has 1% p99 delay, your service has a 10% probability of experiencing at least one downstream delay). Each source has different mitigation strategies.

The platform investment for tail latency: distributed tracing with span-level latency breakdowns, so engineers can identify which service or operation is contributing to tail latency without manual correlation across log files. The platform also provides hedged requests (send a second request to a different instance if the first does not respond within the p90 timeout) as a configurable option for latency-sensitive services where duplicate requests are acceptable. Hedged requests reduce tail latency at the cost of additional load on the backend.

---
