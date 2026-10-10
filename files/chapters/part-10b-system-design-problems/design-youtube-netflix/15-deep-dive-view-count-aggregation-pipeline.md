## Deep Dive: View Count Aggregation Pipeline

Counting views looks like the easiest problem in this chapter and is not. At a billion views per day you cannot increment a row per request: the write rate is bad, and the lock contention on a single viral video's row is worse, since a large fraction of a day's views can land on one row. So the pipeline batches in memory and flushes every 30 seconds or so, turning thousands of writes per second on the hot row into a handful.

Batching is the easy half. The hard half is deciding what a view *is*.

**Duplicates.** Watching a video twice is two views. Refreshing the page ten times is not ten views, and a script refreshing it ten thousand times is definitely not. So the counter needs to deduplicate on viewer identity within some window, which means the event's user ID has to actually be *used*. An aggregator that carries a `UserID` field it never reads is not counting views, it is counting requests, and the field's presence makes the code look like it handles a problem it does not touch.

**Bots.** Be careful here, because it is where the overclaiming happens. A minimum watch duration filters accidental clicks and instant bounces. It does essentially nothing against bots, which can trivially wait 30 seconds, and it is worth saying plainly that a threshold is not an anti-abuse system. Real defenses are adversarial and layered: signed playback sessions so events cannot be forged by anyone who did not stream segments, cross-referencing CDN delivery logs against reported views, per-account and per-IP rate limits, and an offline fraud pipeline that retroactively subtracts. This is why YouTube's counters visibly freeze and correct on viral videos: the fast path is optimistic and a slower, smarter pipeline audits it afterward. Design for that reconciliation instead of pretending the fast path can be right.

**Durability.** Views held in memory are views you lose when the process dies. Thirty seconds of a billion-view-a-day platform is roughly 350,000 views. Whether that is acceptable is a product decision, but it must be a decision and not an accident, and the shutdown path must at least flush rather than dropping the window on the floor. If it is not acceptable, the events belong in Kafka before they are aggregated, so a crash replays from the log rather than losing the window.

```go
package viewcount

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

const (
	// A view requires this much watch time. This filters bounces, not bots.
	minWatchSecs = 30
	// Cap the retry backlog. If the database has been unreachable for long
	// enough to accumulate this many videos, we are already in an incident and
	// growing the map until the process OOMs turns a counter outage into a
	// service outage.
	maxRetryVideos = 100_000
)

type ViewEvent struct {
	VideoID   string
	UserID    string
	WatchSecs float64
	Timestamp int64
}

// viewKey identifies one viewer watching one video, which is what we
// deduplicate on within a flush window.
type viewKey struct {
	videoID string
	userID  string
}

type ViewAggregator struct {
	mu     sync.Mutex
	counts map[string]int64
	// seen holds the keys already counted this window. It bounds the damage
	// from a refresh loop. Note the honest limit: this is per-process and per
	// window, so it does not dedupe across API servers or across windows. For
	// that you need a shared store, typically Redis with a TTL'd key per
	// (video, user), and even that is a heuristic rather than a guarantee.
	seen     map[viewKey]struct{}
	videoDB  VideoStore
	interval time.Duration
	log      *slog.Logger

	stop    chan struct{}
	stopped chan struct{}
}

func NewViewAggregator(db VideoStore, interval time.Duration, log *slog.Logger) *ViewAggregator {
	a := &ViewAggregator{
		counts:   make(map[string]int64),
		seen:     make(map[viewKey]struct{}),
		videoDB:  db,
		interval: interval,
		log:      log,
		stop:     make(chan struct{}),
		stopped:  make(chan struct{}),
	}
	go a.flushLoop()
	return a
}

// RecordView counts one view, at most once per user per video per window.
func (a *ViewAggregator) RecordView(ev ViewEvent) {
	if ev.WatchSecs < minWatchSecs {
		return
	}
	if ev.VideoID == "" || ev.UserID == "" {
		return // an unattributable event cannot be deduplicated, so do not count it
	}

	k := viewKey{videoID: ev.VideoID, userID: ev.UserID}

	a.mu.Lock()
	defer a.mu.Unlock()
	if _, dup := a.seen[k]; dup {
		return
	}
	a.seen[k] = struct{}{}
	a.counts[ev.VideoID]++
}

func (a *ViewAggregator) flushLoop() {
	defer close(a.stopped)
	ticker := time.NewTicker(a.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			a.flush()
		case <-a.stop:
			// Flush what is buffered rather than discarding the window.
			a.flush()
			return
		}
	}
}

// Close stops the flush loop and flushes the final window. Without this the
// goroutine outlives every caller and the last window of views is simply lost.
func (a *ViewAggregator) Close() {
	close(a.stop)
	<-a.stopped
}

func (a *ViewAggregator) flush() {
	a.mu.Lock()
	if len(a.counts) == 0 {
		a.mu.Unlock()
		return
	}
	batch := a.counts
	a.counts = make(map[string]int64)
	// A new window means a viewer may be counted again, which is intended: two
	// views half an hour apart are two views.
	a.seen = make(map[viewKey]struct{})
	a.mu.Unlock()

	// Bound the flush. context.Background() here means one wedged database call
	// stalls the flush loop forever and every subsequent window piles up behind
	// it, with no timeout to break the jam.
	ctx, cancel := context.WithTimeout(context.Background(), a.interval)
	defer cancel()

	for vid, inc := range batch {
		if err := a.videoDB.IncrementViewCount(ctx, vid, inc); err != nil {
			a.log.Error("view count flush failed, requeueing",
				"video_id", vid, "increment", inc, "error", err)
			a.mu.Lock()
			if len(a.counts) < maxRetryVideos {
				a.counts[vid] += inc
			} else {
				// Dropping counts is bad. Dying is worse, and takes the
				// counters for every other video with it.
				a.log.Error("retry backlog full, dropping view counts",
					"video_id", vid, "dropped", inc)
			}
			a.mu.Unlock()
		}
	}
}
```

`IncrementViewCount` must be a relative `UPDATE videos SET view_count = view_count + ?`, never a read-modify-write of an absolute value. Two aggregator instances flushing concurrently with `SET view_count = ?` will each write the total they knew about, and the second write silently erases the first. That is how a counter loses millions of views while every request logs success and every flush reports no error.

---
