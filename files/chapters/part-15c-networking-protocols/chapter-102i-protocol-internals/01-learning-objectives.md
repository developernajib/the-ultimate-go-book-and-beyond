## Learning Objectives

By the end of this chapter, you will be able to:
- Explain the TCP/IP stack and how Go's `net` package interacts with the OS kernel
- Implement custom TCP connection management with fine-grained socket options
- Understand HTTP/2 multiplexing, flow control, HPACK compression, and server push
- Implement HTTP/3 over QUIC using `quic-go` and understand its advantages
- Master TLS 1.3 handshake mechanics, 0-RTT, and certificate management
- Design custom application-layer protocols with efficient binary framing
- Profile and optimize network code at the syscall level

### Junior → FAANG: Mapping Objectives to Common Interview Questions

Each objective maps to a category of interview question. "Explain the TCP/IP stack and Go's `net` package interaction with the OS kernel" maps to "walk me through what happens when you call `http.Get`." "Implement custom TCP connection management with socket options" maps to "how would you tune a Go HTTP client for high-throughput gRPC calls?" "Master TLS 1.3 handshake mechanics" maps to "why is TLS 1.3 faster than TLS 1.2 and what tradeoff does 0-RTT introduce?"

For the custom protocol design objective: the interview version is "you are building a high-frequency trading system where HTTP overhead is measurable. Design the wire protocol." Knowing the components of a custom protocol (frame header, length prefix, type field, payload, checksum) and why each exists is the answer. The ability to sketch a binary frame format on a whiteboard and explain each field's purpose is the target skill level.

### Senior @ FAANG: The Objectives That Distinguish L5 from L6

The objective that most clearly separates L5 from L6 in protocol interviews is "profile and optimize network code at the syscall level." L5 engineers optimize at the application level (reduce request count, increase batch size, tune timeouts). L6 engineers profile at the kernel level: read `ss -i` output to understand TCP retransmission rates, interpret `strace` output to see whether `epoll_wait` is blocking, and correlate `perf` CPU profiles with network event handlers to identify which protocol processing step consumes the most CPU.

The `net/http/httptrace` objective is also L6-differentiating in its depth. Setting up httptrace and reading the output is L5. Designing a system that collects httptrace data from production traffic, aggregates it by endpoint, and surfaces latency percentiles for each phase (DNS, connect, TLS, TTFB) is the L6 observability infrastructure that enables data-driven protocol optimization.

---
