## 89.4 Managing Risk

### Rollback Strategies

Every migration phase must have a tested rollback plan. The ability to quickly revert to the old system is what makes incremental migration safe. There are three primary rollback patterns: feature flags for instant traffic switching, dual-write for database migrations where both systems stay in sync, and expand-contract for schema changes that remain backward-compatible until the final cleanup step. The three implementations each address a different migration scope: `FeatureFlag` provides an instant kill-switch by flipping an `atomic.Bool` that routes all traffic back to the old system in microseconds. Dual-write keeps both old and new stores in sync during a data migration so a rollback never loses writes. Expand-contract uses additive schema changes (add a nullable column, backfill, make it non-null, drop the old column) so any commit in the migration sequence is independently deployable and revertable.

```go
// Pattern 1: Feature Flag Rollback
type FeatureFlag struct {
    name    string
    enabled atomic.Bool
    config  *config.Client
}

func (f *FeatureFlag) Check() bool {
    return f.enabled.Load()
}

func (f *FeatureFlag) Disable() {
    f.enabled.Store(false)
    f.config.Set(f.name, false)
    log.Info("Feature disabled", "feature", f.name)
}

// Instant rollback in case of issues
func handleIncident() {
    flag := GetFlag("new_payment_system")
    flag.Disable()  // Immediately routes all traffic to old
}

// Pattern 2: Database Rollback with Dual-Write
type DualWriter struct {
    primary   *sql.DB
    secondary *sql.DB
}

func (d *DualWriter) Write(ctx context.Context, data Data) error {
    // Write to both during migration
    err1 := d.writeTo(ctx, d.primary, data)
    err2 := d.writeTo(ctx, d.secondary, data)

    if err1 != nil && err2 == nil {
        log.Error("Primary write failed", "error", err1)
        return err1  // Still report the failure
    }
    if err2 != nil && err1 == nil {
        log.Warn("Secondary write failed", "error", err2)
        // Don't fail the request - secondary is not source of truth yet
    }
    return err1
}

// Pattern 3: Schema Rollback with Expand-Contract
/*
    Phase 1: EXPAND
    - Add new columns/tables
    - Old code still works

    Phase 2: MIGRATE
    - Backfill data to new schema
    - Update code to use new schema

    Phase 3: CONTRACT
    - Remove old columns/tables
    - Only after code fully migrated

    Rollback: At any point before CONTRACT, old code works
*/
```

### Monitoring During Migration

You cannot safely migrate what you cannot measure. During a migration, you need side-by-side dashboards comparing the old and new systems across four dimensions: traffic distribution (how much is going where), error rates (is the new system failing more?), latency (is it slower?), and data consistency (do both systems produce the same results?). Without these metrics, you are flying blind and will not know when something goes wrong until users complain. The struct and alert rules below define the minimum monitoring you should have in place before routing any real traffic to the new system.

```go
// Key metrics to track during migration
type MigrationMetrics struct {
    // Traffic distribution
    OldSystemRequests prometheus.Counter
    NewSystemRequests prometheus.Counter

    // Error rates
    OldSystemErrors prometheus.Counter
    NewSystemErrors prometheus.Counter

    // Latency comparison
    OldSystemLatency prometheus.Histogram
    NewSystemLatency prometheus.Histogram

    // Data consistency
    ComparisonMismatches prometheus.Counter
    MismatchDetails      prometheus.CounterVec  // by type

    // Rollout percentage
    NewSystemPercentage prometheus.Gauge
}

func (m *MigrationMetrics) Register() {
    // Dashboard showing:
    // 1. Error rate comparison (should be same or better)
    // 2. Latency comparison (should be same or better)
    // 3. Mismatch rate (should trend to zero)
    // 4. Current rollout percentage
}

// Alert rules
/*
ALERT NewSystemHigherErrorRate
IF rate(new_system_errors[5m]) > rate(old_system_errors[5m]) * 1.1
LABELS { severity = "critical" }
ANNOTATIONS {
    summary = "New system has higher error rate"
    description = "Consider rolling back"
}

ALERT DataMismatchRate
IF rate(comparison_mismatches[5m]) / rate(comparisons[5m]) > 0.001
LABELS { severity = "warning" }
ANNOTATIONS {
    summary = "Data mismatch rate above threshold"
}
*/
```

### Junior → FAANG: Risk Management as a Hiring Signal

FAANG interviewers use "how did you manage risk during that change?" as a filter question. Candidates who answer with "we tested it in staging" are describing a necessary but insufficient step. Candidates who describe dual-write, shadow mode, feature-flagged cutover, and a tested rollback procedure are describing production-grade engineering. You do not need a large project to practice this: even a small Go service change can have a rollback plan, and having one makes a much better interview story.

### Senior @ FAANG: Risk Management as a Governance Framework

At L6, risk management for a migration is a written framework, not an individual judgment call. The migration metrics table (success rate, latency, mismatch rate, go/no-go thresholds) should be standardized across your org so that every team's rollout dashboard looks the same and every on-call engineer knows exactly what number triggers a rollback. This standardization is the difference between a team that manages risk well by luck and a team that manages risk well by design.

Bar-raiser interviewers at Amazon and Google look for evidence that you have moved your org's risk practices forward, not just executed safely on your own project. The question "what did you change about how your org does migrations?" should have a specific answer: you introduced phase gate automation, you built the comparison harness that other teams reuse, you established the dual-write pattern as a required step in the migration checklist. If your risk management improvement stayed within your own team, you may be presenting at L5 scope.

---
