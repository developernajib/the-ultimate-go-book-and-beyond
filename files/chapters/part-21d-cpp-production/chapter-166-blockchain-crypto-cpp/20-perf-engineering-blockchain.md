## Performance Engineering for Blockchain

Blockchain workloads are unusual. The CPU bottleneck shifts dramatically with the workload phase: signature verification during initial block download, state trie hashing during steady-state operation, IO during chainstate flush. A senior performance engineer needs to know which bottleneck applies and how to attack each. This section covers the four major performance fronts: parallel signature verification, Merkle root computation, state database IO, and async IO with `io_uring`.

### Parallel Signature Verification

Signature verification dominates initial block download. A 5000-tx Bitcoin block contains roughly 12,000 input signatures. Sequential ECDSA verification at 100 microseconds per signature is 1.2 seconds per block, which would make IBD take a week.

The fix is parallelism plus batching.

#### Per-Block Parallelism

Bitcoin Core distributes input verification across a thread pool sized to physical cores. Each thread takes a verify job (one input), executes the script, and reports back. This scales near-linearly to 8 to 16 cores.

```cpp
class ParallelScriptVerifier {
public:
    explicit ParallelScriptVerifier(std::size_t n_threads) {
        for (std::size_t i = 0; i < n_threads; ++i) {
            workers_.emplace_back([this](std::stop_token stop) { run_worker(stop); });
        }
    }

    // Returns when all enqueued jobs finish or any has failed
    bool wait_all() {
        std::unique_lock lock(mtx_);
        finished_cv_.wait(lock, [this] { return inflight_ == 0 || failed_; });
        return !failed_;
    }

    void enqueue(std::vector<ScriptCheck> jobs) {
        std::scoped_lock lock(mtx_);
        for (auto& j : jobs) queue_.push_back(std::move(j));
        inflight_ += jobs.size();
        avail_cv_.notify_all();
    }

private:
    void run_worker(std::stop_token stop) {
        while (!stop.stop_requested()) {
            ScriptCheck job;
            {
                std::unique_lock lock(mtx_);
                avail_cv_.wait(lock, [this, &stop] {
                    return !queue_.empty() || stop.stop_requested();
                });
                if (stop.stop_requested()) return;
                job = std::move(queue_.front());
                queue_.pop_front();
            }
            bool ok = job.verify();
            std::scoped_lock lock(mtx_);
            inflight_--;
            if (!ok) failed_ = true;
            if (inflight_ == 0 || failed_) finished_cv_.notify_all();
        }
    }

    std::mutex mtx_;
    std::condition_variable avail_cv_, finished_cv_;
    std::deque<ScriptCheck> queue_;
    std::size_t inflight_{0};
    bool failed_{false};
    std::vector<std::jthread> workers_;
};
```

#### Batched Schnorr Verification

Taproot signatures (BIP340) support batch verification. Given N signatures, batch verify computes a single equation that is true if and only if all N signatures are valid. The cost is roughly `N * c + sqrt(N) * d` where c is one EC addition and d is one scalar multiplication, versus `N * d` for sequential verification. For N=1000, this is roughly 10x speedup.

libsecp256k1 exposes `secp256k1_schnorrsig_verify_batch`. Bitcoin Core 24.0+ uses it for blocks where every signature is Schnorr.

#### GPU Verification (Solana)

Solana validators offload Ed25519 batch verification to GPU. A typical CUDA kernel processes 1024 signatures in roughly 1 ms on an H100. The technique is a single Pippenger-style MSM over the curve, similar to the snark MSM kernels.

### Merkle Root Computation

Computing the state Merkle root after a block is the largest single CPU cost on Ethereum execution clients. The Merkle Patricia Trie has a long path (up to 64 nibbles), and every account update touches every node on its path.

The optimization is **batch root computation**: instead of recomputing the root after each transaction, accumulate all touched paths and recompute the root once at end-of-block. Erigon and Reth use this approach.

```cpp
class BatchedMpt {
public:
    void set(const Hash256& key, const std::vector<std::uint8_t>& value) {
        dirty_.emplace(key, value);
    }

    Hash256 commit_root() {
        // Build a sorted vector of dirty keys
        std::vector<std::pair<Hash256, std::vector<std::uint8_t>>>
            sorted(dirty_.begin(), dirty_.end());
        std::sort(sorted.begin(), sorted.end());

        // Bottom-up reconstruction of the trie
        return build_trie(sorted, 0, sorted.size(), 0);
    }

private:
    Hash256 build_trie(const std::vector<std::pair<Hash256, std::vector<std::uint8_t>>>& items,
                       std::size_t lo, std::size_t hi, std::size_t depth);

    std::unordered_map<Hash256, std::vector<std::uint8_t>, Hash256Hasher> dirty_;
};
```

Erigon's "stage 5" (HashState) does this offline, separately from execution.

### State Database IO

The largest IO bottleneck is the state database. Bitcoin Core uses LevelDB. Geth uses LevelDB or PebbleDB. Erigon uses MDBX. Reth uses MDBX.

The performance differences:

- **LevelDB**: write-amplified by compactions. Random reads are O(log N) seeks, slow on HDDs.
- **PebbleDB**: Go reimplementation of LevelDB by Cockroach Labs. Better tail latency, similar throughput.
- **MDBX**: B-tree with copy-on-write. Read-only mmaps. Single writer, many readers. Excellent for archive nodes because reads are essentially zero-cost.
- **RocksDB**: heavily-tuned LevelDB derivative used by Solana and many Layer 2s.

For chainstate workloads (lots of point lookups, sequential writes during commit), MDBX has been the winner since 2021, which is why Erigon and Reth chose it.

```cpp
#include <mdbx.h>

class MdbxStore {
public:
    explicit MdbxStore(const std::string& path) {
        mdbx_env_create(&env_);
        mdbx_env_set_geometry(env_, -1, -1, 1ull << 40, -1, -1, -1);  // 1TB max
        mdbx_env_set_maxdbs(env_, 64);
        mdbx_env_open(env_, path.c_str(), MDBX_NOSUBDIR | MDBX_LIFORECLAIM, 0664);
    }

    std::vector<std::uint8_t> get(std::span<const std::uint8_t> key) {
        MDBX_txn* txn;
        mdbx_txn_begin(env_, nullptr, MDBX_TXN_RDONLY, &txn);
        MDBX_val k{const_cast<std::uint8_t*>(key.data()), key.size()};
        MDBX_val v;
        std::vector<std::uint8_t> out;
        if (mdbx_get(txn, dbi_, &k, &v) == MDBX_SUCCESS) {
            out.assign(static_cast<const std::uint8_t*>(v.iov_base),
                       static_cast<const std::uint8_t*>(v.iov_base) + v.iov_len);
        }
        mdbx_txn_abort(txn);
        return out;
    }

private:
    MDBX_env* env_{nullptr};
    MDBX_dbi dbi_{};
};
```

MDBX read transactions are essentially free because they hold a snapshot via mmap. This is what makes Erigon's archive node querying fast.

### io_uring for State IO

On Linux 5.10+, `io_uring` provides batched async syscalls with no per-call overhead. For a blockchain state database that does millions of point lookups per block validation, `io_uring` reduces syscall overhead from milliseconds to microseconds.

A simplified async lookup batch:

```cpp
#include <liburing.h>

class IoUringBatch {
public:
    explicit IoUringBatch(unsigned entries = 4096) {
        io_uring_queue_init(entries, &ring_, 0);
    }

    ~IoUringBatch() {
        io_uring_queue_exit(&ring_);
    }

    void submit_read(int fd, std::uint64_t offset, std::span<std::uint8_t> buf, void* user_data) {
        auto* sqe = io_uring_get_sqe(&ring_);
        io_uring_prep_read(sqe, fd, buf.data(), buf.size(), offset);
        io_uring_sqe_set_data(sqe, user_data);
    }

    void submit_and_wait(unsigned n) {
        io_uring_submit_and_wait(&ring_, n);
    }

    void drain(std::function<void(void*, int)> handler) {
        io_uring_cqe* cqe;
        while (io_uring_peek_cqe(&ring_, &cqe) == 0) {
            handler(io_uring_cqe_get_data(cqe), cqe->res);
            io_uring_cqe_seen(&ring_, cqe);
        }
    }

private:
    io_uring ring_;
};
```

Bitcoin Core has experimental `io_uring` patches for the chainstate database. Geth has `io_uring` patches in some forks. The wins are 30 to 50 percent faster IBD on NVMe storage.

### Cache-Friendly Data Structures

A senior engineer should know how to recognize cache-unfriendly code:

- **Pointer chasing**. Linked lists, trees of separately-allocated nodes.
- **False sharing**. Multiple atomics on the same cache line.
- **Sparse access**. Hash map lookups where the keys are uniformly distributed.

The fixes:

- **Arenas**. Allocate nodes in a contiguous bump allocator.
- **Cache-line padding**. Use `alignas(64)` on hot atomics.
- **Robin Hood hashing or open addressing**. Better cache behavior than `std::unordered_map`.

```cpp
template <typename T>
struct alignas(64) PaddedAtomic {
    std::atomic<T> value;
    std::array<std::uint8_t, 64 - sizeof(std::atomic<T>)> _pad;
};
```

### Profiling

Standard tools every senior engineer must know:

- **`perf record / perf report`**: sampling profiler. The default for any Linux performance investigation.
- **`perf stat -e cache-misses,cache-references,instructions,cycles`**: hardware counter reading.
- **VTune**: Intel's deep profiler. Premier tool for memory-system analysis.
- **`pmu-tools`** (Andi Kleen's toolkit): Top-down microarchitecture analysis.
- **`bpftrace` and `bcc`**: kernel-level instrumentation.

For blockchain workloads, the most useful counter is `dTLB-load-misses`. A high TLB miss rate indicates random access into a large state, and the fix is huge pages.

```bash
perf stat -e dTLB-loads,dTLB-load-misses,iTLB-loads,iTLB-load-misses ./bitcoind
```

### Senior Track Notes

- **Huge pages reduce TLB pressure dramatically** on large memory workloads. Use `transparent_hugepage=always` and explicit `madvise(MADV_HUGEPAGE)` on the chainstate cache. Bitcoin Core has an experimental option for this.
- **NUMA-awareness matters at 32+ cores**. The default Linux scheduler does not pin memory to a NUMA node. For dual-socket machines, use `numactl --cpunodebind=0 --membind=0` to keep validator state on one socket.
- **Compiler choice matters**. GCC 13+ and Clang 17+ both produce competitive code, but for crypto kernels with inline assembly, GCC tends to inline more aggressively. Check the generated assembly for hot loops.
- **Profile-guided optimization (PGO)** gains 5 to 15 percent on large interpreters (EVM, Move VM). Bitcoin Core experimented with PGO but rejected it because the build complexity was not worth the gain. Solana validators routinely build with PGO.

The next section reviews the historical security incidents that this performance engineering must avoid replicating.

---
