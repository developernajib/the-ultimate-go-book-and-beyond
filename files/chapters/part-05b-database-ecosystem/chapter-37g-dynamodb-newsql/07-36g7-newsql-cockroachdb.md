## 37G.7 NewSQL: CockroachDB

### Distributed SQL with Geo-Partitioning

CockroachDB provides distributed SQL with serializable isolation as the default (the strongest ANSI level, stronger than the snapshot-isolation default most RDBMS ship with), and automatic range-based sharding across 512 MiB ranges. The PostgreSQL-compatible wire protocol means the standard `pgx` driver (preferred over the legacy `lib/pq`) connects without modification. Geo-partitioning pins table ranges to specific datacenter localities, reducing cross-region latency for compliance and performance requirements. CockroachDB v25.2 (LTS, the current 2026 release train) adds faster schema changes, improved vectorized execution, row-level TTL enhancements, and PL/pgSQL support for closer Postgres parity.

> **Senior track**: The retry loop is not optional. CockroachDB's serializable isolation surfaces contention as `40001` serialization-failure errors that the application must retry with exponential backoff. Wrap every write transaction in the helper below, and never silently swallow retry errors. If retries never succeed, the root cause is almost always a hotspot (a counter row, a sequence-emulation table, or a shared "last updated" row), not CockroachDB.

```go
package newsql

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib" // CockroachDB speaks the PostgreSQL wire protocol
)

// CockroachDB is PostgreSQL-compatible with distributed ACID transactions
// Connection string: postgres://user:pass@host:26257/db?sslmode=require

// Config for CockroachDB
type CockroachConfig struct {
	DSN            string
	MaxOpenConns   int
	MaxIdleConns   int
	ConnMaxLifetime time.Duration
}

// NewCockroachDB creates a CockroachDB connection pool
func NewCockroachDB(cfg CockroachConfig) (*sql.DB, error) {
	db, err := sql.Open("pgx", cfg.DSN)
	if err != nil {
		return nil, fmt.Errorf("cockroachdb open: %w", err)
	}

	db.SetMaxOpenConns(cfg.MaxOpenConns)
	db.SetMaxIdleConns(cfg.MaxIdleConns)
	db.SetConnMaxLifetime(cfg.ConnMaxLifetime)

	return db, nil
}

// CockroachDB-specific features

// Retry transaction: CockroachDB recommends retry logic for serializable transactions
func ExecuteWithRetry(ctx context.Context, db *sql.DB, fn func(*sql.Tx) error) error {
	const maxRetries = 5

	for attempt := 0; attempt < maxRetries; attempt++ {
		tx, err := db.BeginTx(ctx, &sql.TxOptions{
			Isolation: sql.LevelSerializable,
		})
		if err != nil {
			return fmt.Errorf("begin tx: %w", err)
		}

		if err := fn(tx); err != nil {
			_ = tx.Rollback()
			// Check if retryable error (40001 = serialization failure)
			if isRetryableError(err) && attempt < maxRetries-1 {
				time.Sleep(time.Duration(1<<attempt) * 10 * time.Millisecond)
				continue
			}
			return err
		}

		if err := tx.Commit(); err != nil {
			if isRetryableError(err) && attempt < maxRetries-1 {
				time.Sleep(time.Duration(1<<attempt) * 10 * time.Millisecond)
				continue
			}
			return fmt.Errorf("commit: %w", err)
		}
		return nil
	}
	return fmt.Errorf("max retries exceeded")
}

func isRetryableError(err error) bool {
	// PostgreSQL serialization failure error code
	return strings.Contains(err.Error(), "40001") ||
		strings.Contains(err.Error(), "restart transaction")
}

// Multi-region schema setup
const CockroachMultiRegionSchema = `
-- Survive zone failure (default, 3 copies in same region)
ALTER TABLE users CONFIGURE ZONE USING num_replicas = 3;

-- Survive region failure (5 copies across 3 regions)
ALTER DATABASE mydb SURVIVE REGION FAILURE;

-- Pin user data to their home region (CRDB global tables)
ALTER TABLE user_sessions SET LOCALITY GLOBAL;
-- Global tables: readable from any region at ~1ms latency (but higher write latency)

-- Regional-by-row: each row pinned to a region based on column
ALTER TABLE orders ADD COLUMN region CRDB_INTERNAL_REGION NOT VISIBLE
    AS (CASE
        WHEN shipping_country IN ('US', 'CA', 'MX') THEN 'us-east1'
        WHEN shipping_country IN ('GB', 'DE', 'FR') THEN 'europe-west1'
        ELSE 'asia-southeast1'
    END) STORED;
ALTER TABLE orders SET LOCALITY REGIONAL BY ROW AS region;
-- Rows served locally in their region → low latency + data residency compliance
`

// Multi-Region Order Service
type CockroachOrderService struct {
	db  *sql.DB
	log *slog.Logger
}

// TransferFunds atomic cross-shard transfer
func (s *CockroachOrderService) TransferFunds(ctx context.Context, fromID, toID string, amountCents int64) error {
	return ExecuteWithRetry(ctx, s.db, func(tx *sql.Tx) error {
		// SELECT FOR UPDATE locks rows
		var fromBalanceCents int64

		row := tx.QueryRowContext(ctx,
			`SELECT balance_cents FROM accounts WHERE id = $1 FOR UPDATE`, fromID)
		if err := row.Scan(&fromBalanceCents); err != nil {
			return err
		}
		if fromBalanceCents < amountCents {
			return fmt.Errorf("insufficient balance: have %d cents, need %d cents", fromBalanceCents, amountCents)
		}

		_, err := tx.ExecContext(ctx,
			`UPDATE accounts SET balance_cents = balance_cents - $1, updated_at = now() WHERE id = $2`,
			amountCents, fromID)
		if err != nil {
			return err
		}

		_, err = tx.ExecContext(ctx,
			`UPDATE accounts SET balance_cents = balance_cents + $1, updated_at = now() WHERE id = $2`,
			amountCents, toID)
		return err
	})
}
```

### Junior to FAANG: CockroachDB Entry Point

If your mental model of CockroachDB is "Postgres that scales," you are about 70 percent right and 30 percent wrong, and the 30 percent is where junior engineers lose days of debugging time. Start here. CockroachDB speaks the Postgres wire protocol, so `pgx` connects and most SQL runs unchanged. Underneath, every row lives in a range (a contiguous key span, default 512 MiB), every range is replicated by Raft to an odd number of replicas (3 or 5 typically), and every transaction is serializable by default. That last fact is the biggest behavioral difference from Postgres, which defaults to read committed.

Serializable isolation is stronger than snapshot isolation. It prevents write skew, phantom reads, and every other classic anomaly. The cost is that the database will sometimes refuse to commit a transaction and return SQLSTATE `40001` ("serialization_failure"), telling you to retry. The retry is your responsibility, not the driver's. The `ExecuteWithRetry` helper above is the canonical pattern, and in a first-job setting you should assume every write transaction must go through it. If you forget, a load test will surface the bug within minutes as random "could not serialize access" errors that no junior debugger will recognize.

The second thing to internalize is ranges and splits. CockroachDB automatically splits a range when it crosses the size threshold, and rebalances replicas across nodes to spread load. This is usually great. It becomes a problem when your primary key is sequential (an auto-increment ID or a timestamp) because all new writes hit the same range, which is the same three nodes, and you cannot scale past the write capacity of that one range. The fix is `UUID` primary keys or a hash-sharded index, and both are one-line SQL changes. Any CockroachDB schema review that shows `SERIAL` or `BIGSERIAL` without explanation should be flagged.

The third thing to internalize is the port number. CockroachDB defaults to 26257, not 5432. This trips up every junior engineer who tries to point psql at the wrong port on their first day.

For interview framing, "design a globally distributed user service" is the canonical CockroachDB prompt. The entry-level answer covers (a) `REGIONAL BY ROW` for data residency, (b) `SURVIVE REGION FAILURE` for availability, (c) retry loops on the client, and (d) follower reads (`AS OF SYSTEM TIME '-5s'`) for read-heavy paths that can tolerate five seconds of staleness. A candidate who mentions all four without prompting is in the senior band.

Worked example, walking through `TransferFunds` above. The `SELECT ... FOR UPDATE` takes a pessimistic lock on the source row. In Postgres, this is strictly necessary for correctness under read committed. In CockroachDB under serializable, it is not strictly necessary (the optimistic concurrency would catch the conflict), but it converts a retry on commit into a block on the lock, which for hot rows is often faster overall. The `ExecuteWithRetry` wrapper handles the rare case when the lock escalation still races. The `updated_at = now()` is idempotent across retries because `now()` within a transaction returns the transaction's logical timestamp, not wall-clock, so the same retry produces the same value. Small details like this are what separate a working demo from production code.

### Senior at FAANG: Distributed SQL Architecture, Survival Goals, and Vendor Comparison

At staff level, the CockroachDB conversation is a three-way trade-off between consistency, latency, and cost, evaluated against Spanner, YugabyteDB, TiDB, and Aurora DSQL. A senior design doc on database selection should explicitly model all five and pick one with reasons. Here is the decision frame.

CockroachDB uses Raft per range, with ranges independently replicated, which means writes pay the latency of the slowest majority of replicas for that range. In a 3-region deployment with `SURVIVE REGION FAILURE`, every write must reach a quorum across at least 2 regions, giving you cross-region RTT on the commit path (typically 60 to 100 ms US-to-EU). This is not a CockroachDB problem. It is a CAP theorem problem, and every distributed SQL system that promises region survival pays this cost. If your workload cannot tolerate 100 ms commit latency, you need a different survival goal or a different topology. `SURVIVE ZONE FAILURE` (the default) keeps replicas within one region and drops commit latency to single-digit milliseconds, at the cost of losing the region taking the database with it.

Global tables versus regional-by-row is the architecture-level decision that most affects performance. Global tables are readable locally in every region at roughly 1 ms, but writes must reach a quorum across regions and pay the full cross-region cost. Use them for reference data that is read everywhere and written rarely (product catalog, feature flags, tax tables). Regional-by-row pins each row to its home region, giving local read and write latency for home-region traffic, and cross-region reads as a slower fallback. Use it for user-scoped data with a natural region affinity (user profiles, orders, sessions) and for data residency compliance (GDPR requires EU user data stays in EU). Getting this wrong by making user profiles global is the most common CockroachDB performance mistake at the staff level.

Follower reads are the underused feature that most often fixes CockroachDB latency complaints. `AS OF SYSTEM TIME follower_read_timestamp()` gives you a read from the nearest replica at roughly 4.8 seconds of staleness, with no cross-region coordination. For any read path that can tolerate a few seconds of lag (dashboard queries, reporting, product listings), this is the right default and it cuts p99 latency by an order of magnitude in multi-region deployments. The discipline is to route these reads through a separate connection pool with the stale-read hint baked into the SQL, so the staleness is explicit in code review, not buried in a session variable.

Hotspot mitigation deserves a staff-level toolkit. The symptoms are (a) one node pegged at high CPU while others idle, (b) write latency spikes that correlate with a specific primary key pattern, and (c) persistent `40001` errors despite retry loops. The tools are (1) hash-sharded indexes for sequential keys (`CREATE INDEX ... USING HASH WITH BUCKET_COUNT = 8`), (2) `UUID` primary keys with `gen_random_uuid()`, (3) manual range splits at expected hot spots (`ALTER TABLE ... SPLIT AT VALUES (...)`), and (4) breaking up "god rows" that aggregate counters into per-user or per-shard rows with periodic rollup. A principal engineer should be able to diagnose a hotspot from the CockroachDB admin UI's hot ranges view within minutes, and prescribe the fix with confidence.

Comparison table at staff level:

- Spanner. External consistency via TrueTime atomic clocks. Writes pay one RTT to the Paxos leader plus clock uncertainty padding (typically 7 ms). Google-native, AWS and Azure not supported, PGAdapter for Postgres dialect compatibility. Best when you need cross-region ACID and you are on GCP.
- CockroachDB. Raft per range, serializable default, Postgres compatible. Self-hosted or CockroachDB Cloud on AWS, GCP, Azure. Best when you want Spanner-like semantics without GCP lock-in and you can absorb higher commit latency than Spanner for equivalent topologies.
- YugabyteDB. Raft per shard, two SQL APIs (YSQL Postgres-compatible and YCQL Cassandra-compatible). Stronger in read-heavy workloads due to tablet-level consistency, weaker developer ergonomics around schema changes. Best for workloads with mixed SQL plus Cassandra-style access patterns.
- TiDB. Raft with separate storage (TiKV) and compute layers, MySQL wire protocol compatible. Strong HTAP story via TiFlash columnar replicas. Best when your existing stack is MySQL and you need analytics on the same data without a separate warehouse.
- Aurora DSQL. AWS-native serverless distributed SQL announced at re:Invent 2024, Postgres compatible, optimistic concurrency control, no connection pooling needed. Best when you are already on AWS and want a managed service with no nodes to operate. Preview-grade maturity as of 2026, so production workloads should wait for a second year of GA.

Cost modeling. CockroachDB Cloud Dedicated at 3 nodes of 4 vCPU with 16 GB RAM across three regions runs roughly $3.5K per month in 2026 pricing, before data transfer. A comparable Spanner deployment at 1000 PUs across three regions runs roughly $10K per month. Self-hosted CockroachDB on EKS at the same capacity is roughly $1.5K per month in EC2 plus the engineering cost of running it, which for a team under 20 engineers is usually higher than the managed service savings. Staff engineers should push back on any "we will run it ourselves" claim unless there is a dedicated platform team with distributed SQL experience on staff.

Observability. CockroachDB exposes Prometheus metrics at every node's `/_status/vars` endpoint. The metrics that matter most are `sql_txn_restarts` (contention), `range_splits` and `range_merges` (rebalancing activity), `replica_reads_from_follower` (follower read effectiveness), and `sql_exec_latency` per statement fingerprint. Any production CockroachDB deployment should have these in Grafana with alerts, a `rangefeed`-based CDC to the data warehouse for business KPIs, and regular `SHOW RANGES FROM TABLE` audits to catch accidentally-global data.

Schema change discipline. CockroachDB schema changes are online and concurrent, which is a huge operational win over Postgres. The trap is that adding a column with a default value rewrites the table, and for a 10 TB table that takes hours of background work during which foreground latency degrades. The staff-level pattern is to add the column without a default, backfill in batches with a separate job that respects a rate limit, then add the default. The v25.2 release improves this further with parallel backfills, but the discipline of staged schema changes is still the right default.

Final staff-level framing. CockroachDB is the right answer when you need Postgres compatibility, global distribution, and you control the deployment target. It is the wrong answer when you need sub-millisecond single-region latency (use Postgres or Aurora), when you need complex analytics on the same data (use TiDB or a separate warehouse), or when your team has no distributed systems experience and your workload fits in one region (use Aurora). Articulate the boundary and the decision becomes easy.

---

