## 37G.8 NewSQL: Google Spanner with Go

### Globally Distributed SQL

Google Spanner achieves external consistency (strict serializability) across global regions using TrueTime, a combination of GPS and atomic clocks that bounds clock uncertainty to a small epsilon (typically under 7ms) and enables commit timestamps that are universally ordered. The Go client (`cloud.google.com/go/spanner`) exposes a session pool for read-only transactions and `ReadWriteTransaction` with automatic retry for read-write transactions that abort due to concurrency conflicts. Spanner's 2023 capacity upgrade delivered roughly 50% higher throughput per node and 2.5x storage per node, and the PostgreSQL interface has continued to mature (Spanner's Postgres dialect now covers enough surface to run many off-the-shelf Django and Rails apps). For teams that want the standard `database/sql` interface instead of the native client, the community driver `github.com/googleapis/go-sql-spanner` wraps the same RPC layer.

> **Senior track**: The single biggest performance mistake on Spanner is using strong reads where bounded-staleness reads would do. Strong reads wait for the commit-wait interval (bounded by TrueTime uncertainty) and pay a cross-region round trip. Bounded-staleness reads with a 10-second window serve from the nearest replica and cost a fraction of the latency, which is almost always acceptable for dashboards, analytics, and list views. Strong reads should be reserved for read-your-writes paths such as "show order confirmation immediately after placing it".

```go
package newsql

import (
	"context"
	"fmt"
	"time"

	"cloud.google.com/go/spanner"
	"google.golang.org/api/iterator"
)

// Google Cloud Spanner: globally distributed SQL
// Unique feature: TrueTime API provides external consistency
// across globally distributed nodes

// Config for Spanner
type SpannerConfig struct {
	ProjectID  string
	InstanceID string
	DatabaseID string
}

// NewSpannerClient creates a Spanner client
func NewSpannerClient(ctx context.Context, cfg SpannerConfig) (*spanner.Client, error) {
	dbPath := fmt.Sprintf("projects/%s/instances/%s/databases/%s",
		cfg.ProjectID, cfg.InstanceID, cfg.DatabaseID)

	client, err := spanner.NewClient(ctx, dbPath)
	if err != nil {
		return nil, fmt.Errorf("spanner client: %w", err)
	}
	return client, nil
}

// SpannerOrderService implements order operations on Spanner
type SpannerOrderService struct {
	client *spanner.Client
}

// Order domain model for Spanner
type Order struct {
	ID         string
	UserID     string
	Status     string
	TotalCents int64
	CreatedAt  time.Time
}

// Interleaved tables: Spanner's performance optimization
// Child rows stored adjacent to parent rows
const SpannerSchema = `
CREATE TABLE Users (
  UserID     STRING(36)  NOT NULL,
  Email      STRING(255) NOT NULL,
  Name       STRING(255) NOT NULL,
  CreatedAt  TIMESTAMP   NOT NULL OPTIONS (allow_commit_timestamp=true),
) PRIMARY KEY (UserID);

-- Interleaved child table: Orders stored adjacent to their User
CREATE TABLE Orders (
  UserID     STRING(36)  NOT NULL,
  OrderID    STRING(36)  NOT NULL,
  Status     STRING(50)  NOT NULL,
  TotalCents INT64       NOT NULL,
  CreatedAt  TIMESTAMP   NOT NULL,
) PRIMARY KEY (UserID, OrderID),
  INTERLEAVE IN PARENT Users ON DELETE CASCADE;

-- Global secondary index
CREATE INDEX OrdersByStatus ON Orders(Status, CreatedAt DESC);
`

// CreateOrder uses Spanner's read-write transaction
func (s *SpannerOrderService) CreateOrder(ctx context.Context, order Order) error {
	_, err := s.client.ReadWriteTransaction(ctx, func(ctx context.Context, txn *spanner.ReadWriteTransaction) error {
		// Check account balance
		row, err := txn.ReadRow(ctx, "Accounts",
			spanner.Key{order.UserID},
			[]string{"BalanceCents"},
		)
		if err != nil {
			return fmt.Errorf("read account: %w", err)
		}

		var balanceCents int64
		if err := row.Columns(&balanceCents); err != nil {
			return err
		}
		if balanceCents < order.TotalCents {
			return fmt.Errorf("insufficient balance")
		}

		// Debit account
		txn.BufferWrite([]*spanner.Mutation{
			spanner.Update("Accounts",
				[]string{"UserID", "BalanceCents"},
				[]any{order.UserID, balanceCents - order.TotalCents},
			),
		})

		// Create order
		txn.BufferWrite([]*spanner.Mutation{
			spanner.Insert("Orders",
				[]string{"UserID", "OrderID", "Status", "TotalCents", "CreatedAt"},
				[]any{
					order.UserID, order.ID, "pending",
					order.TotalCents,
					spanner.CommitTimestamp, // TrueTime commit timestamp
				},
			),
		})

		return nil
	})
	return err
}

// ReadOrders queries orders with SQL
func (s *SpannerOrderService) ReadOrders(ctx context.Context, userID string, limit int64) ([]Order, error) {
	stmt := spanner.Statement{
		SQL: `SELECT o.OrderID, o.Status, o.TotalCents, o.CreatedAt
              FROM Orders o
              WHERE o.UserID = @userID
              ORDER BY o.CreatedAt DESC
              LIMIT @limit`,
		Params: map[string]any{
			"userID": userID,
			"limit":  limit,
		},
	}

	iter := s.client.Single().Query(ctx, stmt)
	defer iter.Stop()

	var orders []Order
	for {
		row, err := iter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("query orders: %w", err)
		}

		var o Order
		if err := row.Columns(&o.ID, &o.Status, &o.TotalCents, &o.CreatedAt); err != nil {
			return nil, err
		}
		o.UserID = userID
		orders = append(orders, o)
	}
	return orders, nil
}

// Spanner stale reads: efficient for analytics (no locking)
func (s *SpannerOrderService) GetOrderCount(ctx context.Context, status string) (int64, error) {
	// Stale read: reads data up to 15 seconds old - cheaper, no blocking
	stmt := spanner.Statement{
		SQL: `SELECT COUNT(*) FROM Orders WHERE Status = @status`,
		Params: map[string]any{"status": status},
	}

	// Bounded staleness: read as of 10 seconds ago
	iter := s.client.Single().
		WithTimestampBound(spanner.MaxStaleness(10*time.Second)).
		Query(ctx, stmt)
	defer iter.Stop()

	row, err := iter.Next()
	if err != nil {
		return 0, err
	}
	var count int64
	return count, row.Columns(&count)
}
```

### Junior to FAANG: Spanner Entry Point

Spanner is the database that most junior engineers have read about and fewest have actually used. That gap is worth closing because the interview expectation at Google and its peers is that you can describe the TrueTime model coherently in two minutes, and most candidates cannot.

The core idea. Classical distributed databases cannot give you both global availability and global linearizability, because they cannot agree on what "now" means across continents with sub-millisecond precision. Spanner cheats by putting GPS receivers and atomic clocks in every datacenter, and exposing a `TT.now()` API that returns an interval `[earliest, latest]` bounding the true current time. The interval width (epsilon) is typically under 7 ms. Every write commits at a timestamp that is guaranteed to be after every previously committed write anywhere in the system, by waiting out the epsilon before returning. This is called commit-wait, and it is why Spanner writes have a latency floor of roughly 7 ms even in the best case.

What this means for your Go code. The client library handles commit-wait automatically. You do not call any TrueTime API yourself. What you do is choose between `Single()` (single-use read-only transaction), `ReadOnlyTransaction()` (multi-statement read-only), and `ReadWriteTransaction()` (read-write with automatic retry). The retry loop is built into the client, so unlike CockroachDB, you do not write your own. The trade-off is that any side effect inside the transaction function (log lines, metrics, external calls) will execute multiple times on retry, so keep the function pure.

Interleaved tables are the Spanner-specific optimization that most shapes your schema design. Declaring `Orders` as interleaved in `Users` physically co-locates every user's orders next to the user row on disk. A query like "get user plus their 10 most recent orders" becomes a single range scan instead of a join. The cost is that you cannot reparent (you cannot move an order to a different user), and the child row is deleted when the parent is deleted via `ON DELETE CASCADE`. Use interleaving for strongly-owned child data (user's orders, order's line items), not for cross-cutting relationships.

Mutations versus DML. Spanner has two write APIs. `Mutation` (shown as `spanner.Insert`, `spanner.Update`) is the low-level bulk-efficient write. DML (`INSERT INTO ... VALUES`) is the SQL-standard write that runs through the query optimizer and supports `INSERT ... SELECT`, `UPDATE ... WHERE`, and other set-based operations. Mutations are faster for point writes and are the default in the Go client. DML is needed when you need SQL expressivity. A junior engineer should default to mutations and reach for DML only when the query shape demands it.

The Postgres dialect versus Google SQL dialect is the choice you make once per database. Google SQL is the native dialect and gets new features first. Postgres dialect is the compatibility layer for lift-and-shift workloads and for teams that want `pgx` to work. As of 2026, Postgres dialect covers most of what applications need and is recommended for greenfield work where the team is Postgres-fluent, while Google SQL remains the choice for teams that want the newest features (JSON path improvements, vector search, etc) on day one.

Worked example at entry level, using the `CreateOrder` function above. The `ReadWriteTransaction` closure is called with a transaction handle. You read, you validate, you buffer writes with `BufferWrite`, you return. The client commits the transaction. If a concurrent transaction modified your read set, the client retries the whole closure automatically. The `spanner.CommitTimestamp` sentinel tells Spanner to stamp this row with the transaction's commit time, which is the TrueTime-ordered value, not the wall clock. This is the right default for any `CreatedAt` or audit timestamp.

Interview framing at entry level. "Why Spanner over Postgres" is the common prompt. The right answer is not "it scales." Postgres scales to 50 TB on a big machine. The right answer is "it is linearizable across regions without partitioning the application." If you do not need cross-region ACID, Postgres or Aurora is cheaper and has richer tooling. If you do, Spanner is the only production-grade option on GCP and one of the few anywhere.

### Senior at FAANG: Spanner Architecture, Cost Model, and the NewSQL Landscape

At staff level, the Spanner conversation sits at the intersection of three decisions: consistency model, regional topology, and cost. Each has a senior-level depth that entry-level answers skip over.

Consistency model. Spanner offers strong reads, bounded-staleness reads, exact-staleness reads, and read-your-writes reads inside a transaction. Strong reads give you external consistency at the cost of commit-wait on the read path (though the client optimizes by reading from the nearest replica when safe). Bounded staleness reads as of the most recent timestamp no older than the specified bound, usually served from a nearby replica with no coordination. Exact staleness pins the read to a specific timestamp, which is useful for point-in-time analytics and for repeatable reads across multiple queries. Read-your-writes works inside a read-write transaction and is the only safe way to read data you wrote earlier in the same transaction. The senior-level discipline is to treat strong reads as a scarce resource. Every strong read outside a user-visible read-your-writes path is a latency bug waiting to be discovered in a load test.

TrueTime and commit-wait deserve a deeper treatment. The epsilon bound is not fixed. It expands when a datacenter loses GPS signal or when clock drift is detected, and contracts when clocks are fresh. In steady state it is under 7 ms. During a GPS outage it can grow to tens of milliseconds, which directly expands commit latency. Spanner exposes `spanner_instance_total_cpu` and TrueTime epsilon metrics through Cloud Monitoring, and any staff-level deployment alerts on sustained epsilon greater than 10 ms. The failure mode is never silent, but it is subtle enough to miss without explicit alerting.

Regional topology. Spanner offers single-region (lowest latency, zone survival only), dual-region (regional survival within a continent), and multi-region (cross-continental). Multi-region puts Paxos voting replicas in three regions with witnesses, giving full external consistency globally. Dual-region places voting replicas in two regions with a witness in a third, giving a compromise that is cheaper and lower-latency but with reduced survivability. Single-region is functionally similar to Cloud SQL for most workloads and is often the wrong choice if you are paying Spanner prices. The staff-level framing is that you pick Spanner specifically for multi-region, and if you do not need multi-region, you pick AlloyDB or Cloud SQL instead.

Paxos groups are the unit of replication. Each split (Spanner's equivalent of a range) is replicated by a Paxos group, and each group elects a leader that serializes writes. Reads can be served by followers in bounded-staleness mode, which is the key to scalable read throughput. Staff engineers should know that write throughput per split tops out at roughly 2000 writes per second, and that a hot row that exceeds this will cause latency spikes across the whole database. The mitigations are the same as CockroachDB: UUID keys, hash-sharded indexes, manual splits at known hotspots. Spanner exposes the split distribution and hot split metrics in the admin UI.

Cost model at 2026 prices. Spanner is billed per processing unit (PU), where 1000 PUs is one node. A PU costs roughly $0.10 per hour in a single region, roughly $0.30 per hour in multi-region. Storage is roughly $0.30 per GB per month in single region, roughly $0.50 per GB per month in multi-region. A minimal multi-region production deployment is 1000 PUs at roughly $220 per day, plus storage. For workloads that do not need multi-region ACID, this is expensive compared to Cloud SQL ($50 per day for comparable compute) or CockroachDB Cloud (roughly $110 per day for 3-node dedicated). The senior-level decision rule is "Spanner cost is justified when the alternative is application-level sharding of a globally distributed workload," and when that is not the case, a different database is the better answer.

PGAdapter is the 2023-era bridge that lets Postgres clients talk to Spanner over the Postgres wire protocol. For Go applications, this means `pgx` works unmodified against Spanner. The catch is that PGAdapter is a proxy process you run alongside your application, which adds a hop and a failure domain. Production deployments typically run PGAdapter as a sidecar in the same pod as the application, so the hop is loopback and the failure is co-located. For teams migrating from Postgres to Spanner, this is the path of least resistance. For greenfield work, using the native Spanner client avoids the sidecar and gives you features (commit timestamps, partitioned DML, change streams) that the Postgres dialect does not yet fully expose.

AlloyDB versus Spanner is the question that comes up whenever a team asks "do I need Spanner." AlloyDB is Google's Postgres-compatible OLTP database with a columnar engine for HTAP workloads, built on the same distributed storage as Spanner but exposing a single-region Postgres surface. It is the right answer for Postgres workloads that need more than Cloud SQL can provide and that do not need multi-region ACID. Spanner is the right answer when you need global linearizability. The staff-level decision tree is (1) does the workload need cross-region ACID? If yes, Spanner. If no, (2) is the workload Postgres-shaped and within one region? If yes, AlloyDB. If no, (3) does it fit in one machine? If yes, Cloud SQL. If no, you are usually into analytics territory and should be looking at BigQuery.

Apply versus ApplyAtLeastOnce is the subtle Go client detail that affects correctness. `client.Apply(ctx, mutations)` submits the mutations in a single-use transaction with exactly-once semantics. `client.ApplyAtLeastOnce(ctx, mutations)` skips the transaction machinery and may re-apply the mutations on retry. The latter is faster (lower commit latency) but requires your mutations to be idempotent (updates by primary key, no conditional updates, no counters). For bulk imports and telemetry ingestion, `ApplyAtLeastOnce` is the right choice and often doubles throughput. For anything that mutates shared state, use `Apply`. Getting this wrong produces double-debits, duplicate orders, and audit trail mismatches that are caught months later during reconciliation.

Change streams, Spanner's CDC mechanism, are the feature that unlocks event-driven architectures on Spanner. A change stream captures all mutations to a set of tables and exposes them via a query that reads from the stream. Partitioned into watermarks and per-partition streams, change streams scale horizontally and are typically consumed via Dataflow for analytics or Pub/Sub for event propagation. For Go applications, the pattern is a Dataflow job that writes to Pub/Sub, and a Go consumer on Pub/Sub that handles events idempotently. Change streams have a 1-day retention window by default, configurable up to 7 days, which is longer than DynamoDB Streams but still requires a separate export for long-term replay.

Comparison at staff level. Spanner, CockroachDB, YugabyteDB, TiDB, and Aurora DSQL all target the same distributed SQL niche. The differentiators are (1) consistency model precision (Spanner's TrueTime is unique), (2) cloud affinity (Spanner is GCP-only, CockroachDB is portable, Aurora DSQL is AWS-only), (3) SQL compatibility (TiDB is MySQL-compatible, the rest are Postgres-compatible to varying degrees), and (4) operational model (Spanner is fully managed, CockroachDB offers both, YugabyteDB is usually self-hosted, TiDB offers both, Aurora DSQL is serverless managed). A senior design doc names these axes explicitly and picks on the dimension that most matters to the workload. Any design doc that picks Spanner because "it is a Google product" without this analysis should be blocked in review.

Production operational discipline. Every Spanner deployment should have (a) alerts on TrueTime epsilon, (b) alerts on hot splits from the admin API, (c) a query insights dashboard tracking slow queries by fingerprint, (d) commit latency SLOs with alerts on p99 drift, (e) change stream lag alerts if using CDC, and (f) a documented backup and restore procedure using `gcloud spanner databases create-backup` with regular recovery drills. Spanner is one of the most operationally sound databases in production use, but that reputation depends on disciplined operators, not on the platform alone.

---

