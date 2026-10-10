## 52.4 Inventory Service

The inventory service tracks available and reserved stock per product. It is the most concurrency-sensitive service in the platform: during a flash sale, hundreds of concurrent requests may attempt to reserve the same product simultaneously. The implementation uses PostgreSQL row-level locks (`SELECT ... FOR UPDATE`) inside transactions to prevent overselling, and time-limited reservations that automatically expire if an order is not confirmed within 30 minutes.

```go
// internal/inventory/service.go
package inventory

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"example.com/ecommerce/pkg/events"
)

// Inventory represents stock for a product
type Inventory struct {
	ProductID string    `json:"product_id" db:"product_id"`
	Available int       `json:"available" db:"available"`
	Reserved  int       `json:"reserved" db:"reserved"`
	UpdatedAt time.Time `json:"updated_at" db:"updated_at"`
}

// Reservation represents a stock reservation
type Reservation struct {
	ID        string    `json:"id" db:"id"`
	OrderID   string    `json:"order_id" db:"order_id"`
	ProductID string    `json:"product_id" db:"product_id"`
	Quantity  int       `json:"quantity" db:"quantity"`
	Status    string    `json:"status" db:"status"`
	ExpiresAt time.Time `json:"expires_at" db:"expires_at"`
	CreatedAt time.Time `json:"created_at" db:"created_at"`
}

// Service handles inventory operations
type Service struct {
	db        *sql.DB
	publisher events.Publisher
	logger    *slog.Logger
}

// NewService creates an inventory service
func NewService(db *sql.DB, publisher events.Publisher, logger *slog.Logger) (*Service, error) {
	s := &Service{
		db:        db,
		publisher: publisher,
		logger:    logger,
	}
	if err := s.createSchema(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Service) createSchema() error {
	query := `
		CREATE TABLE IF NOT EXISTS inventory (
			product_id UUID PRIMARY KEY,
			available INT NOT NULL DEFAULT 0,
			reserved INT NOT NULL DEFAULT 0,
			updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		);

		CREATE TABLE IF NOT EXISTS reservations (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			order_id UUID NOT NULL,
			product_id UUID NOT NULL,
			quantity INT NOT NULL,
			status VARCHAR(20) DEFAULT 'active',
			expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
			created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
		);

		CREATE INDEX IF NOT EXISTS idx_reservations_order ON reservations(order_id);
		CREATE INDEX IF NOT EXISTS idx_reservations_product ON reservations(product_id);
		CREATE INDEX IF NOT EXISTS idx_reservations_expires ON reservations(expires_at) WHERE status = 'active';
	`

	_, err := s.db.Exec(query)
	return err
}

// GetStock retrieves stock for a product
func (s *Service) GetStock(ctx context.Context, productID string) (*Inventory, error) {
	var inv Inventory
	err := s.db.QueryRowContext(ctx,
		`SELECT product_id, available, reserved, updated_at FROM inventory WHERE product_id = $1`,
		productID,
	).Scan(&inv.ProductID, &inv.Available, &inv.Reserved, &inv.UpdatedAt)

	if err == sql.ErrNoRows {
		return nil, ErrProductNotFound
	}
	return &inv, err
}

// SetStock sets stock for a product
func (s *Service) SetStock(ctx context.Context, productID string, quantity int) error {
	query := `
		INSERT INTO inventory (product_id, available, updated_at)
		VALUES ($1, $2, NOW())
		ON CONFLICT (product_id) DO UPDATE
		SET available = $2, updated_at = NOW()
	`

	_, err := s.db.ExecContext(ctx, query, productID, quantity)
	return err
}

// ReserveItem represents an item to reserve
type ReserveItem struct {
	ProductID string `json:"product_id"`
	Quantity  int    `json:"quantity"`
}

// ReserveStock reserves stock for an order
func (s *Service) ReserveStock(ctx context.Context, orderID string, items []ReserveItem) ([]Reservation, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	reservations := make([]Reservation, 0, len(items))
	expiresAt := time.Now().Add(30 * time.Minute)

	for _, item := range items {
		// Lock and check availability
		var available int
		err := tx.QueryRowContext(ctx,
			`SELECT available FROM inventory WHERE product_id = $1 FOR UPDATE`,
			item.ProductID,
		).Scan(&available)
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("product %s not found", item.ProductID)
		}
		if err != nil {
			return nil, err
		}

		if available < item.Quantity {
			return nil, fmt.Errorf("insufficient stock for product %s: available %d, requested %d",
				item.ProductID, available, item.Quantity)
		}

		// Update inventory
		_, err = tx.ExecContext(ctx,
			`UPDATE inventory SET available = available - $1, reserved = reserved + $1, updated_at = NOW() WHERE product_id = $2`,
			item.Quantity, item.ProductID,
		)
		if err != nil {
			return nil, err
		}

		// Create reservation
		reservation := Reservation{
			ID:        uuid.New().String(),
			OrderID:   orderID,
			ProductID: item.ProductID,
			Quantity:  item.Quantity,
			Status:    "active",
			ExpiresAt: expiresAt,
			CreatedAt: time.Now().UTC(),
		}

		_, err = tx.ExecContext(ctx,
			`INSERT INTO reservations (id, order_id, product_id, quantity, status, expires_at, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			reservation.ID, reservation.OrderID, reservation.ProductID,
			reservation.Quantity, reservation.Status, reservation.ExpiresAt, reservation.CreatedAt,
		)
		if err != nil {
			return nil, err
		}

		reservations = append(reservations, reservation)
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	// Publish event
	s.publisher.Publish(ctx, events.InventoryReserved, events.InventoryReservedEvent{
		OrderID:      orderID,
		Reservations: reservations,
	})

	s.logger.Info("Stock reserved",
		"order_id", orderID,
		"items", len(items),
	)

	return reservations, nil
}

// ReleaseStock releases reserved stock
func (s *Service) ReleaseStock(ctx context.Context, orderID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Get active reservations
	rows, err := tx.QueryContext(ctx,
		`SELECT id, product_id, quantity FROM reservations WHERE order_id = $1 AND status = 'active'`,
		orderID,
	)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var id, productID string
		var quantity int
		if err := rows.Scan(&id, &productID, &quantity); err != nil {
			return err
		}

		// Release stock
		_, err = tx.ExecContext(ctx,
			`UPDATE inventory SET available = available + $1, reserved = reserved - $1, updated_at = NOW() WHERE product_id = $2`,
			quantity, productID,
		)
		if err != nil {
			return err
		}

		// Mark reservation as released
		_, err = tx.ExecContext(ctx,
			`UPDATE reservations SET status = 'released' WHERE id = $1`,
			id,
		)
		if err != nil {
			return err
		}
	}

	if err := tx.Commit(); err != nil {
		return err
	}

	// Publish event
	s.publisher.Publish(ctx, events.InventoryReleased, events.InventoryReleasedEvent{
		OrderID: orderID,
	})

	s.logger.Info("Stock released", "order_id", orderID)

	return nil
}

// ConfirmReservation confirms a reservation (order completed)
func (s *Service) ConfirmReservation(ctx context.Context, orderID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Get and confirm reservations
	rows, err := tx.QueryContext(ctx,
		`SELECT id, product_id, quantity FROM reservations WHERE order_id = $1 AND status = 'active'`,
		orderID,
	)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var id, productID string
		var quantity int
		if err := rows.Scan(&id, &productID, &quantity); err != nil {
			return err
		}

		// Reduce reserved count (already removed from available)
		_, err = tx.ExecContext(ctx,
			`UPDATE inventory SET reserved = reserved - $1, updated_at = NOW() WHERE product_id = $2`,
			quantity, productID,
		)
		if err != nil {
			return err
		}

		// Mark reservation as confirmed
		_, err = tx.ExecContext(ctx,
			`UPDATE reservations SET status = 'confirmed' WHERE id = $1`,
			id,
		)
		if err != nil {
			return err
		}
	}

	return tx.Commit()
}

// CleanupExpiredReservations releases expired reservations
func (s *Service) CleanupExpiredReservations(ctx context.Context) error {
	// Get expired reservations
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, order_id, product_id, quantity FROM reservations WHERE status = 'active' AND expires_at < NOW()`,
	)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var id, orderID, productID string
		var quantity int
		if err := rows.Scan(&id, &orderID, &productID, &quantity); err != nil {
			s.logger.Error("Failed to scan reservation", "error", err)
			continue
		}

		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			continue
		}

		// Release stock
		_, err = tx.ExecContext(ctx,
			`UPDATE inventory SET available = available + $1, reserved = reserved - $1, updated_at = NOW() WHERE product_id = $2`,
			quantity, productID,
		)
		if err != nil {
			tx.Rollback()
			continue
		}

		// Mark as expired
		_, err = tx.ExecContext(ctx,
			`UPDATE reservations SET status = 'expired' WHERE id = $1`,
			id,
		)
		if err != nil {
			tx.Rollback()
			continue
		}

		if err := tx.Commit(); err != nil {
			s.logger.Error("Failed to release expired reservation", "id", id, "error", err)
			continue
		}

		s.logger.Info("Released expired reservation",
			"reservation_id", id,
			"order_id", orderID,
			"product_id", productID,
		)
	}

	return rows.Err()
}

// Errors
var (
	ErrProductNotFound     = fmt.Errorf("product not found in inventory")
	ErrInsufficientStock   = fmt.Errorf("insufficient stock")
)
```

### Junior → FAANG: Inventory Concurrency Fundamentals

The inventory service is the most concurrency-sensitive service in the platform. Understanding why each locking decision was made here will prepare you to answer the most common FAANG interview question about e-commerce systems: "How do you prevent overselling?"

**Why `SELECT ... FOR UPDATE` instead of optimistic locking.** `FOR UPDATE` acquires a row-level lock, so any concurrent transaction that also tries to lock the same row blocks until the first transaction commits or rolls back. This is pessimistic locking: it assumes conflicts are likely. The alternative, optimistic locking, reads the current version number, updates only if the version has not changed, and retries if a concurrent update was detected. Pessimistic locking is the right choice for flash sales (very high conflict probability). Optimistic locking is better for low-contention updates (product description edits).

**Why reservations expire.** If an order is created and inventory is reserved, but the order is abandoned (the user closes the browser), the reservation holds stock indefinitely. The 30-minute expiry in `ReserveStock` and the `CleanupExpiredReservations` method release that stock automatically. In an interview, be ready to explain: "We use time-limited reservations so that stock held for abandoned orders is eventually released without manual intervention."

**Why the cleanup runs per-reservation rather than in one bulk transaction.** `CleanupExpiredReservations` processes each expired reservation in its own transaction. If one reservation fails to release (due to a transient error), the others still succeed. A single bulk transaction would roll back all releases if any one fails.

**First-job habit.** When implementing any inventory or ledger-style service, write the compensation path (release, rollback) before you write the happy path. The compensation path is harder to test and easier to get wrong under time pressure.

### Senior @ FAANG: Inventory Architecture at Flash Sale Scale

The `SELECT ... FOR UPDATE` approach works correctly for moderate concurrency. Under a flash sale, hundreds of concurrent goroutines attempt to lock the same row. PostgreSQL serializes them, so throughput collapses to a single-threaded rate for that row. At Amazon scale, this is unacceptable.

**Partitioning the lock.** The first escalation is to shard the inventory row. Instead of one row per product, maintain N rows each holding 1/N of the available stock. Reservations acquire a lock on one shard, chosen by round-robin or hash. This multiplies the write throughput by N. The implementation cost is tracking which shard a reservation came from during release and confirmation. Amazon's internal "small reservations" system uses exactly this pattern.

**Redis-based decrement for speed, database for durability.** An alternative architecture uses Redis for the hot path: `DECRBY inventory:{productID} {quantity}` is atomic and takes microseconds. The database is the source of truth, with Redis as a fast counter. A reconciliation job periodically syncs Redis counts to the database. The failure mode is Redis data loss causing a phantom stock count. Mitigated by Redis persistence (AOF with `fsync always`) and a reconciliation alarm that fires when the delta between Redis and the database exceeds a threshold.

**The reservation expiry governance problem.** `CleanupExpiredReservations` is a periodic background job. Its frequency, its lock strategy (how do you prevent two pods from cleaning up the same reservation simultaneously?), and its observability (how do you know it is running and keeping up?) are operational concerns that do not appear in the code. At FAANG, a background job with no heartbeat metric, no exclusive lock, and no dead-letter handling is an incident waiting to happen. The production version uses a database advisory lock or a Redis mutex to ensure single-executor semantics, and emits a Prometheus gauge for "expired reservations released per run" and an alert for "no cleanup run in N minutes."

**Inventory as a ledger, not a counter.** The current model is a counter: `available` decreases on reservation and increases on release. A ledger model records every inventory movement as an immutable event: `InventoryReceived(productID, quantity)`, `InventoryReserved(orderID, productID, quantity)`, `InventoryReleased(orderID, productID, quantity)`, `InventoryConfirmed(orderID, productID, quantity)`. The current count is derived by summing the ledger. This model provides a complete audit trail for every unit, which is required for accurate COGS accounting and for debugging "how did we end up with negative inventory?" incidents. The migration from counter to ledger is a schema change that should happen before the first real transaction, not during a production incident.

---
