## TCP Tuning, TCP_NODELAY, and the 40 ms Problem

TCP is a contract between the kernel and the application that hides packetization, ordering, and congestion. That contract has knobs. At FAANG scale you turn the knobs deliberately, in junior code you leave them at defaults and pay 40 ms tail latencies you cannot explain. This chapter is about the knobs.

### 1. Nagle's algorithm vs Delayed-ACK -- the 40 ms problem

Nagle's algorithm (RFC 896, 1984) coalesces small writes: if there is unacked data in flight, hold the next small write until either the ack arrives or a full MSS accumulates. Delayed-ACK (RFC 1122) holds acks for up to 500 ms (Linux: 40 ms by default, `TCP_DELACK_MIN`) hoping to piggyback on outgoing data.

Combine the two on a request/response protocol with small writes and you get the canonical pathology:

1. Client sends partial request (small write 1).
2. Server delayed-ACKs (waits for response to piggyback).
3. Client wants to send small write 2 but Nagle blocks it (unacked data in flight).
4. Server's delayed-ACK timer fires after 40 ms, ack returns.
5. Client finally sends write 2.

40 ms artificial latency, on every request. This is the bug that has been re-discovered in every gRPC / Thrift / database driver since 1990. The fix is `TCP_NODELAY=1`: disable Nagle.

```cpp
int one = 1;
setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
```

Set it on every TCP socket in a latency-sensitive path (RPC clients/servers, databases, caches). Nagle made sense for telnet on 1200-baud modems, it does not make sense for a gRPC call between two pods on the same NIC.

> Junior -> FAANG: Do not enable `TCP_CORK` to "fix" Nagle. CORK is the opposite -- it forces buffering. NODELAY disables Nagle. They are mutually exclusive (kernel rejects both at once on the same socket since 2.5.71).

### 2. TCP_QUICKACK -- the other half

`TCP_QUICKACK` tells the kernel to ack immediately for the next few segments instead of running delayed-ACK. It is **not sticky**, the kernel resets it after each ack. To keep quick-ack on, you re-set it on every recv. Most production code does not bother and just relies on `TCP_NODELAY` on the sender. Use `TCP_QUICKACK` when:

- You must remain compatible with a peer that has Nagle on and you cannot fix the peer.
- You are debugging a 40 ms stall and want to confirm delayed-ACK is the cause (set it, see if the stall vanishes).

### 3. TCP_CORK -- batching writes deliberately

`TCP_CORK` (or BSD's `TCP_NOPUSH`) prevents the kernel from sending partial segments. Useful when assembling a response from multiple writes (HTTP headers + body, sendfile preceded by a write). The pattern is:

```cpp
int on = 1, off = 0;
setsockopt(fd, IPPROTO_TCP, TCP_CORK, &on, sizeof(on));
::write(fd, headers, hlen);
::sendfile(fd, file_fd, &off_t, body_len);
setsockopt(fd, IPPROTO_TCP, TCP_CORK, &off, sizeof(off));   // flush
```

Without CORK, the headers might fly out as a small segment before the body. With CORK, you get a single full segment. nginx uses CORK around `sendfile`. The 200 ms safety timer (Linux flushes a corked socket eventually) means you cannot leave it on indefinitely.

### 4. TCP_NOTSENT_LOWAT -- bufferbloat in your application

`TCP_NOTSENT_LOWAT` (Linux 3.12, commit `c9bee3b7fdec`) sets the threshold of "not yet sent" bytes in the kernel send buffer below which the socket reports writable. Default is `INT_MAX` (writable as long as buffer has any room), which means you can stuff megabytes into the kernel and starve other connections of memory. Set it to a small value (16-128 KiB) to keep epoll's `EPOLLOUT` honest.

```cpp
int lowat = 64 * 1024;
setsockopt(fd, IPPROTO_TCP, TCP_NOTSENT_LOWAT, &lowat, sizeof(lowat));
```

This is the option that fixed YouTube's interactive-video bufferbloat problem in 2013 (see Eric Dumazet's commit message). Use it on long-lived streaming connections (gRPC bidi, WebSocket, video).

### 5. Send/receive buffer tuning

Default Linux autotuning (since 2.6.17) chooses buffer sizes via `net.ipv4.tcp_rmem` / `tcp_wmem` (min, default, max). You can override per-socket with `SO_RCVBUF` / `SO_SNDBUF`, but doing so **disables autotuning** on that socket. Almost always wrong.

```bash
# sysctl tuning for high-BDP links (10 GbE * 50 ms RTT = 60 MiB BDP)
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728
net.ipv4.tcp_rmem = 4096 87380 67108864
net.ipv4.tcp_wmem = 4096 65536 67108864
net.ipv4.tcp_mem  = 786432 1048576 1572864
```

If you must override (rare, specialized protocols, RDMA-style apps), set the buffer **before** `listen()` for listen sockets so accepted children inherit it. If you set it after `accept()`, autotuning is already off and you keep the default.

The receive buffer also caps the advertised TCP window. Too small a `rmem_max` => you cannot get past 64 KiB window without window scaling, and you stall on long fat pipes. Always confirm `net.ipv4.tcp_window_scaling = 1` (default since forever).

### 6. Listen backlog

`listen(fd, backlog)` is *advisory*. The kernel caps it at `net.core.somaxconn` (default 4096 since Linux 5.4, was 128 for two decades and bit everyone). The backlog is split:

- SYN queue: half-open connections, sized by `tcp_max_syn_backlog`.
- Accept queue: established but not yet `accept()`-ed. Overflow drops the connection (or sends RST if `tcp_abort_on_overflow=1`).

```bash
# raise both
sysctl -w net.core.somaxconn=65535
sysctl -w net.ipv4.tcp_max_syn_backlog=65535
```

Then in code:

```cpp
::listen(fd, 65535);
```

If the application cannot keep up with `accept()`, the accept queue fills, SYN-ACKs are silently dropped, and clients see "connection timed out" rather than "connection refused". Monitor `LISTEN_OVERFLOWS` from `/proc/net/netstat` (column `ListenOverflows`).

### 7. Congestion control: BBR vs CUBIC

CUBIC (Linux default since 2.6.19) reacts to packet loss as the signal. On lossy WAN links and shallow router buffers, CUBIC is conservative, on deep-buffered "bufferbloat" paths it overshoots and contributes to bufferbloat itself.

BBR (Google, Linux 4.9, `net/ipv4/tcp_bbr.c`) models the bottleneck bandwidth and round-trip propagation time, paces packets accordingly, and ignores loss as a primary signal. Enable globally:

```bash
echo bbr > /proc/sys/net/ipv4/tcp_congestion_control
echo fq  > /proc/sys/net/core/default_qdisc        # BBR requires fq pacing
```

Per-socket override (less common):

```cpp
const char cc[] = "bbr";
setsockopt(fd, IPPROTO_TCP, TCP_CONGESTION, cc, sizeof(cc) - 1);
```

BBRv2 (Google internal) and BBRv3 (Linux 6.4+, opt-in) further fix fairness against CUBIC. For a public-internet edge, BBR is usually a 5-15% throughput win on lossy links. For an internal datacenter network with negligible loss, CUBIC and BBR are roughly equivalent, pick BBR for consistency.

### 8. TCP keepalive

Default keepalive does nothing for two hours (`tcp_keepalive_time = 7200`). Useful keepalives are application-level (HTTP/2 PING, gRPC keepalive). If you must use TCP keepalive (idle databases, internal long-lived TCP), tune per-socket:

```cpp
int on = 1;
setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &on, sizeof(on));
int idle = 30;     // seconds before first probe
int intvl = 10;    // between probes
int cnt = 3;       // probes before declared dead
setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE,  &idle,  sizeof(idle));
setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL, &intvl, sizeof(intvl));
setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT,   &cnt,   sizeof(cnt));
```

Total time to detect dead peer: `idle + intvl * cnt = 60 s`. Default would be 7200 + 75*9 = ~2h15m. Clients hate that.

### 9. TCP_USER_TIMEOUT -- the bound that actually matters

`TCP_USER_TIMEOUT` (RFC 5482, Linux 2.6.37) bounds the time the kernel will retransmit before declaring the connection dead, regardless of keepalive. Set it slightly above your application timeout so kernel-level retries do not extend beyond your SLA.

```cpp
unsigned int ms = 30000;        // 30 s
setsockopt(fd, IPPROTO_TCP, TCP_USER_TIMEOUT, &ms, sizeof(ms));
```

Without this, a half-closed peer can keep your connection alive for 15+ minutes through retransmissions (`tcp_retries2 = 15`). For RPC clients, set `TCP_USER_TIMEOUT` to your end-to-end deadline.

### 10. TIME_WAIT and connection churn

Each closed connection sits in TIME_WAIT for 2*MSL (60 s on Linux, hard-coded in `TCP_TIMEWAIT_LEN`). High-churn services (short-lived HTTP/1.0 with `Connection: close`) blow through ephemeral ports.

- `net.ipv4.ip_local_port_range = 1024 65535` (default 32768-60999).
- `net.ipv4.tcp_tw_reuse = 1` -- reuse TIME_WAIT sockets for new outgoing connections (safe, RFC 6191).
- Do **not** enable `tcp_tw_recycle`, it was removed in Linux 4.12 because it breaks NATed clients.
- Better fix: HTTP keepalive / connection pooling. Avoid the churn entirely.

### 11. Sample tuning checklist for a new service

```cpp
struct TuneTcpSocket {
  void operator()(int fd) const {
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));

    int lowat = 64 * 1024;
    setsockopt(fd, IPPROTO_TCP, TCP_NOTSENT_LOWAT, &lowat, sizeof(lowat));

    unsigned ut = 30000;
    setsockopt(fd, IPPROTO_TCP, TCP_USER_TIMEOUT, &ut, sizeof(ut));

    setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &one, sizeof(one));
    int idle = 30, intvl = 10, cnt = 3;
    setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE,  &idle,  sizeof(idle));
    setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL, &intvl, sizeof(intvl));
    setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT,   &cnt,   sizeof(cnt));
  }
};
```

Apply to every accepted socket in your `Listener::on_accept`. Pair with the sysctl block from section 5 in `/etc/sysctl.d/99-tcp-tuning.conf`.

### 12. macOS/BSD differences

- No `TCP_NOTSENT_LOWAT` on macOS until 10.10, on FreeBSD it exists with the same semantics.
- `TCP_USER_TIMEOUT` does not exist on BSD, use `TCP_KEEPALIVE` (single-value seconds) instead.
- BSD's `TCP_NOPUSH` ~ Linux's `TCP_CORK` but the flush behavior differs (BSD flushes on disable. Linux flushes opportunistically).
- BBR is Linux-only.

> Senior @ FAANG: every L7 RPC lib at scale ships its own socket-tuning hook. Make yours a first-class object, log every option you set on every connection, and feature-flag changes -- the moment one team enables `TCP_NODELAY` for the wrong reason, regressions land in places you do not expect.

