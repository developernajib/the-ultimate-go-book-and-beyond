## 37B.11 Replication Deep Dive

### Streaming Replication: WAL-Based

PostgreSQL streaming replication sends WAL data from primary to standby in near real-time:

```sql
-- On primary: create replication user
CREATE USER replicator REPLICATION LOGIN ENCRYPTED PASSWORD 'strong_password';

-- In pg_hba.conf on primary:
-- host replication replicator standby_ip/32 scram-sha-256

-- In postgresql.conf on primary:
-- wal_level = replica
-- max_wal_senders = 5
-- wal_keep_size = 1GB  (keep WAL for lagging standbys)

-- On standby: create standby.signal and configure
-- standby.signal file: (empty, just needs to exist)
-- In postgresql.conf on standby:
-- primary_conninfo = 'host=primary port=5432 user=replicator password=...'
-- primary_slot_name = 'standby1'  (optional: use replication slot)

-- Monitor replication on primary:
SELECT
    client_addr,
    state,
    sent_lsn,
    write_lsn,
    flush_lsn,
    replay_lsn,
    pg_wal_lsn_diff(sent_lsn, replay_lsn) AS replication_lag_bytes,
    write_lag,
    flush_lag,
    replay_lag
FROM pg_stat_replication;
```

### Logical Replication

Unlike streaming replication, which sends raw WAL bytes, logical replication decodes WAL records into row-level change events (INSERT, UPDATE, DELETE). This means the subscriber does not need to be the same PostgreSQL major version, and you can replicate individual tables rather than the entire database.

```sql
-- Primary: create publication
CREATE PUBLICATION orders_pub FOR TABLE orders, order_items;

-- Subscriber: create subscription
CREATE SUBSCRIPTION orders_sub
    CONNECTION 'host=primary port=5432 user=replicator dbname=mydb'
    PUBLICATION orders_pub;

-- Monitor logical replication lag
SELECT
    subname,
    pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes
FROM pg_replication_slots
WHERE slot_type = 'logical';
```

**Logical replication use cases**:
- Zero-downtime PostgreSQL major version upgrades
- Selective table replication (not entire database)
- Change data capture (CDC) to Kafka via `wal2json` or `pgoutput`
- Aggregating data from multiple shards into one database

> **Senior track**: PostgreSQL supports three sync modes via `synchronous_commit` and `synchronous_standby_names`: asynchronous (primary returns on local flush, fastest, can lose committed data on primary failure), synchronous (`remote_write` or `remote_apply`, durable but latency equals the slowest standby), and quorum synchronous (`ANY n (s1, s2, s3)`, durable as long as any `n` of the listed standbys ack). For multi-region deployments, `remote_apply` with a local-region standby plus async cross-region replicas is the usual balance: zero data loss within region, low latency, async DR for the far-region standby.

### Replication Lag: Causes and Mitigation

Replication lag is the delay between a change being committed on the primary and being applied on the standby. Even small amounts of lag can cause stale reads in applications that route queries to replicas. The main sources of lag fall into four categories: network bandwidth, standby disk I/O, conflicts with standby queries, and replication slot retention.

```
Replication lag sources:

1. Network: primary sends WAL faster than network allows
   Fix: increase network bandwidth, use compression

2. Standby I/O: standby disk cannot keep up with WAL replay
   Fix: use faster storage on standby

3. Long queries on standby: read queries block WAL apply
   Fix: set hot_standby_feedback = on (prevents vacuum on primary
        from removing rows that standby queries need)
   Fix: set max_standby_streaming_delay to a bounded value like 30s
        (cancel standby queries that still conflict after the delay,
        instead of letting WAL apply wait indefinitely)

4. Replication slot: primary retains WAL for a lagging subscriber
   Risk: if subscriber dies, WAL accumulates and fills disk
   Fix: set max_slot_wal_keep_size to limit WAL retention
```

```sql
-- Check replication slot lag (dangerous if large)
SELECT
    slot_name,
    slot_type,
    active,
    pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS lag
FROM pg_replication_slots;

-- Drop a stale slot that is accumulating WAL
SELECT pg_drop_replication_slot('old_standby_slot');
```

### Go Patterns for Read Replicas

A read/write split routes INSERT, UPDATE, and DELETE operations to the primary and SELECT queries to replicas. The `ReadWriteSplit` struct below maintains separate connection pools for primary and replicas, using round-robin to distribute read load. The `ReadAfterWrite` method forces a read to the primary when the application needs to read its own writes immediately after a mutation.

```go
package replica

import (
    "context"
    "fmt"
    "sync/atomic"

    "github.com/jackc/pgx/v5/pgxpool"
)

// ReadWriteSplit routes write queries to primary and read queries to replicas.
type ReadWriteSplit struct {
    primary  *pgxpool.Pool
    replicas []*pgxpool.Pool
    counter  atomic.Uint64 // round-robin counter
}

func NewReadWriteSplit(primaryDSN string, replicaDSNs []string) (*ReadWriteSplit, error) {
    rws := &ReadWriteSplit{}

    ctx := context.Background()

    primary, err := pgxpool.New(ctx, primaryDSN)
    if err != nil {
        return nil, fmt.Errorf("primary pool: %w", err)
    }
    rws.primary = primary

    for i, dsn := range replicaDSNs {
        replica, err := pgxpool.New(ctx, dsn)
        if err != nil {
            primary.Close()
            return nil, fmt.Errorf("replica %d pool: %w", i, err)
        }
        rws.replicas = append(rws.replicas, replica)
    }

    return rws, nil
}

// Primary returns the primary pool for writes and strong-consistency reads.
func (rws *ReadWriteSplit) Primary() *pgxpool.Pool {
    return rws.primary
}

// Replica returns a replica pool using round-robin for load distribution.
// Falls back to primary if no replicas are configured.
func (rws *ReadWriteSplit) Replica() *pgxpool.Pool {
    if len(rws.replicas) == 0 {
        return rws.primary
    }
    idx := rws.counter.Add(1) % uint64(len(rws.replicas))
    return rws.replicas[idx]
}

// ReadAfterWrite forces a read to go to primary when strong consistency is needed
// (e.g., immediately after a write that the user will read back).
func (rws *ReadWriteSplit) ReadAfterWrite(ctx context.Context, fn func(*pgxpool.Pool) error) error {
    return fn(rws.primary)
}

func (rws *ReadWriteSplit) Close() {
    rws.primary.Close()
    for _, r := range rws.replicas {
        r.Close()
    }
}
```

### Junior to FAANG: replication as a first-job concept

The prerequisite gap most juniors hit is confusing the three layers of "copy". Backups are point-in-time snapshots. Physical replication streams raw 8KB block changes via WAL. Logical replication decodes those WAL records into row events. A junior who treats `pg_dump | psql` as a replication strategy is a junior who will lose data when the restore takes 6 hours on a 2TB database.

Worked example. You join a team and see replication lag spike from 200ms to 45 seconds every day at 02:00 UTC. The first-job reflex is to blame the network. The correct reflex is: "what starts at 02:00?" `SELECT * FROM pg_stat_activity WHERE backend_start < now() - interval '5 min' ORDER BY backend_start` on the standby reveals a nightly analytics job with a 40-minute query. `hot_standby_feedback = on` is pinning the primary's vacuum horizon. Every modification of hot rows piles up as replay conflicts. The fix is either `max_standby_streaming_delay = 30s` (cancel the analytics query) or move analytics to a dedicated replica with `hot_standby_feedback = on` and let the OLTP replica stay fast.

"Why did this fail?" checklist for a first-year on-call. When a replica falls behind: check `pg_stat_replication.replay_lag` on the primary. If `sent_lsn - replay_lsn` is growing, the standby cannot apply fast enough (I/O bound). If `sent_lsn = write_lsn = flush_lsn = replay_lsn` but the client sees stale reads, the issue is not replication lag but read-your-writes consistency, and the fix is routing, not replication tuning. If `pg_replication_slots.active = false` and `confirmed_flush_lsn` is ancient, a subscriber died weeks ago and the primary is about to run out of disk. This last one is the GitLab 2017 failure mode in miniature.

Interview entry-point questions you will actually get at L3/L4. "What is the difference between `synchronous_commit = on` and `synchronous_commit = remote_apply`?" Answer: `on` waits for the primary's local WAL flush, `remote_apply` waits until the standby has replayed the record so a read on the standby sees the committed row. "Can a logical replica be a different major version?" Yes, that is the point, and it is how zero-downtime major version upgrades work. "What does `max_wal_senders` do and why does it matter?" It caps concurrent replication connections, and running out means new standbys cannot attach.

### Senior at FAANG: replication as a platform concern

Staff and principal engineers own the ADR that decides between physical streaming, logical decoding, and consensus-replicated storage. The decision framework has four axes: RPO (can you lose committed data?), RTO (how long to promote?), geographic topology (single-region, multi-region, global), and heterogeneity (same engine everywhere, or cross-engine CDC?).

ADR template for the replication layer.

```
Title: Replication topology for the OrderService primary

Context:
  - 12TB Postgres 18 primary, 80K TPS peak, two regions (us-east, eu-west).
  - Compliance: RPO <= 5s for us-east, RPO <= 60s cross-region acceptable.
  - Analytics team needs CDC into Snowflake with <= 2 min freshness.

Decision:
  - us-east: two sync standbys with `ANY 1 (s1, s2)` quorum on `remote_apply`.
    One standby is in the same AZ (low-latency ack), one in a different AZ
    (AZ-failure durability). Either can ack, so single-AZ latency is preserved
    during cross-AZ partitions.
  - eu-west: async cascading standby off s2 for DR and EU read traffic.
  - CDC: logical replication slot with `pgoutput` plugin consumed by a
    Debezium connector writing to Kafka. Snowpipe consumes Kafka into Snowflake.
  - Failover: Patroni with DCS on etcd, pg_failover_slots extension so logical
    slots survive promotion.

Consequences:
  - Writes commit after one local-region AZ ack. p99 commit latency 4-6ms.
  - Losing both us-east standbys blocks writes (chose durability over availability).
  - Cross-region DR has up to 60s of data loss window during primary outage.
  - CDC pipeline has its own lag budget, tracked separately from HA replication.
```

Maturity model for internals literacy (L1 to L5 on replication).

```
L1 Reactive:     team uses managed RDS replicas, no one reads pg_stat_replication.
                 Lag spikes surface as user complaints. No runbook.
L2 Instrumented: dashboards show sent/write/flush/replay LSN deltas.
                 Alerts on replay_lag > 30s. Runbook exists but is stale.
L3 Diagnostic:   on-call can read auto_explain output, correlate
                 pg_wait_sampling with replay stalls, and identify
                 hot_standby_feedback vacuum pinning without help.
L4 Architected:  replication topology is an ADR, slot retention is capped,
                 pg_failover_slots preserves logical slots across failover,
                 CDC has its own SLO separate from HA SLO.
L5 Platform:     internal replication-as-a-service with self-serve replica
                 provisioning, automated lag-based ejection from the read pool,
                 chaos tests that kill standbys in prod, and a published
                 data-freshness contract per table family.
```

Staff-level review checklist when a team proposes a replication change. (1) What is the slot retention policy? Unbounded `max_slot_wal_keep_size` is a disk-fill incident waiting. (2) Does failover preserve logical slots? Without `pg_failover_slots` or equivalent, promotion silently breaks CDC and analytics goes stale for days before anyone notices. (3) What is the quorum shape under partition? `FIRST 2 (s1, s2, s3)` and `ANY 2 (s1, s2, s3)` behave very differently when s1 is the slow one. (4) Is `hot_standby_feedback` on a reporting replica also on the OLTP replica? If yes, the reporting team's 40-minute query is bloating the primary's hot tables. (5) Where are GTIDs/LSNs checkpointed on the consumer side for CDC? Lose that checkpoint and you replay or skip. (6) What is the plan for XID wraparound? Long-running slots or long-running standby queries can block vacuum and approach the 2-billion XID ceiling, at which point the database stops accepting writes.

Consensus-replicated storage is the other side of the ADR. Spanner uses Paxos groups per tablet, CockroachDB and YugabyteDB use Raft per range, and systems like Delos use chain replication with a pluggable shared log. The tradeoff is: quorum writes across 3-5 replicas give you automatic failover with zero data loss and no split-brain, but every commit pays the latency of the median replica, not the fastest. For a global workload with 50ms inter-region RTT, a Raft write across three regions is 50-75ms minimum, compared to 5ms local sync replication plus async cross-region. Senior engineers do not pick consensus-replicated storage because it is modern. They pick it when the cost of split-brain plus the cost of running a human-in-the-loop failover process exceeds the latency tax.

Observability stack for replication at scale. `pg_stat_replication` for LSN deltas, `pg_stat_subscription` for logical subscribers, `pg_replication_slots` for retention risk, `pg_stat_wal_receiver` on the standby side, `auto_explain.log_min_duration = 1s` with `log_analyze = on` for slow replay queries, `pg_wait_sampling` for wait-event histograms, and Datadog Database Monitoring or pganalyze for cross-host correlation. Export LSN-byte-diff and replay-lag-seconds as Prometheus gauges, alert on both, and page only when both breach (seconds alone misclassifies idle primaries as lagging).

---
