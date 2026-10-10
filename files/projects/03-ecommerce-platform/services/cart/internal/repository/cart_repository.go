package repository

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/example/ecommerce-platform/services/cart/internal/domain"
)

// CartRepository handles cart persistence
type CartRepository struct {
	pool *pgxpool.Pool
}

// NewCartRepository creates a new CartRepository
func NewCartRepository(pool *pgxpool.Pool) *CartRepository {
	return &CartRepository{pool: pool}
}

// Create creates a new cart
func (r *CartRepository) Create(ctx context.Context, cart *domain.Cart) error {
	query := `
		INSERT INTO carts (id, user_id, coupon_code, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5)
	`

	_, err := r.pool.Exec(ctx, query,
		cart.ID,
		cart.UserID,
		cart.CouponCode,
		cart.CreatedAt,
		cart.UpdatedAt,
	)

	if err != nil {
		return fmt.Errorf("creating cart: %w", err)
	}

	return nil
}

// GetByUserID retrieves a cart by user ID
func (r *CartRepository) GetByUserID(ctx context.Context, userID uuid.UUID) (*domain.Cart, error) {
	query := `
		SELECT id, user_id, coupon_code, created_at, updated_at
		FROM carts
		WHERE user_id = $1
	`

	var cart domain.Cart
	err := r.pool.QueryRow(ctx, query, userID).Scan(
		&cart.ID,
		&cart.UserID,
		&cart.CouponCode,
		&cart.CreatedAt,
		&cart.UpdatedAt,
	)

	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domain.ErrCartNotFound
		}
		return nil, fmt.Errorf("getting cart: %w", err)
	}

	return &cart, nil
}

// Update updates a cart
func (r *CartRepository) Update(ctx context.Context, cart *domain.Cart) error {
	query := `
		UPDATE carts
		SET coupon_code = $2, updated_at = $3
		WHERE id = $1
	`

	_, err := r.pool.Exec(ctx, query,
		cart.ID,
		cart.CouponCode,
		cart.UpdatedAt,
	)

	if err != nil {
		return fmt.Errorf("updating cart: %w", err)
	}

	return nil
}
