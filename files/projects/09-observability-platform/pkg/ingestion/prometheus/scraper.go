// pkg/ingestion/prometheus/scraper.go
package prometheus

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	dto "github.com/prometheus/client_model/go"
	"github.com/prometheus/common/expfmt"

	"github.com/example/observability-platform/pkg/models"
	"github.com/example/observability-platform/pkg/pipeline"
)

// Target represents a Prometheus scrape target
type Target struct {
    URL          string
    Labels       models.Labels
    ScrapeInterval time.Duration
    ScrapeTimeout  time.Duration
}

// Scraper scrapes Prometheus metrics
type Scraper struct {
    targets  []*Target
    pipeline *pipeline.Pipeline
    client   *http.Client

    mu       sync.RWMutex
    running  bool
    stopCh   chan struct{}
    wg       sync.WaitGroup
}

// NewScraper creates a new Prometheus scraper
func NewScraper(targets []*Target, pipeline *pipeline.Pipeline) *Scraper {
    return &Scraper{
        targets: targets,
        pipeline: pipeline,
        client: &http.Client{
            Timeout: 10 * time.Second,
        },
    }
}

// Start starts the scraper
func (s *Scraper) Start(ctx context.Context) error {
    s.mu.Lock()
    defer s.mu.Unlock()

    if s.running {
        return fmt.Errorf("scraper already running")
    }

    s.stopCh = make(chan struct{})
    s.running = true

    // Start scraping each target
    for _, target := range s.targets {
        s.wg.Add(1)
        go s.scrapeLoop(target)
    }

    return nil
}

// Stop stops the scraper
func (s *Scraper) Stop(ctx context.Context) error {
    s.mu.Lock()
    if !s.running {
        s.mu.Unlock()
        return nil
    }
    s.running = false
    close(s.stopCh)
    s.mu.Unlock()

    s.wg.Wait()
    return nil
}

// scrapeLoop continuously scrapes a target
func (s *Scraper) scrapeLoop(target *Target) {
    defer s.wg.Done()

    ticker := time.NewTicker(target.ScrapeInterval)
    defer ticker.Stop()

    // Immediate first scrape
    s.scrapeTarget(target)

    for {
        select {
        case <-ticker.C:
            s.scrapeTarget(target)
        case <-s.stopCh:
            return
        }
    }
}

// scrapeTarget scrapes a single target
func (s *Scraper) scrapeTarget(target *Target) {
    ctx, cancel := context.WithTimeout(context.Background(), target.ScrapeTimeout)
    defer cancel()

    req, err := http.NewRequestWithContext(ctx, "GET", target.URL, nil)
    if err != nil {
        return
    }

    resp, err := s.client.Do(req)
    if err != nil {
        return
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        return
    }

    // Parse metrics
    metrics, err := s.parseMetrics(resp.Body, target.Labels)
    if err != nil {
        return
    }

    // Send to pipeline
    for _, metric := range metrics {
        s.pipeline.ProcessMetric(ctx, metric)
    }
}

// parseMetrics parses Prometheus text format
func (s *Scraper) parseMetrics(r io.Reader, targetLabels models.Labels) ([]*models.Metric, error) {
    var parser expfmt.TextParser
    metricFamilies, err := parser.TextToMetricFamilies(r)
    if err != nil {
        return nil, fmt.Errorf("parsing metrics: %w", err)
    }

    var metrics []*models.Metric
    now := time.Now()

    for name, mf := range metricFamilies {
        for _, m := range mf.Metric {
            // Convert Prometheus metric to internal format
            metric := s.convertMetric(name, mf.GetType(), m, now)

            // Add target labels
            metric.Labels = append(metric.Labels, targetLabels...)

            metrics = append(metrics, metric)
        }
    }

    return metrics, nil
}

// convertMetric converts a Prometheus metric to internal format
func (s *Scraper) convertMetric(name string, metricType dto.MetricType,
	m *dto.Metric, timestamp time.Time) *models.Metric {

	metric := &models.Metric{
		Name:      name,
		Timestamp: timestamp,
		Labels:    s.convertLabels(m.Label),
	}

	switch metricType {
    case dto.MetricType_GAUGE:
        metric.Type = models.MetricTypeGauge
        metric.Value = m.Gauge.GetValue()

    case dto.MetricType_COUNTER:
        metric.Type = models.MetricTypeCounter
        metric.Value = m.Counter.GetValue()

    case dto.MetricType_HISTOGRAM:
        metric.Type = models.MetricTypeHistogram
        metric.Count = m.Histogram.GetSampleCount()
        metric.Sum = m.Histogram.GetSampleSum()

        buckets := make([]models.Bucket, len(m.Histogram.Bucket))
        for i, b := range m.Histogram.Bucket {
            buckets[i] = models.Bucket{
                UpperBound: b.GetUpperBound(),
                Count:      b.GetCumulativeCount(),
            }
        }
        metric.Buckets = buckets

    case dto.MetricType_SUMMARY:
        metric.Type = models.MetricTypeSummary
        metric.Count = m.Summary.GetSampleCount()
        metric.Sum = m.Summary.GetSampleSum()

        quantiles := make([]models.Quantile, len(m.Summary.Quantile))
        for i, q := range m.Summary.Quantile {
            quantiles[i] = models.Quantile{
                Quantile: q.GetQuantile(),
                Value:    q.GetValue(),
            }
        }
        metric.Quantiles = quantiles
    }

    return metric
}

// convertLabels converts Prometheus labels to internal format
func (s *Scraper) convertLabels(labels []*dto.LabelPair) models.Labels {
    result := make(models.Labels, len(labels))
    for i, label := range labels {
        result[i] = models.Label{
            Name:  label.GetName(),
            Value: label.GetValue(),
        }
    }
    return result
}

// AddTarget adds a scrape target
func (s *Scraper) AddTarget(target *Target) {
    s.mu.Lock()
    defer s.mu.Unlock()

    s.targets = append(s.targets, target)

    if s.running {
        s.wg.Add(1)
        go s.scrapeLoop(target)
    }
}

// RemoveTarget removes a scrape target
func (s *Scraper) RemoveTarget(url string) {
    s.mu.Lock()
    defer s.mu.Unlock()

    for i, target := range s.targets {
        if target.URL == url {
            s.targets = append(s.targets[:i], s.targets[i+1:]...)
            return
        }
    }
}
