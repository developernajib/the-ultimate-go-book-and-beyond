## Interview Questions

### Fundamentals

**Q1: What happens at the TCP level when you call `connect()` from a client program?**

The kernel initiates the three-way handshake. It sends a SYN segment with a random initial sequence number, transitions the socket to `SYN_SENT` state, and blocks (for blocking sockets) until it receives a SYN-ACK from the server. Upon receiving SYN-ACK, the kernel sends the final ACK, transitions to `ESTABLISHED`, and `connect()` returns. For non-blocking sockets, `connect()` returns immediately with `EINPROGRESS`, and you use `epoll`/`select` to detect when the connection completes (the socket becomes writable).

**Q2: Explain the difference between `SO_REUSEADDR` and `SO_REUSEPORT`.**

`SO_REUSEADDR` allows binding to an address in `TIME_WAIT` state, essential for servers that restart frequently, as TCP connections linger in `TIME_WAIT` for 2*MSL (typically 60 seconds) after close. `SO_REUSEPORT` (Linux 3.9+) allows multiple sockets to bind to the same address and port simultaneously. The kernel distributes incoming connections across them, enabling multi-process load balancing without a shared listen socket. Nginx and Envoy use `SO_REUSEPORT` to distribute connections across worker processes.

**Q3: Why does combining Nagle's algorithm with delayed ACKs cause latency spikes?**

Nagle's algorithm buffers small writes, waiting for an ACK of previously sent data before flushing. Delayed ACKs wait up to 200ms before acknowledging received data, hoping to piggyback on a response. When a client sends a small request and the server does not immediately respond with data (so no piggyback opportunity), the ACK is delayed 200ms. Nagle holds the client's next write during this delay. The result is a 200ms stall on every request that triggers this interaction. The fix is `TCP_NODELAY` on latency-sensitive connections.

### Architecture

**Q4: Compare the Reactor and Proactor patterns. When would you choose one over the other?**

The Reactor notifies the application that a file descriptor is ready for I/O. The application then performs the I/O (read/write syscall). The Proactor submits I/O operations to the OS. The OS performs them asynchronously and notifies the application upon completion, with data already in the buffer. Choose Reactor (epoll) when you need broad platform support and simplicity. Choose Proactor (io_uring, IOCP) when you need high-performance disk I/O (epoll cannot do async disk reads), when you want to minimize syscalls through batched submissions, or when targeting Windows (IOCP is the native high-performance I/O model).

**Q5: How does HTTP/2 flow control work, and how does it interact with TCP flow control?**

HTTP/2 implements its own flow control using WINDOW_UPDATE frames. Each stream and the connection itself have a flow control window (default 65,535 bytes). A sender cannot send more DATA frames than the receiver's window allows. When the receiver processes data, it sends WINDOW_UPDATE to open the window. If the HTTP/2 receiver stops sending WINDOW_UPDATE, the sender's HTTP/2 buffers fill, which causes the TCP send buffer to fill, which causes TCP's receive window to close on the sender's side. The two levels of flow control compose: HTTP/2 provides per-stream granularity, TCP provides the underlying reliability. The risk is deadlocks if both sides are waiting for each other's window updates.

**Q6: Design a connection pool for a microservice that talks to a database. What parameters would you expose, and how would you handle failures?**

Key parameters: `min_idle` (pre-warmed connections), `max_total` (hard limit), `acquire_timeout` (how long to wait when pool is exhausted), `idle_timeout` (close connections idle longer than this), `max_lifetime` (close connections older than this, regardless of activity, to handle server-side state issues). For failure handling: implement health checks on idle connections (periodic ping or TCP keepalive), remove failed connections and replace them, implement circuit breaker logic to stop creating connections to a failing host, and return clear errors to callers (timeout vs connection refused vs pool exhausted) so they can make appropriate decisions (retry, failover, or fail fast).

### Advanced

**Q7: Explain TLS 1.3's 0-RTT and its security implications.**

0-RTT allows a client that has previously connected to a server to send application data in the very first flight of a new connection, using a pre-shared key derived from the previous session. This eliminates the handshake latency entirely. The security risk is replay attacks: an attacker who captures the 0-RTT data can replay it to the server. The server has no way to distinguish the replay from a legitimate retransmission. Therefore, 0-RTT data must only be used for idempotent operations (GET requests, read-only queries). Servers should implement anti-replay mechanisms (single-use session tickets, strike registers, or time-based windows) and applications must design their 0-RTT handlers to be safe against replay.

**Q8: How does Envoy achieve high performance with its thread-local architecture?**

Envoy assigns each connection to a single worker thread for its entire lifetime. Worker threads do not share connection state, there are no mutexes on the hot path. Each worker runs its own event loop (Reactor pattern), its own connection pool to upstream clusters, and its own copy of routing configuration. Configuration updates from the control plane are delivered to each worker thread via thread-local slots, using a read-copy-update (RCU) pattern: the main thread prepares a new config object, posts it to each worker's event loop, and the workers atomically swap their local pointer. This design eliminates lock contention entirely at the cost of per-worker memory duplication (N copies of config, N connection pools), a trade-off that is overwhelmingly worth it for a proxy that may handle millions of requests per second.

**Q9: You are seeing intermittent 200ms latency spikes in a gRPC service. How would you diagnose and fix this?**

Systematic approach: (1) Check if `TCP_NODELAY` is set on gRPC connections, the Nagle + delayed ACK interaction causes exactly 200ms stalls. Most gRPC libraries set this by default, but verify. (2) Check HTTP/2 flow control, if the client's stream window is small and the server produces data faster than window updates arrive, the server stalls. Increase the initial window size. (3) Check for garbage collection pauses in the application (if applicable). (4) Check TCP retransmission statistics (`ss -ti`), a single dropped packet causes a retransmission timeout that defaults to 200ms (the RTO minimum). If retransmissions correlate with latency spikes, investigate network-level issues (congestion, faulty NIC, switch buffer overflow). (5) Check for head-of-line blocking at the TCP level, HTTP/2 multiplexing eliminates application-level HOL blocking, but TCP still delivers bytes in order. A single lost packet blocks all streams on that connection until retransmitted. Consider using multiple TCP connections or QUIC.

**Q10: Compare how Go and C++ handle 100,000 concurrent idle connections. What are the memory and CPU implications?**

In Go, each connection has a goroutine blocked on `Read()`. A goroutine's minimum stack is about 2-4KB (it grows as needed). 100K goroutines consume roughly 200-400MB of stack memory, plus the connection buffers. The Go runtime's netpoller uses epoll internally, so idle goroutines consume no CPU, they are parked until data arrives. In C++, using a Reactor pattern with epoll, 100K idle connections are just 100K file descriptors monitored by epoll. Each needs a small struct for state (maybe 100-200 bytes). Total memory: roughly 10-20MB. CPU is near zero, epoll blocks until events arrive. C++ is dramatically more memory-efficient for idle connections because there is no goroutine stack overhead. However, Go's model is far simpler to program. In practice, both handle 100K connections well. The difference matters at millions of connections or in memory-constrained environments.

---
