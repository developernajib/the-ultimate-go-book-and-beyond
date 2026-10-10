## Failure Handling

In a distributed system handling millions of trips per day, failures are not exceptions, they are expected events. The key principle is graceful degradation: when one component fails, the system should continue operating with reduced functionality rather than stopping entirely. For example, if the ETA service goes down, the matching service falls back to a simple distance-based estimate using the Haversine formula.

Payment retries are where this gets subtle, and there are three traps worth naming before the code.

**Not every failure is retryable.** A network timeout means "unknown, ask again". A card decline means "no, and asking four more times will not change the answer". Retrying a hard decline burns an hour of backoff to arrive at the answer you already had, while the rider hears nothing. Classify first, then retry only what can change.

**The alternative card needs a different idempotency key.** This is the trap that looks like a feature. Escalating to the rider's backup card while reusing `tripID` as the key sends Stripe the same key with different parameters, and Stripe answers 400, exactly as the idempotency chapter describes. The escalation path fails 100% of the time, and it fails in the branch nobody tests, because reaching it requires three prior failures.

Scope the key to the attempt rather than the trip. `ChargeInstrument` below is the `Charge` method from the core components section with the instrument named explicitly instead of defaulting to the rider's card on file, and it keys on `trip-<tripID>-<instrument>`. Each distinct card gets its own key, so each is a legitimately different request, while retries against the same card still collapse onto the same key. The real invariant, at most one successful charge per trip no matter how many instruments were tried, is enforced where it belongs: the `trip_id` unique constraint on the payments table.

**Backoff needs jitter and a context.** `time.Sleep` in a loop cannot be canceled, so a deploy waits an hour for a goroutine that is sleeping on a trip nobody is waiting for. And fixed delays synchronize: when Stripe recovers from an outage, every retry in the fleet fires at the same instant and knocks it back down. Full jitter and a context check are the standard fix.

```go
package payment

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"math/rand"
	"time"

	"github.com/stripe/stripe-go/v76"
)

type RetryManager struct {
	pay   PaymentService
	rider RiderService
	alert AlertService
	log   *slog.Logger
}

const (
	maxAttempts = 5
	baseDelay   = time.Second
	maxDelay    = time.Hour
)

// RetryWithEscalation settles a completed trip, trying the rider's default
// instrument and then their backup.
//
// The caller is a Kafka consumer, not an HTTP handler, so this owns its own
// deadline. Running it on a request context would cancel the whole schedule the
// moment the handler returned.
func (m *RetryManager) RetryWithEscalation(ctx context.Context, tripID, riderID string, amountCents int64) error {
	instrument := "" // empty means the rider's default instrument

	for attempt := 0; attempt < maxAttempts; attempt++ {
		// Attempt first, back off after. Sleeping before the first try adds a
		// second of latency to a charge that would usually have succeeded.
		if attempt > 0 {
			if err := sleepWithJitter(ctx, attempt); err != nil {
				return err // context canceled, shutting down
			}
		}

		_, err := m.pay.ChargeInstrument(ctx, riderID, instrument, amountCents, tripID)
		if err == nil {
			return nil
		}

		// Already charged, just not confirmed yet. The webhook will resolve it,
		// and charging again here would be the double-charge we are avoiding.
		if errors.Is(err, ErrChargeIncomplete) {
			m.log.InfoContext(ctx, "charge pending, leaving to webhook", "trip", tripID)
			return nil
		}

		if isHardDecline(err) {
			// This instrument will never work. Escalate to the backup once,
			// under its own idempotency key, rather than retrying the decline.
			if instrument != "" {
				break // the backup declined too
			}
			alt, altErr := m.rider.GetAltPayment(ctx, riderID)
			if altErr != nil || alt == "" {
				break // nothing left to try
			}
			m.log.InfoContext(ctx, "escalating to backup instrument", "trip", tripID)
			instrument = alt
			continue // retry immediately: a different card, not the same request
		}

		if !isRetryable(err) {
			break
		}
		m.log.WarnContext(ctx, "charge failed, will retry", "trip", tripID, "attempt", attempt, "err", err)
	}

	// Out of options. Record the debt and let the rider settle it on their next
	// trip. Note what we do NOT do: block the account. A rider who cannot ride
	// cannot generate the fare that clears the balance, and a payments blip
	// would lock out paying customers.
	if err := m.rider.MarkPaymentDue(ctx, riderID, tripID, amountCents); err != nil {
		return fmt.Errorf("mark payment due for trip %s: %w", tripID, err)
	}
	return m.alert.Notify(ctx, fmt.Sprintf("payment unresolved: trip=%s rider=%s", tripID, riderID))
}

// sleepWithJitter waits with full jitter: rand * min(cap, base * 2^attempt).
// The randomness decorrelates retries so a recovering provider is not hit by
// the entire fleet on the same tick.
func sleepWithJitter(ctx context.Context, attempt int) error {
	backoff := math.Min(float64(maxDelay), float64(baseDelay)*math.Pow(2, float64(attempt)))
	d := time.Duration(rand.Float64() * backoff)

	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err() // cancelable, unlike time.Sleep
	case <-t.C:
		return nil
	}
}

// isHardDecline reports whether the issuer gave a final "no" for this
// instrument. Retrying these is pure waste: the answer is deterministic until
// the rider changes something we cannot change for them.
func isHardDecline(err error) bool {
	var se *stripe.Error
	if !errors.As(err, &se) || se.Type != stripe.ErrorTypeCard {
		return false
	}
	switch se.Code {
	case stripe.ErrorCodeCardDeclined,
		stripe.ErrorCodeExpiredCard,
		stripe.ErrorCodeIncorrectCVC,
		stripe.ErrorCodeInsufficientFunds:
		return true
	}
	return false
}

// isRetryable reports whether another attempt could plausibly succeed.
//
// The default matters here. An unrecognized error returns true, because an
// unknown failure might be transient and the idempotency key makes an extra
// attempt safe. Defaulting to false would silently drop charges on any error
// class we had not thought of yet.
func isRetryable(err error) bool {
	var se *stripe.Error
	if !errors.As(err, &se) {
		return true // network or transport error: unknown outcome, ask again
	}
	switch se.Type {
	case stripe.ErrorTypeCard:
		// Not a hard decline (checked first), so something like a temporary
		// processing error, which is worth one more try.
		return se.Code == stripe.ErrorCodeProcessingError
	case stripe.ErrorTypeIdempotency:
		// The key was reused with different parameters. This is the 400 the
		// escalation trap produces, and it is a bug in our code, not a blip.
		// Retrying sends the identical broken request forever.
		return false
	case stripe.ErrorTypeInvalidRequest:
		return false // malformed request, deterministic
	case stripe.ErrorTypeAPI:
		return true // Stripe-side problem, retry with backoff
	}
	return true
}
```

| Failure | Degradation |
|---------|-------------|
| Redis location lost | Drivers re-register in 4s |
| Matching down | Queue requests, notify delay |
| Surge unavailable | Default 1.0x, never the cap |
| ETA down | Haversine heuristic |
| Payment down | Complete trip, queue retry, pay the driver regardless |
| Maps API down | Cached traffic matrices |
| WebSocket crash | Auto-reconnect, resume from current position |

Read down the Degradation column and notice that every fallback is chosen so its worst case is affordable. Surge defaults to 1.0x rather than the 3.0x cap because losing revenue during an outage beats overcharging an entire market. Drivers are paid even when the rider's card fails, because collection risk belongs to the platform, not to the person who did the work. Reconnects resume at the current position rather than replaying the queue, because a rider wants to know where the car is, not where it was.

The general form: a fallback is not "what the code does when it breaks", it is a decision about which failure you would rather explain. Pick the direction whose worst case you can absorb, and write down why, because the next person to touch the code will see a default and assume it was arbitrary.

---
