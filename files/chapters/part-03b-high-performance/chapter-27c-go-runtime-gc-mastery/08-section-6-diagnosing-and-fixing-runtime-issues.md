## Section 6: Diagnosing and Fixing Runtime Issues

### 6.1 High GC Pause Diagnostic

High GC pause times manifest as latency spikes that appear in the p99.9 histogram without corresponding CPU or I/O anomalies, making them easy to misdiagnose as network jitter. The diagnostic procedure starts with `GODEBUG=gctrace=1` to confirm pause duration and frequency, then moves to a heap profile to identify the largest live object sets that dominate scan time. The workflow below walks through reading `gctrace` output, correlating GC pauses with request latency spikes in the Prometheus timeline, and using the heap profile to identify the root allocations driving large heap size.

```go
package diagnostics

import (
	"fmt"
	"runtime"
	"runtime/metrics"
	"strings"
	"time"
)

// GCPauseMonitor monitors for GC pauses exceeding a threshold.
// On threshold breach, it dumps diagnostic information.
//
// A monitor must never change the thing it monitors. That sounds obvious
// and it is violated constantly, in one specific way worth calling out:
// there is no debug.GetGCPercent(). The only way to "read" GOGC through
// package debug is debug.SetGCPercent(v), which returns the previous value
// while setting a new one. So the trick you will see in the wild,
//
//	gogc := debug.SetGCPercent(-1) // "read" it
//	debug.SetGCPercent(100)        // "restore" it
//
// has two bugs in two lines. The first line DISABLES the collector for as
// long as it takes to run the second, and the second restores 100 rather
// than gogc, silently discarding an operator's GOGC=200. A diagnostic that
// turns off the GC and resets your tuning is a worse outage than the one
// it was added to detect.
//
// Read it from runtime/metrics instead (/gc/gogc:percent), which is a pure
// read. That is what gogcPercent below does.
type GCPauseMonitor struct {
	threshold time.Duration
	handler   func(pause time.Duration, snapshot string)
	stop      chan struct{}
}

// gogcPercent reads GOGC without modifying it.
// Returns -1 when GC is off (the metric reports MaxUint64 in that case).
func gogcPercent() int64 {
	s := []metrics.Sample{{Name: "/gc/gogc:percent"}}
	metrics.Read(s)
	if s[0].Value.Kind() != metrics.KindUint64 {
		return -1
	}
	v := s[0].Value.Uint64()
	if v > uint64(1<<62) { // GC disabled
		return -1
	}
	return int64(v)
}

func NewGCPauseMonitor(threshold time.Duration, handler func(time.Duration, string)) *GCPauseMonitor {
	return &GCPauseMonitor{
		threshold: threshold,
		handler:   handler,
		stop:      make(chan struct{}),
	}
}

// Start polls MemStats on a ticker.
//
// Know what this costs. runtime.ReadMemStats stops the world to take its
// snapshot, so a 100ms poll adds a small STW pause ten times a second to
// watch for STW pauses. At this interval that is an acceptable trade for a
// diagnostic you enable during an investigation. It is not something to
// leave running at a tighter interval forever. The zero-cost alternative
// is the /gc/pauses:seconds histogram in runtime/metrics, which does not
// stop the world and gives you the whole distribution rather than the last
// 256 samples.
func (m *GCPauseMonitor) Start() {
	go func() {
		var lastNumGC uint32
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()

		for {
			select {
			case <-ticker.C:
				var ms runtime.MemStats
				runtime.ReadMemStats(&ms)

				if ms.NumGC > lastNumGC {
					// Walk the cycles completed since the last tick.
					//
					// Index carefully. The docs define the most recent
					// pause as PauseNs[(NumGC+255)%256], so cycle number n
					// lives at (n+255)%256. This loop runs i from
					// lastNumGC to NumGC-1, which means cycle n = i+1, and
					// therefore idx = (i+1+255)%256, which reduces to
					// i%256. Off-by-one here does not crash, it silently
					// reports the wrong cycle's pause, which is worse.
					for i := lastNumGC; i < ms.NumGC; i++ {
						idx := i % 256
						pause := time.Duration(ms.PauseNs[idx])
						if pause > m.threshold {
							snapshot := fmt.Sprintf(
								"GC Pause Alert: %v\n"+
									"NumGC=%d HeapInuse=%dMB HeapObjects=%d\n"+
									"NextGC=%dMB GOGC=%d",
								pause,
								ms.NumGC,
								ms.HeapInuse/1024/1024,
								ms.HeapObjects,
								ms.NextGC/1024/1024,
								gogcPercent(), // Pure read, does not touch the GC.
							)
							m.handler(pause, snapshot)
						}
					}
					lastNumGC = ms.NumGC
				}
			case <-m.stop:
				return
			}
		}
	}()
}

func (m *GCPauseMonitor) Stop() {
	close(m.stop)
}

// On finding allocation hotspots: do not write this yourself.
//
// It is tempting to put an AnalyzeHeapProfile() helper here that returns a
// ranked list of allocation sites. Any such function short enough for a
// book would have to return hardcoded example data, and a function that
// returns invented numbers while being named like it measures something is
// the most dangerous shape of code in a performance chapter. Someone
// eventually calls it and believes the output.
//
// The tooling already does this properly. To rank allocation sites by
// total bytes allocated over the process lifetime:
//
//	go tool pprof -sample_index=alloc_space -top -nodecount=20 \
//	    http://host:6060/debug/pprof/heap
//
// Swap in -sample_index=alloc_objects to rank by allocation COUNT instead,
// which is what you want when GC pressure rather than footprint is the
// problem: a million 16-byte allocations hurt the collector far more than
// one 16MB buffer, and only the alloc_objects view shows that.
//
// The four sample indexes in a heap profile, and when each is the right
// one to look at:
//
//	alloc_space   Total bytes allocated since start. Finds churn.
//	alloc_objects Total objects allocated since start. Finds GC pressure.
//	inuse_space   Bytes live at profile time. Finds leaks and footprint.
//	inuse_objects Objects live at profile time. Finds retention of many
//	              small objects.
//
// "My RSS is growing" is an inuse_space question. "My GC CPU is high" is
// an alloc_objects question. Reaching for the wrong index is the single
// most common way an engineer stares at a correct profile and concludes
// the wrong thing.

// GoroutineLeakDiagnostic identifies likely goroutine leaks.
type GoroutineLeakDiagnostic struct {
	TotalGoroutines int
	ByState         map[string]int
	TopBlockSites   []string
}

// DiagnoseGoroutines groups live goroutines by wait state.
//
// runtime.Stack(buf, true) stops the world for the whole dump, and the
// cost grows with goroutine count. On a process with hundreds of thousands
// of goroutines this is a real pause, so treat it as an investigation tool
// and not as something to call from a metrics scrape.
//
// Parse the header line rather than grepping the whole dump. Each
// goroutine's header looks like:
//
//	goroutine 42 [chan receive, 5 minutes]:
//
// so the state lives in brackets on that line only. Substring-searching the
// entire dump for "select" instead would also match every function name
// and file path containing the word, which is how you end up reporting
// more goroutines in a state than exist in the process.
//
// The ", N minutes" suffix is the highest-signal part of a leak hunt: the
// runtime only prints it for goroutines blocked long enough to be
// suspicious, so it is stripped for grouping here but is what you read
// first when eyeballing the raw dump.
func DiagnoseGoroutines() GoroutineLeakDiagnostic {
	total := runtime.NumGoroutine()

	// Size the buffer to fit the whole dump. runtime.Stack truncates
	// silently if the buffer is short, and a truncated dump quietly
	// undercounts exactly the leak you are hunting.
	buf := make([]byte, 1<<20)
	for {
		n := runtime.Stack(buf, true)
		if n < len(buf) {
			buf = buf[:n]
			break
		}
		buf = make([]byte, 2*len(buf))
	}

	states := make(map[string]int)
	for _, line := range strings.Split(string(buf), "\n") {
		if !strings.HasPrefix(line, "goroutine ") {
			continue
		}
		open := strings.IndexByte(line, '[')
		close := strings.LastIndexByte(line, ']')
		if open < 0 || close < open {
			continue
		}
		state := line[open+1 : close]
		// Drop the duration suffix: "chan receive, 5 minutes".
		if comma := strings.IndexByte(state, ','); comma >= 0 {
			state = state[:comma]
		}
		states[state]++
	}

	return GoroutineLeakDiagnostic{
		TotalGoroutines: total,
		ByState:         states,
	}
}

// MemoryLeakDiagnostic compares two heap snapshots to identify growing allocations.
type MemoryLeakDiagnostic struct {
	Before     runtime.MemStats
	After      runtime.MemStats
	GrowthBytes uint64
	GrowthPct  float64
}

func TakeHeapSnapshot() runtime.MemStats {
	runtime.GC() // Force GC for accurate reading.
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	return ms
}

func CompareSnapshots(before, after runtime.MemStats) MemoryLeakDiagnostic {
	growth := after.HeapInuse - before.HeapInuse
	var growthPct float64
	if before.HeapInuse > 0 {
		growthPct = float64(growth) / float64(before.HeapInuse) * 100
	}
	return MemoryLeakDiagnostic{
		Before:      before,
		After:       after,
		GrowthBytes: growth,
		GrowthPct:   growthPct,
	}
}
```

### 6.2 Common Runtime Issues and Fixes

The most common runtime issues in production Go services are goroutine leaks (goroutines blocked on a channel or mutex that will never be signaled), memory leaks (growing slices or maps that are never cleared), and excessive GC pauses (from large heap objects or high allocation rates). Each has a characteristic diagnostic signature: goroutine leaks show a monotonically increasing goroutine count in `/debug/pprof/goroutine`. Memory leaks appear as a rising resident set size. GC pauses correlate with heap size in `gctrace` output. The remediation patterns below address each issue with the corresponding diagnostic command and code fix.

```go
package runtime_issues

import (
	"context"
	"io"
	"net/http"
	"sync"
	"time"
)

// ISSUE 1: Connection and goroutine leak via unclosed response bodies.
//
// An unclosed Body means the connection never returns to the idle pool.
// Each live connection carries a readLoop and a writeLoop goroutine in
// net/http's transport, so the leak shows up in a goroutine dump as a pile
// of goroutines parked in net/http.(*persistConn).readLoop. Once the pool
// is exhausted the symptom mutates into request latency, which is why this
// gets misdiagnosed as a slow upstream.

func badHTTPClient(url string) ([]byte, error) {
	resp, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	// BAD: Body is never closed, so the connection is never reused.
	_ = resp
	return nil, nil
}

func goodHTTPClient(url string) ([]byte, error) {
	resp, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close() // ALWAYS close the body.

	// Closing alone is not quite enough for connection reuse. The
	// transport can only reuse a connection once the body is read to EOF,
	// so drain it. io.ReadAll does that for you here - if you intend to
	// discard the body, io.Copy(io.Discard, resp.Body) is the explicit
	// version. Closing early without draining forces the transport to
	// tear the connection down instead of pooling it.
	return io.ReadAll(resp.Body)
}

// ISSUE 2: Goroutine leak via abandoned channels.
// Goroutine blocks on a channel that will never be written to.
func badWorker(jobs <-chan int) {
	go func() {
		for job := range jobs { // If jobs is never closed, goroutine leaks.
			processJob(job)
		}
	}()
}

func goodWorker(ctx context.Context, jobs <-chan int) {
	go func() {
		for {
			select {
			case job, ok := <-jobs:
				if !ok {
					return // Channel closed - exit goroutine.
				}
				processJob(job)
			case <-ctx.Done(): // Context cancellation exits goroutine.
				return
			}
		}
	}()
}

func processJob(id int) { _ = id }

// ISSUE 3: sync.WaitGroup counter goes negative (panic).
// wg.Done() called more times than wg.Add().
func badWaitGroup() {
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		go func() {
			defer wg.Done() // BAD: wg.Add(1) not called before goroutine launch.
			// If goroutine starts before wg.Add(1), Done() panics.
		}()
		wg.Add(1) // Add AFTER goroutine launch - race condition!
	}
	wg.Wait()
}

func goodWaitGroup() {
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1) // ALWAYS Add before launching the goroutine.
		go func() {
			defer wg.Done()
		}()
	}
	wg.Wait()
}

// bestWaitGroup: since Go 1.25, WaitGroup.Go pairs the Add and the Done
// for you, which makes the whole class of bug above unrepresentable.
// Prefer it in new code.
func bestWaitGroup() {
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Go(func() {
			// Add(1) and defer Done() are handled by Go.
		})
	}
	wg.Wait()
}

// ISSUE 4: Timer not stopped → goroutine leak.
func badTimer() {
	t := time.NewTimer(1 * time.Second)
	go func() {
		<-t.C // If we return before this fires, goroutine stays alive for 1s.
	}()
	// If we exit this function, the goroutine keeps waiting.
}

func goodTimer(ctx context.Context) {
	t := time.NewTimer(1 * time.Second)
	go func() {
		select {
		case <-t.C:
			// Timer fired.
		case <-ctx.Done():
			t.Stop() // Cancel timer and exit goroutine.
			// Drain channel if Stop returned false.
			select {
			case <-t.C:
			default:
			}
		}
	}()
}

// ISSUE 5: Mutex deadlock via inconsistent lock ordering.
// Both A→B and B→A lock ordering exist → deadlock possible.
var (
	muA sync.Mutex
	muB sync.Mutex
)

func badLockOrder1() {
	muA.Lock()
	muB.Lock() // Locks in order A → B.
	muB.Unlock()
	muA.Unlock()
}

func badLockOrder2() {
	muB.Lock()
	muA.Lock() // Locks in order B → A → DEADLOCK if concurrent with badLockOrder1.
	muA.Unlock()
	muB.Unlock()
}

// Fix: Always acquire locks in the same order (alphabetical, by address, etc.)
func goodLockOrder() {
	// Always acquire muA before muB, everywhere in the codebase.
	muA.Lock()
	muB.Lock()
	muB.Unlock()
	muA.Unlock()
}
```

### 6.3 The production incident playbook

When a Go service is misbehaving in production, work top-down through a fixed playbook so you do not lose time flailing. Step one: confirm the shape of the problem numerically. Is it CPU, memory, latency, error rate, or goroutine count. Each points at a different profile type. Step two: capture profiles immediately, even before you form a hypothesis. A 30-second CPU profile, a heap profile with `runtime.GC()` beforehand, and a goroutine dump (`debug=2`) are cheap and become invaluable if the incident resolves before you understand it. Step three: look at the dashboard for correlating signals. Did RPS change. Did the pod restart. Did a deploy land in the last 15 minutes. Was a downstream dependency slow. Step four: form a hypothesis and test it with one change. Do not batch changes during an incident. Step five: once stable, write the post-incident review while the context is fresh, including both the root cause and the detection gap (what should have alerted earlier). This playbook is boring and exactly why it works. Brilliance under pressure is rarer than discipline, and the discipline is what separates a senior incident commander from an engineer who happens to be on call.

### 6.4 Junior → FAANG: the three-minute triage drill

Simulate an incident on yourself. Take a known-healthy service and artificially induce each of the following conditions one at a time: a goroutine leak (launch a goroutine per request that never exits), a GC storm (allocate a 1 MB buffer per request on a hot path), a mutex deadlock (two paths that lock A/B and B/A), a memory leak (append to a package-level slice on every request), and a CPU hot spot (a tight loop in a middleware). For each, practice the three-minute triage: dashboard, then the right profile, then a hypothesis with one testable action. After five runs, the playbook becomes reflex. This drill takes a weekend and compresses roughly a year of on-call exposure into deliberate practice. It is the single most effective thing a junior engineer can do to prepare for FAANG-level operational reviews and interviews.

### 6.5 Senior @ FAANG: the post-incident review as a tuning input

Every incident is a signal about which of your tuning assumptions is wrong. After each post-incident review, update the runtime-tuning ADR for the affected service. Did a GC pause cause the incident? Write down what the new pause budget is and how you will verify it. Did a goroutine leak cause the incident? Add a Prometheus alert on goroutine count growth rate and a runbook entry for the leak signature. Did a scheduler starvation cause the incident? Document the preemption pattern and add a fuzz test that reproduces it. Runtime tuning is not a one-time exercise. It is an ongoing conversation between your service and the runtime, mediated by incidents and review documents. Staff engineers who take this seriously have services with progressively tighter SLOs and shorter incidents over time. Staff engineers who do not have services whose incidents rhyme, because the lessons are learned individually and forgotten collectively.

---
