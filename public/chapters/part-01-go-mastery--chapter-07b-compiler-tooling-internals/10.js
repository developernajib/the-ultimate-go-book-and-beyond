export default `## 7B.8 Profile-Guided Optimization (PGO) Internals

PGO (introduced in Go 1.20, stable in Go 1.21) uses runtime profiling data to guide compiler optimizations.

### PGO Workflow

The PGO workflow has three steps: first, build your application normally and run it under a realistic workload while collecting a CPU profile. Then, rebuild the application with the collected profile passed via the \`-pgo\` flag. The compiler reads the profile to identify hot functions and call sites, then applies more aggressive optimizations to those paths. You can collect profiles from production using Go's built-in \`pprof\` HTTP endpoint, which gives the most representative data.

\`\`\`bash
# Step 1: Build without PGO
go build -o myapp ./cmd/myapp

# Step 2: Run with CPU profiling
GOGC=off ./myapp -cpuprofile=cpu.pprof

# Or collect from production (pprof HTTP endpoint)
curl -s http://localhost:6060/debug/pprof/profile?seconds=30 > cpu.pprof

# Step 3: Rebuild with PGO
go build -pgo=cpu.pprof -o myapp-pgo ./cmd/myapp

# Step 4: Compare
go tool pprof -http=:8080 cpu.pprof
\`\`\`

### What PGO Optimizes

PGO primarily improves three areas of code generation. First, it increases the inlining budget for frequently called (hot) functions, allowing more of them to be inlined. Second, it performs devirtualization of interface calls: if profiling shows that an interface method is almost always dispatched to the same concrete type, the compiler inserts a type guard for a direct call, avoiding the overhead of interface dispatch. Third, it provides branch prediction hints to the CPU. The example below illustrates how devirtualization works in practice.

\`\`\`go
package main

import (
	"runtime/pprof"
	"os"
)

// PGO primarily optimizes:
// 1. Inlining decisions (hot functions get higher inlining budget)
// 2. Devirtualization (interface calls that always use same type)
// 3. Memory layout (hot struct fields placed for cache efficiency)

// Example: PGO-guided devirtualization
type Processor interface {
	Process(data []byte) error
}

type FastProcessor struct{}
type SlowProcessor struct{}

func (f *FastProcessor) Process(data []byte) error { return nil }
func (s *SlowProcessor) Process(data []byte) error { return nil }

func processAll(p Processor, batches [][]byte) error {
	for _, batch := range batches {
		// If profiling shows FastProcessor is used 99% of the time,
		// PGO will devirtualize this call with a type guard:
		// if p == (*FastProcessor)(nil) { call directly } else { call via interface }
		if err := p.Process(batch); err != nil {
			return err
		}
	}
	return nil
}

// PGO merging: merge multiple profiles
// go tool pprof -proto cpu1.pprof cpu2.pprof > merged.pprof
// go build -pgo=merged.pprof
\`\`\`

### PGO Statistics

After building with PGO, you can verify which optimizations the compiler applied by combining the \`-pgo\` flag with verbose escape and inlining output. The compiler will annotate its output with "PGO" prefixes for any decision that was influenced by the profile data. This is useful for confirming that your hot paths are actually receiving the expected optimizations.

\`\`\`bash
# See PGO impact
go build -pgo=cpu.pprof -gcflags="-m=2" ./... 2>&1 | grep "PGO"

# Output:
# ./hot.go:42:6: PGO devirtualized interface call to (*FastProcessor).Process
# ./batch.go:88:10: PGO inlined function call to processItem
\`\`\`

### PGO Operational Discipline

For a senior engineer running PGO in production:

1. **Profile refresh cadence.** Monthly is typical. Older profiles produce worse decisions than no profile on a codebase that evolves.
2. **Profile representativeness.** The profile must come from traffic that reflects production. A load-test profile and a production profile make different decisions.
3. **Merging profiles.** For a service with varied traffic patterns, merge profiles from multiple windows to capture the full distribution.
4. **Rollback path.** If PGO produces a regression, the fix is to revert to the default build. Always test both with and without PGO before committing to the pattern.

PGO is a tuning lever, not a substitute for code design. For most services the 5-15% CPU win is real and earns its place. For services with extreme performance requirements, structural changes usually beat PGO.

---
`;
