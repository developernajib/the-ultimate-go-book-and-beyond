export default `## 7.11 Interview Questions

Runtime-internals questions appear in FAANG staff-level Go interviews and as warmup for senior backend roles at Go-first shops (Uber, Cloudflare, Datadog, HashiCorp). Interviewers use them to check whether you can reason about scheduling, GC, and channel behavior at a level that lets you debug production incidents.

> **What FAANG actually tests here**: operational understanding of GMP, the GC algorithm, the stack model, and channel semantics. Memorized definitions are not enough. Be ready to walk through what happens when a goroutine blocks on a syscall, or what \`runtime.NumGoroutine\` counts, or why a closed-channel receive does not panic but a closed-channel send does.

### Question 1: Explain the GMP Model

**What FAANG expects**: the three roles, the local/global/netpoll queue hierarchy, work stealing, and the difference between preemptive and cooperative scheduling (and which Go uses since 1.14).

**Answer**: The GMP model is Go's scheduler architecture:
- **G (Goroutine)**: Lightweight thread with 2KB initial stack, holds execution context
- **M (Machine)**: OS thread that executes goroutines
- **P (Processor)**: Logical processor with local run queue, required to execute Go code

Key points:
- GOMAXPROCS controls the number of P's (default: CPU cores)
- M's are created as needed but can be parked when idle
- P's have local run queues (256 goroutines max) to reduce contention
- Work stealing balances load across P's
- Asynchronous preemption (Go 1.14+) prevents goroutine starvation
- Container-aware GOMAXPROCS (Go 1.25+) auto-detects cgroup CPU limits

**Follow-ups**:
- What happens to the P when an M makes a blocking syscall?
- How did container-aware GOMAXPROCS in Go 1.25 change the deployment story for Kubernetes pods with CPU limits?

### Question 2: How Does Go's GC Work?

**What FAANG expects**: the tri-color invariant, the role of write barriers, the concurrent-mark contract, and awareness that Go 1.26's Green Tea collector restructures the mark phase without changing any of the above.

**Answer**: Go uses a concurrent, tri-color mark-and-sweep garbage collector:

1. **Tri-color algorithm**:
 - White: Not visited, potentially garbage
 - Grey: Visited, children not yet scanned
 - Black: Visited, all children scanned

2. **Phases**:
 - Mark Setup (STW): Enable write barriers, prepare for marking
 - Concurrent Mark: Scan objects while app runs
 - Mark Termination (STW): Finish marking
 - Concurrent Sweep: Reclaim white objects

3. **Write barriers** ensure correctness during concurrent marking

4. **Tuning**:
 - GOGC: Controls GC aggressiveness (default 100 = GC when heap doubles)
 - GOMEMLIMIT: Soft memory limit (Go 1.19+)

5. **Green Tea (Go 1.25 experiment, 1.26 default)**: restructures the mark phase to scan small-object groups via SIMD for 10-40% lower GC overhead. The tri-color invariant and write-barrier contract are unchanged.

**Follow-ups**:
- Why does the GC need write barriers during concurrent marking? Walk through the scenario they prevent.
- How does \`GOMEMLIMIT\` change the collector's pacing decisions?

### Question 3: What Triggers Stack Growth?

**What FAANG expects**: knowledge of the 2KB initial stack, the copy-and-adjust growth model (not linked stack frames), and why this matters for deep recursion versus fixed-size OS thread stacks.

**Answer**: Go uses growable stacks that start at 2KB:

1. **Trigger**: Compiler inserts stack check prologue in every function
2. **Check**: If SP < stackguard0, call runtime.morestack
3. **Growth**: Allocate new stack (2x size), copy contents, update pointers
4. **Shrinking**: GC may shrink stacks that are less than 1/4 used

This design allows millions of goroutines with small initial overhead while supporting deep recursion when needed.

**Follow-ups**:
- Why cannot Go use segmented stacks (the pre-1.3 design)? What was the problem with them?
- What does the stack copy do to interior pointers, and how does the runtime fix them up?

### Question 4: Explain Channel Implementation

**What FAANG expects**: the \`hchan\` struct, the wait queues, the difference between buffered and unbuffered semantics, and the three nil/closed-channel edge cases that show up in interview Q's constantly.

**Answer**: Channels are implemented as \`hchan\` struct with:
- Circular buffer (\`buf\`) for buffered channels
- Wait queues (\`sendq\`, \`recvq\`) for blocked goroutines
- Mutex for synchronization

Operations:
1. **Send**: If receiver waiting, copy directly and wake. Else buffer if space. Else block
2. **Receive**: If sender waiting, receive and wake. Else get from buffer. Else block
3. **Select**: Runtime polls all cases, randomly selects ready one

Key behaviors:
- Nil channel: blocks forever (select uses this pattern to disable a case)
- Closed channel: receives return zero value and \`ok == false\`
- Send to closed: panics
- Close on nil or already-closed channel: panics

**Follow-ups**:
- Why does \`select\` choose randomly among ready cases rather than in source order?
- When would you prefer a mutex over a channel for coordination?

### Question 5: How Does Work Stealing Improve Performance?

**What FAANG expects**: the steal-half heuristic, the random victim selection, and awareness that checking the global queue every 61 schedules prevents starvation of goroutines sitting there.

**Answer**: Work stealing balances load across P's:

1. When P's local queue is empty, it:
 - Checks global run queue (every 61 schedules)
 - Checks network poller
 - Steals half of another P's queue

2. Benefits:
 - Reduces global queue contention
 - Balances CPU utilization
 - Maintains cache locality for local work

3. Implementation:
 - Steal from random P to avoid thundering herd
 - Steal half to minimize future stealing
 - Non-blocking steal using atomic operations

**Follow-ups**:
- What is the sysmon goroutine and when does it force preemption?
- How does the netpoller integrate with the scheduler to avoid blocking Ms on I/O?

### Q (Senior track): How would you diagnose a service with 50ms p99 tail latency you cannot explain?

**What FAANG expects**: a structured diagnostic workflow using \`go tool trace\`, pprof, and runtime metrics.

**Answer**: Start with \`go tool trace\` on a 5-second capture from the service under load. The trace visualises scheduler state, GC pauses, goroutine lifetimes, and network/syscall activity over time. The 50ms span will show up as either (1) a GC pause, (2) a scheduler gap where the goroutine was runnable but not running, (3) a blocking syscall, or (4) a lock wait.

If it is GC, look at the mark and sweep phases, total pause time, and frequency. Fix with allocation reduction or \`GOMEMLIMIT\` adjustment.

If it is scheduler gap, check the number of runnable goroutines and the P utilisation. A gap with runnable goroutines and idle Ps means a scheduling bug (rare). A gap with no runnable goroutines means the goroutine was waiting on something.

If it is a syscall, see how long it took and whether the P was handed off to another M. A long syscall in a hot path is a candidate for non-blocking alternatives.

If it is a lock wait, the block profile (\`/debug/pprof/block\`) shows where. Fix with a different synchronisation primitive or a different algorithm.

The discipline: read the trace, not guess. The answer is always visible in the trace if you know where to look.

### Q (Senior track): Explain the difference between concurrent mark and stop-the-world mark in Go's GC.

**What FAANG expects**: understanding of the tri-colour invariant, write barriers, and why concurrent mark requires them.

**Answer**: Stop-the-world mark pauses all mutators while the GC visits every reachable object. Simple, correct, and terrible for latency at scale.

Concurrent mark runs alongside the mutators. The tri-colour invariant (black objects cannot point to white objects) must hold at all times. Since mutators may modify pointers during marking, the GC uses write barriers: each pointer write during a GC cycle is intercepted to ensure the invariant. Go uses a hybrid deletion + insertion write barrier (since 1.8) that is correct across the mark phase.

The payoff: pause times drop from tens of milliseconds (STW mark on large heaps) to sub-millisecond (concurrent mark plus brief STW phases for setup and completion). The cost: the write barrier adds a few nanoseconds per pointer write, which is invisible in most code but measurable on allocation-heavy hot paths.

### Q (Senior track): How does \`GOMEMLIMIT\` change the GC trigger?

**What FAANG expects**: the soft-limit semantics and how it interacts with \`GOGC\`.

**Answer**: Pre-\`GOMEMLIMIT\`, the GC triggered when the heap grew by \`GOGC\`% from the end of the previous cycle. This worked for steady-state heaps but failed for workloads with bursty allocation: the heap could grow past available memory before the next cycle fired, producing OOM.

\`GOMEMLIMIT\` adds a soft upper bound. The GC runs more aggressively (smaller heap growth between cycles) as the heap approaches the limit. The GC never stops entirely (unlike \`GOGC=off\`), so the process is always making progress on collection.

The practical setting: 80% of container memory limit. The remaining 20% is for stacks, allocator metadata, and transient spikes. If the service hits the limit in practice, either the limit is too low or the service is leaking.

### Q (Senior track): What is the cost of an interface method call versus a direct method call?

**What FAANG expects**: the indirection cost, boxing cost, and when the compiler devirtualises.

**Answer**: A direct method call on a concrete type compiles to a direct branch, which the CPU can predict and inline. Cost: essentially zero at hot paths.

An interface method call requires two loads (the itab pointer from the interface header, then the function pointer from the itab) and an indirect jump. Cost: 2-3 ns on modern CPUs, plus the branch predictor cannot inline through the dispatch.

Boxing a value into an interface typically allocates on the heap (unless the value is small enough to fit inline in the interface header, which is pointer-sized and restricted). For \`any\`-taking functions called in hot paths, this is the dominant cost.

The compiler sometimes devirtualises: if the concrete type is statically known at the call site, the compiler emits a direct call. This is fragile and does not always fire. Profile to confirm.

---
`;
