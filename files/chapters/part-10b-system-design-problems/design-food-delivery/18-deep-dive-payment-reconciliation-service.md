## Deep Dive: Payment Reconciliation Service

In a distributed system, payment state and order state can drift apart. A customer might be charged but the order status update fails, or an order gets canceled but the refund never fires. The Reconciliation Service runs periodically (every 10 minutes) to detect and fix these mismatches automatically. It queries for orders whose payment state does not match their order state, then applies the appropriate correction: capturing uncaptured payments, issuing missing refunds, or flagging ambiguous cases for manual review by the finance team.

```go
package payment

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type PaymentService interface {
	CheckStatus(ctx context.Context, paymentID string) (string, error)
	Refund(ctx context.Context, paymentID string, reason string) error
}

type NotificationService interface{}

// ReconciliationService ensures payment state matches order state
// Runs every 10 minutes to detect and fix inconsistencies
type ReconciliationService struct {
	db         *pgxpool.Pool
	paymentSvc PaymentService
	notifier   NotificationService
}

type ReconciliationReport struct {
	CheckedOrders     int
	MismatchesFound   int
	AutoFixed         int
	ManualRequired    int
	TotalRecovered    int64 // cents
	Timestamp         time.Time
}

// Reconcile checks for payment-order mismatches
func (s *ReconciliationService) Reconcile(ctx context.Context) (*ReconciliationReport, error) {
	report := &ReconciliationReport{Timestamp: time.Now()}

	// 1. Orders marked "confirmed" but payment not captured
	rows, err := s.db.Query(ctx, `
		SELECT id, payment_id, total_price
		FROM orders
		WHERE status = 'confirmed'
		  AND created_at < NOW() - INTERVAL '30 minutes'
		  AND payment_captured = false`)
	if err != nil {
		return nil, fmt.Errorf("query uncaptured orders: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var orderID, paymentID string
		var amount int64 // cents
		rows.Scan(&orderID, &paymentID, &amount)
		report.CheckedOrders++
		report.MismatchesFound++

		status, _ := s.paymentSvc.CheckStatus(ctx, paymentID)
		switch status {
		case "succeeded":
			// Payment went through, update order
			s.db.Exec(ctx, "UPDATE orders SET payment_captured = true WHERE id = $1", orderID)
			report.AutoFixed++
		case "failed":
			// Payment failed, cancel the order (nothing was captured,
			// so there is nothing to refund)
			s.db.Exec(ctx, "UPDATE orders SET status = 'canceled' WHERE id = $1", orderID)
			report.AutoFixed++
		default:
			// Stuck in pending -- alert for manual review
			report.ManualRequired++
		}
	}

	// 2. Orders canceled but payment not refunded
	rows2, err := s.db.Query(ctx, `
		SELECT id, payment_id, total_price
		FROM orders
		WHERE status = 'canceled'
		  AND refund_status IS NULL
		  AND payment_captured = true`)
	if err != nil {
		return nil, fmt.Errorf("query unrefunded orders: %w", err)
	}
	defer rows2.Close()

	for rows2.Next() {
		var orderID, paymentID string
		var amount int64 // cents
		rows2.Scan(&orderID, &paymentID, &amount)
		report.CheckedOrders++
		report.MismatchesFound++

		err := s.paymentSvc.Refund(ctx, paymentID, "auto_reconciliation")
		if err == nil {
			s.db.Exec(ctx, "UPDATE orders SET refund_status = 'refunded' WHERE id = $1", orderID)
			report.AutoFixed++
			report.TotalRecovered += amount
		} else {
			report.ManualRequired++
		}
	}

	return report, nil
}
```

---
