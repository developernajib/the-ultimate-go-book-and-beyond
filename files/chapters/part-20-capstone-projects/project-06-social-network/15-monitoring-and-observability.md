## Monitoring and Observability

In production, you cannot fix what you cannot see. Monitoring and observability tools give you visibility into how the application behaves under real traffic. Prometheus collects numeric metrics like request counts, response times, and cache hit rates, which you can then visualize in Grafana dashboards. Structured logging with Zap produces JSON log entries that can be searched and filtered in tools like Elasticsearch or Loki. Together, metrics and logs allow you to detect problems quickly, understand their root cause, and verify that fixes actually work.

### Prometheus Metrics

Prometheus metrics are defined as global variables that any part of the application can increment or observe. Counters track cumulative totals like the number of HTTP requests or posts created, while histograms record the distribution of values like request durations. By labeling metrics with dimensions like HTTP method, path, and status code, you can create detailed Grafana dashboards that show exactly where performance problems occur.

```go
// internal/metrics/prometheus.go
package metrics

import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

var (
    // HTTP metrics
    HTTPRequestsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "socialnet_http_requests_total",
            Help: "Total number of HTTP requests",
        },
        []string{"method", "path", "status"},
    )

    HTTPRequestDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "socialnet_http_request_duration_seconds",
            Help:    "HTTP request duration in seconds",
            Buckets: prometheus.DefBuckets,
        },
        []string{"method", "path"},
    )

    // Database metrics
    DBQueriesTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "socialnet_db_queries_total",
            Help: "Total number of database queries",
        },
        []string{"operation", "table"},
    )

    DBQueryDuration = promauto.NewHistogramVec(
        prometheus.HistogramOpts{
            Name:    "socialnet_db_query_duration_seconds",
            Help:    "Database query duration in seconds",
            Buckets: prometheus.DefBuckets,
        },
        []string{"operation", "table"},
    )

    // Business metrics
    PostsCreatedTotal = promauto.NewCounter(
        prometheus.CounterOpts{
            Name: "socialnet_posts_created_total",
            Help: "Total number of posts created",
        },
    )

    UsersRegisteredTotal = promauto.NewCounter(
        prometheus.CounterOpts{
            Name: "socialnet_users_registered_total",
            Help: "Total number of users registered",
        },
    )

    FollowsTotal = promauto.NewCounter(
        prometheus.CounterOpts{
            Name: "socialnet_follows_total",
            Help: "Total number of follow actions",
        },
    )

    // Cache metrics
    CacheHitsTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "socialnet_cache_hits_total",
            Help: "Total number of cache hits",
        },
        []string{"cache_type"},
    )

    CacheMissesTotal = promauto.NewCounterVec(
        prometheus.CounterOpts{
            Name: "socialnet_cache_misses_total",
            Help: "Total number of cache misses",
        },
        []string{"cache_type"},
    )
)
```

### Structured Logging

Structured logging outputs log entries as JSON objects rather than plain text strings. This makes logs machine-parseable, which is essential when you are searching through millions of log lines in production. The logger configuration switches between a developer-friendly colored output for local development and a JSON format for production, so you get readability during development and searchability in production.

```go
// internal/logging/logger.go
package logging

import (
    "go.uber.org/zap"
    "go.uber.org/zap/zapcore"
)

func NewLogger(environment string) (*zap.Logger, error) {
    var config zap.Config

    if environment == "production" {
        config = zap.NewProductionConfig()
        config.EncoderConfig.TimeKey = "timestamp"
        config.EncoderConfig.EncodeTime = zapcore.ISO8601TimeEncoder
    } else {
        config = zap.NewDevelopmentConfig()
        config.EncoderConfig.EncodeLevel = zapcore.CapitalColorLevelEncoder
    }

    config.Level = zap.NewAtomicLevelAt(zap.InfoLevel)

    return config.Build()
}
```

---

### Junior → FAANG: Getting Observability Right from Day One

Junior engineers often add logging as an afterthought and then spend their on-call shifts unable to debug production issues because their logs lack context. The foundational habit: every log line must answer "what happened, to which request, for which user, from which service." This requires a correlation ID that flows through every service call and is included in every log line.

Understand the three pillars before interviews: logs (discrete events), metrics (aggregated numerical measurements), and traces (causality chains across service boundaries). Many candidates can name these but cannot explain how they complement each other. Logs give you the detail, metrics tell you the trend, and traces tell you which service in a multi-hop call is responsible for the latency.

First-job mistake: logging at DEBUG level in production. This generates volume that drowns signal in noise and creates real I/O overhead. Log at INFO level in production, ERROR for actionable failures, and WARN for degraded-but-operational conditions. Use structured JSON logs so your log aggregation platform can index and filter on fields without regex parsing.

Entry-level interview framing: when asked how you would debug a production slowdown, the answer structure is: check metrics for anomalies (error rate, p99 latency) to scope the problem, use traces to identify which service call is slow, use logs to find the specific request that failed with full context. This sequence shows systematic thinking rather than guessing.

### Senior @ FAANG: Observability Platform Strategy and SLO Engineering

At FAANG, observability is a platform capability owned by a dedicated team, consumed by all product services. The staff-level question is not "how do I instrument my service" but "how do I define observability standards that scale across 500 services with 3000 engineers."

**SLO-based alerting over symptom-based alerting.** Alerting on individual metrics (CPU > 80%, error count > 100) produces alert fatigue because these metrics do not directly represent user impact. The mature approach is SLO-based alerting using error budget burn rate. An error budget alert fires when you are burning through your monthly error budget faster than sustainable. At 1x burn rate, you will exhaust the budget in 30 days (no alert needed). At 5x burn rate, you will exhaust it in 6 days (alert for action). At 14.4x burn rate, you will exhaust it in 50 hours (page immediately). This approach ensures you are paged for user-impacting events, not infrastructure noise.

**Cardinality governance for metrics.** High-cardinality labels in Prometheus (user_id, request_id as label dimensions) cause exponential growth in time-series count, overwhelming your metrics storage. The governance rule: labels must have bounded cardinality (< 1000 distinct values). Service, endpoint, status code, and region are acceptable labels. User ID is not. If you need per-user analysis, use logs or traces, not metrics. At L6, you define these cardinality constraints as linting rules in the CI pipeline for metric definitions.

**Distributed tracing sampling strategy.** Tracing every request at 100% sampling is prohibitively expensive at FAANG traffic volumes. The senior approach is tail-based sampling: collect all trace spans, decide whether to persist the trace only after it completes (based on whether it was slow, errored, or sampled randomly). This preserves all interesting traces (errors, high-latency) while dropping routine traces. Implement tail-based sampling at a centralized collector (Jaeger, Tempo) rather than at the service level so sampling decisions have full trace context.

**Runbook-driven alerting.** Every alert must have a linked runbook that describes: what the alert means, what the likely causes are (ordered by frequency), the diagnostic steps to narrow the cause, and the remediation steps for each cause. An alert without a runbook trains engineers to acknowledge and ignore. At staff level, you define a standard that no alert ships without a linked, tested runbook. Runbooks are versioned alongside service code and reviewed in PRs that change alerting rules.

**Observability as a hiring signal.** At bar-raiser interviews, candidates who describe concrete observability stories demonstrate senior judgment: "I noticed the p99 latency was increasing slowly over two weeks. The metrics showed it but no alert fired. I discovered our query plan had changed after a statistics update. We added an alert on query plan changes via pg_stat_statements." This story shows proactive monitoring, root cause discipline, and closing the gap by adding a new alert. Candidates who only describe reactive debugging of obvious outages signal a lower maturity level.
