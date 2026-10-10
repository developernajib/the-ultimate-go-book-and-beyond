## Exercises

1. **TCP Diagnostics Tool**: Write a program that connects to any TCP server and reports RTT, packet loss estimate (from retransmits), and congestion window size using `tcp_info`. Compare results for connections to nearby vs. distant servers.

2. **HTTP/2 Frame Analyzer**: Build a tool that intercepts HTTP/2 traffic (via a local proxy with `net/http/httputil.ReverseProxy`) and prints a frame-by-frame breakdown including stream IDs, frame types, flags, and HPACK header tables. Visualize stream multiplexing.

3. **QUIC File Transfer**: Implement a file transfer tool using `quic-go` raw streams. Support parallel chunks: split the file into N parts and transfer each on a separate QUIC stream concurrently. Compare transfer time vs. a single-stream TCP transfer on an emulated lossy network.

4. **mTLS Service Mesh**: Create a Go microservice framework where all service-to-service communication uses mTLS with a local CA. Services auto-register and obtain certificates at startup. Implement certificate revocation with a CRL or OCSP responder.

5. **Binary Protocol Fuzzer**: Write a fuzzer using `go-fuzz` or `testing/fuzz` that generates random byte sequences and feeds them to your `FrameCodec.ReadFrame()`. Ensure the codec handles all malformed inputs without panicking, and add length/magic validation to prevent OOM attacks.

6. **Connection Pool Benchmark**: Implement three connection pool strategies - (a) per-goroutine pools, (b) global pool with mutex, (c) sharded pool - and benchmark them at 100, 1000, and 10000 concurrent goroutines. Plot throughput and p99 latency.

### Junior → FAANG: Building Diagnostic Intuition Through Exercises

Exercise 1 (TCP Diagnostics Tool) builds a skill that most engineers lack: reading kernel-level TCP state. The `tcp_info` struct contains RTT, retransmission count, and congestion window size - data that application-level metrics cannot provide. Building this tool creates the habit of looking below the application layer when diagnosing network problems.

Exercise 4 (TLS session resumption) builds intuition for where TLS overhead comes from and when session resumption helps. After running this benchmark, you will know concretely how much a TLS handshake costs in milliseconds on your hardware. That number is useful in design conversations: "on our hardware, a TLS 1.3 handshake costs X ms, which means for RPCs shorter than Y ms, connection reuse is mandatory to meet our latency target."

Start with exercises 1 and 4. They build the most durable intuition for the broadest set of real-world network problems.

### Senior @ FAANG: Exercise 6 as a Microcosm of Platform Benchmarking Practice

Exercise 6 (Connection Pool Benchmark) is the most valuable exercise from a platform engineering perspective. The three strategies (per-goroutine, global with mutex, sharded) represent a fundamental tradeoff spectrum: per-goroutine eliminates lock contention at the cost of poor connection reuse, global with mutex maximizes reuse at the cost of contention under load, sharded provides a middle ground. The benchmark across three concurrency levels reveals at what point each strategy's tradeoff changes.

The senior-level extension: run this benchmark not just for concurrency but for connection lifetime (short-lived connections vs. long-lived connections) and request size (small vs. large). The optimal strategy depends on the workload characteristics, and a benchmark that only varies concurrency may give misleading guidance for a different workload.

The platform engineering output: document the benchmark results as internal engineering guidance, recommend the correct strategy for each workload class, and provide the recommended strategy as the default in the platform HTTP client library. Individual teams should not need to run this benchmark themselves. The platform team does it once and publishes the conclusion.

---
