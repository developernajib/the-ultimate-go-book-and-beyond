## 81.4 Handling Scale Numbers

### Quick Reference

The following reference data provides the back-of-the-envelope scale estimates that system design interviews expect candidates to recall instantly when sizing components, justifying technology choices, or identifying bottlenecks. Internalizing these numbers eliminates the mental arithmetic that slows down live design sessions.

```
┌──────────────────────────────────────────────────────────────┐
│                    SCALE CHEAT SHEET                         │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Time:                                                       │
│  1 day    = 86,400 seconds ≈ 100K seconds                    │
│  1 month  = 2.5M seconds                                     │
│  1 year   = 30M seconds                                      │
│                                                              │
│  Data:                                                       │
│  1 KB     = 1,000 bytes (text, JSON)                         │
│  1 MB     = 1,000 KB (images, small files)                   │
│  1 GB     = 1,000 MB (videos, databases)                     │
│  1 TB     = 1,000 GB (large databases)                       │
│  1 PB     = 1,000 TB (data warehouses)                       │
│                                                              │
│  Latency:                                                    │
│  L1 cache      = 0.5 ns                                      │
│  L2 cache      = 7 ns                                        │
│  RAM           = 100 ns                                      │
│  SSD read      = 150 μs                                      │
│  HDD read      = 10 ms                                       │
│  Same-region   = 0.5 ms                                      │
│  Cross-region  = 50-100 ms                                   │
│  Cross-ocean   = 150-200 ms                                  │
│                                                              │
│  Throughput:                                                 │
│  SSD           = 500 MB/s                                    │
│  NVMe          = 3 GB/s                                      │
│  Network       = 10 Gbps = 1.25 GB/s                         │
│  Redis         = 100K ops/s per node                         │
│  PostgreSQL    = 10K queries/s per node                      │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Example Calculation

Worked calculations demonstrate how to apply back-of-the-envelope estimation techniques to arrive at component sizing and technology selection justifications during a system design interview. The following example walks through the quantitative reasoning step by step, showing the assumptions and rounding strategies that keep estimation fast without sacrificing directional accuracy.

```
Question: "Design a system for Twitter's home timeline"

Users: 300M monthly active, 150M daily active
Tweets: 500M tweets/day

Read volume:
- Each user views timeline 10 times/day
- 150M × 10 = 1.5B timeline reads/day
- 1.5B / 86,400 ≈ 17,000 reads/second

Write volume:
- 500M tweets/day
- 500M / 86,400 ≈ 5,800 tweets/second

Storage:
- Tweet: ~300 bytes average
- 500M × 300 bytes = 150 GB/day
- 150 GB × 365 = 55 TB/year

Design implications:
- Read-heavy (17K:6K ratio)
- Need caching (timeline pre-computation)
- Consider fan-out on read vs write
```

---

### Junior → FAANG: Scale Numbers as Intuition, Not Calculation

Interviewers do not expect mathematically perfect estimation. They expect order-of-magnitude reasoning that leads to defensible design choices. The skill is building intuition for what numbers mean for your architecture: 10K requests per second means a single well-tuned Go service can handle it, 10M requests per second means a load balancer tier and at least 100 service replicas, and 1B requests per second means you are designing a CDN or a DNS resolver.

Memorize the storage and bandwidth reference points from the quick reference table in this section. Being able to say "100 bytes per record, 100M records, so about 10GB total data, which fits in a reasonably sized cache cluster" without reaching for a calculator impresses interviewers and keeps the session moving.

Practice habit: for every LeetCode problem that involves arrays or strings, estimate the memory footprint of your solution given the stated constraints. "The input can be 10^5 characters and I am allocating a map with at most n entries at 24 bytes each, so about 2.4 MB," which is well within typical memory limits." This builds estimation reflex.

### Senior @ FAANG: Back-of-Envelope Estimation as a Production Sizing Discipline

At senior level, back-of-envelope estimation is not just an interview skill. It is a production planning skill. Engineers who can estimate load, storage, and bandwidth requirements before building a system catch capacity problems before they reach production rather than after.

The Twitter-scale example in this section (17K reads/second, 6K writes/second) is the starting point. A senior candidate extends the estimation to: "at 6K writes/second and 300 bytes per write, we are writing 1.7 MB/second to our primary store. At the database replication factor of 3, that is 5.1 MB/second of write throughput required from the storage layer. This means we need SSDs with at least 50 MB/s sustained write throughput (10x headroom), which rules out spinning disks and constrains our hosting options."

ADR application: capacity estimation feeds directly into infrastructure decisions. A well-documented capacity estimate, with assumptions stated explicitly and sensitivity analysis for 2x growth, is the foundation of a good infrastructure ADR. Demonstrating in an interview that your estimations are assumption-documented and growth-aware shows that you build systems for the future, not just for today.
