export default `## Section 4: Profile-Guided Optimization (PGO)

PGO allows the Go compiler to use real production profiles to make better optimization decisions, delivering 10-15% speedup.

### 4.1 PGO Workflow

Profile-Guided Optimization improves runtime performance using a CPU profile from production to guide compiler decisions. The workflow involves collecting a profile, placing it in the module root, and rebuilding.

\`\`\`
┌─────────────────────────────────────────────────────────┐
│                    PGO Workflow                         │
│                                                         │
│  1. Build without PGO                                   │
│     go build -o app .                                   │
│                 ↓                                       │
│  2. Run in production with profiling                    │
│     import _ "net/http/pprof"                           │
│     curl http://app/debug/pprof/profile > cpu.pprof     │
│                 ↓                                       │
│  3. Rebuild with PGO profile                            │
│     go build -pgo=cpu.pprof -o app .                    │
│                 ↓                                       │
│  4. 10-15% faster binary                                │
│     (inlining, devirtualization, layout)                │
└─────────────────────────────────────────────────────────┘
\`\`\`

### 4.2 PGO Implementation

PGO applies inlining decisions and branch prediction hints based on the collected profile. Functions frequently called in the profile are inlined at their call sites even if they exceed the normal inlining budget.

\`\`\`go
package pgo

import (
	"context"
	"net/http"
	"net/http/pprof"
	"os"
	"os/signal"
	"runtime"
	rpprof "runtime/pprof"
	"syscall"
	"time"
)

// ProfileCollector manages pprof profile collection for PGO
type ProfileCollector struct {
	outputDir string
	server    *http.Server
}

func NewProfileCollector(outputDir string) *ProfileCollector {
	return &ProfileCollector{outputDir: outputDir}
}

// StartProfileServer runs a pprof HTTP server for profile collection
func (pc *ProfileCollector) StartProfileServer(addr string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)

	pc.server = &http.Server{
		Addr:    addr,
		Handler: mux,
	}

	go pc.server.ListenAndServe()
}

// CollectCPUProfile collects a CPU profile for the specified duration
func (pc *ProfileCollector) CollectCPUProfile(duration time.Duration) error {
	filename := pc.outputDir + "/cpu-" + time.Now().Format("20060102-150405") + ".pprof"
	f, err := os.Create(filename)
	if err != nil {
		return err
	}
	defer f.Close()

	if err := rpprof.StartCPUProfile(f); err != nil {
		return err
	}

	time.Sleep(duration)
	rpprof.StopCPUProfile()
	return nil
}

// RunWithProfileCollection runs an application with automatic profile collection
func RunWithProfileCollection(app func(ctx context.Context) error) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Collect CPU profile every hour
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()
		collector := NewProfileCollector("/tmp/profiles")
		for {
			select {
			case <-ticker.C:
				// 30-second profile sample
				collector.CollectCPUProfile(30 * time.Second)
			case <-ctx.Done():
				return
			}
		}
	}()

	// Handle signals
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	errCh := make(chan error, 1)
	go func() {
		errCh <- app(ctx)
	}()

	select {
	case err := <-errCh:
		return err
	case <-sigCh:
		cancel()
		return nil
	}
}

// PGO-friendly code patterns
// These patterns benefit most from PGO optimization:

// 1. Interface calls with single concrete type (devirtualization)
type Processor interface {
	Process(data []byte) ([]byte, error)
}

type FastProcessor struct{}

func (p *FastProcessor) Process(data []byte) ([]byte, error) {
	// PGO will inline this if FastProcessor is the dominant type
	return data, nil
}

// 2. Hot loops with function calls
func HotLoop(data []int, fn func(int) int) []int {
	result := make([]int, len(data))
	for i, v := range data {
		result[i] = fn(v) // PGO inlines fn if it's always the same function
	}
	return result
}

// 3. Branch prediction hints
func ProcessWithBranching(data []byte) int {
	count := 0
	for _, b := range data {
		if b > 128 { // PGO knows this branch probability from profiles
			count++
		}
	}
	return count
}

// Makefile target for PGO build
const PGOMakefile = \`
# PGO Build Process
.PHONY: build-pgo collect-profile

# Step 1: Normal build
build:
	go build -o app .

# Step 2: Collect profile from production
collect-profile:
	curl -o cpu.pprof http://prod-server/debug/pprof/profile?seconds=30

# Step 3: PGO-optimized build
build-pgo:
	go build -pgo=cpu.pprof -o app-pgo .

# Step 4: Benchmark comparison
bench-compare:
	go test -bench=. -count=5 | tee baseline.txt
	go test -bench=. -count=5 -pgo=cpu.pprof | tee pgo.txt
	benchstat baseline.txt pgo.txt
\`

// GOGC and PGO interaction
func OptimizeWithPGO() {
	// PGO affects:
	// 1. Function inlining decisions (based on hot paths)
	// 2. Devirtualization of interface calls
	// 3. Memory layout of frequently-accessed structs
	// 4. Branch prediction hints

	// Measure improvement
	runtime.GC() // Force GC before benchmark
}
\`\`\`

### Adoption Story

PGO is the highest-effort, highest-reward feature in this chapter. The 5 to 15 percent CPU gains are real for hot services, but the engineering cost is the profile-collection pipeline. Three pre-conditions for adoption:

1. **A representative production profile.** A profile from a load test that does not match production traffic produces the wrong inlining decisions. The collection has to come from real traffic at a representative load.
2. **A profile-update cadence.** Profiles drift as the service evolves. A profile from six months ago is worse than no profile. Set a refresh cadence (monthly is typical) and automate the collection.
3. **A measurement discipline.** Track CPU usage before and after PGO, and re-validate after every refresh. The discipline is "PGO is on, and we know how much it is buying us".

The cost-benefit math: PGO is worth it for the top three to five hot services in your fleet. For everything else, the engineering cost exceeds the benefit. The exception is when the toolchain or framework you use ships with PGO baked in (some Go web frameworks now do this), in which case you get the benefit for free.

### Code-Review Lens (Senior Track)

Two patterns to flag:

1. **A PR that adds PGO without a refresh process.** The PR introduces a maintenance burden that nobody owns. Require an owner and a refresh cadence as part of the PR description.
2. **Inlining-sensitive code that depends on PGO for performance.** If the function is so hot that PGO inlining is necessary, consider whether the structural fix (manual inlining, tighter API) is more durable. PGO is a tuning lever, not a substitute for design.

### Migration Lens

PGO has analogues in JVM (HotSpot's tiered compilation), .NET (tiered compilation plus dynamic PGO), and LLVM-based languages (Profile-Guided Optimization in Clang). Go's PGO is closer to the LLVM model: a separate profile-collection pass, then a re-build with the profile as input. The benefit is similar magnitude (single-digit-percent CPU savings on hot paths), with similar pre-conditions (representative profile, refresh discipline).

---
`;
