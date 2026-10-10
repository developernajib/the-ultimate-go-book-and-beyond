## 31B.2 The net Package in Depth

### TCP Connection Lifecycle

The TCP connection lifecycle diagram shows the state machine from `SYN` through established to `FIN`/`TIME_WAIT`. Understanding this model explains why half-open connections accumulate when one side crashes, and why `SO_REUSEADDR` is necessary for rapid server restarts.

```
┌───────────────────────────────────────────────────────────────────────┐
│              TCP Connection Lifecycle in Go                           │
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  Dialing (client side):                                               │
│  net.Dial → os.Socket → connect() syscall → 3-way handshake           │
│  → returns net.Conn (implements io.Reader + io.Writer + Closer)       │
│                                                                       │
│  Listening (server side):                                             │
│  net.Listen → socket + bind + listen → returns net.Listener           │
│  net.Listener.Accept → accept() → returns net.Conn per connection     │
│                                                                       │
│  Each net.Conn:                                                       │
│  - Has a file descriptor                                              │
│  - Read/Write = send/recv syscalls with Go's netpoller (epoll/kqueue) │
│  - Non-blocking internally - goroutine parks while waiting for data   │
│  - go runtime unparks it when the fd is ready                         │
│                                                                       │
│  Closing a connection:                                                │
│  conn.Close() → close(fd) → sends FIN, enters TIME_WAIT               │
│  conn.CloseWrite() → half-close (sends FIN but can still read)        │
│                                                                       │
│  The netpoller is why Go can handle millions of connections with      │
│  thousands of goroutines - goroutines park, not OS threads.           │
└───────────────────────────────────────────────────────────────────────┘
```

### net.Conn: The Core Interface

`net.Conn` is the interface returned by both `net.Dial` (client side) and `net.Listener.Accept` (server side). It combines `io.Reader`, `io.Writer`, and `io.Closer` with deadline methods. Setting deadlines is critical, a connection without a deadline blocks indefinitely if the remote peer stops responding, which leaks the goroutine. The example below shows a typical echo server pattern with per-message deadline resets and proper timeout detection.

```go
package main

import (
    "bufio"
    "context"
    "fmt"
    "io"
    "net"
    "time"
)

// net.Conn interface:
// type Conn interface {
//     Read(b []byte) (n int, err error)
//     Write(b []byte) (n int, err error)
//     Close() error
//     LocalAddr() Addr
//     RemoteAddr() Addr
//     SetDeadline(t time.Time) error       // both read and write deadline
//     SetReadDeadline(t time.Time) error   // only read deadline
//     SetWriteDeadline(t time.Time) error  // only write deadline
// }

// CRITICAL: Always set deadlines to prevent goroutine leaks
// A connection without a deadline will block forever if the peer stops sending
func handleConn(conn net.Conn) {
    defer conn.Close()

    // Set an idle timeout - if no data for 30s, connection closes
    conn.SetDeadline(time.Now().Add(30 * time.Second))

    reader := bufio.NewReader(conn)
    for {
        // Reset deadline on each message (keeps connection alive as long as messages come)
        conn.SetDeadline(time.Now().Add(30 * time.Second))

        line, err := reader.ReadString('\n')
        if err != nil {
            if err != io.EOF {
                // Check if it's a timeout
                if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
                    fmt.Println("connection timed out")
                } else {
                    fmt.Println("read error:", err)
                }
            }
            return
        }
        conn.Write([]byte("echo: " + line))
    }
}

// Echo server: one goroutine per connection
func runEchoServer(ctx context.Context) error {
    ln, err := net.Listen("tcp", ":8080")
    if err != nil {
        return err
    }
    defer ln.Close()

    // Stop accepting when context is canceled
    go func() {
        <-ctx.Done()
        ln.Close()
    }()

    for {
        conn, err := ln.Accept()
        if err != nil {
            if ctx.Err() != nil {
                return nil // expected shutdown
            }
            return err
        }
        go handleConn(conn) // each connection gets its own goroutine
    }
}
```

### net.Dialer: Fine-Grained Connection Control

The default `net.Dial` function uses reasonable defaults, but production code usually needs a `net.Dialer` struct for explicit control over connection timeout, TCP keepalive intervals, DNS resolution, and local address binding. The dialer's `DialContext` method accepts a `context.Context` for cancellation support. You can also inject a custom dialer into `http.Transport` to control how the HTTP client establishes its underlying TCP connections.

```go
package main

import (
    "context"
    "fmt"
    "net"
    "net/http"
    "time"
)

func customDialer() {
    dialer := &net.Dialer{
        // Timeout: how long to wait for the TCP 3-way handshake to complete
        Timeout: 10 * time.Second,

        // KeepAlive: how often to send TCP keepalive probes
        // Detects dead connections (peer crashed without sending FIN)
        KeepAlive: 30 * time.Second,

        // KeepAliveConfig: fine-grained keepalive control (Go 1.23+)
        KeepAliveConfig: net.KeepAliveConfig{
            Enable:   true,
            Idle:     30 * time.Second, // start probing after 30s idle
            Interval: 5 * time.Second,  // probe every 5s
            Count:    3,                // 3 failed probes = connection dead
        },

        // FallbackDelay: for Happy Eyeballs (IPv4 fallback delay)
        // -1 disables IPv6, 0 uses default 300ms
        FallbackDelay: 300 * time.Millisecond,

        // LocalAddr: bind to a specific local address
        // LocalAddr: &net.TCPAddr{IP: net.ParseIP("192.168.1.100")},

        // Resolver: custom DNS resolver
        Resolver: &net.Resolver{
            PreferGo: true, // use Go's pure-Go DNS resolver (not cgo)
            Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
                // Use a custom DNS server
                d := net.Dialer{Timeout: 5 * time.Second}
                return d.DialContext(ctx, "udp", "8.8.8.8:53")
            },
        },
    }

    // Dial with context (preferred over plain Dial - supports cancellation)
    ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
    defer cancel()

    conn, err := dialer.DialContext(ctx, "tcp", "example.com:443")
    if err != nil {
        fmt.Println("dial error:", err)
        return
    }
    defer conn.Close()

    fmt.Println("connected to:", conn.RemoteAddr())

    // Use the custom dialer in an HTTP client
    transport := &http.Transport{
        DialContext: dialer.DialContext,
        // Connection pool settings
        MaxIdleConns:        100,
        MaxIdleConnsPerHost: 20,
        MaxConnsPerHost:     0, // unlimited
        IdleConnTimeout:     90 * time.Second,
        // TLS settings
        TLSHandshakeTimeout:   10 * time.Second,
        ResponseHeaderTimeout: 30 * time.Second,
        ExpectContinueTimeout: 1 * time.Second,
        // Compression
        DisableCompression: false, // accept gzip from servers
    }

    client := &http.Client{
        Transport: transport,
        Timeout:   60 * time.Second, // total request timeout
    }
    _ = client
}
```

### Unix Domain Sockets

Unix domain sockets provide inter-process communication on the same machine without the overhead of the TCP/IP stack, no IP headers, no port lookup, no network-layer processing. They use filesystem paths instead of host:port pairs. Docker, PostgreSQL, Redis, and systemd all default to Unix sockets for local communication. In Go, you use the same `net.Listen` and `net.Dial` functions with `"unix"` as the network type, and you get back a standard `net.Conn`.

```go
package main

import (
    "context"
    "fmt"
    "net"
    "os"
)

// Unix domain sockets: inter-process communication on the same machine
// Faster than TCP loopback (no IP header, no port lookup, no network stack)
// Used by: Docker daemon, PostgreSQL, systemd, Redis default config

const socketPath = "/tmp/myapp.sock"

func runUnixServer(ctx context.Context) error {
    // Remove stale socket file
    os.Remove(socketPath)

    ln, err := net.Listen("unix", socketPath)
    if err != nil {
        return fmt.Errorf("unix listen: %w", err)
    }
    defer ln.Close()
    defer os.Remove(socketPath)

    // Set permissions so only owner can connect
    os.Chmod(socketPath, 0600)

    go func() {
        <-ctx.Done()
        ln.Close()
    }()

    for {
        conn, err := ln.Accept()
        if err != nil {
            return err
        }
        go func() {
            defer conn.Close()
            // conn is a *net.UnixConn - same net.Conn interface as TCP
            buf := make([]byte, 1024)
            n, _ := conn.Read(buf)
            fmt.Printf("unix: received %q\n", string(buf[:n]))
            conn.Write([]byte("ok"))
        }()
    }
}

func connectUnix() error {
    conn, err := net.Dial("unix", socketPath)
    if err != nil {
        return err
    }
    defer conn.Close()

    conn.Write([]byte("hello via unix socket"))
    buf := make([]byte, 16)
    n, _ := conn.Read(buf)
    fmt.Println("unix response:", string(buf[:n]))
    return nil
}
```

### DNS Resolution

Go provides two DNS resolver implementations: a pure-Go resolver and a cgo-based resolver that delegates to the system's C library. The pure-Go resolver (selected by default on most platforms, or forced with `GODEBUG=netdns=go`) avoids cgo overhead and works well for most cases. The `net` package exposes lookup functions for A/AAAA records (`LookupHost`), MX records (`LookupMX`), TXT records (`LookupTXT`), reverse DNS (`LookupAddr`), and more. For timeout-safe resolution, use `net.Resolver` with a `context.Context`.

```go
package main

import (
    "context"
    "fmt"
    "net"
    "time"
)

func dnsExamples() {
    // Default resolver: uses /etc/resolv.conf (or cgo resolver)
    // To force pure-Go resolver: GODEBUG=netdns=go

    // Lookup IP addresses for a hostname
    addrs, err := net.LookupHost("example.com")
    if err != nil {
        fmt.Println("lookup error:", err)
        return
    }
    fmt.Println("IPs:", addrs) // ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]

    // Lookup with context (supports timeout and cancellation)
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    resolver := &net.Resolver{PreferGo: true}
    addrs2, err := resolver.LookupHost(ctx, "golang.org")
    fmt.Println("golang.org IPs:", addrs2, err)

    // Lookup MX records
    mxRecords, _ := net.LookupMX("gmail.com")
    for _, mx := range mxRecords {
        fmt.Printf("MX: %s priority=%d\n", mx.Host, mx.Pref)
    }

    // Lookup TXT records (SPF, DKIM, etc.)
    txtRecords, _ := net.LookupTXT("_dmarc.google.com")
    for _, txt := range txtRecords {
        fmt.Println("TXT:", txt)
    }

    // Reverse lookup: IP → hostname
    names, _ := net.LookupAddr("8.8.8.8")
    fmt.Println("reverse lookup 8.8.8.8:", names) // [dns.google.]

    // Parse and validate IPs
    ip := net.ParseIP("192.168.1.1")
    if ip == nil {
        fmt.Println("invalid IP")
    }
    fmt.Println("is IPv4:", ip.To4() != nil)
    fmt.Println("is IPv6:", ip.To4() == nil)

    // CIDR parsing
    _, network, _ := net.ParseCIDR("192.168.0.0/16")
    fmt.Println("contains 192.168.1.1:", network.Contains(net.ParseIP("192.168.1.1")))
    fmt.Println("contains 10.0.0.1:", network.Contains(net.ParseIP("10.0.0.1")))
}
```

### Raw Connections: net.TCPConn

When you need TCP-specific socket options that the `net.Conn` interface does not expose, use `net.DialTCP` to get a `*net.TCPConn` directly. This gives access to `SetNoDelay` (disables Nagle's algorithm for latency-sensitive protocols), `SetLinger` (controls behavior on `Close`), OS-level buffer sizing, and `CloseWrite` for half-close semantics where you signal end-of-write while continuing to read the peer's response.

```go
package main

import (
    "fmt"
    "net"
    "time"
)

func tcpAdvanced() {
    conn, err := net.DialTCP("tcp", nil, &net.TCPAddr{
        IP:   net.ParseIP("93.184.216.34"),
        Port: 80,
    })
    if err != nil {
        fmt.Println("error:", err)
        return
    }
    defer conn.Close()

    // TCP-specific options not available on net.Conn interface
    conn.SetNoDelay(true)      // disable Nagle's algorithm (for low-latency)
    conn.SetLinger(0)          // RST instead of graceful close (for server recycling)
    conn.SetReadBuffer(65536)  // OS receive buffer size
    conn.SetWriteBuffer(65536) // OS send buffer size

    // Keep-alive at TCP level
    conn.SetKeepAlive(true)
    conn.SetKeepAlivePeriod(30 * time.Second)

    // Half-close: signal end of write stream, still read
    conn.Write([]byte("GET / HTTP/1.0\r\nHost: example.com\r\n\r\n"))
    conn.CloseWrite() // send FIN for our direction

    buf := make([]byte, 4096)
    n, _ := conn.Read(buf)
    fmt.Println("response:", string(buf[:n])[:100])
}
```

### Junior to FAANG: From `net.Dial` to `epoll_wait`

The `net` package hides a large amount of machinery. As a junior, the important mental model is that `net.Conn` is a userspace handle to a kernel socket, and every `Read`/`Write` is a syscall that the Go runtime schedules through the netpoller.

When you write:

```go
ln, _ := net.Listen("tcp", ":8080")
for {
    c, _ := ln.Accept()
    go handle(c)
}
```

The runtime does the following. `net.Listen` calls `socket(2)`, `bind(2)`, `listen(2)`. `Accept` calls `accept4(2)` with `SOCK_NONBLOCK`. If no connection is pending, the goroutine is parked via `gopark`, the listener's fd is registered with epoll (Linux), kqueue (macOS/BSD), or IOCP (Windows). When a SYN completes the 3-way handshake, the kernel posts a readiness event, the netpoller thread wakes up, finds the parked goroutine, and places it on a P's runqueue. The goroutine then retries `accept4`, which now succeeds, and you get a `net.Conn`.

First-job worked example. You are asked to write a TCP echo server and someone says "make sure it handles slow clients without blocking." The naive version:

```go
func handle(c net.Conn) {
    defer c.Close()
    io.Copy(c, c)
}
```

This leaks forever if a client connects, sends nothing, and never closes. The fix is `c.SetReadDeadline(time.Now().Add(30*time.Second))` at the start of each read cycle, or use `context.Context` with `net.Dialer.DialContext`. Every FAANG interviewer for backend roles asks a version of "your service is running out of file descriptors, why?" The answer is almost always missing deadlines or missing `Close` on error paths.

Prerequisites you should be fluent in:

1. The TCP 3-way handshake: SYN, SYN-ACK, ACK. And the 4-way teardown: FIN, ACK, FIN, ACK.
2. The difference between `TIME_WAIT` (local side closed first, waits 2*MSL) and `CLOSE_WAIT` (remote closed, you have not). A buildup of `CLOSE_WAIT` means your code is not closing on EOF.
3. How to use `ss -tan | head` on Linux to see socket states.
4. The difference between a listening socket and an accepted socket. Each `Accept` returns a new fd.

### Senior at FAANG: Netpoller Internals, SO_REUSEPORT, and Tuning at 10M RPS

At staff level the `net` package is a thin veneer over the netpoller, which is itself a thin veneer over the platform readiness API. Being effective at scale requires reading `runtime/netpoll.go`, `runtime/netpoll_epoll.go`, and `net/fd_unix.go`.

**Netpoller architecture.** Go runs one netpoller per process. On Linux it owns a single `epoll_fd` created via `epoll_create1(EPOLL_CLOEXEC)`. Every `net.Conn` and `net.Listener` registers its fd with `epoll_ctl(EPOLL_CTL_ADD, fd, EPOLLIN|EPOLLOUT|EPOLLRDHUP|EPOLLET)`. Note `EPOLLET`: edge-triggered. The runtime relies on edge-triggered semantics to avoid repeated wakeups for the same readiness state.

When a goroutine calls `conn.Read` and the kernel has no data, the runtime enters `runtime.netpollblock`, which parks the goroutine with `gopark`. The goroutine is stashed in a `pollDesc` struct attached to the fd. When epoll signals readiness, `runtime.netpoll` (called from `findrunnable` in the scheduler and from the sysmon thread) iterates ready events, extracts the parked goroutine, and returns it to the scheduler via `injectglist`. The goroutine eventually runs on some P and retries the read, which now succeeds.

Crucial implication: `net.Conn.Read` does not block an OS thread. It parks a goroutine. This is why one Go process can hold 1M idle connections with only `GOMAXPROCS` OS threads running. Contrast with a thread-per-connection C++ server, which would need 1M threads.

**Blocking syscalls and M blowup.** File IO and DNS lookups are different. `os.File.Read` is a blocking syscall. The runtime marks the M as "in syscall" via `entersyscall`, detaches the P, and if the syscall runs long enough, the sysmon thread creates a new M to keep `GOMAXPROCS` Ps busy. On `exitsyscall`, the M tries to reclaim its P, otherwise it parks. This is why a service that suddenly switches from network IO to blocking file IO can see thread count spike from 16 to 10,000 in seconds. Monitor `runtime.ThreadCreateProfile` and set `debug.SetMaxThreads(N)` as a safety net.

**SO_REUSEPORT for listener scaling.** A single listener fd funnels all new connections through one accept queue, which is protected by a kernel spinlock. At 100k accepts/sec on a 64-core box, that spinlock becomes the bottleneck. `SO_REUSEPORT` lets N processes (or N sockets in one process) bind to the same port, and the kernel distributes incoming SYNs across them via a hash of the 4-tuple. Go does not enable this by default. Use `github.com/libp2p/go-reuseport` or set the option manually via `net.ListenConfig.Control`:

```go
lc := net.ListenConfig{
    Control: func(network, address string, c syscall.RawConn) error {
        return c.Control(func(fd uintptr) {
            unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEPORT, 1)
        })
    },
}
ln, _ := lc.Listen(ctx, "tcp", ":8080")
```

Spin up `GOMAXPROCS` listeners, each with its own accept goroutine, and the accept lock contention disappears. At Meta this pattern is standard for edge load balancers. Caveat: connection distribution is not perfectly even. If one listener is slower to drain, the kernel does not rebalance. `SO_INCOMING_CPU` (Linux 4.4+) binds sockets to specific CPUs, pairing well with CPU pinning.

**TCP_NODELAY and TCP_QUICKACK.** Nagle's algorithm coalesces small writes to reduce packet count. Delayed ACKs coalesce ACKs to reduce reverse-direction packets. Together they create a classic 40ms latency hiccup on request-response protocols where the client sends a small request, server sends a small response, and both sides wait for each other. Go sets `TCP_NODELAY` by default on `TCPConn`. Verify with `getsockopt`. For gRPC, HTTP/2, Redis, and most RPC protocols, leave `TCP_NODELAY` on. `TCP_QUICKACK` is not set by default and resets after every response on Linux. Set it aggressively in latency-sensitive paths.

**Congestion control: BBRv3 vs CUBIC.** CUBIC is the Linux default. It uses packet loss as the congestion signal, which overfills buffers at intermediate switches (bufferbloat). BBR models the bottleneck bandwidth and RTT directly, avoids bufferbloat, and consistently delivers 2-5x throughput on long-fat-network paths. Google runs BBR on YouTube and internal RPC. BBRv3 (2023) fixes several fairness issues. Set per-socket:

```go
// Linux 4.9+ for BBR, 6.4+ for BBRv3
unix.SetsockoptString(fd, unix.IPPROTO_TCP, unix.TCP_CONGESTION, "bbr")
```

Or systemwide: `sysctl net.ipv4.tcp_congestion_control=bbr`. For cross-region replication (say, us-east to eu-west with 100ms RTT), BBR typically doubles throughput. For intra-rack traffic, the difference is smaller.

**TLS session resumption and 0-RTT.** Full TLS 1.3 handshake is one round trip. Resumption via session tickets is zero additional handshakes but costs one round trip for application data. `0-RTT` sends application data in the first flight, saving the round trip but enabling replay attacks. Only use 0-RTT for idempotent requests. Go's `crypto/tls` supports session tickets by default in 1.17+. For cluster-wide resumption, you must share the ticket encryption key across all servers. Rotate every 24 hours. See `tls.Config.SetSessionTicketKeys`.

**The netpoller scalability ceiling.** At roughly 2M simultaneous connections on a single Go process, the `epoll_ctl` rate for short-lived connections becomes a bottleneck. Workarounds include `SO_REUSEPORT` sharding across processes, or switching to `io_uring` for the accept loop (experimental, not in stdlib). Cloudflare, Tailscale, and Netflix have all published on this ceiling. For most services you will never hit it.

**DNS resolution.** Go has two resolvers: the pure-Go resolver and the cgo resolver. The pure-Go resolver parses `/etc/resolv.conf` and talks UDP directly. The cgo resolver calls `getaddrinfo(3)` which respects NSS, `/etc/nsswitch.conf`, mDNS, and LDAP. Choose via `GODEBUG=netdns=go` or `cgo`. The pure-Go resolver is faster and more predictable but misses some NSS plugins. At most FAANG companies, the cgo resolver is disabled in production because it blocks an M per lookup and the mystery hangs are worse than missing mDNS. DNS caching is not done by Go. Use `github.com/rs/dnscache` or a local resolver like Unbound running on 127.0.0.1.

**Staff-level review checklist for network code:**

1. Are read and write deadlines set on every `net.Conn` before blocking on it?
2. Is the accept loop protected against transient `accept` errors (return vs retry vs panic)?
3. Is `SO_REUSEPORT` used for listeners expected to see more than 10k accepts/second?
4. Is the TLS config explicit about min version (1.3) and cipher suites?
5. Is DNS resolution cached, and is the resolver chosen deliberately?
6. Is there a metric for `TIME_WAIT` and `CLOSE_WAIT` socket counts?
7. Under SIGTERM, does the listener drain in-flight connections with a bounded deadline?

---
