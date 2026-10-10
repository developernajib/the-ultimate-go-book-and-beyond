## 30.6 Job Monitoring

### Metrics Collection

The `Metrics` struct tracks per-queue processed and failed counts along with a sliding window of processing durations. It uses a read-write mutex so that the stats endpoint can read concurrently without blocking workers recording new data points. The `GetStats` method computes average and P95 latency from the last 1,000 samples, giving operators a real-time view of queue performance without the overhead of a full histogram library.

```go
package queue

import (
    "sort"
    "sync"
    "time"
)

type Metrics struct {
    mu              sync.RWMutex
    processed       map[string]int64
    failed          map[string]int64
    processingTimes map[string][]time.Duration
}

func NewMetrics() *Metrics {
    return &Metrics{
        processed:       make(map[string]int64),
        failed:          make(map[string]int64),
        processingTimes: make(map[string][]time.Duration),
    }
}

func (m *Metrics) RecordProcessed(queue string, duration time.Duration) {
    m.mu.Lock()
    defer m.mu.Unlock()
    m.processed[queue]++
    m.processingTimes[queue] = append(m.processingTimes[queue], duration)

    // Keep only last 1000 samples
    if len(m.processingTimes[queue]) > 1000 {
        m.processingTimes[queue] = m.processingTimes[queue][1:]
    }
}

func (m *Metrics) RecordFailed(queue string) {
    m.mu.Lock()
    defer m.mu.Unlock()
    m.failed[queue]++
}

func (m *Metrics) GetStats(queue string) QueueStats {
    m.mu.RLock()
    defer m.mu.RUnlock()

    stats := QueueStats{
        Queue:     queue,
        Processed: m.processed[queue],
        Failed:    m.failed[queue],
    }

    times := m.processingTimes[queue]
    if len(times) > 0 {
        var total time.Duration
        for _, t := range times {
            total += t
        }
        stats.AvgProcessingTime = total / time.Duration(len(times))

        // Calculate P95
        sorted := make([]time.Duration, len(times))
        copy(sorted, times)
        sort.Slice(sorted, func(i, j int) bool {
            return sorted[i] < sorted[j]
        })
        p95Index := int(float64(len(sorted)) * 0.95)
        stats.P95ProcessingTime = sorted[p95Index]
    }

    return stats
}

type QueueStats struct {
    Queue             string        `json:"queue"`
    Processed         int64         `json:"processed"`
    Failed            int64         `json:"failed"`
    AvgProcessingTime time.Duration `json:"avg_processing_time"`
    P95ProcessingTime time.Duration `json:"p95_processing_time"`
}
```

### Health Check

The health checker queries the job repository to detect three failure modes: a backlog of pending jobs above a configurable threshold, jobs stuck in the running state longer than their expected processing time, and an elevated failure rate over the past hour. The response structure maps directly to a JSON endpoint that Kubernetes readiness probes or a load balancer can consume.

```go
package queue

import (
    "context"
    "time"
)

type HealthChecker struct {
    repo   *JobRepository
    queues []string
}

func (h *HealthChecker) Check(ctx context.Context) (HealthStatus, error) {
    status := HealthStatus{
        Healthy: true,
        Queues:  make(map[string]QueueHealth),
    }

    for _, queue := range h.queues {
        qh := h.checkQueue(ctx, queue)
        status.Queues[queue] = qh

        if !qh.Healthy {
            status.Healthy = false
        }
    }

    return status, nil
}

func (h *HealthChecker) checkQueue(ctx context.Context, queue string) QueueHealth {
    qh := QueueHealth{Healthy: true}

    // Check pending count
    pending, _ := h.repo.CountByStatus(ctx, queue, StatusPending)
    qh.PendingCount = pending

    // Alert if too many pending
    if pending > 10000 {
        qh.Healthy = false
        qh.Issues = append(qh.Issues, "high pending count")
    }

    // Check for stuck jobs
    stuck, _ := h.repo.CountStuck(ctx, queue, 30*time.Minute)
    qh.StuckCount = stuck
    if stuck > 0 {
        qh.Healthy = false
        qh.Issues = append(qh.Issues, "stuck jobs detected")
    }

    // Check failed rate
    failed, _ := h.repo.CountFailed(ctx, queue, time.Hour)
    total, _ := h.repo.CountTotal(ctx, queue, time.Hour)
    if total > 0 {
        failRate := float64(failed) / float64(total)
        qh.FailRate = failRate
        if failRate > 0.1 { // 10% fail rate
            qh.Healthy = false
            qh.Issues = append(qh.Issues, "high failure rate")
        }
    }

    return qh
}

type HealthStatus struct {
    Healthy bool                   `json:"healthy"`
    Queues  map[string]QueueHealth `json:"queues"`
}

type QueueHealth struct {
    Healthy      bool     `json:"healthy"`
    PendingCount int64    `json:"pending_count"`
    StuckCount   int64    `json:"stuck_count"`
    FailRate     float64  `json:"fail_rate"`
    Issues       []string `json:"issues,omitempty"`
}
```

### Junior to FAANG: metrics you must have before production

Custom in-memory P95 is fine for learning. In production, use Prometheus client libraries so metrics land in your observability stack automatically. `prometheus.NewHistogramVec`, and especially native histograms (a `client_golang` feature you enable with `NativeHistogramBucketFactor`), give you high-resolution percentiles across the fleet without the sliding-window approximation this snippet uses.

Four metrics are mandatory.

1. **Queue depth.** Current count of pending jobs per queue. Gauge. Alert if above threshold.
2. **Oldest message age.** Age of the oldest pending job per queue. Gauge. This is the best proxy for SLO. Alert if above the SLO for the tier.
3. **Handler duration.** Histogram with buckets matching the job_type's expected distribution. P50, P95, P99 all derived from this.
4. **Outcome count.** Counter with `outcome` label (success, retry, permanent_failure). Failure rate is a ratio query.

Additional metrics you will want inside the first month. `jobs_inflight` (gauge of currently-running jobs), `jobs_retries_total` by attempt number, `jobs_dequeue_latency_seconds` (time from enqueue to start), `jobs_handler_panic_total`, `worker_leases_recovered_total`.

Alerting template for a new job_type.

- `queue_depth > N` for 5 minutes (N depends on expected throughput).
- `oldest_message_age > SLO * 2` for 1 minute (catches lag before SLO breach).
- `rate(jobs_failed_total[5m]) / rate(jobs_total[5m]) > 0.05` for 10 minutes.
- `rate(jobs_handler_panic_total[5m]) > 0` any.
- `dlq_arrival_rate > baseline + 3 * stddev(baseline)` for 15 minutes.

Interview entry point. "What metrics would you put on a job queue dashboard." Expected answer includes depth, age, duration, outcome, plus the burn-rate concept for SLO alerting. A junior who says "just number processed" is not ready.

Walkthrough for a dashboard you will build. Three rows. Top row, SLO dashboard (oldest-age, error-budget-remaining, burn-rate). Middle row, throughput (enqueue rate, completion rate, DLQ arrival rate). Bottom row, handler performance (duration P50 P95 P99, inflight, panic rate). Below, a table per job_type with depth, age, and failure rate for drill-down.

### Senior at FAANG: observability contract and SLO engineering

Staff engineers do not build dashboards. They define observability contracts that every job_type adheres to, and they own the SLO engineering practice for async work.

**SLO definitions per tier.** A platform contract specifies SLOs per job_type tier.

- Tier-0 (billing, ledger, auth). 99.95% of jobs complete within 5 seconds of enqueue. 99.99% complete at all (never DLQ except poison pills).
- Tier-1 (user-visible async, emails, notifications). 99.9% within 60 seconds. 99.95% complete.
- Tier-2 (analytics, search index updates). 99% within 10 minutes. 99.9% complete.

Each SLO becomes an error budget. Burn-rate alerts fire at 2% of budget per hour (fast burn) and 10% per day (slow burn), per the Google SRE multi-window multi-burn-rate pattern.

**Golden signals.** Four golden signals per job_type, emitted uniformly.

1. Latency. Enqueue-to-start, plus handler duration. Exposed as histograms, not computed P95.
2. Traffic. Enqueue rate. Completion rate.
3. Errors. Failure rate by error.Kind classification.
4. Saturation. Inflight count versus configured concurrency. Queue depth versus autoscaler threshold.

**Distributed tracing.** Every job execution is a span with `otel.trace_id` propagated from the enqueuing request. This makes a trace waterfall show `HTTP request -> DB write -> enqueue -> worker pickup -> handler -> downstream call` end-to-end. Without it, debugging "why did the reminder email arrive 10 minutes late" requires correlating timestamps across three systems. With it, one click.

**Log sampling.** At FAANG scale, logging every job execution is too expensive. The pattern is, sample successful jobs at 1%, log all failures, log all jobs exceeding P99 latency, log any job from a tagged tenant (for support investigations). This reduces log volume by 100x without losing the signal.

**Structured logging contract.** Every log line from the platform carries, `job_id`, `job_type`, `job_version`, `attempt`, `tenant_id`, `trace_id`, `worker_id`, `duration_ms`, `outcome`. Handlers are not allowed to log without the platform context wrapper. This is enforced at the SDK layer.

**Cost observability.** At FAANG scale, queue compute is a significant line item. A staff-level dashboard includes cost per job_type (compute time * worker hourly cost / jobs completed). This lets capacity planning and architecture reviews argue in dollars, not just throughput.

**Anomaly detection.** Beyond static thresholds, platforms at scale run anomaly detection on queue metrics. Prophet, GluonTS, or simple 7-day-same-hour comparison. An unusual drop in enqueue rate indicates upstream breakage (producers down). An unusual drop in completion rate indicates worker breakage. Static thresholds miss both. Anomaly detection catches them.

**Synthetic probes.** A platform team runs a synthetic probe every minute that enqueues a no-op job in each tier and asserts it completes within SLO. This detects problems the user-job flow may not surface during low traffic.

**Incident retrospective pattern.** After a queue incident, the retrospective template asks, did our metrics detect this, would anomaly detection have detected it earlier, did our runbook match reality, what decision took the longest (usually, "is this SEV-1 or SEV-2"). These answers feed back into platform investment. If metrics did not detect, add metrics. If the runbook was wrong, update it.

**Multi-year observability roadmap.** Year 1, uniform metrics contract and per-job-type dashboards. Year 2, SLO definitions and burn-rate alerting. Year 3, cost attribution and anomaly detection. Year 4, automated remediation (auto-scale on lag, auto-shed-load at budget exhaustion). This is the arc Stripe publishes about their reliability engineering.

**ADR example.** "Adopt OpenTelemetry for job tracing". Accepted. Context. Every team uses a different tracing approach. Decision. Platform SDK injects OTel context propagation mandatorily. Consequences. All handlers gain trace context for free. Teams must emit spans for downstream calls. Traces in Tempo or Honeycomb enable waterfall debugging. Cost increase is roughly 3% of compute for span export, offset by reduced MTTR.

---
