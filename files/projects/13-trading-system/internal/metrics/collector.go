// internal/metrics/collector.go
package metrics

import (
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Collector collects trading system metrics
type Collector struct {
	// Order metrics
	ordersSubmitted prometheus.Counter
	ordersAccepted  prometheus.Counter
	ordersRejected  prometheus.Counter
	ordersCanceled  prometheus.Counter
	ordersFilled    prometheus.Counter

	// Fill metrics
	fillsProcessed prometheus.Counter
	fillVolume     prometheus.Counter
	fillValue      prometheus.Counter

	// Latency metrics
	orderLatency      prometheus.Histogram
	fillLatency       prometheus.Histogram
	marketDataLatency prometheus.Histogram

	// Market data metrics
	tradesProcessed prometheus.Counter
	quotesProcessed prometheus.Counter
	booksProcessed  prometheus.Counter

	// Position metrics
	positionCount prometheus.Gauge
	totalPnL      prometheus.Gauge
	realizedPnL   prometheus.Gauge
	unrealizedPnL prometheus.Gauge

	// Risk metrics
	riskChecksTotal  prometheus.Counter
	riskChecksPassed prometheus.Counter
	riskChecksFailed prometheus.Counter

	// System metrics
	goroutineCount prometheus.Gauge
	heapAlloc      prometheus.Gauge
	gcPauseTime    prometheus.Histogram
}

// NewCollector creates a new metrics collector
func NewCollector() *Collector {
	return &Collector{
		// Order metrics
		ordersSubmitted: promauto.NewCounter(prometheus.CounterOpts{
			Name: "trading_orders_submitted_total",
			Help: "Total number of orders submitted",
		}),
		ordersAccepted: promauto.NewCounter(prometheus.CounterOpts{
			Name: "trading_orders_accepted_total",
			Help: "Total number of orders accepted",
		}),
		ordersRejected: promauto.NewCounter(prometheus.CounterOpts{
			Name: "trading_orders_rejected_total",
			Help: "Total number of orders rejected",
		}),
		ordersCanceled: promauto.NewCounter(prometheus.CounterOpts{
			Name: "trading_orders_canceled_total",
			Help: "Total number of orders canceled",
		}),
		ordersFilled: promauto.NewCounter(prometheus.CounterOpts{
			Name: "trading_orders_filled_total",
			Help: "Total number of orders filled",
		}),

		// Fill metrics
		fillsProcessed: promauto.NewCounter(prometheus.CounterOpts{
			Name: "trading_fills_processed_total",
			Help: "Total number of fills processed",
		}),
		fillVolume: promauto.NewCounter(prometheus.CounterOpts{
			Name: "trading_fill_volume_total",
			Help: "Total fill volume",
		}),
		fillValue: promauto.NewCounter(prometheus.CounterOpts{
			Name: "trading_fill_value_total",
			Help: "Total fill value",
		}),

		// Latency metrics
		orderLatency: promauto.NewHistogram(prometheus.HistogramOpts{
			Name:    "trading_order_latency_microseconds",
			Help:    "Order submission latency in microseconds",
			Buckets: []float64{10, 50, 100, 500, 1000, 5000, 10000},
		}),
		fillLatency: promauto.NewHistogram(prometheus.HistogramOpts{
			Name:    "trading_fill_latency_microseconds",
			Help:    "Fill processing latency in microseconds",
			Buckets: []float64{10, 50, 100, 500, 1000, 5000, 10000},
		}),
		marketDataLatency: promauto.NewHistogram(prometheus.HistogramOpts{
			Name:    "trading_market_data_latency_microseconds",
			Help:    "Market data processing latency in microseconds",
			Buckets: []float64{1, 5, 10, 50, 100, 500, 1000},
		}),

		// Market data metrics
		tradesProcessed: promauto.NewCounter(prometheus.CounterOpts{
			Name: "trading_trades_processed_total",
			Help: "Total number of trades processed",
		}),
		quotesProcessed: promauto.NewCounter(prometheus.CounterOpts{
			Name: "trading_quotes_processed_total",
			Help: "Total number of quotes processed",
		}),
		booksProcessed: promauto.NewCounter(prometheus.CounterOpts{
			Name: "trading_books_processed_total",
			Help: "Total number of order books processed",
		}),

		// Position metrics
		positionCount: promauto.NewGauge(prometheus.GaugeOpts{
			Name: "trading_position_count",
			Help: "Current number of open positions",
		}),
		totalPnL: promauto.NewGauge(prometheus.GaugeOpts{
			Name: "trading_total_pnl",
			Help: "Total P&L (realized + unrealized)",
		}),
		realizedPnL: promauto.NewGauge(prometheus.GaugeOpts{
			Name: "trading_realized_pnl",
			Help: "Realized P&L",
		}),
		unrealizedPnL: promauto.NewGauge(prometheus.GaugeOpts{
			Name: "trading_unrealized_pnl",
			Help: "Unrealized P&L",
		}),

		// Risk metrics
		riskChecksTotal: promauto.NewCounter(prometheus.CounterOpts{
			Name: "trading_risk_checks_total",
			Help: "Total number of risk checks performed",
		}),
		riskChecksPassed: promauto.NewCounter(prometheus.CounterOpts{
			Name: "trading_risk_checks_passed_total",
			Help: "Total number of risk checks passed",
		}),
		riskChecksFailed: promauto.NewCounter(prometheus.CounterOpts{
			Name: "trading_risk_checks_failed_total",
			Help: "Total number of risk checks failed",
		}),

		// System metrics
		goroutineCount: promauto.NewGauge(prometheus.GaugeOpts{
			Name: "trading_goroutine_count",
			Help: "Current number of goroutines",
		}),
		heapAlloc: promauto.NewGauge(prometheus.GaugeOpts{
			Name: "trading_heap_alloc_bytes",
			Help: "Current heap allocation in bytes",
		}),
		gcPauseTime: promauto.NewHistogram(prometheus.HistogramOpts{
			Name:    "trading_gc_pause_microseconds",
			Help:    "GC pause time in microseconds",
			Buckets: []float64{10, 50, 100, 500, 1000, 5000, 10000},
		}),
	}
}

// RecordOrderSubmitted records an order submission
func (c *Collector) RecordOrderSubmitted() {
	c.ordersSubmitted.Inc()
}

// RecordOrderAccepted records an order acceptance
func (c *Collector) RecordOrderAccepted() {
	c.ordersAccepted.Inc()
}

// RecordOrderRejected records an order rejection
func (c *Collector) RecordOrderRejected() {
	c.ordersRejected.Inc()
}

// RecordOrderCanceled records an order cancellation
func (c *Collector) RecordOrderCanceled() {
	c.ordersCanceled.Inc()
}

// RecordOrderFilled records an order fill
func (c *Collector) RecordOrderFilled() {
	c.ordersFilled.Inc()
}

// RecordFill records a fill with volume and value
func (c *Collector) RecordFill(quantity, value float64) {
	c.fillsProcessed.Inc()
	c.fillVolume.Add(quantity)
	c.fillValue.Add(value)
}

// RecordOrderLatency records order submission latency
func (c *Collector) RecordOrderLatency(latency time.Duration) {
	c.orderLatency.Observe(float64(latency.Microseconds()))
}

// RecordFillLatency records fill processing latency
func (c *Collector) RecordFillLatency(latency time.Duration) {
	c.fillLatency.Observe(float64(latency.Microseconds()))
}

// RecordMarketDataLatency records market data processing latency
func (c *Collector) RecordMarketDataLatency(latency time.Duration) {
	c.marketDataLatency.Observe(float64(latency.Microseconds()))
}

// RecordTradeProcessed records a trade processed
func (c *Collector) RecordTradeProcessed() {
	c.tradesProcessed.Inc()
}

// RecordQuoteProcessed records a quote processed
func (c *Collector) RecordQuoteProcessed() {
	c.quotesProcessed.Inc()
}

// RecordBookProcessed records an order book processed
func (c *Collector) RecordBookProcessed() {
	c.booksProcessed.Inc()
}

// UpdatePositionMetrics updates position-related metrics
func (c *Collector) UpdatePositionMetrics(count int, realized, unrealized, total float64) {
	c.positionCount.Set(float64(count))
	c.realizedPnL.Set(realized)
	c.unrealizedPnL.Set(unrealized)
	c.totalPnL.Set(total)
}

// RecordRiskCheck records a risk check result
func (c *Collector) RecordRiskCheck(passed bool) {
	c.riskChecksTotal.Inc()
	if passed {
		c.riskChecksPassed.Inc()
	} else {
		c.riskChecksFailed.Inc()
	}
}

// UpdateSystemMetrics updates system-level metrics
func (c *Collector) UpdateSystemMetrics(goroutines int, heapAlloc uint64) {
	c.goroutineCount.Set(float64(goroutines))
	c.heapAlloc.Set(float64(heapAlloc))
}

// RecordGCPause records a GC pause time
func (c *Collector) RecordGCPause(pause time.Duration) {
	c.gcPauseTime.Observe(float64(pause.Microseconds()))
}

// LatencyTracker tracks latency percentiles
type LatencyTracker struct {
	samples []int64
	mu      sync.RWMutex
	maxSize int
}

// NewLatencyTracker creates a new latency tracker
func NewLatencyTracker(maxSize int) *LatencyTracker {
	return &LatencyTracker{
		samples: make([]int64, 0, maxSize),
		maxSize: maxSize,
	}
}

// Record records a latency sample
func (lt *LatencyTracker) Record(latency time.Duration) {
	lt.mu.Lock()
	defer lt.mu.Unlock()

	if len(lt.samples) >= lt.maxSize {
		// Shift left and add to end
		copy(lt.samples, lt.samples[1:])
		lt.samples[len(lt.samples)-1] = latency.Microseconds()
	} else {
		lt.samples = append(lt.samples, latency.Microseconds())
	}
}

// GetPercentile returns the specified percentile
func (lt *LatencyTracker) GetPercentile(percentile float64) time.Duration {
	lt.mu.RLock()
	defer lt.mu.RUnlock()

	if len(lt.samples) == 0 {
		return 0
	}

	// Make a copy and sort
	sorted := make([]int64, len(lt.samples))
	copy(sorted, lt.samples)

	// Simple sort (use slices.SortFunc in production)
	for i := range sorted {
		for j := i + 1; j < len(sorted); j++ {
			if sorted[i] > sorted[j] {
				sorted[i], sorted[j] = sorted[j], sorted[i]
			}
		}
	}

	idx := int(float64(len(sorted)) * percentile / 100.0)
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}

	return time.Duration(sorted[idx]) * time.Microsecond
}

// GetStats returns latency statistics
func (lt *LatencyTracker) GetStats() LatencyStats {
	lt.mu.RLock()
	defer lt.mu.RUnlock()

	if len(lt.samples) == 0 {
		return LatencyStats{}
	}

	var sum int64
	min := lt.samples[0]
	max := lt.samples[0]

	for _, sample := range lt.samples {
		sum += sample
		if sample < min {
			min = sample
		}
		if sample > max {
			max = sample
		}
	}

	avg := sum / int64(len(lt.samples))

	return LatencyStats{
		Count:   len(lt.samples),
		Min:     time.Duration(min) * time.Microsecond,
		Max:     time.Duration(max) * time.Microsecond,
		Average: time.Duration(avg) * time.Microsecond,
	}
}

// LatencyStats holds latency statistics
type LatencyStats struct {
	Count   int
	Min     time.Duration
	Max     time.Duration
	Average time.Duration
}
