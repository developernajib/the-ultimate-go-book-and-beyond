## 12. Data Reconciliation

After dual-write is active, a reconciliation job verifies that the old and new data stores are consistent. This catches edge cases that dual-write misses. Dual-write handles the happy path, but race conditions, retries that partially succeed, and network partitions can cause the two stores to drift apart silently. The reconciler below fetches the same entity from both the old and new repositories and compares them field by field. When it finds a mismatch, it logs the specific fields that diverge and optionally invokes a fix function to heal the discrepancy automatically. You should run reconciliation continuously as a background job and alert if the mismatch rate exceeds a threshold such as 0.01 percent.

```go
// file: internal/reconcile/reconciler.go
package reconcile

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/example/gobook/internal/domain"
	"github.com/example/gobook/internal/metrics"
)

// Mismatch describes a data discrepancy found during reconciliation.
type Mismatch struct {
	EntityID  string
	Field     string
	OldValue  any
	NewValue  any
	DetectedAt time.Time
}

// Reconciler compares data between old and new repositories.
type Reconciler struct {
	old     domain.UserRepository
	new     domain.UserRepository
	logger  *slog.Logger
	metrics *metrics.MigrationMetrics
	fixFn   func(ctx context.Context, id domain.UserID, old, new *domain.User) error
}

// NewReconciler creates a reconciler. fixFn is called for each mismatch if provided.
func NewReconciler(
	old, new domain.UserRepository,
	logger *slog.Logger,
	m *metrics.MigrationMetrics,
	fixFn func(ctx context.Context, id domain.UserID, old, new *domain.User) error,
) *Reconciler {
	return &Reconciler{
		old:     old,
		new:     new,
		logger:  logger,
		metrics: m,
		fixFn:   fixFn,
	}
}

// ReconcileUser compares a single user between old and new stores.
func (r *Reconciler) ReconcileUser(ctx context.Context, id domain.UserID) ([]Mismatch, error) {
	r.metrics.ReconcileTotal.Add(1)

	oldUser, err := r.old.GetByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("reconcile: get old user %s: %w", id, err)
	}
	newUser, err := r.new.GetByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("reconcile: get new user %s: %w", id, err)
	}

	mismatches := r.compareUsers(oldUser, newUser)
	if len(mismatches) > 0 {
		r.metrics.ReconcileMismatches.Add(1)
		r.logger.Warn("reconcile mismatch detected",
			"user_id", id,
			"mismatch_count", len(mismatches),
		)
		for _, m := range mismatches {
			r.logger.Warn("reconcile field mismatch",
				"user_id", id,
				"field", m.Field,
				"old_value", m.OldValue,
				"new_value", m.NewValue,
			)
		}

		if r.fixFn != nil {
			if err := r.fixFn(ctx, id, oldUser, newUser); err != nil {
				r.logger.Error("reconcile auto-fix failed",
					"user_id", id,
					"error", err,
				)
			}
		}
	}

	return mismatches, nil
}

// ReconcileBatch reconciles a page of users between old and new stores.
func (r *Reconciler) ReconcileBatch(ctx context.Context, limit, offset int) (int, int, error) {
	opts := domain.ListOptions{Limit: limit, Offset: offset}
	users, err := r.old.List(ctx, opts)
	if err != nil {
		return 0, 0, fmt.Errorf("reconcile batch: list old users: %w", err)
	}

	totalMismatches := 0
	for _, u := range users {
		mismatches, err := r.ReconcileUser(ctx, u.ID)
		if err != nil {
			r.logger.Error("reconcile: user error", "user_id", u.ID, "error", err)
			continue
		}
		totalMismatches += len(mismatches)
	}

	return len(users), totalMismatches, nil
}

// compareUsers returns all field-level mismatches between two users.
func (r *Reconciler) compareUsers(old, new *domain.User) []Mismatch {
	var out []Mismatch
	now := time.Now()

	if old.Email != new.Email {
		out = append(out, Mismatch{EntityID: string(old.ID), Field: "email", OldValue: old.Email, NewValue: new.Email, DetectedAt: now})
	}
	if old.Name != new.Name {
		out = append(out, Mismatch{EntityID: string(old.ID), Field: "name", OldValue: old.Name, NewValue: new.Name, DetectedAt: now})
	}
	// Add more fields as needed. Keep updated_at excluded since clocks may diverge.
	return out
}
```

### Junior → FAANG: Data Reconciliation as the Proof of Migration Correctness

Data reconciliation is the mechanism that provides evidence that the migration has not corrupted or lost data. Without reconciliation, you have no way to confirm that dual-write is functioning correctly, that the backfill was complete, or that the new service is producing consistent results. Reconciliation converts the question "is the migration correct?" from a matter of opinion to a matter of measurement.

The field-level mismatch structure in this implementation is important: recording which specific fields diverge, not just whether a record diverges, is what enables root cause analysis. If 1,000 records have a mismatch only in the `updated_at` field, the cause is likely a clock skew or timezone handling difference, not a correctness bug. If mismatches are distributed across random fields on random records, the cause may be a race condition in the dual-write coordinator. The field-level granularity is what makes this distinction possible.

For Go engineers: the comment about excluding `updated_at` from comparison reflects a common production pitfall. Timestamp fields populated by the application clock will vary between the old and new service by microseconds or milliseconds due to clock skew and processing time differences. Comparing them will always produce false positives. Define explicitly which fields represent business-critical data (name, email, role, balance) and compare only those.

### Senior @ FAANG: Reconciliation Governance and the Mismatch Triage Protocol

At senior level, data reconciliation is a governance process, not just a technical check. The governance artifact is the mismatch triage protocol: a classification system for mismatches that determines which require immediate remediation, which require investigation, and which are acceptable variance.

The classification framework: critical mismatches affect business-critical fields (financial amounts, user permissions, order statuses) and require immediate remediation and an incident report. Systematic mismatches affect the same field across a large number of records and indicate a systemic bug in the migration logic that requires a code fix and a re-backfill. Isolated mismatches affect a small number of records with no clear pattern and require case-by-case investigation. Acceptable variance includes fields that are expected to differ due to migration timing (last login timestamps, session tokens) and should be explicitly excluded from reconciliation scope in the configuration.

The reconciliation frequency and scope must be defined before the migration begins. Running reconciliation on 100% of records at 1-minute intervals on a table with 100 million rows is not feasible. The correct approach: run full reconciliation during off-peak hours (nightly), run sampled reconciliation (1% of records) continuously during peak hours, and run targeted reconciliation on any record that was written through the dual-write coordinator in the last 5 minutes. This tiered approach provides continuous coverage without overwhelming either store.

At senior level, the reconciliation results must feed back into the migration gate conditions defined in the metrics governance section. If the reconciliation mismatch rate exceeds the defined threshold, the migration traffic split must not advance. The reconciliation system is the data correctness signal, the metrics system is the operational health signal, and both must be green before any traffic split increase is approved.

---
