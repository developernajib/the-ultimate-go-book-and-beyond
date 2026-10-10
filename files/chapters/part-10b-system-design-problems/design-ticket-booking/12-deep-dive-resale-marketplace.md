## Deep Dive: Resale Marketplace

A resale marketplace lets ticket holders sell tickets they can no longer use, while protecting buyers from scalping. The key business rule is the anti-scalping price cap: sellers cannot list tickets for more than 120% of face value. When a ticket is listed for resale, it is "frozen" so the original owner cannot use it while it is on the market. On purchase, ownership transfers atomically, and a new QR code is generated (invalidating the old one) to prevent the seller from still entering the venue.

```go
package resale

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ResaleListing struct {
	ID               string    `json:"id"`
	TicketID         string    `json:"ticket_id"`
	EventID          string    `json:"event_id"`
	SellerID         string    `json:"seller_id"`
	Section          string    `json:"section"`
	Row              string    `json:"row"`
	SeatNumber       int       `json:"seat_number"`
	FaceValueCents   int64     `json:"face_value_cents"`
	AskingPriceCents int64     `json:"asking_price_cents"`
	Status           string    `json:"status"` // active, sold, canceled
	CreatedAt        time.Time `json:"created_at"`
}

// resaleCapPercent is the anti-scalping ceiling: a listing may not exceed this
// percentage of face value. Mirrored by a CHECK constraint on the table.
const resaleCapPercent = 120

// ListForResale freezes a ticket and puts it on the market, subject to the
// anti-scalping price cap.
//
// Everything happens in one transaction, and ownership is proven by the UPDATE
// rather than by a prior read. Fetching the ticket, comparing OwnerID in Go,
// and then freezing it is a read-then-write race: two concurrent list requests
// for the same ticket both read 'active', both pass the ownership check, and
// both insert a listing. The ticket then sells twice, and one of the two
// buyers is turned away at the gate.
func ListForResale(ctx context.Context, db *pgxpool.Pool, ticketID, sellerID string, askingPriceCents int64) (*ResaleListing, error) {
	if askingPriceCents <= 0 {
		return nil, fmt.Errorf("asking price must be positive")
	}

	tx, err := db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// Claim the ticket: proves ownership, proves it is not already listed,
	// used, or transferred, and freezes it, in one atomic compare-and-set.
	var eventID, seatID string
	err = tx.QueryRow(ctx, `
		UPDATE tickets SET status = 'listed'
		WHERE id = $1 AND user_id = $2 AND status = 'active' AND is_used = false
		RETURNING event_id, seat_id`,
		ticketID, sellerID).Scan(&eventID, &seatID)
	if err != nil {
		return nil, fmt.Errorf("ticket is not yours to list, or is already listed or used")
	}

	// Face value comes from the seat record, never from the client.
	var faceValueCents int64
	var section, row string
	var seatNumber int
	if err := tx.QueryRow(ctx, `
		SELECT price_cents, section, row, seat_number
		FROM seats WHERE event_id = $1 AND id = $2`,
		eventID, seatID).Scan(&faceValueCents, &section, &row, &seatNumber); err != nil {
		return nil, fmt.Errorf("load face value: %w", err)
	}

	// Integer cap, truncating down, so the ceiling is never rounded up past
	// the policy: 120% of $67.50 is 8100 cents exactly, and a float 1.2
	// multiply is how a cap becomes 8100.000000000001.
	maxCents := faceValueCents * resaleCapPercent / 100
	if askingPriceCents > maxCents {
		return nil, fmt.Errorf("max price is %d.%02d (%d%% of face value)",
			maxCents/100, maxCents%100, resaleCapPercent)
	}

	listing := &ResaleListing{
		ID:               uuid.NewString(),
		TicketID:         ticketID,
		EventID:          eventID,
		SellerID:         sellerID,
		Section:          section,
		Row:              row,
		SeatNumber:       seatNumber,
		FaceValueCents:   faceValueCents,
		AskingPriceCents: askingPriceCents,
		Status:           "active",
		CreatedAt:        time.Now(),
	}

	// The partial unique index on (ticket_id) WHERE status = 'active' is the
	// backstop: if the CAS above were ever weakened, this still refuses the
	// second listing.
	if _, err := tx.Exec(ctx, `
		INSERT INTO resale_listings
			(id, ticket_id, event_id, seller_id, section, row, seat_number,
			 face_value_cents, asking_price_cents, status, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', NOW())`,
		listing.ID, listing.TicketID, listing.EventID, listing.SellerID,
		listing.Section, listing.Row, listing.SeatNumber,
		listing.FaceValueCents, listing.AskingPriceCents,
	); err != nil {
		return nil, fmt.Errorf("create listing: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return listing, nil
}

// splitResaleProceeds divides what the buyer paid between the platform and the
// seller. The invariant is that the two parts add back to exactly what was
// charged: subtracting the commission rather than computing the payout
// independently means no rounding rule can invent or destroy a cent.
func splitResaleProceeds(askingPriceCents int64) (commission, payout int64) {
	commission = (askingPriceCents*commissionPercent + 50) / 100 // round half up
	return commission, askingPriceCents - commission
}

const commissionPercent = 10

// On purchase, in one transaction: mark the listing sold, move the ticket to
// the buyer, record a ticket_transfers row, and re-sign the barcode against the
// new owner so the seller's old QR code stops validating at the gate. The
// seller's payout is released only after the event, which is what makes a
// refund possible if the event is canceled: money paid out before the show
// cannot be clawed back from a seller who has already spent it.
```

---
