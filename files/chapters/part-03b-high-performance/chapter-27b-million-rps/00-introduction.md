# Chapter 27B: Building Million RPS Systems in Go

*"The purpose of abstracting is not to be vague, but to create a new semantic level in which one can be absolutely precise."* - Edsger W. Dijkstra

At the frontier of Go performance engineering lies a deceptively simple question: how do you sustain one million requests per second on a single node without sacrificing correctness, observability, or operational sanity? The answer is not a single trick. It is the disciplined application of every layer of systems knowledge at once. Hardware cache behavior, kernel networking, Go runtime internals, and application-level data structure design all interact, and a bottleneck at any one layer will cap throughput no matter how well the others are tuned.

Before going further, be honest about what "1M RPS" means, because the phrase is close to meaningless without qualifiers. A million trivial in-memory lookups per second over persistent connections is a very different machine from a million requests per second that each parse JSON, hit a database, and serialize a response. The first is achievable on one modern box. The second is not, at any amount of Go tuning, because the bottleneck is not Go. Whenever you see an RPS number quoted anywhere, including in this chapter, the first question is always: what was in the request?

Most Go services comfortably handle hundreds to a few thousand RPS per instance and never need to go further. But a class of infrastructure exists where this matters: API gateways, edge proxies, time-series ingest pipelines, DNS resolvers, financial matching engines, IoT message brokers, and CDN origin fetchers, all of which must sustain six-figure RPS and up on commodity hardware. At these levels every allocation matters and every syscall counts. The gap between a naively correct implementation and a carefully optimized one is real and sometimes large, though the "two orders of magnitude" figure that gets thrown around is usually the result of comparing an optimized implementation against a deliberately bad one.

Reaching this territory demands work across three dimensions. First, zero-allocation hot paths: understanding Go's escape analysis so critical code does not touch the heap in steady state, which removes GC pressure at the source. Second, lock-free concurrency: replacing contended mutexes with atomic operations, ring buffers, and sharded structures so the scheduler is not parking goroutines behind a lock. Third, transport and I/O tuning: TCP socket options (`TCP_NODELAY`, `SO_REUSEPORT`, buffer sizing), connection reuse, and pool sizing, so the network stack is not adding avoidable microseconds per request.

One correction to the conventional wisdom up front, since this chapter will return to it: HTTP/2 is not a throughput optimization for server-to-server traffic. Multiplexing many streams over one connection was designed to solve browser connection limits over high-latency links. For internal RPC on a fast network, a pool of HTTP/1.1 connections frequently beats HTTP/2 on a single connection, because HTTP/2 adds framing work and reintroduces head-of-line blocking at the TCP layer. Use HTTP/2 when you want its semantics. Do not reach for it expecting free RPS.

**What you'll learn in this chapter:**

- Designing zero-allocation request hot paths using escape analysis, `sync.Pool`, and pre-allocated buffer rings to eliminate GC pressure at peak load
- Implementing lock-free data structures with `sync/atomic`: MPMC queues, sharded counters, and hazard-pointer-style deferred reclamation
- Tuning HTTP and raw TCP servers with `SO_REUSEPORT`, connection reuse, keep-alive policies, and `fasthttp` vs `net/http` trade-offs
- Applying NUMA-aware memory layouts and CPU affinity to pin goroutines to cores and prevent cross-socket memory traffic
- Profiling at extreme throughput with `pprof`, `perf`, flame graphs, and hardware performance counters to find the last 20% of performance
- Building backpressure-aware pipelines that degrade gracefully under overload rather than cascading into latency spikes
- Architecting horizontally scalable layers that compose single-node throughput wins into cluster-wide capacity

**Why this matters at scale:**

Cloudflare built RRDNS, their authoritative DNS server, in Go, and have written publicly about it. Uber open-sourced Ringpop and TChannel in Go, though TChannel has since largely given way to gRPC internally. Twitch published a well-known engineering write-up on tuning Go's GC for their chat system, which remains one of the better real accounts of GC pressure at scale that you can go and read.

Notice what those references do and do not establish. They establish that serious Go systems exist at this scale and that their authors found the work worth writing down. They do not establish a per-node RPS number, because with rare exceptions those numbers are not published, and any specific figure you see attached to another company's system in a book or blog post is usually someone's guess wearing a lab coat. The useful thing to take from these systems is their failure modes, not their scoreboard.

Those failure modes are consistent. When an on-call engineer pages at 3 AM because p99 latency went from milliseconds to hundreds of milliseconds under load, the cause is nearly always one of a handful of things: unexpected allocations in a hot path, lock contention, an undersized connection pool, or an unbounded queue that turned a throughput problem into a latency problem. Understanding those, and designing so they cannot happen, is the actual skill.

**Prerequisites:** Go concurrency and the goroutine scheduler (Part II: Concurrency), profiling fundamentals (pprof and benchmarking), and solid familiarity with Go's memory model. A working knowledge of Linux networking concepts (TCP, sockets, kernel send buffers) will help but is not strictly required.

## Two readers, one chapter

This chapter is written for two very different readers. The material sits at the frontier of Go performance work, so the on-ramps and the ceilings both matter.

**Junior engineer on the FAANG track.** If you have shipped a handful of Go services and your p50 looks fine but you have never seen a pprof flamegraph, start by building mental models. Before writing lock-free code, make sure you can explain: what escape analysis does and how to read `go build -gcflags='-m'` output, what `pprof -alloc_objects` vs `-alloc_space` mean, how a goroutine gets scheduled onto a P and an M, and why a blocking syscall spawns a thread. A useful entry exercise is to take a plain `net/http` echo server, benchmark it with `wrk -t8 -c1000 -d30s`, and graph RPS as you add one optimization at a time (removing `fmt.Sprintf`, switching to `sync.Pool`, enabling `SO_REUSEPORT`). You will feel each technique pay for itself, and that intuition is what interviewers are probing for when they ask "walk me through how you would get this service to 100K RPS."

Coding interviews for infrastructure and systems teams at Google, Meta, AWS, Cloudflare, and Stripe routinely include one performance-tuning question where the "right" answer is not a new algorithm but removing allocations from an inner loop, adding a bounded worker pool, or replacing a mutex with a sharded counter. The patterns in this chapter are those answers.

**Senior engineer already at FAANG.** If you are a staff or principal engineer, the algorithms here are familiar. The value this chapter is trying to add is the operator layer above them: how do you decide whether 1M RPS belongs on one fat box or a hundred small ones, how do you set an SLO that survives a GC pause, how do you write the ADR that commits your org to `fasthttp` (and what do you owe the maintenance contract in year three), how do you triage a latency regression that only shows up at 800K RPS in prod but not at 400K RPS in staging. The chapter closes each section with framing suitable for design review, capacity planning, and incident command at scale. Treat the code samples as reference implementations you can point junior engineers at, and spend your attention on the trade-off analysis in the anti-pattern, scaling, and real-world-systems sections.

A final calibration note: most services at most FAANG companies do not need any of this. The chapter is written for the minority of workloads where it does matter, and for the interviews that probe whether you understand the underlying machine. Knowing when not to apply these techniques is as important as knowing how.

---
