## API Design

A production crawler needs management APIs so operators can seed new URLs, start and stop crawl jobs, monitor progress, and block problematic domains. These REST endpoints expose the crawler's internal state and controls through a clean HTTP interface. The design follows standard REST conventions with versioned paths and JSON payloads.

Treat this as an internal control plane, never a public API, and note what the endpoints actually grant. `POST /seeds` aims a 10,000 request per second fleet at a URL of the caller's choosing, which makes an unauthenticated seed endpoint a DDoS amplifier with your organization's name on the traffic. `POST /crawl/start` sets `workers` and `max_depth`. So these routes need authentication and role-based authorization, seed URLs need validation against an allowlist of schemes (http and https only, rejecting `file:`, `gopher:`, and internal hostnames that would turn the crawler into an SSRF vector into your own VPC), and `max_depth` and `workers` need server-side bounds rather than trusting the body. Note also that `{domain}` is interpolated into paths and storage keys, so it must be parsed and canonicalized rather than passed through.

### REST Endpoints (Crawler Management)

The endpoints below cover the full lifecycle of a crawl operation: adding seed URLs, starting and pausing the crawl, checking per-domain statistics, and blocking spam domains. The `CrawlStatus` struct provides a real-time snapshot of throughput, queue depth, and error rates that operators can poll to monitor crawl health.

```go
package api

import "time"

// POST /api/v1/seeds { "urls": ["https://example.com"], "priority": 1.0 }
// GET /api/v1/seeds?status=pending

// POST /api/v1/crawl/start { "max_depth": 5, "workers": 200 }
// GET /api/v1/crawl/status

type CrawlStatus struct {
	State           string    `json:"state"` // running, paused, stopped
	URLsCrawled     int64     `json:"urls_crawled"`
	URLsQueued      int64     `json:"urls_queued"`
	PagesPerSecond  float64   `json:"pages_per_second"`
	ErrorRate       float64   `json:"error_rate"`
	ActiveWorkers   int       `json:"active_workers"`
	StartedAt       time.Time `json:"started_at"`
	BytesDownloaded int64     `json:"bytes_downloaded"`
}

// POST /api/v1/crawl/pause
// POST /api/v1/crawl/resume

// GET /api/v1/domains/{domain}/stats
type DomainStats struct {
	Domain         string    `json:"domain"`
	URLsCrawled    int64     `json:"urls_crawled"`
	ErrorRate      float64   `json:"error_rate"`
	AvgFetchTimeMs int64     `json:"avg_fetch_time_ms"`
	LastCrawled    time.Time `json:"last_crawled"`
	CrawlDelayMs   int64     `json:"crawl_delay_ms"` // ms, matching domain_metadata
	IsBlocked      bool      `json:"is_blocked"`
}

// POST /api/v1/domains/{domain}/block { "reason": "spam_farm" }
// GET /api/v1/metrics (Prometheus format)
```

---
