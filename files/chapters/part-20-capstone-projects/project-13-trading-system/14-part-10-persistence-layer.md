## Part 10: Persistence Layer

Persistence is critical for audit trails, compliance, and analytics. Financial regulations require that every order, trade, and position change be recorded with precise timestamps and stored for years. The persistence layer must write data reliably without slowing down the hot path of order processing. We achieve this by using asynchronous writes with buffered channels, so the trading engine can continue processing while data is being flushed to the database in the background. TimescaleDB is used for time-series trade data, while Redis provides fast caching for frequently accessed state.

```go
// internal/persistence/repository.go
package persistence

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "github.com/lib/pq"
	"github.com/yourusername/trading-system/pkg/types"
)

// Repository handles data persistence
type Repository struct {
	db *sql.DB
}

// NewRepository creates a new repository
func NewRepository(connString string) (*Repository, error) {
	db, err := sql.Open("postgres", connString)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	// Set connection pool settings for high performance
	db.SetMaxOpenConns(100)
	db.SetMaxIdleConns(10)
	db.SetConnMaxLifetime(time.Hour)

	return &Repository{db: db}, nil
}

// Close closes the database connection
func (r *Repository) Close() error {
	return r.db.Close()
}

// SaveOrder persists an order
func (r *Repository) SaveOrder(ctx context.Context, order *types.Order) error {
	query := `
		INSERT INTO orders (
			id, client_order_id, account_id, symbol, side, type,
			price, stop_price, quantity, filled_quantity, remaining_qty,
			status, created_at, updated_at, time_in_force, strategy_id
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
		ON CONFLICT (id) DO UPDATE SET
			filled_quantity = EXCLUDED.filled_quantity,
			remaining_qty = EXCLUDED.remaining_qty,
			status = EXCLUDED.status,
			updated_at = EXCLUDED.updated_at
	`

	_, err := r.db.ExecContext(ctx, query,
		order.ID,
		order.ClientOrderID,
		order.AccountID,
		order.Symbol,
		order.Side,
		order.Type,
		order.Price,
		order.StopPrice,
		order.Quantity,
		order.FilledQuantity,
		order.RemainingQty,
		order.Status,
		order.CreatedAt,
		order.UpdatedAt,
		order.TimeInForce,
		order.StrategyID,
	)

	return err
}

// GetOrder retrieves an order by ID
func (r *Repository) GetOrder(ctx context.Context, orderID types.OrderID) (*types.Order, error) {
	query := `
		SELECT id, client_order_id, account_id, symbol, side, type,
			   price, stop_price, quantity, filled_quantity, remaining_qty,
			   status, created_at, updated_at, time_in_force, strategy_id
		FROM orders
		WHERE id = $1
	`

	order := &types.Order{
		Tags: make(map[string]string),
	}

	err := r.db.QueryRowContext(ctx, query, orderID).Scan(
		&order.ID,
		&order.ClientOrderID,
		&order.AccountID,
		&order.Symbol,
		&order.Side,
		&order.Type,
		&order.Price,
		&order.StopPrice,
		&order.Quantity,
		&order.FilledQuantity,
		&order.RemainingQty,
		&order.Status,
		&order.CreatedAt,
		&order.UpdatedAt,
		&order.TimeInForce,
		&order.StrategyID,
	)

	if err == sql.ErrNoRows {
		return nil, types.ErrOrderNotFound
	}

	return order, err
}

// GetAccountOrders retrieves all orders for an account
func (r *Repository) GetAccountOrders(ctx context.Context, accountID types.AccountID) ([]*types.Order, error) {
	query := `
		SELECT id, client_order_id, account_id, symbol, side, type,
			   price, stop_price, quantity, filled_quantity, remaining_qty,
			   status, created_at, updated_at, time_in_force, strategy_id
		FROM orders
		WHERE account_id = $1
		ORDER BY created_at DESC
	`

	rows, err := r.db.QueryContext(ctx, query, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var orders []*types.Order
	for rows.Next() {
		order := &types.Order{
			Tags: make(map[string]string),
		}

		err := rows.Scan(
			&order.ID,
			&order.ClientOrderID,
			&order.AccountID,
			&order.Symbol,
			&order.Side,
			&order.Type,
			&order.Price,
			&order.StopPrice,
			&order.Quantity,
			&order.FilledQuantity,
			&order.RemainingQty,
			&order.Status,
			&order.CreatedAt,
			&order.UpdatedAt,
			&order.TimeInForce,
			&order.StrategyID,
		)
		if err != nil {
			return nil, err
		}

		orders = append(orders, order)
	}

	return orders, rows.Err()
}

// SaveFill persists a fill
func (r *Repository) SaveFill(ctx context.Context, fill *types.Fill) error {
	query := `
		INSERT INTO fills (
			id, order_id, symbol, side, price, quantity,
			commission, commission_asset, timestamp, is_maker
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
	`

	_, err := r.db.ExecContext(ctx, query,
		fill.ID,
		fill.OrderID,
		fill.Symbol,
		fill.Side,
		fill.Price,
		fill.Quantity,
		fill.Commission,
		fill.CommissionAsset,
		fill.Timestamp,
		fill.IsMaker,
	)

	return err
}

// GetOrderFills retrieves all fills for an order
func (r *Repository) GetOrderFills(ctx context.Context, orderID types.OrderID) ([]*types.Fill, error) {
	query := `
		SELECT id, order_id, symbol, side, price, quantity,
			   commission, commission_asset, timestamp, is_maker
		FROM fills
		WHERE order_id = $1
		ORDER BY timestamp DESC
	`

	rows, err := r.db.QueryContext(ctx, query, orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var fills []*types.Fill
	for rows.Next() {
		fill := &types.Fill{}

		err := rows.Scan(
			&fill.ID,
			&fill.OrderID,
			&fill.Symbol,
			&fill.Side,
			&fill.Price,
			&fill.Quantity,
			&fill.Commission,
			&fill.CommissionAsset,
			&fill.Timestamp,
			&fill.IsMaker,
		)
		if err != nil {
			return nil, err
		}

		fills = append(fills, fill)
	}

	return fills, rows.Err()
}

// SaveTrade persists a market trade
func (r *Repository) SaveTrade(ctx context.Context, trade *types.Trade) error {
	query := `
		INSERT INTO trades (
			id, symbol, price, quantity, side, timestamp
		) VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (id) DO NOTHING
	`

	_, err := r.db.ExecContext(ctx, query,
		trade.ID,
		trade.Symbol,
		trade.Price,
		trade.Quantity,
		trade.Side,
		trade.Timestamp,
	)

	return err
}

// GetTrades retrieves trades for a symbol in a time range
func (r *Repository) GetTrades(ctx context.Context, symbol types.Symbol, start, end time.Time) ([]*types.Trade, error) {
	query := `
		SELECT id, symbol, price, quantity, side, timestamp
		FROM trades
		WHERE symbol = $1 AND timestamp >= $2 AND timestamp <= $3
		ORDER BY timestamp ASC
	`

	rows, err := r.db.QueryContext(ctx, query, symbol, start, end)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var trades []*types.Trade
	for rows.Next() {
		trade := &types.Trade{}

		err := rows.Scan(
			&trade.ID,
			&trade.Symbol,
			&trade.Price,
			&trade.Quantity,
			&trade.Side,
			&trade.Timestamp,
		)
		if err != nil {
			return nil, err
		}

		trades = append(trades, trade)
	}

	return trades, rows.Err()
}

// SavePosition persists a position
func (r *Repository) SavePosition(ctx context.Context, position *types.Position) error {
	query := `
		INSERT INTO positions (
			symbol, account_id, side, quantity, avg_entry_price,
			realized_pnl, unrealized_pnl, last_update_time
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (symbol, account_id) DO UPDATE SET
			side = EXCLUDED.side,
			quantity = EXCLUDED.quantity,
			avg_entry_price = EXCLUDED.avg_entry_price,
			realized_pnl = EXCLUDED.realized_pnl,
			unrealized_pnl = EXCLUDED.unrealized_pnl,
			last_update_time = EXCLUDED.last_update_time
	`

	_, err := r.db.ExecContext(ctx, query,
		position.Symbol,
		position.AccountID,
		position.Side,
		position.Quantity,
		position.AvgEntryPrice,
		position.RealizedPnL,
		position.UnrealizedPnL,
		position.LastUpdateTime,
	)

	return err
}

// GetPositions retrieves all positions for an account
func (r *Repository) GetPositions(ctx context.Context, accountID types.AccountID) ([]*types.Position, error) {
	query := `
		SELECT symbol, account_id, side, quantity, avg_entry_price,
			   realized_pnl, unrealized_pnl, last_update_time
		FROM positions
		WHERE account_id = $1
		ORDER BY symbol
	`

	rows, err := r.db.QueryContext(ctx, query, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var positions []*types.Position
	for rows.Next() {
		position := &types.Position{}

		err := rows.Scan(
			&position.Symbol,
			&position.AccountID,
			&position.Side,
			&position.Quantity,
			&position.AvgEntryPrice,
			&position.RealizedPnL,
			&position.UnrealizedPnL,
			&position.LastUpdateTime,
		)
		if err != nil {
			return nil, err
		}

		positions = append(positions, position)
	}

	return positions, rows.Err()
}

// SaveQuote persists a quote (for analytics)
func (r *Repository) SaveQuote(ctx context.Context, quote *types.Quote) error {
	// Using TimescaleDB for time-series data
	query := `
		INSERT INTO quotes (
			symbol, bid_price, bid_size, ask_price, ask_size, timestamp
		) VALUES ($1, $2, $3, $4, $5, $6)
	`

	_, err := r.db.ExecContext(ctx, query,
		quote.Symbol,
		quote.BidPrice,
		quote.BidSize,
		quote.AskPrice,
		quote.AskSize,
		quote.Timestamp,
	)

	return err
}

// GetQuoteHistory retrieves quote history for analytics
func (r *Repository) GetQuoteHistory(ctx context.Context, symbol types.Symbol, start, end time.Time, interval time.Duration) ([]*types.Quote, error) {
	// Using TimescaleDB time_bucket for aggregation
	query := `
		SELECT
			symbol,
			time_bucket($1, timestamp) AS bucket,
			FIRST(bid_price, timestamp) AS bid_price,
			FIRST(bid_size, timestamp) AS bid_size,
			FIRST(ask_price, timestamp) AS ask_price,
			FIRST(ask_size, timestamp) AS ask_size
		FROM quotes
		WHERE symbol = $2 AND timestamp >= $3 AND timestamp <= $4
		GROUP BY symbol, bucket
		ORDER BY bucket ASC
	`

	rows, err := r.db.QueryContext(ctx, query, interval, symbol, start, end)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var quotes []*types.Quote
	for rows.Next() {
		quote := &types.Quote{}
		var bucket time.Time

		err := rows.Scan(
			&quote.Symbol,
			&bucket,
			&quote.BidPrice,
			&quote.BidSize,
			&quote.AskPrice,
			&quote.AskSize,
		)
		if err != nil {
			return nil, err
		}

		quote.Timestamp = bucket
		quotes = append(quotes, quote)
	}

	return quotes, rows.Err()
}
```

### Database Schema

The database schema models the core entities, short codes, original URLs, owner accounts, and click events, with indexes tuned for the dominant query patterns. Schema choices made here affect both the scalability of redirect lookups and the flexibility of analytics queries performed offline.

```sql
-- migrations/001_initial_schema.sql

-- Enable TimescaleDB extension for time-series data
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Orders table
CREATE TABLE IF NOT EXISTS orders (
    id VARCHAR(64) PRIMARY KEY,
    client_order_id VARCHAR(64),
    account_id VARCHAR(64) NOT NULL,
    symbol VARCHAR(32) NOT NULL,
    side SMALLINT NOT NULL,
    type SMALLINT NOT NULL,
    price BIGINT NOT NULL,
    stop_price BIGINT,
    quantity BIGINT NOT NULL,
    filled_quantity BIGINT NOT NULL DEFAULT 0,
    remaining_qty BIGINT NOT NULL,
    status SMALLINT NOT NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    time_in_force SMALLINT NOT NULL,
    strategy_id VARCHAR(64)
);

CREATE INDEX idx_orders_account_id ON orders(account_id);
CREATE INDEX idx_orders_symbol ON orders(symbol);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at DESC);

-- Fills table
CREATE TABLE IF NOT EXISTS fills (
    id VARCHAR(64) PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL REFERENCES orders(id),
    symbol VARCHAR(32) NOT NULL,
    side SMALLINT NOT NULL,
    price BIGINT NOT NULL,
    quantity BIGINT NOT NULL,
    commission BIGINT NOT NULL DEFAULT 0,
    commission_asset VARCHAR(16),
    timestamp TIMESTAMP NOT NULL,
    is_maker BOOLEAN NOT NULL
);

CREATE INDEX idx_fills_order_id ON fills(order_id);
CREATE INDEX idx_fills_symbol ON fills(symbol);
CREATE INDEX idx_fills_timestamp ON fills(timestamp DESC);

-- Trades table (market trades)
CREATE TABLE IF NOT EXISTS trades (
    id VARCHAR(64) PRIMARY KEY,
    symbol VARCHAR(32) NOT NULL,
    price BIGINT NOT NULL,
    quantity BIGINT NOT NULL,
    side SMALLINT NOT NULL,
    timestamp TIMESTAMP NOT NULL
);

CREATE INDEX idx_trades_symbol_timestamp ON trades(symbol, timestamp DESC);

-- Convert to TimescaleDB hypertable
SELECT create_hypertable('trades', 'timestamp', if_not_exists => TRUE);

-- Positions table
CREATE TABLE IF NOT EXISTS positions (
    symbol VARCHAR(32) NOT NULL,
    account_id VARCHAR(64) NOT NULL,
    side SMALLINT NOT NULL,
    quantity BIGINT NOT NULL,
    avg_entry_price BIGINT NOT NULL,
    realized_pnl BIGINT NOT NULL DEFAULT 0,
    unrealized_pnl BIGINT NOT NULL DEFAULT 0,
    last_update_time TIMESTAMP NOT NULL,
    PRIMARY KEY (symbol, account_id)
);

-- Quotes table (for analytics)
CREATE TABLE IF NOT EXISTS quotes (
    symbol VARCHAR(32) NOT NULL,
    bid_price BIGINT NOT NULL,
    bid_size BIGINT NOT NULL,
    ask_price BIGINT NOT NULL,
    ask_size BIGINT NOT NULL,
    timestamp TIMESTAMP NOT NULL
);

CREATE INDEX idx_quotes_symbol_timestamp ON quotes(symbol, timestamp DESC);

-- Convert to TimescaleDB hypertable
SELECT create_hypertable('quotes', 'timestamp', if_not_exists => TRUE);

-- Accounts table
CREATE TABLE IF NOT EXISTS accounts (
    id VARCHAR(64) PRIMARY KEY,
    balance BIGINT NOT NULL,
    available_balance BIGINT NOT NULL,
    margin_used BIGINT NOT NULL DEFAULT 0,
    unrealized_pnl BIGINT NOT NULL DEFAULT 0,
    realized_pnl BIGINT NOT NULL DEFAULT 0,
    last_update_time TIMESTAMP NOT NULL
);

-- Audit log table (for compliance)
CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMP NOT NULL,
    event_type VARCHAR(32) NOT NULL,
    account_id VARCHAR(64),
    order_id VARCHAR(64),
    details JSONB,
    user_id VARCHAR(64)
);

CREATE INDEX idx_audit_log_timestamp ON audit_log(timestamp DESC);
CREATE INDEX idx_audit_log_account_id ON audit_log(account_id);
CREATE INDEX idx_audit_log_event_type ON audit_log(event_type);

-- Convert to TimescaleDB hypertable
SELECT create_hypertable('audit_log', 'timestamp', if_not_exists => TRUE);
```
