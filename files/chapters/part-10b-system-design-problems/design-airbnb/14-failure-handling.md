## Failure Handling

### Payment Failure Recovery

In a distributed booking flow, partial failures are inevitable, a payment might authorize successfully but the confirmation step could fail due to a network partition, or a process could crash mid-transaction. The recovery service below runs as a periodic background job every five minutes, scanning for bookings stuck in the "authorized" state. It reconciles each stuck booking by checking the actual payment status with Stripe and then either confirming, canceling, or expiring the booking accordingly. This pattern ensures that no booking stays in an inconsistent state indefinitely.

```go
package resilience

import (
	"context"
	"time"
)

type Booking struct {
	ID        string
	PaymentID string
	CreatedAt time.Time
}

type BookingStore interface {
	FindByStatus(ctx context.Context, status string, duration time.Duration) ([]Booking, error)
	UpdateStatus(ctx context.Context, id string, status string) error
}

type AvailabilityService interface {
	EnsureBlocked(ctx context.Context, booking *Booking) error
	ReleaseBooking(ctx context.Context, bookingID string)
}

type PaymentService interface {
	CheckStatus(ctx context.Context, paymentID string) (string, error)
	Refund(ctx context.Context, paymentID string) error
	Void(ctx context.Context, paymentID string) error
}

type NotificationService interface {
	BookingCanceled(ctx context.Context, booking *Booking)
	BookingConfirmed(ctx context.Context, booking *Booking)
}

// BookingRecoveryService fixes stuck bookings
// Runs every 5 minutes
type BookingRecoveryService struct {
	bookingDB  BookingStore
	availSvc   AvailabilityService
	paymentSvc PaymentService
	notifier   NotificationService
}

func (s *BookingRecoveryService) RecoverStuckBookings(ctx context.Context) error {
	// Find bookings in "authorized" status for > 10 minutes
	stuck, _ := s.bookingDB.FindByStatus(ctx, "authorized", 10*time.Minute)

	for _, booking := range stuck {
		status, err := s.paymentSvc.CheckStatus(ctx, booking.PaymentID)
		if err != nil {
			continue
		}

		switch status {
		case "captured":
			// Payment went through: make sure the calendar block exists
			// before declaring the booking confirmed.
			if err := s.availSvc.EnsureBlocked(ctx, &booking); err != nil {
				// Another guest won the dates in the meantime: refund
				s.paymentSvc.Refund(ctx, booking.PaymentID)
				s.bookingDB.UpdateStatus(ctx, booking.ID, "canceled")
				s.notifier.BookingCanceled(ctx, &booking)
				continue
			}
			s.bookingDB.UpdateStatus(ctx, booking.ID, "confirmed")
			s.notifier.BookingConfirmed(ctx, &booking)
		case "failed", "voided":
			s.availSvc.ReleaseBooking(ctx, booking.ID)
			s.bookingDB.UpdateStatus(ctx, booking.ID, "canceled")
		case "authorized":
			if time.Since(booking.CreatedAt) > 30*time.Minute {
				s.paymentSvc.Void(ctx, booking.PaymentID)
				s.availSvc.ReleaseBooking(ctx, booking.ID)
				s.bookingDB.UpdateStatus(ctx, booking.ID, "expired")
			}
		}
	}
	return nil
}
```

### Double-Booking Prevention (Three Layers)

Preventing double-bookings is the single most important correctness guarantee in a rental marketplace. A single layer of protection is not enough because each layer can fail independently, Redis might lose a key during failover, a database transaction might hit a race condition, or an application bug might skip a check. The three-layer approach below provides defense in depth: Redis handles the fast, optimistic path during checkout. The PostgreSQL confirmation transaction (per-listing advisory lock, overlap re-check, and the schema's exclusion constraint) catches anything Redis misses, and a nightly batch reconciliation job serves as the final safety net to detect and resolve any anomalies.

```
Layer 1: Redis SETNX hold (optimistic, fast)
  During checkout, hold dates with NX flag -- first requester wins
  TTL: 10 minutes, auto-expires if checkout abandoned

Layer 2: PostgreSQL confirmation transaction
  Take a per-listing advisory lock, re-check blocked_dates for overlap,
  then insert. A gist exclusion constraint on (listing_id, daterange)
  rejects overlaps even if the application check is bypassed

Layer 3: Application-level reconciliation
  Nightly batch job checks for any overlapping blocked_dates
  If found (should never happen), alert engineering + auto-cancel newer booking
```

---
