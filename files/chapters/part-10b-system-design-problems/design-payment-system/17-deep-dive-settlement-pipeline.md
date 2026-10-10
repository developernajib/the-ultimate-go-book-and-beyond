## Deep Dive: Settlement Pipeline

Settlement is the process of actually moving money from the payment platform to the merchant's bank account. It runs as a nightly batch job that first reconciles the internal ledger against the external processor's settlement report to catch any discrepancies (missing transactions, amount mismatches). After reconciliation passes, the pipeline identifies merchants with a balance above the payout threshold and initiates bank transfers. Reconcile first, then pay out, so that you never send money based on data you have not verified. That ordering is only worth anything if the payout stage actually refuses to run when reconciliation found problems, so the gate below is explicit rather than implied by the order of two function calls.

The other thing to study here is the ordering inside the payout loop, because a bank transfer is the one operation in this chapter that cannot be undone. Deduct the balance first, in a conditional `UPDATE` that can fail, and only then send the money. Doing it the intuitive way round, send the money and then record that you sent it, means any failure of the second step leaves a paid merchant with an unreduced balance, and tomorrow night the job cheerfully pays them again.

```go
package settlement

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SettlementPipeline handles nightly reconciliation and merchant payouts
type SettlementPipeline struct {
	db        *pgxpool.Pool
	processor CardProcessor
	ledger    PayoutLedger
}

// PayoutLedger posts a payout inside a caller-supplied transaction, so
// that the ledger entries and the balance deduction commit together.
type PayoutLedger interface {
	RecordPayout(ctx context.Context, tx pgx.Tx, p PayoutPosting) error
	ReversePayout(ctx context.Context, tx pgx.Tx, payoutID string) error
}

// PayoutPosting is a payout expressed as a balanced set of movements:
// the merchant is debited the gross, the bank clearing account is
// credited the net, and the platform's fee account is credited the fee.
// Gross must equal Net + Fee, which is asserted rather than assumed.
type PayoutPosting struct {
	PayoutID   string
	MerchantID string
	Gross      int64
	Fee        int64
	Net        int64
	Currency   string
	OccurredAt time.Time
}

type ReconciliationResult struct {
	Date               time.Time
	TotalTransactions  int
	TotalAmount        int64
	Matched            int
	Mismatched         int
	MissingInLedger    int
	MissingInProcessor int
	Discrepancies      []Discrepancy
}

// Clean reports whether the day reconciled with no unexplained
// differences. Payouts are gated on this.
func (r *ReconciliationResult) Clean() bool { return len(r.Discrepancies) == 0 }

type Discrepancy struct {
	TransactionID   string
	LedgerAmount    int64
	ProcessorAmount int64
	Type            string // amount_mismatch, missing_in_ledger, missing_in_processor
	Status          string // pending_review, resolved, written_off
}

// RunDailyReconciliation compares our ledger against processor settlement report
func (s *SettlementPipeline) RunDailyReconciliation(ctx context.Context, date time.Time) (*ReconciliationResult, error) {
	result := &ReconciliationResult{Date: date}

	// Get our ledger entries for the day
	ledgerEntries := make(map[string]int64) // txnID -> amount
	rows, err := s.db.Query(ctx, `
		SELECT transaction_id, amount
		FROM ledger_entries
		WHERE account_type = 'merchant'
		  AND type = 'payment'
		  AND created_at >= $1 AND created_at < $2`,
		date, date.Add(24*time.Hour))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var txnID string
		var amount int64
		// A dropped scan error here would omit a transaction from the
		// ledger side of the comparison, and the omission surfaces as a
		// "missing_in_ledger" discrepancy against a ledger that is
		// perfectly fine. Reconciliation that invents discrepancies is
		// worse than none, because people learn to ignore it.
		if err := rows.Scan(&txnID, &amount); err != nil {
			return nil, fmt.Errorf("scan ledger entry: %w", err)
		}
		ledgerEntries[txnID] = amount
		result.TotalTransactions++
		result.TotalAmount += amount
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate ledger entries: %w", err)
	}

	// Get processor settlement report
	processorEntries, err := s.processor.GetSettlementReport(ctx, date)
	if err != nil {
		return nil, fmt.Errorf("processor report: %w", err)
	}

	// Compare
	processorMap := make(map[string]int64)
	for _, pe := range processorEntries {
		processorMap[pe.TransactionID] = pe.Amount
	}

	for txnID, ledgerAmt := range ledgerEntries {
		procAmt, exists := processorMap[txnID]
		if !exists {
			result.MissingInProcessor++
			result.Discrepancies = append(result.Discrepancies, Discrepancy{
				TransactionID: txnID, LedgerAmount: ledgerAmt,
				Type: "missing_in_processor", Status: "pending_review",
			})
		} else if ledgerAmt != procAmt {
			result.Mismatched++
			result.Discrepancies = append(result.Discrepancies, Discrepancy{
				TransactionID: txnID, LedgerAmount: ledgerAmt, ProcessorAmount: procAmt,
				Type: "amount_mismatch", Status: "pending_review",
			})
		} else {
			result.Matched++
		}
	}

	for txnID, procAmt := range processorMap {
		if _, exists := ledgerEntries[txnID]; !exists {
			result.MissingInLedger++
			result.Discrepancies = append(result.Discrepancies, Discrepancy{
				TransactionID: txnID, ProcessorAmount: procAmt,
				Type: "missing_in_ledger", Status: "pending_review",
			})
		}
	}

	// Persist reconciliation results. If we cannot record the outcome we
	// must not report success, because the payout gate reads this.
	if _, err := s.db.Exec(ctx, `
		INSERT INTO reconciliation_results (date, total_txns, matched, mismatched, discrepancies, created_at)
		VALUES ($1, $2, $3, $4, $5, NOW())`,
		date, result.TotalTransactions, result.Matched, result.Mismatched,
		len(result.Discrepancies)); err != nil {
		return nil, fmt.Errorf("persist reconciliation result: %w", err)
	}

	return result, nil
}

// ProcessMerchantPayouts initiates bank transfers for merchant balances.
//
// Gated on a clean reconciliation for the day: paying out against a
// ledger known to disagree with the processor is how a discrepancy stops
// being a spreadsheet problem and becomes money in someone else's bank.
func (s *SettlementPipeline) ProcessMerchantPayouts(ctx context.Context, recon *ReconciliationResult) error {
	if !recon.Clean() {
		return fmt.Errorf("payouts blocked: %d unresolved discrepancies for %s",
			len(recon.Discrepancies), recon.Date.Format("2006-01-02"))
	}

	// payoutThresholds is per currency, in that currency's minor units.
	// A single global "2500 means $25" is wrong the moment a second
	// currency exists: 2500 JPY minor units is ¥2500, and 2500 BHD minor
	// units is 2.5 BHD. Same integer, wildly different amounts of money.
	rows, err := s.db.Query(ctx, `
		SELECT b.merchant_id, b.currency, b.available
		FROM merchant_balances b
		JOIN payout_thresholds t ON t.currency = b.currency
		WHERE b.available >= t.minimum
		  AND (b.last_payout_at IS NULL
		       OR b.last_payout_at < NOW() - INTERVAL '1 day')`)
	if err != nil {
		return err
	}
	defer rows.Close()

	type candidate struct {
		merchantID, currency string
		amount               int64
	}
	var candidates []candidate

	// Drain the cursor first. The body of this loop makes bank API calls,
	// and holding a pooled connection across them would tie up the pool
	// for the length of the whole batch.
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.merchantID, &c.currency, &c.amount); err != nil {
			return fmt.Errorf("scan payout candidate: %w", err)
		}
		candidates = append(candidates, c)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate payout candidates: %w", err)
	}

	for _, c := range candidates {
		if err := s.payOut(ctx, c.merchantID, c.currency, c.amount); err != nil {
			// One merchant's failed payout must not abandon the rest of
			// the batch. Tomorrow's run retries this merchant.
			alertOps(ctx, "payout failed", c.merchantID, err)
			continue
		}
	}

	return nil
}

// payOut moves one merchant's balance to their bank.
//
// Order of operations is the entire point. The balance is deducted in a
// conditional UPDATE before the transfer is initiated, so that the money
// can only be sent once. If the transfer then fails, we credit the
// balance back, which is a compensating action rather than a rollback,
// because the bank call is not part of any database transaction.
func (s *SettlementPipeline) payOut(ctx context.Context, merchantID, currency string, amount int64) error {
	// 0.25% wire fee, rounded half up so the platform is not
	// systematically shorted a minor unit on every payout by truncation.
	fee := (amount*25 + 5000) / 10000
	netAmount := amount - fee
	if netAmount <= 0 {
		return fmt.Errorf("payout of %d %s is entirely consumed by fees", amount, currency)
	}

	payoutID := uuid.New().String()
	now := time.Now()

	// Reserve: deduct the balance and write the payout row together. The
	// WHERE clause re-checks that the balance still covers the amount, so
	// two concurrent settlement runs cannot both pay the same balance.
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	tag, err := tx.Exec(ctx, `
		UPDATE merchant_balances
		SET available = available - $1, last_payout_at = NOW()
		WHERE merchant_id = $2 AND currency = $3 AND available >= $1`,
		amount, merchantID, currency)
	if err != nil {
		return fmt.Errorf("reserve payout balance: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("balance for %s/%s no longer covers %d", merchantID, currency, amount)
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO payouts (id, merchant_id, amount, currency, fee, net_amount, status, initiated_at)
		VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
		payoutID, merchantID, amount, currency, fee, netAmount, now); err != nil {
		return fmt.Errorf("insert payout: %w", err)
	}

	// Both halves of the payout, plus the fee, in one balanced posting.
	// The fee is not a number subtracted on the way out of the door: it
	// is revenue, and it needs an account, or the ledger quietly loses
	// 0.25% of every payout and nothing ever adds up again.
	if err := s.ledger.RecordPayout(ctx, tx, PayoutPosting{
		PayoutID:   payoutID,
		MerchantID: merchantID,
		Gross:      amount,
		Fee:        fee,
		Net:        netAmount,
		Currency:   currency,
		OccurredAt: now,
	}); err != nil {
		return fmt.Errorf("record payout in ledger: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit payout reservation: %w", err)
	}

	// Only now, with the balance already deducted and committed, do we
	// move real money.
	bankRef, err := s.processor.InitiatePayout(ctx, merchantID, netAmount, currency, payoutID)
	if err != nil {
		// The transfer did not start, so give the balance back. Note this
		// is only safe because InitiatePayout is idempotent on payoutID
		// and reports a clean failure. On an ambiguous error, do not
		// compensate: mark the payout for manual review, because
		// crediting the balance back on a transfer that actually went out
		// pays the merchant twice.
		s.compensateFailedPayout(ctx, payoutID, merchantID, currency, amount, err)
		return fmt.Errorf("initiate payout: %w", err)
	}

	if _, err := s.db.Exec(ctx,
		`UPDATE payouts SET status = 'in_transit', bank_ref = $1 WHERE id = $2`,
		bankRef, payoutID); err != nil {
		// The money is moving and we failed to note the reference. Not
		// worth reversing anything: alert and let a human attach it.
		alertOps(ctx, "payout in transit but bank_ref not recorded", merchantID, err)
	}

	return nil
}
```

The fee is where a payout pipeline most often stops balancing, so it is worth seeing the posting written out. A payout is not one movement but three, and they have to sum to zero. This is the `PayoutLedger` implementation, over in the ledger package:

```go
package ledger

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// RecordPayout posts the three legs of a payout. Debit the merchant the
// gross, credit the bank clearing account the net, credit the platform
// fee account the difference. The three sum to zero, which is what makes
// this a payout rather than a leak.
func (s *LedgerService) RecordPayout(ctx context.Context, tx pgx.Tx, p PayoutPosting) error {
	// Guard the invariant at the boundary. If gross, net, and fee ever
	// disagree, the entries below would still each insert successfully
	// and the ledger would be quietly out of balance from then on. Catch
	// it here, where the cause is still visible.
	if p.Gross != p.Net+p.Fee {
		return fmt.Errorf("unbalanced payout %s: gross %d != net %d + fee %d",
			p.PayoutID, p.Gross, p.Net, p.Fee)
	}

	legs := []struct {
		accountID   string
		accountType string
		amount      int64
	}{
		{p.MerchantID, "merchant", -p.Gross},
		{"bank_clearing:" + p.Currency, "bank", p.Net},
		{"platform_fees:" + p.Currency, "platform", p.Fee},
	}

	for _, leg := range legs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO ledger_entries (id, account_id, account_type, transaction_id,
				amount, currency, type, created_at)
			VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'payout', $6)`,
			leg.accountID, leg.accountType, p.PayoutID, leg.amount,
			p.Currency, p.OccurredAt,
		); err != nil {
			return fmt.Errorf("payout leg %s: %w", leg.accountType, err)
		}
	}
	return nil
}
```

And back in the settlement package, the compensation path:

```go
package settlement

import (
	"context"
	"errors"
)

// ErrTransferNotStarted is returned by the payout processor only when it
// can prove no transfer was created. Every other failure is ambiguous
// and must be treated as "the money may be gone".
var ErrTransferNotStarted = errors.New("payout transfer never started")

// compensateFailedPayout returns a reserved balance after a transfer
// that provably never started. It deliberately does nothing on an
// ambiguous failure: crediting a balance back for a transfer that did go
// out pays the merchant twice, and unlike a card charge there is no
// idempotency key at the other end to save you.
func (s *SettlementPipeline) compensateFailedPayout(
	ctx context.Context, payoutID, merchantID, currency string, amount int64, cause error,
) {
	if !errors.Is(cause, ErrTransferNotStarted) {
		if _, err := s.db.Exec(ctx,
			`UPDATE payouts SET status = 'needs_review' WHERE id = $1`, payoutID); err != nil {
			alertOps(ctx, "failed to flag ambiguous payout", merchantID, err)
		}
		alertOps(ctx, "payout outcome ambiguous, balance NOT restored", merchantID, cause)
		return
	}

	// Provably not sent: reverse the reservation with a compensating
	// ledger posting rather than by deleting the original entries. The
	// ledger is append-only, so a mistake is corrected by an opposite
	// entry that leaves both halves visible in the audit trail.
	if err := s.reverseReservation(ctx, payoutID, merchantID, currency, amount); err != nil {
		alertOps(ctx, "CRITICAL: failed to restore balance after failed payout", merchantID, err)
	}
}

// reverseReservation credits the balance back and posts the opposite of
// each payout leg, tagged to the same payout ID so the attempt and its
// reversal read as one story.
func (s *SettlementPipeline) reverseReservation(
	ctx context.Context, payoutID, merchantID, currency string, amount int64,
) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `
		UPDATE merchant_balances SET available = available + $1, updated_at = NOW()
		WHERE merchant_id = $2 AND currency = $3`,
		amount, merchantID, currency); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE payouts SET status = 'failed' WHERE id = $1`, payoutID); err != nil {
		return err
	}
	if err := s.ledger.ReversePayout(ctx, tx, payoutID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func alertOps(ctx context.Context, msg, merchantID string, err error) {
	// PagerDuty/OpsGenie in production. Payout alerts page a human: money
	// that may or may not have moved is not a metric to graph.
}
```

The append-only rule in that last comment is not bookkeeping pedantry. The tempting repair for a failed payout is to delete the entries and put the balance back where it was, which leaves a ledger that looks as though nothing happened. Auditors and your own future incident review both need to see that a payout was attempted and reversed, because "we tried to send this merchant $40,000 and the bank refused" is exactly the event someone will need to reconstruct six months later. A ledger you can rewrite answers no questions.

---
