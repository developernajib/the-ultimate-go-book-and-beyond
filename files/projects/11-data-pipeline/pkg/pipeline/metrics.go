// pkg/pipeline/metrics.go
package pipeline

import (
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// MetricsCollector gathers pipeline metrics
type MetricsCollector struct {
	mu         sync.RWMutex
	counters   map[string]*Counter
	gauges     map[string]*Gauge
	histograms map[string]*Histogram
}

func NewMetricsCollector() *MetricsCollector {
	return &MetricsCollector{
		counters:   make(map[string]*Counter),
		gauges:     make(map[string]*Gauge),
		histograms: make(map[string]*Histogram),
	}
}

// Counter tracks cumulative values
type Counter struct {
	value int64
}

func (c *Counter) Inc() {
	atomic.AddInt64(&c.value, 1)
}

func (c *Counter) Add(delta int64) {
	atomic.AddInt64(&c.value, delta)
}

func (c *Counter) Value() int64 {
	return atomic.LoadInt64(&c.value)
}

// Gauge tracks current values
type Gauge struct {
	value int64
}

func (g *Gauge) Set(value int64) {
	atomic.StoreInt64(&g.value, value)
}

func (g *Gauge) Inc() {
	atomic.AddInt64(&g.value, 1)
}

func (g *Gauge) Dec() {
	atomic.AddInt64(&g.value, -1)
}

func (g *Gauge) Value() int64 {
	return atomic.LoadInt64(&g.value)
}

// Histogram tracks distribution of values
type Histogram struct {
	mu      sync.RWMutex
	buckets []float64
	counts  []int64
	sum     float64
	count   int64
}

func NewHistogram(buckets []float64) *Histogram {
	return &Histogram{
		buckets: buckets,
		counts:  make([]int64, len(buckets)+1),
	}
}

func (h *Histogram) Observe(value float64) {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.sum += value
	h.count++

	// Find bucket
	bucketIdx := len(h.buckets)
	for i, boundary := range h.buckets {
		if value <= boundary {
			bucketIdx = i
			break
		}
	}

	h.counts[bucketIdx]++
}

func (h *Histogram) Percentile(p float64) float64 {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if h.count == 0 {
		return 0
	}

	targetCount := float64(h.count) * p
	cumCount := int64(0)

	for i, count := range h.counts {
		cumCount += count
		if float64(cumCount) >= targetCount {
			if i >= len(h.buckets) {
				return h.buckets[len(h.buckets)-1]
			}
			return h.buckets[i]
		}
	}

	return 0
}

func (h *Histogram) Mean() float64 {
	h.mu.RLock()
	defer h.mu.RUnlock()

	if h.count == 0 {
		return 0
	}

	return h.sum / float64(h.count)
}

func (h *Histogram) Count() int64 {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.count
}

// MetricsCollector methods

func (m *MetricsCollector) Counter(name string) *Counter {
	m.mu.Lock()
	defer m.mu.Unlock()

	if counter, exists := m.counters[name]; exists {
		return counter
	}

	counter := &Counter{}
	m.counters[name] = counter
	return counter
}

func (m *MetricsCollector) Gauge(name string) *Gauge {
	m.mu.Lock()
	defer m.mu.Unlock()

	if gauge, exists := m.gauges[name]; exists {
		return gauge
	}

	gauge := &Gauge{}
	m.gauges[name] = gauge
	return gauge
}

func (m *MetricsCollector) Histogram(name string, buckets []float64) *Histogram {
	m.mu.Lock()
	defer m.mu.Unlock()

	if histogram, exists := m.histograms[name]; exists {
		return histogram
	}

	histogram := NewHistogram(buckets)
	m.histograms[name] = histogram
	return histogram
}

func (m *MetricsCollector) Report() string {
	m.mu.RLock()
	defer m.mu.RUnlock()

	var report strings.Builder
	report.WriteString("Pipeline Metrics\n")
	report.WriteString("================\n\n")

	// Counters
	if len(m.counters) > 0 {
		report.WriteString("Counters:\n")
		for name, counter := range m.counters {
			report.WriteString(fmt.Sprintf("  %s: %d\n", name, counter.Value()))
		}
		report.WriteString("\n")
	}

	// Gauges
	if len(m.gauges) > 0 {
		report.WriteString("Gauges:\n")
		for name, gauge := range m.gauges {
			report.WriteString(fmt.Sprintf("  %s: %d\n", name, gauge.Value()))
		}
		report.WriteString("\n")
	}

	// Histograms
	if len(m.histograms) > 0 {
		report.WriteString("Histograms:\n")
		for name, histogram := range m.histograms {
			report.WriteString(fmt.Sprintf("  %s:\n", name))
			report.WriteString(fmt.Sprintf("    Count: %d\n", histogram.Count()))
			report.WriteString(fmt.Sprintf("    Mean: %.2f\n", histogram.Mean()))
			report.WriteString(fmt.Sprintf("    P50: %.2f\n", histogram.Percentile(0.5)))
			report.WriteString(fmt.Sprintf("    P95: %.2f\n", histogram.Percentile(0.95)))
			report.WriteString(fmt.Sprintf("    P99: %.2f\n", histogram.Percentile(0.99)))
		}
		report.WriteString("\n")
	}

	return report.String()
}

// MetricsReporter exports metrics
type MetricsReporter interface {
	Report(collector *MetricsCollector) error
}

// ConsoleReporter prints metrics to console
type ConsoleReporter struct {
	interval time.Duration
}

func NewConsoleReporter(interval time.Duration) *ConsoleReporter {
	return &ConsoleReporter{interval: interval}
}

func (r *ConsoleReporter) Start(collector *MetricsCollector, done <-chan struct{}) {
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()

	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			fmt.Println(collector.Report())
		}
	}
}
