## Go Implementation: Billing Service

The billing service aggregates impression and click events into monthly invoices for advertisers. It queries the billing_events table, filters out fraudulent events (so advertisers are not charged for fake clicks), and calculates a 15% platform fee on top of the ad spend. This is a batch operation that runs monthly rather than in real time, because billing accuracy matters more than speed. Notice that the service uses a single aggregation query grouped by campaign, which is efficient even over millions of events when backed by proper indexes.

```go
package billing

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type BillingService struct{ db *pgxpool.Pool }

// All monetary amounts are int64 micro-dollars (1 USD = 1,000,000 micros),
// never floating point: see Common Mistakes on floating-point money.
type Invoice struct {
	AdvertiserID, Period                string
	Lines                               []InvoiceLine
	TotalMicros, FeeMicros, GrandMicros int64
	CreatedAt                           time.Time
}

type InvoiceLine struct {
	CampaignID          string
	Impressions, Clicks int64
	SpendMicros         int64
	Period              string
}

func (s *BillingService) GenerateInvoice(ctx context.Context, advID, period string) (*Invoice, error) {
	rows, err := s.db.Query(ctx, `SELECT campaign_id,
		COUNT(*) FILTER (WHERE event_type='impression'),
		COUNT(*) FILTER (WHERE event_type='click'),
		SUM(cost_micros)
		FROM billing_events
		WHERE advertiser_id=$1 AND period=$2 AND is_fraud=false
		GROUP BY campaign_id`, advID, period)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	inv := &Invoice{AdvertiserID: advID, Period: period, CreatedAt: time.Now()}
	for rows.Next() {
		var l InvoiceLine
		if err := rows.Scan(&l.CampaignID, &l.Impressions, &l.Clicks, &l.SpendMicros); err != nil {
			return nil, err
		}
		inv.Lines = append(inv.Lines, l)
		inv.TotalMicros += l.SpendMicros
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	inv.FeeMicros = inv.TotalMicros * 15 / 100 // 15% platform fee, integer math
	inv.GrandMicros = inv.TotalMicros + inv.FeeMicros

	_, err = s.db.Exec(ctx, `INSERT INTO invoices
		(id,advertiser_id,period,total_micros,fee_micros,grand_micros,status,created_at)
		VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'pending',NOW())`,
		advID, period, inv.TotalMicros, inv.FeeMicros, inv.GrandMicros)
	if err != nil {
		return nil, err
	}
	return inv, nil
}
```

---
