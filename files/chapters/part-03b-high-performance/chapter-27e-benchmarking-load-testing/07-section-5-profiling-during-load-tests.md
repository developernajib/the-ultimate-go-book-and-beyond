## Section 5: Profiling During Load Tests

### 5.1 Auto-Profile on Threshold Breach

Automatically capturing a CPU or heap profile when a request exceeds a latency threshold produces a profile from the exact conditions that cause the problem, unlike manual profiling which requires reproducing the issue on demand. The middleware below starts a 10-second CPU profile whenever a request exceeds the configured threshold, writes the profile to a time-stamped file, and uses an atomic flag to prevent concurrent profile captures from exhausting disk space. This technique is especially useful for intermittent slowdowns that are difficult to reproduce.

```go
package autoprofile

import (
	"fmt"
	"net/http"
	netpprof "net/http/pprof" // Registers handlers; imported for explicit wiring below.
	"os"
	"runtime/pprof"
	"sync/atomic"
	"time"
)

// LatencyTriggeredProfiler automatically captures CPU/heap profiles
// when latency exceeds a threshold. Ideal for production debugging.
type LatencyTriggeredProfiler struct {
	threshold time.Duration
	profiling atomic.Bool
	outputDir string
}

func NewLatencyTriggeredProfiler(threshold time.Duration, outputDir string) *LatencyTriggeredProfiler {
	return &LatencyTriggeredProfiler{
		threshold: threshold,
		outputDir: outputDir,
	}
}

// ObserveLatency checks if latency exceeds threshold and triggers profiling.
func (p *LatencyTriggeredProfiler) ObserveLatency(latency time.Duration) {
	if latency < p.threshold {
		return
	}
	if !p.profiling.CompareAndSwap(false, true) {
		return // Already profiling.
	}
	go p.captureProfile()
}

func (p *LatencyTriggeredProfiler) captureProfile() {
	defer p.profiling.Store(false)

	timestamp := time.Now().Format("20060102-150405")

	// CPU profile.
	cpuFile, err := os.Create(fmt.Sprintf("%s/cpu-%s.prof", p.outputDir, timestamp))
	if err == nil {
		pprof.StartCPUProfile(cpuFile)
		time.Sleep(10 * time.Second) // Profile for 10 seconds.
		pprof.StopCPUProfile()
		cpuFile.Close()
		fmt.Printf("CPU profile saved: %s/cpu-%s.prof\n", p.outputDir, timestamp)
	}

	// Heap profile.
	heapFile, err := os.Create(fmt.Sprintf("%s/heap-%s.prof", p.outputDir, timestamp))
	if err == nil {
		pprof.WriteHeapProfile(heapFile)
		heapFile.Close()
		fmt.Printf("Heap profile saved: %s/heap-%s.prof\n", p.outputDir, timestamp)
	}
}

// Middleware wraps an HTTP handler with automatic profiling on slow requests.
func (p *LatencyTriggeredProfiler) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		latency := time.Since(start)
		p.ObserveLatency(latency)
	})
}

// PPROFEndpoints registers the pprof handlers on mux explicitly.
//
// The idiom you will see in the wild is:
//
//	mux.Handle("/debug/pprof/", http.DefaultServeMux)
//
// Do not copy it. It is wrong twice.
//
//  1. It only works as a side effect of `import _ "net/http/pprof"`, whose init
//     registers onto DefaultServeMux. Miss that import, as the first draft of
//     this example did, and every /debug/pprof/ request 404s while the code
//     looks correct.
//  2. It forwards the whole DefaultServeMux, not just pprof. Anything any
//     dependency ever registered there is now reachable through your admin
//     port. Handing a global, transitively-populated mux a route prefix is not
//     something you can reason about.
//
// Register the handlers by name. It is three more lines and it means exactly
// what it says.
//
// SECURITY. These endpoints must never be reachable from the internet:
//   - /debug/pprof/heap returns live heap contents, which routinely include
//     tokens, keys, and customer PII sitting in buffers.
//   - /debug/pprof/profile blocks and burns CPU for `seconds`, so an
//     unauthenticated attacker has a trivial DoS.
//   - /debug/pprof/goroutine?debug=2 dumps every stack, mapping your internals.
//
// Bind this mux to a separate listener on localhost or a private interface,
// behind authentication, and never on the port serving user traffic. Serving
// pprof from the main listener also means profiling contends with the requests
// you are trying to measure.
func (p *LatencyTriggeredProfiler) PPROFEndpoints(mux *http.ServeMux) {
	mux.HandleFunc("/debug/pprof/", netpprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", netpprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", netpprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", netpprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", netpprof.Trace)
}
```

### 5.2 Continuous Profiling Setup

Continuous profiling captures low-overhead profiles in production on a rolling basis, enabling retrospective analysis of performance regressions without traffic replay. Overhead is low enough that always-on is the norm, but treat any specific percentage you read (including from vendors) as a starting hypothesis and measure it against your own service before committing to it. Open-source tools like Parca and Pyroscope integrate with Go's `pprof` endpoint, uploading profiles to a central store with service-version labels for side-by-side comparison. The code below shows a periodic profiler that captures CPU profiles at regular intervals, along with the Pyroscope SDK configuration for always-on production profiling.

```go
package continuous_profiling

import (
	"context"
	"fmt"
	"os"
	"runtime/pprof"
	"time"
)

// PeriodicProfiler captures profiles at regular intervals.
// Use for diagnosing performance degradation over time.
// In production: use Pyroscope or Parca for always-on profiling.
type PeriodicProfiler struct {
	interval  time.Duration
	duration  time.Duration
	outputDir string
	cancel    context.CancelFunc
}

func NewPeriodicProfiler(interval, duration time.Duration, outputDir string) *PeriodicProfiler {
	return &PeriodicProfiler{
		interval:  interval,
		duration:  duration,
		outputDir: outputDir,
	}
}

// Start begins periodic profiling in the background.
func (p *PeriodicProfiler) Start() {
	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel

	go func() {
		ticker := time.NewTicker(p.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				p.captureOneCPUProfile()
			case <-ctx.Done():
				return
			}
		}
	}()
}

func (p *PeriodicProfiler) captureOneCPUProfile() {
	ts := time.Now().Format("20060102-150405")
	path := fmt.Sprintf("%s/cpu-%s.prof", p.outputDir, ts)

	f, err := os.Create(path)
	if err != nil {
		return
	}
	defer f.Close()

	if err := pprof.StartCPUProfile(f); err != nil {
		return
	}
	time.Sleep(p.duration)
	pprof.StopCPUProfile()
}

// Stop stops periodic profiling.
func (p *PeriodicProfiler) Stop() {
	if p.cancel != nil {
		p.cancel()
	}
}

// PyroscopeConfig documents integration with Pyroscope (always-on profiling).
// It samples CPU profiles continuously, at an overhead low enough that always-on
// is standard practice. Measure it on your own service rather than trusting a
// quoted figure: cost scales with sample rate and with how deep your stacks are.
const PyroscopeIntegration = `
import "github.com/grafana/pyroscope-go"

func main() {
    pyroscope.Start(pyroscope.Config{
        ApplicationName: "myservice",
        ServerAddress:   "http://pyroscope:4040",
        Logger:          pyroscope.StandardLogger,
        ProfileTypes: []pyroscope.ProfileType{
            pyroscope.ProfileCPU,
            pyroscope.ProfileAllocObjects,
            pyroscope.ProfileAllocSpace,
            pyroscope.ProfileInuseObjects,
            pyroscope.ProfileInuseSpace,
            pyroscope.ProfileGoroutines,
        },
    })
    // ... start your server
}

// Access flamegraphs at http://pyroscope:4040
// Compare time ranges to identify regressions.
`
```

### 5.3 Flight Recorder for Continuous Runtime Traces

Execution traces (`runtime/trace`) capture every scheduler event, GC phase, goroutine block, and syscall boundary. They are far richer than pprof profiles but have historically been too expensive to run continuously. Go 1.22 cut the runtime overhead of tracing to roughly 1-2%, and Go 1.25 promoted the **FlightRecorder** API (previously in `golang.org/x/exp/trace`) to `runtime/trace`. The flight recorder runs a rolling in-memory trace buffer of the last few seconds of execution and dumps it to disk on demand, which is exactly the right primitive for post-mortem analysis of latency spikes that cannot be reproduced on demand.

```go
package flightrecorder_demo

import (
	"context"
	"net/http"
	"os"
	"runtime/trace" // Go 1.25+ hosts FlightRecorder here. Pre-1.25 use golang.org/x/exp/trace.
	"time"
)

// Recorder keeps a rolling 5-second trace buffer in memory and snapshots it
// whenever a slow-path condition fires (SLO breach, panic recovery, alert webhook).
type Recorder struct {
	fr *trace.FlightRecorder
}

func NewRecorder() (*Recorder, error) {
	// Both fields are hints, not guarantees. The docs are explicit that MaxBytes
	// "does not guarantee memory overheads will always stay below MaxBytes", and
	// that MaxBytes takes precedence over MinAge. So budget headroom rather than
	// treating 10 MiB as a hard ceiling.
	//
	// Also: at most one flight recorder may be active per process. If a library
	// in your dependency tree starts one, yours fails at Start.
	fr := trace.NewFlightRecorder(trace.FlightRecorderConfig{
		MinAge:   5 * time.Second,
		MaxBytes: 10 << 20, // 10 MiB target.
	})
	if err := fr.Start(); err != nil {
		return nil, err
	}
	return &Recorder{fr: fr}, nil
}

// Snapshot writes the last few seconds of runtime events to path.
// Open in `go tool trace path` for a full scheduler timeline.
func (r *Recorder) Snapshot(path string) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = r.fr.WriteTo(f)
	return err
}

// SnapshotOnBreach wires the flight recorder into a latency-triggered snapshot path.
func (r *Recorder) SnapshotOnBreach(ctx context.Context, threshold time.Duration) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		start := time.Now()
		// ... serve request upstream ...
		if time.Since(start) > threshold {
			_ = r.Snapshot("/var/log/traces/breach-" + start.Format("20060102-150405") + ".trace")
		}
	}
}
```

**When to reach for flight recorder over pprof**: pprof tells you where CPU time went. The execution trace tells you *why* a goroutine sat blocked for 40 ms when no CPU was busy. Classic cases where flight recorder wins are rare GC assists stalling a latency-sensitive request, channel send-side blocking that pprof can't see, and network-poller wake-up anomalies. Keep overhead in mind: continuous recording costs a few percent of CPU, so leave it off by default in very hot paths and enable it per-instance via a runtime flag.

### 5.4 Junior → FAANG: profiling during a load test without crashing the box

A common junior mistake is to enable full pprof CPU sampling on the same process and port that is serving load test traffic, then watch p99 go to infinity and not understand why. Three rules save you. First, run pprof on a separate admin port (the service's main listener and `/debug/pprof` should never share a port under load). Second, keep CPU profile duration short (30 seconds is plenty, an hour is masochism). Third, never enable block or mutex profiling in production without a sampling rate. Both record nothing by default (`SetBlockProfileRate` and `SetMutexProfileFraction` are 0 until you set them), and that default is a deliberate kindness: turned fully on, they instrument every blocking event and every contended unlock, which on a contended path is expensive enough to change the behavior you are measuring. Set a fraction, and measure the overhead on your own service before leaving it on. With these three rules, you can profile during a live load test without perturbing the measurements. Without them, your profile will document a service stressed by its own observation.

### 5.5 Senior @ FAANG: the post-incident profile that answers "what happened"

The most valuable profile is the one you captured during the incident, not the one you tried to reproduce afterwards. For any service whose SLO you care about, wire up three mechanisms: (1) continuous profiling (Pyroscope, Parca, Datadog Continuous Profiler). (2) the flight recorder described in 5.3 with a 5 to 10 second in-memory buffer, snapshotted on every 5xx or latency breach. (3) an auto-capture middleware that writes a heap profile plus a goroutine dump on every SLO-breaching response. Measure the cumulative overhead on your own service and treat that measurement as the thing you defend in review, because the number depends on your stack depth, allocation rate, and sample rates, and no figure copied from a book or a vendor page survives contact with a specific workload. The payoff is that when a 3 AM incident happens, you open the continuous profiler at the incident timestamp and see exactly what the service was doing. Teams that have this wired rarely have "we do not know what caused it" post-mortems. Teams that do not, spend hours after every incident trying to reproduce what the observability layer should have captured in real time.

---
