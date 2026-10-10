## Section 11: Real-World 1M RPS Systems

The techniques in this chapter are not theoretical, and large-scale Go systems really do apply them. But this section has to be careful in a way most "real-world systems" writeups are not.

Throughput numbers attributed to named companies are the most-repeated and least-verified claims in performance writing. A figure gets published in a blog post about one service, on one hardware generation, with one payload shape, and then circulates for a decade detached from every one of those qualifiers, gathering precision it never had. This section keeps the **architectural patterns**, which transfer, and refuses to invent the **numbers**, which do not. Where a company's own published claim is cited, it is marked as such and you should read the original. Where a number would be guesswork, it is absent rather than fabricated.

If that makes this section less quotable, good. Quotable numbers are how bad capacity plans get written.

### 11.1 Pattern: Anatomy of a Million-RPS Go Proxy

**Problem shape**: handle very high request rates per node with a tight p99, where the work per request is small (parse, route, forward).

For calibration: the very highest-tier edge data planes at companies like Cloudflare are typically C, Rust, or eBPF/XDP rather than Go. Go proxies and internal L7 routers do run at extremely high throughput in production. Both facts are true, and the interesting question is which constraint you are actually up against.

**Techniques that consistently appear**:

- Zero-copy request parsing over pooled buffers, so bytes are sliced rather than copied
- `SO_REUSEPORT` with one listener per core, letting the kernel spread accepts instead of contending on a single accept queue
- A lock-free routing table via copy-on-write `atomic.Pointer` swaps
- `GOGC` and `GOMEMLIMIT` set deliberately rather than by default
- Per-connection buffer pooling to keep per-request allocation near zero

**The insight that generalizes**: a routing table read a million times a second and written once a minute should never be behind a lock. Copy-on-write with an atomic pointer swap removes contention from the read path entirely, and the GC handles reclaiming old versions once the last reader drops them. This is the RCU pattern, and it is the single most valuable structure in a Go proxy.

**What to measure on your own proxy**: allocations per request (`-benchmem`), GC CPU share, and the syscall share of your CPU profile. Those three tell you which of the techniques above is worth your time. Nobody's published RPS figure can tell you that.

### 11.2 Case Study: Discord's Go to Rust migration

**Source**: Discord's 2020 post about their **Read States** service. Read the original before repeating anything about it, including this summary.

**The verifiable technical detail**, and the one worth carrying with you: their latency spikes tracked a **two-minute cadence**, which is not a coincidence and not their traffic pattern. The Go runtime forces a GC if none has run for two minutes (`forcegcperiod = 2 * 60 * 1e9` in `runtime/proc.go`, checked by `sysmon`). Their service held a large LRU cache, so every forced cycle had a large live set to mark.

**Why that detail matters more than any latency number**: it explains why the usual advice fails here. Raising `GOGC` cannot push the cycle past two minutes, because `GOGC` governs the heap-ratio trigger and has no effect on the forced one. A big cache plus a mostly-idle heap means you get a mark of the whole live set every two minutes no matter what you set. This is a case where the standard tuning playbook is genuinely exhausted, which is rarer than engineers proposing rewrites tend to believe.

**Why they migrated**: tail-latency predictability, not throughput. They met their throughput goals in Go.

**Lesson**: exhaust the Go options first, and know what "exhausted" means. Allocation reduction, pointer-density reduction, and pooling routinely buy large p99 improvements. A rewrite is warranted only when you can name the specific mechanism Go cannot escape, as Discord could.

### 11.3 Pattern: the API gateway

**Problem shape**: fan a very high inbound request rate out to many backend services.

**Techniques that appear in production gateways**:

- `SO_REUSEPORT` sharded accept loops, one listener per core, removing accept-queue contention
- HTTP/2 or gRPC multiplexing to backends, so upstream calls reuse warm TCP and TLS connections instead of paying handshakes
- Connection pool sizing on every outbound client, which is the most commonly missed item on this list
- Header forwarding that slices rather than copies

**The failure that shows up over and over**: the gateway is tuned beautifully and throughput plateaus anyway, because the **outbound** `http.Transport` was left at defaults. `DefaultMaxIdleConnsPerHost` is **2**. Two idle connections per backend host, no matter how many cores you have or how many goroutines are waiting. Everything above that limit pays a fresh TCP and TLS handshake per request, or queues. If your service plateaus while CPU sits at 40 percent, check `MaxIdleConnsPerHost` and `MaxConnsPerHost` before you touch anything else in this chapter. This single default has cost more aggregate throughput across the Go ecosystem than any GC misconfiguration.

**On bare metal versus Kubernetes**: you will hear that bare metal is worth some specific percentage of latency. Treat any such figure with suspicion, since it depends entirely on the CNI plugin, whether the service mesh injects a sidecar proxy (usually the dominant term by far), the cgroup CPU limits, and the node's overcommit. Measure your own stack. The sidecar, if present, is usually the answer.

### 11.4 Pattern: chat and message fanout

**Problem shape**: many concurrent connections, each message fanned out to many recipients, bursty.

**Techniques**:

- `sync.Pool` for per-message structs, valid here specifically because the objects are genuinely in flight and reused within a GC cycle, which is the narrow case where pooling pays
- `unique.Handle[string]` (Go 1.23+) for repeated strings such as channel names and emote codes, so that N copies of a string collapse to one interned value plus N cheap handles. The saving scales with your duplication factor, so measure it on your own key distribution rather than adopting a percentage
- `GOMEMLIMIT` set from the container limit, with `GOGC` left on

**A caution on the clever version**: `GOGC=off` plus explicit `debug.FreeOSMemory()` at known quiet boundaries can work for a bursty workload with genuinely predictable frames. It is also one instruction away from a service that never collects and OOMs, and it stops being valid the moment traffic stops being bursty in the way you assumed. If you do this, write down the assumption that makes it safe and the alert that fires when the assumption breaks.

### 11.5 Case Study: GoBGP and the control-plane pattern

**Attribution first**: **GoBGP is an open-source BGP implementation originally developed at NTT** (`osrg/gobgp`). It is used by many organizations, and it is not any one company's internal system. Getting this right matters, because "Company X's GoBGP" is exactly the kind of claim that propagates.

**Problem shape**: thousands of peers and very high route-update rates during a reconvergence event, where the work is CPU-bound decode and data-structure updates rather than I/O.

**Techniques that fit this shape**:

- `atomic.Pointer[RoutingTable]` for copy-on-write swaps, keeping the read path lock-free (the same RCU pattern as 11.1)
- `runtime.LockOSThread` plus `unix.SchedSetaffinity` to pin an update applier, but only on hardware where `numactl --hardware` reports more than one NUMA node
- PGO with profiles refreshed from production, worth 2 to 14 percent on typical CPU-bound Go code, delivered through better inlining and devirtualization

**Lesson**: control-plane services benefit from allocator discipline and PGO, not from exotic I/O. There is no kernel bypass to reach for when your bottleneck is decoding messages and updating a tree. This is the most common shape of Go performance work, and it is the least glamorous.

### 11.6 Case Study: GitHub's load balancer and the split-plane pattern

**Source**: GitHub published a series on GLB (GitHub Load Balancer) and GLB Director. Read the originals for their architecture and their numbers.

**The pattern worth stealing**, independent of any figure: **split the data plane from the control plane, and write them in different languages on purpose.**

- The data plane forwards packets at line rate. This is the domain of XDP/eBPF, DPDK, or C, where per-packet cost is measured in nanoseconds and a GC is unacceptable at any pause length.
- The control plane computes routing decisions, runs health checks, and pushes configuration. This is Go's domain: the work is complex, correctness matters more than nanoseconds, and operability and iteration speed dominate.

**Why this is the durable lesson**: it dissolves the "is Go fast enough" argument by refusing it. You do not need Go to be a packet-forwarding language. You need Go to be the language you write the thinking in, and something else to be the language the packets move in. When someone proposes rewriting a whole Go service in Rust for throughput, the split-plane question, "which part of this is actually the hot path," is usually the better answer, and it is much cheaper.

### 11.7 Case Study: The "Accidental Buffer" Trap - When a 90% Latency Drop Explodes the Database Bill

**Problem shape**: A critical e-commerce cart pricing service handling 9,000 requests/second was rewritten from a legacy runtime to Rust to eliminate GC latency and buffer allocations.

**The Initial Triumph**:
- P99 latency dropped from 840 ms to 71 ms (a 90% reduction).
- Pod count collapsed from 42 instances to 6.
- Monthly application compute bills dropped by $2,400.

**Then the Real Bill Arrived**:
Nineteen days after deployment, the finance and database teams flagged an emergency: the managed PostgreSQL database bill had quadrupled, adding $3,900/month and turning the $2,400 compute savings into a net $1,500/month loss.

```
BEFORE REWRITE:                            AFTER REWRITE:
Clients                                    Clients
   │                                          │
   ▼                                          ▼
[ Upstream Pods x42 ]                      [ Upstream Pods x6 ]
   │ (Slow loops & GC pauses acted            │ (Zero pauses, 10x throughput:
   │  as an "accidental buffer")              │  arrives with zero queueing)
   ▼                                          ▼
+---------------------+                    +---------------------+
| PostgreSQL Database | (40% CPU, normal)  | PostgreSQL Database | (96% CPU, IOPS ceiling hit!)
+---------------------+                    +---------------------+
```

**The Architectural Mechanism**:
The old service had an unmeasured property: its internal execution delays and garbage collection pauses acted as a natural queueing buffer, smoothing the rate of incoming queries arriving at the database. Once the upstream execution was optimized to zero-overhead execution, 9,000 requests/second were fired simultaneously into PostgreSQL with zero queueing. Connection churn surged, database disk IOPS hit hardware limits, and the team had to rapidly upscale instances and provision read replicas under incident conditions.

**The Invisible Organizational Taxes**:
1. **CI Pipeline Inflation**: Build and lint pipeline execution times grew from 4 minutes to 19 minutes per PR.
2. **Review & On-Call Bottlenecks**: Only 2 engineers in the 8-person on-call rotation could comfortably debug production backtraces in the rewritten language; other team members approved changes without deep verification.

**The Fix and the Durable Lesson**:
The fix required no infrastructure changes: introducing a strict concurrency semaphore (`maxConcurrentDBQueries = 200`) in front of the database connection pool capped concurrency to what the database engine could actually handle concurrently. Database CPU stabilized at 62%, extra read replicas were decommissioned, and p99 settled at 96 ms.

> [!NOTE]
> Making an upstream service 10x faster without end-to-end backpressure does not solve latency; it merely transforms the upstream service into a firehose pointed directly at stateful databases. For the full retrospective, see The Thread Whisperer's analysis in [*We Rewrote Our Hottest Service in Rust. Latency Dropped 90% - Then the Real Bill Arrived*](https://medium.com/@thethreadwhisperer/we-rewrote-our-hottest-service-in-rust-latency-dropped-90-then-the-real-bill-arrived-3965b26b3c2c).

### 11.8 Cross-case patterns

Read these in sequence and the shapes repeat.

**Nobody reached high throughput with a single technique.** Every such system combines half a dozen techniques from this chapter, and a meaningful share of the final result comes from the platform layer (NIC tuning, kernel version, NUMA, huge pages) rather than from Go code.

**RCU shows up everywhere.** The proxy's routing table, the gateway's config, GoBGP's route table: read-mostly state behind an `atomic.Pointer` with copy-on-write updates. If you learn one pattern from this section, learn that one.

**The Go-to-Rust migrations that made sense were narrow.** They rewrote a specific hot path for tail-latency predictability, not for throughput. Throughput can nearly always be bought inside Go. GC-induced tail variance is the one property Go cannot promise you.

**The boring defaults cost more than the exotic tuning saves.** `MaxIdleConnsPerHost` at 2, a missing `GOMEMLIMIT` in a container, a `sync.Pool` that pools slices instead of pointers. These are worth more than io_uring on almost every real service.

### 11.9 Junior → FAANG: how to read a case study

When you read "Company X handles 50M RPS in Go," do not take it as a badge of what Go can do. Ask what the request actually did (a health check returning a constant is not a request), what the p99 was at that rate, on what hardware and which Go version, how many nodes that number was spread across, whether the load generator corrected for coordinated omission, and what the cost per million requests was.

Then ask the questions the post will not answer: what was the on-call pager load, what failure modes did they accept as not-a-bug, and what would have happened if any single technique in the list were missing.

A blog post that says "we did X and got Y" is a marketing artifact. An engineering artifact says "we did X because Y was unacceptable, and Z was the trade-off we took." Learn to reconstruct the second from the first and you will read every case study, including this chapter, with the eye of a senior engineer. Applying that skepticism to your own writing is what makes you worth reading in turn.

### 11.10 Senior @ FAANG: the internal case study you should be writing

The case studies above are external and therefore lossy. The more valuable document is the one your team writes about your own service, updated quarterly: the capacity model (current and projected), the SLO and current compliance, the top three tuning decisions and their justifications, the three most recent incidents and their root causes, the three most expensive optimizations in engineering time and what they bought, the three you considered and rejected and why, and the next three on the roadmap with expected cost and benefit.

Put the Go version, the hardware, and the measurement method next to every number in it, and re-measure rather than re-quote after each upgrade. An internal number without provenance decays into folklore exactly the way the external ones do, just faster, because nobody outside your team will ever challenge it.

This document serves onboarding (it replaces weeks of tribal knowledge), leadership review (concrete evidence of thoughtful ownership), and succession (it captures context otherwise lost to attrition). If your service lacks it, writing it is among the single most useful things a staff engineer can do, and the writing itself reliably surfaces gaps in the team's understanding.

---
