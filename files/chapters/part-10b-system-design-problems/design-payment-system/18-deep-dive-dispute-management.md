## Deep Dive: Dispute Management

A dispute (also called a chargeback) occurs when a cardholder contacts their bank to contest a charge. When the card network notifies your system of a dispute, you must immediately hold the disputed funds from the merchant's balance, notify the merchant, and give them a window to submit evidence proving the transaction was legitimate. The `DisputeService` below handles this lifecycle: receiving the incoming dispute, freezing funds, tracking the evidence submission deadline, forwarding the merchant's evidence to the card network, and releasing or capturing the held funds when the decision comes back.

Two things shape this code more than the happy path does. The first is that dispute notifications arrive as webhooks, and webhooks are delivered at least once. Handling the same dispute twice must not hold the funds twice, so the handler is keyed on the processor's dispute reference and is idempotent by construction rather than by hoping the network behaves.

The second is that the evidence deadline is not ours to invent. It is set by the issuer and relayed by the processor, and it varies by network, reason code, and region. Hardcoding "7 days from now" produces a deadline that is sometimes later than the real one, and a deadline you miss is a dispute you lose automatically, with no appeal and no relationship to whether the merchant was right. Take the date from the notification, and treat a missing one as an error rather than defaulting it.

```go
package dispute

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// DisputeService handles chargebacks and disputes
type DisputeService struct {
	db        *pgxpool.Pool
	processor CardProcessor
	notifier  NotificationService
}

type Dispute struct {
	ID              string     `json:"id"`
	TransactionID   string     `json:"transaction_id"`
	MerchantID      string     `json:"merchant_id"`
	Amount          int64      `json:"amount"`
	Currency        string     `json:"currency"`
	Reason          string     `json:"reason"` // fraud, product_not_received, duplicate, other
	Status          string     `json:"status"` // open, evidence_required, under_review, won, lost
	ProcessorRef    string     `json:"processor_ref"`
	EvidenceDueDate time.Time  `json:"evidence_due_date"`
	CreatedAt       time.Time  `json:"created_at"`
	ResolvedAt      *time.Time `json:"resolved_at,omitempty"`
}

// DisputeNotification is what the processor's webhook gives us. The due
// date is theirs, not ours: it comes from the issuer via the network.
type DisputeNotification struct {
	DisputeRef    string // the processor's dispute ID, our idempotency key
	ChargeRef     string // processor_ref of the original charge
	Reason        string
	Amount        int64
	EvidenceDueBy time.Time
}

// HandleIncomingDispute processes a new chargeback from the card network.
//
// Idempotent on notification.DisputeRef. Card networks and processors
// redeliver webhooks, and a redelivery that holds the merchant's funds a
// second time is a bug that pays for itself in support tickets.
func (s *DisputeService) HandleIncomingDispute(ctx context.Context, n DisputeNotification) error {
	if n.EvidenceDueBy.IsZero() {
		// Refuse rather than default. A made-up deadline that is later
		// than the issuer's means we tell the merchant they have time
		// they do not have, and the dispute is lost by default.
		return fmt.Errorf("dispute %s has no evidence due date", n.DisputeRef)
	}

	// Find the original transaction
	var txnID, merchantID, currency string
	err := s.db.QueryRow(ctx, `
		SELECT id, merchant_id, currency FROM transactions WHERE processor_ref = $1`,
		n.ChargeRef).Scan(&txnID, &merchantID, &currency)
	if err != nil {
		return fmt.Errorf("transaction not found for dispute %s: %w", n.DisputeRef, err)
	}

	// Everything below commits together. Written as loose statements, a
	// failure partway leaves a dispute recorded with no funds held, or
	// funds held with no dispute to ever release them.
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	disputeID := "disp_" + uuid.New().String()

	// The UNIQUE index on processor_ref makes redelivery a no-op.
	tag, err := tx.Exec(ctx, `
		INSERT INTO disputes (id, transaction_id, merchant_id, amount, currency,
			reason, status, processor_ref, evidence_due_date, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, 'evidence_required', $7, $8, NOW())
		ON CONFLICT (processor_ref) DO NOTHING`,
		disputeID, txnID, merchantID, n.Amount, currency,
		n.Reason, n.DisputeRef, n.EvidenceDueBy)
	if err != nil {
		return fmt.Errorf("insert dispute: %w", err)
	}
	if tag.RowsAffected() == 0 {
		// Already handled. The funds are already held and the merchant is
		// already notified, so stop here rather than doing either again.
		return nil
	}

	// Move the disputed funds out of available and into held. This can
	// drive available negative, and that is correct: the merchant owes
	// the money whether or not their balance currently covers it, and a
	// platform that refuses to record a dispute because the balance is
	// too low has simply chosen not to know about its own exposure.
	if _, err := tx.Exec(ctx, `
		UPDATE merchant_balances
		SET available = available - $1, held = held + $1, updated_at = NOW()
		WHERE merchant_id = $2 AND currency = $3`,
		n.Amount, merchantID, currency); err != nil {
		return fmt.Errorf("hold disputed funds: %w", err)
	}

	if _, err := tx.Exec(ctx,
		`UPDATE transactions SET status = 'disputed', updated_at = NOW() WHERE id = $1`,
		txnID); err != nil {
		return fmt.Errorf("mark transaction disputed: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}

	// Notify only after the commit. Telling a merchant about a dispute
	// that then rolled back is worse than telling them slightly late.
	s.notifier.Send(ctx, Notification{
		MerchantID: merchantID,
		Type:       "dispute.created",
		Message: fmt.Sprintf("Dispute opened for transaction %s. Amount: %d %s. Evidence due by %s.",
			txnID, n.Amount, currency, n.EvidenceDueBy.Format("2006-01-02")),
	})

	return nil
}

// ResolveDispute applies the network's final decision.
//
// Without this, held funds stay held forever: a merchant who wins every
// dispute still never sees the money again. Also idempotent, since the
// resolution arrives by the same at-least-once webhook path.
func (s *DisputeService) ResolveDispute(ctx context.Context, disputeRef string, won bool) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var disputeID, merchantID, currency string
	var amount int64
	err = tx.QueryRow(ctx, `
		UPDATE disputes
		SET status = CASE WHEN $2 THEN 'won' ELSE 'lost' END,
		    resolution = CASE WHEN $2 THEN 'won' ELSE 'lost' END,
		    resolved_at = NOW()
		WHERE processor_ref = $1 AND resolved_at IS NULL
		RETURNING id, merchant_id, currency, amount`,
		disputeRef, won).Scan(&disputeID, &merchantID, &currency, &amount)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // already resolved, or unknown: nothing to undo
	}
	if err != nil {
		return fmt.Errorf("resolve dispute: %w", err)
	}

	if won {
		// Merchant keeps the money: release the hold back to available.
		if _, err := tx.Exec(ctx, `
			UPDATE merchant_balances
			SET available = available + $1, held = held - $1, updated_at = NOW()
			WHERE merchant_id = $2 AND currency = $3`,
			amount, merchantID, currency); err != nil {
			return fmt.Errorf("release hold: %w", err)
		}
	} else {
		// Merchant loses: the held funds go to the issuer. Drop the hold
		// without returning it, and post the loss to the ledger so the
		// money has somewhere to have gone.
		if _, err := tx.Exec(ctx, `
			UPDATE merchant_balances
			SET held = held - $1, updated_at = NOW()
			WHERE merchant_id = $2 AND currency = $3`,
			amount, merchantID, currency); err != nil {
			return fmt.Errorf("capture hold: %w", err)
		}
		if err := s.recordChargebackLoss(ctx, tx, disputeID, merchantID, currency, amount); err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

// SubmitEvidence submits merchant evidence to contest a dispute
func (s *DisputeService) SubmitEvidence(ctx context.Context, disputeID string, evidence DisputeEvidence) error {
	var dispute Dispute
	err := s.db.QueryRow(ctx,
		"SELECT id, status, processor_ref, evidence_due_date FROM disputes WHERE id = $1",
		disputeID).Scan(&dispute.ID, &dispute.Status, &dispute.ProcessorRef, &dispute.EvidenceDueDate)
	if err != nil {
		return err
	}

	if dispute.Status != "evidence_required" {
		return fmt.Errorf("dispute not in evidence_required state: %s", dispute.Status)
	}

	// Check the deadline before spending a network round trip on evidence
	// the issuer will not look at. Missing it is not a soft failure: the
	// dispute is lost, and the merchant deserves to be told why by
	// something better than silence.
	if time.Now().After(dispute.EvidenceDueDate) {
		return fmt.Errorf("evidence window for dispute %s closed at %s",
			disputeID, dispute.EvidenceDueDate.Format(time.RFC3339))
	}

	// Submit to card network via processor
	if err := s.processor.SubmitDisputeEvidence(ctx, dispute.ProcessorRef, evidence); err != nil {
		return fmt.Errorf("submit evidence: %w", err)
	}

	// The evidence is in. Failing to record that is not cosmetic: this
	// dispute would still read as evidence_required, and a merchant
	// retrying would submit a second time.
	if _, err := s.db.Exec(ctx,
		"UPDATE disputes SET status = 'under_review', evidence_submitted_at = NOW() WHERE id = $1",
		disputeID); err != nil {
		return fmt.Errorf("evidence submitted but status not updated for %s: %w", disputeID, err)
	}

	return nil
}

type DisputeEvidence struct {
	Receipt            string `json:"receipt"`        // receipt image URL
	DeliveryProof      string `json:"delivery_proof"` // tracking number
	CustomerComm       string `json:"customer_comm"`  // email/chat transcript
	ServiceDescription string `json:"service_desc"`
	RefundPolicy       string `json:"refund_policy"`
}

// recordChargebackLoss posts the lost dispute: debit the merchant, credit
// the issuer clearing account, so the money that left has a counterparty
// in the ledger instead of simply ceasing to exist.
func (s *DisputeService) recordChargebackLoss(
	ctx context.Context, tx pgx.Tx, disputeID, merchantID, currency string, amount int64,
) error {
	legs := []struct {
		accountID, accountType string
		amount                 int64
	}{
		{merchantID, "merchant", -amount},
		{"issuer_clearing:" + currency, "issuer", amount},
	}
	for _, leg := range legs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO ledger_entries (id, account_id, account_type, transaction_id,
				amount, currency, type, created_at)
			VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'chargeback', NOW())`,
			leg.accountID, leg.accountType, disputeID, leg.amount, currency,
		); err != nil {
			return fmt.Errorf("chargeback leg %s: %w", leg.accountType, err)
		}
	}
	return nil
}
```

A note on the deadline check in `SubmitEvidence`. It rejects late evidence, which is correct, but rejecting at submission time is the last and least useful place to discover the problem. The deadline is known the moment the dispute arrives, so the system should be pushing reminders at the merchant well before it, and escalating the ones nobody has touched. A dispute lost because the merchant had good evidence and no reminder is indistinguishable, on the balance sheet, from fraud.

---
