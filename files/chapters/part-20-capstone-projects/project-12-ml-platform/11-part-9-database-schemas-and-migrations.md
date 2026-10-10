## Part 9: Database Schemas and Migrations

Every service in the platform needs persistent storage, and the database schema is the foundation that everything else builds on. A well-designed schema with proper indexes, foreign key constraints, and JSONB columns for flexible metadata ensures both data integrity and query performance. In this part, you will define the PostgreSQL tables for all platform components and build a migration runner that applies schema changes safely and idempotently.

### 9.1 PostgreSQL Schema

The schema below creates tables for experiments, runs, metrics, artifacts, registered models, model versions, feature groups, features, pipelines, and A/B tests. Notice the use of JSONB columns for tags, parameters, and metadata -- this gives you the flexibility to store arbitrary key-value data without schema changes. Indexes are placed on columns that appear frequently in WHERE clauses and JOIN conditions, such as experiment IDs and model names.

```sql
-- schema/001_initial.sql

-- Experiments table
CREATE TABLE experiments (
    id UUID PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    tags JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    created_by VARCHAR(255) NOT NULL,
    metadata JSONB
);

CREATE INDEX idx_experiments_name ON experiments(name);
CREATE INDEX idx_experiments_created_at ON experiments(created_at DESC);
CREATE INDEX idx_experiments_tags ON experiments USING GIN(tags);

-- Runs table
CREATE TABLE runs (
    id UUID PRIMARY KEY,
    experiment_id UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
    name VARCHAR(255),
    status VARCHAR(50) NOT NULL,
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP,
    parameters JSONB,
    metrics JSONB,
    tags JSONB,
    source_type VARCHAR(50),
    source_name VARCHAR(255),
    git_commit VARCHAR(255),
    git_branch VARCHAR(255),
    user_id VARCHAR(255) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_runs_experiment_id ON runs(experiment_id);
CREATE INDEX idx_runs_status ON runs(status);
CREATE INDEX idx_runs_start_time ON runs(start_time DESC);
CREATE INDEX idx_runs_user_id ON runs(user_id);
CREATE INDEX idx_runs_tags ON runs USING GIN(tags);

-- Artifacts table
CREATE TABLE artifacts (
    id UUID PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    path VARCHAR(1000) NOT NULL,
    type VARCHAR(50) NOT NULL,
    size BIGINT NOT NULL,
    hash VARCHAR(64) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    storage_uri VARCHAR(1000) NOT NULL
);

CREATE INDEX idx_artifacts_run_id ON artifacts(run_id);
CREATE INDEX idx_artifacts_type ON artifacts(type);

-- Metrics table (time-series optimized)
CREATE TABLE metrics (
    run_id UUID NOT NULL,
    key VARCHAR(255) NOT NULL,
    value DOUBLE PRECISION NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    step BIGINT NOT NULL,
    PRIMARY KEY (run_id, key, step)
);

-- Convert to TimescaleDB hypertable for better time-series performance
SELECT create_hypertable('metrics', 'timestamp');

CREATE INDEX idx_metrics_run_key ON metrics(run_id, key);

-- Registered Models table
CREATE TABLE registered_models (
    id UUID PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    tags JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    latest_versions JSONB
);

CREATE INDEX idx_models_name ON registered_models(name);
CREATE INDEX idx_models_tags ON registered_models USING GIN(tags);

-- Model Versions table
CREATE TABLE model_versions (
    id UUID PRIMARY KEY,
    model_id UUID NOT NULL REFERENCES registered_models(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    run_id UUID REFERENCES runs(id),
    stage VARCHAR(50) NOT NULL,
    description TEXT,
    tags JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    source_path VARCHAR(1000) NOT NULL,
    format VARCHAR(50) NOT NULL,
    framework VARCHAR(100),
    signature JSONB,
    metadata JSONB,
    performance_metrics JSONB,
    UNIQUE(model_id, version)
);

CREATE INDEX idx_model_versions_model_id ON model_versions(model_id);
CREATE INDEX idx_model_versions_stage ON model_versions(stage);
CREATE INDEX idx_model_versions_created_at ON model_versions(created_at DESC);

-- Model Transitions table
CREATE TABLE model_transitions (
    id UUID PRIMARY KEY,
    model_version_id UUID NOT NULL REFERENCES model_versions(id) ON DELETE CASCADE,
    from_stage VARCHAR(50) NOT NULL,
    to_stage VARCHAR(50) NOT NULL,
    requested_by VARCHAR(255) NOT NULL,
    requested_at TIMESTAMP NOT NULL,
    approved_by VARCHAR(255),
    approved_at TIMESTAMP,
    status VARCHAR(50) NOT NULL,
    comment TEXT
);

CREATE INDEX idx_transitions_version ON model_transitions(model_version_id);
CREATE INDEX idx_transitions_status ON model_transitions(status);

-- Feature Groups table
CREATE TABLE feature_groups (
    id UUID PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    entity_type VARCHAR(100) NOT NULL,
    features JSONB NOT NULL,
    source JSONB NOT NULL,
    tags JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_feature_groups_name ON feature_groups(name);
CREATE INDEX idx_feature_groups_entity_type ON feature_groups(entity_type);

-- Feature Views table
CREATE TABLE feature_views (
    id UUID PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    feature_groups JSONB NOT NULL,
    entities JSONB NOT NULL,
    features JSONB NOT NULL,
    online_enabled BOOLEAN NOT NULL,
    offline_enabled BOOLEAN NOT NULL,
    ttl INTERVAL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_feature_views_name ON feature_views(name);

-- Pipelines table
CREATE TABLE pipelines (
    id UUID PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    description TEXT,
    steps JSONB NOT NULL,
    schedule JSONB,
    tags JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pipelines_name ON pipelines(name);

-- Pipeline Runs table
CREATE TABLE pipeline_runs (
    id UUID PRIMARY KEY,
    pipeline_id UUID NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
    status VARCHAR(50) NOT NULL,
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP,
    step_runs JSONB NOT NULL,
    params JSONB,
    trigger_type VARCHAR(50) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pipeline_runs_pipeline_id ON pipeline_runs(pipeline_id);
CREATE INDEX idx_pipeline_runs_status ON pipeline_runs(status);
CREATE INDEX idx_pipeline_runs_start_time ON pipeline_runs(start_time DESC);

-- A/B Tests table
CREATE TABLE ab_tests (
    id UUID PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    model_name VARCHAR(255) NOT NULL,
    variants JSONB NOT NULL,
    traffic_split JSONB NOT NULL,
    status VARCHAR(50) NOT NULL,
    start_time TIMESTAMP,
    end_time TIMESTAMP,
    metrics JSONB,
    winner_criteria JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ab_tests_model_name ON ab_tests(model_name);
CREATE INDEX idx_ab_tests_status ON ab_tests(status);

-- Prediction Records table (for monitoring)
CREATE TABLE prediction_records (
    id UUID PRIMARY KEY,
    model_name VARCHAR(255) NOT NULL,
    model_version INTEGER NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    inputs JSONB NOT NULL,
    outputs JSONB NOT NULL,
    latency_ms BIGINT NOT NULL,
    ground_truth JSONB
);

-- Convert to hypertable for time-series
SELECT create_hypertable('prediction_records', 'timestamp');

CREATE INDEX idx_predictions_model ON prediction_records(model_name, model_version);
CREATE INDEX idx_predictions_timestamp ON prediction_records(timestamp DESC);

-- Baseline Statistics table (for drift detection)
CREATE TABLE baseline_statistics (
    id UUID PRIMARY KEY,
    model_name VARCHAR(255) NOT NULL,
    feature_name VARCHAR(255) NOT NULL,
    statistics JSONB NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(model_name, feature_name)
);

CREATE INDEX idx_baseline_model ON baseline_statistics(model_name);
```

### 9.2 Migration Runner

Rather than applying SQL files manually, a migration runner tracks which migrations have already been applied and executes only the new ones. This is essential for team collaboration and automated deployments because it guarantees that every environment -- development, staging, and production -- has the same schema. The runner below uses a `schema_migrations` table to record applied migrations and wraps each migration in a transaction so that a failed migration does not leave the database in a half-applied state.

```go
// internal/storage/migrations/runner.go
package migrations

import (
	"database/sql"
	"embed"
	"fmt"
	"sort"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source/iofs"
)

//go:embed *.sql
var migrationFS embed.FS

// RunMigrations applies all pending migrations
func RunMigrations(db *sql.DB) error {
	driver, err := postgres.WithInstance(db, &postgres.Config{})
	if err != nil {
		return fmt.Errorf("creating postgres driver: %w", err)
	}

	sourceDriver, err := iofs.New(migrationFS, ".")
	if err != nil {
		return fmt.Errorf("creating source driver: %w", err)
	}

	m, err := migrate.NewWithInstance("iofs", sourceDriver, "postgres", driver)
	if err != nil {
		return fmt.Errorf("creating migrate instance: %w", err)
	}

	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return fmt.Errorf("running migrations: %w", err)
	}

	return nil
}
```

---
