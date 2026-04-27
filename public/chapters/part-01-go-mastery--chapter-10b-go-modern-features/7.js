export default `## 10B.5 Green Tea GC (Go 1.26)

Cross-reference: Chapter 6B Section 3 and Chapter 7 Section 5 cover the collector's internal architecture. This section focuses on the production operator's view: what changed, how to measure, and when the gain is worth chasing.

### Timeline and What Changed

Green Tea was introduced as an opt-in experiment in Go 1.25 (August 2025) via \`GOEXPERIMENT=greenteagc\`, then promoted to the default collector in Go 1.26 (February 2026). It is not a new algorithm. The collector is still the concurrent tri-color mark-sweep you already know. What changed is the mark-phase organization: small-object groups are now scanned together with SIMD-friendly control-byte checks, which reduces memory stalls and cuts GC CPU by roughly 10 to 40 percent on allocation-heavy workloads.

**What is actually different:**
1. **Group-based marking**: the mark worker pulls a group of small objects into cache and scans them in one pass instead of walking per-object pointers one at a time.
2. **SIMD scan on amd64 and arm64**: the group's control bytes are checked in parallel with a single hardware instruction.
3. **Unchanged contracts**: the tri-color invariant, the write barrier, and all user-facing GC semantics (GOGC, GOMEMLIMIT, \`debug.SetGCPercent\`, \`runtime.GC\`) behave exactly as before.

\`\`\`go
// Measuring GC impact before and after the 1.26 upgrade
package main

import (
    "fmt"
    "runtime"
    "time"
)

func gcStats() {
    var stats runtime.MemStats
    runtime.ReadMemStats(&stats)
    fmt.Printf("GC runs: %d\\n", stats.NumGC)
    fmt.Printf("GC pause total: %v\\n", time.Duration(stats.PauseTotalNs))
    fmt.Printf("GC CPU fraction: %.4f\\n", stats.GCCPUFraction)
    fmt.Printf("Heap in-use: %d MB\\n", stats.HeapInuse/1024/1024)
}

// To compare behavior against the legacy collector, build with the
// older toolchain (Go 1.24 or earlier). There is no runtime toggle to
// switch collectors within a single Go 1.26 binary, the choice is
// baked in at build time.
\`\`\`

### Real-World Impact

The magnitude of improvement depends on your allocation pattern. Services that allocate heavily per request (building response objects, parsing large payloads) see the largest gains because the GC runs more often and each cycle benefits from better marking locality. Services that rely on object pools and pre-allocated buffers already minimize GC activity, so the improvement is smaller.

\`\`\`go
// Typical Go service with allocation-heavy request handling
// Expected Green Tea GC improvements:

// Scenario A: High allocation rate (>100MB/s heap allocation)
// - GC pause reduction: 20-40%
// - GC CPU overhead reduction: 15-30%
// - Net throughput improvement: 5-15%

// Scenario B: Low allocation rate (object pool heavy)
// - GC pause reduction: 5-10%
// - Little change if GC barely runs

// Scenario C: Large heap (>1GB)
// - Marking locality improvements significant
// - Multi-core GC scaling benefits most visible

// Benchmarking GC behavior
func BenchmarkAllocIntensive(b *testing.B) {
    b.ReportAllocs()
    for b.Loop() {
        // Simulate allocation-heavy workload
        data := make([]byte, 1024)
        _ = processData(data)
    }
}

// Environment variables for GC tuning
// GOGC=100     (default: 100% heap growth triggers GC)
// GOMEMLIMIT=1GiB  (Go 1.19+: cap memory usage)
// GOGC=off     (disable GC - for benchmarking only)
\`\`\`

### GOGC and GOMEMLIMIT with Green Tea GC

\`GOGC\` and \`GOMEMLIMIT\` interact with the Green Tea GC the same way as the previous collector. The recommended production configuration sets \`GOMEMLIMIT\` to 90% of the container's memory limit.

\`\`\`go
// Recommended production GC configuration
// In a containerized service with 2GB memory limit:

// Container: 2GB memory limit
// GOMEMLIMIT: Set to ~90% of container limit
// GOGC: Often can be set higher with Green Tea GC

// Configure via environment:
// GOMEMLIMIT=1800MiB GOGC=200 ./server
// → Allow heap to grow more before GC (200% instead of 100%)
// → GOMEMLIMIT ensures we don't OOM the container
// → Green Tea GC handles the larger heap more efficiently

// In code:
import "runtime/debug"

func init() {
    // Set soft memory limit (can also be done via env var)
    // debug.SetMemoryLimit(1800 * 1024 * 1024) // 1800MB
    // GOMEMLIMIT env var is preferred for operational flexibility
}
\`\`\`

---
`;
