## Learning Objectives

By the end of this chapter, you will be able to:
- Reason about what actually limits a Go service's request rate, and identify which layer (kernel, runtime, allocator, or application) is the binding constraint
- Apply NUMA-aware memory allocation and CPU affinity techniques, and judge when they are worth the complexity
- Implement lock-free data structures using atomic operations, and recognize the common case where a plain mutex is faster
- Distinguish `io_uring` (a batched asynchronous syscall interface, still fully in-kernel) from true kernel bypass (DPDK, AF_XDP), and explain why Go's netpoller already solves most of what people reach for `io_uring` to fix
- Build zero-allocation hot paths and verify them with escape analysis and `-benchmem` rather than by assertion
- Tune the Go runtime scheduler, GC, and memory allocator for throughput-oriented workloads
- Profile, benchmark, and iteratively optimize production Go systems
- Architect horizontally scalable layers that compose single-node throughput into cluster capacity

**Junior → FAANG track.** You should also finish the chapter able to read a Go CPU and heap profile and point at the single most expensive line, write a table-driven `testing.B` benchmark that survives `benchstat` scrutiny (stable variance, no dead-code elimination), explain in an interview why `sync.Pool` is safe for request-scoped buffers but dangerous for long-lived state, and turn "my service is slow" into a numerical claim ("p99 moved from 4 ms to 18 ms after deploy 7a3c, CPU usage flat, goroutine count grew 3x") before touching code.

Most importantly, you should leave able to say "I do not know, I have not measured it" without embarrassment. That sentence is worth more in a performance review, and in an interview, than any confident number you cannot defend. The single most common failure in this field is not ignorance, it is fluent guessing.

**Senior @ FAANG track.** Beyond the mechanics, you should be able to write the one-page capacity brief for a proposed 1M RPS service (blast radius, failure domains, cost per million requests, rollback plan), defend or reject a `fasthttp` adoption in a code review with a written trade-off table, run a blameless post-incident review for a latency regression that crossed a GC tuning knob, and mentor a junior engineer through their first zero-allocation refactor without taking the keyboard. These are the staff-level artifacts that the techniques in this chapter ultimately feed into.

---
