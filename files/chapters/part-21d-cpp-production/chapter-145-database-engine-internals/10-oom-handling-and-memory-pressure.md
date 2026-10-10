## OOM Handling and Memory Pressure in Database Engines

A database that crashes under memory pressure loses the right to be called production-grade. Storage engines are uniquely exposed because the buffer pool, memtables, compaction scratch space, and query working sets all compete for RAM, and the kernel's OOM killer is an adversary that will pick the highest-RSS victim, which is always the database.

### Linux OOM killer: what you must configure

The OOM killer scores each process by `oom_score`, derived from RSS plus `oom_score_adj` (range -1000 to 1000). A production database should register a modestly negative adjustment so smaller sidecars are killed first.

```cpp
void SetOomScore(int adj) {
    int fd = ::open("/proc/self/oom_score_adj", O_WRONLY);
    if (fd < 0) { PLOG(WARNING) << "oom_score_adj open failed"; return; }
    auto s = std::to_string(adj);
    ::write(fd, s.data(), s.size());
    ::close(fd);
}
// Call early in main:
SetOomScore(-500);
```

Do not set -1000. That disables OOM kill entirely, and a leaking process will lock the node into swap death instead of crashing cleanly. Crash-restart is faster than hang-forever.

### cgroup v2 memory limits and PSI

Under Kubernetes or systemd the process lives in a memory cgroup with a hard limit. Read `/sys/fs/cgroup/memory.current` and `memory.max` to know your real ceiling, not `/proc/meminfo`. Pressure Stall Information (`/proc/pressure/memory`) gives a leading indicator before the hard limit is hit.

```cpp
struct MemoryPressure {
    double avg10, avg60, avg300;  // percent of time stalled on memory
};

absl::StatusOr<MemoryPressure> ReadPressure() {
    std::ifstream f("/proc/pressure/memory");
    std::string line;
    std::getline(f, line);  // "some avg10=... avg60=... avg300=... total=..."
    MemoryPressure p;
    if (std::sscanf(line.c_str(),
            "some avg10=%lf avg60=%lf avg300=%lf",
            &p.avg10, &p.avg60, &p.avg300) != 3) {
        return absl::InternalError("parse failed");
    }
    return p;
}
```

A sustained `avg60 > 10` is the signal to start shedding load, trimming caches, and flushing memtables early. Do not wait for OOM.

### `std::bad_alloc` and `set_new_handler`

Vanilla `new` throws `std::bad_alloc` on failure only if the allocator returns null, which glibc malloc does not (it aborts on heap corruption and returns null only on ENOMEM from mmap). Register a new-handler that triggers graceful degradation.

```cpp
void HandleOutOfMemory() {
    static std::atomic<bool> shedding{false};
    if (!shedding.exchange(true)) {
        LOG(ERROR) << "bad_alloc, entering load-shedding mode";
        BufferPool::Instance().Trim(0.5);      // drop half the pages
        Memtable::Instance().ForceFlush();     // push to L0
        QueryScheduler::Instance().SetAdmissionControl(0.1);  // admit 10 percent
    }
    throw std::bad_alloc{};
}

int main() {
    std::set_new_handler(HandleOutOfMemory);
    // ...
}
```

The handler runs in the allocating thread with no extra stack guarantees. It must not allocate. Pre-reserve every buffer it touches during startup.

### Buffer pool: bounded and reservation-based

The single most important rule is: the buffer pool size is a configured value, not an unbounded cache. Use `mmap` with `MAP_POPULATE` to materialize pages upfront when possible, or track live allocations against a semaphore counting bytes.

```cpp
class BoundedBufferPool {
    const size_t capacity_bytes_;
    std::atomic<size_t> used_bytes_{0};

public:
    absl::StatusOr<PageHandle> Acquire(size_t bytes) {
        size_t cur = used_bytes_.load(std::memory_order_relaxed);
        do {
            if (cur + bytes > capacity_bytes_) {
                return absl::ResourceExhaustedError("buffer pool full");
            }
        } while (!used_bytes_.compare_exchange_weak(
            cur, cur + bytes, std::memory_order_acq_rel));
        return AllocatePage(bytes);
    }
};
```

Returning `ResourceExhausted` is how the query layer learns to spill to disk, not crash. Every path that calls `Acquire` must handle the error, which is why the return type is `StatusOr` not a raw pointer.

### Memtable flush triggers

Flush triggers must fire well before the hard limit. Typical thresholds: 60 percent of configured memtable budget (soft, schedules flush), 80 percent (aggressive, blocks new writes briefly), 95 percent (emergency, refuses writes with `ResourceExhausted`). The delta between soft and emergency is the time budget for compaction to drain L0.

### Compaction memory discipline

Compaction is the sneaky OOM source. A sorted-run merge allocates scratch buffers proportional to the fan-in, and unbounded fan-in means unbounded memory. Configure a per-compaction memory budget and fail the job with retry rather than allocating without bound. Jemalloc's `mallctl("arenas.purge")` after a large compaction releases dirty pages back to the OS, otherwise RSS stays inflated and invites the OOM killer.

### Huge pages and fragmentation

Transparent huge pages (THP) can cause latency spikes on compaction due to defragmentation. Disable THP for the database cgroup (`echo never > /sys/kernel/mm/transparent_hugepage/enabled`) and use explicit `MAP_HUGETLB` for known-size buffer pool mappings. RSS fragmentation in glibc malloc can pin gigabytes after a workload spike, which is why jemalloc or tcmalloc with periodic `decay_ms` tuning is standard in production storage engines.

### What to log

Every OOM-adjacent event is an incident artifact. Log RSS, cgroup current, PSI avg10, buffer pool used/capacity, memtable sizes, and in-flight compactions on each threshold crossing. On `bad_alloc`, dump this plus the backtrace. The postmortem will ask for exactly this data.
