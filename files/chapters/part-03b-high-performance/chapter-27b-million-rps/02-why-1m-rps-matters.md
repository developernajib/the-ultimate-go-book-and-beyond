## Why 1M RPS Matters

Most Go services handle hundreds to low thousands of RPS per instance. A narrower class of system needs individual nodes in the six-figure RPS range and up: API gateways, load balancers, time-series ingest, DNS resolvers, trading engines, and edge proxies. What these have in common is not that they are important, it is that their per-request work is small. That is the precondition for high RPS, and it is the reason the technique list below is short and specific rather than general advice.

Reaching this scale requires understanding every layer, from hardware cache lines up to the Go runtime scheduler, and making deliberate trade-offs between complexity and throughput.

The diagram below sketches how such a system is composed across tiers. The shape is the point: no single node carries all the traffic, and each tier has a different bottleneck, so each tier gets different treatment. The RPS figures in the boxes are illustrative placeholders chosen to make the arithmetic legible, not measurements of any real system. Your numbers will differ by an order of magnitude in either direction depending on what a request actually does.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    Million RPS Architecture Stack                        │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  Client Tier        ┌──────────────────────────────────────────────┐     │
│  (10M users)  ───►  │         Load Balancer / Anycast BGP          │     │
│                     └──────────────────────────────────────────────┘     │
│                                          │                               │
│                           ┌─────────────┴─────────────┐                  │
│                           ▼                           ▼                  │
│  Edge Tier        ┌──────────────┐          ┌──────────────┐             │
│  6 nodes,         │  Go Gateway  │   ...    │  Go Gateway  │             │
│  ~200K RPS each   │  Node 1      │          │  Node 6      │             │
│  = 1.2M capacity  │  netpoller   │          │  netpoller   │             │
│  for 1M offered   │  SO_REUSEPORT│          │  SO_REUSEPORT│             │
│  (20% headroom)   └──────┬───────┘          └──────┬───────┘             │
│                          │                         │                     │
│  ┌───────────────────────┼─────────────────────────┼──────────────┐      │
│  │  Service Mesh / gRPC  │     Internal Network     │             │      │
│  └───────────────────────┼─────────────────────────┼──────────────┘      │
│                          ▼                         ▼                     │
│  Service Tier    ┌──────────────┐          ┌──────────────┐              │
│  ~50K RPS/node,  │ Auth Service │          │  Rate Limit  │              │
│  so ~20 nodes    │  Zero-copy   │          │  Token Bucket│              │
│  per 1M RPS      │  JWT verify  │          │  Sharded     │              │
│                  └──────┬───────┘          └──────────────┘              │
│                         │                                                │
│  Data Tier       ┌──────▼───────┐          ┌──────────────┐              │
│                  │  Redis (L2)  │          │  PostgreSQL  │              │
│                  │  Pipeline    │          │  PgBouncer   │              │
│                  │  ~500K ops/s │          │  Conn Pool   │              │
│                  └──────────────┘          └──────────────┘              │
│                                                                          │
│  Hardware Layer: NUMA nodes, CPU pinning, hugepages, NIC queue affinity  │
└──────────────────────────────────────────────────────────────────────────┘
```

### What 1M RPS actually costs

A useful back-of-envelope: 1M RPS is 86.4 billion requests per day. At a benign average of 2 KB per request (headers plus a small JSON body) that is roughly 16 Gb/s of sustained traffic, which is already past what a single 10 GbE NIC can carry and into the territory of 25 GbE or 40 GbE. If your service spends about 31 microseconds of CPU per request and you have 32 cores, you saturate at roughly 32K RPS per core times 32 cores, just over 1M RPS with zero headroom, which is why the p99 falls off a cliff the moment a GC pause or a lock contention hiccup lands. The arithmetic is unforgiving. Every microsecond of CPU per request translates into one core of capacity at 1M RPS.

### When 1M RPS is the wrong target

Before investing six engineer-months in the techniques in this chapter, pressure-test the requirement. Legitimate 1M RPS workloads look like: L7 API gateway fronting a fleet, DNS or DoH resolver, ad-bidding request router, real-time telemetry ingest, WebSocket fan-out for a live event, anycast TLS terminator, or a market-data tick processor. Illegitimate 1M RPS targets often hide one of three mistakes: counting internal retries and health checks as external traffic, setting a "future-proof" headline number that no capacity model backs, or reaching for architectural complexity because a PM said "web scale." The cost of getting this wrong is high. Single-node 1M RPS pulls you into NUMA pinning, custom allocators, and kernel-bypass I/O, all of which carry a five-year maintenance tax. A horizontally-sharded fleet of 20 nodes at 50K RPS each is almost always cheaper to build, operate, and staff. Senior engineers earn their title by pushing back on the headline number before pushing back on the code.

### Junior → FAANG: how to build intuition for these numbers

Memorize a handful of latency anchors and you will never be lost in a capacity conversation. These are the descendants of Jeff Dean's "Latency Numbers Every Programmer Should Know", and Colin Scott's interactive version at colin-scott.github.io/personal_website/research/interactive_latency.html is worth ten minutes of your time because it lets you scrub them by year.

| Operation | Order of magnitude |
|---|---|
| L1 cache hit | ~1 ns |
| L2 cache hit | ~4 ns |
| L3 cache hit | ~10-20 ns |
| Main memory load | ~80 ns |
| NVMe random read | ~20-100 us |
| Same-zone cloud round trip | ~0.1-0.5 ms |
| Cross-region round trip | tens of ms |

Read that table as powers of ten, not as measurements. Its value is that L1 to main memory is roughly two orders of magnitude, and memory to cross-region is roughly five. Nobody will ever ask you whether an L3 hit is 12 ns or 18 ns. They will ask whether a design that touches main memory once per request can hit your latency target, and for that the exponent is the whole answer.

For Go-specific costs, do not trust folklore. Here are measurements taken for this book, so you can see both the numbers and how little they mean without their context. Go 1.27.1, Intel i7-10510U, Linux, `GOMAXPROCS=4` pinned to physical cores, 10 runs summarized with `benchstat`:

| Operation | Measured | Variance |
|---|---|---|
| `sync.Mutex` lock/unlock, uncontended | 22.1 ns | ±3% |
| `sync.Mutex` lock/unlock, 4 goroutines contending | 58.0 ns | ±24% |
| Buffered channel send+receive, same goroutine | 95.4 ns | ±18% |
| Small heap allocation (32 B struct) | 68.1 ns | ±23% |
| Unbuffered channel send, across goroutines | 467 ns | ±10% |
| Goroutine ping-pong round trip | 932 ns | ±5% |
| Goroutine creation | 875 ns | ±7% |

Look at the shape, not the digits. There are two clusters. Operations that stay inside one goroutine (uncontended lock, allocation, buffered channel send with a ready slot) sit in the tens of nanoseconds. Operations where the scheduler must park one goroutine and wake another (unbuffered handoff, ping-pong, goroutine creation) sit in the hundreds. The gap is roughly **20 to 40x**, and it is the most important thing on this page. Nearly every optimization in this chapter works by moving an operation from the second cluster into the first.

Now the caveats, which matter more than the table.

That machine is a laptop, and its clock sat far below its 4.9 GHz ceiling for the entire run. On a server-class CPU at a fixed clock, expect the same shape with smaller absolute numbers: an uncontended mutex is usually quoted nearer 13-20 ns and a small allocation nearer 20-25 ns. Take the ratios, discard the absolutes.

Notice the variance column too. Several rows are ±18-24% even after pinning to physical cores and waiting for the machine to go quiet. And that is the *good* run. An earlier attempt at the same uncontended-mutex benchmark, on the same machine while other work was running, produced results drifting from 11 ns/op to 53 ns/op across six consecutive runs of byte-identical code, a 4.6x spread. Nothing was broken. The clock was pinned near 700 MHz by a `powersave` governor under load.

That is the lesson, and it is why the mutex row above says 22.1 ns rather than "about 20 ns". A single benchmark run is not a measurement, it is an anecdote. Chapter 27E is entirely about why that sentence is not pedantry.

Also note the contended-mutex row is nearly useless as written, and it is left in deliberately so you can see the trap: 4 goroutines on 4 cores is barely contention at all. Real contention, dozens of goroutines fighting for one lock, lands far higher, and the number would depend entirely on how many goroutines I chose to throw at it. "A contended mutex costs X" is not a fact about mutexes, it is a fact about a benchmark someone wrote.

At 1M RPS, a budget of 1 us of CPU per request is already 1 full CPU-second of work per second, which is to say one entire core. That relationship is exact and machine-independent, which is what makes it the most useful number in this chapter.

### Senior @ FAANG: the organizational shape of a 1M RPS service

A 1M RPS tier is rarely a one-team artifact. The typical shape involves four overlapping responsibilities that a staff or principal engineer has to orchestrate. Platform provides the hosts, kernel tuning, NIC drivers, and container runtime. Networking owns the LB, anycast, TLS terminator, and BGP announcements. SRE owns the SLO, error budget, paging rotation, and the graceful-degradation plan. The application team owns business logic and the feature surface. A failure in any one of these quadrants caps the whole system, so the staff engineer's real job is keeping the interfaces between them honest: a documented capacity model, a shared load-test harness, a joint on-call, and an ADR trail that records why each tuning knob is set where it is. When an incident fires, the staff engineer is the one who can read a flame graph, a `bpftrace` script, and a Grafana dashboard in the same twenty minutes and tell the room which quadrant owns the root cause.

---
