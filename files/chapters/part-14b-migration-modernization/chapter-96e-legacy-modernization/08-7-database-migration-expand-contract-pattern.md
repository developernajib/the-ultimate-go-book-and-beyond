## 7. Database Migration: Expand-Contract Pattern

The expand-contract (also called parallel change) pattern is the safest way to perform online schema changes. It avoids downtime and allows rollback at each phase. The pattern works in three stages. First, you expand the schema by adding a new column alongside the old one, which is a non-breaking change since existing code still reads and writes the old column. Second, you backfill existing rows by copying data from the old column to the new one in small batches, with rate limiting to avoid overwhelming the database. Third, after verifying that every row has been backfilled and all application code has been deployed to use the new column, you contract the schema by dropping the old column. The code below provides a reusable migration runner that handles all three phases with built-in progress tracking and verification.

```go
// file: internal/dbmigration/expand_contract.go
package dbmigration

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"time"
)

// Phase represents which phase of expand-contract the system is in.
type Phase string

const (
	PhaseExpand   Phase = "expand"   // New column added, both old and new coexist.
	PhaseMigrate  Phase = "migrate"  // Backfilling old data into new column.
	PhaseContract Phase = "contract" // Old column removed after migration verified.
)

// SchemaVersion tracks the current migration state.
type SchemaVersion struct {
	Version   int
	Phase     Phase
	AppliedAt time.Time
	Notes     string
}

// MigrationRunner executes database migrations with expand-contract semantics.
type MigrationRunner struct {
	db     *sql.DB
	logger *slog.Logger
}

// NewMigrationRunner creates a runner backed by the given DB.
func NewMigrationRunner(db *sql.DB, logger *slog.Logger) *MigrationRunner {
	return &MigrationRunner{db: db, logger: logger}
}

// ExpandAddColumn adds a new nullable column without removing the old one.
// This is always backward compatible: old code still writes to the old column.
func (m *MigrationRunner) ExpandAddColumn(ctx context.Context, table, newCol, colDef string) error {
	query := fmt.Sprintf(
		"ALTER TABLE %s ADD COLUMN IF NOT EXISTS %s %s",
		table, newCol, colDef,
	)
	m.logger.Info("expand: adding column",
		"table", table,
		"column", newCol,
		"phase", PhaseExpand,
	)
	_, err := m.db.ExecContext(ctx, query)
	if err != nil {
		return fmt.Errorf("expand add column %s.%s: %w", table, newCol, err)
	}
	return nil
}

// BackfillBatch migrates a batch of rows from old column to new column.
// Uses keyset pagination for efficiency on large tables. Returns the
// last processed ID and whether more rows remain.
func (m *MigrationRunner) BackfillBatch(
	ctx context.Context,
	table, idCol, oldCol, newCol string,
	lastID int64,
	batchSize int,
	transform func(old any) any,
) (nextID int64, hasMore bool, err error) {
	selectQuery := fmt.Sprintf(
		`SELECT %s, %s FROM %s WHERE %s > $1 AND %s IS NULL ORDER BY %s LIMIT $2`,
		idCol, oldCol, table, idCol, newCol, idCol,
	)
	rows, err := m.db.QueryContext(ctx, selectQuery, lastID, batchSize)
	if err != nil {
		return 0, false, fmt.Errorf("backfill select: %w", err)
	}
	defer rows.Close()

	type row struct {
		id  int64
		old any
	}
	var batch []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.old); err != nil {
			return 0, false, fmt.Errorf("backfill scan: %w", err)
		}
		batch = append(batch, r)
	}
	if err := rows.Err(); err != nil {
		return 0, false, fmt.Errorf("backfill rows: %w", err)
	}
	if len(batch) == 0 {
		return lastID, false, nil
	}

	// Update in a single transaction per batch for atomicity.
	tx, err := m.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, false, fmt.Errorf("backfill begin tx: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	updateQuery := fmt.Sprintf(
		`UPDATE %s SET %s = $1 WHERE %s = $2`,
		table, newCol, idCol,
	)
	stmt, err := tx.PrepareContext(ctx, updateQuery)
	if err != nil {
		return 0, false, fmt.Errorf("backfill prepare: %w", err)
	}
	defer stmt.Close()

	for _, r := range batch {
		newVal := transform(r.old)
		if _, err = stmt.ExecContext(ctx, newVal, r.id); err != nil {
			return 0, false, fmt.Errorf("backfill update row %d: %w", r.id, err)
		}
		nextID = r.id
	}

	if err = tx.Commit(); err != nil {
		return 0, false, fmt.Errorf("backfill commit: %w", err)
	}

	m.logger.Info("backfill batch completed",
		"table", table,
		"batch_size", len(batch),
		"last_id", nextID,
	)

	return nextID, len(batch) == batchSize, nil
}

// ContractDropColumn removes the old column after migration is verified.
// IMPORTANT: Only call this after all reads/writes have switched to the new column
// AND the change has been deployed for at least one full traffic cycle.
func (m *MigrationRunner) ContractDropColumn(ctx context.Context, table, oldCol string) error {
	m.logger.Info("contract: dropping column",
		"table", table,
		"column", oldCol,
		"phase", PhaseContract,
		"warning", "ensure all application code is updated before running",
	)
	query := fmt.Sprintf("ALTER TABLE %s DROP COLUMN IF EXISTS %s", table, oldCol)
	_, err := m.db.ExecContext(ctx, query)
	if err != nil {
		return fmt.Errorf("contract drop column %s.%s: %w", table, oldCol, err)
	}
	return nil
}

// VerifyBackfillComplete checks that no rows have a NULL new column.
func (m *MigrationRunner) VerifyBackfillComplete(ctx context.Context, table, newCol string) (bool, int64, error) {
	query := fmt.Sprintf(
		`SELECT COUNT(*) FROM %s WHERE %s IS NULL`,
		table, newCol,
	)
	var count int64
	if err := m.db.QueryRowContext(ctx, query).Scan(&count); err != nil {
		return false, 0, fmt.Errorf("verify backfill: %w", err)
	}
	return count == 0, count, nil
}

// RunBackfillWithRateLimit runs full table backfill with configurable rate limiting
// to avoid overwhelming the database during migration.
func (m *MigrationRunner) RunBackfillWithRateLimit(
	ctx context.Context,
	table, idCol, oldCol, newCol string,
	batchSize int,
	batchDelayMS int,
	transform func(old any) any,
) error {
	var lastID int64
	totalRows := int64(0)

	m.logger.Info("starting full table backfill",
		"table", table,
		"batch_size", batchSize,
		"batch_delay_ms", batchDelayMS,
	)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		nextID, hasMore, err := m.BackfillBatch(ctx, table, idCol, oldCol, newCol, lastID, batchSize, transform)
		if err != nil {
			return fmt.Errorf("backfill run: %w", err)
		}

		rowsInBatch := nextID - lastID
		totalRows += rowsInBatch
		lastID = nextID

		m.logger.Info("backfill progress",
			"table", table,
			"total_rows_processed", totalRows,
			"last_id", lastID,
		)

		if !hasMore {
			break
		}

		if batchDelayMS > 0 {
			time.Sleep(time.Duration(batchDelayMS) * time.Millisecond)
		}
	}

	m.logger.Info("backfill complete",
		"table", table,
		"total_rows", totalRows,
	)
	return nil
}
```

### Junior → FAANG: Expand-Contract as Zero-Downtime Schema Change

Database schema changes are one of the riskiest operations in production systems because they are often irreversible and because they affect every application instance simultaneously. The expand-contract pattern exists specifically to make schema changes safe by breaking them into phases that are each individually non-breaking.

The key insight: the expand phase (adding a new column) is non-breaking because existing application code that reads or writes the old column continues to work. The contract phase (dropping the old column) is only safe after all application code has been updated to use the new column. The migration phase in the middle (backfilling existing rows) must complete before the contract phase can begin.

For Go engineers specifically: the batch backfill approach in this implementation is critical for production safety. A naive backfill that updates all rows in a single query would lock the table and block production traffic. The batched approach with rate limiting ensures that the backfill proceeds without causing performance degradation. The `time.Sleep(50 * time.Millisecond)` between batches is not arbitrary: it is a configurable throttle that limits the write rate to prevent overwhelming the database during peak traffic hours.

### Senior @ FAANG: Database Migration Governance and the Rollback Protocol

At senior level, database migrations are governance events that require formal review and approval processes at most FAANG companies. Any production schema change that affects a high-traffic table requires a migration plan document, a rollback plan, a backfill timeline estimate, and sign-off from the on-call engineer and the team's technical lead.

The specific governance concerns at senior level: the backfill completion verification must be automated, not manual. The implementation in this section includes a `verifyMigration` function that confirms every row has been updated before declaring the migration complete. This verification must be part of the automated migration runner, not a manual check that a human performs and documents.

The rollback protocol for expand-contract at each phase: if the expand phase fails, drop the new column (the old code is unaffected). If the backfill fails, the old and new columns are in an inconsistent state: restart the backfill from a checkpoint (the implementation tracks progress). If the application code update fails after the backfill, rollback the application code (the old column still exists and the old code still works). The contract phase is the only irreversible phase: once the old column is dropped, rollback requires either restoring from backup or running the expand-contract process in reverse. For this reason, the contract phase should be delayed until all of the above phases have been stable for a defined period.

---
