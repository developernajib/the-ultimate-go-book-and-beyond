## Deep Dive: Adaptive Recrawl Scheduler

The web is not static. News sites update every hour, while documentation pages might not change for months. A naive approach of recrawling every page on a fixed schedule wastes bandwidth on pages that rarely change and misses updates on pages that change frequently. The adaptive recrawl scheduler solves this by tracking each URL's change rate and adjusting the recrawl interval accordingly. If a page changed on more than 80% of recent visits, the interval gets halved (down to a minimum of 1 hour). If a page almost never changes, the interval doubles (up to 30 days).

"Recent" is the load-bearing word, and it is where the obvious implementation goes wrong. Counting lifetime changes and dividing by lifetime crawls gives a rate that can never forget. A news article that changed on all of its first 100 crawls and is then archived and frozen forever still reports a 0.67 change rate after 50 unchanged visits, and it takes another 850 unchanged crawls before the lifetime average falls below 0.1. The crawler would keep hammering a dead page for years. The fix is an exponentially weighted moving average, which decays old evidence geometrically and lets a page's behavior change without a fight. It also costs one float per URL instead of two counters, which matters at 10 billion URLs.

The second trap is the multiplicative update itself. Every branch below scales the *current* interval, so if that interval is ever 0, three of the four branches return 0 forever and the URL is rescheduled for "now" on an infinite loop. A multiplicative controller must never be allowed to reach zero, hence the explicit floor rather than trusting the stored value.

```go
package scheduler

import (
	"context"
	"errors"
	"math"
	"math/rand/v2"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	minIntervalHours     = 1   // never recrawl a URL more than hourly
	maxIntervalHours     = 720 // 30 days
	defaultIntervalHours = 168 // 7 days, the first-crawl guess
	changeRateAlpha      = 0.3 // EWMA weight on the newest observation
)

// Determines when each URL should be recrawled based on change history
type RecrawlScheduler struct {
	db *pgxpool.Pool
}

type RecrawlPolicy struct {
	URL string
	// ChangeRate is an EWMA over recent crawls, not a lifetime average, so a
	// page that stops changing is recognized in a handful of crawls rather
	// than the several hundred a cumulative mean would need.
	ChangeRate    float64
	IntervalHours float64
}

// ScheduleRecrawl adapts interval based on change rate
func (s *RecrawlScheduler) ScheduleRecrawl(ctx context.Context, url string, contentChanged bool) error {
	policy, err := s.getPolicy(ctx, url)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		// Genuinely the first crawl. Only THIS error means "no history".
		return s.setNextCrawl(ctx, url, s.nextTime(defaultIntervalHours), defaultIntervalHours)
	case err != nil:
		// A real database failure. Returning nil here, or treating it as a
		// first crawl, would silently reset the schedule of every URL during
		// an outage and stampede the whole frontier back to 7-day intervals.
		return err
	}

	observed := 0.0
	if contentChanged {
		observed = 1.0
	}
	policy.ChangeRate = changeRateAlpha*observed + (1-changeRateAlpha)*policy.ChangeRate

	interval := s.calculateInterval(policy)
	return s.setNextCrawl(ctx, url, s.nextTime(interval), interval)
}

// nextTime spreads recrawls with +/-10% jitter. Without it, a batch of URLs
// discovered together is rescheduled together forever, and the frontier arrives
// in synchronized waves instead of a smooth stream.
func (s *RecrawlScheduler) nextTime(intervalHours float64) time.Time {
	jitter := 1 + (rand.Float64()*0.2 - 0.1)
	return time.Now().Add(time.Duration(intervalHours * jitter * float64(time.Hour)))
}

func (s *RecrawlScheduler) calculateInterval(p *RecrawlPolicy) float64 {
	// Clamp the base first. Every branch below is multiplicative, so a stored
	// 0 would return 0 forever and reschedule this URL for "now" on a loop.
	base := math.Max(minIntervalHours, p.IntervalHours)

	var next float64
	switch {
	case p.ChangeRate > 0.8:
		next = base / 2 // halve
	case p.ChangeRate > 0.5:
		next = base // keep current
	case p.ChangeRate > 0.1:
		next = base * 1.5 // increase 50%
	default:
		next = base * 2 // double
	}
	return math.Min(maxIntervalHours, math.Max(minIntervalHours, next))
}

func (s *RecrawlScheduler) getPolicy(ctx context.Context, url string) (*RecrawlPolicy, error) {
	var p RecrawlPolicy
	err := s.db.QueryRow(ctx, "SELECT url, change_rate, interval_hours FROM recrawl_policies WHERE url = $1", url).
		Scan(&p.URL, &p.ChangeRate, &p.IntervalHours)
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *RecrawlScheduler) setNextCrawl(ctx context.Context, url string, nextCrawl time.Time, intervalHours float64) error {
	_, err := s.db.Exec(ctx,
		"INSERT INTO recrawl_policies (url, next_crawl_at, interval_hours) VALUES ($1, $2, $3) ON CONFLICT (url) DO UPDATE SET next_crawl_at = $2, interval_hours = $3",
		url, nextCrawl, intervalHours)
	return err
}

// Heuristics:
// News sites:         1-4 hours
// Social media:       4-12 hours
// Documentation:      7-14 days
// Static pages:       30 days
// 404/error pages:    retry 3 times, then drop
```

---
