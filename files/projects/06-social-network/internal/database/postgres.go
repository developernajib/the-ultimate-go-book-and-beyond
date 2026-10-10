// internal/database/postgres.go
package database

import (
    "context"
    "fmt"
    "time"

    "github.com/jmoiron/sqlx"
    _ "github.com/jackc/pgx/v5/stdlib"
)

type Config struct {
    Host            string
    Port            int
    User            string
    Password        string
    Database        string
    SSLMode         string
    MaxOpenConns    int
    MaxIdleConns    int
    ConnMaxLifetime time.Duration
    ConnMaxIdleTime time.Duration
}

func NewPostgresDB(cfg Config) (*sqlx.DB, error) {
    dsn := fmt.Sprintf(
        "host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
        cfg.Host, cfg.Port, cfg.User, cfg.Password, cfg.Database, cfg.SSLMode,
    )

    db, err := sqlx.Connect("pgx", dsn)
    if err != nil {
        return nil, fmt.Errorf("connect to postgres: %w", err)
    }

    // Configure connection pool
    db.SetMaxOpenConns(cfg.MaxOpenConns)       // Max 100 connections
    db.SetMaxIdleConns(cfg.MaxIdleConns)       // Keep 25 idle
    db.SetConnMaxLifetime(cfg.ConnMaxLifetime) // Recycle after 1 hour
    db.SetConnMaxIdleTime(cfg.ConnMaxIdleTime) // Close idle after 10 min

    // Verify connection
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    if err := db.PingContext(ctx); err != nil {
        return nil, fmt.Errorf("ping postgres: %w", err)
    }

    return db, nil
}
