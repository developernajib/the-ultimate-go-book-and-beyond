package database

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Config holds database configuration
type Config struct {
	Host            string
	Port            int
	User            string
	Password        string
	Database        string
	MaxConns        int32
	MinConns        int32
	MaxConnLifetime time.Duration
	MaxConnIdleTime time.Duration
}

// NewPostgresPool creates a new PostgreSQL connection pool
func NewPostgresPool(ctx context.Context, cfg Config) (*pgxpool.Pool, error) {
	dsn := fmt.Sprintf(
		"host=%s port=%d user=%s password=%s dbname=%s sslmode=disable",
		cfg.Host, cfg.Port, cfg.User, cfg.Password, cfg.Database,
	)

	poolConfig, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parsing pool config: %w", err)
	}

	poolConfig.MaxConns = cfg.MaxConns
	if poolConfig.MaxConns == 0 {
		poolConfig.MaxConns = 25
	}

	poolConfig.MinConns = cfg.MinConns
	if poolConfig.MinConns == 0 {
		poolConfig.MinConns = 5
	}

	poolConfig.MaxConnLifetime = cfg.MaxConnLifetime
	if poolConfig.MaxConnLifetime == 0 {
		poolConfig.MaxConnLifetime = time.Hour
	}

	poolConfig.MaxConnIdleTime = cfg.MaxConnIdleTime
	if poolConfig.MaxConnIdleTime == 0 {
		poolConfig.MaxConnIdleTime = time.Minute * 30
	}

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("creating connection pool: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("pinging database: %w", err)
	}

	return pool, nil
}

// Transactor provides transaction support
type Transactor interface {
	WithTransaction(ctx context.Context, fn func(pgx.Tx) error) error
}

// PostgresTransactor implements Transactor
type PostgresTransactor struct {
	pool *pgxpool.Pool
}

// NewTransactor creates a new PostgresTransactor
func NewTransactor(pool *pgxpool.Pool) *PostgresTransactor {
	return &PostgresTransactor{pool: pool}
}

// WithTransaction executes a function within a database transaction
func (t *PostgresTransactor) WithTransaction(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := t.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}

	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback(ctx)
			panic(p)
		}
	}()

	if err := fn(tx); err != nil {
		if rbErr := tx.Rollback(ctx); rbErr != nil {
			return fmt.Errorf("rolling back transaction: %v (original error: %w)", rbErr, err)
		}
		return err
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("committing transaction: %w", err)
	}

	return nil
}
