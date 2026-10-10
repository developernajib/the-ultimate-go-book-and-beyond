## Summary

The Go runtime's GC is a concurrent mark-and-sweep collector optimized for low-latency, high-throughput services:

- **Algorithm**: Concurrent tri-color marking with a hybrid write barrier (Yuasa deletion plus Dijkstra insertion, since Go 1.8). Because the collector is concurrent, its cost is mostly CPU rather than pauses. STW pauses are two per cycle and typically tens of microseconds, and they do not scale with heap size
- **Green Tea GC**: Default since Go 1.26. Restructures the mark phase around span-based scanning for locality, cutting GC CPU by a reported 10 to 40 percent on allocation-heavy workloads. Same tri-color algorithm, same hybrid write barrier, zero code changes. It does **not** make allocation faster
- **Size-specialized allocator**: Go 1.27.1 (shipped). Up to 30 percent cheaper small allocations. This, not Green Tea, is the change that speeds up allocation
- **Tuning**: GOGC is a heap-growth ratio, not a pause dial and not a CPU target (default 100 triggers when the heap doubles past the live set). GOMEMLIMIT (Go 1.19+) is a **soft** limit and is **not** container-aware, so set it yourself from the cgroup limit and leave the cgroup limit above it as the real OOM ceiling. Keep GOGC on alongside it, or risk the death spiral
- **Allocator**: TCMalloc-based three-tier hierarchy (mcache → mcentral → mheap), 67 size classes. The per-P mcache fast path needs no lock
- **Stacks**: Start at 2KB, grow by copying, capped at 1GB on 64-bit. `MemStats.Alloc` is HeapAlloc and **excludes** goroutine stacks
- **Scheduler**: GMP with work stealing (idle Ps steal from busy ones). The run queue is a bounded 256-entry ring plus a `runnext` LIFO slot, with a lock-guarded global queue behind it. `sysmon` is a **thread**, not a goroutine. Network I/O parks the goroutine via the netpoller without blocking an M, while file and cgo I/O do block one. GOMAXPROCS is container-aware since Go 1.25
- **Profiling**: pprof (CPU/heap), runtime/trace (scheduling), runtime/metrics (live, no STW), GODEBUG (verbose tracing). Heap profiles are **sampled** (512KB), and mutex and block profiles record **nothing** until you enable them
- **Patterns**: Flat buffers, minimal pointer density, RCU for config, and pools only where objects are genuinely reused within a GC cycle

The most important thing to remember: **measure before tuning**. The default Go GC is correct for most workloads. Profile first, find the specific bottleneck, apply the minimal fix, and verify. And treat every performance number you meet, including the ones in this chapter, as a claim attached to a Go version and a machine rather than as a fact about the language.

### For the junior engineer on the FAANG track

Leave this chapter with four habits. First, always read one `gctrace` line before you touch a tuning knob. Second, distinguish `alloc_space` (GC cost) from `inuse_space` (RSS cost) on every heap profile. Third, chase pointer density before you chase `GOGC`. Fourth, remember that a goroutine leak is a design bug, not a runtime bug, and every one you catch early is an incident you prevented. Those four habits carry a junior engineer through their first two years of serious Go performance work, and they are what interviewers are probing for when they ask "have you ever debugged a GC issue." If you can narrate one real refactor where you followed this loop (measure, reduce allocations or flatten pointers, verify in production), you will outperform candidates with more years of experience who cannot.

### For the senior engineer at FAANG

Leave this chapter with three artifacts per service you own. First, a runtime-tuning ADR that records every `GOGC` and `GOMEMLIMIT` decision with its justification and rollback criteria. Second, a dashboard with the five runtime queries from section 4.3, alerting on GC CPU share as a rate (not the lifetime-average `go_memstats_gc_cpu_fraction`, and not the nonexistent `go_gc_cpu_fraction`), goroutine growth, and scheduler latency. Third, a runbook that a half-trained on-call engineer can execute at 3 AM without paging you for a standard GC or goroutine incident. The techniques in this chapter are ingredients. The artifacts are the kitchen. Performance engineering at the staff level is measured not by the cleverness of your tuning but by the resilience of the team and the systems you leave behind after you move on. Write the documents. Mentor the juniors. Delete the tuning knobs that are no longer load-bearing. The runtime will keep evolving. The habits and artifacts outlive any specific release.

