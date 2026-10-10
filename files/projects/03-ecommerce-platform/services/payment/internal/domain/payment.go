package domain

import (
	"time"

	"github.com/google/uuid"
)

// Payment represents a payment record
type Payment struct {
	ID                    uuid.UUID
	OrderID               uuid.UUID
	StripePaymentIntentID string
	Amount                int64
	Currency              string
	Status                PaymentStatus
	Metadata              map[string]string
	CreatedAt             time.Time
	UpdatedAt             time.Time
}

// PaymentStatus represents the status of a payment
type PaymentStatus string

const (
	PaymentStatusPending                PaymentStatus = "pending"
	PaymentStatusRequiresPaymentMethod  PaymentStatus = "requires_payment_method"
	PaymentStatusRequiresConfirmation   PaymentStatus = "requires_confirmation"
	PaymentStatusProcessing             PaymentStatus = "processing"
	PaymentStatusSucceeded              PaymentStatus = "succeeded"
	PaymentStatusCancelled              PaymentStatus = "cancelled"
	PaymentStatusFailed                 PaymentStatus = "failed"
	PaymentStatusRefunded               PaymentStatus = "refunded"
	PaymentStatusPartiallyRefunded      PaymentStatus = "partially_refunded"
)

// ErrPaymentNotFound is returned when a payment is not found
var ErrPaymentNotFound = errPaymentNotFound("payment not found")

type errPaymentNotFound string

func (e errPaymentNotFound) Error() string { return string(e) }
