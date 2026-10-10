## Failure Handling

### Inventory Reconciliation

Because the system uses Redis as a fast cache and PostgreSQL as the source of truth, these two data stores drift during failures: network partitions, crashed processes, a promoted replica that lost the last second of writes, or a reaper that died mid-sweep. The reconciliation service runs every five minutes during active sales and repairs the cache.

The direction of that repair is the entire design, and getting it backwards is worse than not running it at all. Reconciliation copies PostgreSQL onto Redis. It never invents a status, and in particular it never blanket-resets a disputed seat to `available`, because a seat that reads `held` in Redis and `sold` in PostgreSQL has been *bought*: resetting it to available puts a sold seat back on the market and hands a second fan a hold on a seat that is already someone's. A repair job that stomps state it does not understand is the most common way a system that cannot oversell starts overselling.

The one status Redis is allowed to have that PostgreSQL does not is a live hold, since holds never existed in the database. So a `held` seat with an unexpired entry in the expiry index is left strictly alone, and a `held` seat whose hold has lapsed is returned to whatever PostgreSQL says it is.

```go
package reconciliation

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

// InventoryReconciler repairs the Redis seat map from PostgreSQL.
// Runs every 5 minutes during sales.
type InventoryReconciler struct {
	db  *pgxpool.Pool
	rdb *redis.Client
}

type ReconciliationReport struct {
	EventID           string
	Timestamp         time.Time
	Mismatches        int
	FixedExpiredHolds int
	LiveHoldsSkipped  int
}

type dbSeat struct {
	status    string
	bookingID string
}

func (r *InventoryReconciler) Reconcile(ctx context.Context, eventID string) (*ReconciliationReport, error) {
	report := &ReconciliationReport{EventID: eventID, Timestamp: time.Now()}
	seatKey := fmt.Sprintf("seats:%s", eventID)

	// PostgreSQL first: it is the truth, and it is what everything else is
	// compared against.
	dbSeats, err := r.getDBSeats(ctx, eventID)
	if err != nil {
		return nil, fmt.Errorf("load db seats: %w", err)
	}

	redisSeats, err := r.rdb.HGetAll(ctx, seatKey).Result()
	if err != nil {
		return nil, fmt.Errorf("load redis seats: %w", err)
	}

	pipe := r.rdb.Pipeline()
	// Iterate the database, not the cache. Ranging over Redis would silently
	// skip any seat missing from the hash entirely, which is exactly the seat
	// most likely to be wrong after a failover.
	for seatID, want := range dbSeats {
		got, present := redisSeats[seatID]
		expected := expectedCacheValue(want)

		if present && got == expected {
			continue
		}

		// A live hold is legitimate cache-only state: PostgreSQL says
		// 'available' because the sale has not happened yet, and it may still
		// happen. Leave it.
		if holdID, ok := strings.CutPrefix(got, "held:"); ok && want.status == "available" {
			live, err := r.holdIsLive(ctx, eventID, holdID)
			if err != nil {
				return nil, err
			}
			if live {
				report.LiveHoldsSkipped++
				continue
			}
			report.FixedExpiredHolds++
		}

		report.Mismatches++
		pipe.HSet(ctx, seatKey, seatID, expected)
	}

	if _, err := pipe.Exec(ctx); err != nil {
		return nil, fmt.Errorf("apply repairs: %w", err)
	}
	if report.Mismatches > 0 {
		slog.WarnContext(ctx, "seat map drift repaired from postgres",
			"event_id", eventID, "mismatches", report.Mismatches,
			"expired_holds", report.FixedExpiredHolds)
	}
	return report, nil
}

// expectedCacheValue maps a committed database row to its cache encoding.
func expectedCacheValue(s dbSeat) string {
	if s.status == "sold" {
		return "sold:" + s.bookingID
	}
	return "available"
}

// holdIsLive reports whether a hold still has time on the clock, according to
// the expiry index that the hold path maintains.
func (r *InventoryReconciler) holdIsLive(ctx context.Context, eventID, holdID string) (bool, error) {
	deadline, err := r.rdb.ZScore(ctx, fmt.Sprintf("holds:expiry:%s", eventID), holdID).Result()
	if errors.Is(err, redis.Nil) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return time.Now().Unix() <= int64(deadline), nil
}

func (r *InventoryReconciler) getDBSeats(ctx context.Context, eventID string) (map[string]dbSeat, error) {
	rows, err := r.db.Query(ctx,
		`SELECT id, status, COALESCE(booking_id, '') FROM seats WHERE event_id = $1`,
		eventID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make(map[string]dbSeat)
	for rows.Next() {
		var id string
		var s dbSeat
		// booking_id is nullable, so it is COALESCEd rather than scanned into
		// a string that would fail on NULL.
		if err := rows.Scan(&id, &s.status, &s.bookingID); err != nil {
			return nil, err
		}
		out[id] = s
	}
	return out, rows.Err()
}
```

### Payment-Booking Consistency, and the Outbox for Everything After

Payment and booking can each fail independently, and the awkward case is specific: the card is charged and the seat turns out not to be available. There is no way to make a charge on Stripe and a commit in PostgreSQL happen atomically, so the design picks an order and handles the fallout.

The order is: price the hold, charge, then attempt the conditional UPDATE. If the update loses the race, refund the exact amount charged and release the hold. This deliberately accepts a rare, brief charge that gets reversed, in exchange for never selling a seat twice. The alternative order, commit first and charge after, trades that for seats marked sold against payments that never land, which is worse: the seat is gone from inventory and nobody paid for it.

Two details keep this honest. The Stripe idempotency key is derived from the hold, so a client that retries a confirm is charged once rather than twice. And `bookings.hold_id` is UNIQUE, so a retry that arrives after the original succeeded collides with the constraint and returns the original booking instead of charging again or, worse, refunding a booking that is still confirmed.

The outbox covers what happens *after* the booking commits. Ticket generation, email, and push all involve external services that fail on their own schedule, and none of them should be able to fail a booking that is already paid for and committed.

```
Problem: booking is committed, but QR generation or email fails

Solution:
1. Write the booking AND a ticket_delivery outbox row in ONE transaction
2. A background worker drains the outbox and generates + sends tickets
3. Retry with exponential backoff (5 attempts: 1/2/4/8/16 minutes)
4. After max retries, alert on-call
5. S3 PutObject with a deterministic key is naturally idempotent

Guarantees:
- A committed booking always has a delivery attempt, because both were
  written in the same transaction
- At-least-once delivery, made safe by idempotent effects. Not exactly-once:
  the worker can always crash between sending the email and marking the row
  done, so the ticket must be safe to regenerate and re-send
```

The reason this is an outbox row and not a goroutine is worth stating plainly, because the goroutine version looks like it works. A goroutine dies with its pod. A deploy in the middle of an onsale would silently take a few hundred undelivered tickets with it, and nothing would ever notice, because the booking is committed and the user is holding a receipt.

---
