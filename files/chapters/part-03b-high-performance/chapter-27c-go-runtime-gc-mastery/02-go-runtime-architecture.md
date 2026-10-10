## Go Runtime Architecture

The Go runtime is an embedded supervisor that manages goroutines, memory, garbage collection, and system calls. It runs inside your process, so there is no separate JVM or CLR to tune.

```
┌───────────────────────────────────────────────────────────────────────┐
│                      Go Runtime Architecture                          │
├───────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  User Code (Goroutines G1…GN)                                         │
│  ──────────────────────────                                           │
│  G1   G2   G3   G4   G5   G6   G7   G8                                │
│   \   /     \   /     \   /     \   /                                 │
│    P1         P2         P3         P4      ← Processors (GOMAXPROCS) │
│    |          |          |          |                                 │
│    M1         M2         M3         M4      ← OS Threads (M)          │
│    |          |          |          |                                 │
│  ┌─┴──────────┴──────────┴──────────┴─────────────┐                   │
│  │           Go Runtime Scheduler                 │                   │
│  │  - Work stealing: idle Ps steal from busy Ps   │                   │
│  │  - Goroutine preemption at safe points         │                   │
│  │  - Sysmon thread (not a G): preempts >10ms Gs  │                   │
│  └────────────────────────────────────────────────┘                   │
│                         │                                             │
│  ┌──────────────────────▼─────────────────────────┐                   │
│  │              Memory Subsystem                   │                  │
│  │  mheap → mcentral → mcache → object            │                   │
│  │  Stack: contiguous, grows by copying            │                  │
│  │  Heap: non-contiguous spans                     │                  │
│  └──────────────────────┬─────────────────────────┘                   │
│                         │                                             │
│  ┌──────────────────────▼─────────────────────────┐                   │
│  │         Garbage Collector (Tri-Color)           │                  │
│  │  Phase 1: Mark Setup (STW < 0.1ms)              │                  │
│  │  Phase 2: Concurrent Mark (background)          │                  │
│  │  Phase 3: Mark Termination (STW < 0.1ms)        │                  │
│  │  Phase 4: Concurrent Sweep (background)         │                  │
│  └─────────────────────────────────────────────────┘                  │
└───────────────────────────────────────────────────────────────────────┘
```

Notice how the layers interact: goroutines (G) are assigned to processors (P), which are bound to OS threads (M). The scheduler sits between user code and the memory subsystem, deciding which goroutine runs where. Below that, the memory subsystem feeds the garbage collector, which must coordinate with the scheduler to pause and resume goroutines during collection phases. Every performance characteristic of a Go program, allocation throughput, GC latency, scheduling fairness, emerges from the interplay between these three layers.

### Junior → FAANG: a memorable mental model

Picture the runtime as three conveyor belts that share one factory floor. The **scheduler belt** moves goroutines through the processors. It is lightweight, preemptive at safe points, and unfair by design (a goroutine that never yields will be preempted asynchronously after 10 ms since Go 1.14). The **allocator belt** carves memory out of spans and hands it back to user code. It is per-P in the fast path (via `mcache`), so allocations on a hot path rarely hit a central lock. The **GC belt** runs in the background, marking reachable objects during mutator execution and sweeping dead ones concurrently. The belts interact through write barriers (every pointer write goes through a runtime hook during GC), mark assists (a fast-allocating goroutine is forced to help the GC), and STW phases (brief global pauses at the start and end of each cycle). Internalize these three belts and the rest of the chapter stops feeling mysterious. The one sentence to remember: **the GC is not an event that happens to your program, it is a set of invariants that your program maintains while it runs.**

### Senior @ FAANG: what to look for in the architecture picture

When you see a runtime diagram like this, the question at staff level is not "do I understand the boxes." It is "where would a failure here show up in my service, and where would I instrument it first." Examples: a P running long without reaching a safe point shows up as tail-latency spikes and elevated `/sched/latencies:seconds` in `runtime/metrics`. A misconfigured `GOMAXPROCS` under a cgroup shows up as underutilized CPU and a growing runnable goroutine count. An allocation storm shows up as GC CPU share (`/cpu/classes/gc/total:cpu-seconds` as a rate) climbing while `/gc/heap/live:bytes` grows faster than serving work. Uneven work distribution shows up in the per-P run queue depths in `GODEBUG=schedtrace=1000` output. For every layer in the diagram, the staff-level artifact is a one-line answer to "what does pathology look like on the dashboard, and what does the first line of the runbook say to do about it." If your service does not have that mapping written down somewhere, the runtime diagram is decoration. Writing it down is what turns the theory into an on-call survival kit.

---
