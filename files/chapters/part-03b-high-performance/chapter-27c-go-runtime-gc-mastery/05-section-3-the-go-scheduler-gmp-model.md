## Section 3: The Go Scheduler (GMP Model)

### 3.1 Scheduler Internals

The GMP (Goroutine, Machine, Processor) model maps goroutines to OS threads through a pool of logical processors (Ps), with each P maintaining a local run queue of goroutines to minimize inter-P contention on the global queue. Work-stealing balances load across Ps: an idle P steals half of a busy P's local run queue, keeping all CPUs utilized without a central scheduler bottleneck. The instrumentation below exposes per-P run queue depths and steal counts using the `runtime` package's trace events, making scheduler imbalance visible during load tests.

```go
package scheduler

import (
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// GMP Components:
//
// G (Goroutine): A lightweight user-space thread.
//   - Stack: starts 2KB, grows by copying, capped at 1GB on 64-bit
//   - State: running, runnable, waiting, dead
//   - goroutine ID: g.goid, deliberately not exposed. It is reachable by
//     parsing runtime.Stack output or by unsafe tricks against the g
//     struct layout. Both are unsupported and break without notice. The
//     omission is intentional: an exposed goroutine ID invites
//     goroutine-local storage, which the Go team considers an
//     anti-pattern. Pass a context.Context instead.
//
// M (Machine/OS Thread): An OS thread created by the runtime.
//   - One-to-one with OS threads
//   - Spawned/parked as needed
//   - Max: 10,000 by default (debug.SetMaxThreads)
//
// P (Processor): The scheduler context.
//   - Number = GOMAXPROCS
//   - Go 1.25+ defaults GOMAXPROCS to the cgroup CPU quota in containers,
//     not the host CPU count. This avoids the classic "32 Ps on a 1 CPU
//     pod" problem without relying on automaxprocs.
//   - Has a local run queue: a bounded ring buffer of 256 goroutines,
//     plus a single-slot runnext field in front of it. runnext is a LIFO
//     hint that holds the most recently readied goroutine and is run
//     first, which keeps ping-pong patterns (unbuffered channel handoff
//     between two goroutines) hot in cache instead of sending the partner
//     to the back of a queue.
//   - When the local ring is full, half of it is flushed to the global
//     run queue, which is guarded by a lock. The local ring is NOT an
//     unbounded lock-free FIFO, and describing it that way in an
//     interview is a tell that someone has read a blog post rather than
//     runtime/proc.go.
//   - Has an mcache for allocation
//   - Has a P-local timer heap (timers became per-P in Go 1.14 and were
//     reimplemented in Go 1.23. Earlier versions used sharded global heaps)

// WorkStealingDemo illustrates Go's work-stealing scheduler.
// When a P's local queue is empty, it steals half the goroutines
// from another P's queue.
func WorkStealingDemo() {
	var wg sync.WaitGroup
	numGoroutines := 1000

	// All goroutines are initially enqueued on the creating P.
	// Other Ps steal work to maintain balance.
	for i := 0; i < numGoroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// CPU-bound work: likely to be stolen.
			// Go 1.22+: loop variable i is per-iteration, safe to capture directly.
			doWork(i)
		}()
	}
	wg.Wait()
}

func doWork(id int) {
	// Simulate CPU-bound work.
	sum := 0
	for i := 0; i < 10000; i++ {
		sum += i * id
	}
	_ = sum
}

// SchedulerPreemption: Go uses signal-based async preemption (Go 1.14+).
//
// sysmon is a THREAD, not a goroutine. This distinction is exactly what
// interviewers probe, and it is not pedantry. sysmon runs on its own M
// with no P attached, and it never enters the normal scheduler. It has to
// work that way: its job includes rescuing a runtime where every P is
// already blocked, and a goroutine could not run under those conditions
// because running a goroutine is the very thing that requires a P.
//
// sysmon does not poll on a fixed 10ms tick either. It starts at a 20µs
// delay and backs off toward 10ms when the process looks idle, tightening
// again when there is work. On each pass it retakes Ps from goroutines
// that have been running too long or that are stuck in syscalls, and it
// sends SIGURG (on Unix) to preempt a G that has held its P for more than
// 10ms. The signal handler suspends the goroutine at an async-safe point,
// an instruction boundary where the stack and registers are describable
// to the GC, and yields the P.
//
// Before Go 1.14 preemption was cooperative: a goroutine in a tight loop
// with no function calls could monopolize a P indefinitely. Today that
// is no longer possible, the preemption signal interrupts pure arithmetic
// loops as well as call sites.
//
// Impact: goroutines will not monopolize a P for more than about 10ms.
// For hard-real-time workloads that need finer granularity, you still need
// to design for cooperative yielding (runtime.Gosched or channel ops).

// GODEBUG=schedtrace=1000: Print scheduler state every 1000ms.
// Real output from Go 1.27 on an 8-core box:
//
//	SCHED 1004ms: gomaxprocs=8 idleprocs=5 threads=5 spinningthreads=2
//	needspinning=0 idlethreads=1 runqueue=0 [ 0 0 0 0 0 0 0 0 ]
//	schedticks=[ 3 0 0 0 0 0 0 1 ]
//
// (wrapped here, it is one line in reality)
//
// runqueue=N is the GLOBAL queue depth. The bracketed list after it is the
// per-P local run queue depth, one entry per P, and schedticks is how many
// times each P has scheduled. The exact field set is not stable across
// releases, needspinning and schedticks are newer, so parse defensively
// and re-check the format against your own toolchain before writing an
// alert on it.
//
// Do NOT add scheddetail=1 if you want the format above. It does not add
// columns to this line, it replaces the output with a multi-line dump of
// every P, M and G, and the bracketed local-queue list disappears.

// SchedulerStats captures scheduler statistics via runtime metrics.
type SchedulerStats struct {
	Goroutines    int           // Current goroutine count
	Threads       int           // OS thread count
	Procs         int           // GOMAXPROCS
	GoRoutineTime time.Duration // CPU time in goroutines
}

func GetSchedulerStats() SchedulerStats {
	return SchedulerStats{
		Goroutines: runtime.NumGoroutine(),
		Procs:      runtime.GOMAXPROCS(0),
		// Threads count requires /proc/self/status on Linux or
		// runtime internals not exposed via public API.
	}
}

// GoroutineLeak detector: monitors goroutine count over time.
type LeakDetector struct {
	baseline int
	mu       sync.Mutex
	samples  []int
	ticker   *time.Ticker
	done     chan struct{}
}

func NewLeakDetector(sampleInterval time.Duration) *LeakDetector {
	d := &LeakDetector{
		baseline: runtime.NumGoroutine(),
		done:     make(chan struct{}),
	}
	d.ticker = time.NewTicker(sampleInterval)
	go d.sample()
	return d
}

func (d *LeakDetector) sample() {
	for {
		select {
		case <-d.ticker.C:
			count := runtime.NumGoroutine()
			d.mu.Lock()
			d.samples = append(d.samples, count)
			d.mu.Unlock()
		case <-d.done:
			return
		}
	}
}

// IsLeaking returns true if goroutine count is consistently growing.
func (d *LeakDetector) IsLeaking() bool {
	d.mu.Lock()
	samples := make([]int, len(d.samples))
	copy(samples, d.samples)
	d.mu.Unlock()

	if len(samples) < 5 {
		return false
	}

	// Check if last 5 samples are all increasing.
	n := len(samples)
	for i := n - 4; i < n; i++ {
		if samples[i] <= samples[i-1] {
			return false
		}
	}
	return true
}

func (d *LeakDetector) Stop() {
	d.ticker.Stop()
	close(d.done)
}

// GoroutineDump captures a dump of all goroutine stacks for leak analysis.
func GoroutineDump() string {
	buf := make([]byte, 10<<20) // 10MB
	n := runtime.Stack(buf, true)
	return string(buf[:n])
}

// avoid import error
var _ atomic.Int64
```

### 3.2 Goroutine Scheduling Patterns

Goroutines that perform blocking I/O, channel operations, or `runtime.Gosched()` voluntarily yield the P, allowing the scheduler to run another goroutine without an OS context switch. CPU-bound goroutines that never yield can starve other goroutines on the same P until the 10ms preemption tick intervenes, a problem that became more acute before the asynchronous preemption introduced in Go 1.14. The patterns below show how to structure CPU-intensive work to yield cooperatively at checkpoint boundaries, ensuring fair scheduling without sacrificing throughput.

```go
package scheduling_patterns

import (
	"context"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// YieldPattern: explicitly yield the P to allow other goroutines to run.
//
// Note the flag is an atomic.Bool and not a *bool. Spinning on a plain
// *bool across goroutines is a data race, and the race is not theoretical:
// with no synchronisation the compiler is free to hoist the load out of
// the loop, turning this into an infinite loop that never observes the
// write. runtime.Gosched() yields the P but establishes no happens-before
// edge, so it does not make the racy version correct. Run any spin loop
// you write under -race before you believe it.
//
// In real code, prefer a channel here. This pattern is for the rare case
// where the wait is measured in nanoseconds and a park/unpark round trip
// would dominate.
func spinWait(ready *atomic.Bool) {
	for !ready.Load() {
		runtime.Gosched() // Yield P to another runnable goroutine.
	}
}

// Worker serialises tasks onto one goroutine locked to one OS thread.
//
// Be precise about what LockOSThread does, because "affinity" oversells
// it. It pins this goroutine to this M (OS thread), and nothing more.
// It does NOT pin the goroutine to a P, it does NOT pin the thread to a
// CPU core, and the OS scheduler remains free to migrate that thread
// between cores whenever it likes. So it buys you thread identity, not
// cache locality.
//
// That makes the legitimate uses narrow and specific: cgo libraries with
// thread-local state (OpenGL, some CUDA contexts), signal handling, and
// anything requiring a stable OS thread identity. If you want real CPU
// affinity you need a syscall the runtime does not wrap, such as
// sched_setaffinity via golang.org/x/sys/unix, and pinning that thread
// while the Go scheduler moves everything else around it is usually a net
// loss. There is deliberately no "preferred P index" field here, since
// the runtime exposes no supported way to honour one.
type Worker struct {
	id     int
	taskCh chan func()
	done   chan struct{}
}

func NewWorker(id int) *Worker {
	w := &Worker{
		id:     id,
		taskCh: make(chan func(), 256),
		done:   make(chan struct{}),
	}
	go w.run()
	return w
}

func (w *Worker) run() {
	// Lock this goroutine to its OS thread. See the caveats above: this
	// is for thread identity, not for cache locality.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	for {
		select {
		case task := <-w.taskCh:
			task()
		case <-w.done:
			return
		}
	}
}

func (w *Worker) Submit(task func()) bool {
	select {
	case w.taskCh <- task:
		return true
	default:
		return false
	}
}

func (w *Worker) Stop() {
	close(w.done)
}

// BackpressureQueue provides a bounded queue with backpressure.
// When full, Submit blocks until space is available or context expires.
// This is the "reactive systems" approach: slow consumers slow producers.
type BackpressureQueue[T any] struct {
	ch chan T
}

func NewBackpressureQueue[T any](capacity int) *BackpressureQueue[T] {
	return &BackpressureQueue[T]{ch: make(chan T, capacity)}
}

func (q *BackpressureQueue[T]) Submit(ctx context.Context, item T) error {
	select {
	case q.ch <- item:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (q *BackpressureQueue[T]) Consume(ctx context.Context) (T, error) {
	select {
	case item := <-q.ch:
		return item, nil
	case <-ctx.Done():
		var zero T
		return zero, ctx.Err()
	}
}

// TimerPoolPattern avoids allocating new timers in hot paths, since
// time.NewTimer allocates on every call.
//
// Two caveats before you copy this. First, sync.Pool is cleared at every
// GC, so it is a short-lived free list and not a cache. Under a low
// timeout rate you will simply allocate a fresh timer each time anyway.
// Second, the drain-on-Stop dance below is legacy. Go 1.23 changed timer
// channels so that a stopped or reset timer never delivers a stale value,
// which is exactly the bug this drain existed to work around. The drain is
// harmless (the default case means it cannot block) and it keeps the code
// correct on older toolchains, but on Go 1.23+ it is no longer load
// bearing. Measure before adopting this pattern at all: a plain
// time.NewTimer is fine for the overwhelming majority of services.
var timerPool = sync.Pool{
	New: func() any {
		return time.NewTimer(0)
	},
}

func AcquireTimer(d time.Duration) *time.Timer {
	t := timerPool.Get().(*time.Timer)
	t.Reset(d)
	return t
}

func ReleaseTimer(t *time.Timer) {
	if !t.Stop() {
		// Drain the channel if Stop returned false.
		select {
		case <-t.C:
		default:
		}
	}
	timerPool.Put(t)
}

// WithTimeout executes fn with a timeout, using a pooled timer.
func WithTimeout(d time.Duration, fn func()) bool {
	t := AcquireTimer(d)
	defer ReleaseTimer(t)

	done := make(chan struct{})
	go func() {
		fn()
		close(done)
	}()

	select {
	case <-done:
		return true
	case <-t.C:
		return false
	}
}
```

### 3.3 Reading `schedtrace` and interpreting scheduler health

Set `GODEBUG=schedtrace=1000` and the runtime prints one line of scheduler state every second. Use `schedtrace` alone for this. Adding `scheddetail=1` does not enrich the line, it swaps it for a per-P, per-M, per-G dump that is useful when you are debugging the runtime itself and noise when you are triaging a service.

The fields worth watching. `runqueue` is the **global** run queue depth, and the bracketed list that follows it is the per-P local queue depth. `idleprocs` counts Ps with no work. `spinningthreads` counts Ms actively hunting for work, which is the scheduler's normal handoff mechanism rather than a defect.

Resist the urge to memorize thresholds for these, including any you find in a book or blog post. There is no universal number at which `runqueue` becomes "too deep" or `spinningthreads` becomes "pathological," because the right value depends entirely on `GOMAXPROCS`, on your goroutine lifetime distribution, and on whether the work is CPU-bound or I/O-bound. A batch pipeline with a deep global queue can be perfectly healthy and running at full utilization. What you want is a **baseline** for your own service when it is healthy, and an eye for deviation from it.

The one pattern that is diagnostic regardless of baseline is a deep global `runqueue` alongside a non-zero `idleprocs`. Runnable work exists and Ps are sitting idle, which means work is not reaching them. In practice that is usually goroutines being created faster than they are being stolen, or a hot goroutine holding a P without yielding. The fix is at submission (spread the work, or bound it with a worker pool) rather than at the scheduler. Reading one `schedtrace` line is the scheduler's equivalent of reading one `gctrace` line: a transferable skill that pays back every time you pick up a new service.

### 3.4 Junior → FAANG: the goroutine-leak hunt

Goroutine leaks are the most common memory pathology in Go services and the easiest to catch if you know the drill. Step one: expose `/debug/pprof/goroutine?debug=1` and watch `go_goroutines` as a Prometheus gauge. A steadily climbing curve that never recovers is a leak. Step two: at a quiet moment, `curl` the endpoint and group the goroutines by their top-of-stack function. The function with thousands of goroutines parked on it is your leak point. Common stacks: `chan send` (unbuffered channel whose reader died), `chan receive` (someone forgot to close), `sync.(*WaitGroup).Wait` (a `wg.Done` was never called on a shutdown path), `select` (a goroutine waiting on a context that will never be canceled). Step three: trace the stack back to a missing `cancel()`, a missing `defer wg.Done()`, or an unclosed channel. Fix, deploy, watch the gauge flatten. This is the canonical mid-level interview scenario for Go infrastructure roles, and the canonical 2 AM incident for Go services in production. Practice it on a toy service until the playbook is automatic.

### 3.5 Senior @ FAANG: scheduler tuning as a last resort

The Go scheduler is very good. Tuning it is almost always a mistake, and the staff-engineer signal is usually to revert whatever change introduced the tuning. A short list of legitimate scheduler interventions: `runtime.LockOSThread` when you genuinely need thread affinity (signal handlers, cgo with thread-local state, CUDA contexts). `GOMAXPROCS` override when the auto-detection from the cgroup is wrong (niche in Go 1.25+, but happens with custom container runtimes). `GOGC=off` combined with manual `runtime.GC()` calls at known idle boundaries (valid only for batch jobs, never for a serving path). Everything else is premature. When you see a PR that adds `runtime.Gosched()` sprinkled through business logic, a `GOMAXPROCS` override inside `init`, or a custom work-stealing pool, the first review question is "what profile showed the default scheduler was the bottleneck." In ten years of Go at scale, the answer is "none" far more often than is comfortable to admit.

---
