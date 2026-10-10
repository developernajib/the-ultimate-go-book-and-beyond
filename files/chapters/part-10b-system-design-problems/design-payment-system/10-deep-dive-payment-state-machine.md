## Deep Dive: Payment State Machine

Every payment moves through a series of well-defined states: pending, authorized, captured, settled, and potentially refunded or disputed. A state machine enforces which transitions are valid, preventing illegal operations like refunding a payment that was never captured. The `TransitionState` method uses a conditional SQL `UPDATE ... WHERE status = $old` to guarantee that concurrent requests cannot corrupt the state: the database re-checks the current state at write time, so of two racing transitions exactly one moves the row and the other sees zero rows affected and knows it lost.

`ReconcileStaleTransactions` is the crash-recovery half, and it is the reason the pending row is written before the charge. A payment stuck in pending past a few minutes means nobody knows whether the card was charged, and the only component that can answer is the processor. So the job asks it, then drives the row to its true terminal state.

```go
package coordinator

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type TransactionCoordinator struct {
	db        *pgxpool.Pool
	processor CardProcessor
	ledger    Ledger
}

type PaymentState string

// These values are the same strings as the chk_status constraint on the
// transactions table. Two lists of state names that must agree and are
// maintained separately will eventually disagree, and the failure lands
// as a constraint violation at 3am, so treat the schema as the authority
// and keep this in step with it.
const (
	StatePending           PaymentState = "pending"
	StateAuthorized        PaymentState = "authorized"
	StateCaptured          PaymentState = "captured"
	StateSettled           PaymentState = "settled"
	StateFailed            PaymentState = "failed"
	StateBlocked           PaymentState = "blocked"
	StateVoided            PaymentState = "voided"
	StatePartiallyRefunded PaymentState = "partially_refunded"
	StateRefunded          PaymentState = "refunded"
	StateDisputed          PaymentState = "disputed"
)

var ValidTransitions = map[PaymentState][]PaymentState{
	StatePending:    {StateAuthorized, StateCaptured, StateFailed, StateBlocked},
	StateAuthorized: {StateCaptured, StateVoided, StateFailed},
	StateCaptured:   {StateSettled, StatePartiallyRefunded, StateRefunded, StateDisputed},
	// Settlement is not the end of the story. A cardholder can dispute
	// weeks after the money moved, and refunds outlive settlement too, so
	// a settled payment that cannot transition would leave real
	// chargebacks with nowhere to go.
	StateSettled: {StatePartiallyRefunded, StateRefunded, StateDisputed},
	// The self-transition is deliberate: a second partial refund leaves
	// the payment partially refunded. Without it, a $100 charge refunded
	// $30 could never be refunded another $30.
	StatePartiallyRefunded: {StatePartiallyRefunded, StateRefunded, StateDisputed},
	StateDisputed:          {StateRefunded, StateSettled},
}

func (c *TransactionCoordinator) TransitionState(ctx context.Context, txnID string, from, to PaymentState) error {
	allowed := false
	for _, v := range ValidTransitions[from] {
		if v == to {
			allowed = true
			break
		}
	}
	if !allowed {
		return fmt.Errorf("invalid transition: %s -> %s", from, to)
	}

	// The state change and its audit record commit together. Written as
	// two independent statements, a failure between them moves the
	// payment with no trace of who moved it or why, and the audit trail
	// is worth exactly as much as its worst gap.
	tx, err := c.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	result, err := tx.Exec(ctx,
		`UPDATE transactions SET status = $1, updated_at = NOW()
		 WHERE id = $2 AND status = $3`,
		string(to), txnID, string(from))
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		// Someone else moved this row first. Not an error to retry
		// blindly: re-read and decide, because the winning transition may
		// have already done what we wanted.
		return fmt.Errorf("state conflict on %s: expected %s", txnID, from)
	}

	if _, err := tx.Exec(ctx,
		`INSERT INTO transaction_events (transaction_id, from_state, to_state, created_at)
		 VALUES ($1, $2, $3, NOW())`,
		txnID, string(from), string(to)); err != nil {
		return fmt.Errorf("audit event: %w", err)
	}

	return tx.Commit(ctx)
}

// ReconcileStaleTransactions fixes payments stuck in pending.
//
// Runs on a timer. The LIMIT and the ordering keep one slow batch from
// monopolizing a worker, and the job is safe to run concurrently on
// several instances because TransitionState's conditional UPDATE means
// only one of them can move any given row.
func (c *TransactionCoordinator) ReconcileStaleTransactions(ctx context.Context) error {
	// processor_ref is nullable: a transaction that crashed before the
	// processor call has none. Scanning NULL into a string fails, so it
	// is coalesced here rather than discovered in production.
	rows, err := c.db.Query(ctx, `
		SELECT id, merchant_id, COALESCE(processor_ref, ''), amount, currency, created_at
		FROM transactions
		WHERE status = 'pending' AND created_at < NOW() - INTERVAL '5 minutes'
		ORDER BY created_at
		LIMIT 100`)
	if err != nil {
		return fmt.Errorf("query stale transactions: %w", err)
	}
	defer rows.Close()

	type stale struct {
		id, merchantID, ref, currency string
		amount                        int64
		createdAt                     time.Time
	}
	var batch []stale

	// Drain the cursor before doing any slow per-row work. Calling the
	// processor inside rows.Next() holds a pooled connection open for the
	// length of every network round trip, which is how a reconciliation
	// job exhausts the connection pool and takes the API down with it.
	for rows.Next() {
		var s stale
		if err := rows.Scan(&s.id, &s.merchantID, &s.ref, &s.amount, &s.currency, &s.createdAt); err != nil {
			return fmt.Errorf("scan stale transaction: %w", err)
		}
		batch = append(batch, s)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate stale transactions: %w", err)
	}

	for _, s := range batch {
		if s.ref == "" {
			// No processor reference means we never reached the
			// processor, so no charge exists to reconcile against.
			if err := c.TransitionState(ctx, s.id, StatePending, StateFailed); err != nil {
				return fmt.Errorf("fail unreferenced txn %s: %w", s.id, err)
			}
			continue
		}

		status, err := c.processor.GetChargeStatus(ctx, s.ref)
		if err != nil {
			// The processor is the only source of truth here. If it will
			// not answer, leave the row pending and try again next run.
			// Guessing "failed" on an unreachable processor is how you
			// keep a customer's money and report the payment as failed.
			continue
		}

		switch status {
		case "succeeded":
			if err := c.TransitionState(ctx, s.id, StatePending, StateCaptured); err != nil {
				continue // lost the race, another worker has it
			}
			// Record is keyed on the transaction and is safe to retry, so
			// a crash between the transition and this call is repaired by
			// the next run rather than double-posting.
			if err := c.ledger.Record(ctx, LedgerEntry{
				TransactionID: s.id,
				MerchantID:    s.merchantID,
				Amount:        s.amount,
				Currency:      s.currency,
				Type:          "payment",
				OccurredAt:    s.createdAt,
			}); err != nil {
				return fmt.Errorf("ledger record for recovered txn %s: %w", s.id, err)
			}
		case "failed":
			if err := c.TransitionState(ctx, s.id, StatePending, StateFailed); err != nil {
				continue
			}
		}
	}
	return nil
}
```

The `MerchantID` in that ledger entry deserves a note, because omitting it is an easy and expensive mistake. `LedgerService.Record` credits `entry.MerchantID`, so a recovery path that forgets to select `merchant_id` posts the credit half to the empty-string account. The debit still balances the credit, the ledger still sums to zero, and every consistency check still passes. The money simply accrues to an account belonging to nobody, and the merchant is never paid. Invariants only catch the errors they are shaped to catch.

---
