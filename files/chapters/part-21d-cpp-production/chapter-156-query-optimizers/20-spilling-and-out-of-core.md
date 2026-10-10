## Spilling and Out-of-Core Execution

A query engine that crashes when input exceeds memory is not a query engine. It is a demo. Production systems must spill: when memory is exhausted, write some state to disk, free the memory, finish the query.

This chapter covers the spilling patterns for hash tables, sorts, and joins, with C++ implementations.

### The Memory Budget Model

The engine has a configurable memory budget per query. Each operator that holds state (hash join build side, hash agg state, sort buffer) is accounted against the budget. When an operator's allocation would exceed budget, it spills.

```cpp
#include <atomic>
#include <cstdint>

namespace spill {

class MemoryBudget {
    std::atomic<int64_t> used_{0};
    int64_t limit_;

public:
    explicit MemoryBudget(int64_t limit) : limit_(limit) {}

    bool TryAcquire(int64_t bytes) {
        int64_t cur = used_.load(std::memory_order_relaxed);
        while (cur + bytes <= limit_) {
            if (used_.compare_exchange_weak(cur, cur + bytes,
                                             std::memory_order_acq_rel))
                return true;
        }
        return false;
    }

    void Release(int64_t bytes) {
        used_.fetch_sub(bytes, std::memory_order_acq_rel);
    }

    int64_t Available() const { return limit_ - used_.load(); }
};

}  // namespace spill
```

The budget is per-query. Cluster-wide budgets are enforced one level up (admission control). DuckDB has a global budget configurable via the `memory_limit` setting. ClickHouse has `max_memory_usage` per query.

### Hash Join Spill

The grace hash join from chapter 10 is the textbook spilling join. The implementation detail to get right: when does spilling start?

Two strategies.

**Spill on threshold.** Build the hash table in memory until it reaches the budget, then spill the existing rows and switch to grace mode for the rest. This is what DuckDB calls "external hash join with spilling triggered."

**Always grace.** Always partition the build side to disk first, then process partitions. Wastes I/O when memory was sufficient.

The threshold approach wins when memory is usually enough. When it is not enough, the threshold version still pays one I/O round trip on already-buffered data. Worth it.

```cpp
#include <fstream>
#include <vector>

namespace spill {

struct Row { int64_t key; int64_t payload; };

class SpillingHashJoin {
    static constexpr size_t kPartitions = 64;
    MemoryBudget& budget_;
    std::vector<Row> in_memory_build_;
    std::vector<std::ofstream> partition_files_;
    bool spilled_ = false;

public:
    explicit SpillingHashJoin(MemoryBudget& b) : budget_(b) {}

    void AddBuildRow(const Row& r) {
        if (!spilled_) {
            if (budget_.TryAcquire(sizeof(Row))) {
                in_memory_build_.push_back(r);
                return;
            }
            BeginSpill();
        }
        SpillRow(r);
    }

    void BeginSpill() {
        spilled_ = true;
        partition_files_.resize(kPartitions);
        for (size_t i = 0; i < kPartitions; ++i) {
            partition_files_[i].open("hj_part_" + std::to_string(i),
                                     std::ios::binary | std::ios::trunc);
        }
        // Flush in-memory rows to partitions.
        for (auto& r : in_memory_build_) SpillRow(r);
        budget_.Release(sizeof(Row) * in_memory_build_.size());
        in_memory_build_.clear();
        in_memory_build_.shrink_to_fit();
    }

    void SpillRow(const Row& r) {
        uint64_t h = std::hash<int64_t>{}(r.key);
        size_t p = (h >> 32) & (kPartitions - 1);
        partition_files_[p].write(reinterpret_cast<const char*>(&r), sizeof(Row));
    }
};

}  // namespace spill
```

Three engineering details.

**Partition count selection.** Want each partition to fit in memory. Estimate: `partitions = ceil(total_build_bytes / memory_budget)`. Round up to next power of two. Typical: 32 to 256.

**File-per-partition vs single-file.** File-per-partition is simpler but uses many file descriptors. ClickHouse and DuckDB use a single file with a partition index for the spill. For pedagogy, file-per-partition is cleaner.

**Async writes.** A synchronous write per row stalls the build pipeline. Buffer rows per partition, flush when buffer fills (typically 1 MB per partition). Use io_uring or async file I/O.

### External Merge Sort

Sort that exceeds memory is the classic out-of-core problem.

The algorithm:

1. Read input in chunks that fit in memory.
2. Sort each chunk in memory, write sorted run to disk.
3. Merge runs by k-way merge with a priority queue.

```cpp
#include <algorithm>
#include <queue>

namespace spill {

class ExternalMergeSort {
    MemoryBudget& budget_;
    std::vector<std::string> run_files_;

public:
    explicit ExternalMergeSort(MemoryBudget& b) : budget_(b) {}

    void Run(std::function<bool(int64_t&)> input,
             std::function<void(int64_t)> output) {
        int64_t per_run_capacity = budget_.Available() / sizeof(int64_t);
        std::vector<int64_t> buf;
        buf.reserve(per_run_capacity);
        int64_t v;
        while (input(v)) {
            buf.push_back(v);
            if (static_cast<int64_t>(buf.size()) >= per_run_capacity) {
                FlushRun(buf);
            }
        }
        if (!buf.empty()) FlushRun(buf);
        Merge(output);
    }

private:
    void FlushRun(std::vector<int64_t>& buf) {
        std::sort(buf.begin(), buf.end());
        std::string name = "run_" + std::to_string(run_files_.size());
        std::ofstream f(name, std::ios::binary);
        f.write(reinterpret_cast<const char*>(buf.data()),
                buf.size() * sizeof(int64_t));
        run_files_.push_back(name);
        buf.clear();
    }

    void Merge(std::function<void(int64_t)> output) {
        struct Entry {
            int64_t value;
            std::ifstream* f;
            bool operator>(const Entry& o) const { return value > o.value; }
        };
        std::priority_queue<Entry, std::vector<Entry>, std::greater<>> pq;
        std::vector<std::ifstream> fs;
        for (auto& name : run_files_) fs.emplace_back(name, std::ios::binary);
        for (auto& f : fs) {
            int64_t v;
            if (f.read(reinterpret_cast<char*>(&v), sizeof(v))) {
                pq.push({v, &f});
            }
        }
        while (!pq.empty()) {
            auto e = pq.top(); pq.pop();
            output(e.value);
            int64_t v;
            if (e.f->read(reinterpret_cast<char*>(&v), sizeof(v))) {
                pq.push({v, e.f});
            }
        }
    }
};

}  // namespace spill
```

For very large inputs (more runs than the priority queue can hold open), perform the merge in passes. With K-way merge over R runs, total disk I/O is `(input + output) * ceil(log_K(R))`. For K=64 and R=1024, two passes.

### Replacement Selection for Better Initial Runs

The naive sort produces runs of size = memory budget. Replacement selection (Knuth, Vol. 3) produces runs of average 2x memory budget by maintaining a heap and emitting values in sorted order while consuming new values into the same heap.

The trick: a new value larger than the last emitted goes into the current heap, smaller goes into a "reserved" heap for the next run. This effectively chains values into longer runs. Production engines rarely implement this because the I/O reduction is small relative to the complexity.

### External Hash Aggregation

When the hash agg table exceeds memory, partition the input by hash, aggregate each partition independently.

```cpp
namespace spill {

class SpillingHashAgg {
    static constexpr size_t kPartitions = 64;
    MemoryBudget& budget_;
    std::vector<std::ofstream> partition_files_;
    bool spilled_ = false;

public:
    explicit SpillingHashAgg(MemoryBudget& b) : budget_(b) {}

    void Update(int64_t key, int64_t value) {
        if (!spilled_ && budget_.TryAcquire(sizeof(int64_t) * 4)) {
            // ... in-memory aggregation
            return;
        }
        if (!spilled_) BeginSpill();
        uint64_t h = std::hash<int64_t>{}(key);
        size_t p = (h >> 32) & (kPartitions - 1);
        partition_files_[p].write(reinterpret_cast<const char*>(&key), sizeof(key));
        partition_files_[p].write(reinterpret_cast<const char*>(&value), sizeof(value));
    }

    void BeginSpill();

    template <typename Emit>
    void Finalize(Emit emit) {
        for (size_t p = 0; p < kPartitions; ++p) {
            // Re-open partition file, run in-memory aggregation, emit.
        }
    }
};

}  // namespace spill
```

The strategy: don't touch the existing in-memory hash table when spilling starts. Spill new updates only. At finalization, merge the in-memory hash table with each partition's spilled data.

DuckDB's external aggregation does this. ClickHouse spills the entire in-memory table to one of the partitions when budget is exceeded.

### Async I/O and io_uring

Synchronous I/O during spilling stalls the entire pipeline. For sustained high throughput, use async I/O.

On Linux, io_uring is the modern interface. The C++ pattern:

```cpp
#include <liburing.h>  // hypothetical wrapper

namespace spill {

class AsyncSpillWriter {
    io_uring ring_;
    int fd_;

public:
    void Init(const std::string& path);
    void Write(std::vector<std::byte>&& buf, uint64_t offset) {
        struct io_uring_sqe* sqe = io_uring_get_sqe(&ring_);
        io_uring_prep_write(sqe, fd_, buf.data(), buf.size(), offset);
        io_uring_sqe_set_data(sqe, /* user data: ownership of buf */);
        io_uring_submit(&ring_);
    }
    void Drain() { /* wait for all completions */ }
};

}  // namespace spill
```

Photon and Velox both use async I/O for spilling. The complexity is in lifetime management: the buffer must outlive the kernel write, and the user-data pointer must let you reclaim it on completion.

For Linux without io_uring (older kernels), `aio_write` from libaio works but has annoying limitations. For Windows, use IOCP.

### Direct I/O

Spilling typically does not benefit from the OS page cache. The spill data is written once, read once, and discarded. Page cache space is better used for actual table data.

`O_DIRECT` on Linux bypasses the page cache. The constraint: writes must be aligned to filesystem block size (typically 512 bytes or 4 KB). Allocate buffers with `posix_memalign`, write in 4 KB chunks.

ClickHouse uses direct I/O for its merge tree. DuckDB does not (its workload is read-heavy and cache benefits dominate). The choice depends on workload.

### Spill File Lifetime and Cleanup

A query that crashes mid-spill can leave files behind. The patterns:

1. **Open and unlink immediately.** On Linux, an unlinked open file is deleted when the last fd closes. Process crash naturally cleans up.
2. **Per-query spill directory.** Create `/var/spill/query_<id>/`, register cleanup at query end and on coordinator restart.
3. **Tmpfs mount.** Use a memory-backed filesystem for spill (`/dev/shm`). Crash-safe (tmpfs is volatile), fast.

Production engines mix these. ClickHouse uses option 1 by default. Spark uses option 2.

### Spill-Aware Cost Model

The optimizer should know the cost of spilling and pick plans that avoid it when possible. Hash join with grace spill costs roughly 2x I/O (read input once, spill, read spill). Sort with external merge costs 2x I/O times log_K passes.

Cost formulas from chapter 07:

```cpp
double SpillCost(double bytes, int passes) {
    return bytes * 2.0 * passes * 0.001e-3;  // 1 GB/s SSD write+read
}
```

For a 100 GB hash join with single-pass spill: `100e9 * 2 * 1 * 0.001e-3 = 200000 us = 200 ms`. Add this to the join CPU cost, the optimizer might prefer a sort-merge join (which has different spill characteristics) or a different join order to fit in memory.

### What Production Engines Do

- **DuckDB**: spill via temp file in the configured temp directory. Hash agg, hash join, and sort all spill.
- **ClickHouse**: `max_bytes_before_external_group_by`, `max_bytes_before_external_sort`, `max_bytes_in_join` thresholds. Spilling is per-operator and configurable.
- **Spark/Photon**: spill to local disk, with shuffle data also potentially spilled.
- **Snowflake**: spill to remote object store (warm) or local SSD (hot). Multi-tier.
- **BigQuery**: spill to colossus (Google's distributed file system). The boundary between memory and disk is invisible to the query.

### What to Read

- Knuth, "The Art of Computer Programming, Volume 3: Sorting and Searching." External sorting chapter.
- Graefe, "Query Evaluation Techniques for Large Databases," ACM Computing Surveys 1993. Section on external operators.
- DuckDB's `src/execution/operator/aggregate/physical_hash_aggregate.cpp` for spilling agg.
- Photon paper, SIGMOD 2022, for distributed spill.

The next chapter assembles everything into a working mini engine.

---
