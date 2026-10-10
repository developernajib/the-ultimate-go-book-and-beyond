## RDMA Application Patterns: KV Stores, RPC, One-Sided vs Two-Sided

Knowing the verbs is one thing. Knowing what to build with them is another. The RDMA research literature spent the 2014 to 2020 period working out the patterns. This chapter covers the canonical designs: FaRM, RAMCloud, HERD, eRPC, and what their conclusions imply for a production C++ RDMA client.

### One-Sided vs Two-Sided: The Argument

The first instinct of anyone learning RDMA is "wow, RDMA_READ lets me grab data without bothering the remote CPU, so I should build everything one-sided." This is roughly half right. The argument has two sides.

**Pro one-sided (RDMA_READ/WRITE):**
- Zero remote CPU. The NIC does the work.
- Lowest latency for simple lookups (1.5us round trip on InfiniBand).
- Receiver scales independently of how many concurrent reads it serves.

**Pro two-sided (SEND/RECV):**
- The receiver gets to validate, transform, and serialize. With one-sided, you expose a memory layout, which is brittle.
- Concurrent updates are easier (the receiver serializes them).
- One QP supports unlimited types of operations. With one-sided, every operation requires a memory layout decision.
- HERD measured that two-sided UD outperforms one-sided RDMA_READ on many workloads because UD avoids the connection-state cost of RC.

The community converged on: **use one-sided when the data is read-mostly, fits a simple structure, and concurrent mutation can be handled with versioning. Use two-sided for everything else.** This is the FaRM/HERD/eRPC consensus.

### FaRM: One-Sided RDMA + Hopscotch Hashing

FaRM (Microsoft Research, NSDI 2014) was the first influential RDMA KV store. The design:

- Each server exposes its hash table as a registered MR.
- Clients learn the rkey and base address out of band.
- A GET is a single RDMA_READ of the bucket (and overflow buckets) that the key hashes to.
- Inserts and updates are done via a transactional protocol with version numbers, clients RDMA_READ to verify the version did not change between read and commit.

The hash table is laid out so that one cache-line read fetches the most likely buckets. The key insight: at 1us network latency, the application is paying for round trips, not bandwidth. Doing one extra RDMA_READ per GET costs more than reading 1KB instead of 64 bytes in the same trip.

### RAMCloud: Distinguishing the Latency Floor

RAMCloud (Stanford, started 2009) targeted 5-10 microsecond GET latencies and showed that the RDMA path on InfiniBand was 80% spent in the network stack and 20% in the application. The lesson: at this latency floor, every memcpy and every cache miss matters. RAMCloud uses a log-structured memory allocator to keep the hot working set in cache and avoids any malloc on the data path.

### HERD: Two-Sided UD Wins

HERD (CMU, SIGCOMM 2014) made a shocking claim: two-sided UD with optimized polling outperforms one-sided RC on KV workloads. The mechanism: HERD uses RC inbound (clients RDMA_WRITE their request to a server-side ring buffer) and UD outbound (server SENDs the response). This combines the lowest-latency request mode (one-sided write, no remote CPU on receive) with the most scalable reply mode (UD, one QP for unlimited clients).

Lesson: the right primitive depends on direction and scaling axis. Pure one-sided or pure two-sided are both wrong.

### eRPC: A General-Purpose RDMA RPC

eRPC (Carnegie Mellon, NSDI 2019) built a general RPC system over UD verbs and showed it could match raw RDMA_READ latency for typical RPC sizes while supporting arbitrary user logic on the server. The design highlights:

- UD only, one QP per server thread, all clients share it.
- Per-session sequence numbers in software for reliable-mode (since UD is unreliable).
- Flow control via session credits.
- Coroutine-based server handlers that yield while waiting on response from another machine.

eRPC's measurement: 850 ns one-way latency for small RPCs on Mellanox CX-5 InfiniBand. That is comparable to one-sided RDMA_READ and you get the full RPC abstraction.

For a production C++ system today, **start from eRPC's model**: UD-based, software-reliable, coroutine-friendly. Move to one-sided RDMA_READ only for specific data structures where the access pattern is read-mostly and the layout is stable.

### Building a Production RDMA Client in C++

The shape of a real client (the boilerplate of context setup, device open, PD/MR/CQ/QP, omitted for brevity, see chapter 06):

```cpp
#include <infiniband/verbs.h>
#include <atomic>
#include <coroutine>
#include <vector>

struct RpcSession {
    ibv_qp*  qp;
    uint32_t remote_rkey;
    uint64_t remote_ring_addr;
    uint32_t ring_size;

    std::atomic<uint32_t> head{0};   // local view of remote ring head
    std::atomic<uint32_t> tail{0};   // remote ring tail (advanced by remote)

    // Pre-allocated WR pool to avoid malloc on hot path
    struct WrSlot {
        ibv_send_wr wr;
        ibv_sge     sge;
        uint64_t    submit_ns;
        bool        in_flight;
    };
    std::vector<WrSlot> wr_pool;
};

class RdmaRpcClient {
public:
    RdmaRpcClient(RdmaCtx& ctx, RpcSession& s) : ctx_(ctx), s_(s) {}

    // Post a request via one-sided WRITE into the remote ring.
    // Caller passes a pre-encoded buffer - we do not malloc.
    uint64_t post_request(const void* req, uint32_t len) {
        const uint32_t pos = s_.head.fetch_add(1, std::memory_order_relaxed);
        const uint32_t slot = pos % s_.wr_pool.size();
        auto& w = s_.wr_pool[slot];
        if (w.in_flight) {
            // Backpressure: wait for completion to free the slot
            drain_completions(/*at_least=*/1);
        }

        w.sge.addr   = uintptr_t(req);
        w.sge.length = len;
        w.sge.lkey   = ctx_.mr->lkey;

        std::memset(&w.wr, 0, sizeof(w.wr));
        w.wr.wr_id   = pos;
        w.wr.sg_list = &w.sge;
        w.wr.num_sge = 1;
        w.wr.opcode  = IBV_WR_RDMA_WRITE_WITH_IMM;
        w.wr.imm_data = htobe32(pos);    // tells remote which slot
        w.wr.send_flags = IBV_SEND_SIGNALED
                       | (len <= 256 ? IBV_SEND_INLINE : 0u);

        const uint64_t off = (pos % s_.ring_size) * MSG_SLOT_BYTES;
        w.wr.wr.rdma.remote_addr = s_.remote_ring_addr + off;
        w.wr.wr.rdma.rkey        = s_.remote_rkey;

        ibv_send_wr* bad = nullptr;
        if (ibv_post_send(s_.qp, &w.wr, &bad) != 0) {
            perror("post_send");
            std::abort();
        }
        w.in_flight = true;
        w.submit_ns = now_ns();
        return pos;
    }

    void drain_completions(uint32_t at_least) {
        ibv_wc wcs[16];
        uint32_t got = 0;
        while (got < at_least) {
            int n = ibv_poll_cq(ctx_.cq, 16, wcs);
            if (n < 0) std::abort();
            for (int i = 0; i < n; i++) {
                const uint64_t pos = wcs[i].wr_id;
                const uint32_t slot = pos % s_.wr_pool.size();
                s_.wr_pool[slot].in_flight = false;
                if (wcs[i].status != IBV_WC_SUCCESS) {
                    handle_error(wcs[i]);
                }
            }
            got += n;
        }
    }

private:
    RdmaCtx&    ctx_;
    RpcSession& s_;
};
```

Notes on what is happening:

1. **No malloc on the hot path.** WR slots, SGEs, and even the request buffer are pre-allocated. RDMA latency wins are erased by a single page fault.
2. **Inline data for small messages.** Sub-256-byte requests skip a DMA fetch.
3. **Signaled completions every WR for now.** A production client would coalesce: signal every 16th, save CQE bandwidth.
4. **Backpressure via slot reuse.** If you would overwrite an in-flight slot, drain completions first. This is your flow control.
5. **`WRITE_WITH_IMM`.** The 32-bit immediate field carries the slot index so the remote can dispatch.

### Fairness and Head-of-Line Blocking

A subtle production hazard: under RC, a single slow client (one whose acks come back slowly because of network latency or remote CPU pressure) can fill the SQ and stall all subsequent WRs. eRPC's UD-with-software-credits avoids this, one client cannot starve another because each session has independent credits.

If you must use RC, give each client its own QP (which limits scaling) or use XRC (which is harder to use but supports thousands of remote receivers fed by shared receive queues).

### Memory Registration Cost

`ibv_reg_mr` is expensive (typically tens of microseconds, sometimes hundreds, because it pins pages and sets up IOMMU). Do it once at startup, never on the data path. Cache the lkey/rkey values. If you must register dynamically (e.g., applications that allocate large buffers on the fly), use `IBV_ACCESS_ON_DEMAND` (ODP, On-Demand Paging) which lazily registers pages on first access. ODP costs latency on first touch but avoids the upfront pin.

### Hugepages for the Buffer Backing

Backing the registered MR with hugepages reduces TLB pressure on the NIC's memory translation. Mellanox NICs walk the page table for every WR if the address is not in the cache. With 4KB pages, a 2 MiB scatter-gather requires 512 walks. With 2 MiB hugepages, it is 1 walk.

```cpp
void* buf = mmap(nullptr, size,
                 PROT_READ | PROT_WRITE,
                 MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB | MAP_HUGE_2MB,
                 -1, 0);
```

### Error Handling: The QP Goes To Error State

A single failing WC moves the QP to `ERR` state. All subsequent WRs fail with `IBV_WC_WR_FLUSH_ERR`. Recovery requires draining the CQ, modifying the QP back through `RESET -> INIT -> RTR -> RTS`, and re-establishing connection state with the peer. This must be handled. A real client has a connection state machine layered above the verbs that handles error and retry, including tearing down and rebuilding QPs.

> Junior engineer behavior: writing RDMA code that uses `ibv_reg_mr` per request, complaining that RDMA is slower than TCP.
> Senior FAANG move: pre-register all buffers at startup, use a slab allocator backed by a hugepage-mapped MR, build a session abstraction that coalesces signaled completions, and design for QP error recovery from day one.
