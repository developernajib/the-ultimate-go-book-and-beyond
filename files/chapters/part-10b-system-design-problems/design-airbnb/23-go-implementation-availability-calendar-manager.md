## Go Implementation: Availability Calendar Manager

The calendar manager gives hosts fine-grained control over their listing's availability and per-night pricing. Hosts can block date ranges for personal use or maintenance, set custom prices for high-demand periods (like holidays or local events), and configure minimum stay requirements. All updates run within a single database transaction to ensure consistency, if any part of a batch update fails, the entire operation rolls back. The key safety rule is that booked dates can never be unblocked by the host, only the booking cancellation flow can release those dates.

```go
package calendar

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"
)

type CalendarUpdate struct {
	StartDate  string
	EndDate    string
	Available  bool
	PriceCents int64
	MinStay    int
	Reason     string
}

// CalendarManager handles listing availability and custom pricing
type CalendarManager struct {
	db  *pgxpool.Pool
	rdb *redis.Client
}

type DayConfig struct {
	Date       time.Time `json:"date"`
	Available  bool      `json:"available"`
	PriceCents int64     `json:"price_cents"` // 0 = use listing default
	MinStay    int       `json:"min_stay"`    // 0 = use default
	Note       string    `json:"note"`
}

// UpdateCalendar sets availability and pricing for a date range
func (cm *CalendarManager) UpdateCalendar(ctx context.Context, listingID string, updates []CalendarUpdate) error {
	tx, err := cm.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	for _, u := range updates {
		startDate, _ := time.Parse("2006-01-02", u.StartDate)
		endDate, _ := time.Parse("2006-01-02", u.EndDate)

		if !u.Available {
			// Block dates
			_, err := tx.Exec(ctx, `
				INSERT INTO blocked_dates (listing_id, start_date, end_date, reason)
				VALUES ($1, $2, $3, $4)
				ON CONFLICT DO NOTHING`,
				listingID, startDate, endDate, u.Reason)
			if err != nil {
				return err
			}
		} else {
			// Unblock dates
			_, err := tx.Exec(ctx, `
				DELETE FROM blocked_dates
				WHERE listing_id = $1
				  AND start_date >= $2
				  AND end_date <= $3
				  AND reason != 'booked'`, // never unblock booked dates
				listingID, startDate, endDate)
			if err != nil {
				return err
			}
		}

		// Custom pricing
		if u.PriceCents > 0 {
			for d := startDate; d.Before(endDate); d = d.AddDate(0, 0, 1) {
				tx.Exec(ctx, `
					INSERT INTO custom_pricing (listing_id, date, price_cents, min_stay)
					VALUES ($1, $2, $3, $4)
					ON CONFLICT (listing_id, date) DO UPDATE SET price_cents = $3, min_stay = $4`,
					listingID, d, u.PriceCents, u.MinStay)
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return err
	}

	// Invalidate cache. DEL does not expand glob patterns, so resolve
	// the matching keys first (production code uses SCAN, not KEYS).
	keys, _ := cm.rdb.Keys(ctx, fmt.Sprintf("avail:%s:*", listingID)).Result()
	if len(keys) > 0 {
		cm.rdb.Del(ctx, keys...)
	}
	return nil
}

// GetCalendar returns availability for a month
func (cm *CalendarManager) GetCalendar(ctx context.Context, listingID string, month time.Time) ([]DayConfig, error) {
	start := time.Date(month.Year(), month.Month(), 1, 0, 0, 0, 0, time.UTC)
	end := start.AddDate(0, 1, 0)

	// Get blocked dates
	blocked := make(map[string]bool)
	rows, _ := cm.db.Query(ctx, `
		SELECT start_date, end_date FROM blocked_dates
		WHERE listing_id = $1 AND start_date < $3 AND end_date > $2`,
		listingID, start, end)
	defer rows.Close()
	for rows.Next() {
		var s, e time.Time
		rows.Scan(&s, &e)
		for d := s; d.Before(e); d = d.AddDate(0, 0, 1) {
			blocked[d.Format("2006-01-02")] = true
		}
	}

	// Get custom pricing
	pricing := make(map[string]DayConfig)
	rows2, _ := cm.db.Query(ctx, `
		SELECT date, price_cents, min_stay FROM custom_pricing
		WHERE listing_id = $1 AND date >= $2 AND date < $3`,
		listingID, start, end)
	defer rows2.Close()
	for rows2.Next() {
		var d time.Time
		var config DayConfig
		rows2.Scan(&d, &config.PriceCents, &config.MinStay)
		pricing[d.Format("2006-01-02")] = config
	}

	// Build calendar
	var days []DayConfig
	for d := start; d.Before(end); d = d.AddDate(0, 0, 1) {
		key := d.Format("2006-01-02")
		day := DayConfig{
			Date:      d,
			Available: !blocked[key],
		}
		if custom, ok := pricing[key]; ok {
			day.PriceCents = custom.PriceCents
			day.MinStay = custom.MinStay
		}
		days = append(days, day)
	}

	return days, nil
}
```

---
