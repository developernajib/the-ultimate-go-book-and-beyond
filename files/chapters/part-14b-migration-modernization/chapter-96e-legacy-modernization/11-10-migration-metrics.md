## 10. Migration Metrics

Comprehensive metrics are essential for measuring migration health and making data-driven decisions about traffic shifting. Without metrics, you are flying blind: you do not know what percentage of traffic is on the new service, whether the new service is slower, or whether shadow comparisons are diverging. The metrics struct below tracks four categories of signals: request routing (how much traffic goes where), shadow comparisons (how often the new service agrees with legacy), dual-write health (success and error rates for each store), and data reconciliation (how many entities have diverged between old and new). The `Snapshot` method produces a point-in-time view that can be exposed as a JSON endpoint for dashboards and alerting systems.

```go
// file: internal/metrics/migration.go
package metrics

import (
	"sync"
	"sync/atomic"
	"time"

	"github.com/example/gobook/internal/featureflags"
)

// MigrationMetrics tracks all migration-relevant signals.
type MigrationMetrics struct {
	mu sync.RWMutex

	// Request routing metrics.
	RequestsToLegacy atomic.Int64
	RequestsToNew    atomic.Int64
	RequestErrors    atomic.Int64

	// Shadow comparison metrics.
	ShadowTotal    atomic.Int64
	ShadowMatches  atomic.Int64
	ShadowErrors   atomic.Int64

	// Dual-write metrics.
	DualWriteSuccess map[string]int64
	DualWriteErrors  map[string]int64

	// Latency histograms (simplified as sum + count for this example).
	LatencySum   map[string]int64
	LatencyCount map[string]int64

	// Data reconciliation metrics.
	ReconcileTotal    atomic.Int64
	ReconcileMismatches atomic.Int64
}

// NewMigrationMetrics initializes the metrics struct.
func NewMigrationMetrics() *MigrationMetrics {
	return &MigrationMetrics{
		DualWriteSuccess: make(map[string]int64),
		DualWriteErrors:  make(map[string]int64),
		LatencySum:       make(map[string]int64),
		LatencyCount:     make(map[string]int64),
	}
}

// RecordRequest increments the appropriate request counter.
func (m *MigrationMetrics) RecordRequest(path, method, target string, latency time.Duration) {
	if target == "new" {
		m.RequestsToNew.Add(1)
	} else {
		m.RequestsToLegacy.Add(1)
	}
	m.mu.Lock()
	key := target + ":" + method + ":" + path
	m.LatencySum[key] += latency.Milliseconds()
	m.LatencyCount[key]++
	m.mu.Unlock()
}

// RecordShadowComparison records a shadow test result.
func (m *MigrationMetrics) RecordShadowComparison(path string, matched bool) {
	m.ShadowTotal.Add(1)
	if matched {
		m.ShadowMatches.Add(1)
	}
}

// RecordShadowError records an error during shadow execution.
func (m *MigrationMetrics) RecordShadowError(path string) {
	m.ShadowErrors.Add(1)
}

// RecordDualWriteSuccess records a successful dual-write operation.
func (m *MigrationMetrics) RecordDualWriteSuccess(operation, mode string) {
	m.mu.Lock()
	m.DualWriteSuccess[operation+":"+mode]++
	m.mu.Unlock()
}

// RecordDualWriteError records a failed dual-write operation.
func (m *MigrationMetrics) RecordDualWriteError(operation, reason string) {
	m.mu.Lock()
	m.DualWriteErrors[operation+":"+reason]++
	m.mu.Unlock()
}

// RecordDualWriteLatency records latency for dual-write operations.
func (m *MigrationMetrics) RecordDualWriteLatency(operation, target string, latency time.Duration) {
	m.mu.Lock()
	key := "dualwrite:" + operation + ":" + target
	m.LatencySum[key] += latency.Milliseconds()
	m.LatencyCount[key]++
	m.mu.Unlock()
}

// RecordFlagEvaluation satisfies the featureflags.MetricsRecorder interface.
func (m *MigrationMetrics) RecordFlagEvaluation(_ featureflags.FlagName, _ bool, _ featureflags.RolloutStrategy) {}

// Snapshot returns a point-in-time view of all migration metrics.
func (m *MigrationMetrics) Snapshot() map[string]any {
	m.mu.RLock()
	defer m.mu.RUnlock()

	totalRequests := m.RequestsToLegacy.Load() + m.RequestsToNew.Load()
	newPct := float64(0)
	if totalRequests > 0 {
		newPct = float64(m.RequestsToNew.Load()) / float64(totalRequests) * 100
	}

	shadowTotal := m.ShadowTotal.Load()
	shadowMatchPct := float64(0)
	if shadowTotal > 0 {
		shadowMatchPct = float64(m.ShadowMatches.Load()) / float64(shadowTotal) * 100
	}

	return map[string]any{
		"requests_legacy":       m.RequestsToLegacy.Load(),
		"requests_new":          m.RequestsToNew.Load(),
		"new_traffic_pct":       newPct,
		"shadow_total":          shadowTotal,
		"shadow_match_pct":      shadowMatchPct,
		"shadow_errors":         m.ShadowErrors.Load(),
		"reconcile_total":       m.ReconcileTotal.Load(),
		"reconcile_mismatches":  m.ReconcileMismatches.Load(),
	}
}
```

### Junior → FAANG: Migration Metrics as the Safety Signal for Traffic Shifting

Migration metrics are the evidence base for every traffic splitting decision during the migration. Without them, increasing the new service's traffic share is a guess. With them, it is a data-driven decision based on observed latency, error rate, shadow divergence, and dual-write health.

The four categories of metrics in this implementation (routing, shadow, dual-write, reconciliation) each answer a different question: routing metrics answer "how much traffic is the new service handling," shadow metrics answer "is the new service behaving correctly," dual-write metrics answer "is the data store transition proceeding safely," and reconciliation metrics answer "is the data consistent between old and new stores after the migration."

For early-career engineers: the `atomic` counters in this implementation are important. Migration metrics are collected from multiple goroutines concurrently (every request potentially increments a counter), so the counters must be thread-safe. Using `sync/atomic` operations rather than a mutex-protected struct reduces contention on the hot path and is the correct pattern for high-frequency counters in Go.

### Senior @ FAANG: Metrics Governance and the SLO-Based Migration Gate

At senior level, migration metrics are connected to explicit SLO-based migration gates: conditions that must be met before the traffic split can progress to the next milestone. The governance process: define the SLOs for the new service before beginning traffic migration (latency p99 must be within X% of legacy, error rate must be below Y%, shadow divergence rate must be below Z%), and instrument automated checks that prevent traffic split increases when any SLO is violated.

The specific metrics governance decision that distinguishes senior from junior migration management: what is the measurement window for evaluating migration gate conditions. A 5-minute window can be gamed by a brief period of good behavior after a deployment. A 7-day window may be too slow to allow timely migration progress. The correct window depends on the traffic patterns: for high-traffic systems with stable diurnal patterns, a 24-hour window that includes at least one full business day peak is typically sufficient.

The `Snapshot` method in this implementation is the correct pattern for exposing metrics to external monitoring systems: it produces a consistent point-in-time view that can be serialized without holding locks. At senior level, this snapshot should be connected to your alerting system with specific thresholds for each metric category, and the alerts should route to different on-call teams based on which category is violated (routing issues are infrastructure on-call, divergence issues are migration team on-call, dual-write issues are database on-call).

---
