## Summary

Building 1M RPS Go systems requires discipline at every layer:

- **Runtime**: Leave GOMAXPROCS alone (it has defaulted to `NumCPU()` since Go 1.5 and reads the container's CPU quota since 1.25). Set GOMEMLIMIT from the pod's memory limit yourself, because it is not container-aware and it is soft. Raise GOGC only with a memory limit backing it
- **Allocations**: Zero allocations on hot paths via sync.Pool, append-based reuse into pre-sized buffers, and escape analysis. Note that Go's `arenas` experiment is not generally available, so "arena" here means a hand-rolled bump allocator you own
- **Concurrency**: Atomics and lock-free structures *where a profile shows mutex contention*. Under low contention an uncontended mutex is already cheap, and a lock-free rewrite frequently measures within noise of the mutex it replaced
- **Networking**: SO_REUSEPORT per core, TCP_NODELAY, io_uring to amortize syscalls across batched submissions. io_uring is not kernel bypass and it is not syscall-free: the kernel still does the I/O, and only DPDK and AF_XDP genuinely bypass it
- **NUMA**: Memory allocated on the same node it's accessed, workers pinned to minimize cross-node traffic
- **Profiling**: pprof → eliminate mallocs. Perf → eliminate cache misses. Trace → eliminate scheduler delays
- **Architecture**: Stateless design with external session state, consistent hashing for horizontal scale, provisioned against the ring's real peak rather than its average

The most important lesson: **profile first**. Throughput work is dominated by a small number of specific bottlenecks that a profile will name for you, and almost never by the language the service is written in. The corollary is that a rewrite is the most expensive way to discover you had one slow function.

The next chapter (27C) covers the Go runtime and garbage collector in detail, giving you the foundation to understand *why* each optimization in this chapter works and when to apply it.

### For the junior engineer on the FAANG track

Leave this chapter with three habits. First, never report a performance change without evidence, and prefer evidence that is deterministic. `allocs/op` and `B/op` are exact. `benchstat` over `ns/op` is a statistical claim that is only as good as the machine underneath it, and on a shared or thermally throttled box it will cheerfully report a large, confidently significant speedup for a change that did nothing. When you must quote a timing, quote the hardware alongside it and re-run the baseline interleaved with the candidate. Second, always distinguish `alloc_space` (GC cost) from `inuse_space` (RSS cost) when reading a heap profile. Third, treat the `MaxIdleConnsPerHost` default of 2 as a bug in any service you inherit. Those three habits alone will carry a junior engineer through their first two years of production performance work, and they are the habits interviewers are probing for when they ask "have you ever optimized a service." If you can walk into an interview and narrate one refactor where you followed this loop (profile, hypothesize, benchmark, measure in production), you will outperform candidates with five more years of experience who cannot.

### For the senior engineer at FAANG

Leave this chapter with three artifacts for every service you own. First, a capacity model spreadsheet that survives turnover. Second, an ADR trail that records why each tuning knob is where it is. Third, a runbook that a half-trained on-call engineer can execute at 3 AM without paging you. The techniques in this chapter are ingredients. The artifacts are the cake. Performance engineering at the staff and principal level is measured not by the cleverness of the code you write but by the resilience of the team and the systems you leave behind after you move on. Write the documents. Mentor the juniors. Delete the optimizations that are not pulling their weight. The 1M RPS target is just the forcing function that reveals whether the real engineering work was done.

