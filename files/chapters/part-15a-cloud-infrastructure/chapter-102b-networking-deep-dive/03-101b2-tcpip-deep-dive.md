## 102B.2 TCP/IP Deep Dive

### The TCP/IP Stack

The TCP/IP model organizes network communication into four layers. Each layer adds a header to the data (encapsulation) and removes it on receipt (decapsulation).

```
┌─────────────────────────────────────────┐
│           APPLICATION LAYER             │
│    HTTP, gRPC, WebSocket, DNS, SMTP     │
│    Your Go code operates here           │
├─────────────────────────────────────────┤
│           TRANSPORT LAYER               │
│         TCP / UDP / QUIC                │
│    Ports, reliability, ordering         │
├─────────────────────────────────────────┤
│           INTERNET LAYER                │
│              IP (v4/v6)                 │
│    Addressing, routing, fragmentation   │
├─────────────────────────────────────────┤
│           LINK LAYER                    │
│    Ethernet, Wi-Fi, Fiber               │
│    MAC addresses, frames                │
└─────────────────────────────────────────┘
```

Data flows down the stack on the sender side (each layer adds its header) and up the stack on the receiver side (each layer strips its header).

### IP Addressing: IPv4, IPv6, CIDR, Subnetting

**IPv4** uses 32-bit addresses, written as four octets: `192.168.1.100`. The theoretical maximum is ~4.3 billion addresses. Due to address exhaustion, NAT (Network Address Translation) became ubiquitous, allowing private address spaces (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) to be reused behind routers.

**IPv6** uses 128-bit addresses: `2001:0db8:85a3:0000:0000:8a2e:0370:7334`. This provides ~340 undecillion addresses - enough for every atom on Earth to have multiple IP addresses. IPv6 eliminates NAT in theory, simplifying peer-to-peer communication.

**CIDR (Classless Inter-Domain Routing)** notation specifies a network block: `10.0.0.0/8` means the first 8 bits are the network portion, leaving 24 bits for host addresses (16,777,214 usable hosts). For a Kubernetes cluster, you might allocate `10.244.0.0/16` for pods.

**Subnetting** divides a network into smaller blocks. A `/24` subnet (255 hosts) is a common unit for a single service or availability zone. A `/28` (14 hosts) is common for isolated components like NAT gateways.

```
CIDR Reference:
/32  = 1 host         (single IP)
/31  = 2 hosts        (point-to-point links)
/30  = 4 hosts        (2 usable, common for small subnets)
/28  = 16 hosts       (14 usable)
/24  = 256 hosts      (254 usable, most common)
/16  = 65536 hosts    (common for VPCs)
/8   = 16M hosts      (Class A, private range)
```

### TCP: Connection-Oriented, Reliable, Ordered

TCP (Transmission Control Protocol) provides:

- **Reliability**: every byte is acknowledged. unacknowledged segments are retransmitted
- **Ordering**: bytes are delivered to the application in the order they were sent, regardless of how packets arrived
- **Flow control**: the receiver can slow down the sender to avoid buffer overflow
- **Congestion control**: the sender adapts to network conditions to avoid collapse

These guarantees come at a cost: latency (due to acknowledgments and retransmission), head-of-line blocking (a lost packet blocks all subsequent packets in the stream), and connection state overhead.

### TCP Three-Way Handshake

Before any data can be exchanged, TCP requires a three-way handshake to synchronize sequence numbers and establish the connection.

```
Client                           Server
  │                                 │
  │──── SYN (seq=x) ───────────────►│  Client sends SYN
  │                                 │  Server receives SYN, opens socket
  │◄─── SYN-ACK (seq=y, ack=x+1) ──│  Server replies SYN-ACK
  │                                 │
  │──── ACK (ack=y+1) ─────────────►│  Client acknowledges
  │                                 │
  │══════════ DATA FLOWS ═══════════│  Connection established
  │                                 │
```

**What each field means:**
- `SYN`: synchronize sequence numbers - "I want to start a connection, my initial sequence number is X"
- `ACK`: acknowledge - "I received everything up to byte Y+1"
- `SYN-ACK`: the server's SYN (with its own initial sequence number Y) combined with an ACK of the client's SYN

**Cost of the handshake:** one full round-trip before any application data can be sent. On a 100ms RTT connection (e.g., cross-continent), this costs 100ms before a single byte of HTTP request is transmitted. This is why connection pooling and keep-alive are critical.

### TCP Four-Way Termination

TCP connection teardown requires four steps because each side must independently close its half of the connection (TCP is full-duplex).

```
Client (initiates close)          Server
  │                                 │
  │──── FIN (seq=m) ───────────────►│  "I have no more data to send"
  │◄─── ACK (ack=m+1) ─────────────│  Server acknowledges client's FIN
  │                                 │  (server may still be sending data)
  │◄─── FIN (seq=n) ───────────────│  Server finishes sending, closes its side
  │──── ACK (ack=n+1) ─────────────►│  Client acknowledges
  │                                 │
  │    [Client enters TIME_WAIT]    │  Connection fully closed after 2*MSL
```

### TCP TIME_WAIT: Why It Exists and Why It Causes Problems

After the client sends the final ACK, it enters `TIME_WAIT` state for `2*MSL` (Maximum Segment Lifetime, typically 60 seconds, so TIME_WAIT lasts 120 seconds). The port cannot be reused during this period.

**Why TIME_WAIT exists:**
1. Ensures the final ACK reaches the server (if the ACK is lost, the server retransmits its FIN and the client can re-ACK)
2. Prevents "ghost" packets from a previous connection being misinterpreted by a new connection on the same port

**Why TIME_WAIT causes problems:**

On a busy server handling thousands of short-lived connections, TIME_WAIT can exhaust the local port range (default: 28,232 ports on Linux, from `ip_local_port_range` 32768-60999). When all ports are in TIME_WAIT, new connections fail with `EADDRNOTAVAIL`.

**How to handle in Go:**

```go
package main

import (
    "net"
    "net/http"
    "time"
)

// ProductionTransport creates an http.Transport configured to minimize TIME_WAIT
// exhaustion by reusing connections aggressively.
func ProductionTransport() *http.Transport {
    dialer := &net.Dialer{
        Timeout:   30 * time.Second,
        KeepAlive: 30 * time.Second,
        // DualStack enables both IPv4 and IPv6 (Happy Eyeballs algorithm).
        // Go 1.21+ uses this by default.
    }

    return &http.Transport{
        DialContext:           dialer.DialContext,
        MaxIdleConns:          1000,
        MaxIdleConnsPerHost:   100,
        MaxConnsPerHost:       0, // no limit
        IdleConnTimeout:       90 * time.Second,
        TLSHandshakeTimeout:   10 * time.Second,
        ExpectContinueTimeout: 1 * time.Second,
        // DisableKeepAlives: false (default) - MUST be false to reuse connections
        // and avoid TIME_WAIT accumulation.
    }
}

// Client is a package-level singleton - never create http.Client per request.
var Client = &http.Client{
    Transport: ProductionTransport(),
    Timeout:   30 * time.Second,
}
```

On the server side, `SO_REUSEADDR` (set by default by Go's listener) allows a server to bind to a port even if it's in TIME_WAIT from a previous process. For high-connection-rate servers, also consider:

```go
//go:build linux || darwin

package main

import (
    "context"
    "net"
    "syscall"
    "time"

    "golang.org/x/sys/unix"
)

// ServerWithTCPOptions sets TCP-level options on the listener.
func ServerWithTCPOptions(addr string) (net.Listener, error) {
    lc := net.ListenConfig{
        Control: func(network, address string, c syscall.RawConn) error {
            return c.Control(func(fd uintptr) {
                // SO_REUSEPORT allows multiple sockets to bind to the same port.
                // Linux kernel distributes incoming connections across them.
                // Useful for multi-core servers.
                _ = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEPORT, 1)
            })
        },
        KeepAlive: 30 * time.Second,
    }
    return lc.Listen(context.Background(), "tcp", addr)
}
```

### TCP Flow Control: Receiver Window

Flow control prevents a fast sender from overwhelming a slow receiver. The receiver advertises a **receive window** (rwnd) in each ACK: "I have this much buffer space available, do not send more than this many bytes without waiting for an ACK."

If `rwnd` drops to zero, the sender stops and polls the receiver with 1-byte probes (persist timer) until the window opens.

**Implication for Go:** if your application is slow to read from a `net.Conn` (e.g., processing each read in a goroutine that does heavy computation), the receive buffer fills up, the window shrinks, and the sender slows down. Always read from connections promptly, decoupling reading from processing using channels or goroutines.

### TCP Congestion Control

Congestion control prevents the sender from overwhelming the *network* (as opposed to the receiver). The sender maintains a **congestion window** (cwnd), and the effective sending rate is `min(cwnd, rwnd)`.

**Slow Start:**
- Start with `cwnd = 1 MSS` (Maximum Segment Size, typically 1460 bytes)
- For each ACK received, `cwnd += 1 MSS` (exponential growth)
- Continue until `cwnd >= ssthresh` (slow start threshold, initially large)

**Congestion Avoidance:**
- Once `cwnd >= ssthresh`, grow linearly: `cwnd += 1 MSS per RTT`
- Continue until packet loss is detected

**Fast Retransmit:**
- Three duplicate ACKs (receiving ACK for the same sequence number three times) signals packet loss without waiting for a timeout
- Retransmit the missing segment immediately

**Fast Recovery:**
- After fast retransmit, set `ssthresh = cwnd / 2`, `cwnd = ssthresh + 3`
- Resume congestion avoidance rather than slow start

**Modern variants:** CUBIC (Linux default since 2.6.19), BBR (Google's Bottleneck Bandwidth and RTT algorithm, used in GCP and increasingly on the internet) improve on classic Reno by using bandwidth and RTT measurements rather than packet loss as the primary signal.

### TCP Nagle Algorithm and TCP_NODELAY

The Nagle algorithm (RFC 896, 1984) was designed to prevent the "small packet problem" on low-bandwidth networks. The rule: if there is unacknowledged data in flight, buffer any outgoing data until either (a) an ACK arrives or (b) the buffer reaches one MSS. This coalesces many small writes into fewer, larger packets.

**Problem:** In request-response protocols (HTTP, gRPC, Redis), Nagle interacts badly with delayed ACK (where the receiver delays sending an ACK for up to 40ms hoping to piggyback it on a response). The result: a 40ms forced delay on every request/response pair.

**Diagnosis:** You see consistent ~40ms latency spikes in your service even though processing takes <1ms.

**Solution:** Set `TCP_NODELAY` to disable Nagle.

```go
//go:build linux || darwin

package tcputil

import (
    "net"
    "syscall"
    "time"

    "golang.org/x/sys/unix"
)

// DialTCPWithNoDelay establishes a TCP connection with Nagle disabled.
// Use this for latency-sensitive connections to databases, caches, or APIs.
func DialTCPWithNoDelay(addr string, timeout time.Duration) (net.Conn, error) {
    dialer := &net.Dialer{
        Timeout: timeout,
        Control: func(network, address string, c syscall.RawConn) error {
            return c.Control(func(fd uintptr) {
                // TCP_NODELAY disables the Nagle algorithm.
                // This reduces latency at the cost of slightly higher packet count.
                _ = unix.SetsockoptInt(
                    int(fd),
                    unix.IPPROTO_TCP,
                    unix.TCP_NODELAY,
                    1,
                )
            })
        },
    }
    return dialer.Dial("tcp", addr)
}

// TCPServer creates a listener with TCP_NODELAY on all accepted connections.
// Note: Go's net/http already sets TCP_NODELAY on accepted connections
// via (*net.TCPConn).SetNoDelay(true) in the HTTP server internals.
// This is useful for raw TCP servers (gRPC without HTTP, custom protocols).
func AcceptWithNoDelay(l net.Listener) (net.Conn, error) {
    conn, err := l.Accept()
    if err != nil {
        return nil, err
    }
    if tc, ok := conn.(*net.TCPConn); ok {
        tc.SetNoDelay(true)
        tc.SetKeepAlive(true)
        tc.SetKeepAlivePeriod(30 * time.Second)
    }
    return conn, nil
}
```

**Go's net/http sets TCP_NODELAY automatically** on server-side connections. However, custom TCP servers and database drivers often do not - always verify.

### TCP Keepalive

TCP keepalive detects dead connections (where the remote end crashed or was disconnected without a proper FIN). After a period of inactivity, the OS sends keepalive probes. If no response after N probes, the connection is closed.

Default OS values are typically 2 hours idle before first probe, 75 seconds between probes, 9 probes before giving up - far too long for production services.

```go
package tcputil

import (
    "context"
    "fmt"
    "net"
    "time"
)

// ProperTCPServer demonstrates correct TCP server setup with production-grade keepalive.
func ProperTCPServer(addr string) error {
    lc := net.ListenConfig{
        KeepAlive: 30 * time.Second, // Send keepalive probes after 30s of inactivity
    }

    listener, err := lc.Listen(context.Background(), "tcp", addr)
    if err != nil {
        return fmt.Errorf("listen: %w", err)
    }
    defer listener.Close()

    for {
        conn, err := listener.Accept()
        if err != nil {
            return fmt.Errorf("accept: %w", err)
        }

        if tc, ok := conn.(*net.TCPConn); ok {
            tc.SetKeepAlive(true)
            tc.SetKeepAlivePeriod(30 * time.Second)
            // For fine-grained control (Linux only), use syscall to set:
            // TCP_KEEPIDLE  = 30 (seconds before first probe)
            // TCP_KEEPINTVL = 5  (seconds between probes)
            // TCP_KEEPCNT   = 3  (number of probes before giving up)
        }

        go handleConn(conn)
    }
}

func handleConn(conn net.Conn) {
    defer conn.Close()
}
```

---

### Junior → FAANG: TCP Concepts That Directly Affect Go Service Performance

The TCP concepts that have the most direct impact on Go service performance are: connection establishment cost (three-way handshake adds one round-trip time per new connection, which is why connection pooling matters), slow start (new connections start at a low congestion window and ramp up, producing high latency for bursty traffic), and TIME_WAIT state (closed connections remain in TIME_WAIT for 2*MSL, consuming port resources and potentially exhausting port space on high-connection-rate services).

For Go specifically, the `net.Dialer` with `KeepAlive` enabled sends TCP keep-alive probes on idle connections, detecting dead connections before they cause request failures. The default `http.Transport` has reasonable defaults but often needs tuning for production: `MaxIdleConnsPerHost` controls the connection pool size per host, and the default value (2) is almost always too low for any service making more than 2 concurrent requests to the same host.

First-job habit: always configure a custom `http.Transport` with appropriate connection pool settings for production Go services. Never use `http.DefaultTransport` or `http.DefaultClient` in production code.

### Senior @ FAANG: TCP at Scale and Network Architecture

At staff level, TCP behavior at scale produces emergent patterns that require architectural responses. The TIME_WAIT exhaustion problem (where a service making thousands of short-lived connections exhausts the ephemeral port range) is addressed by connection reuse (connection pooling), `SO_REUSEPORT` (allowing multiple sockets to bind to the same port for better load distribution), or switching to HTTP/2 (where multiplexing eliminates the need for many TCP connections).

The TCP congestion control algorithm choice (CUBIC is the default on Linux, BBR is increasingly common) has real performance implications for high-bandwidth connections over high-latency links. BBR's throughput-based algorithm significantly outperforms CUBIC on links with high bandwidth-delay products (like satellite links or intercontinental connections). The staff engineer who can evaluate congestion control algorithm changes with network performance benchmarks before recommending them is demonstrating the quantitative reasoning that characterizes L6/L7 networking expertise.

Kernel network parameter tuning (TCP buffer sizes, socket backlog, TIME_WAIT reclamation) is a system administration concern that affects all services on a shared host. Platform teams who manage shared compute infrastructure (EC2 instances, GKE nodes) should document the network parameter configuration and the rationale for each setting, so that performance anomalies can be traced to configuration differences rather than application bugs.
