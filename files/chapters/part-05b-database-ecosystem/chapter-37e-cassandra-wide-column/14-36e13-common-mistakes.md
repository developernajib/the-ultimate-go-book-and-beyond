## 37E.13 Common Mistakes

### 1. Treating Cassandra Like a Relational Database

Cassandra has no query planner and will not accept a WHERE clause that lacks the partition key, because that would require scanning every node in the cluster. The solution is to invert the design: define one denormalized table per query pattern so every read hits a single, known partition.

```go
// BAD: querying without partition key (full table scan)
// SELECT * FROM orders WHERE status = 'pending' -- no partition key!
// Forces Cassandra to scan ALL nodes → extremely slow, resource-intensive

// GOOD: always include partition key
// Create a separate table for each query pattern
// SELECT * FROM orders_by_status_date WHERE status = 'pending' AND date_bucket = '2026-03-13'
```

### 2. Unbounded Partitions

A partition key like `user_id` alone means a power user's entire order history lands on one Cassandra node (potentially millions of rows), creating a hotspot that overwhelms that replica's memory and compaction threads. Adding a time bucket (month, week) to the partition key caps partition size and spreads the load across the cluster.

```go
// BAD: user's entire order history in one partition
// CREATE TABLE orders_by_user (user_id UUID, created_at TIMESTAMP, ...)
// A user with 10M orders → 1 partition with 10M rows → hot partition, slow reads

// GOOD: bucket by time period
// CREATE TABLE orders_by_user_month (
//   user_id UUID, month TEXT, created_at TIMESTAMP, ...
//   PRIMARY KEY ((user_id, month), created_at)
// )
// Max partition: ~30 days of orders per user
```

### 3. Overusing Logged Batches for Performance

Cassandra's logged batch guarantees atomicity but requires the coordinator to synchronize all replica acknowledgments before returning, making it slower than individual writes when the statements touch different partitions. For bulk throughput across many partitions, issuing concurrent individual writes with goroutines is significantly faster.

```go
// BAD: using logged batch expecting performance improvement
batch := session.NewBatch(gocql.LoggedBatch)
for _, item := range items {
    batch.Query("INSERT INTO events ...", item...)
}
session.ExecuteBatch(batch)
// WORSE than individual writes! Coordinator must synchronize all replicas.

// GOOD: use unlogged batch ONLY for same-partition writes
// For different partitions: concurrent individual writes are faster
var wg sync.WaitGroup
for _, item := range items {
    wg.Add(1)
    go func(i Item) {
        defer wg.Done()
        session.Query("INSERT INTO events ...", i...).Exec()
    }(item)
}
wg.Wait()
```

### 4. Ignoring Tombstones

Cassandra deletes do not remove data immediately. They write a tombstone marker that is read back on every query until `gc_grace_seconds` elapses and compaction runs. Overwriting a collection column creates implicit tombstones for the previous values, so partitions with heavy delete or list-overwrite activity accumulate tombstones that degrade read performance.

```go
// Deletes in Cassandra create tombstones (markers, not actual deletion)
// Tombstones accumulate until gc_grace_seconds (10 days) passes + compaction
// Problem: reading a partition with millions of tombstones is slow

// BAD: update-by-overwrite creates implicit tombstones
// UPDATE users SET tags = ['a', 'b'] -- old list elements become tombstones

// GOOD: use TTL instead of delete for time-expiring data
session.Query("INSERT INTO sessions ... USING TTL 3600", ...).Exec()

// GOOD: use incremental SET operations to avoid tombstones
session.Query("UPDATE users SET tags = tags + {'new_tag'} WHERE user_id = ?", id).Exec()
```

### 5. Using ALLOW FILTERING

`ALLOW FILTERING` tells Cassandra to scan the entire dataset and filter in the coordinator. It is functionally equivalent to a full table scan and will cause read timeouts at any meaningful scale. The correct approach is to create a dedicated table for the query pattern with the filter column as part of the partition key.

```go
// BAD: ALLOW FILTERING bypasses partition key → full cluster scan
// SELECT * FROM products WHERE category = 'electronics' ALLOW FILTERING
// Cassandra warns: "may cause timeouts" - this is an anti-pattern

// GOOD: create a table for the query pattern
// CREATE TABLE products_by_category (
//   category TEXT, product_id UUID, name TEXT, price_cents BIGINT,
//   PRIMARY KEY (category, product_id)
// )
```

### 6. Not Using Token-Aware Routing

Without token-aware routing, the `gocql` driver sends every query to a random node, which then forwards it to the owning replica, adding an unnecessary coordinator hop that roughly doubles query latency. `TokenAwareHostPolicy` wrapping `DCAwareRoundRobinPolicy` lets the driver compute the token ring position and route directly to the correct replica.

```go
// BAD: default round-robin routing sends queries to random nodes
// → coordinator must forward to correct node → extra hop + latency

cluster := gocql.NewCluster(hosts...)
// Missing: token-aware policy

// GOOD: token-aware routing sends directly to owning replica
cluster.PoolConfig.HostSelectionPolicy = gocql.TokenAwareHostPolicy(
    gocql.DCAwareRoundRobinPolicy(localDC),
)
// Reduces latency by ~50% by eliminating coordinator hop
```

### Junior → FAANG: The Six Mistakes as an On-Call Checklist

Every mistake in this section maps to a production page you will take in your first two years. Treat the section as a diagnostic checklist, not a morality tale. When an alert fires the question is always "which of the six am I looking at right now."

Worked example. A teammate writes `SELECT * FROM users WHERE email = ? ALLOW FILTERING` in a login path, ships it on a Friday, and by Monday p99 login is 4 seconds. Why did this fail? Because the table is partitioned by `user_id` and email is a non-key column, `ALLOW FILTERING` forces the coordinator to scatter-gather across every node, deserialize every partition header, and filter client-side. The fix is not to tune, it is to add `users_by_email (email PRIMARY KEY, user_id UUID)` and do a two-step read. That two-step read is faster than any single-query solution because Cassandra's cost model rewards narrow partition reads and punishes scans.

Reflex ladder for "why did this query fail?"
1. Does every `WHERE` clause include the full partition key? If not, stop, add a new table.
2. Is the partition bounded? Count the rows per partition with `nodetool tablehistograms`. Over 100k rows or 100MB means you need a bucket.
3. Is there a tombstone warning in `system.log`? Grep for `tombstone_warn_threshold` and `tombstone_failure_threshold`.
4. Is the batch logged across partitions? Logged batches across partitions are almost always the wrong choice.
5. Are reads using `LOCAL_QUORUM` and routed token-aware? Cross-DC `QUORUM` is a silent latency killer.
6. Is the client driver configured with the right host policy and retry policy?

Entry-point interview question. "Your read latency p99 jumped 10x after a deploy. Walk me through diagnosis." The winning answer references these six in order. Panel members will grade you on whether you jump to infrastructure (node count, disk) or to the query and schema layer first. Always the query first.

First-job context. The most common junior mistake not listed above is using `QUORUM` across multiple data centers. On a three-DC cluster with RF=3 per DC, `QUORUM` means 5 of 9 replicas, which crosses DC boundaries on every read. Use `LOCAL_QUORUM`. If an interviewer asks what `LOCAL_QUORUM` means, the answer is "majority within the coordinator's DC only." That single sentence is the difference between a hire and a no-hire at L4.

### Senior @ FAANG: Antipatterns as Governance, Tombstone Economics, and Repair Discipline

At staff level these are not mistakes, they are governance failures. The question is how you prevent them at the policy layer so juniors physically cannot ship them.

Schema lint as policy. Ship a CQL linter in CI that rejects any of the following patterns.

1. `ALLOW FILTERING` anywhere outside a tagged `analytics_only` table.
2. Primary keys with a single column that is not bounded by time or hash bucket, unless the table is tagged `small_reference`.
3. `LOGGED BATCH` spanning more than one partition key.
4. `CREATE INDEX` on a non-low-cardinality column. Native secondary indexes are almost always an antipattern. Use SAI (Storage-Attached Indexes) in Cassandra 5.0 or a dedicated search store.
5. `IF NOT EXISTS` on a table with expected QPS over 1000. LWT (Paxos round) cost is 4x a normal write and serializes per partition.
6. Consistency `QUORUM` on multi-DC topologies. Require `LOCAL_QUORUM` or an explicit override comment.

A single linter in CI deletes entire classes of pages. Teams at Netflix, Apple, and Instagram ship variants of this.

Tombstone economics. `gc_grace_seconds` defaults to 10 days for a reason: it is the maximum time a node can be down before its deletes are forgotten, which would resurrect deleted data via read repair. Set it lower only if you guarantee repair cadence. The cost model is: tombstone_scan_cost = tombstones_per_partition * read_QPS * deserialization_cost. When that product exceeds the memtable flush rate, reads stall. Governance rule: any table with a delete rate over 10% of its write rate needs a tombstone alert at 1000 tombstones per read and a runbook that triggers before `tombstone_failure_threshold` (default 100k) fires a query failure.

Repair discipline at scale. Repair is how you bound inconsistency. Three flavors to pick between.

Full repair. Compares every token range across replicas. Expensive, read-heavy, needed once per `gc_grace_seconds` minimum. At 160PB scale a full repair is a multi-week campaign.

Incremental repair. Tracks which SSTables are already repaired. Cheaper on subsequent runs. Has a known "anti-compaction" cost and a history of correctness bugs in pre-4.0 Cassandra. Safe in 5.0 with UCS.

Sub-range repair. Splits the token ring into small ranges and repairs them one at a time. Resumable, observable, the only sane option at scale. Apache Reaper and ScyllaDB Manager both implement this.

ADR for "Pick a repair orchestrator."

Context. Manual `nodetool repair` does not scale past a dozen nodes. You need scheduling, retries, parallelism limits, and coordination with compaction.

Options. Reaper (open source, JVM, Cassandra-native) versus ScyllaDB Manager (ScyllaDB-native, Go, can also drive Cassandra) versus custom cron.

Decision. If fleet is Cassandra-only, Reaper. If mixed or moving toward ScyllaDB, Manager. Custom cron is a technical debt.

Consequences. Either orchestrator owns a schedule that must not collide with peak traffic or with major compactions. Budget repair as 15 to 25% of cluster capacity during its window.

Maturity model for antipattern governance.

L1 Tribal. Seniors catch bad schemas in review, juniors repeat the same mistakes.
L2 Documented. Antipatterns are written down in a wiki.
L3 Linted. CI rejects the top antipatterns at PR time.
L4 Measured. Dashboards per table track tombstone rate, partition size distribution, LWT QPS, ALLOW FILTERING count (should be zero).
L5 Adaptive. Platform team proposes schema migrations automatically when a table crosses a governance threshold, reviewed by the owning service team.

---
