## Go Implementation: Host Payout Service

The payout service closes the financial loop by transferring earnings from the platform to the host after a guest checks in. Payouts are not immediate, they are scheduled 24 hours after check-in to allow a dispute window where guests can report problems. A background job runs hourly to process all due payouts by calling Stripe's payout API to transfer funds to each host's connected bank account. The 3% host service fee is deducted before the payout, and the platform retains the guest's 14% service fee separately. This delayed-payout model protects both the guest (dispute window) and the platform (fee collection).

```go
package payout

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type StripePayoutRequest struct {
	IdempotencyKey string
	Destination    string
	Amount         int64
	Currency       string
}

type StripeService interface {
	CreatePayout(ctx context.Context, req StripePayoutRequest) error
}

type TaxService interface {
}

type Booking struct {
	SubtotalCents    int64
	CleaningFeeCents int64
	HostID           string
	Currency         string
	CheckIn          time.Time
}

type PayoutMethod struct {
	StripeAccountID string
}

// PayoutService handles host payments after guest check-in
type PayoutService struct {
	db         *pgxpool.Pool
	stripeSvc  StripeService
	taxService TaxService
}

// Payout is a three-way split that must conserve value: gross is what the
// booking earned, and it is divided into the host fee the platform keeps and
// the net the host receives. Gross always equals HostFee plus Net.
type Payout struct {
	ID               string     `json:"id"`
	HostID           string     `json:"host_id"`
	BookingID        string     `json:"booking_id"`
	GrossAmountCents int64      `json:"gross_amount_cents"`
	HostFeeCents     int64      `json:"host_fee_cents"` // 3% host service fee
	NetAmountCents   int64      `json:"net_amount_cents"`
	Currency         string     `json:"currency"`
	Status           string     `json:"status"` // pending, processing, paid, failed
	ScheduledAt      time.Time  `json:"scheduled_at"`
	PaidAt           *time.Time `json:"paid_at,omitempty"`
}

// SchedulePayout creates a payout after check-in + 24h dispute window
func (s *PayoutService) SchedulePayout(ctx context.Context, bookingID string) (*Payout, error) {
	booking, err := s.getBooking(ctx, bookingID)
	if err != nil {
		return nil, err
	}

	// Gross is what the host earned: accommodation plus cleaning fee. The
	// guest's 14% service fee stays with the platform and never enters this
	// calculation, so it is read from the booking rather than subtracted out
	// of the total.
	grossCents := booking.SubtotalCents + booking.CleaningFeeCents

	// Round the fee half-up, then derive the host's net by subtraction. Only
	// one of the two can be rounded: round both and they stop summing to
	// gross, which means every payout either invents or destroys a cent and
	// the ledger stops balancing at a rate of one booking per booking.
	hostFeeCents := (grossCents*3 + 50) / 100 // 3% host fee
	netCents := grossCents - hostFeeCents

	payout := &Payout{
		ID:               generateID(),
		HostID:           booking.HostID,
		BookingID:        bookingID,
		GrossAmountCents: grossCents,
		HostFeeCents:     hostFeeCents,
		NetAmountCents:   netCents,
		Currency:         booking.Currency,
		Status:           "pending",
		ScheduledAt:      booking.CheckIn.Add(24 * time.Hour), // 24h after check-in
	}

	_, err = s.db.Exec(ctx, `
		INSERT INTO payouts (id, host_id, booking_id, gross_amount_cents, host_fee_cents, net_amount_cents, currency, status, scheduled_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)`,
		payout.ID, payout.HostID, payout.BookingID,
		payout.GrossAmountCents, payout.HostFeeCents, payout.NetAmountCents,
		payout.Currency, payout.ScheduledAt)

	return payout, err
}

// ProcessDuePayouts runs every hour to process payouts that are due.
// The claiming UPDATE with FOR UPDATE SKIP LOCKED lets multiple workers
// run concurrently without ever paying the same payout twice.
func (s *PayoutService) ProcessDuePayouts(ctx context.Context) (int, error) {
	rows, err := s.db.Query(ctx, `
		UPDATE payouts SET status = 'processing'
		WHERE id IN (
			SELECT id FROM payouts
			WHERE status = 'pending' AND scheduled_at <= NOW()
			ORDER BY scheduled_at
			LIMIT 100
			FOR UPDATE SKIP LOCKED
		)
		RETURNING id, host_id, net_amount_cents, currency`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	processed := 0
	for rows.Next() {
		var id, hostID, currency string
		var netCents int64
		rows.Scan(&id, &hostID, &netCents, &currency)

		// Get host's payout method (bank account, PayPal, etc.)
		payoutMethod, _ := s.getHostPayoutMethod(ctx, hostID)

		err := s.stripeSvc.CreatePayout(ctx, StripePayoutRequest{
			IdempotencyKey: "payout-" + id, // safe to retry after crashes
			Destination:    payoutMethod.StripeAccountID,
			// Stripe wants minor units, which is what the column already
			// holds. No conversion means no conversion bug.
			Amount:   netCents,
			Currency: currency,
		})

		if err != nil {
			s.db.Exec(ctx, "UPDATE payouts SET status = 'failed' WHERE id = $1", id)
			continue
		}

		now := time.Now()
		s.db.Exec(ctx, "UPDATE payouts SET status = 'paid', paid_at = $1 WHERE id = $2", now, id)
		processed++
	}
	return processed, nil
}

func (s *PayoutService) getBooking(ctx context.Context, bookingID string) (*Booking, error) {
	return &Booking{SubtotalCents: 10000, CleaningFeeCents: 2000, HostID: "host-1", Currency: "USD", CheckIn: time.Now()}, nil
}

func (s *PayoutService) getHostPayoutMethod(ctx context.Context, hostID string) (*PayoutMethod, error) {
	return &PayoutMethod{StripeAccountID: "acct_123"}, nil
}

func generateID() string {
	return "payout-1"
}
```

---
