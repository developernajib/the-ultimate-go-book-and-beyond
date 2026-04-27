export default `## 10B.4 Profile-Guided Optimization (PGO)

### What is PGO?

PGO (Profile-Guided Optimization) uses runtime performance data to guide compile-time optimizations. The compiler learns which functions are hot, which call sites are frequently executed, and optimizes accordingly, inlining hot functions that were previously too large to inline, devirtualizing interface calls, etc.

\`\`\`
Traditional compilation:
Source → [Compiler guesses what's hot] → Binary

PGO compilation:
Source → Binary → [Run in production, collect CPU profile] → Profile
Source + Profile → [Compiler knows what's actually hot] → Optimized Binary
\`\`\`

### Setting Up PGO

PGO setup requires placing a \`default.pgo\` CPU profile in the main package directory before building. The Go toolchain automatically detects and uses this file without additional flags.

\`\`\`bash
# Step 1: Build without PGO (initial deployment)
go build -o server ./cmd/server

# Step 2: Collect CPU profile in production
# In your main.go, expose pprof endpoint:
import _ "net/http/pprof"
go http.ListenAndServe(":6060", nil)

# Collect 30-second CPU profile during peak load
curl -o default.pgo http://production-host:6060/debug/pprof/profile?seconds=30

# Step 3: Build with PGO
go build -pgo=default.pgo -o server-pgo ./cmd/server
# Or use -pgo=auto (Go 1.25+) to auto-detect default.pgo in the package directory

# Step 4: Deploy and measure
\`\`\`

### PGO in CI/CD Pipeline

A practical PGO setup downloads the latest production CPU profile in CI and passes it to the compiler. If no profile exists yet (first deploy), the build falls back to a standard compilation. A separate scheduled job refreshes the profile weekly.

\`\`\`yaml
# .github/workflows/build.yml
name: Build with PGO

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Download latest PGO profile
        run: |
          # Download most recent production profile from storage
          aws s3 cp s3://profiles/pprof/default.pgo ./default.pgo || true

      - name: Build with PGO (if profile exists)
        run: |
          if [ -f default.pgo ]; then
            echo "Building with PGO profile"
            go build -pgo=auto -o server ./cmd/server
          else
            echo "No PGO profile found, building without"
            go build -o server ./cmd/server
          fi

      - name: Upload binary
        # ... deploy server

  update-pgo-profile:
    runs-on: ubuntu-latest
    schedule:
      # Update PGO profile weekly from production
      - cron: '0 2 * * 0'
    steps:
      - name: Collect production profile
        run: |
          curl -o new-profile.pgo \\
            "https://prod-server:6060/debug/pprof/profile?seconds=60"
          aws s3 cp new-profile.pgo s3://profiles/pprof/default.pgo
\`\`\`

The application itself needs to expose a pprof HTTP endpoint so the CI job (or an operator) can collect CPU profiles from production traffic. Guard the endpoint behind an environment variable and add authentication in real deployments.

\`\`\`go
// main.go - expose pprof for profile collection
package main

import (
    "log/slog"
    "net/http"
    _ "net/http/pprof" // Import for side effects - registers /debug/pprof handlers
    "os"
)

func main() {
    // Only expose pprof in production if needed for PGO collection
    // Use authentication in real deployments!
    if os.Getenv("PPROF_ENABLED") == "true" {
        go func() {
            slog.Info("pprof server starting", "addr", ":6060")
            if err := http.ListenAndServe(":6060", nil); err != nil {
                slog.Error("pprof server error", "error", err)
            }
        }()
    }

    // ... rest of main
}
\`\`\`

### Measuring PGO Impact

The performance impact of PGO varies by workload. The following benchmark compares a PGO-optimized binary against a baseline to quantify the improvement in CPU time and instruction count.

\`\`\`go
// Benchmark to verify PGO improvement
package main_test

import (
    "testing"
    "your/app"
)

func BenchmarkCriticalPath(b *testing.B) {
    handler := app.NewHandler()
    req := buildTestRequest()

    b.ReportAllocs()
    b.ResetTimer()

    for b.Loop() { // Go 1.24: b.Loop() preferred over b.N
        handler.Process(req)
    }
}
\`\`\`

To measure the difference, build two binaries, one with PGO, one without, and run the same benchmark against both. The \`benchstat\` tool (from \`golang.org/x/perf/cmd/benchstat\`) provides statistical comparison across multiple runs.

\`\`\`bash
# Compare with and without PGO:
# Build two binaries
go build -o bench-nopgo ./cmd/bench
go build -pgo=default.pgo -o bench-pgo ./cmd/bench

# Run benchmarks
go test -bench=BenchmarkCriticalPath -count=5 -benchmem ./... | tee nopgo.txt
# Switch binary, re-run
# ... compare

# Expected improvements:
# Compute-intensive: 5-15% CPU reduction
# Interface-heavy code: up to 20% (devirtualization)
# Average across most Go services: 2-7%
\`\`\`

### When PGO Helps vs Doesn't

| Scenario | PGO Impact | Why |
|----------|-----------|-----|
| CPU-bound with hot functions | High (5-15%) | Inlines previously-too-large hot functions |
| Interface-heavy dispatch | High (up to 20%) | Devirtualizes frequent call sites |
| I/O-bound services | Minimal | CPU in DB/network, not Go code |
| Short-lived CLIs | None | Startup overhead, PGO helps steady state |
| Memory-bound workloads | Minimal | Memory latency not affected by code paths |
| JSON encoding/decoding | Moderate (5-10%) | Hot encoding paths get inlined |

### Caveats

PGO is not a universal speedup. It cannot improve I/O-bound workloads, it depends on profile quality, and the benefit diminishes for code the compiler already inlines aggressively. Keep these caveats in mind before investing in a PGO pipeline.

\`\`\`go
// Caveats to understand before using PGO in production:

// 1. Profile must represent production workload
// Running benchmarks or synthetic load: poor PGO quality
// Production traffic during peak hours: best PGO quality

// 2. Binary size increase
// PGO may increase binary size by 5-15% due to inlining
// Monitor if binary size is a concern (container images, etc.)

// 3. PGO is non-deterministic across runs
// Same source + same profile may produce slightly different binaries
// This is expected - don't treat binary diffs as regressions

// 4. Staleness - profile from 3 months ago on changed codebase
// PGO degrades gracefully - stale profiles still help, just less
// Best practice: update profile monthly or after major code changes

// 5. GOEXPERIMENT interaction
// PGO works with all standard Go builds
// No conflict with Green Tea GC or other experiments
\`\`\`

---
`;
