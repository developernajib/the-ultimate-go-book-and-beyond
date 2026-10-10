## Production Go Implementation: Weekly Settlement Service

Drivers do not receive payment instantly for each trip, instead, their earnings accumulate throughout the week and are settled in a single batch transfer every Monday. This reduces transaction fees (one transfer instead of hundreds) and simplifies accounting.

This service moves real money to real people, so the ordering of its steps is the whole design. The tempting order is: total the earnings, send the transfer, then mark the earnings settled. It is wrong, and it fails in the most expensive direction available.

Marking the earnings settled *after* the transfer leaves a window where the money has moved but the ledger does not know it. Any failure in that window (a dropped connection during the mark loop, a pod evicted mid-batch, one `MarkSettled` returning an error the code discards) leaves earnings still flagged unsettled. Nothing looks broken. Nobody gets paged. Then next Monday the job finds those same earnings, includes them in a new batch, and pays for the same trips a second time. In the demonstration for this section, a single dropped connection halfway through the mark loop turned $116 of earnings into $176 of payouts, and the only evidence was two rows that still said `settlement_id IS NULL`.

Invert it. Claim the earnings first, in the same transaction that creates the batch, so the ledger commits before any money moves. Then transfer, keyed on the batch ID for idempotency. Now the failure modes are all survivable: crash before the claim and nothing happened, crash after the claim and the batch sits in `pending` for a recovery pass to finish, and because the transfer carries the batch ID as its idempotency key, retrying it cannot send twice. The invariant to protect is not "always pay the driver", it is "never pay twice for the same work", and the way you get it is by making the claim durable before the payout is attempted.

```go
package settlement

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
)

// minPayoutCents is the floor for a transfer. Earnings below it roll into next
// week rather than being dropped: they stay unclaimed, so the next run picks
// them up automatically.
const minPayoutCents = 100

// SettlementService handles weekly driver payouts
type SettlementService struct {
	earningsDB EarningsStore
	settleDB   SettlementStore
	payoutSvc  PayoutService // ACH/Stripe Connect
	log        *slog.Logger
}

type SettlementBatch struct {
	ID              string    `json:"id"`
	DriverID        string    `json:"driver_id"`
	PeriodStart     time.Time `json:"period_start"`
	PeriodEnd       time.Time `json:"period_end"`
	TripCount       int       `json:"trip_count"`
	GrossCents      int64     `json:"gross_cents"`
	DeductionsCents int64     `json:"deductions_cents"` // promotions, adjustments
	NetCents        int64     `json:"net_cents"`
	Status          string    `json:"status"`      // "pending", "completed", "failed"
	TransferID      string    `json:"transfer_id"` // provider's ID, for reconciliation
}

// ProcessWeeklySettlements runs every Monday at 00:00 UTC.
func (s *SettlementService) ProcessWeeklySettlements(ctx context.Context) error {
	// Truncate works on absolute time since the epoch, so Truncate(24h) is a
	// UTC day boundary regardless of the machine's zone. That is what we want
	// here, but only because the schedule is defined in UTC. Never use it to
	// find local midnight: it does not respect zones or DST.
	weekEnd := time.Now().UTC().Truncate(24 * time.Hour)
	weekStart := weekEnd.AddDate(0, 0, -7)

	// Finish anything a previous run left half-done before starting new work.
	if err := s.recoverPending(ctx); err != nil {
		return fmt.Errorf("recover pending settlements: %w", err)
	}

	drivers, err := s.earningsDB.GetDriversWithUnsettledEarnings(ctx, weekStart, weekEnd)
	if err != nil {
		return fmt.Errorf("get drivers: %w", err)
	}

	var failed int
	for _, driverID := range drivers {
		if err := s.settleDriver(ctx, driverID, weekStart, weekEnd); err != nil {
			// One driver's failure must not halt the payroll for everyone else,
			// but it must be counted and surfaced, not printed and forgotten.
			s.log.ErrorContext(ctx, "settlement failed", "driver", driverID, "err", err)
			failed++
		}
	}
	if failed > 0 {
		return fmt.Errorf("%d of %d driver settlements failed", failed, len(drivers))
	}
	return nil
}

func (s *SettlementService) settleDriver(ctx context.Context, driverID string, start, end time.Time) error {
	earnings, err := s.earningsDB.GetUnsettled(ctx, driverID, start, end)
	if err != nil {
		return fmt.Errorf("get unsettled: %w", err)
	}

	var grossCents int64
	ids := make([]string, 0, len(earnings))
	for _, e := range earnings {
		grossCents += e.AmountCents
		ids = append(ids, e.ID)
	}

	if grossCents < minPayoutCents {
		return nil // rolls over to next week, still unclaimed
	}

	deductions, err := s.earningsDB.PendingDeductions(ctx, driverID, start, end)
	if err != nil {
		return fmt.Errorf("get deductions: %w", err)
	}

	batch := &SettlementBatch{
		ID:              uuid.NewString(),
		DriverID:        driverID,
		PeriodStart:     start,
		PeriodEnd:       end,
		TripCount:       len(earnings),
		GrossCents:      grossCents,
		DeductionsCents: deductions,
		NetCents:        grossCents - deductions,
		Status:          "pending",
	}
	if batch.NetCents <= 0 {
		return nil // deductions consumed the week's earnings
	}

	// STEP 1: claim. Creates the batch row and stamps settlement_id onto every
	// earnings row in ONE transaction. After this commits, no future run can
	// see these earnings as unsettled, so no future run can pay them again.
	// The uniq_driver_period constraint rejects a second batch for the same
	// week, which is what makes re-running this job safe.
	if err := s.settleDB.CreateAndClaim(ctx, batch, ids); err != nil {
		if errors.Is(err, ErrPeriodAlreadySettled) {
			return nil // another run already handled this driver-week
		}
		return fmt.Errorf("claim earnings: %w", err)
	}

	// STEP 2: transfer. batch.ID is the idempotency key, so if we crash between
	// here and step 3, the recovery pass retries with the same key and the
	// provider returns the original transfer rather than sending a second one.
	transferID, err := s.payoutSvc.InitiateTransfer(ctx, driverID, batch.NetCents, batch.ID)
	if err != nil {
		// The claim stays in place deliberately. Releasing it here would put the
		// earnings back in the pool while a transfer we are unsure about may
		// still be in flight, which is how you pay twice. Leave the batch failed
		// and let a human or the recovery pass resolve it.
		batch.Status = "failed"
		if uErr := s.settleDB.Update(ctx, batch); uErr != nil {
			return fmt.Errorf("payout failed (%w) and batch update failed: %v", err, uErr)
		}
		return fmt.Errorf("payout: %w", err)
	}

	// STEP 3: record. Keep the provider's transfer ID. Without it the batch
	// cannot be reconciled against the bank statement, and reconciliation is
	// the only thing that ever proves this service is correct.
	batch.TransferID = transferID
	batch.Status = "completed"
	if err := s.settleDB.Update(ctx, batch); err != nil {
		return fmt.Errorf("record transfer %s for batch %s: %w", transferID, batch.ID, err)
	}
	return nil
}

// recoverPending finishes batches that claimed earnings but never reached a
// terminal state, which is what a crash between steps 1 and 3 leaves behind.
// Retrying is safe precisely because the transfer is keyed on the batch ID.
func (s *SettlementService) recoverPending(ctx context.Context) error {
	pending, err := s.settleDB.GetPending(ctx)
	if err != nil {
		return err
	}
	for _, batch := range pending {
		transferID, err := s.payoutSvc.InitiateTransfer(ctx, batch.DriverID, batch.NetCents, batch.ID)
		if err != nil {
			s.log.ErrorContext(ctx, "recovery transfer failed", "batch", batch.ID, "err", err)
			continue
		}
		batch.TransferID = transferID
		batch.Status = "completed"
		if err := s.settleDB.Update(ctx, batch); err != nil {
			s.log.ErrorContext(ctx, "recovery update failed", "batch", batch.ID, "err", err)
		}
	}
	return nil
}
```

The deductions column is worth one more note. The original version of this service set `NetAmount: totalAmount` with a comment saying deductions were "applied separately", which meant the field existed, was always zero, and was reported to drivers as if it meant something. A field that is always zero is worse than a missing field, because everything downstream trusts it. Either compute it or delete it.

---
