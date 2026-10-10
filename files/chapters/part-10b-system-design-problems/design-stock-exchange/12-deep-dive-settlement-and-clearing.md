## Deep Dive: Settlement and Clearing

Settlement is the process of actually transferring shares and money between buyers and sellers after a trade executes. US equities settle T+1, one business day after the trade: the SEC's amendments to Rule 15c6-1(a) moved the standard cycle from T+2 to T+1 effective May 28, 2024. The settlement service reads all pending trades for a given day, then performs "Delivery versus Payment" (DVP), atomically updating both the buyer's and seller's positions and cash balances in a single database transaction. This atomic approach ensures that shares and money always move together, preventing situations where one party receives shares but the other never gets paid.

Three invariants govern this code, and each one maps to a way real money disappears.

**Every statement's error is checked.** An ignored `Exec` error does not roll anything back on its own, so the loop happily continues and the transaction commits. The result is a trade marked settled where one leg silently did nothing.

**Settlement is idempotent.** Reading the pending trades and then writing them is a read-then-write race: two runs (a retry, a redeployed cron, an operator rerunning a failed batch) both see the same pending rows and both apply them. The guard is the `WHERE settlement_status='pending'` clause on the claiming UPDATE plus a check that it actually affected a row. Whoever claims the row settles it, everyone else skips it. `FOR UPDATE SKIP LOCKED` keeps concurrent runs from blocking on each other in the first place.

**Money stays in cents.** `qty * price / 100` looks like a harmless unit conversion and is actually value destruction: integer division truncates, so every trade quietly loses up to a cent, the buyer's debit stops matching the seller's credit, and the double-entry invariant that debits equal credits fails. The ledger is only balanced if the amount subtracted from one side is the exact amount added to the other, which is a good reason never to divide at all.

```go
package settlement

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type SettlementService struct{ db *pgxpool.Pool }

// Fields are exported and ordered to match the SELECT below, because
// pgx.RowToStructByPos maps columns onto exported fields by position.
type pendingTrade struct {
	ID       string
	BuyerID  string
	SellerID string
	Symbol   string
	Qty      int64
	Price    int64 // cents
}

// ProcessDayTrades settles every pending trade for a trade date.
//
// The whole function is built around one question: what happens if it runs
// twice? Two settlement runs that both read the same pending trades and both
// apply them would move the money twice. The defense is not "do not run it
// twice", it is the status guard on the claiming UPDATE, which lets exactly
// one run claim each trade.
func (s *SettlementService) ProcessDayTrades(ctx context.Context, tradeDate time.Time) error {
	settleDate := nextBusinessDay(tradeDate)

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer tx.Rollback(ctx)

	// Read inside the transaction, not on a pool connection outside it, and
	// lock the rows so a second settling process skips them instead of
	// racing us for the same trades.
	rows, err := tx.Query(ctx, `
		SELECT id, buyer_id, seller_id, symbol, quantity, price
		FROM trades
		WHERE executed_at >= $1 AND executed_at < $2
		  AND settlement_status = 'pending'
		FOR UPDATE SKIP LOCKED`,
		tradeDate, tradeDate.AddDate(0, 0, 1))
	if err != nil {
		return fmt.Errorf("select pending trades: %w", err)
	}

	// Drain the cursor before issuing writes on the same transaction.
	trades, err := pgx.CollectRows(rows, pgx.RowToStructByPos[pendingTrade])
	if err != nil {
		return fmt.Errorf("scan pending trades: %w", err)
	}

	for _, t := range trades {
		if err := s.settleOne(ctx, tx, t, settleDate); err != nil {
			return fmt.Errorf("settle trade %s: %w", t.ID, err)
		}
	}

	return tx.Commit(ctx)
}

// settleOne applies Delivery versus Payment for a single trade. Every
// statement's error is checked: an ignored Exec error means the leg silently
// did nothing and the commit still succeeds, which is how shares move without
// the money following them.
func (s *SettlementService) settleOne(ctx context.Context, tx pgx.Tx, t pendingTrade, settleDate time.Time) error {
	// Claim the trade first. The status guard makes this idempotent: if a
	// previous run already settled it, zero rows come back and we skip it
	// rather than paying for it a second time.
	tag, err := tx.Exec(ctx, `
		UPDATE trades SET settlement_status='settled', settled_at=NOW(), settle_date=$2
		WHERE id=$1 AND settlement_status='pending'`, t.ID, settleDate)
	if err != nil {
		return fmt.Errorf("claim: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return nil // already settled by another run
	}

	// Value the trade in cents. Do not divide by 100 to "convert to dollars":
	// integer division truncates, and truncating a half cent off every trade
	// is value destroyed, not value rounded. Cents in, cents out.
	totalValue := t.Qty * t.Price

	// DVP: Delivery versus Payment. Shares and cash move together, in one
	// transaction, or neither moves.
	// The buyer may hold no position row yet, so this must upsert. A plain
	// UPDATE would affect zero rows and hand the buyer nothing while still
	// debiting their cash.
	if err := exec(ctx, tx, `
		INSERT INTO positions (trader_id, symbol, quantity, avg_cost, market_value, updated_at)
		VALUES ($1, $2, $3, $4, $5, NOW())
		ON CONFLICT (trader_id, symbol)
		DO UPDATE SET quantity = positions.quantity + EXCLUDED.quantity, updated_at = NOW()`,
		t.BuyerID, t.Symbol, t.Qty, t.Price, totalValue); err != nil {
		return err
	}
	if err := exec(ctx, tx, `
		INSERT INTO positions (trader_id, symbol, quantity, avg_cost, market_value, updated_at)
		VALUES ($1, $2, $3, $4, $5, NOW())
		ON CONFLICT (trader_id, symbol)
		DO UPDATE SET quantity = positions.quantity - EXCLUDED.quantity, updated_at = NOW()`,
		t.SellerID, t.Symbol, t.Qty, t.Price, totalValue); err != nil {
		return err
	}
	if err := exec(ctx, tx, `
		UPDATE cash_balances SET balance = balance - $1, updated_at = NOW() WHERE trader_id = $2`,
		totalValue, t.BuyerID); err != nil {
		return err
	}
	if err := exec(ctx, tx, `
		UPDATE cash_balances SET balance = balance + $1, updated_at = NOW() WHERE trader_id = $2`,
		totalValue, t.SellerID); err != nil {
		return err
	}

	return nil
}

// exec runs a statement and insists it touched exactly one row. A settlement
// statement that matches nothing is a missing account, not a no-op.
func exec(ctx context.Context, tx pgx.Tx, sql string, args ...any) error {
	tag, err := tx.Exec(ctx, sql, args...)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("expected 1 row affected, got %d", tag.RowsAffected())
	}
	return nil
}

// nextBusinessDay advances to T+1, skipping weekends.
// A production implementation must also skip exchange holidays from a real
// calendar. Note the use of AddDate rather than adding 24 hours: across a
// daylight-saving boundary a "day" is 23 or 25 hours, and settlement dates
// are calendar dates, not durations.
func nextBusinessDay(t time.Time) time.Time {
	next := t.AddDate(0, 0, 1)
	for next.Weekday() == time.Saturday || next.Weekday() == time.Sunday {
		next = next.AddDate(0, 0, 1)
	}
	return next
}
```

---
