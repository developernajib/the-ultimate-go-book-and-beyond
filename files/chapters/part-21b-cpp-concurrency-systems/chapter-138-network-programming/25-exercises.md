## Exercises

### Exercise 1: Benchmarked Echo Server
Build an echo server using the Reactor pattern. Measure throughput (messages/second) and latency (p50, p99) under load using a tool like `wrk` or a custom client that sends 1000 concurrent connections each sending 10,000 messages. Compare performance with and without `TCP_NODELAY`.

### Exercise 2: HTTP Server with Routing and Middleware
Extend the HTTP server from Section 4 with:
- Path parameter extraction (`/users/:id`)
- Middleware chain (logging, timing, CORS headers)
- Graceful shutdown on SIGTERM (drain existing connections, stop accepting new ones)
- Write buffer management (handle `EAGAIN` on write, use `EPOLLOUT` to resume)

### Exercise 3: Binary Protocol Implementation
Design and implement a binary request-response protocol for a key-value store:
- Operations: GET, SET, DELETE, PING
- Length-prefixed framing with version negotiation
- Pipelining support (multiple requests without waiting for responses)
- Benchmark against a text-based (RESP-like) implementation of the same protocol

### Exercise 4: Connection Pool with Health Checking
Build a connection pool that:
- Periodically sends health check probes to idle connections
- Removes and replaces dead connections automatically
- Tracks metrics (acquire latency, pool utilization, connection lifetime)
- Implements circuit breaker pattern, stop creating connections to a host that has failed N times in the last M seconds

### Exercise 5: TLS Performance Measurement
Write a client that:
- Measures full TLS 1.3 handshake time (new connection)
- Measures resumed handshake time (session ticket)
- Measures 0-RTT early data time
- Compares all three across different cipher suites
- Produces a report showing the latency savings of each resumption mechanism

### Exercise 6: Go vs C++ Network Shootout
Implement the same protocol server in both Go and C++ (use the binary KV protocol from Exercise 3). Benchmark under identical conditions:
- Throughput at 100, 1000, 10000 concurrent connections
- Tail latency (p99, p99.9)
- Memory usage
- CPU utilization
Write a comparison report analyzing where each language excels and why.

---
