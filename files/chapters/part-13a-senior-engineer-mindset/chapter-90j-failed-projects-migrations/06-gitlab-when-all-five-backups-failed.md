## 90J.5 GitLab: When All Five Backups Failed (2017)

### The Incident

On January 31, 2017, a GitLab engineer was troubleshooting database replication lag on GitLab.com. After
a long day of debugging, the engineer accidentally ran `rm -rf` on the primary PostgreSQL database directory
instead of the replica. Within seconds, 300 GB of production data began disappearing.

### The Timeline

**January 31, 2017: The Fatigue Factor**

The engineering team had been dealing with a spam attack that was causing database replication to fall behind.
A database engineer was attempting to resynchronize a PostgreSQL replica. After working on the issue for
hours, the engineer opened two terminal windows - one connected to the replica (db2) and one connected to
the primary (db1). In the wrong terminal, the engineer ran:

```
sudo rm -rf /var/opt/gitlab/postgresql/data/
```

The engineer realized the mistake within seconds when they saw the command was running against db1 (the
primary), not db2 (the replica). They hit Ctrl+C, but by then approximately 300 GB of data had already been
deleted.

**The Backup Discovery**

The team immediately attempted to restore from backups. What they discovered was devastating:

1. **LVM snapshots**: Not configured - this backup method had never been set up
2. **Regular PostgreSQL backups (pg_dump)**: The backup process had been silently failing because the
   PostgreSQL version had been upgraded, but the pg_dump version had not been updated to match
3. **Azure disk snapshots**: Only taken every 24 hours - the most recent snapshot was 6 hours old
4. **PostgreSQL replication**: The replica (db2) was the database they were trying to fix - it was
   already behind and had inconsistent data
5. **S3 backups**: The S3 bucket was empty - the backup process had never actually written data to it

Five separate backup strategies, and not a single one produced a usable backup. The only recovery option was
the 6-hour-old Azure disk snapshot, which meant losing 6 hours of production data.

**The Recovery**

GitLab restored from the Azure snapshot, losing approximately 6 hours of data including issues, merge requests,
comments, and CI/CD configuration. They live-streamed the entire recovery process on YouTube, setting a new
standard for incident transparency.

### Root Cause Analysis

1. **Human error under fatigue**: An exhausted engineer ran a destructive command in the wrong terminal
2. **Zero verified backups**: All five backup strategies were broken, and nobody knew
3. **No backup verification**: Backups were configured but never tested for restorability
4. **Version mismatch**: pg_dump version did not match PostgreSQL version, causing silent failures
5. **No deletion safeguards**: rm -rf ran without any confirmation on a production database server

### Go Code: Backup Verification System

The GitLab disaster teaches that backups you do not verify are not backups - they are hopes. Here is a
full backup verification system:

```go
package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

// -----------------------------------------------------------------------
// Backup verification framework
// -----------------------------------------------------------------------

// BackupStrategy represents a single backup mechanism (e.g., pg_dump,
// LVM snapshots, cloud snapshots, replication).
type BackupStrategy struct {
	Name        string
	Type        string // "logical", "physical", "snapshot", "replication"
	Schedule    string // cron expression
	Retention   time.Duration
	Verify      BackupVerifier
	LastSuccess time.Time
	LastFailure time.Time
	Consecutive int // consecutive successes or failures (negative = failures)
}

// BackupVerifier is the interface that each backup strategy must
// implement to verify its backups are actually restorable.
type BackupVerifier interface {
	// VerifyIntegrity checks that the backup file exists, is complete,
	// and has not been corrupted.
	VerifyIntegrity(ctx context.Context, backupPath string) (*IntegrityResult, error)

	// VerifyRestorability actually restores the backup to a temporary
	// location and validates the data.
	VerifyRestorability(ctx context.Context, backupPath string) (*RestoreResult, error)

	// VerifyRecency checks that the backup is within the expected age.
	VerifyRecency(ctx context.Context) (*RecencyResult, error)
}

// IntegrityResult captures the outcome of a backup integrity check.
type IntegrityResult struct {
	Valid      bool
	FileSize   int64
	Checksum   string
	CreatedAt  time.Time
	Errors     []string
}

// RestoreResult captures the outcome of a test restore.
type RestoreResult struct {
	Restorable    bool
	RowCount      int64
	TableCount    int
	RestoreDuration time.Duration
	DataSample    map[string]int64 // table -> row count
	Errors        []string
}

// RecencyResult captures whether the backup is fresh enough.
type RecencyResult struct {
	Fresh       bool
	BackupAge   time.Duration
	MaxAge      time.Duration
	LastBackup  time.Time
}

// VerificationReport is the aggregate report across all backup
// strategies.
type VerificationReport struct {
	Timestamp        time.Time                      `json:"timestamp"`
	Strategies       map[string]*StrategyReport     `json:"strategies"`
	OverallHealthy   bool                           `json:"overall_healthy"`
	RecoverableCount int                            `json:"recoverable_count"`
	TotalStrategies  int                            `json:"total_strategies"`
	Alerts           []string                       `json:"alerts"`
}

// StrategyReport captures the verification results for a single
// backup strategy.
type StrategyReport struct {
	Name             string          `json:"name"`
	IntegrityOK      bool            `json:"integrity_ok"`
	RestorableOK     bool            `json:"restorable_ok"`
	RecencyOK        bool            `json:"recency_ok"`
	IntegrityResult  *IntegrityResult `json:"integrity_result,omitempty"`
	RestoreResult    *RestoreResult   `json:"restore_result,omitempty"`
	RecencyResult    *RecencyResult   `json:"recency_result,omitempty"`
	Errors           []string         `json:"errors,omitempty"`
}

// -----------------------------------------------------------------------
// Backup monitor
// -----------------------------------------------------------------------

// Monitor continuously verifies all backup strategies and alerts
// when any strategy is unhealthy.
type Monitor struct {
	strategies []BackupStrategy
	alertFn    func(alert string)
	interval   time.Duration
	mu         sync.RWMutex
	lastReport *VerificationReport
}

// NewMonitor creates a backup monitor with the given strategies.
func NewMonitor(strategies []BackupStrategy, alertFn func(string), interval time.Duration) *Monitor {
	return &Monitor{
		strategies: strategies,
		alertFn:    alertFn,
		interval:   interval,
	}
}

// Start begins the continuous verification loop.
func (m *Monitor) Start(ctx context.Context) {
	// Run immediately on start.
	m.verify(ctx)

	ticker := time.NewTicker(m.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.verify(ctx)
		}
	}
}

// verify runs a complete verification cycle across all strategies.
func (m *Monitor) verify(ctx context.Context) {
	report := &VerificationReport{
		Timestamp:       time.Now(),
		Strategies:      make(map[string]*StrategyReport),
		TotalStrategies: len(m.strategies),
		OverallHealthy:  true,
	}

	var wg sync.WaitGroup
	var mu sync.Mutex

	for i := range m.strategies {
		strategy := &m.strategies[i]
		wg.Add(1)
		go func(s *BackupStrategy) {
			defer wg.Done()

			sr := &StrategyReport{Name: s.Name}

			// Check recency.
			if s.Verify != nil {
				recency, err := s.Verify.VerifyRecency(ctx)
				if err != nil {
					sr.Errors = append(sr.Errors, fmt.Sprintf("recency check failed: %v", err))
					sr.RecencyOK = false
				} else {
					sr.RecencyOK = recency.Fresh
					sr.RecencyResult = recency
					if !recency.Fresh {
						sr.Errors = append(sr.Errors,
							fmt.Sprintf("backup too old: %v (max: %v)",
								recency.BackupAge, recency.MaxAge))
					}
				}
			}

			mu.Lock()
			report.Strategies[s.Name] = sr
			if sr.RestorableOK {
				report.RecoverableCount++
			}
			if !sr.IntegrityOK || !sr.RestorableOK || !sr.RecencyOK {
				report.OverallHealthy = false
			}
			mu.Unlock()
		}(strategy)
	}

	wg.Wait()

	// Generate alerts.
	if report.RecoverableCount == 0 {
		alert := "CRITICAL: No recoverable backups available. All strategies failed verification."
		report.Alerts = append(report.Alerts, alert)
		if m.alertFn != nil {
			m.alertFn(alert)
		}
	} else if report.RecoverableCount < report.TotalStrategies {
		alert := fmt.Sprintf("WARNING: Only %d/%d backup strategies are healthy.",
			report.RecoverableCount, report.TotalStrategies)
		report.Alerts = append(report.Alerts, alert)
		if m.alertFn != nil {
			m.alertFn(alert)
		}
	}

	m.mu.Lock()
	m.lastReport = report
	m.mu.Unlock()

	report.Print()
}

// GetLastReport returns the most recent verification report.
func (m *Monitor) GetLastReport() *VerificationReport {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.lastReport
}

// Print outputs a human-readable summary of the verification report.
func (r *VerificationReport) Print() {
	fmt.Println("\n========================================")
	fmt.Println("  BACKUP VERIFICATION REPORT")
	fmt.Printf("  Time: %s\n", r.Timestamp.Format(time.RFC3339))
	fmt.Println("========================================")

	for name, sr := range r.Strategies {
		status := "HEALTHY"
		if !sr.IntegrityOK || !sr.RestorableOK || !sr.RecencyOK {
			status = "UNHEALTHY"
		}
		fmt.Printf("  [%s] %s\n", status, name)
		fmt.Printf("    Integrity:    %v\n", boolStatus(sr.IntegrityOK))
		fmt.Printf("    Restorable:   %v\n", boolStatus(sr.RestorableOK))
		fmt.Printf("    Recency:      %v\n", boolStatus(sr.RecencyOK))
		for _, e := range sr.Errors {
			fmt.Printf("    ERROR: %s\n", e)
		}
	}

	fmt.Println("----------------------------------------")
	fmt.Printf("  Recoverable: %d/%d strategies\n",
		r.RecoverableCount, r.TotalStrategies)

	if r.OverallHealthy {
		fmt.Println("  STATUS: ALL BACKUPS HEALTHY")
	} else {
		fmt.Println("  STATUS: BACKUP HEALTH DEGRADED")
	}
	fmt.Println("========================================")
}

func boolStatus(b bool) string {
	if b {
		return "OK"
	}
	return "FAILED"
}

// -----------------------------------------------------------------------
// PostgreSQL-specific backup verifier
// -----------------------------------------------------------------------

// PostgresVerifier implements BackupVerifier for PostgreSQL pg_dump
// backups.
type PostgresVerifier struct {
	BackupDir     string
	MaxAge        time.Duration
	ExpectedTables int
	MinRowCount   int64
}

// VerifyIntegrity checks that the backup file exists and is valid.
func (pv *PostgresVerifier) VerifyIntegrity(
	ctx context.Context,
	backupPath string,
) (*IntegrityResult, error) {
	result := &IntegrityResult{Valid: true}

	info, err := os.Stat(backupPath)
	if err != nil {
		return &IntegrityResult{
			Valid:  false,
			Errors: []string{fmt.Sprintf("backup file not found: %v", err)},
		}, nil
	}

	result.FileSize = info.Size()
	result.CreatedAt = info.ModTime()

	if info.Size() == 0 {
		result.Valid = false
		result.Errors = append(result.Errors, "backup file is empty")
		return result, nil
	}

	// Compute checksum.
	f, err := os.Open(backupPath)
	if err != nil {
		return nil, fmt.Errorf("opening backup file: %w", err)
	}
	defer f.Close()

	hasher := sha256.New()
	if _, err := io.Copy(hasher, f); err != nil {
		return nil, fmt.Errorf("computing checksum: %w", err)
	}
	result.Checksum = hex.EncodeToString(hasher.Sum(nil))

	return result, nil
}

// VerifyRestorability attempts a test restore to a temporary database.
func (pv *PostgresVerifier) VerifyRestorability(
	ctx context.Context,
	backupPath string,
) (*RestoreResult, error) {
	// In production, this would:
	// 1. Create a temporary PostgreSQL instance
	// 2. Restore the backup to it
	// 3. Run validation queries
	// 4. Tear down the temporary instance
	//
	// This is a structural example showing the validation logic.

	result := &RestoreResult{
		Restorable: true,
		DataSample: make(map[string]int64),
	}

	start := time.Now()

	// Simulated validation - in production, these would be real SQL queries.
	fmt.Printf("[POSTGRES VERIFIER] Restoring %s to temporary instance...\n", backupPath)
	fmt.Printf("[POSTGRES VERIFIER] Validating table count...\n")
	fmt.Printf("[POSTGRES VERIFIER] Validating row counts...\n")
	fmt.Printf("[POSTGRES VERIFIER] Validating referential integrity...\n")

	result.RestoreDuration = time.Since(start)
	return result, nil
}

// VerifyRecency checks that the most recent backup is fresh enough.
func (pv *PostgresVerifier) VerifyRecency(
	ctx context.Context,
) (*RecencyResult, error) {
	// Find the most recent backup file in the backup directory.
	entries, err := os.ReadDir(pv.BackupDir)
	if err != nil {
		return nil, fmt.Errorf("reading backup directory: %w", err)
	}

	var latestTime time.Time
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if info.ModTime().After(latestTime) {
			latestTime = info.ModTime()
		}
	}

	if latestTime.IsZero() {
		return &RecencyResult{
			Fresh:      false,
			MaxAge:     pv.MaxAge,
		}, nil
	}

	age := time.Since(latestTime)
	return &RecencyResult{
		Fresh:      age <= pv.MaxAge,
		BackupAge:  age,
		MaxAge:     pv.MaxAge,
		LastBackup: latestTime,
	}, nil
}

// SaveJSON writes the report to a file.
func (r *VerificationReport) SaveJSON(path string) error {
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}
```

### Engineering Lessons

1. **Backups are not backups until they are tested** - schedule regular restore tests.
2. **Multiple backup strategies must be independently verified** - if one fails silently, the others must work.
3. **Fatigue kills** - never let an exhausted engineer run destructive commands on production.
4. **Production servers need deletion safeguards** - rm -rf should require confirmation, or better yet,
   should be aliased to a safe-delete command.
5. **Transparency builds trust** - GitLab's live-streamed recovery set a standard for incident communication.
6. **Monitor your monitoring** - if backup jobs fail silently, you have no backups.

---

### Junior → FAANG: Backup Verification and Production Safety as Interview Topics

GitLab is the interview answer to "how do you ensure your backups work?" The answer is not "we run backup jobs every six hours." The answer is "we run restore tests every week against a separate environment using the actual backup artifacts, and we treat a failing restore test as a P1 incident." GitLab had five backup strategies that had all failed silently before the incident. No strategy counts as a backup until it has been tested as a restore. A second interview point is production server safety: destructive commands on production servers should require explicit confirmation, and ideally should be aliased to a safe wrapper that prevents accidental execution. The combination of an exhausted engineer and a production terminal with no safeguards is a scenario that appears in GitLab's postmortem and in countless unreported incidents. For interviews, the GitLab incident demonstrates that backup reliability is a measurement and testing problem, not a configuration problem.

### Senior @ FAANG: Backup Verification as an Automated, SLA-Governed Platform Capability

At L6, the GitLab incident reframes backup from an infrastructure configuration into a continuously verified platform capability. The platform standard requires three properties. First, every backup must produce a cryptographic manifest of the backed-up data that allows verification without a full restore. A backup job that completes without error but produces a corrupt or incomplete artifact is indistinguishable from a missing backup until restore time. The manifest, verified against the source data at backup creation time, catches corruption immediately. Second, restore tests must be automated and scheduled on a regular cadence: daily for critical data, weekly for non-critical data. The restore test must exercise the full recovery path, including the DNS change, connection string update, and application startup against the restored database. A restore test that only verifies the backup artifact is readable is not a restore test. Third, backup system health must be a first-class monitoring concern, visible in the same dashboard as application health, with alerts that page on-call when restore tests fail. At GitLab, backup jobs were failing silently for months before the incident. Silent failure is not possible when backup health is a monitored SLA. For an organization running dozens of production databases, this means a backup health dashboard that shows the last successful restore test date for each database and the restore time, and an alerting policy that escalates any database that has not had a successful restore test within the SLA window. The staff engineer owns this as a platform capability, not as an individual team responsibility.

---
