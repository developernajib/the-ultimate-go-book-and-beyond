# Part IIIB: High-Performance Go Engineering

*"We should forget about small efficiencies, say about 97% of the time: premature optimization is the root of all evil. Yet we should not pass up our opportunities in that critical 3%."* - Donald Knuth, 1974

---

At scale, performance stops being a nice-to-have and turns into a business requirement measured in revenue. The two most-quoted data points here are both from 2006: Marissa Mayer reported that adding half a second of latency to a Google search results page cut traffic by roughly 20%, and Greg Linden reported that every additional 100ms of latency cost Amazon about 1% in sales. Treat those as directional folklore rather than laws of nature. They are old, they were measured on products very different from yours, and neither was ever published with methodology. What has held up is the direction: latency costs money, and at large enough volume it costs a lot of it.

What is better documented is that companies operating at this scale engineer for it deliberately. Uber runs thousands of Go microservices. Cloudflare, Dropbox, and Datadog have all published engineering write-ups on Go GC and allocation tuning in production. None of them got there by accident. They got there through deliberate work at every layer, from kernel tuning and connection handling up through garbage collector configuration and memory layout.

Most Go developers never push the language beyond its defaults, and for most services that is the correct call. They accept the default garbage collector settings, use the standard library HTTP server untuned, and allocate without thinking about escape analysis or struct alignment. This works fine at modest scale. But when you need to handle a million requests per second, or your p99 latency budget is single-digit milliseconds, or an allocation in a hot path is measurably eating your throughput, you need to understand Go's runtime at a level most developers never reach.

A warning that this part will repeat: almost every performance claim you will read elsewhere, including in books, is unmeasured. This part tries hard not to add to that pile. Where a number appears, it is either measured and labelled with the machine it was measured on, or it is attributed to a published source you can go read. Numbers without one of those two things attached are decoration.

This part teaches you to push Go to its absolute limits. You will learn how the Go scheduler maps goroutines to OS threads, how the garbage collector works and how to tune it for your workload, how to eliminate allocations in hot paths, and how to benchmark and profile with the rigor that FAANG performance engineers demand. Every technique is backed by measurable results and production-proven patterns from real systems at scale.

**What this part covers:**
- Chapter 27B: Handling 1 Million RPS. Kernel tuning, the netpoller and connection handling, zero-allocation hot paths, lock-free structures, `sync.Pool`, and HTTP server design.
- Chapter 27C: Go Runtime and GC Mastery. The GMP scheduler, tri-color marking and the hybrid write barrier, the GC pacer, the size-class allocator, Green Tea GC, and GOGC/GOMEMLIMIT tuning.
- Chapter 27D: Memory and CPU Optimization. CPU caches and false sharing, struct layout and alignment, escape analysis, allocation reduction, SIMD via assembly, and CPU profiling.
- Chapter 27E: Benchmarking and Load Testing. `testing.B` correctness, benchstat and run-to-run variance, load testing with k6 and vegeta, coordinated omission, and regression detection.

**How to use this part:**
Read 27E first if you are in a hurry. That ordering looks backwards, and it is deliberate. Chapters 27B through 27D will hand you a large box of optimization techniques, and without the measurement discipline from 27E you will have no way to tell which of them helped, which did nothing, and which made things worse while appearing to help. Optimization without measurement is not engineering, it is superstition with a profiler open.

Read in order, 27B gives you the full stack of a high-throughput system, 27C explains the runtime machinery that every one of those optimizations is really manipulating, 27D drills into the CPU and memory layer beneath it, and 27E gives you the tools to prove any of it. Either path works. What does not work is applying 27D's techniques without 27E's rigor.

**FAANG relevance:**
Performance engineering is a core competency tested in FAANG system design interviews. You will be asked to estimate throughput, identify bottlenecks in proposed architectures, and explain how to achieve specific latency targets. On the job, performance reviews at senior levels explicitly evaluate your ability to optimize critical paths, reduce infrastructure costs through efficiency improvements, and make data-driven performance trade-offs. Engineers who can demonstrate measurable performance improvements stand out in both interview and promotion evaluations.

---
