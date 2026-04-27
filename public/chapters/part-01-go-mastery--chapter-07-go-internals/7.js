export default `## 7.6 Scheduler Deep Dive (GMP Model)

### The GMP Architecture

The Go scheduler implements an M:N threading model called GMP: Goroutines (G) are multiplexed onto OS threads (M) through logical processors (P). Understanding this model explains goroutine scheduling, preemption, and performance characteristics.

\`\`\`
┌─────────────────────────────────────────────────────────────────────────────┐
│                         GMP Scheduler Architecture                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  G - Goroutine                                                               │
│      • Lightweight thread of execution                                       │
│      • 2KB initial stack (growable to 1GB)                                   │
│      • Contains execution context (PC, SP, registers)                        │
│      • Millions can exist simultaneously                                     │
│                                                                              │
│  M - Machine (OS Thread)                                                     │
│      • Actual OS thread                                                      │
│      • Executes G's on behalf of P                                           │
│      • Limited by GOMAXPROCS and system limits                              │
│      • Can be parked when no work available                                 │
│                                                                              │
│  P - Processor (Logical Processor)                                           │
│      • Context for executing Go code                                         │
│      • Holds local run queue (LRQ)                                          │
│      • Number controlled by GOMAXPROCS                                      │
│      • Required to execute any goroutine                                    │
│                                                                              │
│  ═══════════════════════════════════════════════════════════════════════    │
│                                                                              │
│                       Global Run Queue (GRQ)                                 │
│                  ┌────────────────────────────────┐                          │
│                  │ G │ G │ G │ G │ ... │ G │ G │                            │
│                  └────────────────────────────────┘                          │
│                              │                                               │
│         ┌────────────────────┼────────────────────┐                          │
│         │                    │                    │                          │
│         ▼                    ▼                    ▼                          │
│    ┌─────────┐          ┌─────────┐          ┌─────────┐                    │
│    │   P0    │          │   P1    │          │   P2    │                    │
│    │  LRQ:   │          │  LRQ:   │          │  LRQ:   │                    │
│    │[G][G][G]│          │[G][G]   │          │[G]      │                    │
│    │         │          │         │          │         │                    │
│    │ mcache  │          │ mcache  │          │ mcache  │                    │
│    └────┬────┘          └────┬────┘          └────┬────┘                    │
│         │                    │                    │                          │
│         ▼                    ▼                    ▼                          │
│    ┌─────────┐          ┌─────────┐          ┌─────────┐                    │
│    │   M0    │          │   M1    │          │   M2    │                    │
│    │(thread) │          │(thread) │          │(thread) │                    │
│    │         │          │         │          │         │                    │
│    │  g0     │          │  g0     │          │  g0     │                    │
│    │(sched)  │          │(sched)  │          │(sched)  │                    │
│    └─────────┘          └─────────┘          └─────────┘                    │
│         │                    │                    │                          │
│         └────────────────────┼────────────────────┘                          │
│                              │                                               │
│                              ▼                                               │
│                    Operating System Kernel                                   │
│                    (manages actual CPU cores)                                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
\`\`\`

### The G (Goroutine) Structure

Each goroutine is represented by a \`g\` struct in the runtime that tracks the stack, program counter, status, and scheduling metadata. Knowing this structure helps interpret profiling output and understand goroutine overhead.

\`\`\`go
// Simplified representation of runtime.g
type g struct {
    stack       stack   // Stack bounds [stack.lo, stack.hi)
    stackguard0 uintptr // Stack guard for growth check
    stackguard1 uintptr // Stack guard for C code

    m           *m      // Current M executing this G (nil if not running)
    sched       gobuf   // Saved context for scheduling

    atomicstatus uint32 // Goroutine status
    goid        int64   // Goroutine ID (unique per process)

    waitsince   int64   // Approx time when G became blocked
    waitreason  waitReason // Why G is blocked

    preempt     bool    // Preemption signal
    preemptStop bool    // Stop preempt for GC

    lockedm     *m      // G locked to this M (LockOSThread)

    // ... many more fields
}

// gobuf holds the context needed to resume a goroutine
type gobuf struct {
    sp   uintptr // Stack pointer
    pc   uintptr // Program counter
    g    guintptr
    ctxt unsafe.Pointer
    ret  uintptr
    lr   uintptr // Link register (ARM)
    bp   uintptr // Base pointer (frame pointer)
}

// Goroutine states
const (
    _Gidle      = iota // Just allocated
    _Grunnable        // On run queue, not yet running
    _Grunning         // Currently executing
    _Gsyscall         // In system call
    _Gwaiting         // Blocked (channel, mutex, etc.)
    _Gdead            // Finished, can be reused
    _Gcopystack       // Stack being copied
    _Gpreempted       // Preempted, not on run queue
)
\`\`\`

### The M (Machine/OS Thread) Structure

Each M represents an OS thread. The M is associated with exactly one P at a time and runs goroutines from the local run queue. When blocked on a syscall, the M releases its P to allow other goroutines to run.

\`\`\`go
// Simplified representation of runtime.m
type m struct {
    g0      *g     // Goroutine with scheduling stack
    morebuf gobuf  // State for stack growth

    curg    *g     // Currently running goroutine
    p       *p     // Attached P (nil if not running Go code)
    nextp   *p     // P to attach when acquiring
    oldp    *p     // Previous P for syscalls

    id      int64  // Thread ID

    spinning bool  // Looking for work
    blocked  bool  // Blocked on note

    park    note   // For parking/unparking

    lockedg *g     // Locked to this G (LockOSThread)

    // ... many more fields
}
\`\`\`

### The P (Processor) Structure

Each P holds a local run queue of goroutines ready to execute and per-P caches for memory allocation. The number of Ps defaults to \`GOMAXPROCS\`, determining the degree of true parallelism.

\`\`\`go
// Simplified representation of runtime.p
type p struct {
    id          int32
    status      uint32 // _Pidle, _Prunning, _Psyscall, _Pgcstop, _Pdead

    m           *m     // Attached M (nil if idle)

    // Local run queue (fast, lock-free for owner)
    runqhead    uint32
    runqtail    uint32
    runq        [256]*g
    runnext     *g     // Next G to run (high priority)

    // Memory allocator cache
    mcache      *mcache

    // Timer heap for time.Sleep, time.After, etc.
    timers      []*timer
    numTimers   uint32

    // ... many more fields
}

// P states
const (
    _Pidle    = iota // No work to do
    _Prunning        // Running Go code
    _Psyscall        // In syscall
    _Pgcstop         // Stopped for GC
    _Pdead           // No longer used
)
\`\`\`

### Work Stealing Algorithm

When a P's local run queue is empty, the scheduler does not simply idle. Instead, it follows a prioritized search: check the global queue periodically, poll the network poller for unblocked I/O goroutines, and finally steal half the runnable goroutines from another P's local queue. This approach keeps CPU utilization high even when work is unevenly distributed. The pseudocode below mirrors the actual \`findRunnable\` function in \`runtime/proc.go\`.

\`\`\`go
// Simplified work stealing algorithm
func findRunnable() *g {
    p := getg().m.p

    // 1. Check local run queue
    if g := runqget(p); g != nil {
        return g
    }

    // 2. Check global run queue (every 61 schedules)
    if p.schedtick%61 == 0 {
        if g := globrunqget(p, 1); g != nil {
            return g
        }
    }

    // 3. Check network poller
    if netpollinited() {
        if g := netpoll(0); g != nil { // non-blocking
            return g
        }
    }

    // 4. Steal from other P's
    for i := 0; i < 4; i++ {
        for _, pp := range allPs {
            if pp == p {
                continue
            }
            if g := runqsteal(p, pp); g != nil {
                return g
            }
        }
    }

    // 5. Check global queue again
    if g := globrunqget(p, 0); g != nil {
        return g
    }

    // 6. Block on network poller
    if g := netpoll(block); g != nil {
        return g
    }

    return nil
}
\`\`\`

### Scheduler Tracing

The runtime scheduler can emit detailed trace events via \`GODEBUG=schedtrace=N\`. The \`go tool trace\` command visualizes these events, revealing goroutine blocking patterns and processor utilization.

\`\`\`bash
# Enable scheduler tracing
GODEBUG=schedtrace=1000,scheddetail=1 ./myprogram
\`\`\`

Output interpretation:

\`\`\`
SCHED 1000ms: gomaxprocs=4 idleprocs=2 threads=6 spinningthreads=1 idlethreads=2 runqueue=5 [3 2 0 1]

gomaxprocs=4       # Number of P's (GOMAXPROCS)
idleprocs=2        # Number of idle P's
threads=6          # Total OS threads
spinningthreads=1  # M's looking for work
idlethreads=2      # M's blocked on note
runqueue=5         # Global run queue size
[3 2 0 1]          # Local run queue sizes for each P
\`\`\`

### Scheduler Observation Application

The following application instruments the scheduler to observe goroutine lifecycle events, run queue depths, and context switch rates in a running service.

\`\`\`go
// scheduler_observer.go - Monitor scheduler behavior
package main

import (
    "context"
    "fmt"
    "os"
    "runtime"
    "runtime/trace"
    "sync"
    "sync/atomic"
    "time"
)

// SchedulerStats tracks scheduler behavior
type SchedulerStats struct {
    Goroutines     int64
    Threads        int64
    CGoCalls       int64
    TotalSchedules int64

    // Timing
    StartTime time.Time
    LastCheck time.Time
}

// SchedulerObserver monitors the Go scheduler
type SchedulerObserver struct {
    stats     atomic.Value // *SchedulerStats
    lastNumGC uint32
}

// NewSchedulerObserver creates a new observer
func NewSchedulerObserver() *SchedulerObserver {
    o := &SchedulerObserver{}
    o.stats.Store(&SchedulerStats{StartTime: time.Now()})
    return o
}

// Collect gathers current scheduler statistics
func (o *SchedulerObserver) Collect() SchedulerStats {
    stats := SchedulerStats{
        Goroutines: int64(runtime.NumGoroutine()),
        StartTime:  time.Now(),
        LastCheck:  time.Now(),
    }

    // Get thread count from NumCgoCall (indirect)
    stats.CGoCalls = runtime.NumCgoCall()

    o.stats.Store(&stats)
    return stats
}

// Current returns the most recent stats
func (o *SchedulerObserver) Current() SchedulerStats {
    return *o.stats.Load().(*SchedulerStats)
}

// StartTracing begins execution tracing
func StartTracing(filename string) (func(), error) {
    f, err := os.Create(filename)
    if err != nil {
        return nil, err
    }

    if err := trace.Start(f); err != nil {
        f.Close()
        return nil, err
    }

    return func() {
        trace.Stop()
        f.Close()
    }, nil
}

// GoroutineSpawner demonstrates goroutine creation patterns
type GoroutineSpawner struct {
    count     int64
    workChan  chan func()
    done      chan struct{}
    wg        sync.WaitGroup
}

// NewGoroutineSpawner creates a worker pool
func NewGoroutineSpawner(workers int) *GoroutineSpawner {
    gs := &GoroutineSpawner{
        workChan: make(chan func(), 1000),
        done:     make(chan struct{}),
    }

    for i := 0; i < workers; i++ {
        gs.wg.Add(1)
        go gs.worker()
    }

    return gs
}

func (gs *GoroutineSpawner) worker() {
    defer gs.wg.Done()
    for {
        select {
        case work := <-gs.workChan:
            work()
            atomic.AddInt64(&gs.count, 1)
        case <-gs.done:
            return
        }
    }
}

// Submit adds work to the pool
func (gs *GoroutineSpawner) Submit(work func()) {
    gs.workChan <- work
}

// Stop shuts down the pool
func (gs *GoroutineSpawner) Stop() {
    close(gs.done)
    gs.wg.Wait()
}

// Count returns completed work items
func (gs *GoroutineSpawner) Count() int64 {
    return atomic.LoadInt64(&gs.count)
}

func demonstrateWorkStealing() {
    fmt.Println("\\n=== Work Stealing Demonstration ===")

    runtime.GOMAXPROCS(4)

    var wg sync.WaitGroup
    work := make([]int64, 4)

    // Create unbalanced work distribution
    for p := 0; p < 4; p++ {
        wg.Add(1)
        pIdx := p
        go func() {
            defer wg.Done()

            // P0 gets most work initially
            count := 1000
            if pIdx == 0 {
                count = 10000
            }

            for i := 0; i < count; i++ {
                // CPU-bound work
                x := 0
                for j := 0; j < 10000; j++ {
                    x += j
                }
                atomic.AddInt64(&work[pIdx], 1)
            }
        }()
    }

    // Monitor work distribution
    done := make(chan struct{})
    go func() {
        ticker := time.NewTicker(10 * time.Millisecond)
        defer ticker.Stop()
        for {
            select {
            case <-ticker.C:
                fmt.Printf("Work distribution: P0=%d P1=%d P2=%d P3=%d\\n",
                    atomic.LoadInt64(&work[0]),
                    atomic.LoadInt64(&work[1]),
                    atomic.LoadInt64(&work[2]),
                    atomic.LoadInt64(&work[3]))
            case <-done:
                return
            }
        }
    }()

    wg.Wait()
    close(done)

    fmt.Printf("Final: P0=%d P1=%d P2=%d P3=%d\\n",
        work[0], work[1], work[2], work[3])
}

func demonstratePreemption() {
    fmt.Println("\\n=== Preemption Demonstration (Go 1.14+) ===")

    runtime.GOMAXPROCS(1) // Single P to show preemption clearly

    done := make(chan bool, 2)

    // Long-running goroutine (tight loop)
    go func() {
        start := time.Now()
        count := 0
        for time.Since(start) < 100*time.Millisecond {
            count++
            // No function calls - requires async preemption
        }
        fmt.Printf("Tight loop completed: %d iterations\\n", count)
        done <- true
    }()

    // Short goroutine that should still run
    go func() {
        time.Sleep(10 * time.Millisecond)
        fmt.Println("Short goroutine ran! (preemption worked)")
        done <- true
    }()

    <-done
    <-done
}

func demonstrateLockOSThread() {
    fmt.Println("\\n=== LockOSThread Demonstration ===")

    var wg sync.WaitGroup

    for i := 0; i < 3; i++ {
        wg.Add(1)
        go func(id int) {
            defer wg.Done()

            // Lock this goroutine to its OS thread
            runtime.LockOSThread()
            defer runtime.UnlockOSThread()

            // This is useful for:
            // - C library calls that store state in thread-local storage
            // - OpenGL (must be called from same thread)
            // - Windows COM objects

            fmt.Printf("Goroutine %d locked to OS thread\\n", id)

            // Do work...
            time.Sleep(10 * time.Millisecond)

            fmt.Printf("Goroutine %d unlocking\\n", id)
        }(i)
    }

    wg.Wait()
}

func main() {
    fmt.Println("Go Scheduler Internals Demo")
    fmt.Printf("GOMAXPROCS: %d\\n", runtime.GOMAXPROCS(0))
    fmt.Printf("NumCPU: %d\\n", runtime.NumCPU())

    // Start tracing
    stopTrace, err := StartTracing("trace.out")
    if err != nil {
        fmt.Printf("Failed to start tracing: %v\\n", err)
    } else {
        defer stopTrace()
        fmt.Println("Tracing to trace.out (analyze with: go tool trace trace.out)")
    }

    // Create observer
    observer := NewSchedulerObserver()

    // Start periodic collection
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    go func() {
        ticker := time.NewTicker(100 * time.Millisecond)
        defer ticker.Stop()
        for {
            select {
            case <-ctx.Done():
                return
            case <-ticker.C:
                stats := observer.Collect()
                fmt.Printf("Goroutines: %d\\n", stats.Goroutines)
            }
        }
    }()

    // Demonstrations
    demonstratePreemption()
    demonstrateLockOSThread()
    demonstrateWorkStealing()

    // Worker pool demo
    fmt.Println("\\n=== Worker Pool Demo ===")
    pool := NewGoroutineSpawner(runtime.GOMAXPROCS(0))

    for i := 0; i < 10000; i++ {
        pool.Submit(func() {
            // Simulated work
            time.Sleep(time.Microsecond)
        })
    }

    time.Sleep(100 * time.Millisecond)
    fmt.Printf("Completed work items: %d\\n", pool.Count())
    pool.Stop()

    // Final stats
    fmt.Printf("\\nFinal goroutine count: %d\\n", runtime.NumGoroutine())
}
\`\`\`

### Incident Playbook: Scheduler Pathologies

Three scheduler-related incident shapes every senior Go engineer should recognise:

1. **Syscall starvation.** A goroutine makes a blocking syscall. The runtime detaches the P from the M. If the syscall runs long enough and no other M is available, throughput drops. Diagnosis: \`GODEBUG=schedtrace=1000\` shows low "running" counts and high "syscall" counts. Fix: use non-blocking IO or bound the syscall time.
2. **Goroutine dump without progress.** \`/debug/pprof/goroutine\` shows thousands of goroutines stuck on the same channel or mutex. Diagnosis: read the dump, identify the common wait site. Fix: usually a missing cancellation path or a leaked producer.
3. **Preemption-resistant loops.** A tight loop with no function calls used to resist preemption (fixed in 1.14 with async preemption). In modern Go this is rare, but custom assembly or \`runtime.LockOSThread\` can still produce the pathology.

### Code-Review Lens (Senior Track)

Three patterns to flag:

1. **\`runtime.LockOSThread\` without \`Unlock\`.** Leaks the thread. Always pair them.
2. **Explicit \`runtime.Gosched()\` calls.** Almost always unnecessary. The scheduler preempts automatically. If you think you need \`Gosched\`, measure.
3. **A goroutine count that grows without bound in metrics.** Leak. Diagnose before scale.

---
`;
