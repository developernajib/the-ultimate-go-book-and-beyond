## Interview Questions

### Question 1: How would you design a system to handle 1 million requests per second?

**What FAANG expects:** A structured walk through: requirements (read/write ratio, payload size, latency SLO, consistency), back-of-envelope capacity math, and per-tier scaling strategy. Interviewers want to see you identify the bottleneck at each layer (LB, app tier, cache, DB) and apply the right tool. Bonus for naming realistic capacities (10-30k RPS per Go instance, 10-100k writes/sec per Postgres primary, 1M ops/sec per Redis shard) and for calling out that 1M RPS is regional, not single-DC.

**Answer:**

This question tests your ability to reason systematically about scale across every architectural layer. A complete answer covers the request path from load balancer to database, identifies the bottleneck at each tier, and proposes the appropriate scaling strategy, horizontal scaling for stateless services, read replicas and connection pooling for databases, multi-layer caching for hot data, and async processing for write-heavy workloads. The framework below provides a structured answer template that can be adapted to any high-throughput system design question.

```go
/*
High-Throughput System Design Framework:

1. UNDERSTAND THE REQUIREMENTS
   - Read vs Write ratio
   - Data size per request
   - Latency requirements (p99)
   - Consistency requirements
   - Geographic distribution

2. CALCULATE CAPACITY
   - 1M RPS = ~86.4 billion requests/day
   - If 1KB per request = ~86.4TB/day data transfer (~1 GB/s ingress/egress)
   - Need ~25-100Gbps network capacity (8 Gbps sustained, with peak headroom)

3. ARCHITECTURE LAYERS
*/

// Layer 1: Global Load Balancing (DNS-based)
type GlobalLoadBalancer struct {
    regions map[string]*Region
    // GeoDNS routes to nearest region
    // Anycast for DDoS resilience
}

// Layer 2: Regional Load Balancing (L4/L7)
type RegionalLoadBalancer struct {
    // L4 (NLB): For raw TCP throughput
    // L7 (ALB): For HTTP routing, SSL termination
    backends []*AppServer
}

// Layer 3: Application Tier (Stateless)
type AppServer struct {
    // Horizontally scaled
    // 10K RPS per instance = 100 instances
    // Kubernetes for orchestration
}

// Layer 4: Caching (Multi-tier)
type CacheStrategy struct {
    l1 *LocalCache    // In-process, microseconds
    l2 *RedisCluster  // Distributed, milliseconds
    l3 *CDN           // Edge cache for static
}

func (c *CacheStrategy) Get(ctx context.Context, key string) ([]byte, error) {
    // L1: Check local cache first
    if val, ok := c.l1.Get(key); ok {
        return val, nil
    }

    // L2: Check distributed cache
    val, err := c.l2.Get(ctx, key)
    if err == nil {
        c.l1.Set(key, val) // Populate L1
        return val, nil
    }

    return nil, ErrCacheMiss
}

// Layer 5: Database (Sharded)
type DatabaseCluster struct {
    shards []*Shard
    // Each shard handles ~10K writes/sec
    // For 100K writes/sec = 10 shards
    // Read replicas per shard for reads
}

/*
SCALING MATH:

If 1M RPS total:
- 80% reads, 20% writes (common ratio)
- 800K reads/sec, 200K writes/sec

Caching (90% hit rate):
- 720K reads from cache (instant)
- 80K reads hit database

Database capacity:
- 80K reads + 200K writes = 280K ops/sec
- At 10K ops/shard = 28 shards minimum

Application servers:
- 10K RPS per server (conservative)
- 100 servers minimum
- 150 servers for headroom

ARCHITECTURE DIAGRAM:

                    ┌───────────────────┐
                    │    CloudFlare     │ ← DDoS protection
                    │    (Edge/CDN)     │
                    └─────────┬─────────┘
                              │
            ┌─────────────────┼─────────────────┐
            │                 │                 │
     ┌──────▼──────┐   ┌──────▼──────┐   ┌──────▼──────┐
     │  Region US  │   │  Region EU  │   │  Region AP  │
     └──────┬──────┘   └──────┬──────┘   └──────┬──────┘
            │                 │                 │
     ┌──────▼──────┐                    ┌──────▼──────┐
     │     NLB     │                    │     NLB     │
     └──────┬──────┘                    └──────┬──────┘
            │                                  │
     ┌──────┴──────┐                    ┌──────┴──────┐
     │ App Servers │                    │ App Servers │
     │  (50 pods)  │                    │  (50 pods)  │
     └──────┬──────┘                    └──────┬──────┘
            │                                  │
     ┌──────▼──────┐                    ┌──────▼──────┐
     │   Redis     │                    │   Redis     │
     │  Cluster    │                    │  Cluster    │
     └──────┬──────┘                    └──────┬──────┘
            │                                  │
            └──────────────┬───────────────────┘
                           │
                    ┌──────▼──────┐
                    │   Database  │
                    │  (Sharded)  │
                    │   28 shards │
                    └─────────────┘
*/
```

**Follow-ups:**
- *Where does 1M RPS typically break first in a naive design?* The database. Caches can absorb 90%+ read traffic, but without sharding or read replicas, the write path caps out at single-node throughput (10-100k/sec depending on engine). Plan sharding from day one at this scale.
- *How do you pick between DynamoDB, Spanner, and sharded Postgres for the primary store at 1M RPS?* DynamoDB if access patterns are single-key or well-known (predictable cost, auto-scaling). Spanner for global strong consistency (pay the latency tax). Sharded Postgres when you need relational features and control the operations.
- *What SLO are you actually committing to?* Usually p99 latency + availability. 1M RPS sustained at p99 < 100ms = Netflix/Discord territory. Communicate the cost: three-region active-active with shared state is 5-10x the single-region bill.

### Question 2: Explain the difference between horizontal and vertical scaling. When would you choose each?

**What FAANG expects:** The vertical-first rule: scale up until you hit hardware limits or single-point-of-failure risk, then scale out. For stateless services, horizontal is cheap and elastic. For databases, vertical gets you further than most interviewers expect (modern Postgres on a 96-vCPU node handles a lot). Bonus for mentioning the hybrid (vertically scaled write primary + horizontally scaled app/read replicas/cache) and the operational cost of distribution (distributed transactions, partial failures, observability complexity).

**Answer:**

Vertical scaling adds resources to a single machine. horizontal scaling adds more machines. The answer should cover the trade-offs of each approach, when to use them, and demonstrate that a hybrid strategy, vertically scaled database primaries with horizontally scaled stateless application servers and read replicas, is often the best fit for production systems. The code below contrasts a simple single-node transaction with a distributed saga, and shows a hybrid architecture that combines both scaling strategies.

```go
/*
VERTICAL SCALING (Scale Up)
===========================

Definition: Add more resources (CPU, RAM, disk) to existing machine

Example progression:
t2.micro → t2.large → r5.4xlarge → r5.24xlarge
(1 vCPU)   (2 vCPU)   (16 vCPU)    (96 vCPU)

Pros:
✓ Simple - no code changes
✓ No distributed system complexity
✓ ACID transactions easy
✓ Lower operational overhead

Cons:
✗ Hardware limits (max ~448 vCPUs on AWS)
✗ Single point of failure
✗ Expensive at high end
✗ Downtime for upgrades

Best for:
- Early stage startups
- Relational database primary
- Legacy applications
- Low traffic applications
*/

type VerticallyScaledApp struct {
    db *sql.DB // Single powerful database server
}

func (app *VerticallyScaledApp) TransferMoney(ctx context.Context, from, to string, amountCents int64) error {
    // Simple transaction - no distributed complexity
    tx, _ := app.db.BeginTx(ctx, nil)
    defer tx.Rollback()

    tx.Exec("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?", amountCents, from)
    tx.Exec("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?", amountCents, to)

    return tx.Commit()
}

/*
HORIZONTAL SCALING (Scale Out)
==============================

Definition: Add more machines to distribute load

Example:
1 server → 3 servers → 10 servers → 100 servers

Pros:
✓ Unlimited scale (in theory)
✓ Fault tolerant
✓ Cost efficient at scale
✓ No downtime for scaling

Cons:
✗ Distributed system complexity
✗ Network partitions
✗ Consistency challenges
✗ More operational overhead

Best for:
- High traffic applications
- Stateless services
- Read-heavy workloads
- Cloud-native applications
*/

type HorizontallyScaledApp struct {
    nodes []*Node
    lb    *LoadBalancer
}

func (app *HorizontallyScaledApp) TransferMoney(ctx context.Context, from, to string, amountCents int64) error {
    // Need distributed transaction (Saga pattern)
    saga := &TransferSaga{
        from:        from,
        to:          to,
        amountCents: amountCents,
    }

    // Step 1: Reserve funds
    if err := saga.ReserveFunds(ctx); err != nil {
        return err
    }

    // Step 2: Credit destination
    if err := saga.CreditDestination(ctx); err != nil {
        saga.CompensateReservation(ctx) // Rollback
        return err
    }

    // Step 3: Confirm debit
    return saga.ConfirmDebit(ctx)
}

/*
DECISION MATRIX:

┌──────────────────┬───────────────┬───────────────────┐
│ Factor           │ Vertical      │ Horizontal        │
├──────────────────┼───────────────┼───────────────────┤
│ Traffic          │ < 10K RPS     │ > 10K RPS         │
│ Data consistency │ Strong needed │ Eventual OK       │
│ Budget           │ Low           │ High at scale     │
│ Team size        │ Small         │ Large             │
│ Downtime OK      │ Yes           │ No                │
│ Legacy code      │ Yes           │ No                │
│ Cloud-native     │ No            │ Yes               │
└──────────────────┴───────────────┴───────────────────┘

HYBRID APPROACH (Best of both):
*/

type HybridScaling struct {
    // Vertically scaled write leader
    writePrimary *sql.DB // r5.8xlarge

    // Horizontally scaled read replicas
    readReplicas []*sql.DB // 5 x r5.4xlarge

    // Horizontally scaled application tier
    appServers []*AppServer // 10 pods

    // Horizontally scaled cache
    cacheCluster *RedisCluster // 6 node cluster
}

func (h *HybridScaling) ReadQuery(ctx context.Context, query string) (*sql.Rows, error) {
    // Distribute reads across replicas
    replica := h.readReplicas[rand.IntN(len(h.readReplicas))]
    return replica.QueryContext(ctx, query)
}

func (h *HybridScaling) WriteQuery(ctx context.Context, query string, args ...any) error {
    // All writes go to primary
    _, err := h.writePrimary.ExecContext(ctx, query, args...)
    return err
}
```

**Follow-ups:**
- *When does scaling vertically bite you despite the simplicity?* At upgrade time (downtime or complex failover), when one primary becomes a SPOF, and when you run out of SKU (AWS tops out around 448 vCPU / 24TB RAM). Scale up until the next upgrade is scarier than going distributed.
- *Is a stateless service truly stateless?* No, it usually depends on a cache, a DB, a message bus. "Stateless" means no session state *on the node*. Moving state to backing services does not remove it, it centralizes it.
- *How do read replicas interact with consistency requirements?* Replica reads are eventually consistent (replication lag, typically 10-500ms). Route read-your-write queries to the primary, or use session consistency tokens (Aurora, Spanner) to pin to a replica that has caught up.

### Question 3: How would you design a globally distributed system with low latency?

**What FAANG expects:** Data locality is the crux: each user has a home region for writes, and other regions read from replicas (eventually consistent) or from home (strongly consistent, latency cost). GeoDNS / Anycast for routing. Multi-region active-active costs a lot. Active-passive is simpler. Bonus for discussing data residency laws (GDPR, India DPDP Act) that *force* locality, and for naming CRDTs for cases where you want local writes with eventual convergence.

**Answer:**

Achieving sub-100ms p99 latency globally requires serving requests from the region closest to the user, which means deploying application servers and caches in multiple regions and routing traffic via GeoDNS or anycast. Data placement is the central challenge: each user's data has a "home" region where writes are authoritative, and reads from other regions use local replicas with eventual consistency for non-critical data or cross-region reads for strong consistency when required. The implementation below demonstrates multi-region routing, data locality decisions, edge caching, and connection optimization patterns.

```go
/*
GLOBAL DISTRIBUTION ARCHITECTURE

Goal: <100ms p99 latency worldwide

Key Strategies:
1. Edge computing (serve from nearest location)
2. Data locality (data near users)
3. Async replication (eventual consistency for global data)
4. Smart routing (GeoDNS, anycast)
*/

// Multi-region deployment
type GlobalSystem struct {
    regions map[string]*Region
    router  *GlobalRouter
}

type Region struct {
    name         string
    datacenters  []*Datacenter
    primaryDB    *sql.DB        // Regional primary
    replicaDBs   []*sql.DB      // Read replicas
    cache        *RedisCluster
    localData    bool           // Does this region own user data?
}

// GeoDNS routing
type GlobalRouter struct {
    dns         *GeoDNS
    healthCheck *HealthChecker
}

func (r *GlobalRouter) RouteRequest(userIP string) string {
    // 1. Determine user's region from IP
    userRegion := r.dns.GetRegion(userIP)

    // 2. Check if nearest region is healthy
    if r.healthCheck.IsHealthy(userRegion) {
        return userRegion
    }

    // 3. Fallback to next nearest healthy region
    return r.healthCheck.GetNearestHealthy(userRegion)
}

// Data placement strategy
type DataPlacement int

const (
    LocalOnly    DataPlacement = iota // Data stays in user's region
    GlobalRead                        // Read anywhere, write to home region
    GlobalWrite                       // Write anywhere (conflict resolution)
)

type UserDataService struct {
    regions map[string]*Region
    router  *GlobalRouter
}

func (s *UserDataService) GetUser(ctx context.Context, userID string) (*User, error) {
    // Determine user's home region
    homeRegion := s.getUserHomeRegion(userID)
    currentRegion := s.router.CurrentRegion(ctx)

    if homeRegion == currentRegion {
        // User in home region - read from local DB
        return s.regions[homeRegion].primaryDB.GetUser(ctx, userID)
    }

    // User accessing from different region
    // Option 1: Read from local replica (eventual consistency)
    // Option 2: Read from home region (strong consistency, higher latency)

    // Use local replica for profile data (eventual consistency OK)
    return s.regions[currentRegion].replicaDBs[0].GetUser(ctx, userID)
}

func (s *UserDataService) UpdateUser(ctx context.Context, user *User) error {
    homeRegion := s.getUserHomeRegion(user.ID)

    // Always write to home region
    if err := s.regions[homeRegion].primaryDB.UpdateUser(ctx, user); err != nil {
        return err
    }

    // Async replication to other regions
    go s.replicateGlobally(ctx, user)

    return nil
}

// Edge caching for static content
type EdgeCache struct {
    cdn     *CloudFrontCDN
    origins map[string]*Origin
}

func (e *EdgeCache) GetStaticContent(ctx context.Context, path string) ([]byte, error) {
    // CDN handles:
    // 1. Edge caching (300+ locations worldwide)
    // 2. SSL termination
    // 3. DDoS protection
    // 4. Compression
    // 5. HTTP/2 multiplexing

    return e.cdn.Get(ctx, path)
}

// Real-time data with regional writes
type RealTimeService struct {
    regions map[string]*Region
    pubsub  *GlobalPubSub
}

func (r *RealTimeService) PublishMessage(ctx context.Context, channelID string, msg Message) error {
    currentRegion := r.getCurrentRegion(ctx)

    // Write to local region first
    if err := r.regions[currentRegion].cache.Publish(ctx, channelID, msg); err != nil {
        return err
    }

    // Fan out to other regions via global pub/sub
    for region := range r.regions {
        if region != currentRegion {
            r.pubsub.Publish(ctx, region, channelID, msg)
        }
    }

    return nil
}

/*
LATENCY OPTIMIZATION TECHNIQUES:

1. Connection Pooling
   - Reuse TCP connections
   - Pre-warm connections
   - Keep-alive

2. Protocol Optimization
   - HTTP/2 multiplexing
   - gRPC for internal services
   - WebSocket for real-time

3. Data Format
   - Protocol Buffers (smaller than JSON)
   - Compression (gzip, brotli)

4. Caching Hierarchy
   - Browser cache (localStorage)
   - CDN edge cache
   - Regional cache (Redis)
   - Database cache

5. Async Operations
   - Fire and forget for non-critical
   - Queue processing
   - Event-driven architecture
*/

// Connection optimization
type OptimizedClient struct {
    pool *ConnectionPool
    http *http.Client
}

func NewOptimizedClient() *OptimizedClient {
    transport := &http.Transport{
        MaxIdleConns:        100,
        MaxIdleConnsPerHost: 100,
        MaxConnsPerHost:     100,
        IdleConnTimeout:     90 * time.Second,
        DisableCompression:  false,
        ForceAttemptHTTP2:   true,
    }

    return &OptimizedClient{
        http: &http.Client{
            Transport: transport,
            Timeout:   10 * time.Second,
        },
    }
}
```

**Follow-ups:**
- *Active-active vs active-passive, which pays off?* Active-passive is ~2x the cost (idle standby), simpler consistency. Active-active can be 3-5x (replication bandwidth, conflict resolution) but gives lower p99 globally and smaller blast radius. Pick per-service, not per-company.
- *How do you handle a regional outage for writes?* If primary region is down, failover requires a predefined leader election (or manual runbook). Spanner and CockroachDB handle it automatically at the cost of synchronous quorum writes. Aurora Global with unplanned failover takes minutes.
- *When do you actually need CRDTs?* Real-time collaborative documents, offline-first mobile apps, multi-leader replication where conflicts are frequent. For typical user-scoped data (one writer at a time), last-write-wins with a version column suffices and is far cheaper.

### Junior → FAANG: Interview Strategy and Self-Preparation

The three questions in this section cover roughly 80% of FAANG system design interviews for L4 and L5 candidates. Before your screen, practice answering each one out loud in under 40 minutes, including the estimation step.

The most common failure mode is spending too long on estimation and not reaching the component design. A good rule: spend no more than 5-8 minutes on back-of-envelope math, state your assumptions explicitly, and move on. The math does not need to be exact. It needs to demonstrate that you think about scale before you design.

A prerequisite gap for many candidates: knowing realistic numbers for common components. Memorize these:
- A single Go HTTP server on modern hardware: 10,000 to 50,000 RPS depending on workload complexity.
- A PostgreSQL primary: 1,000 to 10,000 writes per second before connection pool or disk I/O becomes the bottleneck.
- A Redis instance: 100,000 to 1,000,000 operations per second for simple get/set.
- A Kafka partition: 10,000 to 100,000 messages per second depending on message size and replication factor.

Knowing these numbers lets you do capacity math in 2 minutes and gives you credibility when you say "at 1M RPS, I need approximately 100 application servers and 28 database shards."

For Question 3 (global distribution), the most important thing to say early is: "the primary challenge is data locality, specifically which region owns each user's writes." Candidates who skip this and jump straight to CDN and GeoDNS are missing the hardest part of the problem.

### Senior @ FAANG: Bar-Raiser Signals for L6 and L7

At L6 and above, the three questions in this section are baseline. Any L6 candidate is expected to answer them correctly. The bar-raiser evaluation is on the depth, proactivity, and precision of the reasoning.

**What separates L5 from L6 in a system design interview.**
- L5 produces a correct architecture for the happy path. L6 proactively identifies failure modes and designs mitigations without being prompted.
- L5 can name the right components. L6 can explain the cost of each component in specific terms: latency overhead, operational complexity, consistency trade-off, failure blast radius.
- L5 answers follow-up questions correctly. L6 asks the clarifying questions that reveal the interesting design constraints before the interviewer does.
- L5 describes a design for the stated scale. L6 identifies where the design breaks at 10x and names the next architectural evolution.

**What separates L6 from L7 in a system design interview.**
- L6 designs a single large system well. L7 designs a system whose architecture can be adopted as a platform by other teams without modification.
- L6 makes good trade-offs for the stated constraints. L7 explicitly discusses organizational and operational trade-offs in addition to technical ones: team ownership, operational cost at scale, migration path from the current state.
- L6 demonstrates expertise in a domain. L7 demonstrates how that expertise translates into standards, tooling, and patterns that scale across an organization.

**Interview-specific L7 signals for the 1M RPS question.** A typical L7 answer includes: explicit mention of the cost of three-region active-active (roughly 5-10x the single-region cost, due to replication bandwidth, cross-region latency for synchronous operations, and operational complexity), a statement about which SLO dimension (latency, availability, or consistency) is sacrificed in the chosen architecture, and a proactive discussion of where the design would need to change if the requirement changed (for example, if 90% of users are in one region, the three-region active-active design is over-engineered and a single primary with a warm standby is more appropriate).

**The operational dimension.** Senior interviewers at FAANG often probe operational concerns that pure-theory candidates miss: who is on call for this system, what does the runbook look like for a database failover, how do you do a zero-downtime migration of this sharded database when you need to add shards, and what does a successful quarterly capacity review look like? A candidate who can answer these questions fluently is demonstrating staff-level operational maturity, not just design skill.

---
