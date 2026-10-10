package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/example/ecommerce-platform/services/payment/internal/domain"
)

// PaymentRepository handles payment persistence
type PaymentRepository struct {
	pool *pgxpool.Pool
}

// NewPaymentRepository creates a new PaymentRepository
func NewPaymentRepository(pool *pgxpool.Pool) *PaymentRepository {
	return &PaymentRepository{pool: pool}
}

// Create creates a new payment
func (r *PaymentRepository) Create(ctx context.Context, payment *domain.Payment) error {
	query := `
		INSERT INTO payments (
			id, order_id, stripe_payment_intent_id, amount, currency,
			status, metadata, created_at, updated_at
		) VALUES (
			$1, $2, $3, $4, $5, $6, $7, $8, $9
		)
	`

	_, err := r.pool.Exec(ctx, query,
		payment.ID,
		payment.OrderID,
		payment.StripePaymentIntentID,
		payment.Amount,
		payment.Currency,
		payment.Status,
		payment.Metadata,
		payment.CreatedAt,
		payment.UpdatedAt,
	)

	if err != nil {
		return fmt.Errorf("creating payment: %w", err)
	}

	return nil
}

// GetByID retrieves a payment by ID
func (r *PaymentRepository) GetByID(ctx context.Context, id uuid.UUID) (*domain.Payment, error) {
	query := `
		SELECT id, order_id, stripe_payment_intent_id, amount, currency,
			status, metadata, created_at, updated_at
		FROM payments
		WHERE id = $1
	`

	var payment domain.Payment
	err := r.pool.QueryRow(ctx, query, id).Scan(
		&payment.ID,
		&payment.OrderID,
		&payment.StripePaymentIntentID,
		&payment.Amount,
		&payment.Currency,
		&payment.Status,
		&payment.Metadata,
		&payment.CreatedAt,
		&payment.UpdatedAt,
	)

	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domain.ErrPaymentNotFound
		}
		return nil, fmt.Errorf("getting payment: %w", err)
	}

	return &payment, nil
}

// GetByStripePaymentIntentID retrieves a payment by Stripe payment intent ID
func (r *PaymentRepository) GetByStripePaymentIntentID(ctx context.Context, paymentIntentID string) (*domain.Payment, error) {
	query := `
		SELECT id, order_id, stripe_payment_intent_id, amount, currency,
			status, metadata, created_at, updated_at
		FROM payments
		WHERE stripe_payment_intent_id = $1
	`

	var payment domain.Payment
	err := r.pool.QueryRow(ctx, query, paymentIntentID).Scan(
		&payment.ID,
		&payment.OrderID,
		&payment.StripePaymentIntentID,
		&payment.Amount,
		&payment.Currency,
		&payment.Status,
		&payment.Metadata,
		&payment.CreatedAt,
		&payment.UpdatedAt,
	)

	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domain.ErrPaymentNotFound
		}
		return nil, fmt.Errorf("getting payment by stripe ID: %w", err)
	}

	return &payment, nil
}

// Update updates a payment
func (r *PaymentRepository) Update(ctx context.Context, payment *domain.Payment) error {
	query := `
		UPDATE payments
		SET status = $2, metadata = $3, updated_at = $4
		WHERE id = $1
	`

	_, err := r.pool.Exec(ctx, query,
		payment.ID,
		payment.Status,
		payment.Metadata,
		time.Now(),
	)

	if err != nil {
		return fmt.Errorf("updating payment: %w", err)
	}

	return nil
}
