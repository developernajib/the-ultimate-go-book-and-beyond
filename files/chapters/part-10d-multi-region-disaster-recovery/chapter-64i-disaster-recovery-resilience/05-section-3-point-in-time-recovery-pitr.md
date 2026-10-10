## Section 3: Point-in-Time Recovery (PITR)


PITR allows restoring a database to any moment in time by replaying WAL (Write-Ahead Log) segments from a base backup. This is the primary mechanism for meeting aggressive RPO targets without synchronous replication.

```go
// file: internal/dr/pitr/recovery.go
package pitr

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// WALSegment represents a single archived WAL file.
type WALSegment struct {
	SegmentName string
	StartLSN    string
	EndLSN      string
	StartTime   time.Time
	EndTime     time.Time
	StoragePath string
	SizeBytes   int64
}

// WALArchive provides access to archived WAL segments.
type WALArchive interface {
	// ListSegments returns WAL segments in chronological order.
	ListSegments(ctx context.Context, after, before time.Time) ([]WALSegment, error)
	// FetchSegment retrieves a WAL segment by name.
	FetchSegment(ctx context.Context, name string) ([]byte, error)
}

// BaseBackupProvider retrieves base backup data.
type BaseBackupProvider interface {
	// LatestBefore returns the most recent full backup taken before targetTime.
	LatestBefore(ctx context.Context, targetTime time.Time) (*BaseBackup, error)
	// RestoreBase restores the base backup to the target data directory.
	RestoreBase(ctx context.Context, backup *BaseBackup, dataDir string) error
}

// BaseBackup is a complete database snapshot.
type BaseBackup struct {
	ID          string
	TakenAt     time.Time
	EndLSN      string
	StoragePath string
}

// DBRestorer applies WAL segments to a restored base.
type DBRestorer interface {
	// RestoreBase extracts a base backup into the target data directory.
	RestoreBase(ctx context.Context, base *BaseBackup, dataDir string) error
	// ApplyWAL replays a WAL segment file at path.
	ApplyWAL(ctx context.Context, segmentPath string) error
	// PromoteStandby promotes replica to primary (stops replay, accepts writes).
	PromoteStandby(ctx context.Context) error
}

// RecoveryConfig holds PITR parameters.
type RecoveryConfig struct {
	TargetTime    time.Time // restore to this point in time
	DataDirectory string
	ServiceName   string
}

// RecoveryPlan is computed before execution.
type RecoveryPlan struct {
	BaseBackup    *BaseBackup
	WALSegments   []WALSegment
	EstimatedTime time.Duration
}

// PITREngine orchestrates point-in-time recovery.
type PITREngine struct {
	archive  WALArchive
	backups  BaseBackupProvider
	restorer DBRestorer
	logger   *slog.Logger
}

func NewPITREngine(
	archive WALArchive,
	backups BaseBackupProvider,
	restorer DBRestorer,
	logger *slog.Logger,
) *PITREngine {
	return &PITREngine{
		archive:  archive,
		backups:  backups,
		restorer: restorer,
		logger:   logger.With("component", "pitr_engine"),
	}
}

// Plan computes the recovery plan without executing it.
func (e *PITREngine) Plan(ctx context.Context, cfg RecoveryConfig) (*RecoveryPlan, error) {
	e.logger.InfoContext(ctx, "computing PITR plan",
		"target_time", cfg.TargetTime,
		"service", cfg.ServiceName,
	)

	base, err := e.backups.LatestBefore(ctx, cfg.TargetTime)
	if err != nil {
		return nil, fmt.Errorf("find base backup before %s: %w", cfg.TargetTime, err)
	}

	e.logger.InfoContext(ctx, "selected base backup",
		"backup_id", base.ID,
		"taken_at", base.TakenAt,
		"end_lsn", base.EndLSN,
	)

	// Fetch WAL segments from base backup time to target time.
	segments, err := e.archive.ListSegments(ctx, base.TakenAt, cfg.TargetTime)
	if err != nil {
		return nil, fmt.Errorf("list WAL segments: %w", err)
	}

	e.logger.InfoContext(ctx, "WAL segments required",
		"count", len(segments),
		"first_lsn", func() string {
			if len(segments) > 0 {
				return segments[0].StartLSN
			}
			return "n/a"
		}(),
		"last_lsn", func() string {
			if len(segments) > 0 {
				return segments[len(segments)-1].EndLSN
			}
			return "n/a"
		}(),
	)

	// Estimate based on 10MB/s WAL replay throughput.
	var totalBytes int64
	for _, s := range segments {
		totalBytes += s.SizeBytes
	}
	estimatedSeconds := totalBytes / (10 * 1024 * 1024)
	if estimatedSeconds < 1 {
		estimatedSeconds = 1
	}

	return &RecoveryPlan{
		BaseBackup:    base,
		WALSegments:   segments,
		EstimatedTime: time.Duration(estimatedSeconds) * time.Second,
	}, nil
}

// Execute performs the PITR restore.
func (e *PITREngine) Execute(ctx context.Context, cfg RecoveryConfig) error {
	plan, err := e.Plan(ctx, cfg)
	if err != nil {
		return fmt.Errorf("plan PITR: %w", err)
	}

	e.logger.InfoContext(ctx, "executing PITR recovery",
		"base_backup_id", plan.BaseBackup.ID,
		"wal_segments", len(plan.WALSegments),
		"estimated_duration", plan.EstimatedTime,
		"target_time", cfg.TargetTime,
	)

	startTime := time.Now()

	// Step 1: Restore base backup.
	if err := e.restorer.RestoreBase(ctx, plan.BaseBackup, cfg.DataDirectory); err != nil {
		return fmt.Errorf("restore base backup: %w", err)
	}
	e.logger.InfoContext(ctx, "base backup restored")

	// Step 2: Apply WAL segments in order.
	for i, seg := range plan.WALSegments {
		select {
		case <-ctx.Done():
			return fmt.Errorf("PITR canceled after %d/%d segments: %w",
				i, len(plan.WALSegments), ctx.Err())
		default:
		}

		data, err := e.archive.FetchSegment(ctx, seg.SegmentName)
		if err != nil {
			return fmt.Errorf("fetch WAL segment %s: %w", seg.SegmentName, err)
		}

		// Write segment to temp location then apply.
		segPath := fmt.Sprintf("%s/pg_wal/%s", cfg.DataDirectory, seg.SegmentName)
		if err := writeFile(segPath, data); err != nil {
			return fmt.Errorf("write WAL segment %s: %w", seg.SegmentName, err)
		}

		if err := e.restorer.ApplyWAL(ctx, segPath); err != nil {
			return fmt.Errorf("apply WAL segment %s: %w", seg.SegmentName, err)
		}

		if (i+1)%10 == 0 {
			e.logger.InfoContext(ctx, "WAL replay progress",
				"applied", i+1,
				"total", len(plan.WALSegments),
				"elapsed", time.Since(startTime),
			)
		}
	}

	// Step 3: Promote to primary.
	if err := e.restorer.PromoteStandby(ctx); err != nil {
		return fmt.Errorf("promote standby after PITR: %w", err)
	}

	e.logger.InfoContext(ctx, "PITR complete",
		"total_duration", time.Since(startTime),
		"target_time", cfg.TargetTime,
	)

	return nil
}

func writeFile(path string, data []byte) error {
	import_os_create_stub := func() error {
		// In production: os.WriteFile(path, data, 0o600)
		_ = path
		_ = data
		return nil
	}
	return import_os_create_stub()
}
```

---

### Junior -> FAANG: Why PITR Is the Answer to "What Is Your RPO?"

PITR is the mechanism that makes granular RPO targets achievable. Without PITR, your recovery options are: restore from the last full backup (RPO equals time since last full backup), or restore from the last incremental (RPO equals time since last incremental). With PITR, your RPO is the time since the last WAL segment was archived, which for PostgreSQL continuous archiving can be as low as seconds.

The interview entry point: when asked "how would you design a backup system for a financial database with RPO of 5 minutes?", the correct answer involves continuous WAL archiving, not just hourly backups. Hourly incrementals give you RPO of up to 60 minutes. PITR with WAL archiving gives you RPO of up to the WAL segment archive interval, configurable down to seconds.

The key concept to understand before any PITR implementation interview is the LSN (Log Sequence Number). An LSN is a monotonically increasing position in the WAL. Every write to PostgreSQL advances the LSN. When you restore to a target LSN (or a target timestamp), you replay WAL segments until the LSN is reached and stop. The backup metadata should always record the LSN at backup time so restore can build the correct replay chain.

### Senior @ FAANG: PITR as a Platform Capability Requiring Operational Discipline

**WAL retention and the "lost segment" failure mode.** PITR relies on an unbroken chain of WAL segments from the base backup to the target recovery point. If any segment in the chain is missing or corrupted, the replay stops at that point and you can only recover to the segment before the gap. WAL segments must be archived to object storage with checksums verified and retention long enough to cover the maximum recovery window. A staff engineer configures archive retention at twice the RPO window as a safety margin: if RPO is 15 minutes, keep at least 30 minutes of WAL.

**PITR testing as a mandatory DR drill component.** PITR is notoriously difficult to test without performing an actual restore. A production DR discipline includes quarterly PITR drills: choose a target timestamp from 4 hours ago, restore the database to that timestamp in a separate environment, verify data integrity at that point, and measure the restore time. The restore time is your actual PITR RTO for that dataset size, not a theoretical estimate. If the restore takes 45 minutes and your RTO is 30 minutes, you have discovered a gap before an incident exposes it.

**Concurrent PITR and ongoing WAL generation.** When a PITR restore is in progress, the production database continues writing and archiving new WAL segments. The restore process must not pick up these new segments. It must stop at the target timestamp. PostgreSQL's `recovery_target_time` configuration handles this correctly by stopping replay at the specified timestamp. In an application-layer PITR implementation (like the one in this section), the replay loop must compare each WAL segment's timestamp against the target and stop accordingly, not replay indefinitely.

**Data validation after PITR restore.** Restoring to a point in time does not guarantee data consistency at the application layer. A transaction that updated three tables atomically may have only partially replayed if the target timestamp fell mid-transaction. PostgreSQL handles this by completing transactions that started before the target time and rolling back those that started after. Application-layer PITR must implement equivalent semantics for multi-entity transactions. After restore, run application-layer consistency checks (foreign key validation, balance sheet checks for financial data) before declaring the restore successful.
