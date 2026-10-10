## Memory Leak Detection in Production

A C++ service with a slow memory leak does not crash for hours or days. The RSS climbs gradually, the OS page cache shrinks to compensate, latency drifts up as paging starts, and eventually the OOM killer (or Kubernetes' memory limit) terminates the process. The on-call engineer wakes up to a restart loop. The cause was a small leak that started six versions ago.

This chapter is about catching the leak when it starts, not when it kills you.

### The Phases of a Memory Problem

A C++ service's memory issue typically goes through phases:

1. **The introduction.** A code change leaks N bytes per request. Net effect: invisible.
2. **The accumulation.** Days of uptime, slow drift in RSS. No alarms.
3. **The plateau.** Allocator caches saturate. RSS appears stable to monitoring.
4. **The cliff.** Some workload shift bumps memory usage past a threshold, the OOM killer fires.

Catching the issue in phase 1 or 2 is free. Catching in phase 3 is hard. Catching in phase 4 is operationally expensive.

### RSS Budget Alerting

The first signal is RSS growth. A simple alert:

```
alert: RssAboveBudget
expr: process_resident_memory_bytes / pod_memory_limit > 0.85
for: 30m
```

A more sophisticated version: RSS as a fraction of the limit, plus the rate of increase. A linear regression over the last hour tells you whether you have time before OOM.

Distinguish three RSS shapes:

- **Steady-state.** RSS plateaus at some level. Normal.
- **Sawtooth.** RSS grows, restart, grows, restart. Indicates a leak with restart-driven recovery.
- **Monotonic growth.** RSS climbs without recovery. Active leak in this version.

The third is the urgent case.

### Heap Profiling: jemalloc

jemalloc has a built-in heap profiler. Enable at runtime:

```bash
$ MALLOC_CONF="prof:true,prof_active:true,lg_prof_sample:19,prof_prefix:/tmp/jeprof" ./mybin
```

`lg_prof_sample:19` means sample every 2^19 = 512KB of allocation. The overhead is negligible (under 1%). Higher sample rates (smaller intervals) catch more allocation sites, lower rates have less overhead.

Capture a snapshot:

```bash
$ kill -USR1 $(pidof mybin)   # forces a heap dump
$ ls /tmp/jeprof.*
```

Visualize:

```bash
$ jeprof --show_bytes --pdf /opt/mybin /tmp/jeprof.123.4.heap > heap.pdf
```

Or interactively:

```bash
$ jeprof /opt/mybin /tmp/jeprof.123.4.heap
(jeprof) top10
(jeprof) list MyClass::Process
```

The output identifies which call sites have the largest live allocation. A leak shows up as a call site whose live allocation grows without bound.

### Heap Profiling: tcmalloc

tcmalloc (gperftools) has a similar profiler:

```bash
$ HEAPPROFILE=/tmp/myheap ./mybin
$ pprof --pdf /opt/mybin /tmp/myheap.0001.heap > heap.pdf
```

Periodic snapshots are written automatically (every N MB allocated). For a long-running service, this gives you a time series of heap snapshots, a diff between snapshots shows where new live memory is going.

```bash
$ pprof --base /tmp/myheap.0001.heap /opt/mybin /tmp/myheap.0050.heap
(pprof) top10
```

The diff is the answer to "where is the leak?" If snapshot 50 has 200MB more in `Cache::Insert` than snapshot 1, the cache is leaking.

### Periodic Heap Dump and Diff

The pattern at scale: the service emits a heap snapshot every hour. A separate analyzer ingests the stream of snapshots, compares each new one to the one from a baseline (yesterday's snapshot at the same hour), and alerts on call sites whose live allocation grew by more than X%.

```cpp
class HeapSnapshotter {
public:
    void Run() {
        while (!stopping_) {
            std::this_thread::sleep_for(std::chrono::hours(1));
            DumpHeap("/var/lib/myservice/heap-" + Timestamp() + ".prof");
        }
    }
};
```

Most leak bugs would be caught within a few hours of being introduced if this pipeline is in place.

### Slab Leaks vs Fragmentation

Two RSS-growth modes that look similar but have different fixes:

**True leak.** Live allocations grow over time. A heap-profile diff shows specific call sites accumulating bytes. Fix: find the missing `delete`, the missed reference-count decrement, the leaked closure. The bug is a programming error.

**Heap fragmentation.** Live allocations are stable, but free memory is scattered across many small holes. The allocator cannot combine them into large blocks, so it requests more from the OS. RSS grows without live allocation growing.

Distinguish by comparing `mallinfo` (or jemalloc's stats) reports over time:

- `uordblks` (in-use bytes): live allocation. Stable means no leak.
- `fordblks` (free bytes): fragmentation pool. Growing means fragmentation.
- RSS: total. Growing while `uordblks` is stable means fragmentation.

For fragmentation, the fixes are:

- Use a different allocator (jemalloc and tcmalloc fragment less than glibc malloc on most workloads).
- Match allocation sizes to allocator size classes.
- Recycle large buffers explicitly via an object pool.
- Periodic process restart: simple, often the right answer for a service that has reached its allocator's fragmentation limit.

### OOM-Kill Investigation

When the OOM killer fires:

```
kernel: oom-kill: ... mybin invoked oom-killer
kernel: Out of memory: Killed process 18293 (mybin) ...
```

The autopsy:

1. **Was it a real leak or a single allocation spike?** Look at the RSS trajectory in the dashboard. Linear growth means leak. A sharp spike means a request that allocated huge memory.
2. **Did the service hit cgroup limit or system OOM?** cgroup OOM means your pod's memory limit was the bound. System OOM means the node was out of memory.
3. **Capture a heap dump from the next pre-OOM moment.** Either via signal-based dump or by tooling that triggers a dump when RSS crosses 90% of limit.

A common defense: a pre-OOM trigger that dumps heap and exits cleanly before the OS kills the process.

```cpp
void MemoryWatchdog::Run() {
    while (!stopping_) {
        size_t rss = ReadRss();
        if (rss > size_t(0.85 * limit_)) {
            DumpHeap("/var/lib/myservice/preoom.prof");
            LOG(FATAL) << "RSS at 85% of limit, dumping and exiting";
        }
        std::this_thread::sleep_for(std::chrono::seconds(10));
    }
}
```

The pre-OOM dump is often the most useful artifact for debugging the leak, because it captures the moment when live allocations are at their peak.

### C++-Specific Leak Patterns

The leak patterns in C++ are different from those in garbage-collected languages:

- **Owned raw pointer never deleted.** A class holds a `T*`, the destructor forgets to delete it. Fix: `unique_ptr`, `shared_ptr`.
- **Cyclic shared_ptr.** A holds shared_ptr to B, B holds shared_ptr to A. Neither destructs. Fix: weak_ptr on the back edge.
- **Container that grows unbounded.** A cache or queue with no eviction. Fix: bound the size.
- **Static destructor order.** A global object's destructor never runs because of static destruction order issues, "leaking" until process exit. Usually invisible because process exit reclaims memory anyway, but visible in heap profilers as growing static state.
- **Lambda captures.** A lambda that captures `this` is stored in a callback registry. The callback is never unregistered. The captured `this` is held alive by the lambda. Fix: weak captures or explicit unregister.

### Real Postmortem Flavor

A C++ search backend's RSS grew by 200MB per hour. Restarts every 36 hours kept it under the 32GB pod limit. The team noticed only when the restart cadence started causing user-visible cache-coldness on every restart.

Heap-profile diff showed all the growth in a single call site: a recent change had added a per-query trace to a `std::vector<TraceEntry>` member of the connection class, and the connection was a long-lived gRPC channel. Each query appended an entry. Each connection lasted hours. Each query added 200 bytes. At 10 QPS per connection over 36 hours, every connection accumulated 25MB.

The fix was a circular buffer instead of a vector. Total leak: gone. Restart cadence returned to weekly.

The team's lesson: any container that accumulates state across requests on a long-lived connection needs a bound. They added a clang-tidy check.

### Senior at FAANG: The Memory Pipeline

The senior contribution is the heap-profile pipeline: continuous sampling, periodic dumps, automated diff against baseline, alerts on growing call sites. It is not "a tool you use when debugging a leak." It is "a service-wide leak-detection system that runs continuously and catches leaks within hours of introduction." Building it once pays back forever.

---
