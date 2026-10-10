## Go Implementation: Crawl Orchestrator

The orchestrator is the top-level component that ties everything together. It loads seed URLs into the frontier, starts the worker coordinator and recrawl scheduler as background goroutines, and periodically reports metrics. It also provides pause and resume controls so operators can temporarily halt the crawl without losing any state. This is the entry point you would call from your `main` function to kick off a crawl job.

A pause control is worth studying because it is so easy to write one that does nothing. Setting a `state` field to `"paused"` under a mutex looks like a pause, logs like a pause, and reads like a pause in review. It is not one unless something *consults* that state, and a field that is only ever assigned is not a control, it is a comment with a mutex around it. The version below exposes `WaitIfPaused`, which every worker calls before claiming its next URL, so pausing actually blocks the fetch loop. The gate is a channel rather than a polled boolean so that resuming wakes every waiter at once instead of leaving them to notice on their next tick, and it takes a `ctx` so that a paused crawl still shuts down promptly on SIGTERM rather than deadlocking until someone resumes it.

```go
package orchestrator

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

type URLFrontier struct{}

func (f *URLFrontier) Add(ctx context.Context, rawURL string, depth int, discoveredFrom string) error {
	return nil
}

type RecrawlScheduler struct{}

func (s *RecrawlScheduler) ScheduleLoop(ctx context.Context) {}

type WorkerCoordinator struct{}

func (w *WorkerCoordinator) MonitorWorkers(ctx context.Context) {}

type CrawlStats struct {
	TotalCrawled  int64
	QueueSize     int64
	ErrorRate     float64
	ActiveWorkers int
}

type CrawlerMetrics struct{}

func (m *CrawlerMetrics) RotateWindow() float64   { return 0 }
func (m *CrawlerMetrics) GetSnapshot() CrawlStats { return CrawlStats{} }

func (o *CrawlOrchestrator) loadSeeds(ctx context.Context, seeds []string) error {
	for _, seed := range seeds {
		if err := o.frontier.Add(ctx, seed, 0, ""); err != nil {
			return err
		}
	}
	return nil
}

// CrawlOrchestrator manages the overall crawl lifecycle
type CrawlOrchestrator struct {
	frontier    *URLFrontier
	scheduler   *RecrawlScheduler
	coordinator *WorkerCoordinator
	metrics     *CrawlerMetrics
	logger      *slog.Logger

	mu    sync.Mutex
	state string // running, paused, stopped
	// resume is nil while running. Pause replaces it with an open channel that
	// Resume closes, releasing every blocked worker at once.
	resume chan struct{}
}

// Start begins the crawl operation
func (o *CrawlOrchestrator) Start(ctx context.Context, config CrawlConfig) error {
	o.mu.Lock()
	o.state = "running"
	o.mu.Unlock()

	o.logger.Info("crawl started",
		"workers", config.WorkerCount,
		"max_depth", config.MaxDepth,
		"target_pages_sec", config.TargetPagesPerSec)

	// 1. Load seed URLs into frontier
	if err := o.loadSeeds(ctx, config.SeedURLs); err != nil {
		return fmt.Errorf("load seeds: %w", err)
	}

	// 2. Start worker coordinator
	go o.coordinator.MonitorWorkers(ctx)

	// 3. Start recrawl scheduler
	go o.scheduler.ScheduleLoop(ctx)

	// 4. Start metrics reporter
	go o.reportMetrics(ctx)

	// 5. Wait for completion or cancellation
	<-ctx.Done()

	o.mu.Lock()
	o.state = "stopped"
	o.mu.Unlock()

	return nil
}

// Pause temporarily stops crawling (workers drain current work)
func (o *CrawlOrchestrator) Pause() {
	o.mu.Lock()
	if o.resume == nil { // idempotent: pausing twice must not orphan a channel
		o.resume = make(chan struct{})
		o.state = "paused"
	}
	o.mu.Unlock()
	o.logger.Info("crawl paused")
}

// Resume continues a paused crawl
func (o *CrawlOrchestrator) Resume() {
	o.mu.Lock()
	if o.resume != nil {
		close(o.resume) // wakes every blocked worker
		o.resume = nil
		o.state = "running"
	}
	o.mu.Unlock()
	o.logger.Info("crawl resumed")
}

// WaitIfPaused blocks while the crawl is paused. Workers call this before
// taking their next URL. This is the read that makes Pause mean something.
// It returns ctx.Err() if the crawl is shut down while paused, so a paused
// fleet still exits on SIGTERM instead of hanging.
func (o *CrawlOrchestrator) WaitIfPaused(ctx context.Context) error {
	o.mu.Lock()
	ch := o.resume
	o.mu.Unlock()

	if ch == nil {
		return nil // running, the common path, no blocking
	}
	select {
	case <-ch:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// State reports the current lifecycle state for the status API.
func (o *CrawlOrchestrator) State() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.state
}

func (o *CrawlOrchestrator) reportMetrics(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			// This ticker is the single owner of the rate window. Everyone
			// else (the status API, Prometheus) calls GetSnapshot, which is a
			// pure read and cannot steal the window out from under us.
			pps := o.metrics.RotateWindow()
			stats := o.metrics.GetSnapshot()
			o.logger.Info("crawl progress",
				"pages_per_sec", pps,
				"total_crawled", stats.TotalCrawled,
				"queue_size", stats.QueueSize,
				"error_rate", stats.ErrorRate,
				"active_workers", stats.ActiveWorkers)
		}
	}
}

type CrawlConfig struct {
	SeedURLs          []string
	WorkerCount       int
	MaxDepth          int
	TargetPagesPerSec float64
	PolitenessDelay   time.Duration
}
```

---
