## Profiling: perf, VTune, and gperftools

### Linux perf

`perf` is the standard profiling tool on Linux, accessing hardware performance counters directly:

```bash
# Record a profile (sampling at 99 Hz to avoid lockstep with timers)
perf record -g -F 99 ./myapp

# View the profile
perf report

# Key metrics to collect
perf stat -e cycles,instructions,cache-references,cache-misses,\
branches,branch-misses,L1-dcache-load-misses,LLC-load-misses \
./myapp

# Example output:
#  3,200,000,000  cycles
#  8,500,000,000  instructions  # 2.66 IPC (good)
#    150,000,000  cache-references
#      2,500,000  cache-misses   # 1.67% miss rate (good)
#  1,200,000,000  branches
#     15,000,000  branch-misses  # 1.25% miss rate (good)

# Annotate hot functions with assembly
perf annotate --symbol=hot_function

# Generate a flame graph
perf script | stackcollapse-perf.pl | flamegraph.pl > flame.svg
```

### Intel VTune

VTune provides deep microarchitectural analysis unavailable through `perf`:

```bash
# Hotspot analysis
vtune -collect hotspots -result-dir=r001 ./myapp

# Microarchitecture analysis (identifies pipeline stalls)
vtune -collect uarch-exploration -result-dir=r002 ./myapp

# Memory access analysis
vtune -collect memory-access -result-dir=r003 ./myapp

# View results
vtune-gui r001/
```

VTune categorizes execution time into: retiring (useful work), bad speculation (branch misprediction), frontend bound (instruction cache misses, decoding), and backend bound (execution unit stalls, memory latency).

### gperftools (Google Performance Tools)

gperftools CPU profiling works by instrumenting a program with `ProfilerStart`/`ProfilerStop` calls, writing sampled stack traces to a `.prof` file that can be analyzed with `pprof`. The profiler uses SIGPROF-based sampling at ~100 Hz, so it incurs minimal overhead and can safely run in production. The resulting profile pinpoints hot functions by sample count, making it straightforward to identify which callsites dominate CPU time.
```cpp
// CPU profiling with gperftools
#include <gperftools/profiler.h>

int main() {
    ProfilerStart("myapp.prof");

    // ... your application code ...
    run_workload();

    ProfilerStop();
    return 0;
}
```

```bash
# Compile with profiler
g++ -O2 -g main.cpp -lprofiler -o myapp

# Run and analyze
./myapp
pprof --web ./myapp myapp.prof    # interactive web view
pprof --text ./myapp myapp.prof   # text report
pprof --svg ./myapp myapp.prof > profile.svg  # SVG flame graph
```

### Profiling Methodology

Follow a systematic approach:

1. **Measure first.** Never optimize without a profile. The bottleneck is almost never where you think it is.
2. **Top-down analysis.** Start with wall-clock time per function (hotspot analysis). Then drill into the hottest function with microarchitectural analysis.
3. **Identify the bottleneck type.** Is it compute-bound (high IPC, all execution units busy), memory-bound (low IPC, many cache misses), or branch-bound (high branch miss rate)?
4. **Apply targeted optimization.** Compute-bound: use SIMD, reduce instruction count. Memory-bound: improve data layout, prefetch. Branch-bound: branchless code, sort data.
5. **Re-measure.** Confirm the optimization helped and did not regress other metrics.

---
