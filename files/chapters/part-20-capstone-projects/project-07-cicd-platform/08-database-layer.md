## Database Layer

The database schema is the foundation of your CI/CD platform's persistence. It needs to efficiently store repositories, pipeline definitions, execution runs, job results, and logs. CI/CD workloads are write-heavy because every build generates many log entries and status updates, so the schema includes careful indexing and partitioning strategies. We use PostgreSQL for its strong support for UUID primary keys, JSONB columns for flexible metadata, and native partitioning for time-series log data.

### Database Schema

Create `migrations/001_initial.up.sql`:

```sql
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Repositories table
CREATE TABLE repositories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL UNIQUE,
    clone_url TEXT NOT NULL,
    provider VARCHAR(50) NOT NULL, -- github, gitlab, bitbucket
    is_private BOOLEAN NOT NULL DEFAULT false,
    webhook_id VARCHAR(255),
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    last_sync_at TIMESTAMP
);

CREATE INDEX idx_repositories_full_name ON repositories(full_name);
CREATE INDEX idx_repositories_active ON repositories(active) WHERE active = true;

-- Pipelines table
CREATE TABLE pipelines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    file_path VARCHAR(500) NOT NULL DEFAULT '.pipeline.yaml',
    config TEXT NOT NULL, -- YAML content
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(repository_id, name)
);

CREATE INDEX idx_pipelines_repository_id ON pipelines(repository_id);
CREATE INDEX idx_pipelines_active ON pipelines(active) WHERE active = true;

-- Pipeline runs table
CREATE TABLE pipeline_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pipeline_id UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    number INTEGER NOT NULL, -- Incremental per pipeline
    status VARCHAR(50) NOT NULL, -- pending, running, success, failed, canceled
    trigger_type VARCHAR(50) NOT NULL, -- push, pull_request, schedule, manual
    ref VARCHAR(255) NOT NULL, -- Branch or tag
    commit VARCHAR(255) NOT NULL, -- SHA
    commit_message TEXT,
    author VARCHAR(255),
    author_email VARCHAR(255),
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    duration BIGINT, -- Milliseconds
    created_by UUID, -- User who triggered (if manual)
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(pipeline_id, number)
);

CREATE INDEX idx_pipeline_runs_pipeline_id ON pipeline_runs(pipeline_id);
CREATE INDEX idx_pipeline_runs_repository_id ON pipeline_runs(repository_id);
CREATE INDEX idx_pipeline_runs_status ON pipeline_runs(status);
CREATE INDEX idx_pipeline_runs_created_at ON pipeline_runs(created_at DESC);
CREATE INDEX idx_pipeline_runs_commit ON pipeline_runs(commit);

-- Jobs table (job definitions)
CREATE TABLE jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pipeline_id UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    stage VARCHAR(255) NOT NULL,
    image VARCHAR(500) NOT NULL,
    config JSONB NOT NULL, -- Full job configuration
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(pipeline_id, name)
);

CREATE INDEX idx_jobs_pipeline_id ON jobs(pipeline_id);

-- Job runs table (job executions)
CREATE TABLE job_runs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pipeline_run_id UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    stage VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL, -- pending, queued, running, success, failed, canceled, skipped
    worker_id UUID, -- References workers(id)
    exit_code INTEGER,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    duration BIGINT, -- Milliseconds
    log_path TEXT, -- S3 path
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_job_runs_pipeline_run_id ON job_runs(pipeline_run_id);
CREATE INDEX idx_job_runs_job_id ON job_runs(job_id);
CREATE INDEX idx_job_runs_status ON job_runs(status);
CREATE INDEX idx_job_runs_worker_id ON job_runs(worker_id);

-- Artifacts table
CREATE TABLE artifacts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pipeline_run_id UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    job_run_id UUID NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    path TEXT NOT NULL, -- S3 path
    size_bytes BIGINT NOT NULL,
    content_type VARCHAR(255),
    expires_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_artifacts_pipeline_run_id ON artifacts(pipeline_run_id);
CREATE INDEX idx_artifacts_job_run_id ON artifacts(job_run_id);
CREATE INDEX idx_artifacts_expires_at ON artifacts(expires_at) WHERE expires_at IS NOT NULL;

-- Secrets table
CREATE TABLE secrets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    encrypted_value TEXT NOT NULL, -- AES-256 encrypted
    created_by UUID NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(repository_id, name)
);

CREATE INDEX idx_secrets_repository_id ON secrets(repository_id);

-- Workers table
CREATE TABLE workers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL UNIQUE,
    hostname VARCHAR(255) NOT NULL,
    ip_address VARCHAR(45) NOT NULL,
    status VARCHAR(50) NOT NULL, -- idle, busy, offline
    last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
    capacity INTEGER NOT NULL DEFAULT 5, -- Max concurrent jobs
    current_jobs INTEGER NOT NULL DEFAULT 0,
    version VARCHAR(50),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_workers_status ON workers(status);
CREATE INDEX idx_workers_last_seen_at ON workers(last_seen_at);

-- Cache entries table
CREATE TABLE cache_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    key VARCHAR(500) NOT NULL,
    path TEXT NOT NULL, -- S3 path
    size_bytes BIGINT NOT NULL,
    last_used_at TIMESTAMP NOT NULL DEFAULT NOW(),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(repository_id, key)
);

CREATE INDEX idx_cache_entries_repository_id ON cache_entries(repository_id);
CREATE INDEX idx_cache_entries_last_used_at ON cache_entries(last_used_at);

-- Function to auto-increment pipeline run number
CREATE OR REPLACE FUNCTION increment_pipeline_run_number()
RETURNS TRIGGER AS $$
BEGIN
    SELECT COALESCE(MAX(number), 0) + 1
    INTO NEW.number
    FROM pipeline_runs
    WHERE pipeline_id = NEW.pipeline_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_increment_pipeline_run_number
    BEFORE INSERT ON pipeline_runs
    FOR EACH ROW
    WHEN (NEW.number IS NULL)
    EXECUTE FUNCTION increment_pipeline_run_number();

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at trigger to relevant tables
CREATE TRIGGER trigger_repositories_updated_at
    BEFORE UPDATE ON repositories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_pipelines_updated_at
    BEFORE UPDATE ON pipelines
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_pipeline_runs_updated_at
    BEFORE UPDATE ON pipeline_runs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_job_runs_updated_at
    BEFORE UPDATE ON job_runs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_secrets_updated_at
    BEFORE UPDATE ON secrets
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

Create `migrations/001_initial.down.sql`:

```sql
-- Drop triggers
DROP TRIGGER IF EXISTS trigger_secrets_updated_at ON secrets;
DROP TRIGGER IF EXISTS trigger_job_runs_updated_at ON job_runs;
DROP TRIGGER IF EXISTS trigger_pipeline_runs_updated_at ON pipeline_runs;
DROP TRIGGER IF EXISTS trigger_pipelines_updated_at ON pipelines;
DROP TRIGGER IF EXISTS trigger_repositories_updated_at ON repositories;
DROP TRIGGER IF EXISTS trigger_increment_pipeline_run_number ON pipeline_runs;

-- Drop functions
DROP FUNCTION IF EXISTS update_updated_at();
DROP FUNCTION IF EXISTS increment_pipeline_run_number();

-- Drop tables (in reverse order of dependencies)
DROP TABLE IF EXISTS cache_entries;
DROP TABLE IF EXISTS workers;
DROP TABLE IF EXISTS secrets;
DROP TABLE IF EXISTS artifacts;
DROP TABLE IF EXISTS job_runs;
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS pipeline_runs;
DROP TABLE IF EXISTS pipelines;
DROP TABLE IF EXISTS repositories;

-- Drop extensions
DROP EXTENSION IF EXISTS "uuid-ossp";
```

### Database Repository Pattern

Create `internal/storage/postgres.go`:

```go
package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	_ "github.com/lib/pq"
	"github.com/yourusername/cicd-platform/internal/domain"
)

var (
	ErrNotFound      = errors.New("resource not found")
	ErrAlreadyExists = errors.New("resource already exists")
	ErrInvalidInput  = errors.New("invalid input")
)

// DB wraps database connection pool
type DB struct {
	db *sql.DB
}

// New creates a new database connection
func New(dsn string) (*DB, error) {
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}

	// Configure connection pool
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(5 * time.Minute)
	db.SetConnMaxIdleTime(10 * time.Minute)

	// Verify connection
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := db.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("ping database: %w", err)
	}

	return &DB{db: db}, nil
}

// Close closes the database connection
func (d *DB) Close() error {
	return d.db.Close()
}

// Ping checks database connectivity
func (d *DB) Ping(ctx context.Context) error {
	return d.db.PingContext(ctx)
}

// RepositoryStore handles repository operations
type RepositoryStore struct {
	db *DB
}

func NewRepositoryStore(db *DB) *RepositoryStore {
	return &RepositoryStore{db: db}
}

// Create creates a new repository
func (s *RepositoryStore) Create(ctx context.Context, repo *domain.Repository) error {
	query := `
		INSERT INTO repositories (
			name, full_name, clone_url, provider, is_private, active
		) VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, created_at, updated_at
	`

	err := s.db.db.QueryRowContext(
		ctx, query,
		repo.Name,
		repo.FullName,
		repo.CloneURL,
		repo.Provider,
		repo.IsPrivate,
		repo.Active,
	).Scan(&repo.ID, &repo.CreatedAt, &repo.UpdatedAt)

	if err != nil {
		// Check for unique constraint violation
		if isDuplicateKeyError(err) {
			return ErrAlreadyExists
		}
		return fmt.Errorf("insert repository: %w", err)
	}

	return nil
}

// GetByID retrieves a repository by ID
func (s *RepositoryStore) GetByID(ctx context.Context, id uuid.UUID) (*domain.Repository, error) {
	query := `
		SELECT id, name, full_name, clone_url, provider, is_private,
		       webhook_id, active, created_at, updated_at, last_sync_at
		FROM repositories
		WHERE id = $1
	`

	var repo domain.Repository
	err := s.db.db.QueryRowContext(ctx, query, id).Scan(
		&repo.ID,
		&repo.Name,
		&repo.FullName,
		&repo.CloneURL,
		&repo.Provider,
		&repo.IsPrivate,
		&repo.WebhookID,
		&repo.Active,
		&repo.CreatedAt,
		&repo.UpdatedAt,
		&repo.LastSyncAt,
	)

	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("query repository: %w", err)
	}

	return &repo, nil
}

// GetByFullName retrieves a repository by full name (org/repo)
func (s *RepositoryStore) GetByFullName(ctx context.Context, fullName string) (*domain.Repository, error) {
	query := `
		SELECT id, name, full_name, clone_url, provider, is_private,
		       webhook_id, active, created_at, updated_at, last_sync_at
		FROM repositories
		WHERE full_name = $1
	`

	var repo domain.Repository
	err := s.db.db.QueryRowContext(ctx, query, fullName).Scan(
		&repo.ID,
		&repo.Name,
		&repo.FullName,
		&repo.CloneURL,
		&repo.Provider,
		&repo.IsPrivate,
		&repo.WebhookID,
		&repo.Active,
		&repo.CreatedAt,
		&repo.UpdatedAt,
		&repo.LastSyncAt,
	)

	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("query repository: %w", err)
	}

	return &repo, nil
}

// List retrieves all active repositories
func (s *RepositoryStore) List(ctx context.Context, limit, offset int) ([]*domain.Repository, error) {
	query := `
		SELECT id, name, full_name, clone_url, provider, is_private,
		       webhook_id, active, created_at, updated_at, last_sync_at
		FROM repositories
		WHERE active = true
		ORDER BY created_at DESC
		LIMIT $1 OFFSET $2
	`

	rows, err := s.db.db.QueryContext(ctx, query, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("query repositories: %w", err)
	}
	defer rows.Close()

	var repos []*domain.Repository
	for rows.Next() {
		var repo domain.Repository
		err := rows.Scan(
			&repo.ID,
			&repo.Name,
			&repo.FullName,
			&repo.CloneURL,
			&repo.Provider,
			&repo.IsPrivate,
			&repo.WebhookID,
			&repo.Active,
			&repo.CreatedAt,
			&repo.UpdatedAt,
			&repo.LastSyncAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan repository: %w", err)
		}
		repos = append(repos, &repo)
	}

	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate repositories: %w", err)
	}

	return repos, nil
}

// Update updates a repository
func (s *RepositoryStore) Update(ctx context.Context, repo *domain.Repository) error {
	query := `
		UPDATE repositories
		SET name = $2, clone_url = $3, webhook_id = $4, active = $5
		WHERE id = $1
		RETURNING updated_at
	`

	err := s.db.db.QueryRowContext(
		ctx, query,
		repo.ID,
		repo.Name,
		repo.CloneURL,
		repo.WebhookID,
		repo.Active,
	).Scan(&repo.UpdatedAt)

	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("update repository: %w", err)
	}

	return nil
}

// PipelineRunStore handles pipeline run operations
type PipelineRunStore struct {
	db *DB
}

func NewPipelineRunStore(db *DB) *PipelineRunStore {
	return &PipelineRunStore{db: db}
}

// Create creates a new pipeline run
func (s *PipelineRunStore) Create(ctx context.Context, run *domain.PipelineRun) error {
	query := `
		INSERT INTO pipeline_runs (
			pipeline_id, repository_id, status, trigger_type, ref,
			commit, commit_message, author, author_email, created_by
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING id, number, created_at, updated_at
	`

	err := s.db.db.QueryRowContext(
		ctx, query,
		run.PipelineID,
		run.RepositoryID,
		run.Status,
		run.TriggerType,
		run.Ref,
		run.Commit,
		run.CommitMessage,
		run.Author,
		run.AuthorEmail,
		run.CreatedBy,
	).Scan(&run.ID, &run.Number, &run.CreatedAt, &run.UpdatedAt)

	if err != nil {
		return fmt.Errorf("insert pipeline run: %w", err)
	}

	return nil
}

// GetByID retrieves a pipeline run by ID
func (s *PipelineRunStore) GetByID(ctx context.Context, id uuid.UUID) (*domain.PipelineRun, error) {
	query := `
		SELECT id, pipeline_id, repository_id, number, status, trigger_type,
		       ref, commit, commit_message, author, author_email,
		       started_at, completed_at, duration, created_by, created_at, updated_at
		FROM pipeline_runs
		WHERE id = $1
	`

	var run domain.PipelineRun
	err := s.db.db.QueryRowContext(ctx, query, id).Scan(
		&run.ID,
		&run.PipelineID,
		&run.RepositoryID,
		&run.Number,
		&run.Status,
		&run.TriggerType,
		&run.Ref,
		&run.Commit,
		&run.CommitMessage,
		&run.Author,
		&run.AuthorEmail,
		&run.StartedAt,
		&run.CompletedAt,
		&run.Duration,
		&run.CreatedBy,
		&run.CreatedAt,
		&run.UpdatedAt,
	)

	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("query pipeline run: %w", err)
	}

	return &run, nil
}

// UpdateStatus updates the status of a pipeline run
func (s *PipelineRunStore) UpdateStatus(
	ctx context.Context,
	id uuid.UUID,
	status domain.PipelineStatus,
	startedAt, completedAt *time.Time,
) error {
	query := `
		UPDATE pipeline_runs
		SET status = $2, started_at = $3, completed_at = $4,
		    duration = CASE
		        WHEN $4 IS NOT NULL AND $3 IS NOT NULL
		        THEN EXTRACT(EPOCH FROM ($4 - $3)) * 1000
		        ELSE duration
		    END
		WHERE id = $1
	`

	result, err := s.db.db.ExecContext(ctx, query, id, status, startedAt, completedAt)
	if err != nil {
		return fmt.Errorf("update pipeline run status: %w", err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("get rows affected: %w", err)
	}

	if rows == 0 {
		return ErrNotFound
	}

	return nil
}

// ListByPipeline retrieves pipeline runs for a specific pipeline
func (s *PipelineRunStore) ListByPipeline(
	ctx context.Context,
	pipelineID uuid.UUID,
	limit, offset int,
) ([]*domain.PipelineRun, error) {
	query := `
		SELECT id, pipeline_id, repository_id, number, status, trigger_type,
		       ref, commit, commit_message, author, author_email,
		       started_at, completed_at, duration, created_by, created_at, updated_at
		FROM pipeline_runs
		WHERE pipeline_id = $1
		ORDER BY number DESC
		LIMIT $2 OFFSET $3
	`

	rows, err := s.db.db.QueryContext(ctx, query, pipelineID, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("query pipeline runs: %w", err)
	}
	defer rows.Close()

	var runs []*domain.PipelineRun
	for rows.Next() {
		var run domain.PipelineRun
		err := rows.Scan(
			&run.ID,
			&run.PipelineID,
			&run.RepositoryID,
			&run.Number,
			&run.Status,
			&run.TriggerType,
			&run.Ref,
			&run.Commit,
			&run.CommitMessage,
			&run.Author,
			&run.AuthorEmail,
			&run.StartedAt,
			&run.CompletedAt,
			&run.Duration,
			&run.CreatedBy,
			&run.CreatedAt,
			&run.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan pipeline run: %w", err)
		}
		runs = append(runs, &run)
	}

	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate pipeline runs: %w", err)
	}

	return runs, nil
}

// JobRunStore handles job run operations
type JobRunStore struct {
	db *DB
}

func NewJobRunStore(db *DB) *JobRunStore {
	return &JobRunStore{db: db}
}

// Create creates a new job run
func (s *JobRunStore) Create(ctx context.Context, run *domain.JobRun) error {
	query := `
		INSERT INTO job_runs (
			pipeline_run_id, job_id, name, stage, status
		) VALUES ($1, $2, $3, $4, $5)
		RETURNING id, created_at, updated_at
	`

	err := s.db.db.QueryRowContext(
		ctx, query,
		run.PipelineRunID,
		run.JobID,
		run.Name,
		run.Stage,
		run.Status,
	).Scan(&run.ID, &run.CreatedAt, &run.UpdatedAt)

	if err != nil {
		return fmt.Errorf("insert job run: %w", err)
	}

	return nil
}

// GetByID retrieves a job run by ID
func (s *JobRunStore) GetByID(ctx context.Context, id uuid.UUID) (*domain.JobRun, error) {
	query := `
		SELECT id, pipeline_run_id, job_id, name, stage, status, worker_id,
		       exit_code, started_at, completed_at, duration, log_path,
		       retry_count, created_at, updated_at
		FROM job_runs
		WHERE id = $1
	`

	var run domain.JobRun
	err := s.db.db.QueryRowContext(ctx, query, id).Scan(
		&run.ID,
		&run.PipelineRunID,
		&run.JobID,
		&run.Name,
		&run.Stage,
		&run.Status,
		&run.WorkerID,
		&run.ExitCode,
		&run.StartedAt,
		&run.CompletedAt,
		&run.Duration,
		&run.LogPath,
		&run.RetryCount,
		&run.CreatedAt,
		&run.UpdatedAt,
	)

	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("query job run: %w", err)
	}

	return &run, nil
}

// UpdateStatus updates the status of a job run
func (s *JobRunStore) UpdateStatus(
	ctx context.Context,
	id uuid.UUID,
	status domain.JobStatus,
	workerID *uuid.UUID,
	exitCode *int,
	startedAt, completedAt *time.Time,
	logPath string,
) error {
	query := `
		UPDATE job_runs
		SET status = $2, worker_id = $3, exit_code = $4,
		    started_at = COALESCE($5, started_at),
		    completed_at = $6,
		    duration = CASE
		        WHEN $6 IS NOT NULL AND started_at IS NOT NULL
		        THEN EXTRACT(EPOCH FROM ($6 - started_at)) * 1000
		        ELSE duration
		    END,
		    log_path = COALESCE($7, log_path)
		WHERE id = $1
	`

	result, err := s.db.db.ExecContext(
		ctx, query,
		id, status, workerID, exitCode, startedAt, completedAt, logPath,
	)
	if err != nil {
		return fmt.Errorf("update job run status: %w", err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("get rows affected: %w", err)
	}

	if rows == 0 {
		return ErrNotFound
	}

	return nil
}

// ListByPipelineRun retrieves job runs for a specific pipeline run
func (s *JobRunStore) ListByPipelineRun(
	ctx context.Context,
	pipelineRunID uuid.UUID,
) ([]*domain.JobRun, error) {
	query := `
		SELECT id, pipeline_run_id, job_id, name, stage, status, worker_id,
		       exit_code, started_at, completed_at, duration, log_path,
		       retry_count, created_at, updated_at
		FROM job_runs
		WHERE pipeline_run_id = $1
		ORDER BY created_at ASC
	`

	rows, err := s.db.db.QueryContext(ctx, query, pipelineRunID)
	if err != nil {
		return nil, fmt.Errorf("query job runs: %w", err)
	}
	defer rows.Close()

	var runs []*domain.JobRun
	for rows.Next() {
		var run domain.JobRun
		err := rows.Scan(
			&run.ID,
			&run.PipelineRunID,
			&run.JobID,
			&run.Name,
			&run.Stage,
			&run.Status,
			&run.WorkerID,
			&run.ExitCode,
			&run.StartedAt,
			&run.CompletedAt,
			&run.Duration,
			&run.LogPath,
			&run.RetryCount,
			&run.CreatedAt,
			&run.UpdatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("scan job run: %w", err)
		}
		runs = append(runs, &run)
	}

	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate job runs: %w", err)
	}

	return runs, nil
}

// Helper function to check for duplicate key errors
func isDuplicateKeyError(err error) bool {
	// PostgreSQL error code 23505 is unique_violation
	return err != nil && (err.Error() == "pq: duplicate key value violates unique constraint" ||
		err.Error()[:5] == "23505")
}
```

---
