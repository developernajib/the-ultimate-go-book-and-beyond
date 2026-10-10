## 105E.6 Continuous Profiling with Pyroscope

Continuous profiling captures CPU and memory profiles from production services at low overhead (~1-2% CPU) and stores them as flame graphs queryable by time range, allowing you to correlate a latency spike visible in traces with the specific function responsible for the CPU or allocation increase. The Pyroscope Go client below configures push-based profiling that runs alongside the application, tags profiles with service name and environment labels for multi-service comparison, and integrates with Grafana so profiles can be linked directly from trace spans.

```go
package profiling

import (
	"context"
	"fmt"
	"net/http"
	"runtime"
	"runtime/pprof"
	runtimetrace "runtime/trace"
	"time"

	"github.com/grafana/pyroscope-go"
)

// ProfilerConfig holds profiling configuration
type ProfilerConfig struct {
	ServerAddress string
	AppName       string
	ProfileTypes  []pyroscope.ProfileType
	Logger        pyroscope.Logger
	Tags          map[string]string
}

// SetupPyroscope initializes continuous profiling with Pyroscope
func SetupPyroscope(config ProfilerConfig) (*pyroscope.Profiler, error) {
	if len(config.ProfileTypes) == 0 {
		config.ProfileTypes = []pyroscope.ProfileType{
			pyroscope.ProfileCPU,
			pyroscope.ProfileInuseObjects,
			pyroscope.ProfileAllocObjects,
			pyroscope.ProfileInuseSpace,
			pyroscope.ProfileAllocSpace,
			pyroscope.ProfileGoroutines,
			pyroscope.ProfileMutexCount,
			pyroscope.ProfileMutexDuration,
			pyroscope.ProfileBlockCount,
			pyroscope.ProfileBlockDuration,
		}
	}

	profiler, err := pyroscope.Start(pyroscope.Config{
		ApplicationName: config.AppName,
		ServerAddress:   config.ServerAddress,
		Logger:          config.Logger,
		Tags:            config.Tags,
		ProfileTypes:    config.ProfileTypes,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to start Pyroscope: %w", err)
	}

	// Enable Go runtime profiling
	runtime.SetMutexProfileFraction(1)
	runtime.SetBlockProfileRate(1)

	return profiler, nil
}

// ProfiledSection wraps a code section with profiling labels
func ProfiledSection(ctx context.Context, labels map[string]string, fn func(context.Context)) {
	pyroscope.TagWrapper(ctx, pyroscope.Labels(flattenLabels(labels)...), fn)
}

func flattenLabels(labels map[string]string) []string {
	result := make([]string, 0, len(labels)*2)
	for k, v := range labels {
		result = append(result, k, v)
	}
	return result
}

// PProfHandler provides on-demand profiling via HTTP
type PProfHandler struct{}

// ServeHTTP handles pprof requests
func (h *PProfHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	profileType := r.URL.Query().Get("type")
	durationStr := r.URL.Query().Get("duration")

	duration, err := time.ParseDuration(durationStr)
	if err != nil || duration <= 0 {
		duration = 30 * time.Second
	}

	switch profileType {
	case "cpu":
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", "attachment; filename=cpu.prof")
		if err := pprof.StartCPUProfile(w); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		time.Sleep(duration)
		pprof.StopCPUProfile()

	case "heap":
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", "attachment; filename=heap.prof")
		runtime.GC()
		if err := pprof.WriteHeapProfile(w); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
		}

	case "goroutine":
		w.Header().Set("Content-Type", "text/plain")
		p := pprof.Lookup("goroutine")
		if p == nil {
			http.Error(w, "goroutine profile not available", http.StatusInternalServerError)
			return
		}
		p.WriteTo(w, 2)

	case "trace":
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", "attachment; filename=trace.out")
		if err := runtimetrace.Start(w); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		time.Sleep(duration)
		runtimetrace.Stop()

	default:
		http.Error(w, "unknown profile type", http.StatusBadRequest)
	}
}

// FlameGraphAnalyzer processes pprof data for flamegraph rendering
type FlameGraphAnalyzer struct{}

// MemoryLeakDetector uses runtime stats to detect memory leaks
type MemoryLeakDetector struct {
	samples []runtime.MemStats
	interval time.Duration
}

// NewMemoryLeakDetector creates a memory leak detector
func NewMemoryLeakDetector(interval time.Duration) *MemoryLeakDetector {
	return &MemoryLeakDetector{
		interval: interval,
	}
}

// Start begins collecting memory stats
func (d *MemoryLeakDetector) Start(ctx context.Context) {
	ticker := time.NewTicker(d.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			var stats runtime.MemStats
			runtime.ReadMemStats(&stats)
			d.samples = append(d.samples, stats)

			if len(d.samples) > 30 {
				d.samples = d.samples[1:]
			}

			if len(d.samples) >= 10 {
				if d.detectLeak() {
					fmt.Printf("MEMORY LEAK DETECTED: HeapAlloc is consistently growing\n")
					// In production: send alert
				}
			}

		case <-ctx.Done():
			return
		}
	}
}

// detectLeak checks if heap allocation is monotonically increasing
func (d *MemoryLeakDetector) detectLeak() bool {
	if len(d.samples) < 5 {
		return false
	}

	// Check if last 5 samples show consistent growth
	for i := len(d.samples)-4; i < len(d.samples); i++ {
		if d.samples[i].HeapAlloc <= d.samples[i-1].HeapAlloc {
			return false
		}
	}

	return true
}

// GoroutineLeakDetector detects goroutine leaks
type GoroutineLeakDetector struct {
	baseline int
	samples  []int
}

// NewGoroutineLeakDetector creates a goroutine leak detector
func NewGoroutineLeakDetector() *GoroutineLeakDetector {
	return &GoroutineLeakDetector{
		baseline: runtime.NumGoroutine(),
	}
}

// Check checks for goroutine leaks
func (d *GoroutineLeakDetector) Check() *GoroutineLeak {
	current := runtime.NumGoroutine()
	d.samples = append(d.samples, current)

	if len(d.samples) > 60 {
		d.samples = d.samples[1:]
	}

	if len(d.samples) < 10 {
		return nil
	}

	// Detect consistent growth above baseline
	recentAvg := avg(d.samples[len(d.samples)-5:])
	if recentAvg > float64(d.baseline)*1.5 {
		return &GoroutineLeak{
			Baseline: d.baseline,
			Current:  current,
			Growth:   current - d.baseline,
		}
	}

	return nil
}

// GoroutineLeak represents a detected goroutine leak
type GoroutineLeak struct {
	Baseline int
	Current  int
	Growth   int
}

func avg(values []int) float64 {
	sum := 0
	for _, v := range values {
		sum += v
	}
	return float64(sum) / float64(len(values))
}
```

### Junior → FAANG: When to Reach for Continuous Profiling vs Distributed Tracing

Distributed tracing tells you that a specific request was slow and which span contributed most of that latency. Continuous profiling tells you why that span was slow at the CPU level. They are complementary tools that answer different questions. If a span named "compute recommendations" took 800ms, tracing tells you it was slow but not why. A CPU flame graph linked to that trace via Pyroscope shows that 600ms was spent in a JSON unmarshaling function that was called 40,000 times inside the span. That is the actionable insight that tracing alone cannot provide.

For first-job practice, set up Pyroscope locally alongside a simple Go HTTP server and generate a CPU flame graph. Learn to read the flame graph from bottom to top: the base of the stack is `main`, and the widest bar in the middle of the stack is the hottest code path. Any function that occupies more than 10% of total CPU time is worth investigating.

### Senior @ FAANG: Continuous Profiling as a Production Performance Governance Tool

At L6, continuous profiling is not a debugging tool used during incidents. It is a production governance tool used proactively to detect performance regressions before they become user-visible latency increases. The workflow is: configure Pyroscope to continuously sample CPU and memory allocation profiles from every production replica at a low sampling rate (10ms sampling interval, 1% overhead), store profiles with 30-day retention, and tag each profile with the service version. After every deployment, run an automated comparison of the new version's CPU profile against the previous version's profile using Pyroscope's diff API. Alert when any function's CPU share increases by more than 20% relative to the baseline.

The trace-to-profile linking feature (setting `pyroscope.labels` to match the OTel trace ID) is the key integration that makes this governance tool actionable. Without the link, a flame graph is a static snapshot of the entire service's CPU behavior aggregated across all requests. With the link, an engineer investigating a slow trace can click from the Jaeger span directly to the CPU profile captured during that specific request, seeing exactly which functions ran during the slow span. This workflow compression means that a performance regression that previously required a dedicated profiling session (blocking a senior engineer for half a day) can be investigated and attributed in under 15 minutes.

The memory allocation profiler is equally important but less commonly used. Go's GC pause time is proportional to the number of live objects, not object size. A service that allocates many small, short-lived objects (common in JSON parsing and HTTP request handling) will have higher GC overhead than one that allocates fewer, larger objects. The allocation profile shows the allocation rate per call site, enabling targeted optimization of the highest-allocation code paths. A well-run platform team tracks allocation profile trends across releases alongside CPU profiles to catch GC regression before users notice increased tail latency.

---
