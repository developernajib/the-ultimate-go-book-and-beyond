## 36.7 Complete Migration Management System

Let's build a production-ready migration management system that handles versioning, locking, validation, and rollback with detailed logging.

### Project Structure

The directory layout below reflects a clean separation of concerns: commands and entry points live under `cmd/`, reusable packages under `internal/`, and public APIs under `pkg/`. This structure scales from a small tool to a production codebase by keeping each package focused on a single responsibility.

```
migration-system/
├── cmd/
│   ├── migrate/
│   │   └── main.go              # CLI application
│   └── server/
│       └── main.go              # Server with migrations
├── internal/
│   └── migrations/
│       ├── manager.go           # Migration manager
│       ├── executor.go          # Migration executor
│       ├── validator.go         # Schema validator
│       ├── lock.go              # Distributed locking
│       └── reporter.go          # Status reporting
├── migrations/
│   ├── 000001_create_users.up.sql
│   ├── 000001_create_users.down.sql
│   ├── 000002_create_posts.up.sql
│   ├── 000002_create_posts.down.sql
│   └── embed.go
├── Makefile
├── Dockerfile
└── docker-compose.yml
```

### Migration Manager (internal/migrations/manager.go)

The migration manager is the core orchestrator. It loads migration files from an embedded filesystem, compares them against the `schema_migrations` tracking table to find pending migrations, acquires a distributed lock to prevent concurrent runs, validates each migration for dangerous patterns, and applies them inside a transaction with dirty-state tracking for crash recovery.

```go
package migrations

import (
    "context"
    "database/sql"
    "embed"
    "fmt"
    "io/fs"
    "log/slog"
    "sort"
    "strconv"
    "strings"
    "time"
)

//go:embed *.sql
var MigrationsFS embed.FS

// MigrationDirection indicates the direction of migration
type MigrationDirection string

const (
    DirectionUp   MigrationDirection = "up"
    DirectionDown MigrationDirection = "down"
)

// Migration represents a database migration
type Migration struct {
    Version     int64
    Name        string
    Direction   MigrationDirection
    Content     string
    AppliedAt   *time.Time
    ExecutionMs int64
}

// MigrationStatus represents the status of a migration
type MigrationStatus struct {
    Version     int64
    Name        string
    Applied     bool
    AppliedAt   *time.Time
    ExecutionMs int64
    Dirty       bool
}

// MigrationResult represents the result of running migrations
type MigrationResult struct {
    Applied    []Migration
    Skipped    []Migration
    Errors     []MigrationError
    StartTime  time.Time
    EndTime    time.Time
    TotalCount int
}

// MigrationError represents an error during migration
type MigrationError struct {
    Migration Migration
    Error     error
}

// Config holds migration configuration
type Config struct {
    TableName          string
    LockTimeout        time.Duration
    StatementTimeout   time.Duration
    MaxRetries         int
    RetryInterval      time.Duration
    DryRun             bool
    AllowDirty         bool
    ValidateBeforeRun  bool
    CreateSchemaTable  bool
}

// DefaultConfig returns default migration configuration
func DefaultConfig() Config {
    return Config{
        TableName:          "schema_migrations",
        LockTimeout:        30 * time.Second,
        StatementTimeout:   5 * time.Minute,
        MaxRetries:         3,
        RetryInterval:      time.Second,
        DryRun:             false,
        AllowDirty:         false,
        ValidateBeforeRun:  true,
        CreateSchemaTable:  true,
    }
}

// Manager handles database migrations
type Manager struct {
    db        *sql.DB
    config    Config
    logger    *slog.Logger
    lock      *DistributedLock
    validator *Validator
    reporter  *Reporter
}

// NewManager creates a new migration manager
func NewManager(db *sql.DB, config Config, logger *slog.Logger) (*Manager, error) {
    if logger == nil {
        logger = slog.Default()
    }

    m := &Manager{
        db:        db,
        config:    config,
        logger:    logger,
        lock:      NewDistributedLock(db, config.LockTimeout),
        validator: NewValidator(db),
        reporter:  NewReporter(db, config.TableName, logger),
    }

    if config.CreateSchemaTable {
        if err := m.ensureSchemaTable(context.Background()); err != nil {
            return nil, fmt.Errorf("failed to create schema table: %w", err)
        }
    }

    return m, nil
}

// ensureSchemaTable creates the migrations tracking table
func (m *Manager) ensureSchemaTable(ctx context.Context) error {
    query := fmt.Sprintf(`
        CREATE TABLE IF NOT EXISTS %s (
            version BIGINT PRIMARY KEY,
            name VARCHAR(255) NOT NULL,
            applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            execution_ms BIGINT NOT NULL DEFAULT 0,
            dirty BOOLEAN NOT NULL DEFAULT false,
            checksum VARCHAR(64)
        )
    `, m.config.TableName)

    _, err := m.db.ExecContext(ctx, query)
    return err
}

// LoadMigrations loads migrations from embedded filesystem
func (m *Manager) LoadMigrations() ([]Migration, error) {
    entries, err := fs.ReadDir(MigrationsFS, ".")
    if err != nil {
        return nil, fmt.Errorf("failed to read migrations dir: %w", err)
    }

    migrations := make(map[int64]*struct {
        up   *Migration
        down *Migration
    })

    for _, entry := range entries {
        if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
            continue
        }

        migration, err := m.parseMigrationFile(entry.Name())
        if err != nil {
            return nil, fmt.Errorf("failed to parse %s: %w", entry.Name(), err)
        }

        if migrations[migration.Version] == nil {
            migrations[migration.Version] = &struct {
                up   *Migration
                down *Migration
            }{}
        }

        if migration.Direction == DirectionUp {
            migrations[migration.Version].up = migration
        } else {
            migrations[migration.Version].down = migration
        }
    }

    // Convert to slice and sort
    var result []Migration
    for _, m := range migrations {
        if m.up != nil {
            result = append(result, *m.up)
        }
    }

    sort.Slice(result, func(i, j int) bool {
        return result[i].Version < result[j].Version
    })

    return result, nil
}

// parseMigrationFile parses a migration filename
func (m *Manager) parseMigrationFile(filename string) (*Migration, error) {
    // Expected format: 000001_name.up.sql or 000001_name.down.sql
    parts := strings.Split(filename, "_")
    if len(parts) < 2 {
        return nil, fmt.Errorf("invalid migration filename: %s", filename)
    }

    version, err := strconv.ParseInt(parts[0], 10, 64)
    if err != nil {
        return nil, fmt.Errorf("invalid version number: %s", parts[0])
    }

    nameParts := strings.Split(strings.Join(parts[1:], "_"), ".")
    name := nameParts[0]

    var direction MigrationDirection
    if strings.Contains(filename, ".up.sql") {
        direction = DirectionUp
    } else if strings.Contains(filename, ".down.sql") {
        direction = DirectionDown
    } else {
        return nil, fmt.Errorf("invalid migration direction: %s", filename)
    }

    content, err := fs.ReadFile(MigrationsFS, filename)
    if err != nil {
        return nil, fmt.Errorf("failed to read migration: %w", err)
    }

    return &Migration{
        Version:   version,
        Name:      name,
        Direction: direction,
        Content:   string(content),
    }, nil
}

// Up runs all pending migrations
func (m *Manager) Up(ctx context.Context) (*MigrationResult, error) {
    result := &MigrationResult{StartTime: time.Now()}
    defer func() { result.EndTime = time.Now() }()

    // Acquire lock
    if err := m.lock.Acquire(ctx); err != nil {
        return nil, fmt.Errorf("failed to acquire lock: %w", err)
    }
    defer m.lock.Release(ctx)

    // Check for dirty state
    if !m.config.AllowDirty {
        dirty, err := m.isDirty(ctx)
        if err != nil {
            return nil, fmt.Errorf("failed to check dirty state: %w", err)
        }
        if dirty {
            return nil, fmt.Errorf("database is in dirty state; fix manually or set AllowDirty")
        }
    }

    // Load migrations
    migrations, err := m.LoadMigrations()
    if err != nil {
        return nil, err
    }

    // Get current version
    currentVersion, err := m.CurrentVersion(ctx)
    if err != nil {
        return nil, err
    }

    // Filter pending migrations
    pending := make([]Migration, 0)
    for _, mig := range migrations {
        if mig.Version > currentVersion {
            pending = append(pending, mig)
        } else {
            result.Skipped = append(result.Skipped, mig)
        }
    }

    result.TotalCount = len(pending)

    // Validate if enabled
    if m.config.ValidateBeforeRun {
        if err := m.validator.ValidateMigrations(ctx, pending); err != nil {
            return nil, fmt.Errorf("validation failed: %w", err)
        }
    }

    // Apply each migration
    for _, mig := range pending {
        m.logger.Info("applying migration",
            "version", mig.Version,
            "name", mig.Name,
            "dry_run", m.config.DryRun,
        )

        if m.config.DryRun {
            result.Applied = append(result.Applied, mig)
            continue
        }

        if err := m.applyMigration(ctx, mig); err != nil {
            result.Errors = append(result.Errors, MigrationError{
                Migration: mig,
                Error:     err,
            })
            return result, fmt.Errorf("migration %d failed: %w", mig.Version, err)
        }

        result.Applied = append(result.Applied, mig)
    }

    return result, nil
}

// Down rolls back the last n migrations
func (m *Manager) Down(ctx context.Context, steps int) (*MigrationResult, error) {
    result := &MigrationResult{StartTime: time.Now()}
    defer func() { result.EndTime = time.Now() }()

    // Acquire lock
    if err := m.lock.Acquire(ctx); err != nil {
        return nil, fmt.Errorf("failed to acquire lock: %w", err)
    }
    defer m.lock.Release(ctx)

    // Get applied migrations in reverse order
    applied, err := m.getAppliedMigrations(ctx)
    if err != nil {
        return nil, err
    }

    // Reverse order for rollback
    sort.Slice(applied, func(i, j int) bool {
        return applied[i].Version > applied[j].Version
    })

    // Limit to steps
    if steps > 0 && steps < len(applied) {
        applied = applied[:steps]
    }

    result.TotalCount = len(applied)

    // Load down migrations
    for _, mig := range applied {
        downMig, err := m.loadDownMigration(mig.Version)
        if err != nil {
            return nil, fmt.Errorf("no down migration for version %d: %w", mig.Version, err)
        }

        m.logger.Info("rolling back migration",
            "version", downMig.Version,
            "name", downMig.Name,
            "dry_run", m.config.DryRun,
        )

        if m.config.DryRun {
            result.Applied = append(result.Applied, *downMig)
            continue
        }

        if err := m.rollbackMigration(ctx, *downMig); err != nil {
            result.Errors = append(result.Errors, MigrationError{
                Migration: *downMig,
                Error:     err,
            })
            return result, fmt.Errorf("rollback %d failed: %w", downMig.Version, err)
        }

        result.Applied = append(result.Applied, *downMig)
    }

    return result, nil
}

// applyMigration applies a single migration with transaction
func (m *Manager) applyMigration(ctx context.Context, mig Migration) error {
    startTime := time.Now()

    // Set statement timeout
    _, err := m.db.ExecContext(ctx, fmt.Sprintf(
        "SET statement_timeout = '%dms'",
        m.config.StatementTimeout.Milliseconds(),
    ))
    if err != nil {
        return fmt.Errorf("failed to set timeout: %w", err)
    }

    // Mark as dirty before starting
    if err := m.markDirty(ctx, mig.Version, true); err != nil {
        return fmt.Errorf("failed to mark dirty: %w", err)
    }

    // Execute migration
    tx, err := m.db.BeginTx(ctx, nil)
    if err != nil {
        return fmt.Errorf("failed to begin transaction: %w", err)
    }
    defer tx.Rollback()

    if _, err := tx.ExecContext(ctx, mig.Content); err != nil {
        return fmt.Errorf("failed to execute migration: %w", err)
    }

    if err := tx.Commit(); err != nil {
        return fmt.Errorf("failed to commit: %w", err)
    }

    // Record successful migration
    executionMs := time.Since(startTime).Milliseconds()
    if err := m.recordMigration(ctx, mig, executionMs); err != nil {
        return fmt.Errorf("failed to record migration: %w", err)
    }

    m.logger.Info("migration applied",
        "version", mig.Version,
        "execution_ms", executionMs,
    )

    return nil
}

// rollbackMigration rolls back a single migration
func (m *Manager) rollbackMigration(ctx context.Context, mig Migration) error {
    tx, err := m.db.BeginTx(ctx, nil)
    if err != nil {
        return fmt.Errorf("failed to begin transaction: %w", err)
    }
    defer tx.Rollback()

    if _, err := tx.ExecContext(ctx, mig.Content); err != nil {
        return fmt.Errorf("failed to execute rollback: %w", err)
    }

    // Remove migration record
    _, err = tx.ExecContext(ctx, fmt.Sprintf(
        "DELETE FROM %s WHERE version = $1",
        m.config.TableName,
    ), mig.Version)
    if err != nil {
        return fmt.Errorf("failed to remove migration record: %w", err)
    }

    return tx.Commit()
}

// recordMigration records a successful migration
func (m *Manager) recordMigration(ctx context.Context, mig Migration, executionMs int64) error {
    query := fmt.Sprintf(`
        INSERT INTO %s (version, name, execution_ms, dirty)
        VALUES ($1, $2, $3, false)
        ON CONFLICT (version) DO UPDATE SET
            applied_at = NOW(),
            execution_ms = $3,
            dirty = false
    `, m.config.TableName)

    _, err := m.db.ExecContext(ctx, query, mig.Version, mig.Name, executionMs)
    return err
}

// markDirty marks a migration as dirty
func (m *Manager) markDirty(ctx context.Context, version int64, dirty bool) error {
    query := fmt.Sprintf(`
        INSERT INTO %s (version, name, dirty)
        VALUES ($1, 'pending', $2)
        ON CONFLICT (version) DO UPDATE SET dirty = $2
    `, m.config.TableName)

    _, err := m.db.ExecContext(ctx, query, version, dirty)
    return err
}

// isDirty checks if database is in dirty state
func (m *Manager) isDirty(ctx context.Context) (bool, error) {
    var dirty bool
    query := fmt.Sprintf(
        "SELECT EXISTS(SELECT 1 FROM %s WHERE dirty = true)",
        m.config.TableName,
    )
    err := m.db.QueryRowContext(ctx, query).Scan(&dirty)
    return dirty, err
}

// CurrentVersion returns the current migration version
func (m *Manager) CurrentVersion(ctx context.Context) (int64, error) {
    var version sql.NullInt64
    query := fmt.Sprintf(
        "SELECT MAX(version) FROM %s WHERE dirty = false",
        m.config.TableName,
    )
    err := m.db.QueryRowContext(ctx, query).Scan(&version)
    if err != nil {
        return 0, err
    }
    return version.Int64, nil
}

// getAppliedMigrations returns all applied migrations
func (m *Manager) getAppliedMigrations(ctx context.Context) ([]Migration, error) {
    query := fmt.Sprintf(`
        SELECT version, name, applied_at, execution_ms
        FROM %s
        WHERE dirty = false
        ORDER BY version ASC
    `, m.config.TableName)

    rows, err := m.db.QueryContext(ctx, query)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var migrations []Migration
    for rows.Next() {
        var mig Migration
        if err := rows.Scan(&mig.Version, &mig.Name, &mig.AppliedAt, &mig.ExecutionMs); err != nil {
            return nil, err
        }
        migrations = append(migrations, mig)
    }

    return migrations, rows.Err()
}

// loadDownMigration loads a down migration for a version
func (m *Manager) loadDownMigration(version int64) (*Migration, error) {
    entries, err := fs.ReadDir(MigrationsFS, ".")
    if err != nil {
        return nil, err
    }

    prefix := fmt.Sprintf("%06d", version)
    for _, entry := range entries {
        if strings.HasPrefix(entry.Name(), prefix) && strings.Contains(entry.Name(), ".down.") {
            return m.parseMigrationFile(entry.Name())
        }
    }

    return nil, fmt.Errorf("down migration not found for version %d", version)
}

// Status returns the status of all migrations
func (m *Manager) Status(ctx context.Context) ([]MigrationStatus, error) {
    return m.reporter.GetStatus(ctx)
}
```

### Distributed Lock (internal/migrations/lock.go)

In multi-instance deployments, two application pods might start simultaneously and both attempt to run migrations. PostgreSQL advisory locks prevent this race condition. The lock uses a fixed integer ID. `pg_try_advisory_lock` attempts a non-blocking acquire first, and if that fails (another instance holds it), falls back to a blocking acquire with a context timeout.

```go
package migrations

import (
    "context"
    "database/sql"
    "fmt"
    "time"
)

// DistributedLock provides advisory locking for migrations
type DistributedLock struct {
    db      *sql.DB
    timeout time.Duration
    lockID  int64
    held    bool
}

// NewDistributedLock creates a new distributed lock
func NewDistributedLock(db *sql.DB, timeout time.Duration) *DistributedLock {
    return &DistributedLock{
        db:      db,
        timeout: timeout,
        lockID:  7629384756, // Unique lock ID for migrations
    }
}

// Acquire acquires the migration lock
func (l *DistributedLock) Acquire(ctx context.Context) error {
    if l.held {
        return nil // Already holding the lock
    }

    ctx, cancel := context.WithTimeout(ctx, l.timeout)
    defer cancel()

    var acquired bool
    err := l.db.QueryRowContext(ctx,
        "SELECT pg_try_advisory_lock($1)",
        l.lockID,
    ).Scan(&acquired)

    if err != nil {
        return fmt.Errorf("failed to acquire lock: %w", err)
    }

    if !acquired {
        // Try blocking acquire with timeout
        err = l.db.QueryRowContext(ctx,
            "SELECT pg_advisory_lock($1)",
            l.lockID,
        ).Scan(&acquired)
        if err != nil {
            return fmt.Errorf("failed to acquire lock (blocking): %w", err)
        }
    }

    l.held = true
    return nil
}

// Release releases the migration lock
func (l *DistributedLock) Release(ctx context.Context) error {
    if !l.held {
        return nil
    }

    _, err := l.db.ExecContext(ctx,
        "SELECT pg_advisory_unlock($1)",
        l.lockID,
    )

    if err == nil {
        l.held = false
    }

    return err
}

// IsHeld returns whether the lock is currently held
func (l *DistributedLock) IsHeld() bool {
    return l.held
}
```

### Validator (internal/migrations/validator.go)

The validator scans migration SQL for dangerous patterns before execution. It flags `DROP TABLE`, non-concurrent index creation, direct `NOT NULL` additions, and other operations that commonly cause production outages. It also performs basic syntax checks (balanced parentheses, unclosed quotes) and verifies that down migrations reverse their corresponding up migrations by checking for matching `DROP TABLE` and `DROP COLUMN` statements.

```go
package migrations

import (
    "context"
    "database/sql"
    "fmt"
    "regexp"
    "strings"
)

// Validator validates migrations before execution
type Validator struct {
    db *sql.DB
}

// NewValidator creates a new validator
func NewValidator(db *sql.DB) *Validator {
    return &Validator{db: db}
}

// DangerousPatterns contains SQL patterns that require extra caution
var DangerousPatterns = []struct {
    Pattern     *regexp.Regexp
    Description string
    Severity    string
}{
    {
        Pattern:     regexp.MustCompile(`(?i)DROP\s+TABLE`),
        Description: "Dropping tables can cause data loss",
        Severity:    "warning",
    },
    {
        Pattern:     regexp.MustCompile(`(?i)TRUNCATE`),
        Description: "Truncating tables deletes all data",
        Severity:    "warning",
    },
    {
        Pattern:     regexp.MustCompile(`(?i)ALTER\s+TABLE.*DROP\s+COLUMN`),
        Description: "Dropping columns can cause data loss",
        Severity:    "warning",
    },
    {
        Pattern:     regexp.MustCompile(`(?i)ALTER\s+TABLE.*ALTER\s+COLUMN.*TYPE`),
        Description: "Changing column types may lock table and require full rewrite",
        Severity:    "warning",
    },
    {
        Pattern:     regexp.MustCompile(`(?i)CREATE\s+INDEX(?!\s+CONCURRENTLY)`),
        Description: "Non-concurrent index creation locks table for writes",
        Severity:    "info",
    },
    {
        Pattern:     regexp.MustCompile(`(?i)ALTER\s+TABLE.*ADD\s+CONSTRAINT.*FOREIGN\s+KEY`),
        Description: "Adding foreign key validates all existing rows (use NOT VALID + VALIDATE)",
        Severity:    "info",
    },
    {
        Pattern:     regexp.MustCompile(`(?i)ALTER\s+TABLE.*SET\s+NOT\s+NULL`),
        Description: "Adding NOT NULL requires full table scan",
        Severity:    "info",
    },
}

// ValidationResult represents the result of validating migrations
type ValidationResult struct {
    Valid    bool
    Warnings []ValidationIssue
    Errors   []ValidationIssue
}

// ValidationIssue represents a validation issue
type ValidationIssue struct {
    Migration   int64
    Description string
    Severity    string
    Line        int
}

// ValidateMigrations validates a list of migrations
func (v *Validator) ValidateMigrations(ctx context.Context, migrations []Migration) error {
    result := &ValidationResult{Valid: true}

    for _, mig := range migrations {
        issues := v.validateMigration(mig)
        for _, issue := range issues {
            if issue.Severity == "error" {
                result.Valid = false
                result.Errors = append(result.Errors, issue)
            } else {
                result.Warnings = append(result.Warnings, issue)
            }
        }
    }

    if !result.Valid {
        return fmt.Errorf("validation failed with %d errors", len(result.Errors))
    }

    return nil
}

// validateMigration validates a single migration
func (v *Validator) validateMigration(mig Migration) []ValidationIssue {
    var issues []ValidationIssue

    // Check for dangerous patterns
    for _, pattern := range DangerousPatterns {
        if pattern.Pattern.MatchString(mig.Content) {
            issues = append(issues, ValidationIssue{
                Migration:   mig.Version,
                Description: pattern.Description,
                Severity:    pattern.Severity,
            })
        }
    }

    // Check for syntax (basic validation)
    if err := v.validateSyntax(mig.Content); err != nil {
        issues = append(issues, ValidationIssue{
            Migration:   mig.Version,
            Description: fmt.Sprintf("Syntax error: %v", err),
            Severity:    "error",
        })
    }

    // Check for missing transaction safety
    if !v.hasTransactionSafety(mig.Content) && v.needsTransaction(mig.Content) {
        issues = append(issues, ValidationIssue{
            Migration:   mig.Version,
            Description: "Migration may benefit from explicit transaction handling",
            Severity:    "info",
        })
    }

    return issues
}

// validateSyntax performs basic SQL syntax validation
func (v *Validator) validateSyntax(sql string) error {
    // Check for balanced parentheses
    open := strings.Count(sql, "(")
    close := strings.Count(sql, ")")
    if open != close {
        return fmt.Errorf("unbalanced parentheses: %d open, %d close", open, close)
    }

    // Check for unclosed quotes
    singleQuotes := strings.Count(sql, "'")
    if singleQuotes%2 != 0 {
        return fmt.Errorf("unclosed single quote")
    }

    return nil
}

// hasTransactionSafety checks if migration has transaction markers
func (v *Validator) hasTransactionSafety(sql string) bool {
    return strings.Contains(strings.ToUpper(sql), "BEGIN") ||
        strings.Contains(strings.ToUpper(sql), "TRANSACTION")
}

// needsTransaction checks if migration should use transactions
func (v *Validator) needsTransaction(sql string) bool {
    // Concurrent operations cannot use transactions
    if strings.Contains(strings.ToUpper(sql), "CONCURRENTLY") {
        return false
    }
    return true
}

// ValidateDownMigration validates that down migration properly reverses up
func (v *Validator) ValidateDownMigration(up, down Migration) []ValidationIssue {
    var issues []ValidationIssue

    // Check CREATE TABLE has DROP TABLE
    createTables := regexp.MustCompile(`(?i)CREATE\s+TABLE\s+(\w+)`).FindAllStringSubmatch(up.Content, -1)
    for _, match := range createTables {
        tableName := match[1]
        dropPattern := fmt.Sprintf(`(?i)DROP\s+TABLE.*%s`, tableName)
        if !regexp.MustCompile(dropPattern).MatchString(down.Content) {
            issues = append(issues, ValidationIssue{
                Migration:   up.Version,
                Description: fmt.Sprintf("Down migration doesn't drop table %s", tableName),
                Severity:    "warning",
            })
        }
    }

    // Check ADD COLUMN has DROP COLUMN
    addColumns := regexp.MustCompile(`(?i)ADD\s+COLUMN\s+(\w+)`).FindAllStringSubmatch(up.Content, -1)
    for _, match := range addColumns {
        columnName := match[1]
        dropPattern := fmt.Sprintf(`(?i)DROP\s+COLUMN.*%s`, columnName)
        if !regexp.MustCompile(dropPattern).MatchString(down.Content) {
            issues = append(issues, ValidationIssue{
                Migration:   up.Version,
                Description: fmt.Sprintf("Down migration doesn't drop column %s", columnName),
                Severity:    "warning",
            })
        }
    }

    return issues
}
```

### Reporter (internal/migrations/reporter.go)

The reporter queries the `schema_migrations` table and formats the results as a human-readable status table or a summary with counts. This is what backs the `status` CLI command and is useful for dashboards and deployment checks.

```go
package migrations

import (
    "context"
    "database/sql"
    "fmt"
    "log/slog"
    "strings"
    "text/tabwriter"
)

// Reporter generates migration status reports
type Reporter struct {
    db        *sql.DB
    tableName string
    logger    *slog.Logger
}

// NewReporter creates a new reporter
func NewReporter(db *sql.DB, tableName string, logger *slog.Logger) *Reporter {
    return &Reporter{
        db:        db,
        tableName: tableName,
        logger:    logger,
    }
}

// GetStatus returns the status of all migrations
func (r *Reporter) GetStatus(ctx context.Context) ([]MigrationStatus, error) {
    query := fmt.Sprintf(`
        SELECT version, name, applied_at, execution_ms, dirty
        FROM %s
        ORDER BY version ASC
    `, r.tableName)

    rows, err := r.db.QueryContext(ctx, query)
    if err != nil {
        return nil, err
    }
    defer rows.Close()

    var statuses []MigrationStatus
    for rows.Next() {
        var s MigrationStatus
        if err := rows.Scan(&s.Version, &s.Name, &s.AppliedAt, &s.ExecutionMs, &s.Dirty); err != nil {
            return nil, err
        }
        s.Applied = true
        statuses = append(statuses, s)
    }

    return statuses, rows.Err()
}

// PrintStatus prints migration status as a formatted table
func (r *Reporter) PrintStatus(ctx context.Context, w *strings.Builder) error {
    statuses, err := r.GetStatus(ctx)
    if err != nil {
        return err
    }

    tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
    fmt.Fprintln(tw, "VERSION\tNAME\tAPPLIED\tEXECUTION\tDIRTY")
    fmt.Fprintln(tw, "-------\t----\t-------\t---------\t-----")

    for _, s := range statuses {
        appliedAt := "pending"
        if s.AppliedAt != nil {
            appliedAt = s.AppliedAt.Format("2006-01-02 15:04:05")
        }
        fmt.Fprintf(tw, "%d\t%s\t%s\t%dms\t%v\n",
            s.Version, s.Name, appliedAt, s.ExecutionMs, s.Dirty)
    }

    return tw.Flush()
}

// GetSummary returns a summary of migration status
func (r *Reporter) GetSummary(ctx context.Context) (*MigrationSummary, error) {
    var summary MigrationSummary

    // Count total migrations
    query := fmt.Sprintf("SELECT COUNT(*) FROM %s", r.tableName)
    if err := r.db.QueryRowContext(ctx, query).Scan(&summary.Total); err != nil {
        return nil, err
    }

    // Count dirty migrations
    query = fmt.Sprintf("SELECT COUNT(*) FROM %s WHERE dirty = true", r.tableName)
    if err := r.db.QueryRowContext(ctx, query).Scan(&summary.Dirty); err != nil {
        return nil, err
    }

    // Get current version
    query = fmt.Sprintf("SELECT COALESCE(MAX(version), 0) FROM %s WHERE dirty = false", r.tableName)
    if err := r.db.QueryRowContext(ctx, query).Scan(&summary.CurrentVersion); err != nil {
        return nil, err
    }

    // Get total execution time
    query = fmt.Sprintf("SELECT COALESCE(SUM(execution_ms), 0) FROM %s", r.tableName)
    if err := r.db.QueryRowContext(ctx, query).Scan(&summary.TotalExecutionMs); err != nil {
        return nil, err
    }

    summary.Applied = summary.Total - summary.Dirty

    return &summary, nil
}

// MigrationSummary represents a summary of migrations
type MigrationSummary struct {
    Total            int
    Applied          int
    Pending          int
    Dirty            int
    CurrentVersion   int64
    TotalExecutionMs int64
}
```

### CLI Application (cmd/migrate/main.go)

The CLI ties everything together. It parses flags for the database URL, command (`up`, `down`, `status`, `version`), dry-run mode, and timeouts, then delegates to the `Manager`. The `--dry-run` flag prints the SQL that would execute without applying it, and `--force` allows running migrations even when the database is in a dirty state.

```go
package main

import (
    "context"
    "database/sql"
    "flag"
    "fmt"
    "log/slog"
    "os"
    "strings"
    "time"

    "migration-system/internal/migrations"

    _ "github.com/lib/pq"
)

func main() {
    // Parse flags
    var (
        databaseURL = flag.String("database", os.Getenv("DATABASE_URL"), "Database URL")
        command     = flag.String("cmd", "up", "Command: up, down, status, version")
        steps       = flag.Int("steps", 0, "Number of migrations to apply/rollback")
        dryRun      = flag.Bool("dry-run", false, "Show migrations without applying")
        force       = flag.Bool("force", false, "Force migration even if dirty")
        verbose     = flag.Bool("verbose", false, "Verbose output")
        timeout     = flag.Duration("timeout", 5*time.Minute, "Migration timeout")
    )
    flag.Parse()

    // Setup logger
    logLevel := slog.LevelInfo
    if *verbose {
        logLevel = slog.LevelDebug
    }
    logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
        Level: logLevel,
    }))

    // Connect to database
    db, err := sql.Open("postgres", *databaseURL)
    if err != nil {
        logger.Error("failed to connect to database", "error", err)
        os.Exit(1)
    }
    defer db.Close()

    // Configure migrations
    config := migrations.DefaultConfig()
    config.DryRun = *dryRun
    config.AllowDirty = *force
    config.StatementTimeout = *timeout

    // Create manager
    manager, err := migrations.NewManager(db, config, logger)
    if err != nil {
        logger.Error("failed to create migration manager", "error", err)
        os.Exit(1)
    }

    ctx := context.Background()

    // Execute command
    switch *command {
    case "up":
        result, err := manager.Up(ctx)
        if err != nil {
            logger.Error("migration failed", "error", err)
            os.Exit(1)
        }
        printResult(result, logger)

    case "down":
        if *steps == 0 {
            *steps = 1
        }
        result, err := manager.Down(ctx, *steps)
        if err != nil {
            logger.Error("rollback failed", "error", err)
            os.Exit(1)
        }
        printResult(result, logger)

    case "status":
        statuses, err := manager.Status(ctx)
        if err != nil {
            logger.Error("failed to get status", "error", err)
            os.Exit(1)
        }
        printStatus(statuses)

    case "version":
        version, err := manager.CurrentVersion(ctx)
        if err != nil {
            logger.Error("failed to get version", "error", err)
            os.Exit(1)
        }
        fmt.Printf("Current version: %d\n", version)

    default:
        logger.Error("unknown command", "command", *command)
        os.Exit(1)
    }
}

func printResult(result *migrations.MigrationResult, logger *slog.Logger) {
    duration := result.EndTime.Sub(result.StartTime)

    fmt.Println("\n=== Migration Result ===")
    fmt.Printf("Applied: %d\n", len(result.Applied))
    fmt.Printf("Skipped: %d\n", len(result.Skipped))
    fmt.Printf("Errors:  %d\n", len(result.Errors))
    fmt.Printf("Duration: %v\n", duration)

    if len(result.Applied) > 0 {
        fmt.Println("\nApplied migrations:")
        for _, m := range result.Applied {
            fmt.Printf("  - %06d_%s\n", m.Version, m.Name)
        }
    }

    if len(result.Errors) > 0 {
        fmt.Println("\nErrors:")
        for _, e := range result.Errors {
            fmt.Printf("  - %06d: %v\n", e.Migration.Version, e.Error)
        }
    }
}

func printStatus(statuses []migrations.MigrationStatus) {
    fmt.Println("\n=== Migration Status ===")
    fmt.Printf("%-10s %-30s %-20s %-10s %s\n", "VERSION", "NAME", "APPLIED", "TIME", "DIRTY")
    fmt.Println(strings.Repeat("-", 80))

    for _, s := range statuses {
        appliedAt := "pending"
        if s.AppliedAt != nil {
            appliedAt = s.AppliedAt.Format("2006-01-02 15:04:05")
        }
        fmt.Printf("%-10d %-30s %-20s %-10d %v\n",
            s.Version, s.Name, appliedAt, s.ExecutionMs, s.Dirty)
    }
}
```

### Makefile

The build configuration automates compilation, testing, and code generation steps. Encoding these commands in a Makefile or shell script ensures that all contributors run identical commands and that CI uses the same process as local development.

```makefile
.PHONY: all build test migrate migrate-down migrate-status

# Variables
BINARY_NAME=migrate
DATABASE_URL?=postgres://postgres:password@localhost:5432/app?sslmode=disable
MIGRATIONS_DIR=./migrations

# Build
build:
	go build -o bin/$(BINARY_NAME) ./cmd/migrate

# Test
test:
	go test -v ./...

test-integration:
	docker-compose up -d postgres
	sleep 3
	DATABASE_URL=$(DATABASE_URL) go test -v -tags=integration ./...
	docker-compose down

# Migration commands
migrate-up:
	go run ./cmd/migrate -database $(DATABASE_URL) -cmd up

migrate-down:
	go run ./cmd/migrate -database $(DATABASE_URL) -cmd down -steps 1

migrate-status:
	go run ./cmd/migrate -database $(DATABASE_URL) -cmd status

migrate-version:
	go run ./cmd/migrate -database $(DATABASE_URL) -cmd version

migrate-dry-run:
	go run ./cmd/migrate -database $(DATABASE_URL) -cmd up -dry-run

# Create new migration
migrate-create:
	@read -p "Migration name: " name; \
	timestamp=$$(date +%Y%m%d%H%M%S); \
	touch migrations/$${timestamp}_$${name}.up.sql; \
	touch migrations/$${timestamp}_$${name}.down.sql; \
	echo "Created migrations/$${timestamp}_$${name}.up.sql"; \
	echo "Created migrations/$${timestamp}_$${name}.down.sql"

# Docker
docker-build:
	docker build -t migration-system .

docker-run:
	docker run --rm \
		-e DATABASE_URL=$(DATABASE_URL) \
		migration-system -cmd up

# Development
dev-db:
	docker-compose up -d postgres redis

dev-db-down:
	docker-compose down -v

# Linting
lint:
	golangci-lint run ./...

# Clean
clean:
	rm -rf bin/
	go clean -testcache
```

### Dockerfile

The multi-stage Dockerfile separates the build environment from the runtime image. The first stage compiles the Go binary with all build tools available. The second stage copies only the compiled binary into a minimal base image, reducing the final image size and attack surface.

```dockerfile
# Build stage
FROM golang:1.27.1-alpine AS builder

RUN apk add --no-cache git ca-certificates

WORKDIR /app

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source
COPY . .

# Build
RUN CGO_ENABLED=0 GOOS=linux go build -o /migrate ./cmd/migrate

# Runtime stage
FROM alpine:3.19

RUN apk add --no-cache ca-certificates tzdata

COPY --from=builder /migrate /usr/local/bin/migrate

# Copy migrations
COPY migrations /migrations

ENTRYPOINT ["migrate"]
CMD ["-cmd", "status"]
```

### docker-compose.yml

The Compose file defines a PostgreSQL service with a health check, plus two migration service variants: one for applying migrations (`migrate`) and one for checking status (`migrate-status`). The `depends_on` with `condition: service_healthy` ensures migrations only run after PostgreSQL is ready to accept connections.

```yaml
version: '3.8'

services:
  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
      POSTGRES_DB: app
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  migrate:
    build: .
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://postgres:password@postgres:5432/app?sslmode=disable
    command: ["-cmd", "up", "-verbose"]

  migrate-status:
    build: .
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://postgres:password@postgres:5432/app?sslmode=disable
    command: ["-cmd", "status"]

volumes:
  postgres_data:
```

### Junior → FAANG: prerequisite gaps and first-job context

The mental model to build before reading this code. A migration system is three things stacked on top of a SQL driver. A file loader that reads numbered SQL files off disk or an embed.FS. A ledger (the `schema_migrations` table) that records which of those files have been run. An executor that reads both, computes the diff, and runs the missing ones under a lock. Everything else in this 1300-line system is operational hardening around those three core pieces. If that model is clear, the code reads like prose. If it is not clear, re-read `Manager.Up` three times with this framing in mind before touching the rest.

Worked example for your first migration tool evaluation. Your team is deciding between golang-migrate, goose, atlas, and rolling your own. The honest answer for 95 percent of teams is "use golang-migrate or goose and move on." The cases where you build your own are when you need something the libraries do not offer. Distributed locking that coordinates with Kubernetes leader election. A validator that rejects migrations lacking an explicit rollback window. Integration with a company-specific secrets manager or audit log. The code in this section is pedagogical, it shows you how the guts work so you can evaluate whether an off-the-shelf tool is sufficient or where it falls short for your environment. Do not copy this code into production without first checking whether an existing library already solves your actual problem.

Interview entry-point. A common system-design question is "design a database migration system." The grading rubric usually covers four areas. Ordering guarantees (how do you ensure migration 5 runs before migration 6, and how do you handle branching if two developers each write a migration 7 on different branches). Concurrency safety (how do you prevent two app instances from running migrations at the same time, and `pg_advisory_lock` is the standard answer). Failure recovery (the "dirty" flag pattern in this section, where a migration that crashed halfway is marked so the next run refuses to proceed blindly). Rollback semantics (what does `down` actually do, and why is it often unsafe). If you can whiteboard the `schema_migrations` table, explain the advisory lock, and articulate why dirty-state tracking matters, you have cleared the bar.

### Senior @ FAANG: hardening, multi-region, and the operator-based evolution

The system in this section is a competent single-region, single-database migrator. At FAANG scale it needs surgery in six places before it is production-fit.

First, the advisory lock assumes a single Postgres primary. In a multi-region or multi-cluster deployment with multiple primaries (for example, a Citus cluster, a Vitess fleet, or a service that talks to a dozen horizontally sharded databases), a single advisory lock is the wrong abstraction. The correct model is a lock per shard, taken in a deterministic order to prevent deadlocks, and a coordinator that fans out the migration to each shard in parallel while aggregating status. Vitess Online DDL and Citus's `citus.multi_shard_modify_mode` are reference implementations. If the Go service owns 64 shards, the migrator runs 64 parallel executions, each taking the advisory lock on its own shard, each writing to its own shard's `schema_migrations` table, and the coordinator reports success only when all 64 succeed. Partial failure requires careful rollback because some shards may have applied the change and others not.

Second, the transaction boundary is wrong for online DDL. The code wraps every migration in a transaction, which breaks the moment you need `CREATE INDEX CONCURRENTLY` or `ALTER TYPE ... ADD VALUE` (both of which Postgres refuses to run inside a transaction). The fix is a per-migration directive like `-- +noTransaction` that the parser honors, and a strong convention that such migrations contain exactly one statement so there is no partial-failure ambiguity. Goose and golang-migrate both support this directive. Production systems usually enforce it in CI with a linter that reads the migration file and rejects multi-statement non-transactional migrations.

Third, dirty-state recovery is oversimplified. The current design refuses to proceed if any migration is dirty, which forces a human to manually clear the flag. At scale this produces 3am pages that block deploys. The production pattern is an automatic reconciler that, on startup, inspects the dirty migration's SQL, determines whether it is idempotent (most `ADD COLUMN IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` are), and if so, retries it. If not idempotent, the system quarantines the migration, marks it as requiring human review, and surfaces a runbook link. This is the pattern at Netflix, and the runbook link is the most important part because it is what the oncall reads at 3am.

Fourth, the validator's regex-based dangerous-pattern detection is a starting point, not a finish line. A FAANG-grade validator parses SQL with a real parser (pg_query_go, which wraps Postgres's own parser, or sqlparser from Vitess for MySQL) and walks the AST. Regexes miss comments that contain the flagged keyword, fail on multi-line statements, and cannot distinguish `DROP TABLE` inside a `DO $$ BEGIN ... END $$` block from a top-level `DROP TABLE`. Parser-backed validation also enables deeper checks like "this migration adds a foreign key but the referenced column is not indexed" or "this migration references a table that does not exist in the expected pre-migration schema." Both of these are runtime-only failures today and compile-time-preventable with AST walking.

Fifth, observability is absent. A production migrator emits structured logs with trace IDs that correlate to the deploy that triggered it, exports Prometheus metrics for migration duration per version and per shard, emits OpenTelemetry spans so a slow migration shows up in the same trace as the deploy pipeline, and writes an audit record to an immutable log (S3 with object lock, or a dedicated audit database) before and after each migration. Audit records include the operator identity (who ran it), the commit SHA, the full SQL, and the before/after checksums. In regulated shops the audit log for schema changes is a compliance artifact often retained for years to satisfy SOX or similar controls.

Sixth, the system assumes migrations run at deploy time from the application binary. At scale this is backwards. Deploy-time migrations couple schema lifecycle to application rollout, which means a slow migration blocks the deploy and a failed migration blocks all deploys. The mature pattern separates them. Migrations run as their own Kubernetes `Job` or a dedicated control-plane service (think Atlas Cloud, PlanetScale's branch-and-deploy flow, or an internal tool like Shopify's ghostferry orchestrator). The application deploys decoupled from the migration, with feature flags gating any code that assumes the new schema. If the migration fails, the deploy proceeds with the flag off and the migration is retried or rolled back independently. This separation of concerns is the single biggest architectural shift between a Series B shop and a FAANG backend, and it is why the operator-led model (Atlas, Spirit, Vitess Online DDL, pgroll) is displacing application-embedded migrators for serious workloads.

A staff-level code review of this system would also flag the lock ID being a hardcoded magic number (should be derived from the service name hash, so two services sharing a database do not collide), the absence of a checksum verification that the file content matches what was recorded at apply time (catches the classic "someone edited a merged migration file" footgun), and the lack of a `-target` flag that lets you migrate to a specific version rather than just "latest" (essential for investigating production incidents by reproducing a mid-migration state in staging).

---
