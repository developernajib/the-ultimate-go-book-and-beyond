## 1. TCP/IP Deep Dive

### The Three-Way Handshake

Every TCP connection begins with a handshake. The client sends a SYN segment with an initial sequence number (ISN). The server responds with SYN-ACK, acknowledging the client's ISN and providing its own. The client completes the handshake with an ACK.

```
Client                          Server
  |  ---- SYN (seq=x) -------->  |
  |  <--- SYN-ACK (seq=y, ack=x+1) --- |
  |  ---- ACK (seq=x+1, ack=y+1) ----> |
  |        Connection Established       |
```

In C++, this is hidden behind `connect()` and `accept()`, but understanding it matters for diagnosing latency. Each handshake adds one round-trip time (RTT) before any data flows.

```cpp
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <cstring>
#include <iostream>

// Server: listen and accept connections
int create_tcp_server(uint16_t port) {
    int server_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd < 0) {
        perror("socket");
        return -1;
    }

    // Allow address reuse - avoids TIME_WAIT issues during development
    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(port);

    if (bind(server_fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        perror("bind");
        close(server_fd);
        return -1;
    }

    // backlog of 128 - the kernel queues SYN_RECV connections here
    if (listen(server_fd, 128) < 0) {
        perror("listen");
        close(server_fd);
        return -1;
    }

    return server_fd;
}
```

The `listen()` backlog parameter controls how many connections can complete the handshake before `accept()` is called. If the backlog overflows, the kernel silently drops SYN packets, the client retransmits, sees increasing latency, and eventually times out.

### Congestion Control: Cubic and BBR

TCP's congestion control determines how fast data flows. Two dominant algorithms shape modern networks.

**Cubic** is the default on Linux. It uses a cubic function to grow the congestion window (cwnd) after a loss event. The window grows slowly near the previous maximum, then accelerates as it moves away. This produces the characteristic cubic curve that gives the algorithm its name. Cubic is loss-based: it interprets packet loss as a signal of congestion.

**BBR** (Bottleneck Bandwidth and Round-trip propagation time), developed by Google, takes a fundamentally different approach. Instead of reacting to loss, BBR actively probes for the bottleneck bandwidth and minimum RTT, then paces packets to match the network's capacity. BBR achieves significantly higher throughput on lossy networks (like intercontinental links) where Cubic would throttle aggressively.

```cpp
// Enable BBR congestion control on a socket (Linux 4.9+)
void enable_bbr(int sockfd) {
    const char* congestion = "bbr";
    if (setsockopt(sockfd, IPPROTO_TCP, TCP_CONGESTION,
                   congestion, strlen(congestion)) < 0) {
        perror("setsockopt TCP_CONGESTION");
    }
}

// Query current congestion control algorithm
void print_congestion_algo(int sockfd) {
    char algo[16]{};
    socklen_t len = sizeof(algo);
    getsockopt(sockfd, IPPROTO_TCP, TCP_CONGESTION, algo, &len);
    std::cout << "Congestion control: " << algo << "\n";
}
```

### Nagle's Algorithm and TCP_NODELAY

Nagle's algorithm buffers small writes and coalesces them into larger segments to reduce overhead from tiny packets. For bulk transfers, this is efficient. For interactive or latency-sensitive protocols, it creates delays, a small write waits for an ACK before being sent, adding up to one RTT of latency.

The interaction between Nagle's algorithm and delayed ACKs is particularly insidious. Delayed ACKs wait up to 200ms before acknowledging a segment (hoping to piggyback the ACK on a data response). Combined with Nagle, you get: small write → wait for ACK → delayed ACK fires after 200ms → finally send next segment. This 200ms stall is the classic "Nagle + delayed ACK" problem.

```cpp
// Disable Nagle's algorithm for latency-sensitive connections
void disable_nagle(int sockfd) {
    int flag = 1;
    if (setsockopt(sockfd, IPPROTO_TCP, TCP_NODELAY, &flag, sizeof(flag)) < 0) {
        perror("setsockopt TCP_NODELAY");
    }
}

// For high-throughput bulk transfers, keep Nagle enabled (default)
// and use large write buffers to minimize syscall overhead.
void set_send_buffer(int sockfd, int size) {
    setsockopt(sockfd, SOL_SOCKET, SO_SNDBUF, &size, sizeof(size));
}
```

**Rule of thumb**: Disable Nagle (`TCP_NODELAY`) for RPC protocols, game servers, and any request-response pattern. Leave it enabled for bulk streaming where throughput matters more than per-message latency.

---
