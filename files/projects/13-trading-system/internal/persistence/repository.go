// internal/persistence/repository.go
package persistence

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	_ "github.com/lib/pq"
	"github.com/example/trading-system/pkg/types"
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
