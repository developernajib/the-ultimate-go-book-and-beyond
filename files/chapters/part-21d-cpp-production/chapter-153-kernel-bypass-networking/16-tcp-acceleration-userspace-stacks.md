## Userspace TCP Stacks: mTCP, F-Stack, Seastar, VPP, lwIP

DPDK and AF_XDP give you raw packets. Most applications need TCP. Bridging the gap is a userspace TCP stack: a library or framework that runs the TCP state machine in your process, on top of a packet-level transport. This chapter surveys the major userspace stacks, their design tradeoffs, and when to choose each.

### mTCP

mTCP (KAIST, 2014) was the first widely-used DPDK-based userspace TCP. The architecture: each application thread is paired with an mTCP I/O thread, they communicate via a per-thread API queue. The application calls `mtcp_socket`, `mtcp_connect`, `mtcp_recv`, etc., which are similar in shape to BSD sockets but operate on mTCP's state.

Strengths: simple, correct, well-studied in the academic literature. Throughput is good (10x kernel TCP for small connections).

Weaknesses: development has slowed since 2018. Limited TCP feature set (no ECN, weak congestion control, no TLS integration). The thread model is awkward for modern coroutine-based C++.

For a green-field 2025-era project, mTCP is rarely the right choice unless you specifically need its model.

### F-Stack

F-Stack (Tencent, 2017) takes a different approach: it ports the FreeBSD TCP/IP stack onto DPDK. You get a battle-tested TCP implementation (FreeBSD's stack is the gold standard for correctness) with kernel-bypass performance. The API is BSD-socket-compatible via a shim, so existing code can be linked against F-Stack with minimal changes.

Strengths: full FreeBSD TCP correctness (BBR, ECN, RACK, all the modern features). Real production deployment at Tencent scale (CDN, gaming).

Weaknesses: heavyweight. The compiled F-Stack library is large. The model is "one process per core, each running its own FreeBSD stack instance", cross-core communication requires the F-Stack API rather than just shared memory. TLS integration is the user's problem.

F-Stack is a good fit when you have an existing socket-based application that needs 10-50x more throughput and you do not want to rewrite the application.

### Seastar (ScyllaDB)

Seastar is the framework behind ScyllaDB. It is more than a TCP stack, it is a complete shared-nothing C++ framework with:

- A future/promise-based async model.
- A polling reactor per core, no shared state, message-passing across cores.
- A userspace TCP stack on top of DPDK.
- A custom memory allocator, file I/O via aio/io_uring, RPC framework.

Writing Seastar code feels different from regular C++ async: every operation returns a `seastar::future<T>`, you `.then()` and `.handle_exception()`, and you never call blocking syscalls. The reactor pattern is strict: a misbehaving handler that blocks for milliseconds stalls the whole core.

Strengths: exceptional single-machine throughput. ScyllaDB hits 1M ops/sec/core on 24-core boxes. The framework is mature, the TCP stack is correct. Memory-safety conventions are strong.

Weaknesses: opinionated framework, steep learning curve, large rewrite cost from existing code. Co-existence with non-Seastar libraries is hard because every blocking call must be marshalled through the reactor.

Choose Seastar when you are building a new high-performance server from scratch and willing to commit to its idioms. ScyllaDB, Redpanda (Kafka-compatible), and a number of internal hyperscaler projects use it.

### VPP (Vector Packet Processing)

VPP (FD.io, originated at Cisco) is not a TCP stack in the traditional sense, it is a framework for "vector" packet processing where you pass arrays of packets through a graph of nodes. Each node operates on a batch (typically 256 packets) for cache-warming benefit. VPP includes a TCP stack as a node, plus L2/L3 forwarding, NAT, IPSec, and dozens of other features.

VPP is the choice for building L3-L4 middleboxes (routers, NATs, tunnel endpoints) at high pps. It is overkill for a server-side TCP stack.

### lwIP

lwIP (lightweight IP) is the canonical embedded TCP/IP stack, originally designed for microcontrollers. It is also useful in userspace as the TCP stack layer for very small kernel-bypass setups: you bring up a DPDK port, hand received packets to lwIP, lwIP runs TCP and exposes a callback-based or socket-emulating API.

Strengths: tiny, well-understood, correct. Easy to embed.

Weaknesses: not designed for high pps. Missing modern TCP features. Single-threaded by default.

Use lwIP for testing, prototyping, or for the rare deployment that needs a single TCP connection over a kernel-bypass NIC and no more.

### Custom Stacks at FAANG

Most hyperscalers have their own internal userspace TCP stack:

- **Google Pony Express / Snap.** Custom userspace transport, used internally for many RPC paths. Combines QUIC-style features with kernel-bypass.
- **Meta DGRAM and netcastle.** Internal kernel-bypass transports for service-mesh and ML training fabric.
- **Cloudflare quiche + custom UDP path.** Their HTTP/3 stack runs on a heavily-tuned UDP path, not always on bypass but with similar engineering investment.
- **Microsoft msquic.** Open-source QUIC with userspace optimization (covered in chapter 17).

The pattern: hyperscalers initially port FreeBSD's stack (F-Stack-style), then iterate to a custom stack as workload-specific optimizations accumulate.

### When NOT To Use a Userspace TCP Stack

For most workloads, kernel TCP plus io_uring plus AF_XDP is enough. Modern Linux TCP with BBR has very competitive throughput. Userspace TCP wins when:

- Aggregate connection count is in the millions, kernel socket overhead dominates.
- Tail latency requirements are submillisecond.
- You need to terminate or originate at line rate of 100+ Gbit per host.

For most other cases, the engineering cost is not justified.

### A Minimal Userspace TCP Send Path

To illustrate what a userspace stack actually does, the send path for an established connection in pseudo-code:

```cpp
class Connection {
    State state_;
    uint32_t snd_una_;       // first unacked seq
    uint32_t snd_nxt_;       // next seq to send
    uint32_t snd_wnd_;       // peer's advertised receive window
    uint32_t cwnd_;          // congestion window
    RetransmitQueue rxq_;    // buffered for retransmit
    PacingClock pace_;
public:
    int send(const uint8_t* buf, size_t len) {
        if (state_ != ESTABLISHED) return -EPIPE;
        size_t in_flight = snd_nxt_ - snd_una_;
        size_t can_send  = std::min(snd_wnd_, cwnd_) - in_flight;
        size_t to_send   = std::min(len, can_send);
        if (to_send == 0) { /* enqueue, return EAGAIN */ }

        // Slice into MSS chunks, build TCP segments
        for (size_t off = 0; off < to_send; off += MSS) {
            const size_t seg_len = std::min<size_t>(MSS, to_send - off);
            auto* m = build_tcp_segment(buf + off, seg_len, snd_nxt_);
            rxq_.add(snd_nxt_, m);                    // for possible retransmit
            tx_port_.submit(m);                       // hand to NIC
            snd_nxt_ += seg_len;
        }
        return int(to_send);
    }
    void on_ack(uint32_t ack, uint16_t wnd) {
        rxq_.cumulative_ack(ack);
        snd_una_ = ack;
        snd_wnd_ = wnd;
        cong_ctrl_.on_ack(ack);
        cwnd_ = cong_ctrl_.cwnd();
    }
    void on_rto() {
        cong_ctrl_.on_rto();
        cwnd_ = cong_ctrl_.cwnd();
        rxq_.retransmit_oldest(tx_port_);
    }
};
```

Real TCP is far more complex (SACK, fast retransmit, RACK, F-RTO, ECN, loss probes), but the skeleton shows where userspace fits: the same logic the kernel runs, just in your address space, with no syscalls.

### Choosing a Stack

```
Workload                                  Pick
--------                                  ----
Hyperscale TCP server, building new       Seastar (or custom)
Existing socket app, 10x speed-up        F-Stack
L3/L4 middlebox, complex packet logic    VPP
Embedded or single-connection            lwIP
Research / academic                      mTCP
HFT TCP order entry                      OpenOnload (chapter 08) or ef_vi+lwIP
```

> Junior engineer pitfall: writing a userspace TCP stack from scratch.
> Senior FAANG move: choosing the right existing stack, validating its correctness with real packet-loss and reordering scenarios, and integrating it into the application's threading model rather than fighting it.
