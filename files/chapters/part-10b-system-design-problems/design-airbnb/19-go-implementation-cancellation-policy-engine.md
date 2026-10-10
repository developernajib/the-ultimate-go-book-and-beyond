## Go Implementation: Cancellation Policy Engine

Cancellation policies are a core part of the Airbnb product because they balance guest flexibility with host income protection. Each listing has one of four policies (flexible, moderate, strict, or super-strict), and the refund calculation depends on how far in advance the guest cancels relative to the check-in date. This engine encapsulates all the refund logic in a single, testable function. Notice that the service fee is handled separately, Airbnb refunds the 14% service fee if the guest cancels more than 3 days before check-in, regardless of the listing's cancellation policy.

This is the function in the chapter where integer money earns its keep. A refund is a **split**: every cent the guest paid either goes back to the guest or stays with the platform and host, and those two numbers must add back to exactly what was charged. Percentages are what break that invariant. Compute the refund at 50% and the retained amount at 50% independently and an odd-cent total leaves you a cent short or a cent long, in a ledger where both directions are a defect.

Two rules keep the split honest. The refund rounds half-up, favoring the guest on the half-cent, because a cancellation is already a bad day and the platform can afford to lose the tie. Then the retained amount is computed by **subtraction** rather than by its own percentage, so it absorbs whatever the rounding did and the two parts sum to the total by construction rather than by luck.

The booking carries its money components separately, which is what makes this tractable. An earlier version of this engine backed the service fee out of the total with `total * 0.14 / 1.14`, and that expression is wrong twice over: it is a float, and it silently assumes the total is nothing but accommodation plus fee, which stopped being true the moment a cleaning fee joined the total. Read the stored component instead of reverse-engineering it.

```go
package cancellation

import (
	"context"
	"fmt"
	"time"
)

type Booking struct {
	CancellationPolicy string
	CheckIn            time.Time
	SubtotalCents      int64
	CleaningFeeCents   int64
	ServiceFeeCents    int64
	TotalCents         int64
	Currency           string
}

type BookingStore interface {
	Get(ctx context.Context, bookingID string) (*Booking, error)
}

// CancellationPolicyEngine computes refund amounts based on policy
type CancellationPolicyEngine struct {
	bookingDB BookingStore
}

type CancellationPolicy string

const (
	PolicyFlexible CancellationPolicy = "flexible"  // Full refund 24h before check-in
	PolicyModerate CancellationPolicy = "moderate"  // Full refund 5 days before
	PolicyStrict   CancellationPolicy = "strict"    // 50% refund up to 7 days before
	PolicySuperStrict CancellationPolicy = "super_strict" // Non-refundable
)

type RefundCalculation struct {
	Policy CancellationPolicy `json:"policy"`
	// RefundPct is a whole percent (0, 50, 100). Every policy in the product
	// is a whole percent, so an int says what a float64 only approximates.
	RefundPct         int64     `json:"refund_percentage"`
	RefundCents       int64     `json:"refund_cents"`
	// RetainedCents is what the platform and host keep. It is derived by
	// subtraction, never by its own percentage, so RefundCents plus
	// RetainedCents always equals the booking total exactly.
	RetainedCents     int64     `json:"retained_cents"`
	Currency          string    `json:"currency"`
	Reasoning         string    `json:"reasoning"`
	Deadline          time.Time `json:"deadline"`
}

func (e *CancellationPolicyEngine) CalculateRefund(ctx context.Context, bookingID string) (*RefundCalculation, error) {
	booking, err := e.bookingDB.Get(ctx, bookingID)
	if err != nil {
		return nil, err
	}

	policy := CancellationPolicy(booking.CancellationPolicy)
	hoursUntilCheckIn := time.Until(booking.CheckIn).Hours()

	calc := &RefundCalculation{Policy: policy}

	switch policy {
	case PolicyFlexible:
		if hoursUntilCheckIn > 24 {
			calc.RefundPct = 100
			calc.Reasoning = "Full refund: canceled more than 24 hours before check-in"
		} else {
			calc.RefundPct = 0
			calc.Reasoning = "No refund: canceled within 24 hours of check-in"
		}
		calc.Deadline = booking.CheckIn.Add(-24 * time.Hour)

	case PolicyModerate:
		if hoursUntilCheckIn > 5*24 {
			calc.RefundPct = 100
			calc.Reasoning = "Full refund: canceled more than 5 days before check-in"
		} else if hoursUntilCheckIn > 24 {
			calc.RefundPct = 50
			calc.Reasoning = "50% refund: canceled 1-5 days before check-in"
		} else {
			calc.RefundPct = 0
			calc.Reasoning = "No refund: canceled within 24 hours of check-in"
		}
		calc.Deadline = booking.CheckIn.Add(-5 * 24 * time.Hour)

	case PolicyStrict:
		if hoursUntilCheckIn > 7*24 {
			calc.RefundPct = 50
			calc.Reasoning = "50% refund: canceled more than 7 days before check-in"
		} else {
			calc.RefundPct = 0
			calc.Reasoning = "No refund: canceled within 7 days of check-in (strict policy)"
		}
		calc.Deadline = booking.CheckIn.Add(-7 * 24 * time.Hour)

	case PolicySuperStrict:
		calc.RefundPct = 0
		calc.Reasoning = "Non-refundable booking"

	default:
		return nil, fmt.Errorf("unknown policy: %s", policy)
	}

	// The policy percentage applies to the accommodation portion only, which
	// is the subtotal plus the cleaning fee. The guest service fee follows
	// its own rule: refunded in full when the guest cancels more than 3 days
	// before check-in, regardless of policy.
	//
	// Both components are read from the booking, not derived from the total.
	accommodationCents := booking.SubtotalCents + booking.CleaningFeeCents

	// Half-up, favoring the guest on the exact half cent. On a 50% refund of
	// a $300.01 accommodation this is (30001*50 + 50) / 100 = 15001 cents.
	calc.RefundCents = (accommodationCents*calc.RefundPct + 50) / 100

	if hoursUntilCheckIn > 3*24 {
		calc.RefundCents += booking.ServiceFeeCents
	}

	// Derive the retained side by subtraction. This is what guarantees the
	// split conserves value: whatever the rounding above did, these two
	// numbers still sum to exactly what the guest was charged. At a 100%
	// refund within the fee window, RefundCents equals TotalCents and the
	// platform retains nothing, which is the correct answer and one that
	// falls out of the arithmetic rather than needing a special case.
	calc.RetainedCents = booking.TotalCents - calc.RefundCents
	calc.Currency = booking.Currency

	return calc, nil
}
```

---
