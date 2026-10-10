## Summary

Network programming sits at the intersection of systems programming and distributed systems design. Key layers of the stack include:

- **TCP/IP fundamentals**: The three-way handshake, congestion control (Cubic for loss-based, BBR for model-based), and Nagle's algorithm interactions that create real-world latency issues.
- **Reactor pattern**: Single-threaded event loops using epoll that handle thousands of connections without threads, the architecture behind Redis and Nginx.
- **Proactor pattern**: True async I/O with io_uring where the kernel performs operations and notifies on completion, eliminating the double syscall overhead of the Reactor.
- **HTTP from scratch**: Incremental parsing, non-blocking I/O, keep-alive connections, understanding what your framework does internally.
- **Protocol design**: Binary vs text trade-offs, framing strategies (length-prefixed, delimiter, fixed), and versioning approaches that keep protocols evolvable.
- **gRPC internals**: HTTP/2 stream multiplexing, the 5-byte gRPC message prefix, and two-level flow control that provides per-stream backpressure.
- **TLS 1.3**: The 1-RTT handshake, session resumption with tickets, and 0-RTT early data with its replay attack implications.
- **Connection pooling and backpressure**: Reusing expensive connections, health checking, and the critical importance of bounded queues and flow control to prevent cascading failures.
- **Envoy proxy**: How a production C++ proxy achieves millions of requests per second through thread-local architecture, filter chains, and dynamic configuration.
- **Go vs C++ comparison**: Go provides simplicity through goroutines and a powerful standard library. C++ provides control through explicit resource management and zero-overhead abstractions. The best systems use both.

The network is the boundary between your process and the rest of the world. Understanding every layer, from TCP segment pacing to TLS key exchange to HTTP/2 frame interleaving, is what separates engineers who build reliable distributed systems from those who merely use them.

---

| [◀ Chapter 137: Systems Programming](../chapter-137-systems-programming/00-introduction.md) | [Chapter 138: Network Programming](00-introduction.md) | [Chapter 139: Performance Engineering](../../part-21c-cpp-performance/chapter-139-performance-engineering/00-introduction.md) ▶ |

