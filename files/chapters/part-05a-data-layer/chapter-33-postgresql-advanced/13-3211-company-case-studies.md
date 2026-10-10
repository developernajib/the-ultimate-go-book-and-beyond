## 33.11 Company Case Studies

### How Instagram Uses PostgreSQL at Scale

Instagram stores billions of photos and serves hundreds of millions of users using PostgreSQL:

**1. Sharding with Consistent Hashing**

```go
// Instagram uses sharding based on user ID
type ShardedPostgres struct {
	shards []*pgxpool.Pool
	count  int
}

func (s *ShardedPostgres) GetShard(userID int64) *pgxpool.Pool {
	// Consistent hash based on user ID
	shardID := userID % int64(s.count)
	return s.shards[shardID]
}

func (s *ShardedPostgres) GetUserPhotos(ctx context.Context, userID int64) ([]Photo, error) {
	pool := s.GetShard(userID)

	query := `
		SELECT id, user_id, url, caption, created_at
		FROM photos
		WHERE user_id = $1
		ORDER BY created_at DESC
		LIMIT 20
	`

	rows, err := pool.Query(ctx, query, userID)
	// ...
}
```

**2. JSONB for Flexible Metadata**

```go
// Instagram stores photo metadata in JSONB
type PhotoMetadata struct {
	Filters     []string          `json:"filters"`
	Location    *Location         `json:"location,omitempty"`
	TaggedUsers []int64           `json:"tagged_users,omitempty"`
	Hashtags    []string          `json:"hashtags,omitempty"`
	Custom      map[string]string `json:"custom,omitempty"`
}

func (r *PhotoRepository) UpdateMetadata(ctx context.Context, photoID int64, updates map[string]any) error {
	// Partial JSONB update using jsonb_set
	query := `
		UPDATE photos
		SET metadata = metadata || $1::jsonb
		WHERE id = $2
	`

	data, _ := json.Marshal(updates)
	_, err := r.pool.Exec(ctx, query, data, photoID)
	return err
}
```

### Geospatial Data in PostgreSQL: PostGIS at Ride-Hailing Scale

A ride platform processes millions of location updates per second. (Honesty note: Uber itself famously migrated from Postgres to MySQL in 2016 for replication-architecture reasons and indexes geodata with its H3 hexagonal grid, but PostGIS remains the standard geospatial answer for Postgres shops, and the query patterns below are what it looks like:)

**1. PostGIS for Geospatial Queries**

```go
// Uber uses PostGIS extension for location queries
func (r *DriverRepository) FindNearbyDrivers(ctx context.Context, lat, lng float64, radiusKm float64) ([]Driver, error) {
	query := `
		SELECT
			id, name, vehicle_type,
			ST_Distance(
				location::geography,
				ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
			) as distance_meters
		FROM drivers
		WHERE status = 'available'
		AND ST_DWithin(
			location::geography,
			ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
			$3 * 1000  -- Convert km to meters
		)
		ORDER BY distance_meters
		LIMIT 10
	`

	rows, err := r.pool.Query(ctx, query, lng, lat, radiusKm)
	// ...
}
```

**2. Real-time Location Updates with LISTEN/NOTIFY**

```go
// Uber broadcasts driver location updates
func (r *DriverRepository) UpdateLocation(ctx context.Context, driverID int64, lat, lng float64) error {
	query := `
		UPDATE drivers
		SET location = ST_SetSRID(ST_MakePoint($1, $2), 4326),
		    last_seen = NOW()
		WHERE id = $3
	`

	_, err := r.pool.Exec(ctx, query, lng, lat, driverID)
	if err != nil {
		return err
	}

	// Notify subscribers about location change
	notification := map[string]any{
		"driver_id": driverID,
		"lat":       lat,
		"lng":       lng,
		"timestamp": time.Now().Unix(),
	}
	data, _ := json.Marshal(notification)

	_, err = r.pool.Exec(ctx, "SELECT pg_notify('driver_locations', $1)", string(data))
	return err
}
```

### Financial-Grade PostgreSQL

Payment processors move billions of dollars with strict consistency requirements, and the discipline below is what that demands from Postgres:

**1. Serializable Transactions for Payments**

```go
// Financial systems use serializable isolation for money movement
func (r *PaymentRepository) ProcessPayment(ctx context.Context, payment *Payment) error {
	return r.db.TransactionWithRetry(ctx, 3, func(tx pgx.Tx) error {
		// Lock the account row
		var balanceCents int64
		err := tx.QueryRow(ctx, `
			SELECT balance_cents FROM accounts WHERE id = $1 FOR UPDATE
		`, payment.AccountID).Scan(&balanceCents)
		if err != nil {
			return err
		}

		if balanceCents < payment.AmountCents {
			return ErrInsufficientFunds
		}

		// Debit account
		_, err = tx.Exec(ctx, `
			UPDATE accounts SET balance_cents = balance_cents - $1 WHERE id = $2
		`, payment.AmountCents, payment.AccountID)
		if err != nil {
			return err
		}

		// Record transaction with idempotency key check
		_, err = tx.Exec(ctx, `
			INSERT INTO transactions (idempotency_key, account_id, amount_cents, type, status)
			VALUES ($1, $2, $3, $4, 'completed')
			ON CONFLICT (idempotency_key) DO NOTHING
		`, payment.IdempotencyKey, payment.AccountID, payment.AmountCents, payment.Type)

		return err
	})
}
```

### Junior → FAANG: Reading Case Studies Without Cargo-Culting

Junior engineers read "Instagram shards by user_id" and immediately propose sharding their 40 GB database. That is the wrong lesson. The right lesson is that Instagram ran a single Postgres node for years before sharding, and the shard key was chosen because every hot query already filtered by user_id. Read case studies for the constraints that forced the design, not the design itself.

Prerequisite gaps to close before your first on-call shift:
1. You must be able to read `EXPLAIN (ANALYZE, BUFFERS)` output and name the node types (Seq Scan, Index Scan, Bitmap Heap Scan, Nested Loop, Hash Join, Merge Join). If Buffers shows `shared read=50000` on a hot query, that is 400 MB of cache misses per execution.
2. You must know the difference between `FOR UPDATE`, `FOR NO KEY UPDATE`, `FOR SHARE`, and `FOR KEY SHARE`. The Stripe payment example uses `FOR UPDATE` because it mutates the balance_cents column. Using `FOR NO KEY UPDATE` would allow foreign key checks to proceed concurrently.
3. You must understand that `SERIALIZABLE` in Postgres is SSI (Serializable Snapshot Isolation), not 2PL. It aborts transactions with SQLSTATE 40001 at commit time, so every serializable transaction needs a retry loop like the `TransactionWithRetry` helper above.

Worked example, "why did this fail?" reflex. A junior ships the Uber `FindNearbyDrivers` query and p99 latency spikes to 8 seconds during rush hour. Walk through the diagnosis:
- Run `EXPLAIN (ANALYZE, BUFFERS)` with a hot lat/lng pair. If you see Seq Scan on drivers, the GIST index on `location` is missing or not usable because the query casts to `geography` while the index is on `geometry`. Fix: `CREATE INDEX drivers_location_gix ON drivers USING GIST ((location::geography))` and add `WHERE status = 'available'` as a partial index predicate.
- If the plan uses the index but still takes 8 seconds, check `pg_stat_statements` for `mean_exec_time` and `shared_blks_hit` vs `shared_blks_read`. A cold cache after failover will read from disk until the working set is resident.
- If the index is used and cache is warm but latency is still bad, the problem is likely lock contention from the `UPDATE drivers SET location = ...` path fighting the read path. HOT updates require the updated column to not be indexed, so updating `location` invalidates the GIST index and forces a non-HOT update.

Interview entry-point for new grads and SWE I candidates:
- "Walk me through what happens when you run `SELECT * FROM photos WHERE user_id = 42` on a table with a btree index on user_id." Expected answer names the index scan, the TID fetch from the heap, MVCC visibility check against the snapshot, and the tuple return. Bonus points for mentioning Index-Only Scans and the visibility map.
- "What is the difference between `JSONB` and `JSON`?" JSONB is parsed and stored in a binary decomposed form, supports GIN indexes, and has slightly higher write cost. JSON stores the exact text. Instagram picks JSONB for metadata because `metadata @> '{"filters": ["valencia"]}'` needs a GIN index.

### Senior @ FAANG: Case Study Archaeology and Platform ADRs

Staff and principal engineers do not just implement the Stripe pattern. They decide whether Postgres is still the right substrate, write the ADR that commits the org to it for the next five years, and run the migration when it is not. The case studies in this section are snapshots of a decade of decisions. Your job is to know which decisions aged well and which did not.

The Uber Postgres-to-MySQL-to-Docstore saga (2016 blog post, 2020 Docstore announcement, 2023 internal migration wrap-up) is the canonical cautionary tale. Uber migrated off Postgres citing write amplification on HOT updates, replication model differences, and connection handling. The critical reading is that many of those pain points were addressed across Postgres 12 through 18 (logical replication maturity, HOT-update and indexing improvements, and ongoing connection-pooling work), even though the write-amplification issue that an in-place storage engine like zheap would have solved never landed in core. The ADR lesson is that migrating databases is a multi-year commitment and the destination's maturity matters more than the source's flaws. Uber ended up building Docstore on top of MySQL and then layering their own sharding, which is effectively what Citus or Vitess already offered.

GitLab's Postgres migration stories (the 2017 data loss incident, the 2020 multi-TB upgrade using logical replication, the 2023 decomposition into Cells architecture) give you three distinct ADRs to study:
1. Incident-driven backup discipline. PITR with WAL archiving to object storage, tested restores on a weekly cadence, and a backup runbook that is rehearsed by every on-call engineer.
2. Major version upgrade via logical replication switchover instead of `pg_upgrade --link`. Downtime drops from 30 minutes to under 60 seconds, at the cost of running two clusters in parallel for weeks and reconciling replication slot lag.
3. Horizontal decomposition when vertical scaling runs out. GitLab's Cells design shards tenants across independent Postgres clusters rather than sharding inside one cluster. This is the Shopify Pods model applied to a different domain.

Notion's 2021 sharding project (sharded into 480 logical shards across 32 physical Postgres instances) and Figma's sharding project (grouped related tables into colocations that share a shard key, kept the application query pattern largely unchanged behind a custom routing proxy called DBProxy) are the two reference architectures for application-level sharding on vanilla Postgres. The senior-level question is when to pick that over Citus, Aurora Limitless, AlloyDB, CockroachDB, or Spanner. The answer is usually "when your write volume is below 500k TPS and your team has the operational maturity to run the routing layer." Above that, managed distributed SQL earns its premium.

Extension review ADR template. Every new extension is a production dependency with its own release cadence, security posture, and upgrade story. Treat `CREATE EXTENSION` like adding a service.

```
# ADR-0XXX: Adopt <extension> in Postgres platform

## Context
- Problem being solved
- Alternatives considered (app-layer, different extension, managed service)
- Postgres versions affected (17, 18)
- Managed service compatibility (RDS, Aurora, AlloyDB, Supabase, Neon, Crunchy)

## Decision
- Extension name, version, upstream maintainer
- Installation path (shared_preload_libraries, superuser grant, per-database CREATE EXTENSION)
- Upgrade mechanism (ALTER EXTENSION UPDATE, or drop/recreate with data migration)

## Consequences
- Lock-in: can we leave this extension without a full data migration?
- Performance footprint: memory, WAL volume, background workers
- Security surface: new SQL functions, new roles, any SECURITY DEFINER risk
- Observability: metrics exposed, log volume, pg_stat_* views added

## Operational commitments
- On-call runbook updates
- Backup/restore validation with extension present
- Major version upgrade validation (does it support PG 18 GA?)
```

Apply this template to the usual suspects. pgvector earns it in 2026 because every product has an embeddings feature. TimescaleDB earns it for time-series workloads above 100k inserts/sec. Citus earns it only if you have committed to Azure or self-hosted and need distributed tables. pg_cron is trivially adopted but becomes a pager source when leader failover loses scheduled jobs. pg_partman is mandatory above 100 GB partitioned tables. pg_stat_statements is non-optional and should be in shared_preload_libraries on every cluster. pg_ivm (incremental materialized views) is still experimental in 18 and belongs in a staging evaluation, not production. ParadeDB adds search and analytics inside Postgres and competes with Elasticsearch sidecars. The ADR decides whether that consolidation is worth the coupling.

Maturity model for Postgres platform teams:
- L1: One hand-tuned instance per service, manual failover, backups to a shared NFS. Typical at Series A startups.
- L2: Managed RDS/Aurora with Terraform modules, per-team runbooks, monthly restore drills. Typical at Series C.
- L3: Centralized platform team owns a golden-path module. Standard extensions, standard observability (pg_stat_statements, pgBadger, pgwatch2), standard connection pooling (pgbouncer or pgcat). On-call rotation for the platform team.
- L4: Self-service provisioning for application teams. Schema change tooling adopted (pgroll from Xata, reshape, or pg_osc). Automated bloat detection with pg_repack runs gated on lock acquisition timeouts. Logical replication for major version upgrades is standard.
- L5: Multi-tenant Postgres platform with quotas, chargeback, and tenant isolation. Automated shard splits. Fleet-wide query regression detection via pg_stat_statements diffing across deploys. Disaster recovery tested monthly with real RTO/RPO measurements. This is where Figma, Notion, Shopify, and Instacart operate in 2026.

Bar-raiser interview questions for staff candidates on Postgres case studies:
1. "Walk me through a 9-month migration you led from one database engine to another." Signal: did they run shadow traffic, dual-write with reconciliation, or cutover? How did they handle schema drift?
2. "Describe an index bloat incident you debugged." Signal: do they know about pg_repack vs VACUUM FULL, the `pgstattuple` extension, autovacuum_naptime tuning, and the difference between table bloat and index bloat?
3. "Your primary is healthy but a replica is 40 minutes behind and growing. Triage." Signal: do they reach for `pg_stat_replication`, check for long-running queries on the replica blocking WAL apply, consider `hot_standby_feedback` tradeoffs, and understand that logical replication workers have a different failure mode than streaming replication?

---
