## Deep Dive: Royalty Calculation Pipeline

Royalty calculation is the most business-critical code in a music streaming platform, and it is the place where the usual engineering instincts are actively wrong. Every time a user listens to a track for at least 30 seconds it counts as a "play" that generates royalty payments to artists, songwriters, and labels. The system uses a pro-rata model: the subscription revenue pool is split proportionally by each track's share of total plays. This pipeline must be accurate, auditable, idempotent, and capable of processing billions of play events per month.

Four rules govern this code, and every one of them is a rule people break.

**Never use float64 for money.** A `float64` cannot represent 0.10 exactly, and errors accumulate across billions of operations. The per-play rate makes this worse than usual: the pool divided by total plays lands somewhere around a third of a cent, so the entire calculation happens down in the digits where binary floating point is least able to represent decimal values exactly. Money is `int64` in minor units, always.

**Rounding must not create or destroy value.** This is the subtle one. Computing each track's royalty independently and rounding to the nearest cent gives an allocation whose sum is not the pool. It is off by some number of cents in one direction or the other, and there is no correct answer to "where did the extra $340 come from", because the money never existed. Allocation has to be exact by construction, which is what the largest remainder method below does: floor every share, then hand the leftover cents out one at a time to the tracks with the largest fractional remainders. The sum equals the pool exactly, always, and the rule for who gets the extra cent is deterministic and explainable to an auditor.

**Pay everyone.** The tempting `ORDER BY plays DESC LIMIT 10000` makes the query fast and pays only the ten thousand most-played tracks in the catalog, while the rate was computed by dividing the pool across every play including all the ones belonging to tracks that just got cut. This does not error. It produces a report that balances internally and silently pays nothing to the long tail, which is most artists on the platform.

**Make it idempotent.** A monthly batch job will be re-run. The machine dies halfway, someone finds a bug in the aggregation, the job gets triggered twice by a scheduler retry. A bare `INSERT` in a loop means the second run pays everyone a second time. A unique constraint on `(track_id, period)` makes the database refuse the duplicate rather than trusting the job to only run once.

```go
package royalty

import (
	"context"
	"fmt"
	"math/big"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// RoyaltyService calculates per-play royalties for artists and labels.
type RoyaltyService struct {
	db *pgxpool.Pool
}

// payoutShareBps is the fraction of subscription revenue that flows into the
// royalty pool, in basis points. Integer math, and the real number is a
// negotiated blend of contracts rather than a constant, so it belongs in
// configuration next to the rights data. It sits here to keep the example short.
const payoutShareBps = 7000 // 70%

type RoyaltyReport struct {
	Period     string `json:"period"` // e.g., "2026-07"
	TotalPlays int64  `json:"total_plays"`
	// Cents, not dollars, and not float64.
	TotalRoyaltyPoolCents int64          `json:"total_royalty_pool_cents"`
	ByTrack               []TrackRoyalty `json:"by_track"`
}

type TrackRoyalty struct {
	TrackID   string `json:"track_id"`
	TrackName string `json:"track_name"`
	Plays     int64  `json:"plays"`
	// ShareBps is basis points of the pool (1 bps = 0.01%). Integer, so the
	// report cannot disagree with the money by a rounding step.
	ShareBps    int64 `json:"share_bps"`
	AmountCents int64 `json:"amount_cents"`
}

// CalculateMonthlyRoyalties runs the monthly royalty batch.
// Pro-rata: each track's share = its plays / total plays * pool.
func (s *RoyaltyService) CalculateMonthlyRoyalties(ctx context.Context, year int, month int) (*RoyaltyReport, error) {
	period := fmt.Sprintf("%d-%02d", year, month)
	startDate := time.Date(year, time.Month(month), 1, 0, 0, 0, 0, time.UTC)
	endDate := startDate.AddDate(0, 1, 0)

	// Sum the settled column, not the charged one. subscription_payments is
	// multi-currency, so SUM(amount_cents) would add yen to euros and return a
	// confident, meaningless number.
	//
	// COALESCE because SUM over zero rows returns NULL, not 0, and scanning
	// NULL into a non-nullable int64 is an error rather than a zero.
	var totalRevenueCents int64
	if err := s.db.QueryRow(ctx, `
		SELECT COALESCE(SUM(settled_usd_cents), 0) FROM subscription_payments
		WHERE period = $1 AND status = 'paid'`, period).Scan(&totalRevenueCents); err != nil {
		return nil, fmt.Errorf("sum revenue for %s: %w", period, err)
	}

	// Integer math: multiply before dividing so the truncation happens once.
	poolCents := totalRevenueCents * payoutShareBps / 10000

	var totalPlays int64
	if err := s.db.QueryRow(ctx, `
		SELECT COUNT(*) FROM play_history
		WHERE played_at >= $1 AND played_at < $2
		  AND is_counted_play = true`, startDate, endDate).Scan(&totalPlays); err != nil {
		return nil, fmt.Errorf("count plays for %s: %w", period, err)
	}
	if totalPlays == 0 {
		return nil, fmt.Errorf("no plays in period %s", period)
	}

	// Every track with at least one qualifying play. No LIMIT: the rate was
	// derived from all plays, so the allocation must cover all plays.
	rows, err := s.db.Query(ctx, `
		SELECT ph.track_id, t.title, COUNT(*) AS plays
		FROM play_history ph
		JOIN tracks t ON t.id = ph.track_id
		WHERE ph.played_at >= $1 AND ph.played_at < $2
		  AND ph.is_counted_play = true
		GROUP BY ph.track_id, t.title`, startDate, endDate)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tracks []TrackRoyalty
	for rows.Next() {
		var tr TrackRoyalty
		if err := rows.Scan(&tr.TrackID, &tr.TrackName, &tr.Plays); err != nil {
			return nil, err
		}
		tr.ShareBps = tr.Plays * 10000 / totalPlays
		tracks = append(tracks, tr)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	allocate(poolCents, totalPlays, tracks)

	report := &RoyaltyReport{
		Period:                period,
		TotalPlays:            totalPlays,
		TotalRoyaltyPoolCents: poolCents,
		ByTrack:               tracks,
	}
	if err := s.persist(ctx, period, tracks); err != nil {
		return nil, err
	}
	return report, nil
}

// allocate splits poolCents across tracks in proportion to plays, using the
// largest remainder method. Guarantees sum(AmountCents) == poolCents exactly.
func allocate(poolCents, totalPlays int64, tracks []TrackRoyalty) {
	type rem struct {
		idx int
		r   *big.Int
	}
	rems := make([]rem, len(tracks))

	// poolCents * plays overflows int64 at realistic scale: a pool in the
	// hundreds of millions of dollars times billions of plays is far past
	// 9.2e18. big.Int keeps the intermediate product exact.
	pool := big.NewInt(poolCents)
	total := big.NewInt(totalPlays)
	var distributed int64

	for i := range tracks {
		num := new(big.Int).Mul(pool, big.NewInt(tracks[i].Plays))
		q, r := new(big.Int).QuoRem(num, total, new(big.Int))
		tracks[i].AmountCents = q.Int64() // floor of the exact share
		distributed += tracks[i].AmountCents
		rems[i] = rem{idx: i, r: r}
	}

	// Floors always undershoot, so there are leftover cents to place. There are
	// strictly fewer than len(tracks) of them.
	leftover := poolCents - distributed

	// Largest remainder first. Tie-break on TrackID so the allocation is
	// deterministic: rerunning the job must produce identical output, or the
	// idempotency guarantee downstream is worthless.
	sort.Slice(rems, func(i, j int) bool {
		if c := rems[i].r.Cmp(rems[j].r); c != 0 {
			return c > 0
		}
		return tracks[rems[i].idx].TrackID < tracks[rems[j].idx].TrackID
	})
	for i := int64(0); i < leftover; i++ {
		tracks[rems[i].idx].AmountCents++
	}
}

// persist writes the payable records in one transaction.
//
// The unique constraint on (track_id, period) is the idempotency guarantee, and
// it lives in the database rather than in a read-then-write check here, because
// a check-then-insert is a race: two concurrent runs both read "no record" and
// both insert. DO NOTHING makes a re-run a no-op instead of a second payment.
func (s *RoyaltyService) persist(ctx context.Context, period string, tracks []TrackRoyalty) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	batch := &pgx.Batch{}
	for _, tr := range tracks {
		batch.Queue(`
			INSERT INTO royalty_records
			    (track_id, period, plays, amount_cents, created_at)
			VALUES ($1, $2, $3, $4, NOW())
			ON CONFLICT (track_id, period) DO NOTHING`,
			tr.TrackID, period, tr.Plays, tr.AmountCents)
	}
	if err := tx.SendBatch(ctx, batch).Close(); err != nil {
		return fmt.Errorf("persist royalties for %s: %w", period, err)
	}
	return tx.Commit(ctx)
}
```

The rights-holder split is the stage after this one. A single track routinely has several parties behind it (performer, songwriter, publisher, label) with contractual percentages, so `royalty_records` is the per-track total that a downstream job divides again. That split faces the same conservation problem and takes the same answer: allocate integer minor units by largest remainder, never round each party independently.

---
