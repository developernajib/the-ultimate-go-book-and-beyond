## Memory Debugging and Leak Detection

A long-running C++ service that does not leak in development will leak in production. The leak rate may be slow. The leaked allocations may be small. They will grow until the OOM killer arrives. Detecting them, attributing them to source lines, and shipping fixes is part of the operational baseline. The tools have improved enormously over the last decade. There is no excuse for not running them.

### LeakSanitizer

LeakSanitizer (LSan) is part of the Address Sanitizer family, shipped with Clang and GCC. It detects memory that was allocated and never freed by program exit. Compile with `-fsanitize=address` (which includes LSan) or with `-fsanitize=leak` for the standalone leak checker.

```bash
g++ -O1 -g -fsanitize=address -fno-omit-frame-pointer main.cc -o app
./app
```

On exit, LSan prints stack traces for every leaked block. False positives are rare and typically come from "definitely-leaked-but-intentional" globals (e.g. lazy-init singletons that never destroy). Suppress those.

```bash
LSAN_OPTIONS="suppressions=lsan.supp" ./app
```

Suppression file:

```
leak:my_singleton_init
leak:protobuf::internal::OnShutdownDestroy
```

LSan slows the program ~2x and increases RSS modestly. Run it in CI on every test. Run it in staging on long-running smoke tests. Do not run it in production (the slowdown is significant and the on-exit detection means it does not help production-running processes).

### Address Sanitizer for Other Bugs

The full ASan (`-fsanitize=address`) catches more than leaks: heap-buffer-overflow, stack-buffer-overflow, use-after-free, use-after-return, use-after-scope, double-free, invalid-free. It costs ~2-3x slowdown and ~3x RSS. Always compile a CI job with ASan. Always.

```bash
g++ -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer main.cc -o app
ASAN_OPTIONS="abort_on_error=1:print_legend=0:detect_stack_use_after_return=1" ./app
```

The flags worth knowing.

- `abort_on_error=1`: dump core on detection. Easier to debug than the default exit.
- `detect_stack_use_after_return=1`: catches dangling pointers to stack locals after return. Costs more, finds important bugs.
- `halt_on_error=0`: keep running after first detection. Useful when you want to find as many bugs as possible per run.

### heaptrack

heaptrack is a sample-and-record-everything heap profiler from KDAB. It traces every `malloc` and `free` (via `LD_PRELOAD`), records the call stack, and writes a compressed log. After the run, the GUI shows allocation flame graphs, leaks (allocations alive at exit), peak memory, allocations over time, and per-call-site statistics.

```bash
heaptrack ./app
heaptrack_gui heaptrack.app.NNNN.gz
```

heaptrack is the right tool for a desktop or development workstation. It is too heavy for production (every malloc records a stack walk). The output is rich: you can see "this function allocated 12 GiB across 4 million calls and freed 11.9 GiB," which is the right way to attribute heap pressure.

### valgrind massif

massif is the heap profiler in valgrind. It snapshots heap allocations periodically and tracks which call stacks are responsible. The output is a textual or graphical breakdown of heap usage over time.

```bash
valgrind --tool=massif --time-unit=B ./app
ms_print massif.out.NNNN | less
massif-visualizer massif.out.NNNN  # GUI
```

massif slows the program ~10-20x. It is the most accurate of these tools because it works at the binary instruction level (no LD_PRELOAD games). It is also the slowest. Use for one-off investigations, not in CI.

### jemalloc Heap Profiling

If you ship with jemalloc, it has built-in sampled heap profiling. No recompile needed.

```bash
MALLOC_CONF="prof:true,prof_active:true,lg_prof_sample:19,prof_prefix:jeprof.out" \
  ./app

# Periodically dump:
echo prof.dump | ./your-control-channel

# After: convert .heap files with jeprof
jeprof --svg ./app jeprof.out.*.heap > heap.svg
jeprof --text ./app jeprof.out.*.heap | head -50
```

`lg_prof_sample:19` samples once per 2^19 = 512KB allocated. The default is 19. Lower (e.g. 16 = 64KB) catches smaller allocations at higher overhead. Higher (e.g. 22 = 4MB) is cheaper but coarser.

Sampled profiling has near-zero CPU overhead. Production-safe. Many companies leave it on permanently and expose `prof.dump` over an admin endpoint. When RSS climbs, you can dump and diff.

### tcmalloc Heap Profiling

Modern TCMalloc has the same capability via the `MallocExtension` API.

```cpp
#include "tcmalloc/malloc_extension.h"

// Configure sample rate at startup:
setenv("TCMALLOC_SAMPLE_PARAMETER", "524288", 1);  // 512KB

// Snapshot:
auto profile = tcmalloc::MallocExtension::SnapshotCurrent(
    tcmalloc::ProfileType::kHeap);

// Iterate:
profile.Iterate([](const tcmalloc::Profile::Sample& s) {
    // s.stack[0..s.depth] is the allocation call stack
    // s.allocated_size, s.requested_size, s.count
    // ...
});

// Or write a pprof-format file:
auto serialized = profile.Serialize();
write_to_file("/tmp/tcmalloc.pprof", serialized);
```

Then `pprof --svg ./app /tmp/tcmalloc.pprof` (using Google's pprof tool, written in Go).

The gperftools `tcmalloc` (the old one) uses `HeapProfilerStart` / `HeapProfilerDump` instead. If you are still on gperftools, migrate.

### Always-On Sampled Profiling vs Periodic Dump

Two production patterns.

Always-on sampled profiling: jemalloc's `prof_active:true` keeps a running profile. Dump on demand or on schedule. Low overhead. Captures rare events. Standard at large companies.

Periodic dump: a control plane triggers `prof.dump` every N minutes. Each dump is a full point-in-time profile. Diff consecutive dumps to find growing call sites. Easier to integrate with existing monitoring.

Most companies do both: always-on sampling, periodic dumps to a profile store, plus on-demand dump on RSS-spike alerts. The result is "we know exactly which call site is leaking, within 5 minutes of the leak starting."

### A Production Heap Pipeline

The architecture used at companies serving millions of QPS.

1. Build with sampled profiling enabled. Ship to production.
2. Each instance writes a heap profile every 5 minutes to local disk, rolling over to keep last N.
3. A sidecar uploads dumps to a profile store (S3, Glooglecloud, internal blob).
4. A continuous flame-graph service ingests profiles and serves UIs keyed by service + time range.
5. Alerts fire on RSS slope: if RSS grows faster than X bytes/min for Y minutes, page on-call.
6. On-call pulls the most recent profile and the profile from before the climb, diffs them, and finds the leaking call site within minutes.

This is operational baseline infrastructure for any C++ service running at scale. It is not glamorous. It is essential.

### Heap Snapshots vs Allocation Tracing

These are different.

Heap snapshots (the above tools) tell you what is alive now and where it was allocated.

Allocation tracing tells you every allocation and free. heaptrack does this. eBPF can do it. uftrace can do it. Allocation tracing is more expensive but catches "rapid alloc/free churn that never grows" pathologies that snapshots miss.

For a leaking service, snapshots are enough. For a service that is slow because it allocates too much, you want tracing.

### Common Mistakes

- Running ASan only locally. Then the bug ships to production. CI must run ASan on every PR.
- Ignoring LSan output because "those are intentional leaks." Maintain a suppression file. Never silence LSan globally.
- Reading a heap profile without symbols. The traces are useless without `-g`. Ship debug info to a symbol server, strip the production binary, and re-symbolicate offline.
- Sampling too coarsely. `lg_prof_sample:24` (16MB) hides small leaks until they aggregate to gigabytes.
- Confusing virtual size with RSS. A program that mmaps 100 GiB and never touches 99 of them has 100 GiB virtual but ~1 GiB RSS. Track both.

### Junior to FAANG

A junior engineer adds memory-leak debugging to the backlog after the third OOM. A FAANG-grade engineer ships every binary with sampled heap profiling enabled, runs ASan + LSan in CI on every commit, builds a continuous heap-snapshot pipeline before the first leak happens, and treats RSS slope as a first-class SLI. They also know the difference between a leak (memory never freed) and bloat (memory freed but RSS not returned to kernel) and have separate dashboards for each.
