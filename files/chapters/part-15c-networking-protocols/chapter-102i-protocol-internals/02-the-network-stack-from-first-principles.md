## Architecture Overview: The Network Stack from First Principles

Go's network stack is a layered abstraction that maps directly onto the OSI model, with the Go runtime acting as a thin bridge between user-space goroutines and kernel I/O multiplexing via `epoll` (Linux), `kqueue` (macOS/BSD), or `IOCP` (Windows). When a goroutine blocks on a `net.Conn.Read`, the runtime parks the goroutine and registers the file descriptor with the OS poller, the goroutine is rescheduled only when the kernel signals data is available, keeping system thread count low. HTTP/2 adds a stream multiplexing layer on top of a single TLS/TCP connection, while HTTP/3 replaces the TCP transport entirely with QUIC over UDP, eliminating head-of-line blocking at the transport level.

```
┌──────────────────────────────────────────────────────────────────┐
│                     Go Application Layer                         │
│          net/http, net.Conn, net.Listener, crypto/tls            │
├──────────────────────────────────────────────────────────────────┤
│                      Go Runtime (netpoll)                        │
│        epoll/kqueue/IOCP integration, goroutine parking          │
├──────────────────────────────────────────────────────────────────┤
│                   Operating System Kernel                        │
│    TCP/UDP socket API, socket buffers, congestion control        │
├──────────────────────┬───────────────────┬───────────────────────┤
│   Transport Layer    │   Network Layer   │   Data Link Layer     │
│   TCP / UDP / QUIC   │      IP v4/v6     │   Ethernet / Wi-Fi    │
└──────────────────────┴───────────────────┴───────────────────────┘

HTTP/2 multiplexing over TLS/TCP:
┌──────────────────────────────────────────────┐
│  Stream 1  │  Stream 3  │  Stream 5  │ ...   │  ← HEADERS + DATA frames
│  GET /api  │  POST /up  │  GET /img  │       │
├──────────────────────────────────────────────┤
│              Single TCP Connection           │ 
│         TLS 1.3 record layer (AES-GCM)       │ 
└──────────────────────────────────────────────┘

HTTP/3 over QUIC (UDP):
┌──────────────────────────────────────────────┐
│  Stream 1  │  Stream 3  │  Stream 5  │ ...   │  ← no HOL blocking!
├──────────────────────────────────────────────┤
│            QUIC (UDP + reliable streams)     │ 
│       Built-in TLS 1.3, connection IDs       │ 
└──────────────────────────────────────────────┘
```

### Junior → FAANG: The Go Runtime's Relationship to the OS Poller

The key insight in this section is that Go goroutines do not block OS threads when waiting on network I/O. When `net.Conn.Read` has no data, the runtime parks the goroutine (moves it off the OS thread), registers the file descriptor with `epoll`/`kqueue`, and runs another goroutine on the same OS thread. When the kernel signals that data is available, the runtime reschedules the parked goroutine. This is why Go can handle hundreds of thousands of concurrent network connections with a relatively small number of OS threads.

For interviews: understanding this mechanism lets you answer "why does Go handle concurrency well for network services?" with a precise answer rather than "because goroutines are cheap." The precise answer is: goroutines yield cooperatively on I/O operations without blocking OS threads, enabling the scheduler to multiplex many concurrent I/O waits onto a small OS thread pool.

### Senior @ FAANG: netpoll and Its Implications for Latency Optimization

The Go netpoll mechanism introduces a specific latency characteristic: goroutines wake up when the OS signals I/O readiness, not when data arrives at the application. Under high load, the OS poller notification may be delayed by the scheduler's run queue, adding single-digit milliseconds of latency that is invisible to application-level profiling. This is measurable with `epoll_wait` latency instrumentation via `strace` or `eBPF`.

The practical implication for latency-sensitive services: the Go runtime's M:N threading model with netpoll is not appropriate for sub-100 microsecond latency requirements. At that latency tier, user-space networking (DPDK, io_uring) or kernel bypass technologies are required, and the Go runtime's netpoll becomes a bottleneck. Staff-level architects at companies building latency-sensitive trading systems or real-time processing pipelines are expected to know where the runtime's I/O model is and is not suitable, and what the alternatives are.

---
