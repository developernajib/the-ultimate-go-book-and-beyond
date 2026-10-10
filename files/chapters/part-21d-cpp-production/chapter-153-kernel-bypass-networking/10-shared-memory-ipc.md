## Shared Memory IPC: Aeron, Chronicle, ZeroMQ inproc, and Custom Rings

Once you have stripped the kernel out of network I/O, the next bottleneck is often inter-process communication on the same host. A typical HFT or low-latency system has a market data process feeding multiple strategy processes, an order entry process, a risk process, and a logger. If those talk over Unix domain sockets, each message pays 1-2 microseconds in syscall overhead. Shared memory rings reduce that to 60-150 nanoseconds.

This chapter covers the patterns: hand-rolled mmap-backed ring buffers, the production-grade libraries (Aeron, Chronicle Queue, ZeroMQ inproc), and the cache-discipline rules that decide whether your ring runs at 50 ns per message or 500.

### Why Shared Memory Wins

A Unix-domain socket `send()` of a 256-byte message costs:

- syscall entry: 150 ns
- copy_from_user: 200 ns
- skb alloc (yes, even for AF_UNIX): 300 ns
- enqueue + wakeup: 400 ns
- syscall return: 100 ns

That is ~1100 ns one way, ~2200 ns round trip, before the receiver does anything. Compare to a shared memory ring write: a write to memory + a release fence. ~50 ns.

The cost: you give up the kernel's safety net. Buggy producer corrupts the ring, and the consumer sees garbage. There is no automatic backpressure (the kernel's send buffer would have blocked you).

### Anatomy of an SPSC Ring

The simplest case: single producer, single consumer, fixed-size slots. Two cache-line-aligned indices (head, tail), a power-of-two buffer:

```cpp
#include <atomic>
#include <cstdint>
#include <cstring>
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>

template <size_t SlotBytes, size_t NumSlots>
struct alignas(64) SpscRing {
    static_assert((NumSlots & (NumSlots - 1)) == 0,
                  "NumSlots must be a power of two");
    static constexpr size_t kMask = NumSlots - 1;

    alignas(64) std::atomic<uint64_t> head;   // producer writes
    alignas(64) std::atomic<uint64_t> tail;   // consumer writes
    alignas(64) std::byte slots[NumSlots][SlotBytes];

    bool try_push(const void* msg) noexcept {
        const uint64_t h = head.load(std::memory_order_relaxed);
        const uint64_t t = tail.load(std::memory_order_acquire);
        if (h - t >= NumSlots) return false;
        std::memcpy(slots[h & kMask], msg, SlotBytes);
        head.store(h + 1, std::memory_order_release);
        return true;
    }

    bool try_pop(void* out) noexcept {
        const uint64_t t = tail.load(std::memory_order_relaxed);
        const uint64_t h = head.load(std::memory_order_acquire);
        if (t == h) return false;
        std::memcpy(out, slots[t & kMask], SlotBytes);
        tail.store(t + 1, std::memory_order_release);
        return true;
    }
};
```

Three cache-discipline points decide whether this is fast or slow:

1. **`head` and `tail` on different cache lines.** If they share a line, every producer write invalidates it on the consumer's core, forcing a coherence transaction. The `alignas(64)` per-field is non-negotiable.
2. **Slots adjacent.** With 64-byte slots, sequential pushes hit successive lines, which the prefetcher recognizes.
3. **Acquire/release pairing.** The producer's `release` on `head.store` synchronizes with the consumer's `acquire` on `head.load`. Memory barriers, but only the right ones. `seq_cst` here would be wasteful.

Place the ring in shared memory (POSIX shm or memfd) so two processes can map it:

```cpp
int fd = shm_open("/mdring", O_RDWR | O_CREAT, 0660);
ftruncate(fd, sizeof(SpscRing<256, 65536>));
void* mem = mmap(nullptr, sizeof(SpscRing<256, 65536>),
                 PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
auto* ring = new (mem) SpscRing<256, 65536>();
```

For multi-core throughput, back the mapping with hugepages (`MFD_HUGETLB`) to avoid TLB thrash on writes that span many pages.

### Aeron: The Production-Grade Choice

Aeron (Real Logic, MIT-licensed) is the de facto standard low-latency messaging library used at LMAX and many trading firms. The C++ port (Aeron C++) provides:

- Reliable UDP unicast and multicast over the wire.
- Local IPC (shared memory) with the same API.
- Sub-microsecond IPC latency with backpressure and flow control.
- Exclusive (single-publisher) and concurrent (multi-publisher) publications.

Skeleton:

```cpp
#include <Aeron.h>
#include <Publication.h>
#include <Subscription.h>

aeron::Context ctx;
ctx.aeronDir("/dev/shm/aeron");
auto aeron = aeron::Aeron::connect(ctx);

const auto pub_id = aeron->addExclusivePublication("aeron:ipc", 10);
auto pub = aeron->findExclusivePublication(pub_id);
while (!pub) { pub = aeron->findExclusivePublication(pub_id); }

const std::string msg = "hello";
aeron::concurrent::AtomicBuffer buf((uint8_t*)msg.data(), msg.size());
while (pub->offer(buf, 0, msg.size()) < 0) { /* backpressure */ }
```

Aeron's underlying transport is a log-buffer-based protocol: producers append to a log, consumers tail it. The IPC variant is essentially the SPSC ring above, but with framing, fragmentation, and flow control on top.

Choose Aeron when you want a library boundary, replication semantics, and the ability to run the same code over IPC and over UDP unicast or multicast. Choose a hand-rolled SPSC when every nanosecond matters and you control the schema.

### Chronicle Queue (Java, but Often Ported)

Chronicle Queue is the Java-world standard. C++ ports exist (some commercial). Its model is a memory-mapped append-only log: producers write tagged messages, consumers tail with positional cursors that survive process restarts.

The interesting design feature: the log is on disk (or on tmpfs), so consumers can disconnect and reconnect across the boundary. For HFT order audit logging, this is the right tool. For pure inter-process IPC where persistence is not needed, an in-memory ring is faster.

### ZeroMQ inproc

ZeroMQ's `inproc://` transport is a thread-to-thread queue inside a single process. It is not shared memory across processes, for that, ZeroMQ has `ipc://` (Unix-domain sockets) which is again kernel-mediated. ZeroMQ's `ipc://` adds 1-2 microseconds, no different from a raw Unix-domain socket.

ZeroMQ inproc is useful for thread fanout in a single process. It is the wrong tool for inter-process IPC at sub-microsecond.

### MPSC and SPMC Variants

Single-producer single-consumer is the easy case. Production needs at least:

- **MPSC** (multiple producers, one consumer). Producers contend on `head`. CAS-based reservation. The consumer is uncontested. Used for log aggregators, event sinks.
- **SPMC** (one producer, multiple consumers, broadcast). Consumers each track their own tail. The producer never blocks on consumers. Slow consumers fall behind and may need conflation.
- **MPMC**. The hardest. Bounded-MPMC ring buffers are well-known (Vyukov's MPMC queue is the reference), throughput is good but latency suffers vs SPSC.

For market data fanout (one feed handler, many strategies), SPMC broadcast with conflation is the right pattern. Each strategy reads at its own rate, if it falls behind, it skips to the latest message rather than reading stale.

### Wakeup vs Busy-Poll

A consumer in a tight `try_pop` loop pegs a CPU at 100%. The alternatives:

- **eventfd notification.** Producer writes to an eventfd when it pushes, consumer `poll`s on the eventfd. Adds 200-400 ns per wakeup.
- **Hybrid.** Spin for N iterations, then poll. Common in Aeron. Tunable via `aeron.idle.strategy`.
- **Spin always.** Maximum latency but 100% CPU.

For HFT inner loops, spin always. For service-tier consumers (logger, analytics), hybrid. For thousands of low-rate consumers, eventfd, because a thousand spinning cores is a thousand cores.

### The Conflation Pattern

Slow consumer falling behind on market data: option A (block producer) is unacceptable, option B (drop messages) loses information. The right answer is conflation: the producer writes the latest snapshot per key, the slow consumer reads only the most recent.

```cpp
struct ConflatingSlot {
    std::atomic<uint64_t> seq;       // even = stable, odd = updating
    PriceLevel level;
};
ConflatingSlot levels[NUM_SYMBOLS];

// Producer
void update(uint32_t sym, const PriceLevel& v) {
    auto& s = levels[sym];
    auto seq = s.seq.fetch_add(1, std::memory_order_acq_rel);  // -> odd
    s.level = v;
    s.seq.store(seq + 2, std::memory_order_release);            // -> even
}

// Consumer (lossy reader)
bool read(uint32_t sym, PriceLevel& out) {
    auto& s = levels[sym];
    while (true) {
        auto s1 = s.seq.load(std::memory_order_acquire);
        if (s1 & 1) continue;            // mid-update, retry
        out = s.level;
        auto s2 = s.seq.load(std::memory_order_acquire);
        if (s1 == s2) return true;       // stable read
    }
}
```

This is the seqlock pattern, applied per slot. Producer does not block, consumer either gets a clean read or retries.

### Shared Memory and Process Lifecycle

The hidden trap of mmap-backed IPC: process death. If the producer crashes mid-write, the ring is in an inconsistent state and the consumer can hang. Mitigations:

- **Robust mutexes** (`pthread_mutexattr_setrobust`). On owner death, lock acquisition returns `EOWNERDEAD`, the recovering process must call `pthread_mutex_consistent`.
- **Pid heartbeats in shared memory.** Consumer periodically checks producer is alive via `kill(pid, 0)`.
- **Watchdog process.** A separate process watches both ends and terminates the system on stale state.

Aeron handles this internally. Hand-rolled rings need explicit attention.

> Junior engineer pitfall: writing a one-liner `std::queue` with a mutex and calling it "shared memory IPC."
> Senior FAANG move: choosing SPSC/MPSC/SPMC topology per data path, aligning indices to cache lines, picking spin vs hybrid wakeup based on consumer count, designing for crash recovery, and validating with `perf c2c` that there is no false sharing on the index lines.
