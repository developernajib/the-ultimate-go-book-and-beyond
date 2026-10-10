package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	_ "github.com/lib/pq"
	"github.com/example/cicd-platform/internal/domain"
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
		len(err.Error()) >= 5 && err.Error()[:5] == "23505")
}
