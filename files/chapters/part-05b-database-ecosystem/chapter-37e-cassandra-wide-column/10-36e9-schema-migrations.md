## 37E.9 Schema Migrations

### Managing CQL Schema Changes

Cassandra schema migrations must be strictly additive: dropping or renaming columns breaks existing data since Cassandra stores columns by name in each SSTable. This migration runner persists applied migrations in a `schema_migrations` table using a checksum, so it is idempotent and safe to run at application startup before any queries execute.

```go
package migrations

import (
	"context"
	"fmt"
	"hash/fnv"
	"log/slog"
	"slices"
	"time"

	"github.com/gocql/gocql"
)

// Migration represents a versioned schema change
type Migration struct {
	Version     int
	Description string
	Up          string // CQL to apply
	Down        string // CQL to reverse (optional)
}

// Migrator handles Cassandra schema migrations
type Migrator struct {
	session *gocql.Session
	log     *slog.Logger
}

func NewMigrator(session *gocql.Session, log *slog.Logger) *Migrator {
	return &Migrator{session: session, log: log}
}

// Initialize creates the schema_migrations tracking table
func (m *Migrator) Initialize(ctx context.Context) error {
	return m.session.Query(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version     INT,
			description TEXT,
			applied_at  TIMESTAMP,
			checksum    TEXT,
			PRIMARY KEY (version)
		)
	`).WithContext(ctx).Exec()
}

// Migrate applies pending migrations in order
func (m *Migrator) Migrate(ctx context.Context, migrations []Migration) error {
	// Sort by version
	slices.SortFunc(migrations, func(a, b Migration) int {
		return a.Version - b.Version
	})

	// Get applied versions
	applied, err := m.getApplied(ctx)
	if err != nil {
		return fmt.Errorf("get applied: %w", err)
	}

	for _, mig := range migrations {
		if _, ok := applied[mig.Version]; ok {
			m.log.Debug("migration already applied", "version", mig.Version)
			continue
		}

		m.log.Info("applying migration", "version", mig.Version, "description", mig.Description)

		if err := m.session.Query(mig.Up).WithContext(ctx).Exec(); err != nil {
			return fmt.Errorf("migration %d failed: %w", mig.Version, err)
		}

		// Record applied migration
		if err := m.session.Query(
			`INSERT INTO schema_migrations (version, description, applied_at, checksum) VALUES (?, ?, ?, ?)`,
			mig.Version, mig.Description, time.Now().UTC(), checksum(mig.Up),
		).WithContext(ctx).Exec(); err != nil {
			return fmt.Errorf("record migration %d: %w", mig.Version, err)
		}

		m.log.Info("migration applied", "version", mig.Version)
	}
	return nil
}

func (m *Migrator) getApplied(ctx context.Context) (map[int]struct{}, error) {
	iter := m.session.Query(`SELECT version FROM schema_migrations`).
		WithContext(ctx).
		Iter()

	applied := make(map[int]struct{})
	var version int
	for iter.Scan(&version) {
		applied[version] = struct{}{}
	}
	return applied, iter.Close()
}

func checksum(s string) string {
	h := fnv.New32a()
	h.Write([]byte(s))
	return fmt.Sprintf("%x", h.Sum32())
}

// Example migrations
var Migrations = []Migration{
	{
		Version:     1,
		Description: "create users table",
		Up: `CREATE TABLE IF NOT EXISTS users (
			user_id UUID, email TEXT, name TEXT, created_at TIMESTAMP,
			PRIMARY KEY (user_id)
		)`,
	},
	{
		Version:     2,
		Description: "add metadata column to users",
		Up:          `ALTER TABLE users ADD metadata MAP<TEXT, TEXT>`,
	},
	{
		Version:     3,
		Description: "create orders tables",
		Up: `CREATE TABLE IF NOT EXISTS orders_by_user (
			user_id UUID, created_at TIMESTAMP, order_id UUID,
			status TEXT, total_cents BIGINT,
			PRIMARY KEY (user_id, created_at, order_id)
		) WITH CLUSTERING ORDER BY (created_at DESC, order_id ASC)`,
	},
	{
		Version:     4,
		Description: "add email SAI index (Cassandra 5.0)",
		// SAI (Storage-Attached Index) replaces legacy 2i for 5.0 deployments.
		// SAI maintains the index inline with flush/compaction, requiring no cluster-wide
		// rebuild when a node joins, and it scales to billions of rows.
		Up: `CREATE INDEX IF NOT EXISTS users_email_sai ON users (email) USING 'sai'`,
	},
	{
		Version:     5,
		Description: "add vector column + ANN index for semantic search",
		Up: `ALTER TABLE users ADD profile_vec VECTOR<FLOAT, 384>`,
	},
	{
		Version:     6,
		Description: "SAI vector index (HNSW + cosine similarity)",
		Up: `CREATE INDEX IF NOT EXISTS users_vec_sai ON users (profile_vec)
		     USING 'sai' WITH OPTIONS = {'similarity_function': 'cosine'}`,
	},
}
```

### Junior to FAANG: why Cassandra DDL is not SQL DDL

In a relational system you can rename a column, change its type, or drop it, and the engine rewrites pages behind you. Cassandra does none of that. A column is identified by name in every SSTable on disk, so renaming is impossible and dropping is a metadata operation that leaves orphaned cells until compaction reclaims them. Changing the type of a column is allowed only between compatible types (for example `ASCII` to `TEXT`) and never for primary key columns. A worked first-job example: you wrote `user_name TEXT` and later realize you need an internationalized display field. The correct move is to add a new column `display_name TEXT`, dual-write for a migration window, backfill, and switch readers. The wrong move is to try to rename. Interview entry point: be able to list the three operations that are safe (`ADD column`, `DROP column`, `CREATE TABLE`) and the three that are dangerous or forbidden (rename PK, change PK, change clustering order). Also know that `IF NOT EXISTS` on `CREATE TABLE` is idempotent but not free, because the schema check itself propagates through gossip.

### Senior at FAANG: schema propagation, disagreement, and online DDL limits

At staff level, schema migrations are a distributed systems problem disguised as a DDL problem. Every schema change in Cassandra 5.0 produces a new schema version UUID, which propagates via gossip to every node in the cluster. Until all nodes agree on the same schema version, the cluster is in a state called schema disagreement, visible in `nodetool describecluster` as multiple schema versions. Writes and reads that touch the affected table during disagreement may hit nodes with stale metadata and either reject the operation or silently drop columns the coordinator does not know about. The operational rule is: issue one DDL statement at a time, wait for agreement (poll `system.peers` and `system.local` for the schema version until they converge), then issue the next. Running multiple concurrent DDL statements against different coordinators is the classic way to create a schema split that requires a rolling restart to resolve. Your migrator above applies statements sequentially, which is correct, but it should also call an agreement wait between statements. A production `waitForSchemaAgreement(ctx)` helper polls `system.peers.schema_version` with a bounded timeout (typically 30 seconds) and fails loudly if nodes do not converge.

The irreversibility of primary key changes is the second staff-level topic. Cassandra has no online way to change a partition key, a clustering key, or a clustering order. The only safe migration is a new table with the new key, a backfill job that copies data through a token-range scan, a dual-write window so new mutations land in both tables, a cutover of readers behind a feature flag, and a final `DROP TABLE` on the old table after a cooling period. This pattern shows up in every large-scale Cassandra shop and is worth rehearsing as an interview drill. The backfill job reads by token ranges (for example `WHERE token(pk) >= ? AND token(pk) < ?`) rather than paging through a single iterator, because the per-partition key order makes single-iterator scans impossible to resume safely after failure. Sized correctly, a token-range scan with N shards parallelizes across the cluster and completes without a single coordinator hotspot.

Dropping and re-adding a column with the same name is a trap. Because Cassandra keys cells by column name and writetime, a re-added column will shadow or be shadowed by undeleted cells from the dropped version, depending on timestamp ordering. The safe pattern is: drop the column, wait for `gc_grace_seconds` (default 10 days) plus a full compaction cycle, then re-add. In practice, teams avoid re-adding dropped names entirely and pick a new name. Document this in the migration framework so junior engineers do not reach for the easy rename later.

SAI (Storage-Attached Indexes) in Cassandra 5.0 change the migration economics for secondary indexes. Legacy `2i` indexes required a full cluster rebuild on creation and scaled poorly past a few million rows. SAI builds incrementally with flush and compaction, so `CREATE INDEX ... USING 'sai'` is effectively free at creation time and filled in over the next compaction cycle. The migration above adds a SAI index on `email` and a vector SAI index on `profile_vec`. In production, you still want to issue the `CREATE INDEX` during a low-traffic window because the initial backfill of existing SSTables does consume IO, but the cluster remains available throughout. ScyllaDB 6.0 has its own Local Secondary Index (LSI) and Global Secondary Index (GSI) types with different trade-offs, and neither is wire-compatible with Cassandra SAI, which matters if your migration framework targets both engines. Staff-level signal in review: your migrator should emit a structured audit log per migration (version, checksum, applied_at, schema_version_before, schema_version_after), because post-mortem reconstruction of a bad migration depends on that trail. It should also refuse to run if the checksum of a previously-applied migration does not match the stored checksum, which catches the case where someone edited a migration file in place rather than appending a new one.

---
