package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/example/ecommerce-platform/services/product/internal/domain"
)

// InventoryRepository handles inventory and reservation persistence
type InventoryRepository struct {
	pool *pgxpool.Pool
}

// NewInventoryRepository creates a new InventoryRepository
func NewInventoryRepository(pool *pgxpool.Pool) *InventoryRepository {
	return &InventoryRepository{pool: pool}
}

// CheckInventory checks if inventory is available
func (r *InventoryRepository) CheckInventory(
	ctx context.Context,
	productID uuid.UUID,
	variantID *uuid.UUID,
	quantity int32,
) (bool, int32, error) {
	var currentInventory int32

	if variantID != nil {
		query := `SELECT inventory FROM product_variants WHERE id = $1`
		err := r.pool.QueryRow(ctx, query, *variantID).Scan(&currentInventory)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return false, 0, domain.ErrProductNotFound
			}
			return false, 0, fmt.Errorf("checking variant inventory: %w", err)
		}
	} else {
		query := `SELECT inventory FROM products WHERE id = $1`
		err := r.pool.QueryRow(ctx, query, productID).Scan(&currentInventory)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return false, 0, domain.ErrProductNotFound
			}
			return false, 0, fmt.Errorf("checking product inventory: %w", err)
		}
	}

	reservedQuery := `
		SELECT COALESCE(SUM(quantity), 0)
		FROM inventory_reservations
		WHERE product_id = $1
			AND ($2::uuid IS NULL OR variant_id = $2)
			AND status = $3
			AND expires_at > NOW()
	`
	var reserved int32
	if err := r.pool.QueryRow(ctx, reservedQuery, productID, variantID, domain.ReservationStatusPending).Scan(&reserved); err != nil {
		return false, 0, fmt.Errorf("checking reserved inventory: %w", err)
	}

	available := currentInventory - reserved
	return available >= quantity, available, nil
}

// ReserveInventory creates an inventory reservation
func (r *InventoryRepository) ReserveInventory(
	ctx context.Context,
	reservationID uuid.UUID,
	productID uuid.UUID,
	variantID *uuid.UUID,
	quantity int32,
	expiresAt time.Time,
) error {
	available, _, err := r.CheckInventory(ctx, productID, variantID, quantity)
	if err != nil {
		return err
	}
	if !available {
		return domain.ErrInsufficientInventory
	}

	query := `
		INSERT INTO inventory_reservations (
			id, product_id, variant_id, quantity, expires_at, status, created_at
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7
		)
	`

	_, err = r.pool.Exec(ctx, query,
		reservationID,
		productID,
		variantID,
		quantity,
		expiresAt,
		domain.ReservationStatusPending,
		time.Now(),
	)

	if err != nil {
		return fmt.Errorf("creating reservation: %w", err)
	}

	return nil
}

// ReleaseInventory releases a reservation
func (r *InventoryRepository) ReleaseInventory(ctx context.Context, reservationID uuid.UUID) error {
	query := `
		UPDATE inventory_reservations
		SET status = $2
		WHERE id = $1 AND status = $3
	`

	result, err := r.pool.Exec(ctx, query,
		reservationID,
		domain.ReservationStatusReleased,
		domain.ReservationStatusPending,
	)

	if err != nil {
		return fmt.Errorf("releasing reservation: %w", err)
	}

	if result.RowsAffected() == 0 {
		return domain.ErrReservationNotFound
	}

	return nil
}

// CommitInventory commits a reservation and reduces actual inventory
func (r *InventoryRepository) CommitInventory(ctx context.Context, reservationID uuid.UUID) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}
	defer tx.Rollback(ctx)

	var reservation domain.InventoryReservation
	query := `
		SELECT product_id, variant_id, quantity, status, expires_at
		FROM inventory_reservations
		WHERE id = $1
		FOR UPDATE
	`

	err = tx.QueryRow(ctx, query, reservationID).Scan(
		&reservation.ProductID,
		&reservation.VariantID,
		&reservation.Quantity,
		&reservation.Status,
		&reservation.ExpiresAt,
	)

	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ErrReservationNotFound
		}
		return fmt.Errorf("getting reservation: %w", err)
	}

	if reservation.Status != domain.ReservationStatusPending {
		return domain.ErrReservationAlreadyUsed
	}

	if time.Now().After(reservation.ExpiresAt) {
		return domain.ErrReservationExpired
	}

	var updateQuery string
	if reservation.VariantID != nil {
		updateQuery = `
			UPDATE product_variants
			SET inventory = inventory - $1
			WHERE id = $2 AND inventory >= $1
		`
	} else {
		updateQuery = `
			UPDATE products
			SET inventory = inventory - $1
			WHERE id = $2 AND inventory >= $1
		`
	}

	var targetID uuid.UUID
	if reservation.VariantID != nil {
		targetID = *reservation.VariantID
	} else {
		targetID = reservation.ProductID
	}

	result, err := tx.Exec(ctx, updateQuery, reservation.Quantity, targetID)
	if err != nil {
		return fmt.Errorf("updating inventory: %w", err)
	}

	if result.RowsAffected() == 0 {
		return domain.ErrInsufficientInventory
	}

	updateReservationQuery := `
		UPDATE inventory_reservations
		SET status = $2
		WHERE id = $1
	`

	_, err = tx.Exec(ctx, updateReservationQuery, reservationID, domain.ReservationStatusCommitted)
	if err != nil {
		return fmt.Errorf("updating reservation: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("committing transaction: %w", err)
	}

	return nil
}

// CleanupExpiredReservations removes expired reservations
func (r *InventoryRepository) CleanupExpiredReservations(ctx context.Context) error {
	query := `
		UPDATE inventory_reservations
		SET status = $1
		WHERE status = $2 AND expires_at < NOW()
	`

	_, err := r.pool.Exec(ctx, query, domain.ReservationStatusExpired, domain.ReservationStatusPending)
	if err != nil {
		return fmt.Errorf("cleaning up expired reservations: %w", err)
	}

	return nil
}
