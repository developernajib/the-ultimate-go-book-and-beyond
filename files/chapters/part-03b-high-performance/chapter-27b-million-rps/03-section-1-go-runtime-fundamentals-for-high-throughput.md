## Section 1: Go Runtime Fundamentals for High Throughput

### 1.1 GOMAXPROCS and the Scheduler

The Go scheduler (GMP model) determines how goroutines map to OS threads. For extreme throughput, the default `GOMAXPROCS` setting is not always optimal. Since Go 1.25, the runtime reads the container CPU quota (cgroup v2 `cpu.max`) and picks a sensible default when running under Kubernetes or Docker, which fixes a long-standing pitfall where a pod limited to 2 cores still saw `GOMAXPROCS=64` on a large node.

On bare metal, `runtime.NumCPU()` counts logical CPUs, so on an SMT machine it counts hyperthreads. Hyperthreading lets two logical cores share one physical core's execution units. The commonly cited gain is on the order of 20 to 30 percent on throughput-oriented workloads, but it is extremely workload-dependent: SMT helps when threads stall on memory and leave execution units idle, and it helps very little when they are already saturating those units. It can hurt latency, because two hyperthread siblings contend for the same L1 and L2. For latency-sensitive paths, restricting `GOMAXPROCS` to the physical core count can reduce jitter. Measure it. Do not assume it.

The function below reads the physical core count from the Linux sysfs topology. Note carefully what it does not do: it reads the *host* topology, so it is wrong inside a CPU-limited container, where the kernel still reports every core on the box. Use it on bare metal or with a pinned CPU set, and rely on the runtime's own cgroup detection everywhere else.

> **Senior track**: On Go 1.25+ prefer the automatic container detection over setting `GOMAXPROCS` manually. Override only when you have measured a regression and can articulate why hyperthread siblings are hurting p99. "I read that hyperthreading is bad for latency" is not a reason, it is a hypothesis, and it is cheap to test.

```go
package runtimetuning

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// TuneRuntime pins GOMAXPROCS to the physical core count.
//
// Only call this on bare metal or with an explicitly pinned CPU set. Inside a
// CPU-limited container it is actively harmful: sysfs reports the host
// topology, not your quota, so this will happily set GOMAXPROCS=64 in a pod
// limited to 2 cores. On Go 1.25+ the runtime's own cgroup-aware default is
// correct there, and doing nothing beats doing this.
//
// Verify with a benchmark before shipping. Restricting to physical cores is a
// hypothesis about your workload, not a universal win.
func TuneRuntime() {
	n := physicalCoreCount()
	if n > 0 {
		runtime.GOMAXPROCS(n)
	}
	// If topology is unreadable, leave GOMAXPROCS alone. The runtime default
	// is a better guess than any fallback we could invent here. In particular,
	// do NOT fall back to runtime.NumCPU()/2: that assumes 2-way SMT and
	// silently halves capacity on machines that have SMT disabled or absent.
}

// physicalCoreCount counts unique (physical_package_id, core_id) pairs in the
// Linux sysfs CPU topology. Two hyperthread siblings share a core_id, so
// counting distinct pairs yields physical cores. Returns 0 when the topology
// cannot be read, which includes non-Linux platforms.
func physicalCoreCount() int {
	dirs, err := filepath.Glob("/sys/devices/system/cpu/cpu[0-9]*/topology")
	if err != nil || len(dirs) == 0 {
		return 0
	}
	seen := make(map[string]struct{}, len(dirs))
	for _, d := range dirs {
		core, err := os.ReadFile(filepath.Join(d, "core_id"))
		if err != nil {
			continue
		}
		pkg, err := os.ReadFile(filepath.Join(d, "physical_package_id"))
		if err != nil {
			continue
		}
		seen[strings.TrimSpace(string(pkg))+":"+strings.TrimSpace(string(core))] = struct{}{}
	}
	return len(seen)
}
```

### 1.2 GC Tuning for Low Pause Times

Go's garbage collector is concurrent. This single fact is the one most often lost in performance discussions, so state it plainly: the GC's cost to your service is overwhelmingly **CPU**, not pause time. There are two stop-the-world pauses per cycle, at mark setup and mark termination, and since Go 1.14 they are typically in the tens of microseconds. Stack scanning happens concurrently, per goroutine. If your p99 has a GC-shaped hole in it, the cause is almost never "a long pause". It is mark assists stealing CPU from your request handlers, or the collector simply running more often than you think.

Go 1.26 makes the "Green Tea" collector the default. It restructures the **mark** phase to scan spans of objects rather than chasing individual objects through memory, which improves locality on mark workers and reduces GC CPU by roughly 10 to 40 percent on allocation-heavy services with no code change. Two things Green Tea does not do, both widely misunderstood: it does not make allocation faster, and it does not eliminate the stop-the-world pauses. It makes marking cheaper. Separately, Go 1.27 adds a size-specialized allocator that does target allocation cost, with small allocations up to about 30 percent cheaper.

The two primary knobs, `GOGC` (heap growth ratio) and `GOMEMLIMIT` (soft memory cap), trade GC CPU overhead against heap size. Profile-guided optimization (PGO) is orthogonal to all of it and is reported by the Go team at **2 to 14 percent** depending on workload, achieved through **inlining and devirtualization**. PGO does not rearrange your structs, add branch hints, or change register allocation, whatever you may have read. Devirtualization is why interface-dispatch-heavy code such as JSON or protobuf decoding tends to land at the better end of that range.

The code below shows how to set these parameters programmatically and observe their effect.

```go
package gc_tuning

import (
	"runtime"
	"runtime/debug"
	"time"
)

// GCConfig holds GC tuning parameters.
type GCConfig struct {
	// GOGC: percentage of heap GROWTH over live heap before the next GC.
	// GOGC=100 (default): next GC when heap reaches 2x live heap.
	// GOGC=400:           next GC when heap reaches 5x live heap.
	// Higher = less frequent GC, less GC CPU, more memory.
	// At 1M RPS allocating 100B/req that is a 100MB/s allocation rate,
	// so GOGC directly sets how often you pay for a mark cycle.
	GOGCPercent int

	// GOMEMLIMIT: a SOFT memory limit (Go 1.19+). This is not a hard cap
	// and it will not prevent an OOM on its own. As the heap approaches the
	// limit the GC runs more and more aggressively, up to continuously, but
	// if live memory genuinely exceeds the limit the runtime keeps going
	// rather than killing the process. Treat it as backpressure, not a fence.
	MemLimitBytes int64

	// BalancerInterval: how often to adjust GC parameters.
	BalancerInterval time.Duration
}

// ApplyGCConfig applies GC tuning. Call at startup.
func ApplyGCConfig(cfg GCConfig) {
	if cfg.GOGCPercent > 0 {
		debug.SetGCPercent(cfg.GOGCPercent)
	}
	if cfg.MemLimitBytes > 0 {
		debug.SetMemoryLimit(cfg.MemLimitBytes)
	}
}

// ProductionGCConfig returns a STARTING POINT for a throughput-oriented
// service on a 16GB machine. These are not "sensible defaults" and you should
// not ship them unmeasured. GOGC=400 is a bet that you would rather spend
// memory than GC CPU. That bet is wrong for any service whose working set is
// already large, and it is wrong for anything latency-sensitive enough that
// the resulting bigger heap lengthens mark cycles.
func ProductionGCConfig() GCConfig {
	return GCConfig{
		// Let the heap reach 5x live heap before the next cycle.
		// Paired with GOMEMLIMIT so a live-set surprise still triggers GC
		// rather than growing unbounded.
		GOGCPercent: 400,

		// 12GB limit on 16GB machine, leaving 4GB for OS + stacks.
		MemLimitBytes: 12 * 1024 * 1024 * 1024,

		BalancerInterval: 30 * time.Second,
	}
}

// GCStats captures GC statistics for monitoring.
type GCStats struct {
	NumGC        uint32
	PauseTotal   time.Duration
	LastPause    time.Duration
	HeapInuse    uint64
	HeapReleased uint64
	HeapObjects  uint64
}

func CollectGCStats() GCStats {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	return GCStats{
		NumGC:        ms.NumGC,
		PauseTotal:   time.Duration(ms.PauseTotalNs),
		LastPause:    time.Duration(ms.PauseNs[(ms.NumGC+255)%256]),
		HeapInuse:    ms.HeapInuse,
		HeapReleased: ms.HeapReleased,
		HeapObjects:  ms.HeapObjects,
	}
}
```

### 1.3 Goroutine Pools and Worker Management

Goroutine-per-request is the right default in Go, and it stays the right default much further up the scale than folklore suggests. Be precise about why you would bound it, because the usual reason given is wrong.

The common claim is that unbounded goroutines "cause scheduling starvation" or are "10x slower". Measured, that claim does not hold up. Go's scheduler handles very large goroutine counts without falling over, and CPU-time benchmarks comparing a bounded pool against unbounded spawning on the same workload tend to come out close to 1.0x. The scheduler is genuinely good at this. The reason to bound goroutines is **memory**, and it is not subtle.

Each goroutine starts with a 2 KB stack (growing by copying, up to a 1 GB cap). Parking 200,000 goroutines and measuring `runtime.MemStats.StackSys` on the author's machine (Intel i7-10510U, Go 1.27.1, Linux) gives:

| Goroutines | StackSys | Per goroutine |
|---|---|---|
| 10,000 | 19.8 MB | 2071 B |
| 50,000 | 96.5 MB | 2024 B |
| 100,000 | 193.6 MB | 2030 B |
| 200,000 | 389.2 MB | 2041 B |

Roughly 390 MB of stacks for 200k idle goroutines, tracking the 2 KB starting stack almost exactly. That is the real failure mode: a traffic burst spawns goroutines faster than they retire, each one costs you 2 KB minimum before it has done anything, and the pod hits its memory limit and gets OOM-killed. Note also that those stacks are roots the GC must scan, so a large goroutine population raises GC cost too.

So bound goroutines for memory safety and for backpressure, not because you expect the scheduler to thank you. A bounded worker pool caps concurrency, gives callers backpressure, and turns goroutine count into a controlled parameter instead of a function of whatever traffic arrives. The pool below uses a buffered channel as both queue and semaphore, with `context.Context` support for graceful shutdown.

```go
package workerpool

import (
	"context"
	"errors"
	"runtime"
	"sync"
	"sync/atomic"
)

// Task represents a unit of work.
type Task func()

// Pool is a bounded goroutine pool.
//
// Shutdown protocol: we never close taskQueue. Closing a channel that
// producers may still be sending on is unfixable by checking a flag first,
// because the check and the send are two steps and Shutdown can land between
// them. Instead we close a separate `done` channel that both producers and
// workers select on, and producers never race a close on the queue itself.
type Pool struct {
	workers   int
	taskQueue chan Task
	done      chan struct{} // closed by Shutdown to signal "stop"
	closeOnce sync.Once
	wg        sync.WaitGroup

	// Metrics
	processed atomic.Uint64
	queued    atomic.Int64
	dropped   atomic.Uint64
}

// ErrPoolClosed is returned by SubmitWait after Shutdown.
var ErrPoolClosed = errors.New("workerpool: pool is closed")

// NewPool creates a worker pool. workers <= 0 defaults to GOMAXPROCS.
func NewPool(workers, queueSize int) *Pool {
	if workers <= 0 {
		workers = runtime.GOMAXPROCS(0)
	}
	p := &Pool{
		workers:   workers,
		taskQueue: make(chan Task, queueSize),
		done:      make(chan struct{}),
	}
	p.start()
	return p
}

func (p *Pool) start() {
	for i := 0; i < p.workers; i++ {
		p.wg.Add(1)
		go p.worker()
	}
}

// worker drains the queue until Shutdown, then drains what remains so that
// already-accepted tasks are not silently discarded.
func (p *Pool) worker() {
	defer p.wg.Done()
	for {
		select {
		case task := <-p.taskQueue:
			p.run(task)
		case <-p.done:
			// Drain the remainder without blocking, then exit.
			for {
				select {
				case task := <-p.taskQueue:
					p.run(task)
				default:
					return
				}
			}
		}
	}
}

// run executes a task and recovers from its panics. Without this, one bad
// task kills a worker permanently and the pool silently loses capacity.
func (p *Pool) run(task Task) {
	defer func() {
		p.processed.Add(1)
		p.queued.Add(-1)
		if r := recover(); r != nil {
			// In production, log this. Never let it escape.
			_ = r
		}
	}()
	task()
}

// Submit enqueues a task without blocking. Reports whether it was accepted.
// Returns false if the pool is closed or the queue is full.
func (p *Pool) Submit(task Task) bool {
	select {
	case <-p.done:
		return false
	default:
	}
	select {
	case p.taskQueue <- task:
		p.queued.Add(1)
		return true
	case <-p.done:
		return false
	default:
		p.dropped.Add(1)
		return false
	}
}

// SubmitWait submits a task, blocking until it is queued, the context is
// cancelled, or the pool shuts down. This is where backpressure lives: a
// blocked caller is the pool telling the caller to slow down.
func (p *Pool) SubmitWait(ctx context.Context, task Task) error {
	select {
	case <-p.done:
		return ErrPoolClosed
	default:
	}
	select {
	case p.taskQueue <- task:
		p.queued.Add(1)
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-p.done:
		return ErrPoolClosed
	}
}

// Shutdown stops accepting work and waits for in-flight tasks to finish.
// Safe to call concurrently with Submit/SubmitWait, and safe to call twice.
func (p *Pool) Shutdown() {
	p.closeOnce.Do(func() { close(p.done) })
	p.wg.Wait()
}

// Stats returns pool statistics.
func (p *Pool) Stats() (processed uint64, queued int64, dropped uint64) {
	return p.processed.Load(), p.queued.Load(), p.dropped.Load()
}
```

> **The shutdown race, and why the obvious fix is not a fix.** The tempting way to write `Shutdown` is `closed.Store(true)` followed by `close(taskQueue)`, with `Submit` checking `closed.Load()` before sending. This is wrong, and it is wrong in a way that will page you rather than fail a test. The check and the send are two separate steps. A producer can read `closed == false`, get descheduled, watch `Shutdown` close the queue, then resume and send on a closed channel, which panics and takes the process down. The window is small, which is exactly what makes it dangerous: it survives testing and then fires under production load, where "small window" times a million requests per second is a frequent event.
>
> There is no way to patch this by reordering or by adding more atomics around the flag, because the panic lives in the gap between the check and the send. The rule to internalize is: **the sender must never race a close on the channel it sends to.** Either the producers close, or nobody closes. The version above takes "nobody closes": a separate `done` channel signals shutdown, every producer selects on it, and `taskQueue` is left to the garbage collector. Workers drain what was already accepted before exiting, so tasks that `Submit` reported as accepted still run.
>
> The `run` wrapper matters for a similar reason. In the naive `for task := range queue { task() }` loop, one panicking task kills that worker forever, and the pool quietly loses a fraction of its capacity with no error anywhere. At 1M RPS you will not notice until throughput has dropped by a quarter.

### 1.4 The GMP model at 1M RPS in one page

At a million RPS you can no longer treat the scheduler as a black box. The three moving pieces are **G** (goroutine, 2 KB of starting stack plus bookkeeping), **M** (machine, an OS thread), and **P** (processor, a scheduling context, capped at `GOMAXPROCS`). A G runs on an M, and an M needs a P to run Go code. Runnable Gs live on a per-P local queue of 256 slots, with overflow spilling to a global queue. When a P runs out of work it becomes a thief: **idle Ps steal from busy ones**, taking half the victim's runnable Gs. The direction matters and people get it backwards. A busy P never pushes work away, an idle P comes and takes it.

Three consequences worth carrying around.

**Network I/O does not consume a thread.** This is the single most important thing about Go's networking model, and the paragraph most books get wrong. When a goroutine reads from a socket and no data is ready, it does not block an M. The runtime registers the fd with the **netpoller** (epoll on Linux, kqueue on BSD, IOCP on Windows) and parks only the G, freeing the M and P for other work. When the fd becomes ready the netpoller makes the G runnable again. This is why a Go server can hold hundreds of thousands of idle connections on a handful of threads, and it is why Go got the C10K problem right by default. It is also why reaching for `io_uring` to "fix blocking network I/O" is solving a problem you do not have.

**File I/O does consume a thread.** Regular file reads and writes, `cgo` calls, and most other genuinely blocking syscalls are different. epoll does not usefully support regular files, so these park the M. The runtime hands the P to another M from its thread pool so Go code keeps running, but the thread count grows. This is the real reason unbounded blocking syscall concurrency inflates threads well past `GOMAXPROCS`, and it is where `io_uring` genuinely does have something to offer. If your thread count is climbing, look for file or `cgo` work, not network work.

**Preemption is asynchronous since Go 1.14.** A goroutine running longer than roughly 10 ms without hitting a safe point gets preempted by signal. Before 1.14, a tight arithmetic loop containing no function calls could hold a P hostage indefinitely, which was a genuine source of latency mysteries. That class of bug is gone.

The mechanism that delivers that preemption is **`sysmon`**, a runtime monitor that also retakes Ps from long-running syscalls and forces periodic GC. Note that `sysmon` is an **OS thread, not a goroutine**, and it runs without a P. It has to be, since a goroutine needing a P could not reliably preempt a goroutine that is hogging every P.

Profile with `GODEBUG=schedtrace=1000,scheddetail=1` under a staging load test. Sustained `runqueue` values in the hundreds, or a global queue that never drains, mean you are scheduler-bound, and no amount of micro-optimizing the handler will help until you reduce goroutine count or work-unit size.

### 1.5 Junior → FAANG: the escape analysis drill

If you want one skill that compounds over a career in performance work, it is the ability to read compiler escape output. Take any hot function and run:

```bash
go build -gcflags='-m=2' ./... 2>&1 | grep -E 'escapes|moved to heap'
```

Every `moved to heap` or `escapes to heap` line is an allocation you did not ask for. Common causes: taking the address of a local and storing it in an interface, closing over a local in a goroutine, returning a pointer from a function, and assigning to a `map[string]interface{}`. The drill is simple. Pick a hot function. Read the `-m=2` output. Remove one escape (by using a stack-allocated struct, a value receiver, or a caller-provided buffer). Re-run a benchmark and confirm `allocs/op` dropped. Repeat ten times on a real codebase and you will start seeing escapes in your head while you type. This is the exact skill that differentiates a strong senior from a typical senior in FAANG performance interviews.

### 1.6 Senior @ FAANG: when tuning `GOGC` and `GOMEMLIMIT` is a trap

`GOMEMLIMIT` is powerful and frequently misused. It turns a heap-growth GC into a memory-pressure GC, so if you set it too close to the working set, the collector runs continuously and burns CPU that your p99 was counting on. This is the **GC death spiral**, and it is worth understanding precisely because the symptom points away from the cause: live memory approaches the limit, the pacer responds by collecting more often, each cycle reclaims almost nothing because the memory is genuinely live, so the heap stays near the limit, so it collects again. The service does not OOM. It burns most of its CPU on GC and appears to be suffering a latency problem. Since `GOMEMLIMIT` is a soft limit, nothing stops this, and the process will happily thrash indefinitely rather than die.

The organizational failure mode follows from that: a service runs fine for months, a feature ships that adds a few hundred MB of cache, the limit traps the service into thrash, latency degrades, and the regression is blamed on the feature rather than the knob that was set 18 months earlier by someone who has since changed teams. The feature gets reverted. The knob survives to do it again.

Staff-level discipline is to set `GOMEMLIMIT` genuinely above working set plus transient allocation, with real headroom, and then to monitor the thing that actually distinguishes this failure from a normal slowdown: the fraction of CPU going to GC.

Note that the old `go_memstats_gc_cpu_fraction` metric is gone. `MemStats.GCCPUFraction` was deprecated and client_golang removed the corresponding metric in v1.12. The current source of truth is the `runtime/metrics` package, specifically `/gc/cpu/classes/total:cpu-seconds`, a cumulative counter you rate over a window and divide by available CPU time. Expose it via `collectors.NewGoCollector(collectors.WithGoCollectorRuntimeMetrics(...))` and alert when the GC's share of CPU crosses something like 10 percent sustained. A GC line belongs in every deploy canary, monitored the same way you monitor RPS.

The same applies to `GOGC=400`. It helps only if your memory bill tolerates the bigger heap and your latency tolerates the longer mark cycles that a bigger heap implies. Record the choice, and the measured baseline that justified it, in an ADR. Otherwise the next engineer reverts it blindly during a memory scare and nobody can say what it was for.

---
