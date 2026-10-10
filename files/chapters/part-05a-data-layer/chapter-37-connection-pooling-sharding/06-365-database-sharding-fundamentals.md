## 37.5 Database Sharding Fundamentals

### Choosing a Shard Key (The Decision That Defines Your Architecture)

The shard key is the single most consequential decision in a sharded system - it is effectively unchangeable once you have production data, and a bad choice creates hot shards that throttle the entire cluster. Rules from teams that have done this at scale (Pinterest, Instagram, Discord, Slack):

- **High cardinality**: the key must have millions or billions of distinct values. `country_code` has ~200 values - a hot-shard disaster. `user_id`, `tenant_id`, `account_id`, or a UUID work.
- **Even distribution**: hash the key before taking modulo. Monotonic IDs (auto-increment, timestamp) concentrate all new writes on one shard. Twitter's Snowflake IDs embed a timestamp in the high bits - using them directly as a shard key would send every write to the latest shard.
- **Co-locate related data**: pick a key that keeps rows you typically query together on the same shard. Multi-tenant SaaS: `tenant_id`. Social graphs: `user_id` (with duplicated data for the "followers" side). Shopify shards by `shop_id` so an entire merchant lives on one shard.
- **Avoid the celebrity problem**: if one tenant is 10,000x larger than the median (a Shopify Black Friday merchant, a Discord server with 1M members), single-key sharding alone will not save you. Sub-shard hot tenants, or put them on dedicated shards.
- **No cross-shard transactions**: if your design requires a transaction spanning two shard keys, redesign. Denormalize, use sagas, or accept eventual consistency.

**Established sharding platforms worth knowing before you build your own:**

- **Vitess** (MySQL): built at YouTube, used by Slack, Block/Square, GitHub (for some workloads), JD.com. Handles resharding, VReplication for online schema changes, query routing via VTGate. The industry standard for MySQL at scale.
- **Citus** (Postgres): distributed Postgres extension, now owned by Microsoft and embedded in Azure Cosmos DB for PostgreSQL. Handles distributed queries, reference tables, and `CREATE DISTRIBUTED TABLE`.
- **pgcat** (Postgres): Rust-based proxy from PostgresML. Built-in sharding, load balancing across replicas, supports prepared statements in transaction mode from day one.
- **CockroachDB / Spanner / TiDB**: NewSQL systems that shard automatically under a SQL interface. Pay in latency (multi-region Raft) and operational complexity, buy back transparent horizontal scaling.

Writing your own sharding layer is legitimate for well-scoped use cases (hash-sharded key-value access, tenant isolation), but reach for Vitess/Citus before building a general-purpose query router.

### Sharding Strategies

A shard key determines which database node owns a given row. The simplest approach is modular hashing: `hash(key) % numShards`. The `ShardKey` interface below abstracts this so integer, string, and UUID keys each compute their shard index through a type-appropriate hash function. A `ShardRouter` holds the slice of shard connections and maps any `ShardKey` to the correct `*sql.DB`.

```go
package sharding

import (
    "crypto/md5"
    "database/sql"
    "encoding/binary"
    "hash/fnv"
)

// ShardKey represents a sharding key
type ShardKey interface {
    ShardIndex(numShards int) int
}

// IntShardKey for integer-based sharding
type IntShardKey int64

func (k IntShardKey) ShardIndex(numShards int) int {
    return int(k) % numShards
}

// StringShardKey for string-based sharding (consistent hashing)
type StringShardKey string

func (k StringShardKey) ShardIndex(numShards int) int {
    h := fnv.New32a()
    h.Write([]byte(k))
    return int(h.Sum32()) % numShards
}

// UUIDShardKey for UUID-based sharding
type UUIDShardKey string

func (k UUIDShardKey) ShardIndex(numShards int) int {
    hash := md5.Sum([]byte(k))
    // Use first 8 bytes as uint64
    num := binary.BigEndian.Uint64(hash[:8])
    return int(num % uint64(numShards))
}

// ShardRouter routes queries to appropriate shards
type ShardRouter struct {
    shards []*sql.DB
}

func NewShardRouter(shards []*sql.DB) *ShardRouter {
    return &ShardRouter{shards: shards}
}

func (r *ShardRouter) NumShards() int {
    return len(r.shards)
}

// GetShard returns the database for a shard key
func (r *ShardRouter) GetShard(key ShardKey) *sql.DB {
    idx := key.ShardIndex(len(r.shards))
    return r.shards[idx]
}

// GetShardByIndex returns shard by direct index
func (r *ShardRouter) GetShardByIndex(idx int) *sql.DB {
    return r.shards[idx%len(r.shards)]
}

// AllShards returns all shard connections
func (r *ShardRouter) AllShards() []*sql.DB {
    return r.shards
}
```

### Sharded Repository

The repository implementation translates domain method calls into SQL queries, isolating the service layer from database-specific concerns. Each method accepts a context to propagate deadlines and cancellation into the query execution.

```go
package repository

import (
    "context"
    "database/sql"
    "fmt"
    "sync"
)

// ShardedUserRepository manages users across shards
type ShardedUserRepository struct {
    router *ShardRouter
}

func NewShardedUserRepository(router *ShardRouter) *ShardedUserRepository {
    return &ShardedUserRepository{router: router}
}

// User with shard-aware ID
type User struct {
    ID        int64  // Contains shard info in high bits
    TenantID  int64  // Shard key
    Name      string
    Email     string
}

// GetByID retrieves user from correct shard
func (r *ShardedUserRepository) GetByID(ctx context.Context, tenantID, userID int64) (*User, error) {
    shard := r.router.GetShard(IntShardKey(tenantID))

    var user User
    err := shard.QueryRowContext(ctx,
        "SELECT id, tenant_id, name, email FROM users WHERE id = $1 AND tenant_id = $2",
        userID, tenantID,
    ).Scan(&user.ID, &user.TenantID, &user.Name, &user.Email)

    if err != nil {
        return nil, err
    }
    return &user, nil
}

// Create inserts user in correct shard
func (r *ShardedUserRepository) Create(ctx context.Context, user *User) error {
    shard := r.router.GetShard(IntShardKey(user.TenantID))

    // On Postgres, read the generated id back via RETURNING with QueryRow().Scan().
    // LastInsertId() is not supported by the pq/pgx drivers.
    err := shard.QueryRowContext(ctx,
        "INSERT INTO users (tenant_id, name, email) VALUES ($1, $2, $3) RETURNING id",
        user.TenantID, user.Name, user.Email,
    ).Scan(&user.ID)
    return err
}

// ListByTenant gets all users for a tenant (single shard)
func (r *ShardedUserRepository) ListByTenant(ctx context.Context, tenantID int64) ([]*User, error) {
    shard := r.router.GetShard(IntShardKey(tenantID))

    rows, err := shard.QueryContext(ctx,
        "SELECT id, tenant_id, name, email FROM users WHERE tenant_id = $1",
        tenantID,
    )
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var users []*User
    for rows.Next() {
        var user User
        if err := rows.Scan(&user.ID, &user.TenantID, &user.Name, &user.Email); err != nil {
            return nil, err
        }
        users = append(users, &user)
    }
    return users, nil
}

// SearchAll searches across all shards (scatter-gather)
func (r *ShardedUserRepository) SearchAll(ctx context.Context, query string) ([]*User, error) {
    var (
        wg      sync.WaitGroup
        mu      sync.Mutex
        results []*User
        errors  []error
    )

    for _, shard := range r.router.AllShards() {
        wg.Add(1)
        go func(db *sql.DB) {
            defer wg.Done()

            rows, err := db.QueryContext(ctx,
                "SELECT id, tenant_id, name, email FROM users WHERE name ILIKE $1",
                "%"+query+"%",
            )
            if err != nil {
                mu.Lock()
                errors = append(errors, err)
                mu.Unlock()
                return
            }
            defer rows.Close()

            var localResults []*User
            for rows.Next() {
                var user User
                if err := rows.Scan(&user.ID, &user.TenantID, &user.Name, &user.Email); err != nil {
                    mu.Lock()
                    errors = append(errors, err)
                    mu.Unlock()
                    return
                }
                localResults = append(localResults, &user)
            }

            mu.Lock()
            results = append(results, localResults...)
            mu.Unlock()
        }(shard)
    }

    wg.Wait()

    if len(errors) > 0 {
        return nil, fmt.Errorf("errors querying shards: %v", errors)
    }

    return results, nil
}
```

### Junior → FAANG: Prerequisite Gaps and First-Job Context

If you have never sharded a database in production, this section is where most confusion starts. A shard is just a separate database that owns a disjoint subset of rows. You do not shard because you read about it in a book. You shard when a single Postgres primary cannot hold your working set in RAM, or when write IOPS saturate one machine, or when the table has passed roughly 1 to 5 TB and vacuum/index rebuilds no longer finish inside a maintenance window. Before that, vertical scaling and read replicas are almost always the correct answer.

A worked example for a junior engineer. Imagine a multi tenant SaaS with 50 million users across 200 thousand tenants. You pick `tenant_id` as the shard key because your query pattern is "show me this tenant's data" 99 percent of the time. You hash `tenant_id` and take modulo 16 to pick one of 16 Postgres shards. Every tenant lives entirely on one shard. Joins inside a tenant stay local. The celebrity problem shows up when one tenant has 10 million users and the median tenant has 200. That one tenant's shard runs hot while the other 15 are idle. The fix is not to reshard by `user_id`. The fix is to detect the whale tenant and move it to a dedicated shard, which is exactly what Shopify does for Black Friday pods.

Entry level interview questions you should be able to answer cleanly. What is the difference between partitioning and sharding. Partitioning splits a table inside one database instance for query pruning and vacuum locality. Sharding splits across machines for capacity. Why not `user_id % N`. Because N changes when you add shards and every row moves. Use consistent hashing or a directory lookup. Why is `created_at` a terrible shard key. Because all writes land on the newest shard and all reads for recent data land on the same shard, so you have sharded your storage but not your load. What happens on a cross shard join. Either scatter gather at the application layer, or denormalize, or feed a columnar store like ClickHouse or Trino through CDC.

The code in this section uses `hash(key) % numShards`. That is fine for a teaching example. It is wrong for production because adding a seventeenth shard remaps almost every key. The next section on consistent hashing is what you actually ship.

### Senior @ FAANG: Sharding Strategy Governance at Staff and Principal Scope

At staff and principal scope, sharding is not a technology choice. It is a multi year governance problem. The shard key is a contract signed with every future engineer on the team, and reversing it costs eight figures. The work you do before writing any code is worth more than the code itself.

Strategy selection has five canonical shapes and each one fails differently. Range sharding (shard by `user_id` 0 to 1M on shard 0, 1M to 2M on shard 1) gives you efficient range scans and terrible write hotspots because new users cluster on the newest range. HBase and Bigtable use range sharding and pay for it with aggressive region splits and pre splitting. Hash sharding (what `user_id % N` pretends to be) gives you even write distribution and destroys range scans. Cassandra, DynamoDB, and most sharded Postgres deployments use hash. List sharding (EU tenants on shard 0, US on shard 1, APAC on shard 2) is really geographic sharding in disguise and is how you satisfy GDPR data residency. Directory based sharding keeps a lookup table from shard key to shard id, which gives you operational flexibility (move a whale tenant, rebalance) at the cost of a lookup on every query. Vitess topo and Citus metadata tables are directory sharding under the hood. Composite sharding (shard by `tenant_id` with secondary partition by `created_at` month) is what most mature platforms land on because pure hash sharding makes time range cold data archival impossible.

Shard key selection governance is where senior engineers earn their title. Write a shard key RFC before any migration. It must answer nine questions. What is the access pattern distribution across query shapes. What is the skew of the key (p50, p99, p99.9 row count per key value). What is the natural blast radius of a shard outage. Can the key carry through to every secondary index or must you build global indexes. What is the cross shard query budget per request. What is the resharding plan on the day the key proves wrong. What is the backup and PITR unit of recovery. What is the multi region replication topology. What is the compliance boundary (GDPR, HIPAA, SOC2, data residency). If the RFC cannot answer all nine, the shard key is not ready.

Hotspot prevention at scale requires treating the shard key distribution as a first class SLO. `user_id % N` produces hotspots whenever user ids are not uniform, which they never are. Power law distributions are the default in any social, commerce, or messaging system. Discord's famous "big server" problem, Slack's "enterprise grid" problem, and Shopify's flash sale problem are all the same bug. The industry accepted mitigations are sub sharding (split one shard key value across multiple physical shards with a hash suffix like `tenant_id:bucket_0`, `tenant_id:bucket_1`), dedicated shards for whales, and read path caching that isolates the hot reader path from the storage tier. Instagram's 2012 sharding post described 4096 logical shards mapped onto a much smaller physical set, which lets them split logical shards onto new machines without rehashing. That pattern is still correct in 2026.

Consistent hashing variants matter because the classic Karger 1997 paper is rarely what you deploy. Jump hash (Lamping and Veach at Google, 2014) computes the shard in roughly 5 nanoseconds with zero memory, moves the minimum number of keys on resize, and is what you want for stateless hash sharding where the shard count is the only state. Rendezvous hashing (HRW, 1996) gives you weighted nodes and is what you reach for when nodes have different capacities. Maglev hashing (Google 2016) trades a tiny bit of balance for O(1) lookup and is the load balancer inside GCP and Envoy. Bounded load consistent hashing (Mirrokni, Thorup, Zadimoghaddam at Google 2017) caps the load any one node can take to `(1 plus epsilon) times average` and is what Vimeo and Envoy use for sticky session balancing. Pick jump hash for stateless key to shard mapping, Maglev for load balancing, bounded load for sticky work distribution. Virtual nodes (vnodes) are the Cassandra style variant where each physical node owns 256 logical tokens, which smooths distribution and makes rebalance incremental.

Resharding strategy is where most teams discover their shard key was wrong. The industry has converged on three patterns. Vitess VReplication streams writes from source keyspace to target keyspace while the application keeps writing to the source, then cuts over atomically via topo. Slack, GitHub, and YouTube all rely on this. Citus shard rebalancer uses logical replication plus pg_dist_partition metadata swaps to move shards between worker nodes with minutes of lock time. Application level double write plus backfill plus cutover is the fallback when your database does not give you either. Figma published a 2023 post on their horizontal sharding migration using logical replication and PgBouncer pause/resume for the cutover window, which is essential reading.

Cross shard queries are the tax you pay for sharding. Scatter gather (fan out to all shards, aggregate at the router) is O(N) in shard count and its tail latency is the slowest shard. Budget scatter gather to admin queries and background jobs, never to the hot path. Cross shard JOINs are best avoided via data duplication (denormalize the small side onto every shard as a reference table, which Citus supports natively), CDC fed materialized tables (Debezium to Kafka to a columnar store), or query federation (Trino, ClickHouse, Starburst) for analytical workloads. Cross shard ORDER BY with LIMIT requires top K merge across shards, which Vitess and Citus both implement but with caveats on offset. Cross shard GROUP BY requires partial aggregation per shard plus final aggregation at the router and only works correctly for distributive (SUM, COUNT, MIN, MAX) and algebraic (AVG as SUM/COUNT) aggregates, never holistic (MEDIAN, PERCENTILE) without approximation.

Cross shard transactions are where most architectures quietly abandon ACID. Two phase commit is correct and slow and brittle to coordinator failure, which is why Spanner invested in TrueTime and Paxos for their commit protocol and why everyone else uses sagas. The saga pattern (Garcia Molina 1987, popularized by Chris Richardson) breaks a logical transaction into local transactions plus compensating actions, and is what Uber, DoorDash, and Stripe use for cross service workflows. Eventual consistency with idempotency keys is the third option and is what Stripe built their entire payments API around. Pick based on the business cost of a temporarily inconsistent read, not based on architectural purity.

FAANG case studies worth internalizing. Vitess at YouTube scales to thousands of MySQL shards with VTGate as the query router and topo server for metadata. Slack ran MySQL sharded by team id and moved to Vitess in 2020 to 2022, published a detailed migration writeup. GitHub uses Vitess for specific workloads including the main mysql1 cluster. Citus at Microsoft powers Azure Cosmos DB for PostgreSQL and handles multi tenant SaaS at the scale of tens of thousands of tenants per cluster. Instagram sharded Postgres in 2012 with logical to physical shard mapping and that architecture is still in production. Notion scaled from a single Postgres to 480 logical shards distributed across 32 (later 96) physical instances (published in 2021 and 2023) to support their block model, with PgBouncer in front. Figma's 2023 sharding work was their first horizontal partition and used logical replication for online migration. Discord moved from Cassandra to Scylla in 2022 to handle trillions of messages at sub millisecond p99, sharded by channel id. Uber built Schemaless on top of MySQL and then Docstore as a multi region sharded store. Stripe shards by idempotency key hash for their API layer so retries land on the same shard and deduplicate naturally. Shopify's Pod architecture puts a full vertical slice (web, jobs, MySQL, Redis) in one pod and shards shops across pods, which gives them perfect blast radius isolation at the cost of cross pod operations being impossible by design. Each of these teams made different trade offs and each one is defensible. Your job as a staff engineer is to know which one maps to your workload and to write the RFC that explains why.

---
