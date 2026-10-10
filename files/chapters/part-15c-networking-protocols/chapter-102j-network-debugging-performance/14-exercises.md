## Exercises

1. **Network Health Dashboard**: Build a Go HTTP server that serves a `/health/network` endpoint returning JSON with: DNS lookup latency to 3 configurable hosts, TCP connection state counts from `/proc/net/tcp`, open FD count, and HTTP request latency to 3 upstream dependencies. Include thresholds that return HTTP 503 when any metric exceeds limits.

2. **Retry Storm Simulator**: Implement a test that spins up 100 goroutines each making requests to a mock server that returns 503 for 10 seconds. Measure the retry amplification with and without: (a) no retry logic, (b) fixed 1s retry, (c) exponential backoff with jitter, (d) exponential backoff with jitter + retry budget. Plot amplification factor and success recovery time.

3. **Custom DNS Cache with Negative Caching**: Extend the `DNSCache` to support negative caching (cache NXDOMAIN responses for a configurable TTL), per-host TTL overrides, and metrics export (hit rate, miss rate, eviction count). Benchmark against uncached resolver under high concurrency.

4. **HTTP/2 Server Push Effectiveness**: Build a benchmark that serves an HTML page with 10 linked assets (CSS, JS). Compare total page load time (using a headless Chrome automation or `httptrace`) with: (a) HTTP/1.1, (b) HTTP/2 without push, (c) HTTP/2 with server push. Measure improvement and cases where push is counterproductive (warm cache).

5. **Packet Flow Analyzer**: Using `gopacket`, capture 60 seconds of traffic on a network interface and produce a report showing: top-10 flows by bytes, TCP retransmit rate per flow, SYN/ACK ratio (detects port scans), and connections to unexpected destinations.

6. **Timeout Calibration Tool**: Build a tool that empirically calibrates timeouts for a given service. Make 1000 sequential requests, measure the latency distribution, and recommend: DialTimeout = p95 of connect time, TLSHandshakeTimeout = p95 of TLS time, ResponseHeaderTimeout = p99 of server response time, client.Timeout = p99.9 of total time. Export recommendations as Go code.

### Junior → FAANG: Starting with Exercise 1 and Building Upward

Exercise 1 (Network Health Dashboard) is the single most useful starting point because it builds all the fundamental skills simultaneously: reading `/proc/net/tcp`, computing TCP state distributions, measuring latency with `httptrace`, and surfacing everything through a structured HTTP endpoint. More importantly, it produces a tool you can actually use in a real service.

After completing exercise 1, deploy it as a sidecar endpoint in any service you are running (even locally). Then intentionally introduce a connection leak or a misconfigured transport and verify that the health endpoint detects it. This live testing turns the exercise from a code implementation exercise into a diagnostic instrument you understand deeply.

Exercise 6 (Timeout Calibration Tool) is the most interview-relevant exercise because it captures the correct reasoning about timeout selection: timeouts should be set based on the observed latency distribution of the target service, not based on round numbers. A service with p99.9 of 450ms should have a client timeout of 500-600ms (with headroom), not 1,000ms (because that is a round number) and not 200ms (because that would time out 1 in 1,000 requests that are legitimate but slow).

### Senior @ FAANG: Exercise 6 as a Platform Service

The Timeout Calibration Tool in exercise 6 is a prototype for a platform service that runs continuously in production and maintains recommended timeout configurations for every service-to-service call path. At FAANG scale, managing timeout configurations manually across hundreds of service pairs is not feasible. Services that call each other negotiate timeouts based on outdated measurements or engineering intuition, leading to systematic misconfiguration.

A production timeout calibration service: samples latency from all service-to-service call paths, computes recommended timeout values at each phase (dial, TLS, header, total), compares recommended values against configured values, and alerts when a service is configured with a timeout significantly below the recommended value (causing excessive spurious timeouts) or significantly above (causing slow failure detection under real outages). This service encodes the reasoning from exercise 6 as an automated platform capability.

The L6 contribution: design the data model (how to store and version timeout recommendations), the alert thresholds (when does a misconfiguration become urgent enough to page?), and the rollout process (how do you apply new recommendations without risking service disruption?). These are the governance questions that convert a useful prototype into a reliable platform service.

---
