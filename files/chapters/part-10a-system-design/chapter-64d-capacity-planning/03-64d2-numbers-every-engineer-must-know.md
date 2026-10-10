## 64D.2 Numbers Every Engineer Must Know

### The Jeff Dean Numbers

In 2009, Jeff Dean (Google Senior Fellow) published latency numbers that every engineer should have memorized. These numbers have been updated as hardware has improved, but the order-of-magnitude relationships remain fundamentally correct.

**Latency Numbers (2024 estimates)**:

```
Operation                          Latency         Notes
─────────────────────────────────────────────────────────────────
L1 cache reference                 0.5 ns
Branch misprediction               5 ns
L2 cache reference                 7 ns
Mutex lock/unlock                  25 ns
Main memory reference              100 ns          ~200x L1 cache
Compress 1KB (Snappy)              3 μs (3,000 ns)
Send 1KB over 1Gbps network        10 μs           ~100x memory
Read 4KB random from NVMe SSD      100 μs          ~1,000x memory
Read 1MB sequentially from memory  250 μs
Round trip within same datacenter  500 μs
Read 1MB sequentially from NVMe    1 ms
Disk seek (HDD)                    10 ms           ~100x NVMe
Read 1MB sequentially from HDD     20 ms
Send packet CA → Netherlands → CA  150 ms
```

**The critical ratios to remember**:
- L1 cache: 1 ns
- Memory: 100 ns (100x L1)
- NVMe SSD: 100 μs (1,000x memory)
- Network (same DC): 500 μs (5x SSD)
- HDD seek: 10 ms (20x network, 100,000x memory)
- Cross-continent: 150 ms (300x HDD seek)

**Implications for architecture**:

A request that hits L1 cache costs 0.5 ns. A request that hits main memory costs 100 ns - that is a 200x penalty for a cache miss. This is why CPU-bound hot paths must fit in cache.

A request that hits NVMe SSD costs 100 μs. A request that hits HDD costs 10 ms - a 100x penalty. This is why HDDs are unacceptable for databases serving interactive traffic. They belong only in cold storage, data lakes, and sequential-write workloads (logs, backups).

A cross-datacenter network round trip costs 150 ms. If your service makes three synchronous cross-datacenter calls per user request, your minimum latency is 450 ms before any compute. This is why geographic distribution and regional affinity matter.

### Throughput Numbers

```
Resource                           Throughput      Notes
─────────────────────────────────────────────────────────────────
Single CPU core (operations)       ~1 billion/sec  For simple ALU ops
Single CPU core (HTTP requests)    ~10,000/sec     With network I/O
PostgreSQL (simple queries)        ~50,000 QPS     On c5.4xlarge
Redis (single thread)              ~100,000 ops/s  SET/GET
Kafka (single partition)           ~50 MB/s        Sequential writes
NVMe SSD (sequential read)         ~3,500 MB/s     PCIe 4.0
NVMe SSD (sequential write)        ~3,000 MB/s
NVMe SSD (random 4K reads)         ~700,000 IOPS
HDD (sequential read)              ~200 MB/s
HDD (random 4K reads)              ~100 IOPS       The killer number
1 Gbps network link                ~125 MB/s       (1,000 / 8)
10 Gbps network link               ~1,250 MB/s
100 Gbps network link              ~12,500 MB/s
```

**The HDD IOPS number deserves special attention**: 100 random IOPS per HDD is the reason traditional HDDs are unsuitable for databases. A PostgreSQL server running on HDDs can serve perhaps 100 random I/O queries per second before the disk becomes the bottleneck. The same server on NVMe SSD can serve 700,000 IOPS - a 7,000x improvement. This is not a rounding difference. It is an architectural difference.

### Powers of 2

For estimation, use powers of 2 for capacity and powers of 10 for rates:

```
2^10  = 1,024           ≈ 1 thousand (1K)
2^20  = 1,048,576       ≈ 1 million (1M)
2^30  = 1,073,741,824   ≈ 1 billion (1B)
2^40  ≈ 1 trillion (1T)

Useful relationships:
1 KB = 1,024 bytes ≈ 10^3 bytes
1 MB = 1,048,576 bytes ≈ 10^6 bytes
1 GB = 1,073,741,824 bytes ≈ 10^9 bytes
1 TB ≈ 10^12 bytes
1 PB ≈ 10^15 bytes
```

**Memory conversion trick**: When multiplying rates by times, convert units first.

```
100 million users × 10 KB/user = 1,000,000,000 KB = 1,000,000 MB = 1,000 GB = 1 TB
```

### Storage Sizes

These are the canonical storage constants for estimation. Memorize these.

```
Object                     Size        Notes
─────────────────────────────────────────────────────────────────
UUID                       16 bytes    Standard UUID-4
Email address              320 bytes   Max per RFC 5321 (average ~30 bytes)
Tweet (text)               280 bytes   Twitter character limit
Short URL record           500 bytes   URL, metadata, counters
User profile               1 KB        Name, email, prefs, metadata
Web page (avg HTML)        80 KB       Uncompressed
Low-res image (JPEG)       100 KB      Profile photo, thumbnail
HD image (JPEG)            1 MB        Typical smartphone photo (compressed)
RAW image                  25 MB       DSLR unprocessed
Audio (MP3, 1 min)         1 MB        128 kbps encoding
Video (SD, 1 min)          10 MB       480p, 1 Mbps bitrate
Video (HD, 1 min)          50 MB       1080p, 7 Mbps bitrate
Video (4K, 1 min)          200 MB      4K, 25 Mbps bitrate
Typical API response       10 KB       JSON payload, compressed
Log line                   200 bytes   Structured JSON log entry
Database row (typical)     100-500 bytes
```

### Junior → FAANG: Drilling the Numbers Until They Are Automatic

The latency numbers in this section are the foundation of every capacity estimate and architecture justification you will make in a FAANG interview. The goal is not familiarity: it is automatic recall so that you can say "an HDD seek is 10ms and an NVMe read is 100 microseconds, so HDDs are 100x slower for random access" without pausing.

**How to memorize the latency ratios, not just the numbers.** The most durable way to internalize these numbers is through the ratios. Memory is 200x slower than L1 cache. NVMe is 1,000x slower than memory. A same-DC network round trip is 5x slower than NVMe. An HDD seek is 20x slower than a same-DC round trip. Cross-continent is 15x slower than an HDD seek. These ratios give you a chain: if you remember L1 cache is about 1ns, you can derive every other number. Practice the chain out loud.

**The HDD IOPS number is a decision gate.** 100 IOPS for random reads is not just a benchmark: it is the architectural constraint that makes HDDs unacceptable for any database serving interactive queries. If you cannot recall this number in an interview and say "HDDs can only do about 100 random IOPS, which is why we need NVMe for the database tier," you will miss the justification that interviewers expect. The moment an interviewer hears you say "100 random IOPS," they know you understand why storage hardware choices matter.

**Powers of 2 and storage unit conversions as arithmetic shortcuts.** In an interview, you will multiply numbers like "100M users times 3MB per photo." If you pause to do the arithmetic, you lose time. Practice converting to TB in one step: 100M users times 3MB is 300 million MB, which is 300,000 GB, which is 300 TB. Then multiply by 3 for replication. The pattern (millions times MB equals TB) is worth internalizing as a shortcut.

**First-job habit:** Before proposing any storage system in a design discussion, state two numbers out loud: the expected random read IOPS requirement and the target system's IOPS capacity. If the IOPS requirement exceeds the system's capacity, you have caught an architectural problem before it becomes a production incident.

**Interview entry point:** "Why would you choose NVMe over HDD for a write-ahead log?" The expected answer references both IOPS (100 vs 700,000 for random) and sequential throughput (200 MB/s vs 3,500 MB/s for sequential), and then notes that write-ahead logs are mostly sequential, so the sequential throughput difference (17x) matters more than the random IOPS difference. Distinguishing sequential from random workloads demonstrates hardware-aware thinking.

### Senior @ FAANG: Using Hardware Numbers to Drive Architecture and Cost Decisions

At senior level, the numbers in this section are not interview preparation material. They are the vocabulary of architectural decision-making and cost optimization discussions that happen in design reviews, post-mortems, and infrastructure planning.

**ADR: storage tier selection based on access patterns.** Every service that writes data should have a documented storage tier strategy that references actual IOPS and throughput requirements. An ADR for "migrate hot data to NVMe-backed instances" must include: current p99 read latency on HDD-backed storage, expected p99 latency on NVMe-backed storage (derived from the IOPS numbers), cost difference per TB, and the traffic volume at which the latency improvement justifies the cost. Without these numbers in the ADR, the decision is opinion, not engineering.

**Latency budgets as a design discipline.** A request that makes three database calls, two cache lookups, and one external API call has a latency structure that can be analyzed before any code is written. Using the numbers from this section: two cache lookups at ~500 microseconds each (NVMe-backed Redis with local network hop), three database calls at ~5ms each (PostgreSQL query with index on NVMe), and one external API call at ~50ms (same region). The total minimum latency is approximately 65ms before any application code. If the SLA target is 100ms, the budget leaves only 35ms for application logic. This analysis happens in the design phase, not after deployment.

**Throughput numbers as team vocabulary.** When your team's design documents say "the service is high throughput," that phrase is meaningless. When they say "the service handles 50K QPS on a single PostgreSQL primary with NVMe-backed storage, which is within the 50K QPS capacity ceiling we measured in load testing," the statement is actionable. A staff engineer establishes this precision as the team norm. Design documents that use vague performance language get returned for revision.

**Cost modeling using hardware numbers.** The cost difference between HDD-backed and NVMe-backed storage instances on AWS or GCP is approximately 3-4x per GB. For a service with 10 TB of hot data, the monthly cost difference is significant. The question a staff engineer asks is not "which is faster" but "what is the latency improvement worth in SLA terms, and does that improvement justify the cost at our scale?" For interactive user traffic with a 100ms SLA, NVMe is non-negotiable: HDD latency would consume the entire budget on disk seeks alone. For sequential log ingestion where p99 latency is 1 second, HDDs are cost-effective. The hardware numbers make these decisions quantitative.

**L6/L7 concern: hardware assumptions in capacity models decay over time.** The latency numbers in this section are 2024 estimates. PCIe 5.0 NVMe drives already offer 2x the random IOPS of PCIe 4.0. Network hardware in hyperscaler data centers runs at 100 Gbps with sub-100 microsecond latency between nodes in the same rack. A staff engineer maintaining long-lived capacity models must account for hardware refresh cycles: a model built on 2020 hardware assumptions for a 2028 growth projection will overestimate compute requirements. Parameterizing hardware assumptions in capacity models (rather than hard-coding them) makes models easier to update as hardware improves.

**Governance: who updates the canonical numbers.** If your team has a shared capacity planning document or template, someone must own updating the hardware reference numbers when new instance types or storage technologies become available. This is not a glamorous ownership area, but stale hardware numbers lead to over-provisioning (wasted cost) or under-provisioning (capacity incidents). A staff engineer assigns this ownership explicitly and ensures the update process is part of the annual infrastructure review.

---
