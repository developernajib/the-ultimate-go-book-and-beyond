## Go Implementation: Crawl Metrics Collector

The metrics collector tracks real-time crawl statistics using atomic counters for thread-safe updates without lock contention. It records page fetches, errors, bytes downloaded, and duplicate detections at both the global and per-domain level. The `GetSnapshot` method returns a point-in-time view of all metrics, including a pages-per-second calculation based on a sliding time window. The `GetTopDomains` method helps operators identify which domains are consuming the most crawl budget or producing the most errors.

Three things here are easy to get wrong, and all three produce numbers that look plausible on a dashboard while being false, which is worse than no dashboard at all.

**Atomic counters do not make a struct thread-safe.** Mixing `atomic` counters with a plain `time.Time` field is the classic version of this. The window reset needs both the counter and the timestamp to move together, so the pair has to sit under the mutex. An unsynchronized `windowStart = time.Now()` is a genuine data race that `go test -race` catches immediately, and races on a `time.Time` (two words) can produce a torn value, not just a stale one.

**Rates need the right denominator.** Dividing total errors by total *crawls* is wrong, because a request that failed was never a crawl. Given 100 successes and 200 timeouts, that formula reports a 200% error rate. The denominator has to be total attempts.

**A snapshot must not consume what it reports.** Reading the window counter with `SwapInt64(..., 0)` means the first caller destroys the data for the next one, so the log ticker and the status API silently steal each other's numbers and both report nonsense. `GetSnapshot` here is a pure read, and window rotation is an explicit separate call owned by exactly one caller.

```go
package metrics

import (
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// CrawlerMetrics collects real-time crawl statistics
type CrawlerMetrics struct {
	totalAttempts   int64 // fetches + errors: the denominator for rates
	totalCrawled    int64
	totalErrors     int64
	totalBytes      int64
	totalDuplicates int64

	domainStats map[string]*DomainMetrics
	mu          sync.RWMutex

	startTime time.Time

	// windowMu guards the rate window. The counter and its start time must be
	// read and reset together, so they cannot be plain atomics.
	windowMu      sync.Mutex
	windowStart   time.Time
	windowCrawled int64

	// queueSize and activeWorkers are pushed in by the components that know
	// them. Without a setter these stay 0 forever and every dashboard that
	// reads them is quietly lying.
	queueSize     int64
	activeWorkers int64
}

type DomainMetrics struct {
	Crawled      int64
	Errors       int64
	TotalFetchMs int64
	LastCrawled  time.Time
}

type MetricSnapshot struct {
	TotalCrawled  int64   `json:"total_crawled"`
	TotalErrors   int64   `json:"total_errors"`
	TotalBytes    int64   `json:"total_bytes"`
	PagesPerSec   float64 `json:"pages_per_sec"`
	ErrorRate     float64 `json:"error_rate"`
	DuplicateRate float64 `json:"duplicate_rate"`
	QueueSize     int64   `json:"queue_size"`
	ActiveWorkers int     `json:"active_workers"`
	UpTime        string  `json:"uptime"`
}

func NewCrawlerMetrics() *CrawlerMetrics {
	return &CrawlerMetrics{
		domainStats: make(map[string]*DomainMetrics),
		startTime:   time.Now(),
		windowStart: time.Now(),
	}
}

// RecordFetch records a completed page fetch (any status code)
func (m *CrawlerMetrics) RecordFetch(domain string, statusCode int, fetchMs int64) {
	atomic.AddInt64(&m.totalCrawled, 1)
	atomic.AddInt64(&m.totalAttempts, 1)

	m.windowMu.Lock()
	m.windowCrawled++
	m.windowMu.Unlock()

	m.mu.Lock()
	dm, ok := m.domainStats[domain]
	if !ok {
		dm = &DomainMetrics{}
		m.domainStats[domain] = dm
	}
	dm.Crawled++
	dm.TotalFetchMs += fetchMs
	dm.LastCrawled = time.Now()
	if statusCode >= 400 {
		dm.Errors++
		atomic.AddInt64(&m.totalErrors, 1)
	}
	m.mu.Unlock()
}

// RecordError records a fetch that never produced a response
func (m *CrawlerMetrics) RecordError(domain string, err error) {
	atomic.AddInt64(&m.totalErrors, 1)
	atomic.AddInt64(&m.totalAttempts, 1) // an attempt, but not a crawl

	m.mu.Lock()
	dm, ok := m.domainStats[domain]
	if !ok {
		dm = &DomainMetrics{}
		m.domainStats[domain] = dm
	}
	dm.Errors++
	m.mu.Unlock()
}

// RecordDuplicate records a content duplicate detection
func (m *CrawlerMetrics) RecordDuplicate() {
	atomic.AddInt64(&m.totalDuplicates, 1)
}

// RecordBytes records bytes downloaded. The fetcher must call this with the
// response size, or TotalBytes and every bandwidth panel built on it read 0.
func (m *CrawlerMetrics) RecordBytes(n int64) {
	atomic.AddInt64(&m.totalBytes, n)
}

// SetQueueSize is called by the frontier consumer with its current lag.
func (m *CrawlerMetrics) SetQueueSize(n int64) { atomic.StoreInt64(&m.queueSize, n) }

// SetActiveWorkers is called by the coordinator with its live worker count.
func (m *CrawlerMetrics) SetActiveWorkers(n int64) { atomic.StoreInt64(&m.activeWorkers, n) }

// RotateWindow closes the current rate window and returns its pages/sec.
// Exactly one caller should own this, typically the orchestrator's ticker.
// It is separate from GetSnapshot so that reading metrics never destroys them.
func (m *CrawlerMetrics) RotateWindow() float64 {
	m.windowMu.Lock()
	defer m.windowMu.Unlock()

	elapsed := time.Since(m.windowStart).Seconds()
	pps := 0.0
	if elapsed > 0 {
		pps = float64(m.windowCrawled) / elapsed
	}
	m.windowCrawled = 0
	m.windowStart = time.Now()
	return pps
}

// GetSnapshot returns current metrics. It is a pure read: any number of
// callers can poll it without stealing each other's data.
func (m *CrawlerMetrics) GetSnapshot() MetricSnapshot {
	attempts := atomic.LoadInt64(&m.totalAttempts)
	total := atomic.LoadInt64(&m.totalCrawled)
	errs := atomic.LoadInt64(&m.totalErrors)
	bytes := atomic.LoadInt64(&m.totalBytes)
	dupes := atomic.LoadInt64(&m.totalDuplicates)

	m.windowMu.Lock()
	elapsed := time.Since(m.windowStart).Seconds()
	windowCrawled := m.windowCrawled
	m.windowMu.Unlock()

	pps := float64(0)
	if elapsed > 0 {
		pps = float64(windowCrawled) / elapsed
	}

	// Rates are per ATTEMPT. Dividing errors by successful crawls lets the
	// "rate" exceed 1.0, which no alert threshold can interpret.
	errorRate := float64(0)
	if attempts > 0 {
		errorRate = float64(errs) / float64(attempts)
	}

	// Duplicates are only detectable on pages we actually fetched, so this one
	// is per crawl, not per attempt.
	dupeRate := float64(0)
	if total > 0 {
		dupeRate = float64(dupes) / float64(total)
	}

	return MetricSnapshot{
		TotalCrawled:  total,
		TotalErrors:   errs,
		TotalBytes:    bytes,
		PagesPerSec:   pps,
		ErrorRate:     errorRate,
		DuplicateRate: dupeRate,
		QueueSize:     atomic.LoadInt64(&m.queueSize),
		ActiveWorkers: int(atomic.LoadInt64(&m.activeWorkers)),
		UpTime:        time.Since(m.startTime).Round(time.Second).String(),
	}
}

// GetTopDomains returns the most-crawled domains
func (m *CrawlerMetrics) GetTopDomains(limit int) []DomainSummary {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var summaries []DomainSummary
	for domain, dm := range m.domainStats {
		avgFetchMs := float64(0)
		if dm.Crawled > 0 {
			avgFetchMs = float64(dm.TotalFetchMs) / float64(dm.Crawled)
		}
		summaries = append(summaries, DomainSummary{
			Domain:      domain,
			Crawled:     dm.Crawled,
			Errors:      dm.Errors,
			AvgFetchMs:  avgFetchMs,
			LastCrawled: dm.LastCrawled,
		})
	}

	// Sort by crawled count descending
	sort.Slice(summaries, func(i, j int) bool {
		return summaries[i].Crawled > summaries[j].Crawled
	})

	if len(summaries) > limit {
		summaries = summaries[:limit]
	}
	return summaries
}

type DomainSummary struct {
	Domain      string    `json:"domain"`
	Crawled     int64     `json:"crawled"`
	Errors      int64     `json:"errors"`
	AvgFetchMs  float64   `json:"avg_fetch_ms"`
	LastCrawled time.Time `json:"last_crawled"`
}
```

---
