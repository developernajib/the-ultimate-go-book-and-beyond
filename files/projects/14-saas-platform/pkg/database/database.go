// pkg/database/database.go
package database

import (
	"context"
	"database/sql"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// DB wraps sql.DB for the platform
type DB struct {
	*sql.DB
}

// Tx wraps sql.Tx
type Tx struct {
	*sql.Tx
}

// Connect creates a new database connection
func Connect(dsn string) (*DB, error) {
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	return &DB{db}, nil
}

// BeginTx starts a transaction
func (db *DB) BeginTx(ctx context.Context, opts *sql.TxOptions) (*Tx, error) {
	tx, err := db.DB.BeginTx(ctx, opts)
	if err != nil {
		return nil, err
	}
	return &Tx{tx}, nil
}
