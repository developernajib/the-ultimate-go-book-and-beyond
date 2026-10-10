## Exercises

**Exercise 1 - TCP Time Wait Analysis**

Write a Go program that creates 1,000 short-lived HTTP connections to a local server. Use `ss -tan` to observe TIME_WAIT accumulation. Then add proper connection pooling and observe the difference.

**Exercise 2 - TLS Certificate Generation and mTLS**

Using `crypto/tls` and `crypto/x509`:
1. Generate a root CA certificate and key
2. Generate a server certificate signed by the root CA
3. Generate a client certificate signed by the root CA
4. Implement an mTLS server and client, verifying that connections with invalid certificates are rejected

**Exercise 3 - HTTP/2 vs HTTP/1.1 Benchmarking**

Write a benchmark that sends 1,000 sequential requests to both an HTTP/1.1 server and an HTTP/2 server. Measure total time, connection count, and throughput. Then run 1,000 concurrent requests and compare.

**Exercise 4 - DNS Caching Middleware**

Implement a `CachingDialer` that wraps `net.Dialer` with TTL-aware DNS caching. Verify it reduces DNS query volume under load using a mock DNS server that logs queries.

**Exercise 5 - Custom Load Balancer**

Implement a load balancer with:
- Consistent hashing for cache-friendly routing
- HTTP health checks with automatic backend removal
- Connection draining on SIGTERM
- Prometheus metrics (requests per backend, error rates, p99 latency per backend)

**Exercise 6 - TCP Nagle Debugging**

Write a custom TCP server and client. Benchmark request-response latency with Nagle enabled vs `TCP_NODELAY`. Use `tcpdump` to count packets in both cases.

**Exercise 7 - HTTP Client Timing Dashboard**

Instrument all outbound HTTP requests in a Go service using `httptrace.ClientTrace` to capture DNS, connect, TLS, and TTFB timings. Expose these as Prometheus histograms and create a Grafana dashboard showing per-endpoint breakdowns.

**Exercise 8 - QUIC Echo Server**

Using `quic-go`, implement an echo server and client over QUIC. Compare connection establishment time (including TLS) with a TCP+TLS equivalent on the same machine, then over a simulated lossy network using `tc netem`.

---

### Junior → FAANG: Networking Exercises as Foundational Practical Skills

These exercises convert abstract networking knowledge into observable, measurable phenomena. Exercise 1 (TIME_WAIT analysis) makes the cost of connection proliferation visible: you can see the TIME_WAIT connections accumulate in `ss` output and measure the performance improvement from connection pooling. Exercise 3 (DNS performance) makes DNS resolution latency visible and motivates caching.

The most valuable exercise for career development: build the complete production HTTP client from exercise 4 and benchmark it against `http.DefaultClient` under load. Measuring a 5x latency improvement from proper connection pooling is more motivating than reading about it, and the benchmark code becomes a template for production client configuration.

### Senior @ FAANG: Networking Exercises as Platform Standards Validation

At staff level, these exercises are prototypes for platform standards. Exercise 4 (production HTTP client configuration) produces the template for the organization's shared HTTP client library. Exercise 5 (TLS performance) validates the TLS configuration choices for the organization's standard server configuration. Exercise 6 (load balancer simulation) demonstrates the behavior of different load balancing algorithms under specific traffic patterns, informing the load balancer selection decision.

Running these exercises with the organization's actual traffic patterns (not just synthetic benchmarks) produces evidence for architectural decisions. "We chose least-connections load balancing because our benchmarks showed 40% lower P99 latency compared to round-robin under our specific traffic pattern of long-tail request duration distribution" is a more defensible architectural decision than "least-connections is generally better for variable-duration requests."
*End of Chapter 102B: Networking Deep Dive for Senior Go Engineers*

---

**Next Chapter: [Chapter 102N: FinOps Deep Dive - Cloud Cost Engineering with Go](../chapter-102n-finops-deep-dive/00-introduction.md)** - Master cloud cost engineering in Go, AWS Cost Explorer and GCP Billing APIs, unit economics instrumentation, rightsizing recommendation engines, and automated anomaly detection.
