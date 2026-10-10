## 64D.6 Server Count Estimation

### The Formula

Server count estimation translates traffic and storage requirements into the number of machines needed to handle the load with adequate headroom, accounting for the fundamental difference between CPU-bound and I/O-bound services. A Go HTTP service handling compute-intensive image processing might saturate at 100 RPS per core, while an I/O-bound proxy can handle 10,000+ RPS per core by efficiently multiplexing goroutines while waiting on network calls. The 50-70% utilization target preserves capacity for traffic spikes and prevents the performance cliff where fully-saturated systems experience exponentially increasing tail latency.

```
Servers needed = Peak RPS / (RPS per server × utilization target)

Where:
- Peak RPS: from your traffic estimation
- RPS per server: depends on service type (CPU-bound vs I/O-bound)
- Utilization target: typically 50-70% (headroom for spikes)
```

### CPU-Bound vs. I/O-Bound Service Sizing

**CPU-bound services** (computation-heavy: ML inference, encoding, compression):
- Bottleneck: CPU cycles
- Scaling axis: cores and clock speed
- Typical RPS per server: 100-1,000 (depending on operation cost)
- Example: video transcoding service handles ~1 video per CPU-minute

**I/O-bound services** (network/database-heavy: API servers, web servers):
- Bottleneck: network I/O and database connections
- Scaling axis: concurrency and network bandwidth
- Typical RPS per server: 10,000-100,000 for simple Go HTTP handlers
- Example: Go API server serving simple JSON responses: ~50,000 RPS per 4-core server

**Go-specific throughput benchmarks** (on c5.4xlarge, 16 vCPUs):

```
Service type                        RPS per server
────────────────────────────────────────────────────
Simple HTTP handler (no DB)         100,000-500,000
HTTP handler with Redis cache hit   50,000-100,000
HTTP handler with PostgreSQL query  5,000-20,000
gRPC service (simple proto)         50,000-200,000
gRPC service with DB query          3,000-10,000
```

### Database Sizing

**QPS capacity**:
```
PostgreSQL (c5.4xlarge, 16 vCPUs, NVMe SSD):
- Simple point queries (SELECT by PK): ~50,000 QPS
- Complex queries (JOIN, aggregation): ~2,000-5,000 QPS
- Write-heavy workloads: ~10,000 QPS (IOPS-limited)

Redis (r6g.2xlarge, 8 vCPUs):
- GET/SET: ~500,000 ops/sec (single threaded, single node)
- Cluster: ~millions of ops/sec

Cassandra (i3.2xlarge, NVMe):
- Write: ~50,000-100,000 ops/sec
- Read (cache hit): ~50,000 ops/sec
- Read (disk): ~10,000 ops/sec
```

**Connection pool sizing**:
```
Max DB connections ≈ (CPU cores × 2) + effective_spindle_count

For PostgreSQL on 16 vCPU + NVMe:
Max connections ≈ 16 × 2 + 2 = 34

With 10 application servers, each needing connections:
Connections per app server = 34 / 10 ≈ 3 connections per server

In practice: use pgBouncer (connection pooler) to multiplex
many application connections onto few database connections.
pgBouncer allows 100s of application connections to share 34 DB connections.
```

### Cache Sizing

Cache sizing hinges on Zipf's Law: in virtually every real-world access pattern, a small fraction of content receives a disproportionately large share of requests. This means you do not need to cache the entire dataset to achieve a high hit rate, you only need to cache the "hot" tail. The calculation below derives the required RAM from your target hit rate by identifying what percentage of the corpus accounts for that percentage of traffic, then multiplying by object size. Getting cache sizing right is critical because each cache miss falls through to the database, and the ratio of cache hits to misses directly determines how many database servers you need.

```
To achieve a 90% cache hit rate, you need to cache enough data to serve
90% of incoming requests from memory.

Request distribution follows Zipf's Law: a small fraction of content
gets the vast majority of requests.

For Twitter (150M DAU, ~12M tweets posted per day):
- Reads concentrate heavily on recent and popular tweets, so the hot
  working set is far smaller than all-time tweet volume.
- Hot working set ≈ roughly one day of tweets plus the viral tail,
  about 15M tweets.
- Each tweet (with metadata): ~2 KB
- Cache needed for a 90% hit rate: 15M × 2 KB = 30 GB

This fits in a single Redis node!
Distributed across 3 nodes (replication): 30 GB × 3 = 90 GB
Use r6g.2xlarge (64 GB RAM) - one node per replica
Cost: ~$500/month for all three nodes

For this cache hit rate, your database only receives 10% of reads:
DB reads = 15,000 RPS × 10% = 1,500 QPS - very manageable
```

### Junior → FAANG: Sizing Servers with the Right Mental Model

Server count estimation is where capacity planning becomes concrete: you translate abstract traffic numbers into actual machine counts. The failure mode for junior engineers is treating server sizing as arithmetic (peak RPS divided by RPS per server) without applying the correct mental model for the service type or the utilization target.

**CPU-bound versus I/O-bound is the first question.** Before you can size servers, you must classify the service. A Go HTTP handler that validates a JWT, queries a cache, and returns a JSON response is I/O-bound: it spends most of its time waiting on network calls, and a single server can handle tens of thousands of concurrent requests using goroutines. A video transcoding service is CPU-bound: it spends most of its time on CPU-intensive codec operations, and throughput is limited by CPU core count and clock speed. Applying I/O-bound throughput numbers to a CPU-bound service produces a server count that is 10-100x too low. State the service classification before producing the RPS-per-server estimate.

**The 70% utilization target is not optional.** "100 RPS per server" means 100 RPS before saturation. Running at 100 RPS means you have zero headroom. A 2x traffic spike takes you to 200 RPS, which means 100% utilization and likely cascading latency failures. The 70% target means your effective capacity is 70 RPS per server, and you size server count based on that. Interviewers know this rule and will probe candidates who forget to apply it: "You said 10 servers at 10,000 RPS each. But what happens during a 2x spike?" The expected answer invokes the utilization target and shows that your sizing already accounts for the spike.

**Database connection pool sizing is the hidden bottleneck.** The connection pool formula (CPU cores times two, plus effective spindle count) is the right starting point, but the more important insight is the relationship between connection count and application server count. If your database supports 34 connections and you have 10 application servers, each server gets 3.4 connections. At 5,000 RPS per server with each request taking 5ms of database time, Little's Law gives you 25 concurrent database connections needed per server, far more than 3.4. This mismatch means you need a connection pooler (pgBouncer) that multiplexes application connections onto database connections. Candidates who identify this bottleneck and propose a connection pooler demonstrate production-level database knowledge.

**First-job habit:** When your team is considering adding capacity (more application servers, a new database replica), first calculate the current utilization of each tier using the formulas in this section. If the application servers are at 45% utilization, the bottleneck is elsewhere. If the database is at 85% utilization, that is the tier to address. Measuring before provisioning prevents cargo-culting ("we always add more application servers when things are slow").

**Interview entry point:** "Your Twitter-scale system has 100,000 peak read RPS. Size your application server tier." The expected answer: classify as I/O-bound (cache reads, network), estimate 70,000 RPS per server at 70% utilization, so 100,000 divided by 70,000 is roughly 2 servers. But wait: these are cache-hit reads. The 10% cache miss reads fall through to the database. 10,000 miss RPS at 5,000 QPS per database server at 70% utilization is 3 database servers. Total: 2 application servers, 3 database servers (plus replicas). Candidates who work through both tiers demonstrate end-to-end sizing competence.

### Senior @ FAANG: Server Sizing as a Cost and Reliability Architecture Decision

At senior level, server count estimation is not a one-time calculation: it is the input to provisioning decisions, instance type selection, auto-scaling configuration, and cost modeling.

**ADR: instance type selection based on service workload profile.** The choice between compute-optimized (c-series on AWS), memory-optimized (r-series), and storage-optimized (i-series) instances should be justified by the measured workload profile of the service, not by default convention. A Go API service that is network-I/O-bound with moderate memory use fits a c-series instance. A caching tier that keeps large datasets in memory fits an r-series instance. A database with high IOPS requirements fits an i-series instance with NVMe storage. An ADR for instance type selection must include: measured CPU, memory, and IOPS utilization at target load, comparison of cost-per-unit-of-work across two or three instance types, and a recommendation with quantified cost impact.

**Cache sizing as the variable that changes everything else.** The Zipf's Law analysis in the cache sizing section (30 GB of cache absorbs 90% of Twitter reads) has an important corollary: getting the cache size right is the most impactful capacity decision for read-heavy systems. A cache that is 20% too small (24 GB instead of 30 GB) might drop the cache hit rate from 90% to 85%, increasing database QPS by 50%. A cache that is 50% too large is wasted RAM cost with no reliability benefit. A staff engineer sizing a caching tier must estimate the working set size from access pattern data (or from Zipf distribution assumptions), not just provision "as much RAM as the instance has." Validate the estimate by measuring cache hit rate in production and adjusting if it diverges from the target.

**Connection pool sizing as a shared infrastructure governance concern.** In a microservices environment where many services share a database cluster, the aggregate connection count from all services can exceed the database's maximum connection limit. At 500 connections per PostgreSQL instance and 20 services each using a pool of 30 connections per application server running on 3 servers, the total connection demand is 1,800, far exceeding the limit. A staff engineer managing shared database infrastructure must own the connection budget: allocate connection pool sizes per service, enforce the allocation through pgBouncer configuration or connection limit policies, and provide a connection budget review process for new services.

**L6/L7 concern: multi-dimensional server sizing for heterogeneous workloads.** Real production services rarely have uniform request profiles. A search service handles queries that range from 1ms (cache hit) to 500ms (full index scan). A recommendation service handles requests that range from 5ms (precomputed) to 2s (real-time ML inference). Server sizing that uses average request latency produces incorrect concurrency calculations for services with high latency variance. A staff engineer sizing a heterogeneous service must decompose the workload into request classes, model the concurrency and CPU demand for each class separately, and combine them into a total server count that accounts for the bursty, high-latency tail of the workload distribution. Little's Law applied to average latency alone will underestimate server count for high-variance workloads.

**Governance: server sizing reviews for cost accountability.** In a large organization, compute costs are owned by teams, not by a central infrastructure budget. A staff engineer is accountable for the cost of their team's servers. This accountability requires: knowing the current server count and instance types, knowing the current utilization at each tier, and being able to justify the provisioned capacity relative to peak traffic and headroom targets. Quarterly cost reviews should compare actual utilization to the target utilization band (50-70%). Persistent over-provisioning (below 30% utilization) should trigger right-sizing. Persistent under-provisioning (above 80%) should trigger a capacity increase. The staff engineer drives both conversations.

---
