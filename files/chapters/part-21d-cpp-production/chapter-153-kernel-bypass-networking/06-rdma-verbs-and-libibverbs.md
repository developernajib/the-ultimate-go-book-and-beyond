## RDMA Verbs: PD, MR, QP, CQ, and the libibverbs Programming Model

RDMA (Remote Direct Memory Access) is a different beast from DPDK or AF_XDP. Where those frameworks accelerate raw packet I/O, RDMA exposes a per-connection, memory-to-memory primitive: one machine reads or writes the memory of another machine without involving either machine's CPU. The NIC does the work. Latency for a one-sided RDMA read on a modern InfiniBand or RoCEv2 fabric is roughly 1.0 to 2.0 microseconds end to end, including bus, switch, and remote NIC. Bandwidth scales with the link, currently up to 400 Gbit/s per port on Nvidia ConnectX-7.

RDMA was born on InfiniBand. It now runs on Ethernet via RoCE v1 (limited adoption) and RoCE v2 (the dominant deployment, used by every cloud and most HFT firms). The userspace API is libibverbs, a C library that exposes verbs with names like `ibv_post_send`, `ibv_poll_cq`. Higher-level wrappers (UCX, Mellanox Messaging Accelerator, NCCL) build on it.

### The Verbs Object Model

RDMA programming feels strange the first time. There are no sockets. There is a graph of objects:

- **Device (`ibv_context`)**, a handle to a physical RDMA NIC (HCA), opened from a name like `mlx5_0`.
- **Protection Domain (`ibv_pd`)**, a security boundary. All MRs and QPs that work together must live in the same PD.
- **Memory Region (`ibv_mr`)**, a chunk of registered memory. Registration pins pages, gives the NIC IOMMU mappings, and returns local and remote keys (lkey, rkey).
- **Completion Queue (`ibv_cq`)**, a hardware queue where the NIC posts Work Completions (WCs) when work finishes.
- **Queue Pair (`ibv_qp`)**, a send queue plus a receive queue, with a connection state machine. The fundamental unit of RDMA communication.

A typical client setup posts an SQ work request, the WR's completion appears on the CQ, the application polls the CQ. There is no syscall on the data path.

### Connection Types

The connection type chosen for a QP determines the verbs you can use and the semantics:

- **RC (Reliable Connected).** Point-to-point, in-order, reliable. Supports SEND, RECV, RDMA_READ, RDMA_WRITE, ATOMIC. Used by FaRM, RAMCloud, eRPC's reliable mode, NCCL, MPI's default. Cost: one QP per peer pair. At 10000 peers, the QP table no longer fits in NIC cache and performance falls off a cliff.
- **UD (Unreliable Datagram).** Connectionless, like UDP. Supports SEND/RECV only. One QP can talk to any peer. Used for control plane, group membership, and protocols built on top (HERD, eRPC's UD mode).
- **UC (Unreliable Connected).** Connection-oriented, unreliable. Rarely used.
- **RD (Reliable Datagram).** Mostly extinct.
- **XRC (eXtended Reliable Connected).** Optimization on top of RC for shared receive contexts across peers, harder to use, more scalable.

For a senior interview, the most important answer is: "RC for one-sided primitives and small peer count, UD for one-to-many and large peer count, build a fallback or sharding strategy if you need both."

### Work Requests and Completions

Sending data:

```c
struct ibv_sge sge = { .addr=(uintptr_t)buf, .length=len, .lkey=mr->lkey };
struct ibv_send_wr wr = {
    .wr_id     = my_id,
    .next      = NULL,
    .sg_list   = &sge,
    .num_sge   = 1,
    .opcode    = IBV_WR_SEND,
    .send_flags= IBV_SEND_SIGNALED,
};
struct ibv_send_wr* bad;
ibv_post_send(qp, &wr, &bad);
```

The WR is queued in the SQ, the NIC reads it via DMA, executes it, and writes a completion to the CQ. To learn it finished, poll:

```c
struct ibv_wc wc;
int n = ibv_poll_cq(cq, 1, &wc);
if (n > 0 && wc.status != IBV_WC_SUCCESS) {
    fprintf(stderr, "wc failed: %s\n", ibv_wc_status_str(wc.status));
}
```

### SEND vs RDMA_WRITE vs RDMA_READ

Three opcodes, three very different semantics:

- **SEND/RECV (two-sided).** Sender posts SEND, receiver must have a matching RECV posted. Receiver's CPU is involved, gets a completion, knows new data arrived. This is the closest analogue to a TCP message.
- **RDMA_WRITE (one-sided).** Sender writes directly into a remote MR using a remote address and rkey learned out of band. Receiver's CPU is not involved at all. The receiver only learns data arrived if the sender does an immediate (`IBV_WR_RDMA_WRITE_WITH_IMM`) which posts a 32-bit value to the receiver's CQ.
- **RDMA_READ (one-sided).** Reader fetches from a remote MR. Same: zero remote CPU involvement.

One-sided primitives are the magic. They make RDMA dramatically faster than TCP for many workloads because the remote machine does no work whatsoever, but they require the remote application to expose memory layouts and handle concurrent mutation carefully (atomics, fences, versioning). FaRM (Microsoft Research, 2014) and HERD (CMU, 2014) are the classic examples.

### Inline Data and Signaling

Performance levers on the send path:

- **`IBV_SEND_INLINE`.** For small payloads (typically <= 256 bytes), the WR carries the data inline so the NIC does not need a second DMA fetch. Halves the latency for small messages.
- **`IBV_SEND_SIGNALED`.** Whether this WR generates a CQE on completion. Posting WRs unsignaled and signaling only every Nth saves CQ entries and polling cost. Be careful: completions are still required for flow control, since the SQ has finite capacity.

A typical RPC client might post 31 unsignaled WRs followed by a signaled one, polling the CQ for the signaled completion to learn that the previous 32 are also done.

### A Minimal RDMA C++ Client

The real production RDMA setup involves out-of-band connection establishment (TCP socket exchange of GIDs, QP numbers, MR addresses and rkeys) which is verbose. The skeleton below shows the data path only.

```cpp
#include <infiniband/verbs.h>
#include <cstring>
#include <cstdio>

struct RdmaCtx {
    ibv_context*    dev;
    ibv_pd*         pd;
    ibv_cq*         cq;
    ibv_qp*         qp;
    ibv_mr*         mr;
    void*           buf;
    size_t          buf_size;
};

static RdmaCtx open_rdma(const char* dev_name, size_t buf_size) {
    RdmaCtx c{};
    c.buf_size = buf_size;
    c.buf = aligned_alloc(4096, buf_size);
    std::memset(c.buf, 0, buf_size);

    int n;
    ibv_device** list = ibv_get_device_list(&n);
    ibv_device* dev = nullptr;
    for (int i = 0; i < n; i++)
        if (!std::strcmp(ibv_get_device_name(list[i]), dev_name)) dev = list[i];
    if (!dev) { fprintf(stderr, "device %s not found\n", dev_name); std::exit(1); }
    c.dev = ibv_open_device(dev);
    ibv_free_device_list(list);

    c.pd = ibv_alloc_pd(c.dev);
    c.mr = ibv_reg_mr(c.pd, c.buf, buf_size,
                      IBV_ACCESS_LOCAL_WRITE
                    | IBV_ACCESS_REMOTE_WRITE
                    | IBV_ACCESS_REMOTE_READ);
    c.cq = ibv_create_cq(c.dev, 256, nullptr, nullptr, 0);

    ibv_qp_init_attr qa{};
    qa.send_cq = c.cq;
    qa.recv_cq = c.cq;
    qa.cap.max_send_wr = 128;
    qa.cap.max_recv_wr = 128;
    qa.cap.max_send_sge = 1;
    qa.cap.max_recv_sge = 1;
    qa.cap.max_inline_data = 256;
    qa.qp_type = IBV_QPT_RC;
    c.qp = ibv_create_qp(c.pd, &qa);

    // ... transition QP through INIT -> RTR -> RTS using out-of-band exchange
    return c;
}

static void post_rdma_write(RdmaCtx& c,
                            uint64_t local_addr, uint32_t lkey,
                            uint64_t remote_addr, uint32_t rkey,
                            uint32_t len, bool signaled) {
    ibv_sge sge{ .addr = local_addr, .length = len, .lkey = lkey };
    ibv_send_wr wr{};
    wr.wr_id  = uint64_t(remote_addr);
    wr.sg_list = &sge;
    wr.num_sge = 1;
    wr.opcode  = IBV_WR_RDMA_WRITE;
    wr.send_flags = (signaled ? IBV_SEND_SIGNALED : 0u)
                  | (len <= 256 ? IBV_SEND_INLINE : 0u);
    wr.wr.rdma.remote_addr = remote_addr;
    wr.wr.rdma.rkey        = rkey;

    ibv_send_wr* bad = nullptr;
    int rc = ibv_post_send(c.qp, &wr, &bad);
    if (rc) { perror("ibv_post_send"); std::exit(1); }
}

static void poll_one(RdmaCtx& c) {
    ibv_wc wc;
    while (true) {
        int n = ibv_poll_cq(c.cq, 1, &wc);
        if (n < 0) { perror("poll_cq"); std::exit(1); }
        if (n == 0) continue;        // busy poll
        if (wc.status != IBV_WC_SUCCESS) {
            fprintf(stderr, "wc bad: %s op=%d\n",
                ibv_wc_status_str(wc.status), wc.opcode);
            std::exit(1);
        }
        return;
    }
}
```

Build:

```bash
g++ -O3 -std=c++20 rdma_client.cpp -o rdma_client -libverbs
```

### QP State Machine

A new QP is in state `RESET`. To use it, you transition through `INIT` (set port, pkey), `RTR` (Ready to Receive, set remote QP number, GID/LID, MTU, PSN), `RTS` (Ready to Send, set timeout, retry counts, max RD/atomic). Each transition is a `ibv_modify_qp` call with a different mask. Get one wrong and the QP enters error state on first WR, with a generic "transport error" that takes hours to debug.

The exchange of GID, LID, QPN, PSN, MR address, and rkey happens out of band, typically over TCP. The library `librdmacm` provides a connection-manager that handles this for you and is the recommended path, raw verbs are for very specific high-performance setups.

### Congestion Control: DCQCN, TIMELY, HPCC

RoCEv2 over Ethernet does not have a congestion control protocol baked in the way TCP does. Lossy switching of RDMA destroys throughput because go-back-N is brutal at line rate. Two production approaches:

- **DCQCN (Microsoft, 2015).** ECN-based. Switches mark packets on queue buildup, receiver sends CNPs (Congestion Notification Packets), sender backs off. Standard on most cloud RoCE deployments. Requires PFC (priority flow control) on the switches to get lossless behavior.
- **TIMELY (Google, 2015).** RTT-based. Measures RTT in software and reacts. More fragile but does not need PFC.
- **HPCC (Alibaba, 2019).** In-network telemetry (INT) tells the sender exactly how much to slow down. Requires programmable switches.

For a real RoCE deployment you need DSCP-based traffic class, PFC enabled on the relevant priority, ECN marking thresholds tuned (the Microsoft "DCB on Mellanox SN2000 series" guide is the standard reference), and headroom management. Get this wrong and you get either packet drops (if PFC is off) or PFC storms / pause frames flooding the fabric (if PFC thresholds are off). RDMA at 100 Gbit is a network engineering project, not just a software project.

### Common Failure Modes

- **`IBV_WC_RETRY_EXC_ERR`.** Sender retried the maximum number of times without ACK. Means the remote QP is dead, GID is wrong, or the path is broken.
- **`IBV_WC_RNR_RETRY_EXC_ERR`.** Receiver Not Ready. Sender posted SEND but remote had no RECV posted in time.
- **`IBV_WC_REM_ACCESS_ERR`.** Remote rkey did not match, address out of MR range, or access flags wrong.
- **Performance falling off after 8K connections.** QP context cache exhausted on the NIC. Mellanox CX-6 has a few thousand QP cache slots, beyond that, memory translation table walks happen on every WR.

> Junior engineer pitfall: writing RDMA code that works on the bench and immediately fails in production because PFC is not configured on the switch path.
> Senior FAANG move: validate the lossless RoCE configuration end to end with `ibstat`, `mlxlink`, switch buffer counters (`show queue-monitoring` on Mellanox SN switches), and a sustained throughput test, before integrating with the application code.
